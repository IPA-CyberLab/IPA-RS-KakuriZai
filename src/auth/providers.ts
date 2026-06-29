// @ts-nocheck
import crypto from "node:crypto";
import { normalizeAuthConfig } from "../core/config.js";
import { decodeJwt, signSelfToken, verifyClaims, verifySelfToken } from "./jwt.js";
import { verifyPasswordHash } from "./password.js";

export function createAuthProvider(rawConfig) {
  const config = normalizeAuthConfig(rawConfig);
  if (config.provider === "none") return new NoAuthProvider();
  if (config.provider === "local") return new LocalAuthProvider(config);
  if (config.provider === "self") return new SelfAuthProvider(config);
  if (config.provider === "oidc") return new OidcAuthProvider(config);
  throw new Error(`unsupported auth provider: ${config.provider}`);
}

export class NoAuthProvider {
  type = "none";

  publicConfig() {
    return { provider: "none", label: "Disabled", requiresToken: false };
  }

  async verifyRequest() {
    return { subject: "anonymous", provider: "none", claims: {} };
  }
}

export class LocalAuthProvider {
  constructor(config) {
    this.type = "local";
    this.config = config;
    this.users = config.users || config.local?.users || {};
  }

  publicConfig() {
    return {
      provider: "local",
      label: this.config.label || "KakuriZai Local Auth",
      requiresToken: false,
      requiresCredentials: true
    };
  }

  async verifyLogin(body) {
    const username = String(body.username || body.user || "").trim();
    const password = body.password;
    if (!username || !password) throw unauthorized("missing username or password");
    const record = this.users[username];
    if (!record || record.disabled) throw unauthorized("invalid username or password");
    if (!record.passwordHash) throw unauthorized("local user password hash is not configured");
    let valid = false;
    try {
      valid = verifyPasswordHash(password, record.passwordHash);
    } catch (error) {
      throw unauthorized(error.message || "invalid password hash");
    }
    if (!valid) throw unauthorized("invalid username or password");
    return {
      subject: username,
      provider: "local",
      claims: {
        amr: ["pwd"],
        roles: record.roles || record.role,
        permissions: record.permissions || record.permission || record.scope,
        displayName: record.displayName || username
      }
    };
  }

  async verifyRequest() {
    throw unauthorized("local auth requires a session login");
  }
}

export class SelfAuthProvider {
  constructor(config) {
    this.type = "self";
    this.config = config;
  }

  publicConfig() {
    return {
      provider: "self",
      label: "KakuriZai Self Auth",
      issuer: this.config.issuer,
      audience: this.config.audience,
      requiresToken: true
    };
  }

  issueToken(options = {}) {
    return signSelfToken({
      subject: options.subject || "local-user",
      issuer: this.config.issuer,
      audience: this.config.audience,
      secret: this.config.secret,
      expiresInSeconds: options.expiresInSeconds || 8 * 60 * 60,
      scope: options.scope,
      role: options.role,
      roles: options.roles || (!options.role ? ["admin"] : undefined),
      permissions: options.permissions
    });
  }

  async verifyRequest(request) {
    const token = bearerToken(request);
    if (!token) throw unauthorized("missing bearer token");
    let claims;
    try {
      claims = verifySelfToken(token, this.config);
    } catch (error) {
      throw unauthorized(error.message || "invalid token");
    }
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

  publicConfig() {
    return {
      provider: this.config.providerName || "oidc",
      label: this.config.label || this.config.providerName || "OIDC",
      issuer: this.config.issuer,
      audience: this.config.audience,
      requiresToken: true
    };
  }

  async verifyRequest(request) {
    const token = bearerToken(request);
    if (!token) throw unauthorized("missing bearer token");
    let decoded;
    try {
      decoded = decodeJwt(token);
    } catch (error) {
      throw unauthorized(error.message || "invalid jwt");
    }
    if (decoded.header.alg !== "RS256") throw unauthorized("only RS256 OIDC tokens are supported");
    const key = await this.keyFor(decoded.header.kid);
    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(decoded.signingInput);
    verifier.end();
    const valid = verifier.verify(key, Buffer.from(decoded.signature, "base64url"));
    if (!valid) throw unauthorized("invalid token signature");
    try {
      verifyClaims(decoded.payload, this.config);
    } catch (error) {
      throw unauthorized(error.message || "invalid token claims");
    }
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
