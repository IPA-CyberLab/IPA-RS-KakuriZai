// @ts-nocheck
import fs from "node:fs/promises";
import http from "node:http";
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
  const server = http.createServer((request, response) => {
    route(config, auth, request, response).catch((error) => sendError(response, error));
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
      env: process.env
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

async function route(config, auth, request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  if (request.method === "GET" && url.pathname === "/api/auth/config") {
    return sendJson(response, auth.publicConfig());
  }
  if (url.pathname.startsWith("/api/")) {
    request.query = url.searchParams;
    request.user = await auth.verifyRequest(request);
    return api(config, request, response, url);
  }
  return staticFile(request, response, url);
}

async function api(config, request, response, url) {
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
