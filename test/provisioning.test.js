import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { loadConfig } from "../dist/src/core/config.js";
import { createWorld, ensureWorldProvisioned, getWorld } from "../dist/src/core/worlds.js";
import { startStudio } from "../dist/src/server.js";

test("pending CubeSandbox world is provisioned once before concurrent connections", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-provision-"));
  const config = await provisioningConfig(tmp);
  const world = await createPendingWorld(config);
  const runtime = await createFakeCubeCli(tmp, "4fac1c9a074d49bf8e29ee1d90592b22");
  enableFakeCubeCli(config, runtime);

  const [first, second] = await Promise.all([
    ensureWorldProvisioned(config, world.id),
    ensureWorldProvisioned(config, world.id)
  ]);

  assert.equal(first.status, "ready");
  assert.equal(second.status, "ready");
  assert.equal(first.sandbox.id, runtime.sandboxId);
  assert.equal(second.sandbox.id, runtime.sandboxId);
  assert.equal(await readCreateCount(runtime.countFile), 1);
  const stored = await getWorld(config, world.id);
  assert.equal(stored.sandbox.containerId, runtime.sandboxId);
});

test("orphaned CubeSandbox runtime is reattached to its world without duplication", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-reattach-"));
  const config = await provisioningConfig(tmp);
  const world = await createPendingWorld(config);
  const runtime = await createFakeCubeCli(tmp, "79257b61653045d8ad7fce31c5396e81");
  await fs.writeFile(runtime.stateFile, `${runtime.sandboxId}\n`, "utf8");
  enableFakeCubeCli(config, runtime);

  const reconciled = await ensureWorldProvisioned(config, world.id);

  assert.equal(reconciled.status, "ready");
  assert.equal(reconciled.sandbox.id, runtime.sandboxId);
  assert.equal(reconciled.sandbox.containerId, runtime.sandboxId);
  assert.equal(await readCreateCount(runtime.countFile), 0);
});

test("failed world without a sandbox id retries provisioning once and becomes ready", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-retry-failed-"));
  const config = await provisioningConfig(tmp);
  const world = await createPendingWorld(config);
  await saveWorldState(world, {
    status: "failed",
    sandbox: {
      ...(world.sandbox || {}),
      id: null,
      containerId: null,
      status: "failed",
      reason: "cubecow snapshot cannot resize"
    }
  });
  const runtime = await createFakeCubeCli(tmp, "36284cd7dd4440869997f0a34d67aa22");
  enableFakeCubeCli(config, runtime);

  const provisioned = await ensureWorldProvisioned(config, world.id);

  assert.equal(provisioned.status, "ready");
  assert.equal(provisioned.sandbox.id, runtime.sandboxId);
  assert.equal(provisioned.sandbox.reason, null);
  assert.equal(await readCreateCount(runtime.countFile), 1);
});

test("failed runtime candidate is rejected without creating a duplicate", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-reject-failed-runtime-"));
  const config = await provisioningConfig(tmp);
  const world = await createPendingWorld(config);
  const sandboxId = "6ac2673aaf3548158c523b51f82f6a8c";
  await saveWorldState(world, {
    status: "failed",
    sandbox: {
      ...(world.sandbox || {}),
      id: sandboxId,
      containerId: sandboxId,
      status: "failed",
      reason: "runtime stopped during provisioning"
    }
  });
  const runtime = await createFakeCubeMaster(tmp, world.id, sandboxId, "failed");
  config.cube.mode = "master";
  config.cube.mastercli = runtime.binary;

  await assert.rejects(
    ensureWorldProvisioned(config, world.id),
    /CubeSandbox .* is failed/
  );
  assert.equal(await readCreateCount(runtime.countFile), 0);
});

test("web shell provisions and verifies a pending world before accepting the connection", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-shell-provision-"));
  const config = await provisioningConfig(tmp);
  const world = await createPendingWorld(config, "escape");
  const runtime = await createFakeCubeCli(tmp, "119d69d95cbb4ea7886306442bf214ad");
  enableFakeCubeCli(config, runtime);
  config.auth = { provider: "none" };
  config.audit = { enabled: false };
  config.cluster.failover.enabled = false;
  config.studio = {
    ...config.studio,
    host: "127.0.0.1",
    port: 0,
    tls: { certFile: null, keyFile: null }
  };

  const studio = await startStudio(config);
  try {
    const port = studio.server.address().port;
    const messages = await readWebSocket(`ws://127.0.0.1:${port}/api/worlds/${encodeURIComponent(world.id)}/shell`);
    const output = messages.join("");
    assert.match(output, /Connected to escape/);
    assert.match(output, /shell-ready/);
    assert.doesNotMatch(output, /not provisioned in CubeSandbox/);
    assert.equal(await readCreateCount(runtime.countFile), 1);
    const stored = await getWorld(config, world.id);
    assert.equal(stored.status, "ready");
    assert.equal(stored.sandbox.id, runtime.sandboxId);
  } finally {
    await new Promise((resolve) => studio.server.close(resolve));
  }
});

