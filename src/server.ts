// @ts-nocheck
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import { WebSocket, WebSocketServer } from "ws";
import { createAuthProvider } from "./auth/providers.js";
import { verifyTotp } from "./auth/totp.js";
import { checkpointFailoverReplicas, createJoinToken, joinNode, listClusterNodes, reconcileFailover, removeClusterNode, replicateWorld, startFailoverController } from "./core/cluster.js";
import { collectMetrics, listTraces, prometheusText, recordTraceEvent, startTrace, stopTrace } from "./core/observability.js";
import { applyWorld, changedPaths, createKubernetesLab, createWorld, execWorld, getWorld, listWorlds, openWorld, pauseWorld, removeWorld, resumeWorld, updateWorldConfig } from "./core/worlds.js";
import { applyProbeChecks, buildNetworkProbePlan, buildProbeScript, parseProbeOutput } from "./core/probe.js";
import { CubeSandboxClient } from "./cube/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = path.join(__dirname, "studio");
const SESSION_COOKIE = "kakurizai_session";
const CSRF_HEADER = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_ROLES = {
  viewer: ["studio:read", "worlds:read"],
  operator: ["studio:read", "worlds:read", "worlds:write", "shell:open", "devaccess:open"],
  admin: ["studio:read", "worlds:read", "worlds:write", "worlds:delete", "shell:open", "devaccess:open", "admin"]
};

export async function startStudio(config) {
  const auth = createAuthProvider(config.auth);
  const tls = await loadTlsOptions(config);
  enforceStudioSecurity(config, Boolean(tls));
  const sessions = new StudioSessionStore(config);
  await sessions.load();
  const audit = new AuditLog(config);
  await audit.load();
  const devAccess = new DevAccessManager(config);
  const rateLimiter = new RequestRateLimiter(config);
  const failoverController = startFailoverController(config);
  const listener = (request, response) => {
    request.audit = audit;
    request.config = config;
    try {
      assertRequestAllowed(config, rateLimiter, request);
    } catch (error) {
      sendError(request, response, error);
      return;
    }
    route(config, auth, sessions, devAccess, request, response).catch((error) => sendError(request, response, error));
  };
  const server = tls ? https.createServer(tls, listener) : http.createServer(listener);
  const protocol = tls ? "https" : "http";
  const shellServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    request.audit = audit;
    request.config = config;
    try {
      assertRequestAllowed(config, rateLimiter, request, { upgrade: true });
    } catch (error) {
      socket.write(`HTTP/1.1 ${error.statusCode || 403} Forbidden\r\nContent-Type: text/plain\r\n\r\n${error.message || String(error)}\n`);
      socket.destroy();
      return;
    }
    handleUpgrade(config, auth, sessions, shellServer, request, socket, head).catch((error) => {
      socket.write(`HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\n${error.message || String(error)}\n`);
      socket.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.studio.port, config.studio.host, resolve);
  });
  server.on("close", () => failoverController.stop());
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : config.studio.port;
  const url = config.studio.publicUrl || `${protocol}://${config.studio.host}:${boundPort}/`;
  return { server, url, auth: auth.publicConfig(), tls: Boolean(tls) };
}

async function loadTlsOptions(config) {
  const certFile = config.studio?.tls?.certFile;
  const keyFile = config.studio?.tls?.keyFile;
  if (!certFile && !keyFile) return null;
  if (!certFile || !keyFile) throw new Error("studio.tls.certFile and studio.tls.keyFile must be configured together");
  const [cert, key] = await Promise.all([fs.readFile(certFile), fs.readFile(keyFile)]);
  return { cert, key };
}

async function handleUpgrade(config, auth, sessions, shellServer, request, socket, head) {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  const match = /^\/api\/worlds\/([^/]+)\/shell$/.exec(url.pathname);
  if (!match) {
    socket.destroy();
    return;
  }
  const session = await authenticateRequest(config, auth, sessions, request, { requireCsrf: false });
  request.user = session.user;
  request.authSession = session.session;
  authorize(config, request, "shell:open");
  const world = await getWorld(config, decodeURIComponent(match[1]));
  void request.audit?.write(auditRecord(request, 101, { action: "shell.open", target: world.id }));
  shellServer.handleUpgrade(request, socket, head, (ws) => {
    shellServer.emit("connection", ws, request, world);
    attachShell(config, world, ws);
  });
}

function attachShell(config, world, ws) {
  let shellProcess;
  try {
    const shell = new CubeSandboxClient(config.cube).shellCommand(world);
    shellProcess = pty.spawn(shell.command, shell.args, {
      name: "xterm-256color",
      cols: 100,
      rows: 24,
      cwd: process.cwd(),
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        CLICOLOR: "1"
      }
    });
  } catch (error) {
    ws.send(`\r\n${error.message || String(error)}\r\n`);
    ws.close();
    return;
  }

  const write = (chunk) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk.toString());
  };
  shellProcess.onData(write);
  shellProcess.onExit(({ exitCode }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`\r\n[session exited ${exitCode ?? ""}]\r\n`);
      ws.close();
    }
  });
  ws.on("message", (message) => {
    const text = message.toString();
    const envelope = parseShellEnvelope(text);
    if (envelope?.type === "resize") {
      shellProcess.resize(envelope.cols, envelope.rows);
      return;
    }
    if (envelope?.type === "input") {
      shellProcess.write(envelope.data);
      return;
    }
    shellProcess.write(text);
  });
  ws.on("close", () => {
    shellProcess.kill("SIGTERM");
  });
  ws.send(`Connected to ${world.name}\r\n`);
}

function parseShellEnvelope(text) {
  if (!text.startsWith("{")) return null;
  try {
    const value = JSON.parse(text);
    if (value?.type === "input" && typeof value.data === "string") return value;
    if (value?.type === "resize") {
      const cols = Number(value.cols);
      const rows = Number(value.rows);
      if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
        return { type: "resize", cols, rows };
      }
    }
  } catch {
    return null;
  }
  return null;
}

class DevAccessManager {
  constructor(config) {
    this.config = config;
    this.sessions = new Map();
    this.pending = new Map();
  }

