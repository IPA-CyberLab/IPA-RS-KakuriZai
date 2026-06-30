// @ts-nocheck
import crypto from "node:crypto";

const DEFAULT_SCRYPT = {
  N: 16384,
  r: 8,
  p: 1,
  keyLength: 32
};

export function hashPassword(password, options = {}) {
  if (!password || typeof password !== "string") throw new Error("password is required");
  const params = { ...DEFAULT_SCRYPT, ...options };
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, params.keyLength, {
    N: params.N,
    r: params.r,
    p: params.p
  });
  return [
    "scrypt",
    `N=${params.N},r=${params.r},p=${params.p},l=${params.keyLength}`,
    salt.toString("base64url"),
    hash.toString("base64url")
  ].join("$");
}

export function verifyPasswordHash(password, encoded) {
  if (!password || typeof password !== "string" || !encoded || typeof encoded !== "string") return false;
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") throw new Error("unsupported password hash");
  const params = parseParams(parts[1]);
  const salt = Buffer.from(parts[2], "base64url");
  const expected = Buffer.from(parts[3], "base64url");
  const actual = crypto.scryptSync(password, salt, params.l, {
    N: params.N,
    r: params.r,
    p: params.p
  });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function parseParams(value) {
  const params = {};
  for (const pair of value.split(",")) {
    const [key, raw] = pair.split("=");
    params[key] = Number(raw);
  }
  for (const key of ["N", "r", "p", "l"]) {
    if (!Number.isInteger(params[key]) || params[key] <= 0) throw new Error("invalid password hash params");
  }
  return params;
}
