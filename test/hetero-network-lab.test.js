import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../dist/src/core/config.js";
import { createHeteroNetworkLab, listWorlds } from "../dist/src/core/worlds.js";

test("creates a HeteroNetwork lab with public, NAT, and double-NAT profiles", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-hetero-lab-"));
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });

  const result = await createHeteroNetworkLab(config, {
    name: "ipars-net",
    publicNodes: 1,
    natNodes: 1,
    doubleNatNodes: 1,
    cpu: "1000m",
    memory: "1024Mi",
    writableLayerSize: "2G",
    addressBase: "192.168.70",
    addressStart: 40,
    portOffset: 100
  });

  assert.equal(result.lab.name, "ipars-net");
  assert.equal(result.lab.profile, "hetero-network");
  assert.deepEqual(result.lab.expectedPathStates, ["DIRECT_PUBLIC", "DIRECT_NAT_TRAVERSAL", "RELAY"]);
  assert.equal(result.worlds.length, 3);

  const worlds = await listWorlds(config);
  assert.deepEqual(worlds.map((world) => world.name), ["ipars-net-double-nat-1", "ipars-net-nat-1", "ipars-net-public-1"]);

  const publicNode = worlds.find((world) => world.name === "ipars-net-public-1");
  const natNode = worlds.find((world) => world.name === "ipars-net-nat-1");
  const doubleNatNode = worlds.find((world) => world.name === "ipars-net-double-nat-1");

  assert.equal(publicNode.backendConfig.network.sandboxIp, "192.168.70.40");
  assert.equal(publicNode.backendConfig.network.inbound.defaultPolicy, "allow");
  assert.equal(publicNode.backendConfig.network.topology.role, "public");
  assert.equal(publicNode.backendConfig.network.topology.publicEndpoint, true);
  assert.deepEqual(publicNode.backendConfig.network.exposedPorts, [3478, 8443, 9443, 9580, 9780, 51820].sort((a, b) => a - b));
  assert.equal(publicNode.backendConfig.network.nat.portForwards.find((forward) => forward.name === "control-plane").hostPort, 8543);
  assert.equal(publicNode.labels["kakurizai.experiment"], "hetero-network");

  assert.equal(natNode.backendConfig.network.sandboxIp, "192.168.70.41");
  assert.equal(natNode.backendConfig.network.inbound.defaultPolicy, "deny");
  assert.equal(natNode.backendConfig.network.topology.role, "nat");
  assert.equal(natNode.backendConfig.network.topology.natDepth, 1);
  assert.equal(natNode.backendConfig.network.topology.path, "negotiated");

  assert.equal(doubleNatNode.backendConfig.network.sandboxIp, "192.168.70.42");
  assert.equal(doubleNatNode.backendConfig.network.inbound.defaultPolicy, "deny");
  assert.equal(doubleNatNode.backendConfig.network.topology.role, "double-nat");
  assert.equal(doubleNatNode.backendConfig.network.topology.natDepth, 2);
  assert.equal(doubleNatNode.backendConfig.network.topology.path, "relay");
});

test("rejects invalid HeteroNetwork lab counts", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-hetero-lab-"));
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });

  await assert.rejects(
    () => createHeteroNetworkLab(config, { name: "bad-lab", publicNodes: 0 }),
    /publicNodes/
  );
  await assert.rejects(
    () => createHeteroNetworkLab(config, { name: "too-big", natNodes: 21 }),
    /natNodes/
  );
});
