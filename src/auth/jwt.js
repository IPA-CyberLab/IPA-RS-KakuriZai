import crypto from "node:crypto";

export function base64urlEncode(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return input.toString("base64url");
}

export function base64urlJson(value) {
  return base64urlEncode(JSON.stringify(value));
}

export function decodeJwt(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new Error("invalid jwt shape");
  const [encodedHeader, encodedPayload, signature] = parts;
  return {
    header: JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")),
    signature,
    signingInput: `${encodedHeader}.${encodedPayload}`
  };
}

export function signSelfToken(options) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: options.subject || "local-user",
    iss: options.issuer,
    aud: options.audience,
    iat: now,
    exp: now + (options.expiresInSeconds || 3600),
    scope: options.scope || "worlds:read worlds:write"
  };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const signature = crypto.createHmac("sha256", options.secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

export function verifySelfToken(token, options) {
  const decoded = decodeJwt(token);
  if (decoded.header.alg !== "HS256") throw new Error("self auth requires HS256");
  const expected = crypto.createHmac("sha256", options.secret).update(decoded.signingInput).digest("base64url");
  const actualBuffer = Buffer.from(decoded.signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error("invalid token signature");
  }
  verifyClaims(decoded.payload, options);
  return decoded.payload;
}

export function verifyClaims(payload, options) {
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error("token expired");
  if (options.issuer && payload.iss !== options.issuer) throw new Error("issuer mismatch");
  if (options.audience) {
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(options.audience)) throw new Error("audience mismatch");
  }
}
