import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/core/config.js";
import { WorldStore } from "../src/core/store.js";
import { buildCubeSandboxRequest } from "../src/cube/request.js";

test("cube request mounts source readonly and upper writable", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-"));
  const source = path.join(tmp, "source");
  await fs.mkdir(source);
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  const store = new WorldStore(config);
  const world = await store.create({
    name: "cube",
    sourcePath: source,
    backend: "cube-sandbox-overlay"
  });
  const request = buildCubeSandboxRequest(world, { template: "base", workspacePath: "/workspace" });
  assert.equal(request.annotations["kakurizai.backend"], "cube-sandbox-overlay");
  assert.equal(request.annotations["cube.master.appsnapshot.template.id"], "base");
  const mounts = request.containers[0].volume_mounts;
  assert.equal(mounts.find((mount) => mount.name === "lower").readonly, true);
  assert.equal(mounts.find((mount) => mount.name === "upper").readonly, false);
  assert.match(request.containers[0].args[0], /mount -t overlay/);
});
