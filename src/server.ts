// @ts-nocheck
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import { WebSocket, WebSocketServer } from "ws";
import { createAuthProvider } from "./auth/providers.js";
import { applyWorld, changedPaths, createKubernetesLab, createWorld, execWorld, getWorld, listWorlds, openWorld, pauseWorld, removeWorld, resumeWorld, updateWorldConfig } from "./core/worlds.js";
import { applyProbeChecks, buildNetworkProbePlan, buildProbeScript, parseProbeOutput } from "./core/probe.js";
import { CubeSandboxClient } from "./cube/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = path.join(__dirname, "studio");

export async function startStudio(config) {
  const auth = createAuthProvider(config.auth);
  const devAccess = new DevAccessManager(config);
  const server = http.createServer((request, response) => {
    route(config, auth, devAccess, request, response).catch((error) => sendError(response, error));
  });
  const shellServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    handleUpgrade(config, auth, shellServer, request, socket, head).catch((error) => {
      socket.write(`HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\n${error.message || String(error)}\n`);
      socket.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.studio.port, config.studio.host, resolve);
  });
  const token = auth.type === "self" ? auth.issueToken({ subject: "studio-local" }) : null;
  const url = `http://${config.studio.host}:${config.studio.port}/${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  return { server, url };
}

async function handleUpgrade(config, auth, shellServer, request, socket, head) {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  const match = /^\/api\/worlds\/([^/]+)\/shell$/.exec(url.pathname);
  if (!match) {
    socket.destroy();
    return;
  }
  const token = url.searchParams.get("token");
  if (token && !request.headers.authorization) request.headers.authorization = `Bearer ${token}`;
  request.user = await auth.verifyRequest(request);
  const world = await getWorld(config, decodeURIComponent(match[1]));
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
  const proto = request.headers["x-forwarded-proto"] || "http";
  const host = request.headers["x-forwarded-host"] || request.headers.host || `${config.studio.host}:${config.studio.port}`;
  return `${Array.isArray(proto) ? proto[0] : proto}://${Array.isArray(host) ? host[0] : host}`;
}

function publicHostname(origin) {
  const hostname = new URL(origin).hostname;
  if (hostname === "0.0.0.0") return "127.0.0.1";
  return hostname;
}

async function route(config, auth, devAccess, request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  if (request.method === "GET" && url.pathname === "/api/auth/config") {
    return sendJson(response, auth.publicConfig());
  }
  if (url.pathname.startsWith("/api/")) {
    const token = url.searchParams.get("token");
    if (token && !request.headers.authorization) request.headers.authorization = `Bearer ${token}`;
    request.query = url.searchParams;
    request.user = await auth.verifyRequest(request);
    return api(config, devAccess, request, response, url);
  }
  return staticFile(request, response, url);
}

async function api(config, devAccess, request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/session") {
    return sendJson(response, { user: request.user, auth: request.user.provider });
  }
  if (request.method === "GET" && url.pathname === "/api/host/browse") {
    return sendJson(response, await browseHost(url.searchParams.get("path") || process.env.HOME || "/"));
  }
  if (request.method === "GET" && url.pathname === "/api/cube/inspect") {
    return sendJson(response, await new CubeSandboxClient(config.cube).inspect());
  }
  if (request.method === "POST" && url.pathname === "/api/network/probe") {
    return sendJson(response, await probeNetwork(config, await readBody(request)));
  }
  if (request.method === "POST" && url.pathname === "/api/labs/kubernetes") {
    return sendJson(response, await createKubernetesLab(config, await readBody(request)), 201);
  }
  const cubeSandboxMatch = /^\/api\/cube\/sandboxes\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (cubeSandboxMatch) {
    const [, sandboxId, action] = cubeSandboxMatch;
    const client = new CubeSandboxClient(config.cube);
    if (request.method === "GET" && action === "logs") {
      return sendJson(response, await client.logs(decodeURIComponent(sandboxId), {
        tail: Number(url.searchParams.get("tail") || 120)
      }));
    }
    if (request.method === "POST" && action === "destroy") {
      return sendJson(response, await client.destroySandboxById(decodeURIComponent(sandboxId)));
    }
    if (request.method === "POST" && action === "pause") {
      return sendJson(response, await client.pauseSandboxById(decodeURIComponent(sandboxId)));
    }
    if (request.method === "POST" && action === "resume") {
      return sendJson(response, await client.resumeSandboxById(decodeURIComponent(sandboxId)));
    }
  }
  if (request.method === "GET" && url.pathname === "/api/worlds") {
    return sendJson(response, await listWorlds(config));
  }
  if (request.method === "POST" && url.pathname === "/api/worlds") {
    const body = await readBody(request);
    const world = await createWorld(config, body);
    return sendJson(response, world, 201);
  }
  const devAccessOpenMatch = /^\/api\/worlds\/([^/]+)\/dev-access\/open$/.exec(url.pathname);
  if (request.method === "GET" && devAccessOpenMatch) {
    const world = await getWorld(config, decodeURIComponent(devAccessOpenMatch[1]));
    const session = await devAccess.ensureSession(world, { vscode: true, ssh: false });
    const publicSession = devAccess.publicSession(session, request);
    const cookies = await devAccess.loginCodeServer(session, publicSession.vscodeUrl);
    response.writeHead(302, {
      location: publicSession.vscodeUrl,
      ...(cookies.length ? { "set-cookie": cookies } : {})
    });
    response.end();
    return;
  }
  const match = /^\/api\/worlds\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) return sendJson(response, { error: "not found" }, 404);
  const [, ref, action] = match;
  if (request.method === "DELETE" && !action) {
    return sendJson(response, await removeWorld(config, decodeURIComponent(ref), { exactId: true }));
  }
  if (request.method === "PATCH" && action === "config") {
    return sendJson(response, await updateWorldConfig(config, decodeURIComponent(ref), await readBody(request)));
  }
  if (request.method === "GET" && action === "changed") {
    return sendJson(response, await changedPaths(config, decodeURIComponent(ref)));
  }
  if (request.method === "POST" && action === "apply") {
    return sendJson(response, await applyWorld(config, decodeURIComponent(ref), await readBody(request)));
  }
  if (request.method === "POST" && action === "pause") {
    return sendJson(response, await pauseWorld(config, decodeURIComponent(ref)));
  }
  if (request.method === "POST" && action === "resume") {
    return sendJson(response, await resumeWorld(config, decodeURIComponent(ref)));
  }
  if (request.method === "POST" && action === "open") {
    const body = await readBody(request);
    return sendJson(response, await openWorld(config, decodeURIComponent(ref), body.target));
  }
  if (request.method === "POST" && action === "dev-access") {
    const body = await readBody(request);
    const world = await getWorld(config, decodeURIComponent(ref));
    const session = await devAccess.ensureSession(world, {
      vscode: body.vscode !== false,
      ssh: body.ssh === true
    });
    return sendJson(response, devAccess.publicSession(session, request));
  }
  if (request.method === "POST" && action === "exec") {
    const body = await readBody(request);
    const result = await execWorld(config, decodeURIComponent(ref), body.command || ["true"]);
    return sendJson(response, result);
  }
  return sendJson(response, { error: "not found" }, 404);
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
  if (!filePath.startsWith(STATIC_ROOT)) return sendJson(response, { error: "not found" }, 404);
  const result = await readStaticOrSpaFallback(filePath);
  response.writeHead(200, { "content-type": contentType(result.filePath) });
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

function sendJson(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function sendError(response, error) {
  const status = error.statusCode || 500;
  sendJson(response, { error: error.message || String(error) }, status);
}
