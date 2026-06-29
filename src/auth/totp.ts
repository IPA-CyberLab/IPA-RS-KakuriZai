// @ts-nocheck
import crypto from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

export function totpAuthUrl(options) {
  const issuer = encodeURIComponent(options.issuer || "KakuriZai");
  const label = encodeURIComponent(`${options.issuer || "KakuriZai"}:${options.subject || "local-user"}`);
  const url = new URL(`otpauth://totp/${label}`);
  url.searchParams.set("secret", options.secret);
  url.searchParams.set("issuer", options.issuer || "KakuriZai");
  url.searchParams.set("algorithm", "SHA1");
  url.searchParams.set("digits", String(options.digits || 6));
  url.searchParams.set("period", String(options.period || 30));
  return url.toString();
}

export function verifyTotp(secret, token, options = {}) {
  const normalized = String(token || "").replace(/\s+/g, "");
  const digits = options.digits || 6;
  if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) return false;
  const period = options.period || 30;
  const window = options.window == null ? 1 : options.window;
  const timestamp = Math.floor((options.now || Date.now()) / 1000);
  const counter = Math.floor(timestamp / period);
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = hotp(secret, counter + offset, digits);
    if (safeEqual(normalized, expected)) return true;
  }
  return false;
}

export function totpCode(secret, options = {}) {
  const period = options.period || 30;
  const digits = options.digits || 6;
  const timestamp = Math.floor((options.now || Date.now()) / 1000);
  return hotp(secret, Math.floor(timestamp / period), digits);
}

function hotp(secret, counter, digits) {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % (10 ** digits)).padStart(digits, "0");
}

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(value) {
  const input = String(value || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let current = 0;
  const bytes = [];
  for (const char of input) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error("invalid base32 secret");
    current = (current << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((current >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
