// @ts-nocheck
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { Algorithm, hashSync as hashArgon2Sync } from "@node-rs/argon2";
import { createAuthProvider } from "./auth/providers.js";
import { AccountStore, normalizeSshPublicKeys, publicAccount } from "./core/accounts.js";
import { checkpointFailoverReplicas, createJoinToken, joinNode, listClusterNodes, reconcileFailover, removeClusterNode, replicateWorld, startFailoverController } from "./core/cluster.js";
import { collectMetrics, listTraces, prometheusText, recordTraceEvent, startTrace, stopTrace } from "./core/observability.js";
import { applyWorld, changedPaths, createHeteroNetworkLab, createKubernetesLab, createWorld, ensureWorldProvisioned, execWorld, getWorld, listWorlds, openWorld, pauseWorld, removeWorld, resumeWorld, updateWorldConfig } from "./core/worlds.js";
import { applyProbeChecks, buildNetworkProbePlan, buildProbeScript, parseProbeOutput } from "./core/probe.js";
import { TerraformManager } from "./core/terraform.js";
import { SandboxTemplateStore, starterSandboxTemplate } from "./core/templates.js";
import { CubeSandboxClient } from "./cube/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = path.join(__dirname, "studio");
const SESSION_COOKIE = "kakurizai_session";
const OIDC_STATE_COOKIE = "kakurizai_oidc_state";
const CSRF_HEADER = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_ROLES = {
  viewer: ["studio:read", "worlds:read", "terraform:read"],
  operator: ["studio:read", "worlds:read", "worlds:write", "shell:open", "devaccess:open", "terraform:read", "terraform:write"],
  admin: ["studio:read", "worlds:read", "worlds:write", "worlds:delete", "shell:open", "devaccess:open", "terraform:read", "terraform:write", "users:read", "users:write", "admin"]
};

export async function startStudio(config) {
  const auth = createAuthProvider(config.auth);
  const tls = await loadTlsOptions(config);
  enforceStudioSecurity(config, Boolean(tls));
  const sessions = new StudioSessionStore(config);
  await sessions.load();
  const accounts = new AccountStore(config);
  await accounts.load();
  const terraform = new TerraformManager(config);
  await terraform.load();
  const templates = new SandboxTemplateStore(config);
  await templates.init();
  await templates.ensureDefault({
    baseTemplate: config.cube?.template,
    cpu: config.cube?.cpu,
    memory: config.cube?.memory,
    writableLayerSize: config.cube?.writableLayerSize
  });
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
    route(config, auth, sessions, accounts, terraform, templates, devAccess, request, response).catch((error) => sendError(request, response, error));
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
    handleUpgrade(config, auth, sessions, accounts, devAccess, shellServer, request, socket, head).catch((error) => {
      const status = error.statusCode || 500;
      socket.write(`HTTP/1.1 ${status} ${httpStatusText(status)}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${error.message || String(error)}\n`);
      socket.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.studio.port, config.studio.host, resolve);
  });
  server.on("close", () => {
    failoverController.stop();
    void terraform.close();
  });
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

async function handleUpgrade(config, auth, sessions, accounts, devAccess, shellServer, request, socket, head) {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  const vscodeMatch = /^\/api\/worlds\/([^/]+)\/vscode(?:\/(.*))?$/.exec(url.pathname);
  if (vscodeMatch) {
    const session = await authenticateRequest(config, auth, sessions, accounts, request, { requireCsrf: false });
    request.user = session.user;
    request.authSession = session.session;
    authorize(config, request, "devaccess:open");
    return devAccess.proxyUpgrade(decodeURIComponent(vscodeMatch[1]), request, socket, head, `/${vscodeMatch[2] || ""}${url.search}`);
  }
  const match = /^\/api\/worlds\/([^/]+)\/shell$/.exec(url.pathname);
  if (!match) {
    socket.destroy();
    return;
  }
  const session = await authenticateRequest(config, auth, sessions, accounts, request, { requireCsrf: false });
  request.user = session.user;
  request.authSession = session.session;
  authorize(config, request, "shell:open");
  const world = await ensureWorldProvisioned(config, decodeURIComponent(match[1]));
  const shell = new CubeSandboxClient(config.cube).shellCommand(world);
  void request.audit?.write(auditRecord(request, 101, { action: "shell.open", target: world.id }));
  shellServer.handleUpgrade(request, socket, head, (ws) => {
    shellServer.emit("connection", ws, request, world);
    void attachShell(world, ws, shell);
  });
}

