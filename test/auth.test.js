import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeAuthConfig } from "../dist/src/core/config.js";
import { createAuthProvider } from "../dist/src/auth/providers.js";
import { startStudio } from "../dist/src/server.js";

test("keycloak config normalizes to oidc discovery", () => {
  const auth = normalizeAuthConfig({
    provider: "keycloak",
    serverUrl: "https://id.example.com/",
    realm: "kakurizai",
    clientId: "studio",
    authorizationParams: { acr_values: "mfa" }
  });
  assert.equal(auth.provider, "keycloak");
  assert.equal(auth.issuer, "https://id.example.com/realms/kakurizai");
  assert.equal(auth.discoveryUrl, "https://id.example.com/realms/kakurizai/.well-known/openid-configuration");
  assert.equal(auth.audience, "studio");
  assert.equal(auth.authorizationParams.acr_values, "mfa");
});

test("keycloak provider verifies bearer tokens and maps keycloak roles", async () => {
  const keycloak = await startMockKeycloak();
  try {
    const provider = createAuthProvider({
      provider: "keycloak",
      issuer: keycloak.issuer,
      discoveryUrl: keycloak.discoveryUrl,
      realm: "kakurizai",
      clientId: "studio",
      audience: "studio",
      mfa: { required: true }
    });
    const token = keycloak.signToken({
      sub: "alice",
      aud: "studio",
      amr: ["pwd", "otp"],
      realm_access: { roles: ["kakurizai-admin"] },
      resource_access: { studio: { roles: ["operator"] } }
    });
    const user = await provider.verifyRequest({ headers: { authorization: `Bearer ${token}` } });
    assert.equal(user.subject, "alice");
    assert.equal(user.provider, "keycloak");
    assert.deepEqual(user.claims.roles.sort(), ["kakurizai-admin", "operator"]);
  } finally {
    await keycloak.close();
  }
});

