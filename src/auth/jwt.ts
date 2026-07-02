// @ts-nocheck

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

export function verifyClaims(payload, options) {
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error("token expired");
  if (options.issuer && payload.iss !== options.issuer) throw new Error("issuer mismatch");
  if (options.audience) {
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(options.audience)) throw new Error("audience mismatch");
  }
}
