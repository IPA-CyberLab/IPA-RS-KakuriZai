import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../dist/src/core/config.js";
import { bootstrapKubernetesLab, buildK3sBootstrapScript } from "../dist/src/core/kubernetes.js";
import { normalizeKubernetesConfig } from "../dist/src/core/network.js";
import { runCommand } from "../dist/src/core/process.js";
import { WorldStore } from "../dist/src/core/store.js";
import { startStudio } from "../dist/src/server.js";

async function fixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-k3s-"));
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  const store = new WorldStore(config);
  const worlds = [];
  for (const [index, role] of ["control-plane", "worker", "worker"].entries()) {
    const name = index === 0 ? "demo-cp-1" : `demo-worker-${index}`;
    worlds.push(await store.create({
      name,
      backend: "cube-sandbox-overlay",
      status: "ready",
      sandbox: { id: `runtime-${index}`, containerId: `runtime-${index}`, status: "running", sandboxIp: `192.0.2.${10 + index}` },
      backendConfig: {
        hostMount: false,
        kubernetes: normalizeKubernetesConfig({
          enabled: true,
          clusterName: "demo",
          nodeName: name,
          nodeRole: role,
          joinToken: "private-cluster-token",
          podCidr: "10.70.0.0/16",
          serviceCidr: "10.71.0.0/16"
        })
      }
    }));
  }
  return { config, store, worlds };
}