test("web shell rejects an unavailable pending world before the WebSocket upgrade", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-shell-unavailable-"));
  const config = await provisioningConfig(tmp);
  const world = await createPendingWorld(config, "escape");
  config.auth = { provider: "none" };
  config.audit = { enabled: false };
  config.cluster.failover.enabled = false;
  config.studio = {
    ...config.studio,
    host: "127.0.0.1",
    port: 0,
    tls: { certFile: null, keyFile: null }
  };

  const studio = await startStudio(config);
  try {
    const port = studio.server.address().port;
    const response = await readRejectedWebSocket(
      `ws://127.0.0.1:${port}/api/worlds/${encodeURIComponent(world.id)}/shell`
    );
    assert.equal(response.statusCode, 503);
    assert.match(response.body, /could not be provisioned in CubeSandbox/);
  } finally {
    await new Promise((resolve) => studio.server.close(resolve));
  }
});

async function provisioningConfig(tmp) {
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  config.defaultBackend = "cube-sandbox-overlay";
  config.cube = {
    ...config.cube,
    mode: "disabled",
    cubecli: path.join(tmp, "missing-cubecli"),
    mastercli: path.join(tmp, "missing-cubemastercli"),
    bootstrapTools: { enabled: false }
  };
  return config;
}

async function createPendingWorld(config, name = "escape") {
  const world = await createWorld(config, {
    name,
    backend: "cube-sandbox-overlay",
    hostMount: false
  });
  assert.equal(world.status, "pending-cube");
  assert.equal(world.sandbox.id, null);
  return world;
}

async function saveWorldState(world, changes) {
  const saved = {
    ...world,
    ...changes,
    sandbox: changes.sandbox === undefined ? world.sandbox : changes.sandbox
  };
  await fs.writeFile(world.paths.metadata, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
}

function enableFakeCubeCli(config, runtime) {
  config.cube.mode = "cli";
  config.cube.cubecli = runtime.binary;
}

async function createFakeCubeCli(tmp, sandboxId) {
  const binary = path.join(tmp, `cubecli-${sandboxId.slice(0, 8)}`);
  const stateFile = path.join(tmp, `runtime-${sandboxId.slice(0, 8)}.txt`);
  const countFile = path.join(tmp, `creates-${sandboxId.slice(0, 8)}.txt`);
  await fs.writeFile(binary, `#!/bin/sh
state_file=${shellQuote(stateFile)}
count_file=${shellQuote(countFile)}
sandbox_id=${shellQuote(sandboxId)}
case " $* " in
  *" cubebox list "*)
    if [ -f "$state_file" ]; then cat "$state_file"; fi
    ;;
  *" cubebox create "*)
    count=0
    if [ -f "$count_file" ]; then count=$(cat "$count_file"); fi
    count=$((count + 1))
    printf '%s\\n' "$count" > "$count_file"
    printf '%s\\n' "$sandbox_id" > "$state_file"
    printf 'create sandbox %s success\\n' "$sandbox_id"
    ;;
  *" cubebox inspect "*)
    printf '{"IP":null,"Labels":{}}\\n'
    ;;
  *" exec "*)
    printf 'shell-ready\\n'
    ;;
esac
`, "utf8");
  await fs.chmod(binary, 0o755);
  return { binary, stateFile, countFile, sandboxId };
}

async function createFakeCubeMaster(tmp, worldId, sandboxId, status) {
  const binary = path.join(tmp, `cubemastercli-${sandboxId.slice(0, 8)}`);
  const countFile = path.join(tmp, `master-creates-${sandboxId.slice(0, 8)}.txt`);
  await fs.writeFile(binary, `#!/bin/sh
count_file=${shellQuote(countFile)}
case "$1" in
  list)
    cat <<'TABLE'
sandbox_id	status	host_id	create_at	pause_at	template_id	namespace	host_ip	labels
${sandboxId}	${status}	host-a	2026-07-23T08:00:00Z	-	tpl-test	kakurizai	192.0.2.10	{"kakurizai.world":"${worldId}"}
TABLE
    ;;
  multirun)
    count=0
    if [ -f "$count_file" ]; then count=$(cat "$count_file"); fi
    printf '%s\\n' "$((count + 1))" > "$count_file"
    ;;
esac
`, "utf8");
  await fs.chmod(binary, 0o755);
  return { binary, countFile };
}

async function readCreateCount(file) {
  try {
    return Number((await fs.readFile(file, "utf8")).trim() || 0);
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

function readWebSocket(url) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("timed out waiting for web shell to close"));
    }, 5000);
    socket.on("message", (message) => messages.push(message.toString()));
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(messages);
    });
  });
}

function readRejectedWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("timed out waiting for rejected web shell upgrade"));
    }, 5000);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.terminate();
      reject(new Error("unprovisioned web shell unexpectedly accepted the WebSocket upgrade"));
    });
    socket.once("unexpected-response", (_request, response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        clearTimeout(timer);
        resolve({
          statusCode: response.statusCode,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
