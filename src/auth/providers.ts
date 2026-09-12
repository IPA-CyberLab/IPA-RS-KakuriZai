// @ts-nocheck
import crypto from "node:crypto";
import { normalizeAuthConfig } from "../core/config.js";
import { decodeJwt, verifyClaims } from "./jwt.js";

export function createAuthProvider(rawConfig) {
  const config = normalizeAuthConfig(rawConfig);
  if (config.provider === "none") return new NoAuthProvider();
  if (config.provider === "keycloak" || config.provider === "oidc") return new OidcAuthProvider(config);
  throw new Error(`unsupported auth provider: ${config.provider}`);
}

export class NoAuthProvider {
  type = "none";

  publicConfig() {
    return { provider: "none", label: "Disabled", requiresRedirect: false };
  }

  async verifyRequest() {
    return { subject: "anonymous", provider: "none", claims: {} };
  }
}

export class OidcAuthProvider {
  constructor(config) {
    this.type = config.provider || "oidc";
    this.config = config;
    this.discovery = null;
    this.discoveryLoadedAt = 0;
    this.jwks = null;
    this.jwksLoadedAt = 0;
  }

  publicConfig() {
    return {
      provider: this.config.providerName || this.config.provider || "oidc",
      label: this.config.label || this.config.providerName || "OIDC",
      issuer: this.config.issuer,
      audience: this.config.audience,
      clientId: this.config.clientId,
      loginUrl: "/api/auth/login",
      logoutUrl: "/api/auth/logout",
      accountUrl: `${this.config.issuer}/account`,
      requiresRedirect: true,
      supportsBearer: true
    };
  }

  async authorizationUrl(options) {
    const discovery = await this.loadDiscovery();
    const authorizationEndpoint = discovery.authorization_endpoint || this.config.authorizationEndpoint;
    if (!authorizationEndpoint) throw new Error("OIDC authorization endpoint is not configured");
    const url = new URL(authorizationEndpoint);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", options.redirectUri);
    url.searchParams.set("scope", normalizeScope(this.config.scopes));
    url.searchParams.set("state", options.state);
    url.searchParams.set("nonce", options.nonce);
    for (const [key, value] of Object.entries(this.config.authorizationParams || {})) {
      if (value != null) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async exchangeCode(options) {
    const discovery = await this.loadDiscovery();
    const tokenEndpoint = discovery.token_endpoint || this.config.tokenEndpoint;
    if (!tokenEndpoint) throw new Error("OIDC token endpoint is not configured");
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", options.code);
    body.set("redirect_uri", options.redirectUri);
    body.set("client_id", this.config.clientId);
    const headers = { "content-type": "application/x-www-form-urlencoded" };
    if (this.config.clientSecret) {
      if ((this.config.tokenEndpointAuthMethod || "client_secret_post") === "client_secret_basic") {
        headers.authorization = `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`;
      } else {
        body.set("client_secret", this.config.clientSecret);
      }
    }
    const response = await fetch(tokenEndpoint, { method: "POST", headers, body });
    const tokenSet = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = tokenSet.error_description || tokenSet.error || `OIDC token exchange failed: ${response.status}`;
      throw unauthorized(message);
    }
    const claims = await this.verifyJwt(tokenSet.id_token || tokenSet.access_token, {
      nonce: options.nonce,
      requireNonce: Boolean(tokenSet.id_token)
    });
    return {
      user: this.userFromClaims(claims),
      tokenSet: redactTokenSet(tokenSet)
    };
  }

  async verifyRequest(request) {
    const token = bearerToken(request);
    if (!token) throw unauthorized("missing bearer token");
    const claims = await this.verifyJwt(token);
    return this.userFromClaims(claims);
  }

  async verifyJwt(token, options = {}) {
    if (!token) throw unauthorized("missing oidc token");
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
      verifyClaims(decoded.payload, { issuer: this.config.issuer, audience: this.config.audience });
    } catch (error) {
      throw unauthorized(error.message || "invalid token claims");
    }
    if (options.requireNonce && decoded.payload.nonce !== options.nonce) throw unauthorized("nonce mismatch");
    return decoded.payload;
  }

  userFromClaims(claims) {
    const normalized = normalizeKeycloakClaims(claims, this.config.clientId);
    return {
      subject: normalized.sub,
      provider: this.config.providerName || this.config.provider || "oidc",
      claims: normalized
    };
  }

  async keyFor(kid) {
    const jwks = await this.loadJwks();
    const jwk = jwks.keys.find((candidate) => candidate.kid === kid);
    if (!jwk) throw unauthorized(`jwks key not found: ${kid}`);
    return crypto.createPublicKey({ key: jwk, format: "jwk" });
  }

  async loadDiscovery() {
    const now = Date.now();
    if (this.discovery && now - this.discoveryLoadedAt < 10 * 60 * 1000) return this.discovery;
    const response = await fetch(this.config.discoveryUrl);
    if (!response.ok) throw new Error(`OIDC discovery failed: ${response.status}`);
    const discovery = await response.json();
    if (discovery.issuer && discovery.issuer.replace(/\/+$/, "") !== this.config.issuer.replace(/\/+$/, "")) {
      throw new Error(`OIDC issuer mismatch: ${discovery.issuer}`);
    }
    this.discovery = discovery;
    this.discoveryLoadedAt = now;
    return discovery;
  }

  async loadJwks() {
    const now = Date.now();
    if (this.jwks && now - this.jwksLoadedAt < 10 * 60 * 1000) return this.jwks;
    const discovery = await this.loadDiscovery();
    const jwksUri = this.config.jwksUri || discovery.jwks_uri;
    if (!jwksUri) throw new Error("OIDC JWKS URI is not configured");
    const response = await fetch(jwksUri);
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

function normalizeScope(value) {
  if (!value) return "openid profile email";
  if (Array.isArray(value)) return value.join(" ");
  return String(value);
}

function normalizeKeycloakClaims(claims, clientId) {
  const roles = new Set(arrayClaim(claims.roles));
  for (const role of arrayClaim(claims.realm_access?.roles)) roles.add(role);
  for (const role of arrayClaim(claims.resource_access?.[clientId]?.roles)) roles.add(role);
  for (const group of arrayClaim(claims.groups)) roles.add(group);
  return { ...claims, roles: [...roles] };
}

function arrayClaim(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(arrayClaim);
  return String(value)
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function redactTokenSet(tokenSet) {
  return {
    tokenType: tokenSet.token_type || null,
    expiresIn: tokenSet.expires_in || null,
    scope: tokenSet.scope || null
  };
}