test("Kubernetes bootstrap starts the server before agents and waits for every expected Ready node", async () => {
  const { config, store, worlds } = await fixture();
  const commands = [];
  let nodeChecks = 0;
  const client = {
    async syncCubeSandboxHairpinTopology() {
      commands.push({ name: "topology", command: ["network"] });
      return { skipped: false, applied: true };
    },
    async exec(world, command) {
      commands.push({ name: world.name, command });
      if (command.includes("--raw=/readyz")) return { code: 0, stdout: "ok\n", stderr: "" };
      if (command.includes("nodes")) {
        nodeChecks += 1;
        return { code: 0, stdout: JSON.stringify({ items: worlds.map((node, index) => ({
          metadata: { name: node.name },
          status: { conditions: [{ type: "Ready", status: index === 2 && nodeChecks === 1 ? "False" : "True" }] }
        })) }), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
  };
  const result = await bootstrapKubernetesLab(config, worlds, { client, timeoutMs: 1000, pollIntervalMs: 1 });
  assert.equal(result.status, "ready");
  assert.equal(commands[0].name, "topology");
  assert.equal(result.endpoint, "https://192.0.2.10:6443");
  assert.equal(nodeChecks, 2);
  const launches = commands.filter(({ command }) => command[0] === "/bin/sh");
  assert.deepEqual(launches.map(({ name }) => name), ["demo-cp-1", "demo-worker-1", "demo-worker-2"]);
  assert.match(launches[0].command[2], /k3s server --config/);
  assert.match(launches[1].command[2], /k3s agent --config/);
  assert.match(launches[1].command[2], /"server":"https:\/\/192\.0\.2\.10:6443"/);
  assert.match(launches[0].command[2], /"cluster-cidr":"10\.70\.0\.0\/16"/);
  assert.match(launches[0].command[2], /"flannel-external-ip":true/);
  const stored = await Promise.all(worlds.map((world) => store.get(world.id)));
  assert.ok(stored.every((world) => world.sandbox.kubernetesBootstrap.status === "ready"));
  assert.ok(stored.every((world) => world.sandbox.kubernetesBootstrap.runtimeId === world.sandbox.id));
  const previousCommands = commands.length;
  assert.equal((await bootstrapKubernetesLab(config, stored, { client })).status, "ready");
  assert.equal(commands.length, previousCommands, "a converged cluster must not be restarted on each controller tick");
});

test("Kubernetes bootstrap leaves unprovisioned definitions pending and runs no guest commands", async () => {
  const { config, store, worlds } = await fixture();
  worlds[2].status = "pending-cube";
  worlds[2].sandbox = { status: "planned", id: null };
  await store.save(worlds[2]);
  const result = await bootstrapKubernetesLab(config, worlds, { client: { exec() { assert.fail("must wait for all nodes"); } } });
  assert.equal(result.status, "pending");
  assert.ok((await store.list()).every((world) => world.sandbox.kubernetesBootstrap.status === "pending"));
});

test("failed Kubernetes installation is never recorded as Ready and secrets are redacted", async () => {
  const { config, store, worlds } = await fixture();
  const result = await bootstrapKubernetesLab(config, worlds, {
    client: { async exec() { return { code: 1, stdout: "", stderr: "installation failed for private-cluster-token" }; } },
    timeoutMs: 1000
  });
  assert.equal(result.status, "failed");
  assert.doesNotMatch(result.reason, /private-cluster-token/);
  for (const world of await store.list()) {
    assert.equal(world.sandbox.kubernetesBootstrap.status, "failed");
    assert.doesNotMatch(world.sandbox.kubernetesBootstrap.reason, /private-cluster-token/);
    assert.ok(world.sandbox.kubernetesBootstrap.nextRetryAt > Date.now());
  }
});

test("a controller must wait for all declared lab nodes before initializing a partial cluster", async () => {
  const { config, store, worlds } = await fixture();
  worlds[0].backendConfig.kubernetes.expectedNodes = worlds.map((world) => world.name);
  await store.save(worlds[0]);
  const result = await bootstrapKubernetesLab(config, [worlds[0]], {
    client: { exec() { assert.fail("a partially created lab must not bootstrap"); } }
  });
  assert.equal(result.status, "pending");
  assert.equal((await store.get(worlds[0].id)).sandbox.kubernetesBootstrap.status, "pending");
});

test("Kubernetes bootstrap times out when an agent never becomes Ready", async () => {
  const { config, store, worlds } = await fixture();
  const result = await bootstrapKubernetesLab(config, worlds, {
    client: { async exec(_world, command) {
      return { code: 0, stderr: "", stdout: command.includes("--raw=/readyz") ? "ok" : command.includes("nodes") ? '{"items":[]}' : "" };
    } },
    timeoutMs: 300,
    pollIntervalMs: 1
  });
  assert.equal(result.status, "failed");
  assert.match(result.reason, /timed out.*Ready nodes/s);
  assert.ok((await store.list()).every((world) => world.sandbox.kubernetesBootstrap.status === "failed"));
});

test("managed k3s shell scripts quote configuration safely and pass sh syntax validation", async () => {
  for (const nodeRole of ["control-plane", "worker"]) {
    const script = buildK3sBootstrapScript({
      nodeRole,
      nodeName: "node-a",
      joinToken: "a'quoted-token",
      joinEndpoint: nodeRole === "worker" ? "https://192.0.2.10:6443" : "",
      sysctls: { "net.ipv4.ip_forward": "1" },
      extraArgs: ["--node-label=example=hello world"]
    }, "192.0.2.10");
    assert.equal((await runCommand("/bin/sh", ["-n"], { input: script })).code, 0);
    assert.match(script, /sha256sum -c -/);
    assert.match(script, /umask 077/);
    assert.match(script, /managed_pid/);
    assert.doesNotMatch(script, /get\.k3s\.io/);
  }
  assert.throws(() => buildK3sBootstrapScript({ nodeName: "a", joinToken: "x", version: "$(command)" }, "192.0.2.10"), /invalid k3s version/);
});

test("Studio does not expose managed Kubernetes join credentials in World JSON", async () => {
  const { config, store, worlds } = await fixture();
  worlds[0].backendConfig.cubeRequest = { annotations: { "kakurizai.kubernetes.joinToken": "private-cluster-token" } };
  await store.save(worlds[0]);
  config.auth = { provider: "none" };
  config.audit.enabled = false;
  config.provisioning.enabled = false;
  config.cluster.failover.enabled = false;
  config.studio.port = 0;
  const studio = await startStudio(config);
  try {
    const response = await fetch(`http://127.0.0.1:${studio.server.address().port}/api/worlds`);
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /private-cluster-token/);
    assert.equal((await store.get(worlds[0].id)).backendConfig.kubernetes.joinToken, "private-cluster-token");
  } finally {
    await new Promise((resolve) => studio.server.close(resolve));
  }
});
