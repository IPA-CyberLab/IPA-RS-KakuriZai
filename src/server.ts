// @ts-nocheck
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuthProvider } from "./auth/providers.js";
import { applyWorld, changedPaths, createWorld, execWorld, listWorlds, openWorld, removeWorld } from "./core/worlds.js";
import { CubeSandboxClient } from "./cube/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = path.join(__dirname, "studio");

export async function startStudio(config) {
  const auth = createAuthProvider(config.auth);
  const server = http.createServer((request, response) => {
    route(config, auth, request, response).catch((error) => sendError(response, error));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.studio.port, config.studio.host, resolve);
  });
  const token = auth.type === "self" ? auth.issueToken({ subject: "studio-local" }) : null;
  const url = `http://${config.studio.host}:${config.studio.port}/${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  return { server, url };
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
    return sendJson(response, await removeWorld(config, decodeURIComponent(ref)));
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
  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const filePath = path.resolve(STATIC_ROOT, requested);
  if (!filePath.startsWith(STATIC_ROOT)) return sendJson(response, { error: "not found" }, 404);
  const data = await fs.readFile(filePath);
  response.writeHead(200, { "content-type": contentType(filePath) });
  response.end(data);
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