  async ensure(world, request) {
    const session = await this.ensureSession(world, { vscode: true, ssh: false });
    return this.publicSession(session, request);
  }

  async ensureSession(world, options = {}) {
    const existing = this.pending.get(world.id);
    if (existing) {
      await existing.catch(() => {});
    }
    const task = this.ensureSessionLocked(world, options);
    this.pending.set(world.id, task);
    try {
      return await task;
    } finally {
      if (this.pending.get(world.id) === task) this.pending.delete(world.id);
    }
  }

  async ensureSessionLocked(world, options = {}) {
    const needsVscode = options.vscode !== false;
    const needsSsh = options.ssh === true;
    let session = this.sessions.get(world.id);
    if (!session) {
      const client = new CubeSandboxClient(this.config.cube);
      const runtime = await client.inspectWorldSandbox(world);
      const sandboxIp = runtime.sandboxIp;
      if (!sandboxIp) throw new Error(`sandbox IP is not available for ${world.name}`);
      session = {
        worldId: world.id,
        worldName: world.name,
        sandboxIp,
        workspace: null,
        vscodePort: 13337,
        sshPort: 2222
      };
      this.sessions.set(world.id, session);
    }

    const vscodePort = 13337;
    const sshPort = 2222;
    const client = new CubeSandboxClient(this.config.cube);

    if (needsVscode && !session.vscodeForward) {
      session.vscodePassword = crypto.randomBytes(18).toString("base64url");
      session.vscodeHashedPassword = hashCodeServerPassword(session.vscodePassword);
      const services = await client.startDevAccessServices(world, {
        vscodePort,
        sshPort,
        enableVscode: true,
        enableSsh: false,
        vscodeHashedPassword: session.vscodeHashedPassword
      });
      if (!services.applied) throw new Error(services.reason || `failed to start VS Code Web for ${world.name}`);
      session.workspace = services.workspace;
      session.vscodeForward = await listenTcpForward({
        listenHost: publicListenHost(this.config.studio.host),
        targetHost: session.sandboxIp,
        targetPort: vscodePort
      });
    }

    if (needsSsh && !session.sshForward) {
      session.sshPassword = crypto.randomBytes(18).toString("base64url");
      const services = await client.startDevAccessServices(world, {
        vscodePort,
        sshPort,
        enableVscode: false,
        enableSsh: true,
        sshPassword: session.sshPassword
      });
      if (!services.applied) throw new Error(services.reason || `failed to start SSH for ${world.name}`);
      session.workspace = session.workspace || services.workspace;
      session.sshForward = await listenTcpForward({
        listenHost: publicListenHost(this.config.studio.host),
        targetHost: session.sandboxIp,
        targetPort: sshPort
      });
    }

    return session;
  }

  publicSession(session, request) {
    const origin = publicOrigin(request, this.config);
    const publicHost = publicHostname(origin);
    const httpUrl = session.vscodeForward ? new URL(origin) : null;
    if (httpUrl) {
      httpUrl.port = String(session.vscodeForward.port);
      httpUrl.pathname = "/";
      httpUrl.search = "";
      httpUrl.hash = "";
    }
    const sshCommand = session.sshForward ? `ssh root@${publicHost} -p ${session.sshForward.port}` : null;
    return {
      worldId: session.worldId,
      worldName: session.worldName,
      sandboxIp: session.sandboxIp,
      workspace: session.workspace,
      vscodeUrl: httpUrl ? httpUrl.toString() : null,
      vscodePath: httpUrl ? "/" : null,
      vscodePort: session.vscodeForward ? session.vscodePort : null,
      vscodeForwardPort: session.vscodeForward?.port || null,
      sshHost: publicHost,
      sshPort: session.sshForward?.port || null,
      sshUri: session.sshForward ? `ssh://root@${publicHost}:${session.sshForward.port}` : null,
      sshCommand
    };
  }