test("studio signs in through keycloak code flow with session cookie, csrf, rbac, and audit", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-keycloak-"));
  const keycloak = await startMockKeycloak();
  const studio = await startStudio({
    home: tmp,
    studio: { host: "127.0.0.1", port: 0, tls: { certFile: null, keyFile: null } },
    auth: {
      provider: "keycloak",
      issuer: keycloak.issuer,
      discoveryUrl: keycloak.discoveryUrl,
      realm: "kakurizai",
      clientId: "studio",
      audience: "studio",
      sessionFile: path.join(tmp, "auth", "sessions.json"),
      rbac: {
        enabled: true,
        roles: {
          "kakurizai-admin": ["admin"]
        }
      },
      mfa: { required: true }
    },
    audit: { enabled: true, file: path.join(tmp, "audit", "studio.jsonl"), chain: true },
    cube: { mode: "disabled" },
    storeDir: path.join(tmp, "store")
  });
  const origin = `http://127.0.0.1:${studio.server.address().port}`;
  try {
    const publicConfig = await (await fetch(`${origin}/api/auth/config`)).json();
    assert.equal(publicConfig.provider, "keycloak");
    assert.equal(publicConfig.requiresRedirect, true);
    assert.equal(publicConfig.mfaRequired, true);

    const loginStart = await fetch(`${origin}/api/auth/login?returnTo=/observability`, { redirect: "manual" });
    assert.equal(loginStart.status, 302);
    const oidcCookie = loginStart.headers.get("set-cookie");
    assert.match(oidcCookie, /kakurizai_oidc_state=/);
    const keycloakAuth = await fetch(loginStart.headers.get("location"), { redirect: "manual" });
    assert.equal(keycloakAuth.status, 302);
    const callback = await fetch(keycloakAuth.headers.get("location"), {
      redirect: "manual",
      headers: { cookie: oidcCookie }
    });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "/observability");
    const cookie = callback.headers.get("set-cookie");
    assert.match(cookie, /kakurizai_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.ok(Number(/Max-Age=(\d+)/.exec(cookie)?.[1]) >= 604790);
    const sessionCookie = /kakurizai_session=[^;]+/.exec(cookie)?.[0];
    assert.ok(sessionCookie);

    const session = await fetch(`${origin}/api/session`, { headers: { cookie: sessionCookie } });
    assert.equal(session.status, 200);
    const sessionBody = await session.json();
    assert.equal(sessionBody.user.subject, "alice");
    assert.equal(sessionBody.user.username, "alice");
    assert.ok(sessionBody.permissions.includes("admin"));
    assert.ok(sessionBody.csrfToken);
    assert.ok(Number(/Max-Age=(\d+)/.exec(session.headers.get("set-cookie") || "")?.[1]) >= 604790);

    const accountResponse = await fetch(`${origin}/api/account`, { headers: { cookie: sessionCookie } });
    assert.equal(accountResponse.status, 200);
    const account = await accountResponse.json();
    assert.equal(account.subject, "alice");
    assert.equal(account.loginType, "keycloak");

    const updatedAccountResponse = await fetch(`${origin}/api/account`, {
      method: "PATCH",
      headers: {
        cookie: sessionCookie,
        "content-type": "application/json",
        "x-csrf-token": sessionBody.csrfToken
      },
      body: JSON.stringify({ username: "alice.dev", name: "Alice Dev", avatarUrl: "https://example.com/alice.png" })
    });
    assert.equal(updatedAccountResponse.status, 200);
    const updatedAccount = await updatedAccountResponse.json();
    assert.equal(updatedAccount.username, "alice.dev");
    assert.equal(updatedAccount.name, "Alice Dev");

    const browserSessionsResponse = await fetch(`${origin}/api/account/sessions`, { headers: { cookie: sessionCookie } });
    assert.equal(browserSessionsResponse.status, 200);
    const browserSessions = await browserSessionsResponse.json();
    assert.equal(browserSessions.length, 1);
    assert.equal(browserSessions[0].current, true);
    assert.equal(browserSessions[0].id.includes(sessionCookie.split("=")[1]), false);

    const usersResponse = await fetch(`${origin}/api/users`, { headers: { cookie: sessionCookie } });
    assert.equal(usersResponse.status, 200);
    const users = await usersResponse.json();
    assert.equal(users.length, 1);
    assert.ok(users[0].roles.includes("kakurizai-admin"));

    const starterResponse = await fetch(`${origin}/api/terraform/templates/starter`, { headers: { cookie: sessionCookie } });
    assert.equal(starterResponse.status, 200);
    assert.match((await starterResponse.json()).files["main.tf"], /module "sandbox"/);

    const createTemplateResponse = await fetch(`${origin}/api/terraform/templates`, {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        "content-type": "application/json",
        "x-csrf-token": sessionBody.csrfToken
      },
      body: JSON.stringify({
        name: "test-template",
        displayName: "Test template",
        files: { "main.tf": "variable \"name\" {\n  type = string\n}\n" }
      })
    });
    const createTemplateBody = await createTemplateResponse.text();
    assert.equal(createTemplateResponse.status, 201, createTemplateBody);
    const createdTemplate = JSON.parse(createTemplateBody);
    assert.equal(createdTemplate.slug, "test-template");

    const templatesResponse = await fetch(`${origin}/api/terraform/templates`, { headers: { cookie: sessionCookie } });
    assert.equal(templatesResponse.status, 200);
    const listedTemplates = await templatesResponse.json();
    assert.equal(listedTemplates.find((template) => template.id === createdTemplate.id)?.activeVersion, createdTemplate.activeVersion);

    const templateSourceResponse = await fetch(`${origin}/api/terraform/templates/${createdTemplate.id}`, { headers: { cookie: sessionCookie } });
    assert.equal(templateSourceResponse.status, 200);
    assert.match((await templateSourceResponse.json()).files["main.tf"], /variable "name"/);

    const updateTemplateResponse = await fetch(`${origin}/api/terraform/templates`, {
      method: "PUT",
      headers: {
        cookie: sessionCookie,
        "content-type": "application/json",
        "x-csrf-token": sessionBody.csrfToken
      },
      body: JSON.stringify({
        name: "test-template",
        slug: "test-template",
        displayName: "Updated test template",
        files: { "main.tf": "variable \"name\" {\n  type = string\n}\noutput \"revision\" { value = 2 }\n" }
      })
    });
    const updatedTemplateBody = await updateTemplateResponse.text();
    assert.equal(updateTemplateResponse.status, 201, updatedTemplateBody);
    const updatedTemplate = JSON.parse(updatedTemplateBody);
    assert.equal(updatedTemplate.id, createdTemplate.id);
    assert.notEqual(updatedTemplate.activeVersion, createdTemplate.activeVersion);
    assert.equal(updatedTemplate.versions.length, 2);

    const suspendSelf = await fetch(`${origin}/api/users/alice`, {
      method: "PATCH",
      headers: {
        cookie: sessionCookie,
        "content-type": "application/json",
        "x-csrf-token": sessionBody.csrfToken
      },
      body: JSON.stringify({ status: "suspended" })
    });
    assert.equal(suspendSelf.status, 400);

    const rejected = await fetch(`${origin}/api/network/probe`, {
      method: "POST",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(rejected.status, 403);

    const sessionFile = JSON.parse(await waitForFile(path.join(tmp, "auth", "sessions.json")));
    assert.equal(sessionFile.sessions.length, 1);
    assert.equal(sessionFile.sessions[0].user.subject, "alice");

    const accountFile = JSON.parse(await waitForFile(path.join(tmp, "auth", "accounts.json")));
    assert.equal(accountFile.accounts[0].username, "alice.dev");

    const audit = await waitForFile(path.join(tmp, "audit", "studio.jsonl"), /"action":"auth.login"/);
    assert.match(audit, /"hash":"[a-f0-9]{64}"/);
  } finally {
    await new Promise((resolve) => studio.server.close(resolve));
    await keycloak.close();
  }
});

