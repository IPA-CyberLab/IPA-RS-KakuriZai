import crypto from "node:crypto";
import { normalizeAuthConfig } from "../core/config.js";
import { decodeJwt, signSelfToken, verifyClaims, verifySelfToken } from "./jwt.js";

export function createAuthProvider(rawConfig) {
  const config = normalizeAuthConfig(rawConfig);
  if (config.provider === "none") return new NoAuthProvider();
  if (config.provider === "self") return new SelfAuthProvider(config);
  if (config.provider === "oidc") return new OidcAuthProvider(config);
  throw new Error(`unsupported auth provider: ${config.provider}`);
}

export class NoAuthProvider {
  type = "none";

  async verifyRequest() {
    return { subject: "anonymous", provider: "none", claims: {} };
  }
}

export class SelfAuthProvider {
  constructor(config) {
    this.type = "self";
    this.config = config;
  }

  issueToken(options = {}) {
    return signSelfToken({
      subject: options.subject || "local-user",
      issuer: this.config.issuer,
      audience: this.config.audience,
      secret: this.config.secret,
      expiresInSeconds: options.expiresInSeconds || 8 * 60 * 60,
      scope: options.scope
    });
  }

  async verifyRequest(request) {
    const token = bearerToken(request);
    if (!token) throw unauthorized("missing bearer token");
    const claims = verifySelfToken(token, this.config);
    return { subject: claims.sub, provider: "self", claims };
  }
}

export class OidcAuthProvider {
  constructor(config) {
    this.type = "oidc";
    this.config = config;
    this.jwks = null;
    this.jwksLoadedAt = 0;
  }

  async verifyRequest(request) {
    const token = bearerToken(request);
    if (!token) throw unauthorized("missing bearer token");
    const decoded = decodeJwt(token);
    if (decoded.header.alg !== "RS256") throw unauthorized("only RS256 OIDC tokens are supported");
    const key = await this.keyFor(decoded.header.kid);
    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(decoded.signingInput);
    verifier.end();
    const valid = verifier.verify(key, Buffer.from(decoded.signature, "base64url"));
    if (!valid) throw unauthorized("invalid token signature");
    verifyClaims(decoded.payload, this.config);
    return { subject: decoded.payload.sub, provider: this.config.providerName || "oidc", claims: decoded.payload };
  }

  async keyFor(kid) {
    const jwks = await this.loadJwks();
    const jwk = jwks.keys.find((candidate) => candidate.kid === kid);
    if (!jwk) throw unauthorized(`jwks key not found: ${kid}`);
    return crypto.createPublicKey({ key: jwk, format: "jwk" });
  }

  async loadJwks() {
    const now = Date.now();
    if (this.jwks && now - this.jwksLoadedAt < 10 * 60 * 1000) return this.jwks;
    const response = await fetch(this.config.jwksUri);
    if (!response.ok) throw unauthorized(`jwks fetch failed: ${response.status}`);
    this.jwks = await response.json();
    this.jwksLoadedAt = now;
    return this.jwks;
  }
}

export function bearerToken(request) {
  const header = request.headers?.authorization || request.headers?.Authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] || null;
}

export function unauthorized(message) {
  const error = new Error(message);
  error.statusCode = 401;
  return error;
}
