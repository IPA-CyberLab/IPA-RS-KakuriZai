import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAuthConfig } from "../src/core/config.js";
import { createAuthProvider } from "../src/auth/providers.js";

test("self auth issues and verifies a bearer token", async () => {
  const provider = createAuthProvider({
    provider: "self",
    issuer: "kakurizai",
    audience: "studio",
    secret: "secret"
  });
  const token = provider.issueToken({ subject: "alice", expiresInSeconds: 60 });
  const user = await provider.verifyRequest({ headers: { authorization: `Bearer ${token}` } });
  assert.equal(user.subject, "alice");
  assert.equal(user.provider, "self");
});

test("auth0 config normalizes to oidc", () => {
  const auth = normalizeAuthConfig({
    provider: "auth0",
    domain: "tenant.us.auth0.com",
    audience: "api"
  });
  assert.equal(auth.provider, "oidc");
  assert.equal(auth.issuer, "https://tenant.us.auth0.com/");
  assert.equal(auth.jwksUri, "https://tenant.us.auth0.com/.well-known/jwks.json");
});

test("cognito config normalizes to oidc", () => {
  const auth = normalizeAuthConfig({
    provider: "cognito",
    region: "ap-northeast-1",
    userPoolId: "ap-northeast-1_abc",
    clientId: "client"
  });
  assert.equal(auth.provider, "oidc");
  assert.equal(auth.issuer, "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_abc");
  assert.equal(auth.audience, "client");
});
