import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../dist/src/core/config.js";
import { createKubernetesLab, listWorlds } from "../dist/src/core/worlds.js";

test("creates a multi-node Kubernetes lab with shared cluster metadata", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-k8s-lab-"));
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });

  const result = await createKubernetesLab(config, {
    name: "demo-lab",
    controlPlanes: 1,
    workers: 2,
    cpu: "1000m",
    memory: "1024Mi",
    writableLayerSize: "2G",
    profile: "k3s",
    cni: "flannel",
    podCidr: "10.50.0.0/16",
    serviceCidr: "10.51.0.0/16",
    apiServerPort: 6443,
    nodePorts: [30080],
    joinToken: "token-123",
    sysctls: {
      "net.ipv4.ip_forward": "1",
      "net.ipv4.conf.all.route_localnet": "1"
    },
    network: {
      allowInternetAccess: false,
      denyOut: ["10.0.0.0/8"]
    }
  });

  assert.equal(result.lab.name, "demo-lab");
  assert.equal(result.lab.controlPlanes, 1);
  assert.equal(result.lab.workers, 2);
  assert.equal(result.worlds.length, 3);

  const worlds = await listWorlds(config);
  assert.deepEqual(worlds.map((world) => world.name), ["demo-lab-cp-1", "demo-lab-worker-1", "demo-lab-worker-2"]);
  const controlPlane = worlds.find((world) => world.name === "demo-lab-cp-1");
  const worker = worlds.find((world) => world.name === "demo-lab-worker-1");

  assert.equal(controlPlane.backendConfig.kubernetes.clusterName, "demo-lab");
  assert.equal(controlPlane.backendConfig.kubernetes.nodeRole, "control-plane");
  assert.equal(controlPlane.backendConfig.kubernetes.joinEndpoint, "");
  assert.equal(controlPlane.backendConfig.network.allowInternetAccess, false);
  assert.deepEqual(controlPlane.backendConfig.network.exposedPorts, [6443, 30080]);
  assert.equal(worker.backendConfig.kubernetes.nodeRole, "worker");
  assert.equal(worker.backendConfig.kubernetes.joinEndpoint, "https://demo-lab-cp-1:6443");
  assert.equal(worker.backendConfig.kubernetes.joinToken, "token-123");
  assert.equal(worker.backendConfig.kubernetes.sysctls["net.ipv4.conf.all.route_localnet"], "1");
  assert.equal(worker.labels["kakurizai.lab"], "demo-lab");
  assert.equal(worker.labels["kakurizai.kubernetes.nodeRole"], "worker");
});

test("rejects invalid Kubernetes lab counts", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-k8s-lab-"));
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });

  await assert.rejects(
    () => createKubernetesLab(config, { name: "bad-lab", controlPlanes: 21 }),
    /controlPlanes/
  );
  await assert.rejects(
    () => createKubernetesLab(config, { name: "worker-only", controlPlanes: 0, workers: 1 }),
    /controlPlanes/
  );
});
