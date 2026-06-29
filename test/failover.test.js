import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../dist/src/core/config.js";
import { reconcileFailover } from "../dist/src/core/cluster.js";
import { WorldStore } from "../dist/src/core/store.js";

test("failover promotes a memory replica into the source world", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-failover-"));
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  config.cube = { ...config.cube, mode: "disabled" };
  const store = new WorldStore(config);
  const source = await store.create({
    name: "primary",
    backend: "cube-sandbox-overlay",
    status: "ready",
    backendConfig: {
      hostMount: false,
      mountMode: "none",
      placement: { nodeId: "node-a", nodeName: "control" }
    },
    sandbox: {
      id: "source-sandbox",
      containerId: "source-sandbox",
      mode: "master",
      status: "running",
      hostId: "node-a"
    }
  });
  const replica = await store.create({
    name: "primary-worker",
    backend: "cube-sandbox-overlay",
    status: "ready",
    labels: {
      "kakurizai.replicaOf": source.id,
      "kakurizai.replication.node": "node-b"
    },
    backendConfig: {
      hostMount: false,
      mountMode: "none",
      placement: { nodeId: "node-b", nodeName: "worker" },
      replication: {
        role: "replica",
        state: {
          mode: "direct-cubelet",
          capturesMemory: true,
          snapshotId: "tpl-live",
          capturedAt: "2026-06-29T00:00:00.000Z"
        },
        executor: { type: "local", cubecli: "/bin/echo" }
      }
    },
    sandbox: {
      id: "replica-sandbox",
      containerId: "replica-sandbox",
      mode: "direct-cubelet",
      status: "running"
    }
  });

  const result = await reconcileFailover(config, { force: true, world: source.id });
  const promoted = await store.get(source.id, { exactId: true });
  const standby = await store.get(replica.id, { exactId: true });

  assert.equal(result.promoted.length, 1);
  assert.equal(promoted.sandbox.id, "replica-sandbox");
  assert.equal(promoted.sandbox.mode, "direct-cubelet");
  assert.equal(promoted.backendConfig.placement.nodeId, "node-b");
  assert.equal(promoted.backendConfig.replication.state.capturesMemory, true);
  assert.equal(promoted.labels["kakurizai.failover.promoted"], "true");
  assert.equal(promoted.labels["kakurizai.failover.activeReplica"], replica.id);
  assert.equal(standby.status, "standby-promoted");
  assert.equal(standby.labels["kakurizai.failover.promotedAs"], source.id);
});