test("studio finishes keycloak callback without state cookie for the same client", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-keycloak-state-"));
  const keycloak = await startMockKeycloak();
  const studio = await startStudio({
    home: tmp,
    studio: { host: "127.0.0.1", port: 0, tls: { certFile: null, keyFile: null } },
    auth: {
      provider: "keycloak",
      issuer: keycloak.issuer,
      discoveryUrl: keycloak.discoveryUrl,
      realm: "kakurizai",
      clientId: "studio",
      audience: "studio",
      rbac: { enabled: true, roles: { "kakurizai-admin": ["admin"] } },
      mfa: { required: true }
    },
    audit: { enabled: true, file: path.join(tmp, "audit", "studio.jsonl") },
    cube: { mode: "disabled" },
    storeDir: path.join(tmp, "store")
  });
  const origin = `http://127.0.0.1:${studio.server.address().port}`;
  const headers = { "user-agent": "kakurizai-state-test" };
  try {
    const loginStart = await fetch(`${origin}/api/auth/login?returnTo=/observability`, { redirect: "manual", headers });
    assert.equal(loginStart.status, 302);
    const keycloakAuth = await fetch(loginStart.headers.get("location"), { redirect: "manual", headers });
    assert.equal(keycloakAuth.status, 302);
    const callback = await fetch(keycloakAuth.headers.get("location"), { redirect: "manual", headers });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "/observability");
    assert.match(callback.headers.get("set-cookie"), /kakurizai_session=/);
  } finally {
    await new Promise((resolve) => studio.server.close(resolve));
    await keycloak.close();
  }
});

test("studio rejects keycloak callback without state cookie from a different client", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-keycloak-state-mismatch-"));
  const keycloak = await startMockKeycloak();
  const studio = await startStudio({
    home: tmp,
    studio: { host: "127.0.0.1", port: 0, tls: { certFile: null, keyFile: null } },
    auth: {
      provider: "keycloak",
      issuer: keycloak.issuer,
      discoveryUrl: keycloak.discoveryUrl,
      realm: "kakurizai",
      clientId: "studio",
      audience: "studio",
      mfa: { required: true }
    },
    audit: { enabled: true, file: path.join(tmp, "audit", "studio.jsonl") },
    cube: { mode: "disabled" },
    storeDir: path.join(tmp, "store")
  });
  const origin = `http://127.0.0.1:${studio.server.address().port}`;
  try {
    const loginStart = await fetch(`${origin}/api/auth/login`, {
      redirect: "manual",
      headers: { "user-agent": "kakurizai-state-test-a" }
    });
    const keycloakAuth = await fetch(loginStart.headers.get("location"), { redirect: "manual" });
    const callback = await fetch(keycloakAuth.headers.get("location"), {
      redirect: "manual",
      headers: { "user-agent": "kakurizai-state-test-b" }
    });
    assert.equal(callback.status, 401);
    assert.match(await callback.text(), /missing or expired oidc state/);
  } finally {
    await new Promise((resolve) => studio.server.close(resolve));
    await keycloak.close();
  }
});