  async loginCodeServer(session, publicUrl) {
    if (!session.vscodeForward || !session.vscodePassword) {
      throw new Error("VS Code Web is not started");
    }
    const loginUrl = new URL("login", publicUrl).toString();
    const attempts = [
      { base: ".", href: loginUrl },
      { base: "/", href: publicUrl }
    ];
    let lastError = null;
    for (const attempt of attempts) {
      try {
        return await postCodeServerLogin({
          port: session.vscodeForward.port,
          host: new URL(publicUrl).host,
          password: session.vscodePassword,
          base: attempt.base,
          href: attempt.href
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("code-server login failed");
  }
}

function postCodeServerLogin(options) {
  const body = new URLSearchParams({
    password: options.password,
    base: options.base,
    href: options.href
  }).toString();
  return new Promise((resolve, reject) => {
    const chunks = [];
    const request = http.request({
      host: "127.0.0.1",
      port: options.port,
      method: "POST",
      path: "/login",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": Buffer.byteLength(body),
        host: options.host
      }
    }, (response) => {
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const cookies = response.headers["set-cookie"] || [];
        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`code-server login failed with ${response.statusCode}`));
          return;
        }
        if (!cookies.length) {
          const text = Buffer.concat(chunks).toString("utf8");
          const detail = /error[^>]*>([^<]+)/i.exec(text)?.[1]?.trim();
          reject(new Error(detail || "code-server login did not return an auth cookie"));
          return;
        }
        resolve(Array.isArray(cookies) ? cookies : [cookies]);
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

function hashCodeServerPassword(password) {
  if (typeof crypto.argon2Sync !== "function") {
    throw new Error("Node.js crypto.argon2Sync is required for code-server password hashing");
  }
  const salt = crypto.randomBytes(16);
  const memory = 4096;
  const passes = 3;
  const parallelism = 1;
  const hash = crypto.argon2Sync("argon2id", {
    message: password,
    nonce: salt,
    parallelism,
    tagLength: 32,
    memory,
    passes
  });
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${phcBase64(salt)}$${phcBase64(hash)}`;
}

function phcBase64(value) {
  return Buffer.from(value).toString("base64").replace(/=+$/g, "");
}

function listenTcpForward(options) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((clientSocket) => {
      const upstream = net.createConnection({ host: options.targetHost, port: options.targetPort });
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
      clientSocket.on("error", () => upstream.destroy());
      upstream.on("error", () => clientSocket.destroy());
    });
    server.once("error", reject);
    server.listen(0, options.listenHost, () => {
      server.off("error", reject);
      resolve({ server, port: server.address().port });
    });
  });
}

function publicListenHost(studioHost) {
  return studioHost === "127.0.0.1" || studioHost === "localhost" ? "127.0.0.1" : "0.0.0.0";
}

function publicOrigin(request, config) {
  const proto = trustedHeader(config, request, "x-forwarded-proto") || (request.socket?.encrypted ? "https" : "http");
  const host = trustedHeader(config, request, "x-forwarded-host") || request.headers.host || `${config.studio.host}:${config.studio.port}`;
  return `${Array.isArray(proto) ? proto[0] : proto}://${Array.isArray(host) ? host[0] : host}`;
}

function publicHostname(origin) {
  const hostname = new URL(origin).hostname;
  if (hostname === "0.0.0.0") return "127.0.0.1";
  return hostname;
}

function securityBaseDir(config) {
  return config.home || config.storeDir || path.join(process.cwd(), ".kakurizai");
}

class StudioSessionStore {
  constructor(config) {
    this.config = config;
    this.sessions = new Map();
    this.loginAttempts = new Map();
    this.ttlMs = Number(config.auth.sessionTtlSeconds || 8 * 60 * 60) * 1000;
    this.maxLoginAttempts = Number(config.auth.maxLoginAttempts || 12);
    this.persist = config.auth.persistSessions !== false;
    this.file = config.auth.sessionFile || path.join(securityBaseDir(config), "auth", "studio-sessions.json");
    this.saveTask = Promise.resolve();
  }

  async load() {
    if (!this.persist) return;
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8"));
      const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
      const now = Date.now();
      for (const session of sessions) {
        if (session?.id && session?.csrfToken && session?.user && session.expiresAt > now) {
          this.sessions.set(session.id, session);
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  create(user) {
    const id = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.ttlMs;
    const session = { id, csrfToken, user, expiresAt };
    this.sessions.set(id, session);
    void this.save();
    return session;
  }

  get(id) {
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      void this.save();
      return null;
    }
    return session;
  }

  destroy(id) {
    if (id) {
      this.sessions.delete(id);
      void this.save();
    }
  }

  save() {
    if (!this.persist) return Promise.resolve();
    this.saveTask = this.saveTask.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const sessions = [...this.sessions.values()].filter((session) => session.expiresAt > Date.now());
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(tmp, this.file);
    }).catch(() => {});
    return this.saveTask;
  }

  assertLoginAllowed(key) {
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;
    const current = this.loginAttempts.get(key);
    if (!current || current.resetAt <= now) {
      this.loginAttempts.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    current.count += 1;
    if (current.count > this.maxLoginAttempts) {
      const error = new Error("too many login attempts");
      error.statusCode = 429;
      throw error;
    }
  }

  resetLoginAttempts(key) {
    this.loginAttempts.delete(key);
  }
}

class AuditLog {
  constructor(config) {
    this.config = config;
    this.enabled = config.audit?.enabled !== false;
    this.logReads = config.audit?.logReads === true;
    this.file = config.audit?.file || path.join(securityBaseDir(config), "audit", "studio.jsonl");
    this.chain = config.audit?.chain !== false;
    this.seq = 0;
    this.lastHash = null;
    this.writeTask = Promise.resolve();
  }

  async load() {
    if (!this.enabled || !this.chain) return;
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const lines = raw.trim().split("\n").filter(Boolean);
      const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
      this.seq = Number(last?.seq || lines.length || 0);
      this.lastHash = last?.hash || null;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  write(record) {
    if (!this.enabled) return Promise.resolve();
    if (record.readOnly && !this.logReads) return Promise.resolve();
    this.writeTask = this.writeTask.then(async () => {
      const entry = this.chain ? this.chainRecord(record) : record;
      const line = `${JSON.stringify(entry)}\n`;
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await fs.appendFile(this.file, line, { encoding: "utf8", mode: 0o600 });
    }).catch(() => {});
    return this.writeTask;
  }

  chainRecord(record) {
    const entry = {
      ...record,
      seq: this.seq + 1,
      prevHash: this.lastHash
    };
    const hash = crypto.createHash("sha256")
      .update(stableJson(entry))
      .digest("hex");
    entry.hash = hash;
    this.seq = entry.seq;
    this.lastHash = hash;
    return entry;
  }
}

class RequestRateLimiter {
  constructor(config) {
    const rate = config.studio?.rateLimit || {};
    this.enabled = rate.enabled !== false;
    this.windowMs = Number(rate.windowSeconds || 60) * 1000;
    this.maxRequests = Number(rate.maxRequests || 600);
    this.buckets = new Map();
  }

  check(key) {
    if (!this.enabled) return;
    const now = Date.now();
    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    current.count += 1;
    if (current.count > this.maxRequests) {
      const error = new Error("rate limit exceeded");
      error.statusCode = 429;
      throw error;
    }
  }
}

function enforceStudioSecurity(config, tlsEnabled) {
  if (config.security?.enforceRemoteAccess === false || config.security?.allowInsecureRemote === true) return;
  if (!isRemoteBind(config.studio?.host)) return;
  const issues = [];
  if (config.auth?.provider === "none") issues.push("auth.provider must not be none");
  if (config.auth?.rbac?.enabled === false) issues.push("auth.rbac.enabled must not be false");
  if (!authConfigRequiresMfa(config)) issues.push("MFA must be enabled");
  if (config.auth?.persistSessions === false) issues.push("auth.persistSessions must not be false");
  if (config.audit?.enabled === false) issues.push("audit.enabled must not be false");
  if (!tlsEnabled && !httpsPublicUrl(config)) issues.push("configure studio.tls or an https studio.publicUrl");
  if (!tlsEnabled && !config.studio?.secureCookies) issues.push("studio.secureCookies must be true behind HTTPS reverse proxies");
  if (!allowedHostnames(config).size) issues.push("studio.publicUrl or studio.allowedHosts must pin the public host");
  if (!providerHasProductionMfa(config)) issues.push("provider MFA must cover every login user");
  if (issues.length) {
    const error = new Error(`refusing to expose Studio on ${config.studio?.host}: ${issues.join("; ")}`);
    error.statusCode = 500;
    throw error;
  }
}

function assertRequestAllowed(config, rateLimiter, request, options = {}) {
  const ip = requestIp(request, config);
  assertIpAllowed(config, ip);
  rateLimiter?.check(ip || "unknown");
  assertHostAllowed(config, request);
  assertOriginAllowed(config, request, options);
}

function assertIpAllowed(config, ip) {
  const deny = config.studio?.ipDenylist || [];
  if (deny.some((rule) => ipMatchesRule(ip, rule))) {
    const error = new Error("client ip is denied");
    error.statusCode = 403;
    throw error;
  }
  const allow = config.studio?.ipAllowlist || [];
  if (allow.length && !allow.some((rule) => ipMatchesRule(ip, rule))) {
    const error = new Error("client ip is not allowed");
    error.statusCode = 403;
    throw error;
  }
}

function assertHostAllowed(config, request) {
  const host = hostnameFromHostHeader(request.headers.host);
  if (!host) {
    const error = new Error("missing host header");
    error.statusCode = 400;
    throw error;
  }
  const allowed = allowedHostnames(config);
  if (!allowed.size || allowed.has("*") || allowed.has(host.toLowerCase())) return;
  const error = new Error("host header is not allowed");
  error.statusCode = 421;
  throw error;
}

function assertOriginAllowed(config, request, options = {}) {
  const origin = request.headers.origin;
  if (!origin) return;
  if (!options.upgrade && SAFE_METHODS.has(request.method)) return;
  const allowed = new Set();
  for (const item of config.studio?.trustedOrigins || []) {
    const normalized = normalizeOrigin(item);
    if (normalized) allowed.add(normalized);
  }
  if (config.studio?.publicUrl) {
    const normalized = normalizeOrigin(config.studio.publicUrl);
    if (normalized) allowed.add(normalized);
  }
  allowed.add(normalizeOrigin(publicOrigin(request, config)));
  if (allowed.has(normalizeOrigin(origin))) return;
  const error = new Error("origin is not allowed");
  error.statusCode = 403;
  throw error;
}

function providerHasProductionMfa(config) {
  const provider = config.auth?.provider;
  if (provider === "local") {
    const users = localUsers(config).filter(([, user]) => !user.disabled);
    return users.length > 0 && users.every(([name, user]) => hasUserTotp(user) || Boolean(totpUserConfig(config, name)));
  }
  if (provider === "self") {
    const users = config.auth?.totp?.users || {};
    return config.auth?.totp?.enabled === true && Object.keys(users).length > 0;
  }
  if (provider === "oidc" || provider === "auth0" || provider === "cognito") {
    return config.auth?.mfa?.required === true;
  }
  return false;
}

function localUsers(config) {
  const users = config.auth?.users || config.auth?.local?.users || {};
  return Object.entries(users);
}

function hasUserTotp(user) {
  return Boolean(user?.totp || user?.totpSecret);
}

function httpsPublicUrl(config) {
  if (!config.studio?.publicUrl) return false;
  try {
    return new URL(config.studio.publicUrl).protocol === "https:";
  } catch {
    return false;
  }
}

function isRemoteBind(host) {
  const value = String(host || "").toLowerCase();
  if (!value || value === "0.0.0.0" || value === "::" || value === "[::]") return true;
  return !["127.0.0.1", "::1", "localhost"].includes(value);
}

function allowedHostnames(config) {
  const allowed = new Set();
  for (const host of config.studio?.allowedHosts || []) {
    if (host === "*") allowed.add("*");
    else {
      const normalized = hostnameFromHostHeader(host) || host;
      if (normalized) allowed.add(String(normalized).toLowerCase());
    }
  }
  if (config.studio?.publicUrl) {
    try {
      allowed.add(new URL(config.studio.publicUrl).hostname.toLowerCase());
    } catch {
      // Invalid publicUrl is caught by the remote exposure guard when it matters.
    }
  }
  const host = String(config.studio?.host || "");
  if (host && !["0.0.0.0", "::", "[::]"].includes(host)) {
    allowed.add(host.replace(/^\[|\]$/g, "").toLowerCase());
  }
  if (!isRemoteBind(host)) {
    allowed.add("127.0.0.1");
    allowed.add("localhost");
    allowed.add("::1");
  }
  return allowed;
}

function hostnameFromHostHeader(value) {
  if (!value || Array.isArray(value)) return null;
  try {
    return new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

function normalizeOrigin(value) {
  if (!value || Array.isArray(value)) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

async function route(config, auth, sessions, devAccess, request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  if (request.method === "GET" && url.pathname === "/api/auth/config") {
    return sendJson(request, response, {
      ...auth.publicConfig(),
      sessionCookie: auth.type !== "none",
      csrfHeader: CSRF_HEADER,
      mfaRequired: authConfigRequiresMfa(config),
      rbac: rbacPublicConfig(config)
    });
  }
  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    return login(config, auth, sessions, request, response);
  }
  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const session = await authenticateRequest(config, auth, sessions, request, { requireCsrf: auth.type !== "none" });
    request.user = session.user;
    request.authSession = session.session;
    const sessionId = cookieValue(request, SESSION_COOKIE);
    sessions.destroy(sessionId);
    response.writeHead(204, {
      ...securityHeaders(request, "application/json; charset=utf-8"),
      "set-cookie": expiredSessionCookie()
    });
    response.end();
    void request.audit?.write(auditRecord(request, 204, { action: "auth.logout" }));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    const session = await authenticateRequest(config, auth, sessions, request, { requireCsrf: requiresCsrf(url, request) });
    request.user = session.user;
    request.authSession = session.session;
    request.authMethod = session.method;
    request.query = url.searchParams;
    return api(config, devAccess, request, response, url);
  }
  return staticFile(request, response, url);
}

async function login(config, auth, sessions, request, response) {
  if (auth.type === "none") {
    const user = await auth.verifyRequest(request);
    return sendJson(request, response, { user, auth: user.provider, csrfToken: null });
  }
  const body = await readBody(request);
  const key = `${requestIp(request, config)}:${body.username || body.user || "token"}`;
  sessions.assertLoginAllowed(key);
  const user = await verifyLoginUser(auth, body);
  verifyMfa(config, user, body);
  sessions.resetLoginAttempts(key);
  const session = sessions.create(user);
  request.user = user;
  request.authSession = session;
  return sendJson(request, response, {
    user,
    auth: user.provider,
    permissions: [...permissionsForUser(config, user)],
    csrfToken: session.csrfToken
  }, 200, {
    "set-cookie": sessionCookie(config, request, session)
  });
}

async function verifyLoginUser(auth, body) {
  if (typeof auth.verifyLogin === "function") return auth.verifyLogin(body);
  const token = body.token || body.bearerToken;
  if (!token || typeof token !== "string") {
    const error = new Error("missing bearer token");
    error.statusCode = 401;
    throw error;
  }
  return auth.verifyRequest({ headers: { authorization: `Bearer ${token}` } });
}

async function authenticateRequest(config, auth, sessions, request, options = {}) {
  const bearer = bearerHeader(request);
  if (bearer) {
    const user = await auth.verifyRequest({ headers: { authorization: bearer } });
    verifyBearerMfaPolicy(config, user);
    return { method: "bearer", user, session: null };
  }
  if (auth.type === "none") {
    const user = await auth.verifyRequest(request);
    return { method: "none", user, session: null };
  }
  const session = sessions.get(cookieValue(request, SESSION_COOKIE));
  if (!session) {
    const error = new Error("missing or expired session");
    error.statusCode = 401;
    throw error;
  }
  if (options.requireCsrf) {
    const csrfToken = request.headers[CSRF_HEADER];
    if (csrfToken !== session.csrfToken) {
      const error = new Error("invalid csrf token");
      error.statusCode = 403;
      throw error;
    }
  }
  return { method: "session", user: session.user, session };
}

function requiresCsrf(url, request) {
  if (!SAFE_METHODS.has(request.method)) return true;
  if (/^\/api\/worlds\/[^/]+\/dev-access\/open$/.test(url.pathname)) return true;
  return false;
}

function bearerHeader(request) {
  const header = request.headers?.authorization || request.headers?.Authorization;
  return /^Bearer\s+.+$/i.test(header || "") ? header : null;
}

function cookieValue(request, name) {
  const cookie = request.headers.cookie || "";
  for (const part of cookie.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }
  return null;
}

function sessionCookie(config, request, session) {
  const maxAge = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
  const secure = secureCookie(config, request) ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

function expiredSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

function secureCookie(config, request) {
  if (config.studio?.secureCookies === true) return true;
  if (request.socket?.encrypted) return true;
  const proto = trustedHeader(config, request, "x-forwarded-proto");
  return (Array.isArray(proto) ? proto[0] : proto) === "https";
}

function requestIp(request, config = request.config) {
  const remote = normalizeIp(request.socket?.remoteAddress || "unknown");
  const forwarded = trustedHeader(config, request, "x-forwarded-for");
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return normalizeIp((value || remote || "unknown").split(",")[0].trim());
}

function trustedHeader(config, request, name) {
  if (!config?.studio?.trustProxy) return null;
  const proxies = config.studio.trustedProxies || [];
  if (proxies.length) {
    const remote = normalizeIp(request.socket?.remoteAddress || "unknown");
    if (!proxies.some((rule) => ipMatchesRule(remote, rule))) return null;
  }
  return request.headers[name];
}

function authConfigRequiresMfa(config) {
  return Boolean(config.auth?.totp?.enabled || config.auth?.mfa?.required || localUsers(config).some(([, user]) => hasUserTotp(user)));
}

function rbacPublicConfig(config) {
  return {
    enabled: config.auth?.rbac?.enabled !== false,
    roles: Object.keys({ ...DEFAULT_ROLES, ...(config.auth?.rbac?.roles || {}) })
  };
}

function verifyMfa(config, user, body) {
  const totp = totpUserConfig(config, user.subject);
  if (totp) {
    const token = body.totp || body.otp || body.mfaCode;
    if (!verifyTotp(totp.secret, token, {
      digits: totp.digits || config.auth?.totp?.digits || 6,
      period: totp.period || config.auth?.totp?.period || 30,
      window: totp.window == null ? config.auth?.totp?.window : totp.window
    })) {
      const error = new Error("invalid one-time code");
      error.statusCode = 401;
      throw error;
    }
    return;
  }
  if (config.auth?.totp?.enabled) {
    const error = new Error("totp is required for this user");
    error.statusCode = 401;
    throw error;
  }
  if (config.auth?.mfa?.required && !claimHasMfa(user.claims || {})) {
    const error = new Error("identity provider mfa claim is required");
    error.statusCode = 401;
    throw error;
  }
}

function verifyBearerMfaPolicy(config, user) {
  if (totpUserConfig(config, user.subject) || config.auth?.totp?.enabled) {
    const error = new Error("session login is required when totp is enabled");
    error.statusCode = 401;
    throw error;
  }
  if (config.auth?.mfa?.required && !claimHasMfa(user.claims || {})) {
    const error = new Error("identity provider mfa claim is required");
    error.statusCode = 401;
    throw error;
  }
}

function totpUserConfig(config, subject) {
  const users = config.auth?.totp?.users || {};
  const value = users[subject] || users["*"];
  if (value) return typeof value === "string" ? { secret: value } : value;
  const local = localUsers(config).find(([name]) => name === subject)?.[1];
  if (!local) return null;
  if (local.totpSecret) return { secret: local.totpSecret };
  if (local.totp) return typeof local.totp === "string" ? { secret: local.totp } : local.totp;
  return null;
}

function claimHasMfa(claims) {
  const amr = arrayClaim(claims.amr);
  if (amr.some((value) => ["mfa", "otp", "totp", "hwk", "webauthn"].includes(value))) return true;
  const acr = String(claims.acr || "").toLowerCase();
  return acr.includes("mfa") || acr.includes("multi-factor");
}

function authorize(config, request, permission) {
  if (config.auth?.provider === "none" || config.auth?.rbac?.enabled === false) return;
  const permissions = permissionsForUser(config, request.user);
  request.permissions = [...permissions];
  if (permissions.has("admin") || permissions.has(permission)) return;
  const error = new Error(`permission denied: ${permission}`);
  error.statusCode = 403;
  throw error;
}

function permissionsForUser(config, user) {
  const permissions = new Set();
  if (!user) return permissions;
  const rbac = config.auth?.rbac || {};
  const roles = new Set();
  const claims = user.claims || {};

  addValues(roles, claims.roles);
  addValues(roles, claims.role);
  addValues(roles, claims.groups);
  addValues(roles, claims["cognito:groups"]);
  addValues(permissions, claims.permissions);
  addValues(permissions, claims.permission);
  addValues(permissions, claims.scope);
  addValues(permissions, claims.scp);

  const binding = rbac.users?.[user.subject] || rbac.users?.["*"];
  if (binding) {
    if (typeof binding === "string" || Array.isArray(binding)) addValues(roles, binding);
    else {
      addValues(roles, binding.roles || binding.role);
      addValues(permissions, binding.permissions || binding.permission || binding.scope);
    }
  }
  if (roles.size === 0 && permissions.size === 0 && rbac.defaultRole) roles.add(rbac.defaultRole);

  const roleDefinitions = { ...DEFAULT_ROLES, ...(rbac.roles || {}) };
  for (const role of roles) {
    addValues(permissions, roleDefinitions[role]);
  }
  return permissions;
}

function addValues(target, value) {
  for (const item of arrayClaim(value)) target.add(item);
}

function arrayClaim(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(arrayClaim);
  return String(value)
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function ipMatchesRule(ip, rule) {
  if (!ip || !rule) return false;
  if (rule === "*") return true;
  const normalizedIp = normalizeIp(ip);
  const normalizedRule = normalizeIp(String(rule).split("/")[0]);
  if (!String(rule).includes("/")) return normalizedIp === normalizedRule;
  const [address, rawPrefix] = String(rule).split("/");
  const prefix = Number(rawPrefix);
  const left = ipToBigInt(normalizedIp);
  const right = ipToBigInt(normalizeIp(address));
  if (!left || !right || left.version !== right.version) return false;
  const bits = left.version === 4 ? 32n : 128n;
  if (!Number.isInteger(prefix) || prefix < 0 || BigInt(prefix) > bits) return false;
  const shift = bits - BigInt(prefix);
  return (left.value >> shift) === (right.value >> shift);
}

function normalizeIp(value) {
  const text = String(value || "").replace(/^\[|\]$/g, "");
  if (text.startsWith("::ffff:") && net.isIP(text.slice(7)) === 4) return text.slice(7);
  return text;
}

function ipToBigInt(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    const parts = ip.split(".").map(Number);
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    return {
      version: 4,
      value: parts.reduce((result, part) => (result << 8n) + BigInt(part), 0n)
    };
  }
  if (version !== 6) return null;
  const expanded = expandIpv6(ip);
  if (!expanded) return null;
  return {
    version: 6,
    value: expanded.reduce((result, part) => (result << 16n) + BigInt(part), 0n)
  };
}

function expandIpv6(ip) {
  const [leftRaw, rightRaw] = ip.split("::");
  if (ip.split("::").length > 2) return null;
  const left = leftRaw ? leftRaw.split(":").filter(Boolean) : [];
  const right = rightRaw ? rightRaw.split(":").filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right].map((part) => Number.parseInt(part, 16));
  if (groups.length !== 8 || groups.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) return null;
  return groups;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function auditRecord(request, status, extra = {}) {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  return {
    ts: new Date().toISOString(),
    action: extra.action || auditAction(url, request),
    status,
    subject: request.user?.subject || null,
    provider: request.user?.provider || null,
    method: request.method,
    path: url.pathname,
    target: extra.target || targetFromPath(url.pathname),
    ip: requestIp(request, request.config),
    userAgent: request.headers["user-agent"] || null,
    readOnly: SAFE_METHODS.has(request.method)
  };
}

function traceEventFromRequest(request, status) {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  const target = targetFromPath(url.pathname);
  return {
    ts: new Date().toISOString(),
    kind: "api",
    action: auditAction(url, request),
    status,
    subject: request.user?.subject || null,
    provider: request.user?.provider || null,
    method: request.method,
    path: url.pathname,
    target,
    worldId: target,
    ip: requestIp(request, request.config)
  };
}

function auditAction(url, request) {
  if (url.pathname === "/api/auth/login") return "auth.login";
  if (url.pathname === "/api/auth/logout") return "auth.logout";
  if (request.method === "DELETE") return "delete";
  if (!SAFE_METHODS.has(request.method)) return "write";
  return "read";
}

function targetFromPath(pathname) {
  const world = /^\/api\/worlds\/([^/]+)/.exec(pathname);
  if (world) return decodeURIComponent(world[1]);
  const sandbox = /^\/api\/cube\/sandboxes\/([^/]+)/.exec(pathname);
  if (sandbox) return decodeURIComponent(sandbox[1]);
  return null;
}

async function api(config, devAccess, request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/session") {
    authorize(config, request, "studio:read");
    return sendJson(request, response, {
      user: request.user,
      auth: request.user.provider,
      permissions: request.permissions || [...permissionsForUser(config, request.user)],
      csrfToken: request.authSession?.csrfToken || null
    });
  }
  if (request.method === "GET" && url.pathname === "/api/host/browse") {
    authorize(config, request, "worlds:write");
    return sendJson(request, response, await browseHost(url.searchParams.get("path") || process.env.HOME || "/"));
  }
  if (request.method === "GET" && url.pathname === "/api/cube/inspect") {
    authorize(config, request, "worlds:read");
    return sendJson(request, response, await new CubeSandboxClient(config.cube).inspect());
  }
  if (request.method === "POST" && url.pathname === "/api/network/probe") {
    authorize(config, request, "worlds:write");
    return sendJson(request, response, await probeNetwork(config, await readBody(request)));
  }
  if (request.method === "POST" && url.pathname === "/api/labs/kubernetes") {
    authorize(config, request, "worlds:write");
    return sendJson(request, response, await createKubernetesLab(config, await readBody(request)), 201);
  }
  if (request.method === "GET" && url.pathname === "/api/cluster/nodes") {
    authorize(config, request, "worlds:read");
    return sendJson(request, response, await listClusterNodes(config));
  }
  if (request.method === "POST" && url.pathname === "/api/cluster/failover/reconcile") {
    authorize(config, request, "worlds:write");
    return sendJson(request, response, await reconcileFailover(config, await readBody(request)));
  }
  if (request.method === "POST" && url.pathname === "/api/cluster/failover/checkpoint") {
    authorize(config, request, "worlds:write");
    return sendJson(request, response, await checkpointFailoverReplicas(config, await readBody(request)));
  }
  if (request.method === "GET" && url.pathname === "/api/observability/metrics") {
    authorize(config, request, "worlds:read");
    return sendJson(request, response, await collectMetrics(config));
  }
  if (request.method === "GET" && url.pathname === "/api/observability/prometheus") {
    authorize(config, request, "worlds:read");
    return sendText(request, response, prometheusText(await collectMetrics(config, { persist: false })), "text/plain; version=0.0.4; charset=utf-8");
  }
  if (request.method === "GET" && url.pathname === "/api/observability/traces") {
    authorize(config, request, "worlds:read");
    return sendJson(request, response, await listTraces(config));
  }
  if (request.method === "POST" && url.pathname === "/api/observability/traces") {
    authorize(config, request, "worlds:write");
    return sendJson(request, response, await startTrace(config, await readBody(request)), 201);
  }
  const traceStopMatch = /^\/api\/observability\/traces\/([^/]+)\/stop$/.exec(url.pathname);
  if (request.method === "POST" && traceStopMatch) {
    authorize(config, request, "worlds:write");
    return sendJson(request, response, await stopTrace(config, decodeURIComponent(traceStopMatch[1])));
  }
  if (request.method === "POST" && url.pathname === "/api/cluster/join-token") {
    authorize(config, request, "admin");
    return sendJson(request, response, await createJoinToken(config, await readBody(request)), 201);
  }
  if (request.method === "POST" && url.pathname === "/api/cluster/nodes") {
    authorize(config, request, "admin");
    return sendJson(request, response, await joinNode(config, { ...(await readBody(request)), requireToken: false }), 201);
  }
  const clusterNodeMatch = /^\/api\/cluster\/nodes\/([^/]+)$/.exec(url.pathname);
  if (request.method === "DELETE" && clusterNodeMatch) {
    authorize(config, request, "admin");
    return sendJson(request, response, await removeClusterNode(config, decodeURIComponent(clusterNodeMatch[1])));
  }
  const cubeSandboxMatch = /^\/api\/cube\/sandboxes\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (cubeSandboxMatch) {
    const [, sandboxId, action] = cubeSandboxMatch;
    const client = new CubeSandboxClient(config.cube);
    if (request.method === "GET" && action === "logs") {
      authorize(config, request, "worlds:read");
      return sendJson(request, response, await client.logs(decodeURIComponent(sandboxId), {
        tail: Number(url.searchParams.get("tail") || 120)
      }));
    }
    if (request.method === "POST" && action === "destroy") {
      authorize(config, request, "worlds:delete");
      return sendJson(request, response, await client.destroySandboxById(decodeURIComponent(sandboxId)));
    }
    if (request.method === "POST" && action === "pause") {
      authorize(config, request, "worlds:write");
      return sendJson(request, response, await client.pauseSandboxById(decodeURIComponent(sandboxId)));
    }
    if (request.method === "POST" && action === "resume") {
      authorize(config, request, "worlds:write");
      return sendJson(request, response, await client.resumeSandboxById(decodeURIComponent(sandboxId)));
    }
  }
  if (request.method === "GET" && url.pathname === "/api/worlds") {
    authorize(config, request, "worlds:read");
    return sendJson(request, response, await listWorlds(config));
  }
  if (request.method === "POST" && url.pathname === "/api/worlds") {
    authorize(config, request, "worlds:write");
    const body = await readBody(request);
    const world = await createWorld(config, body);
    return sendJson(request, response, world, 201);
  }
  const devAccessOpenMatch = /^\/api\/worlds\/([^/]+)\/dev-access\/open$/.exec(url.pathname);
  if (request.method === "POST" && devAccessOpenMatch) {
    authorize(config, request, "devaccess:open");
    const world = await getWorld(config, decodeURIComponent(devAccessOpenMatch[1]));
    const session = await devAccess.ensureSession(world, { vscode: true, ssh: false });
    const publicSession = devAccess.publicSession(session, request);
    const cookies = await devAccess.loginCodeServer(session, publicSession.vscodeUrl);
    return sendJson(request, response, { vscodeUrl: publicSession.vscodeUrl }, 200, {
      ...(cookies.length ? { "set-cookie": cookies } : {})
    });
  }
  const match = /^\/api\/worlds\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) return sendJson(request, response, { error: "not found" }, 404);
  const [, ref, action] = match;
  if (request.method === "DELETE" && !action) {
    authorize(config, request, "worlds:delete");
    return sendJson(request, response, await removeWorld(config, decodeURIComponent(ref), { exactId: true }));
  }
  if (request.method === "PATCH" && action === "config") {
    authorize(config, request, "worlds:write");
    return sendJson(request, response, await updateWorldConfig(config, decodeURIComponent(ref), await readBody(request)));
  }
  if (request.method === "GET" && action === "changed") {
    authorize(config, request, "worlds:read");
    return sendJson(request, response, await changedPaths(config, decodeURIComponent(ref)));
  }
  if (request.method === "POST" && action === "apply") {
    authorize(config, request, "worlds:write");
    return sendJson(request, response, await applyWorld(config, decodeURIComponent(ref), await readBody(request)));
  }
  if (request.method === "POST" && action === "pause") {
    authorize(config, request, "worlds:write");
    return sendJson(request, response, await pauseWorld(config, decodeURIComponent(ref)));
  }
  if (request.method === "POST" && action === "resume") {
    authorize(config, request, "worlds:write");
    return sendJson(request, response, await resumeWorld(config, decodeURIComponent(ref)));
  }
  if (request.method === "POST" && action === "open") {
    authorize(config, request, "worlds:write");
    const body = await readBody(request);
    return sendJson(request, response, await openWorld(config, decodeURIComponent(ref), body.target));
  }
  if (request.method === "POST" && action === "replicate") {
    authorize(config, request, "worlds:write");
    return sendJson(request, response, await replicateWorld(config, decodeURIComponent(ref), await readBody(request)), 201);
  }
  if (request.method === "POST" && action === "dev-access") {
    authorize(config, request, "devaccess:open");
    const body = await readBody(request);
    const world = await getWorld(config, decodeURIComponent(ref));
    const session = await devAccess.ensureSession(world, {
      vscode: body.vscode !== false,
      ssh: body.ssh === true
    });
    return sendJson(request, response, devAccess.publicSession(session, request));
  }
  if (request.method === "POST" && action === "exec") {
    authorize(config, request, "shell:open");
    const body = await readBody(request);
    const result = await execWorld(config, decodeURIComponent(ref), body.command || ["true"]);
    return sendJson(request, response, result);
  }
  return sendJson(request, response, { error: "not found" }, 404);
}

async function probeNetwork(config, options = {}) {
  const worlds = await listWorlds(config);
  const cube = await new CubeSandboxClient(config.cube).inspect();
  let plan = buildNetworkProbePlan(worlds, cube.sandboxes || [], options);
  if (options.live === false) return plan;

  for (const source of plan.nodes) {
    if (!source.canProbe) continue;
    const targets = plan.nodes
      .filter((target) => target.worldId !== source.worldId)
      .map((target) => ({
        worldId: target.worldId,
        ip: target.sandboxIp,
        ports: target.exposedPorts
      }));
    if (!targets.length) continue;
    try {
      const result = await execWorld(config, source.worldId, ["/bin/sh", "-lc", buildProbeScript(targets, options)], {
        allowFailure: true
      });
      const output = `${result.stdout || ""}\n${result.stderr || ""}`;
      const checks = parseProbeOutput(output);
      const error = result.code && !checks.length ? result.stderr || result.stdout || `probe exited with ${result.code}` : null;
      plan = applyProbeChecks(plan, source.worldId, checks, error);
    } catch (error) {
      plan = applyProbeChecks(plan, source.worldId, [], error.message || String(error));
    }
  }
  return plan;
}

async function browseHost(target) {
  const resolved = path.resolve(target);
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent: parent === resolved ? null : parent,
    entries: entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: path.join(resolved, entry.name),
        type: "directory"
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  };
}

async function staticFile(_request, response, url) {
  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const filePath = path.resolve(STATIC_ROOT, requested);
  if (!filePath.startsWith(STATIC_ROOT)) return sendJson(_request, response, { error: "not found" }, 404);
  const result = await readStaticOrSpaFallback(filePath);
  response.writeHead(200, securityHeaders(_request, contentType(result.filePath)));
  response.end(result.content);
}

async function readStaticOrSpaFallback(filePath) {
  try {
    return { filePath, content: await fs.readFile(filePath) };
  } catch (error) {
    if (error.code !== "ENOENT" || path.extname(filePath)) throw error;
  }
  const indexPath = path.join(STATIC_ROOT, "index.html");
  return { filePath: indexPath, content: await fs.readFile(indexPath) };
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) reject(new Error("request body too large"));
    });
    request.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(requestOrResponse, responseOrValue, valueOrStatus, statusOrHeaders = 200, extraHeaders = {}) {
  let request = null;
  let response;
  let value;
  let status;
  let headers;
  if (responseOrValue?.writeHead) {
    request = requestOrResponse;
    response = responseOrValue;
    value = valueOrStatus;
    status = typeof statusOrHeaders === "number" ? statusOrHeaders : 200;
    headers = typeof statusOrHeaders === "object" ? statusOrHeaders : extraHeaders;
  } else {
    response = requestOrResponse;
    value = responseOrValue;
    status = typeof valueOrStatus === "number" ? valueOrStatus : 200;
    headers = typeof valueOrStatus === "object" ? valueOrStatus : {};
  }
  response.writeHead(status, {
    ...securityHeaders(request, "application/json; charset=utf-8"),
    ...headers
  });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
  if (request?.audit && request.url?.startsWith("/api/") && !request.url.startsWith("/api/auth/config")) {
    void request.audit.write(auditRecord(request, status));
  }
  if (request?.config && request.url?.startsWith("/api/")) {
    void recordTraceEvent(request.config, traceEventFromRequest(request, status));
  }
}

function sendText(request, response, value, contentTypeValue = "text/plain; charset=utf-8", status = 200) {
  response.writeHead(status, securityHeaders(request, contentTypeValue));
  response.end(value);
  if (request?.audit && request.url?.startsWith("/api/") && !request.url.startsWith("/api/auth/config")) {
    void request.audit.write(auditRecord(request, status));
  }
  if (request?.config && request.url?.startsWith("/api/")) {
    void recordTraceEvent(request.config, traceEventFromRequest(request, status));
  }
}

function sendError(request, response, error) {
  const status = error.statusCode || 500;
  sendJson(request, response, { error: error.message || String(error) }, status);
}

function securityHeaders(request, contentTypeValue) {
  const headers = {
    "content-type": contentTypeValue,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin"
  };
  if (request && secureCookie(request.config || { studio: { secureCookies: false } }, request)) {
    headers["strict-transport-security"] = "max-age=15552000; includeSubDomains";
  }
  return headers;
}
