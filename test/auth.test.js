import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeAuthConfig } from "../dist/src/core/config.js";
import { createAuthProvider } from "../dist/src/auth/providers.js";
import { startStudio } from "../dist/src/server.js";
import { decodeJwt } from "../dist/src/auth/jwt.js";
import { generateTotpSecret, totpCode } from "../dist/src/auth/totp.js";
import { hashPassword } from "../dist/src/auth/password.js";

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

test("self auth token can carry rbac roles", () => {
  const provider = createAuthProvider({
    provider: "self",
    issuer: "kakurizai",
    audience: "studio",
    secret: "secret"
  });
  const token = provider.issueToken({ subject: "alice", roles: ["operator"], expiresInSeconds: 60 });
  const decoded = decodeJwt(token);
  assert.deepEqual(decoded.payload.roles, ["operator"]);
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

test("studio self auth uses http-only session cookie and csrf", async () => {
  const auth = {
    provider: "self",
    issuer: "kakurizai",
    audience: "studio",
    secret: "secret",
    sessionTtlSeconds: 3600,
    maxLoginAttempts: 4
  };
  const provider = createAuthProvider(auth);
  const token = provider.issueToken({ subject: "alice", expiresInSeconds: 60 });
  const studio = await startStudio({
    studio: { host: "127.0.0.1", port: 0, tls: { certFile: null, keyFile: null } },
    auth,
    cube: { mode: "disabled" },
    storeDir: "/tmp"
  });
  const address = studio.server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(studio.url, `${origin}/`);
    assert.doesNotMatch(studio.url, /token=/);

    const login = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie");
    assert.match(cookie, /kakurizai_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const loginBody = await login.json();
    assert.equal(loginBody.user.subject, "alice");
    assert.ok(loginBody.csrfToken);

    const session = await fetch(`${origin}/api/session`, { headers: { cookie } });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).user.subject, "alice");

    const rejected = await fetch(`${origin}/api/network/probe`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(rejected.status, 403);
  } finally {
    await new Promise((resolve) => studio.server.close(resolve));
  }
});

test("studio self auth enforces totp, rbac, persistent session, and audit log", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-sec-"));
  const secret = generateTotpSecret();
  const auth = {
    provider: "self",
    issuer: "kakurizai",
    audience: "studio",
    secret: "secret",
    sessionTtlSeconds: 3600,
    sessionFile: path.join(tmp, "auth", "sessions.json"),
    rbac: { enabled: true },
    totp: { enabled: true, users: { alice: { secret } } }
  };
  const provider = createAuthProvider(auth);
  const viewerToken = provider.issueToken({ subject: "alice", roles: ["viewer"], expiresInSeconds: 60 });
  const studio = await startStudio({
    home: tmp,
    studio: { host: "127.0.0.1", port: 0, tls: { certFile: null, keyFile: null } },
    auth,
    audit: { enabled: true, file: path.join(tmp, "audit", "studio.jsonl") },
    cube: { mode: "disabled" },
    storeDir: path.join(tmp, "store")
  });
  const origin = `http://127.0.0.1:${studio.server.address().port}`;
  try {
    const rejectedMfa = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: viewerToken })
    });
    assert.equal(rejectedMfa.status, 401);

    const login = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: viewerToken, totp: totpCode(secret) })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie");
    const body = await login.json();
    assert.ok(body.csrfToken);
    assert.deepEqual(body.permissions.sort(), ["studio:read", "worlds:read"]);

    const forbidden = await fetch(`${origin}/api/network/probe`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": body.csrfToken },
      body: "{}"
    });
    assert.equal(forbidden.status, 403);

    const sessionFile = JSON.parse(await waitForFile(auth.sessionFile));
    assert.equal(sessionFile.sessions.length, 1);
    assert.equal(sessionFile.sessions[0].user.subject, "alice");

    const audit = await waitForFile(path.join(tmp, "audit", "studio.jsonl"));
    assert.match(audit, /"action":"auth.login"/);
    assert.match(audit, /"status":403/);
  } finally {
    await new Promise((resolve) => studio.server.close(resolve));
  }
});

test("studio local auth uses password hash, totp, csrf, and audit hash chain", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-local-sec-"));
  const secret = generateTotpSecret();
  const auth = {
    provider: "local",
    sessionTtlSeconds: 3600,
    sessionFile: path.join(tmp, "auth", "sessions.json"),
    users: {
      alice: {
        passwordHash: hashPassword("correct horse battery staple"),
        roles: ["admin"],
        totp: { secret }
      }
    },
    rbac: { enabled: true }
  };
  const studio = await startStudio({
    home: tmp,
    studio: { host: "127.0.0.1", port: 0, tls: { certFile: null, keyFile: null } },
    auth,
    audit: { enabled: true, file: path.join(tmp, "audit", "studio.jsonl"), chain: true },
    cube: { mode: "disabled" },
    storeDir: path.join(tmp, "store")
  });
  const origin = `http://127.0.0.1:${studio.server.address().port}`;
  try {
    const publicConfig = await (await fetch(`${origin}/api/auth/config`)).json();
    assert.equal(publicConfig.requiresCredentials, true);
    assert.equal(publicConfig.mfaRequired, true);

    const rejected = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "wrong", totp: totpCode(secret) })
    });
    assert.equal(rejected.status, 401);

    const login = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "correct horse battery staple", totp: totpCode(secret) })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie");
    const body = await login.json();
    assert.ok(body.csrfToken);
    assert.ok(body.permissions.includes("admin"));

    const logoutWithoutCsrf = await fetch(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: { cookie }
    });
    assert.equal(logoutWithoutCsrf.status, 403);

    const audit = await waitForFile(path.join(tmp, "audit", "studio.jsonl"));
    assert.match(audit, /"seq":1/);
    assert.match(audit, /"hash":"[a-f0-9]{64}"/);
  } finally {
    await new Promise((resolve) => studio.server.close(resolve));
  }
});

test("studio refuses remote exposure without production security", async () => {
  await assert.rejects(
    () => startStudio({
      studio: { host: "0.0.0.0", port: 0, tls: { certFile: null, keyFile: null } },
      auth: { provider: "self", issuer: "kakurizai", audience: "studio", secret: "secret" },
      audit: { enabled: true },
      cube: { mode: "disabled" },
      storeDir: "/tmp"
    }),
    /refusing to expose Studio/
  );
});

async function waitForFile(filePath) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}