async function attachShell(world, ws, shell) {
  let shellProcess;
  try {
    const ptyModule = await import("node-pty");
    const pty = ptyModule.default || ptyModule;
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

function httpStatusText(status) {
  return ({
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout"
  })[status] || "Error";
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
    world = await ensureWorldProvisioned(this.config, world.id);
    const needsVscode = options.vscode !== false;
    const needsSsh = options.ssh === true;
    const sandboxId = world.sandbox?.containerId || world.sandbox?.id;
    let session = this.sessions.get(world.id);
    if (session && session.sandboxId !== sandboxId) {
      session.vscodeForward?.server.close();
      session.sshForward?.server.close();
      this.sessions.delete(world.id);
      session = null;
    }
    if (!session) {
      const client = new CubeSandboxClient(this.config.cube);
      const runtime = await client.inspectWorldSandbox(world);
      const sandboxIp = runtime.sandboxIp;
      if (!sandboxIp) throw new Error(`sandbox IP is not available for ${world.name}`);
      session = {
        worldId: world.id,
        worldName: world.name,
        sandboxId,
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
        listenHost: publicListenHost(this.config.studio.host, this.config.studio.forwardHost),
        targetHost: session.sandboxIp,
        targetPort: vscodePort
      });
    }

    const sshPublicKeys = [...new Set(options.sshPublicKeys || [])];
    const sshKeysChanged = JSON.stringify(session.sshPublicKeys || []) !== JSON.stringify(sshPublicKeys);
    if (needsSsh && sshPublicKeys.length === 0) {
      const error = new Error("Add an SSH public key in Account settings before starting SSH Forward");
      error.statusCode = 400;
      throw error;
    }
    if (needsSsh && (!session.sshForward || sshKeysChanged)) {
      const services = await client.startDevAccessServices(world, {
        vscodePort,
        sshPort,
        enableVscode: false,
        enableSsh: true,
        sshPublicKeys
      });
      if (!services.applied) throw new Error(services.reason || `failed to start SSH for ${world.name}`);
      session.workspace = session.workspace || services.workspace;
      session.sshPublicKeys = sshPublicKeys;
      if (!session.sshForward) {
        session.sshForward = await listenTcpForward({
          listenHost: publicListenHost(this.config.studio.host, this.config.studio.forwardHost),
          targetHost: session.sandboxIp,
          targetPort: sshPort
        });
      }
    }

    return session;
  }

  publicSession(session, request) {
    const origin = normalizeOrigin(this.config.studio.publicUrl) || publicOrigin(request, this.config);
    const publicHost = publicHostname(origin);
    const sshHost = this.config.studio.sshHost || publicHost;
    const httpUrl = session.vscodeForward
      ? new URL(`/api/worlds/${encodeURIComponent(session.worldId)}/vscode/`, origin)
      : null;
    const sshCommand = session.sshForward ? `ssh root@${sshHost} -p ${session.sshForward.port}` : null;
    return {
      worldId: session.worldId,
      worldName: session.worldName,
      sandboxIp: session.sandboxIp,
      workspace: session.workspace,
      vscodeUrl: httpUrl ? httpUrl.toString() : null,
      vscodePath: httpUrl ? "/" : null,
      vscodePort: session.vscodeForward ? session.vscodePort : null,
      vscodeForwardPort: session.vscodeForward?.port || null,
      sshHost,
      sshPort: session.sshForward?.port || null,
      sshUri: session.sshForward ? `ssh://root@${sshHost}:${session.sshForward.port}` : null,
      sshCommand
    };
  }

  async loginCodeServer(session, publicUrl) {
    if (!session.vscodeForward || !session.vscodePassword) {
      throw new Error("VS Code Web is not started");
    }
    const loginUrl = `http://${session.sandboxIp}:${session.vscodePort}/login`;
    const attempts = [
      { base: ".", href: publicUrl },
      { base: "/", href: loginUrl }
    ];
    let lastError = null;
    for (const attempt of attempts) {
      try {
        return await postCodeServerLogin({
          connectHost: session.sandboxIp,
          connectPort: session.vscodePort,
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

  proxyHttp(worldId, request, response, upstreamPath) {
    const session = this.requireVscodeSession(worldId);
    const headers = { ...request.headers };
    const upstream = http.request({
      host: session.sandboxIp,
      port: session.vscodePort,
      method: request.method,
      path: upstreamPath,
      headers
    }, (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers };
      const prefix = `/api/worlds/${encodeURIComponent(worldId)}/vscode`;
      if (typeof responseHeaders.location === "string" && responseHeaders.location.startsWith("/")) {
        responseHeaders.location = `${prefix}${responseHeaders.location}`;
      }
      response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", (error) => {
      if (!response.headersSent) sendJson(request, response, { error: error.message }, 502);
      else response.destroy(error);
    });
    request.pipe(upstream);
  }

  proxyUpgrade(worldId, request, socket, head, upstreamPath) {
    const session = this.requireVscodeSession(worldId);
    const upstream = net.createConnection({ host: session.sandboxIp, port: session.vscodePort }, () => {
      upstream.write(`${request.method} ${upstreamPath} HTTP/${request.httpVersion}\r\n`);
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        upstream.write(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}\r\n`);
      }
      upstream.write("\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  }

  requireVscodeSession(worldId) {
    const session = this.sessions.get(worldId);
    if (session?.vscodeForward) return session;
    const error = new Error("VS Code Web session is not running; open it again from the sandbox");
    error.statusCode = 409;
    throw error;
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
      host: options.connectHost,
      port: options.connectPort,
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
  return hashArgon2Sync(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 4096,
    timeCost: 3,
    parallelism: 1,
    outputLen: 32
  });
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

function publicListenHost(studioHost, forwardHost) {
  if (forwardHost) return forwardHost;
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
    this.oidcStates = new Map();
    this.ttlMs = Number(config.auth.sessionTtlSeconds || 7 * 24 * 60 * 60) * 1000;
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
        const createdAt = Date.parse(session?.createdAt || "");
        const configuredExpiry = Number.isFinite(createdAt) ? createdAt + this.ttlMs : 0;
        const expiresAt = Math.max(Number(session?.expiresAt || 0), configuredExpiry);
        if (session?.id && session?.csrfToken && session?.user && expiresAt > now) {
          this.sessions.set(session.id, {
            ...session,
            expiresAt,
            createdAt: session.createdAt || new Date(now).toISOString(),
            lastSeenAt: session.lastSeenAt || session.createdAt || new Date(now).toISOString(),
            ip: session.ip || null,
            userAgent: session.userAgent || null
          });
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  create(user, request) {
    const id = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.ttlMs;
    const now = new Date().toISOString();
    const session = {
      id,
      csrfToken,
      user,
      expiresAt,
      createdAt: now,
      lastSeenAt: now,
      ip: request ? requestIp(request, this.config) : null,
      userAgent: request?.headers?.["user-agent"] || null
    };
    this.sessions.set(id, session);
    void this.save();
    return session;
  }

  get(id, request) {
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      void this.save();
      return null;
    }
    if (request && Date.now() - Date.parse(session.lastSeenAt || 0) >= 60_000) {
      session.lastSeenAt = new Date().toISOString();
      session.ip = requestIp(request, this.config);
      session.userAgent = request.headers?.["user-agent"] || session.userAgent || null;
      void this.save();
    }
    return session;
  }

  destroy(id) {
    if (id) {
      this.sessions.delete(id);
      void this.save();
    }
  }

  listForSubject(subject, currentId) {
    const now = Date.now();
    return [...this.sessions.values()]
      .filter((session) => session.expiresAt > now && session.user?.subject === subject)
      .map((session) => ({
        id: sessionPublicId(session.id),
        current: session.id === currentId,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: new Date(session.expiresAt).toISOString(),
        ip: session.ip || null,
        userAgent: session.userAgent || null
      }))
      .sort((left, right) => String(right.lastSeenAt).localeCompare(String(left.lastSeenAt)));
  }

  destroyPublic(subject, publicId, currentId) {
    for (const session of this.sessions.values()) {
      if (session.user?.subject !== subject || sessionPublicId(session.id) !== publicId) continue;
      const current = session.id === currentId;
      this.sessions.delete(session.id);
      void this.save();
      return { destroyed: true, current };
    }
    const error = new Error("session not found");
    error.statusCode = 404;
    throw error;
  }

  destroyOtherSessions(subject, currentId) {
    let destroyed = 0;
    for (const session of this.sessions.values()) {
      if (session.user?.subject === subject && session.id !== currentId) {
        this.sessions.delete(session.id);
        destroyed += 1;
      }
    }
    if (destroyed) void this.save();
    return { destroyed };
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

  createOidcState(pending, request) {
    this.pruneOidcStates();
    const record = {
      ...pending,
      expiresAt: Date.now() + 10 * 60 * 1000,
      ip: requestIp(request, this.config),
      userAgent: request.headers["user-agent"] || ""
    };
    this.oidcStates.set(record.state, record);
    return record;
  }

  consumeOidcState(state, request) {
    if (!state) return null;
    const record = this.oidcStates.get(state);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      this.oidcStates.delete(state);
      return null;
    }
    if (record.ip !== requestIp(request, this.config)) return null;
    if (record.userAgent !== (request.headers["user-agent"] || "")) return null;
    this.oidcStates.delete(state);
    return record;
  }

  deleteOidcState(state) {
    if (state) this.oidcStates.delete(state);
  }

  pruneOidcStates() {
    const now = Date.now();
    for (const [state, record] of this.oidcStates.entries()) {
      if (record.expiresAt <= now) this.oidcStates.delete(state);
    }
  }
}

function sessionPublicId(id) {
  return crypto.createHash("sha256").update(String(id)).digest("base64url").slice(0, 24);
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
  if (provider === "keycloak" || provider === "oidc") {
    return config.auth?.mfa?.required === true;
  }
  return false;
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

async function route(config, auth, sessions, accounts, terraform, templates, devAccess, request, response) {
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
  if (request.method === "GET" && url.pathname === "/api/auth/login") {
    return beginOidcLogin(config, auth, sessions, request, response, url);
  }
  if (request.method === "GET" && url.pathname === "/api/auth/callback") {
    return finishOidcLogin(config, auth, sessions, accounts, request, response, url);
  }
  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const session = await authenticateRequest(config, auth, sessions, accounts, request, { requireCsrf: auth.type !== "none" });
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
    const session = await authenticateRequest(config, auth, sessions, accounts, request, { requireCsrf: requiresCsrf(url, request) });
    request.user = session.user;
    request.authSession = session.session;
    request.authMethod = session.method;
    request.query = url.searchParams;
    return api(config, devAccess, sessions, accounts, terraform, templates, request, response, url);
  }
  return staticFile(request, response, url);
}

async function beginOidcLogin(config, auth, sessions, request, response, url) {
  if (auth.type === "none") {
    const user = await auth.verifyRequest(request);
    return sendJson(request, response, { user, auth: user.provider, csrfToken: null });
  }
  if (typeof auth.authorizationUrl !== "function") {
    const error = new Error("configured auth provider does not support browser login");
    error.statusCode = 400;
    throw error;
  }
  const key = `${requestIp(request, config)}:oidc`;
  const state = crypto.randomBytes(32).toString("base64url");
  const nonce = crypto.randomBytes(32).toString("base64url");
  const returnTo = safeReturnTo(url.searchParams.get("returnTo") || "/");
  sessions.assertLoginAllowed(key);
  const redirectUri = oidcRedirectUri(config, request);
  const pending = sessions.createOidcState({ state, nonce, returnTo }, request);
  const location = await auth.authorizationUrl({ redirectUri, state, nonce });
  response.writeHead(302, {
    ...securityHeaders(request, "text/plain; charset=utf-8"),
    location,
    "set-cookie": oidcStateCookie(config, request, pending)
  });
  response.end("redirecting to identity provider\n");
}

async function finishOidcLogin(config, auth, sessions, accounts, request, response, url) {
  if (auth.type === "none") {
    response.writeHead(302, {
      ...securityHeaders(request, "text/plain; charset=utf-8"),
      location: "/"
    });
    response.end();
    return;
  }
  const callbackState = url.searchParams.get("state");
  let pending = readOidcStateCookie(request);
  if (!pending?.state || !pending?.nonce || pending.expiresAt <= Date.now()) {
    pending = sessions.consumeOidcState(callbackState, request);
  }
  if (!pending?.state || !pending?.nonce || pending.expiresAt <= Date.now()) {
    const error = new Error("missing or expired oidc state");
    error.statusCode = 401;
    throw error;
  }
  if (callbackState !== pending.state) {
    const error = new Error("oidc state mismatch");
    error.statusCode = 401;
    throw error;
  }
  sessions.deleteOidcState(pending.state);
  if (url.searchParams.get("error")) {
    const error = new Error(url.searchParams.get("error_description") || url.searchParams.get("error"));
    error.statusCode = 401;
    throw error;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    const error = new Error("missing oidc authorization code");
    error.statusCode = 401;
    throw error;
  }
  const result = await auth.exchangeCode({
    code,
    redirectUri: oidcRedirectUri(config, request),
    nonce: pending.nonce
  });
  verifyMfa(config, result.user);
  const account = await accounts.touch(result.user, { force: true });
  assertAccountActive(account);
  result.user.account = account;
  sessions.resetLoginAttempts(`${requestIp(request, config)}:oidc`);
  const session = sessions.create(result.user, request);
  request.user = result.user;
  request.authSession = session;
  const returnTo = safeReturnTo(pending.returnTo || "/");
  response.writeHead(302, {
    ...securityHeaders(request, "text/plain; charset=utf-8"),
    location: returnTo,
    "set-cookie": [
      sessionCookie(config, request, session),
      expiredOidcStateCookie()
    ]
  });
  response.end("signed in\n");
  const audit = auditRecord(request, 302, { action: "auth.login", provider: result.user.provider });
  audit.readOnly = false;
  void request.audit?.write(audit);
}

async function authenticateRequest(config, auth, sessions, accounts, request, options = {}) {
  const bearer = bearerHeader(request);
  if (bearer) {
    const user = await auth.verifyRequest({ headers: { authorization: bearer } });
    verifyBearerMfaPolicy(config, user);
    user.account = await accounts.touch(user);
    assertAccountActive(user.account);
    return { method: "bearer", user, session: null };
  }
  if (auth.type === "none") {
    const user = await auth.verifyRequest(request);
    user.account = await accounts.touch(user);
    return { method: "none", user, session: null };
  }
  const session = sessions.get(cookieValue(request, SESSION_COOKIE), request);
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
  session.user.account = await accounts.touch(session.user);
  assertAccountActive(session.user.account);
  return { method: "session", user: session.user, session };
}

function assertAccountActive(account) {
  if (account?.status !== "suspended") return;
  const error = new Error("account is suspended");
  error.statusCode = 403;
  throw error;
}

function requiresCsrf(url, request) {
  if (/^\/api\/worlds\/[^/]+\/vscode(?:\/|$)/.test(url.pathname)) return false;
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
  return expiredCookie(SESSION_COOKIE);
}

function expiredCookie(name) {
  return `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

function expiredOidcStateCookie() {
  return `${OIDC_STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/api/auth/callback; Max-Age=0`;
}

function oidcStateCookie(config, request, pending) {
  const secure = secureCookie(config, request) ? "; Secure" : "";
  const payload = Buffer.from(JSON.stringify({
    ...pending,
    expiresAt: Date.now() + 10 * 60 * 1000
  })).toString("base64url");
  return `${OIDC_STATE_COOKIE}=${encodeURIComponent(payload)}; HttpOnly; SameSite=Lax; Path=/api/auth/callback; Max-Age=600${secure}`;
}

function readOidcStateCookie(request) {
  const value = cookieValue(request, OIDC_STATE_COOKIE);
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function oidcRedirectUri(config, request) {
  return `${normalizeOrigin(config.studio?.publicUrl) || publicOrigin(request, config)}/api/auth/callback`;
}

function safeReturnTo(value) {
  const text = String(value || "/");
  if (!text.startsWith("/") || text.startsWith("//")) return "/";
  return text;
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
  return Boolean(config.auth?.mfa?.required);
}

function rbacPublicConfig(config) {
  return {
    enabled: config.auth?.rbac?.enabled !== false,
    roles: Object.keys({ ...DEFAULT_ROLES, ...(config.auth?.rbac?.roles || {}) })
  };
}

function verifyMfa(config, user) {
  if (config.auth?.mfa?.required && !claimHasMfa(user.claims || {})) {
    const error = new Error("identity provider mfa claim is required");
    error.statusCode = 401;
    throw error;
  }
}

function verifyBearerMfaPolicy(config, user) {
  if (config.auth?.mfa?.required && !claimHasMfa(user.claims || {})) {
    const error = new Error("identity provider mfa claim is required");
    error.statusCode = 401;
    throw error;
  }
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
  const roles = rolesForUser(config, user);
  const claims = user.claims || {};
  addValues(permissions, claims.permissions);
  addValues(permissions, claims.permission);
  addValues(permissions, claims.scope);
  addValues(permissions, claims.scp);
  const rbac = config.auth?.rbac || {};
  const binding = rbac.users?.[user.subject] || rbac.users?.["*"];
  if (binding && typeof binding === "object" && !Array.isArray(binding)) {
    addValues(permissions, binding.permissions || binding.permission || binding.scope);
  }
  const roleDefinitions = { ...DEFAULT_ROLES, ...(rbac.roles || {}) };
  for (const role of roles) {
    addValues(permissions, roleDefinitions[role]);
  }
  return permissions;
}

function rolesForUser(config, user) {
  const roles = new Set();
  if (!user) return roles;
  const rbac = config.auth?.rbac || {};
  const claims = user.claims || {};
  addValues(roles, claims.roles);
  addValues(roles, claims.role);
  addValues(roles, claims.groups);
  addValues(roles, user.account?.roles);
  const binding = rbac.users?.[user.subject] || rbac.users?.["*"];
  if (binding) {
    if (typeof binding === "string" || Array.isArray(binding)) addValues(roles, binding);
    else addValues(roles, binding.roles || binding.role);
  }
  if (roles.size === 0 && rbac.defaultRole) roles.add(rbac.defaultRole);
  return roles;
}

function publicUser(config, user) {
  const account = user?.account;
  if (!account) return { subject: user?.subject || null, provider: user?.provider || null };
  const knownRoles = new Set(Object.keys({ ...DEFAULT_ROLES, ...(config.auth?.rbac?.roles || {}) }));
  const roles = [...rolesForUser(config, user)].filter((role) => knownRoles.has(role));
  return publicAccount(account, { roles });
}

function publicStoredAccount(config, account) {
  const user = {
    subject: account.subject,
    provider: account.provider,
    claims: { roles: account.identityRoles || [] },
    account
  };
  return {
    ...publicUser(config, user),
    permissions: [...permissionsForUser(config, user)].sort()
  };
}

function devAccessSshPublicKeys(config, accounts) {
  const keys = new Set();
  for (const account of accounts) {
    if (account.status !== "active") continue;
    const user = {
      subject: account.subject,
      provider: account.provider,
      claims: { roles: account.identityRoles || [] },
      account
    };
    const permissions = permissionsForUser(config, user);
    if (!permissions.has("admin") && !permissions.has("devaccess:open")) continue;
    for (const key of account.sshPublicKeys || []) keys.add(key);
  }
  return [...keys];
}

export async function fetchGithubSshPublicKeys(username, fetchImpl = fetch) {
  const githubUsername = String(username || "").trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(githubUsername)) {
    const error = new Error("GitHub username is invalid");
    error.statusCode = 400;
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(`https://github.com/${encodeURIComponent(githubUsername)}.keys`, {
      headers: { "user-agent": "KakuriZai" },
      redirect: "error",
      signal: controller.signal
    });
    if (response.status === 404) {
      const error = new Error("GitHub user was not found");
      error.statusCode = 404;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`GitHub key import failed with HTTP ${response.status}`);
      error.statusCode = 502;
      throw error;
    }
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > 64 * 1024) {
      const error = new Error("GitHub returned too many SSH public keys");
      error.statusCode = 502;
      throw error;
    }
    const text = await response.text();
    if (text.length > 64 * 1024) {
      const error = new Error("GitHub returned too many SSH public keys");
      error.statusCode = 502;
      throw error;
    }
    const keys = normalizeSshPublicKeys(text);
    if (keys.length === 0) {
      const error = new Error("No SSH public keys were found for that GitHub user");
      error.statusCode = 404;
      throw error;
    }
    return keys;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("GitHub key import timed out");
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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
  if (url.pathname === "/api/auth/callback") return "auth.callback";
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

async function api(config, devAccess, sessions, accounts, terraform, templates, request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/session") {
    authorize(config, request, "studio:read");
    return sendJson(request, response, {
      user: publicUser(config, request.user),
      auth: request.user.provider,
      permissions: request.permissions || [...permissionsForUser(config, request.user)],
      csrfToken: request.authSession?.csrfToken || null,
      session: request.authSession ? {
        id: sessionPublicId(request.authSession.id),
        createdAt: request.authSession.createdAt,
        lastSeenAt: request.authSession.lastSeenAt,
        expiresAt: new Date(request.authSession.expiresAt).toISOString()
      } : null
    }, 200, request.authSession ? { "set-cookie": sessionCookie(config, request, request.authSession) } : {});
  }
  if (request.method === "GET" && url.pathname === "/api/account") {
    authorize(config, request, "studio:read");
    return sendJson(request, response, publicUser(config, request.user));
  }
  if (request.method === "PATCH" && url.pathname === "/api/account") {
    authorize(config, request, "studio:read");
    request.user.account = await accounts.updateProfile(request.user.subject, await readBody(request));
    return sendJson(request, response, publicUser(config, request.user));
  }
  if (request.method === "POST" && url.pathname === "/api/account/ssh-keys/import/github") {
    authorize(config, request, "studio:read");
    const body = await readBody(request);
    const importedKeys = await fetchGithubSshPublicKeys(body.username);
    request.user.account = await accounts.updateProfile(request.user.subject, {
      sshPublicKeys: [...(request.user.account.sshPublicKeys || []), ...importedKeys]
    });
    return sendJson(request, response, publicUser(config, request.user));
  }
  if (request.method === "GET" && url.pathname === "/api/account/sessions") {
    authorize(config, request, "studio:read");
    const currentId = cookieValue(request, SESSION_COOKIE);
    return sendJson(request, response, sessions.listForSubject(request.user.subject, currentId));
  }
  if (request.method === "DELETE" && url.pathname === "/api/account/sessions") {
    authorize(config, request, "studio:read");
    return sendJson(request, response, sessions.destroyOtherSessions(request.user.subject, cookieValue(request, SESSION_COOKIE)));
  }
  const accountSessionMatch = /^\/api\/account\/sessions\/([^/]+)$/.exec(url.pathname);
  if (request.method === "DELETE" && accountSessionMatch) {
    authorize(config, request, "studio:read");
    const result = sessions.destroyPublic(request.user.subject, decodeURIComponent(accountSessionMatch[1]), cookieValue(request, SESSION_COOKIE));
    return sendJson(request, response, result, 200, result.current ? { "set-cookie": expiredSessionCookie() } : {});
  }
  if (request.method === "GET" && url.pathname === "/api/users") {
    authorize(config, request, "users:read");
    return sendJson(request, response, accounts.list().map((account) => publicStoredAccount(config, account)));
  }
  const userMatch = /^\/api\/users\/([^/]+)$/.exec(url.pathname);
  if (request.method === "PATCH" && userMatch) {
    authorize(config, request, "users:write");
    const knownRoles = Object.keys({ ...DEFAULT_ROLES, ...(config.auth?.rbac?.roles || {}) });
    const account = await accounts.updateAdmin(decodeURIComponent(userMatch[1]), await readBody(request), {
      currentSubject: request.user.subject,
      knownRoles
    });
    return sendJson(request, response, publicStoredAccount(config, account));
  }
  if (request.method === "GET" && url.pathname === "/api/terraform/templates") {
    authorize(config, request, "terraform:read");
    return sendJson(request, response, await templates.list());
  }
  if (request.method === "GET" && url.pathname === "/api/terraform/templates/starter") {
    authorize(config, request, "terraform:read");
    const builder = {
      baseTemplate: config.cube?.template || "",
      cpu: config.cube?.cpu || "2000m",
      memory: config.cube?.memory || "2000Mi",
      writableLayerSize: config.cube?.writableLayerSize || "2G",
      networkType: "tap",
      allowInternetAccess: true,
      kubernetesEnabled: false,
      startupScript: ""
    };
    return sendJson(request, response, {
      builder,
      files: {
        "main.tf": starterSandboxTemplate(builder)
      }
    });
  }
  if (request.method === "POST" && url.pathname === "/api/terraform/templates/render") {
    authorize(config, request, "terraform:write");
    const input = await readBody(request);
    return sendJson(request, response, {
      files: {
        "main.tf": starterSandboxTemplate({
          baseTemplate: input.baseTemplate || config.cube?.template,
          cpu: input.cpu,
          memory: input.memory,
          writableLayerSize: input.writableLayerSize,
          networkType: input.networkType,
          allowInternetAccess: input.allowInternetAccess,
          kubernetesEnabled: input.kubernetesEnabled,
          startupScript: input.startupScript
        })
      }
    });
  }
  if ((request.method === "POST" || request.method === "PUT") && url.pathname === "/api/terraform/templates") {
    authorize(config, request, "admin");
    return sendJson(request, response, await templates.push(await readBody(request)), 201);
  }
  const terraformTemplateDeploymentMatch = /^\/api\/terraform\/templates\/([^/]+)\/deployments$/.exec(url.pathname);
  if (request.method === "POST" && terraformTemplateDeploymentMatch) {
    authorize(config, request, "terraform:write");
    const template = await templates.get(decodeURIComponent(terraformTemplateDeploymentMatch[1]));
    return sendJson(request, response, await terraform.startTemplateDeployment(templates, template, await readBody(request), {
      subject: request.user.subject
    }), 202);
  }
  const terraformTemplateMatch = /^\/api\/terraform\/templates\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && terraformTemplateMatch) {
    authorize(config, request, "terraform:read");
    return sendJson(request, response, await templates.getWithSource(decodeURIComponent(terraformTemplateMatch[1])));
  }
  if (request.method === "DELETE" && terraformTemplateMatch) {
    authorize(config, request, "admin");
    return sendJson(request, response, await templates.remove(decodeURIComponent(terraformTemplateMatch[1])));
  }
  if (request.method === "GET" && url.pathname === "/api/terraform") {
    authorize(config, request, "terraform:read");
    return sendJson(request, response, await terraform.overview(await listWorlds(config)));
  }
  const terraformProjectMatch = /^\/api\/terraform\/projects\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && terraformProjectMatch) {
    authorize(config, request, "terraform:read");
    return sendJson(request, response, terraform.preview(await getWorld(config, decodeURIComponent(terraformProjectMatch[1]))));
  }
  const terraformPrepareMatch = /^\/api\/terraform\/projects\/([^/]+)\/prepare$/.exec(url.pathname);
  if (request.method === "POST" && terraformPrepareMatch) {
    authorize(config, request, "terraform:write");
    return sendJson(request, response, await terraform.prepare(await getWorld(config, decodeURIComponent(terraformPrepareMatch[1]))));
  }
  const terraformRunCreateMatch = /^\/api\/terraform\/projects\/([^/]+)\/runs$/.exec(url.pathname);
  if (request.method === "POST" && terraformRunCreateMatch) {
    authorize(config, request, "terraform:write");
    const body = await readBody(request);
    if (body.action === "destroy") authorize(config, request, "worlds:delete");
    const world = await getWorld(config, decodeURIComponent(terraformRunCreateMatch[1]));
    return sendJson(request, response, await terraform.startRun(world, body.action, {
      confirmation: body.confirmation,
      subject: request.user.subject
    }), 202);
  }
  const terraformRunMatch = /^\/api\/terraform\/runs\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && terraformRunMatch) {
    authorize(config, request, "terraform:read");
    return sendJson(request, response, await terraform.getRun(decodeURIComponent(terraformRunMatch[1])));
  }
  const terraformCancelMatch = /^\/api\/terraform\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
  if (request.method === "POST" && terraformCancelMatch) {
    authorize(config, request, "terraform:write");
    return sendJson(request, response, await terraform.cancelRun(decodeURIComponent(terraformCancelMatch[1])));
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
  if (request.method === "POST" && url.pathname === "/api/labs/hetero-network") {
    authorize(config, request, "worlds:write");
    return sendJson(request, response, await createHeteroNetworkLab(config, await readBody(request)), 201);
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
  const vscodeProxyMatch = /^\/api\/worlds\/([^/]+)\/vscode(?:\/(.*))?$/.exec(url.pathname);
  if (vscodeProxyMatch) {
    authorize(config, request, "devaccess:open");
    return devAccess.proxyHttp(
      decodeURIComponent(vscodeProxyMatch[1]),
      request,
      response,
      `/${vscodeProxyMatch[2] || ""}${url.search}`
    );
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
      ssh: body.ssh === true,
      sshPublicKeys: devAccessSshPublicKeys(config, accounts.list())
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
    "content-security-policy": "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin"
  };
  if (request && secureCookie(request.config || { studio: { secureCookies: false } }, request)) {
    headers["strict-transport-security"] = "max-age=15552000; includeSubDomains";
  }
  return headers;
}