test("studio rejects keycloak sessions without mfa claim when required", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-keycloak-mfa-"));
  const keycloak = await startMockKeycloak({
    tokenClaims: { amr: ["pwd"] }
  });
  const studio = await startStudio({
    home: tmp,
    studio: { host: "127.0.0.1", port: 0, tls: { certFile: null, keyFile: null } },
    auth: {
      provider: "keycloak",
      issuer: keycloak.issuer,
      discoveryUrl: keycloak.discoveryUrl,
      realm: "kakurizai",
      clientId: "studio",
      audience: "studio",
      mfa: { required: true }
    },
    audit: { enabled: true, file: path.join(tmp, "audit", "studio.jsonl") },
    cube: { mode: "disabled" },
    storeDir: path.join(tmp, "store")
  });
  const origin = `http://127.0.0.1:${studio.server.address().port}`;
  try {
    const loginStart = await fetch(`${origin}/api/auth/login`, { redirect: "manual" });
    const oidcCookie = loginStart.headers.get("set-cookie");
    const keycloakAuth = await fetch(loginStart.headers.get("location"), { redirect: "manual" });
    const callback = await fetch(keycloakAuth.headers.get("location"), {
      redirect: "manual",
      headers: { cookie: oidcCookie }
    });
    assert.equal(callback.status, 401);
  } finally {
    await new Promise((resolve) => studio.server.close(resolve));
    await keycloak.close();
  }
});

test("studio refuses remote exposure without keycloak production security", async () => {
  await assert.rejects(
    () => startStudio({
      studio: { host: "0.0.0.0", port: 0, tls: { certFile: null, keyFile: null } },
      auth: {
        provider: "keycloak",
        issuer: "https://keycloak.example.com/realms/kakurizai",
        discoveryUrl: "https://keycloak.example.com/realms/kakurizai/.well-known/openid-configuration",
        realm: "kakurizai",
        clientId: "studio",
        audience: "studio",
        mfa: { required: false }
      },
      audit: { enabled: true },
      cube: { mode: "disabled" },
      storeDir: "/tmp"
    }),
    /refusing to expose Studio/
  );
});

async function startMockKeycloak(options = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "test-key";
  const codes = new Map();
  let origin = "";
  let issuer = "";
  const tokenClaims = options.tokenClaims || {};
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, origin);
    if (url.pathname === "/realms/kakurizai/.well-known/openid-configuration") {
      return json(response, {
        issuer,
        authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
        token_endpoint: `${issuer}/protocol/openid-connect/token`,
        jwks_uri: `${issuer}/protocol/openid-connect/certs`,
        end_session_endpoint: `${issuer}/protocol/openid-connect/logout`
      });
    }
    if (url.pathname === "/realms/kakurizai/protocol/openid-connect/certs") {
      const jwk = publicKey.export({ format: "jwk" });
      return json(response, { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] });
    }
    if (url.pathname === "/realms/kakurizai/protocol/openid-connect/auth") {
      const code = crypto.randomBytes(12).toString("base64url");
      codes.set(code, {
        nonce: url.searchParams.get("nonce"),
        clientId: url.searchParams.get("client_id")
      });
      const redirect = new URL(url.searchParams.get("redirect_uri"));
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", url.searchParams.get("state"));
      response.writeHead(302, { location: redirect.toString() });
      response.end();
      return;
    }
    if (url.pathname === "/realms/kakurizai/protocol/openid-connect/token") {
      const body = new URLSearchParams(await readRequestBody(request));
      const code = body.get("code");
      const entry = codes.get(code);
      if (!entry) return json(response, { error: "invalid_grant" }, 400);
      const idToken = signJwt({
        sub: "alice",
        iss: issuer,
        aud: body.get("client_id") || entry.clientId || "studio",
        nonce: entry.nonce,
        amr: ["pwd", "otp"],
        realm_access: { roles: ["kakurizai-admin"] },
        ...tokenClaims
      }, { privateKey, kid });
      return json(response, {
        token_type: "Bearer",
        expires_in: 300,
        id_token: idToken,
        access_token: idToken
      });
    }
    json(response, { error: "not found" }, 404);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  issuer = `${origin}/realms/kakurizai`;
  return {
    origin,
    issuer,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    signToken(payload) {
      return signJwt({
        iss: issuer,
        aud: "studio",
        exp: Math.floor(Date.now() / 1000) + 300,
        iat: Math.floor(Date.now() / 1000),
        ...payload
      }, { privateKey, kid });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

function signJwt(payload, options) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: options.kid };
  const fullPayload = {
    iat: now,
    exp: now + 300,
    ...payload
  };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(fullPayload)}`;
  const signature = crypto.createSign("RSA-SHA256")
    .update(signingInput)
    .end()
    .sign(options.privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function json(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function waitForFile(filePath, pattern = null) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      if (!pattern || pattern.test(content)) return content;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (lastError) throw lastError;
  throw new Error(`timed out waiting for ${filePath}`);
}
