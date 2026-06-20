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
import { applyWorld, changedPaths, createWorld, execWorld, getWorld, listWorlds, openWorld, removeWorld, updateWorldConfig } from "./core/worlds.js";
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
  }

  async ensure(world, request) {
    const existing = this.sessions.get(world.id);
    if (existing) return this.publicSession(existing, request);

    const vscodePassword = crypto.randomBytes(18).toString("base64url");
    const sshPassword = crypto.randomBytes(18).toString("base64url");
    const vscodePort = 13337;
    const sshPort = 2222;
    const client = new CubeSandboxClient(this.config.cube);
    const runtime = await client.inspectWorldSandbox(world);
    const sandboxIp = runtime.sandboxIp;
    if (!sandboxIp) throw new Error(`sandbox IP is not available for ${world.name}`);

    const services = await client.startDevAccessServices(world, {
      vscodePort,
      sshPort,
      vscodePassword,
      sshPassword
    });
    if (!services.applied) throw new Error(services.reason || `failed to start dev access for ${world.name}`);

    const vscodeForward = await listenTcpForward({
      listenHost: publicListenHost(this.config.studio.host),
      targetHost: sandboxIp,
      targetPort: vscodePort
    });
    const sshForward = await listenTcpForward({
      listenHost: publicListenHost(this.config.studio.host),
      targetHost: sandboxIp,
      targetPort: sshPort
    });
    const session = {
      worldId: world.id,
      worldName: world.name,
      sandboxIp,
      vscodePort,
      vscodePassword,
      vscodeForward,
      sshPort,
      sshPassword,
      sshForward,
      workspace: services.workspace
    };
    this.sessions.set(world.id, session);
    return this.publicSession(session, request);
  }

  publicSession(session, request) {
    const origin = publicOrigin(request, this.config);
    const publicHost = publicHostname(origin);
    const httpUrl = new URL(origin);
    httpUrl.port = String(session.vscodeForward.port);
    httpUrl.pathname = "/";
    httpUrl.search = "";
    httpUrl.hash = "";
    const sshCommand = `ssh root@${publicHost} -p ${session.sshForward.port}`;
    return {
      worldId: session.worldId,
      worldName: session.worldName,
      sandboxIp: session.sandboxIp,
      workspace: session.workspace,
      vscodeUrl: httpUrl.toString(),
      vscodePath: "/",
      vscodePort: session.vscodePort,
      vscodePassword: session.vscodePassword,
      vscodeForwardPort: session.vscodeForward.port,
      sshHost: publicHost,
      sshPort: session.sshForward.port,
      sshUri: `ssh://root@${publicHost}:${session.sshForward.port}`,
      sshCommand,
      sshPassword: session.sshPassword
    };
  }
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
  }
  if (request.method === "GET" && url.pathname === "/api/worlds") {
    return sendJson(response, await listWorlds(config));
  }
  if (request.method === "POST" && url.pathname === "/api/worlds") {
    const body = await readBody(request);
    const world = await createWorld(config, body);
    return sendJson(response, world, 201);
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
  if (request.method === "POST" && action === "open") {
    const body = await readBody(request);
    return sendJson(response, await openWorld(config, decodeURIComponent(ref), body.target));
  }
  if (request.method === "POST" && action === "dev-access") {
    return sendJson(response, await devAccess.ensure(await getWorld(config, decodeURIComponent(ref)), request));
  }
  if (request.method === "POST" && action === "exec") {
    const body = await readBody(request);
    const result = await execWorld(config, decodeURIComponent(ref), body.command || ["true"]);
    return sendJson(response, result);
  }
  return sendJson(response, { error: "not found" }, 404);
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
