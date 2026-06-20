import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../dist/src/core/config.js";
import { WorldStore } from "../dist/src/core/store.js";
import { buildCubeSandboxRequest } from "../dist/src/cube/request.js";

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
  assert.equal(request.annotations["cube.master.appsnapshot.template.version"], "v2");
  assert.equal(request.instance_type, "cubebox");
  const volumes = new Map(request.volumes.map((volume) => [volume.name, volume]));
  assert.equal(volumes.size, 4);
  assert.equal(volumes.get("lower").volume_source.host_dir_volumes.volume_sources[0].host_path, world.sourcePath);
  assert.equal(volumes.get("upper").volume_source.host_dir_volumes.volume_sources[0].host_path, world.paths.upper);
  assert.equal(volumes.get("work").volume_source.host_dir_volumes.volume_sources[0].host_path, world.paths.workdir);
  assert.equal(volumes.get("whiteouts").volume_source.host_dir_volumes.volume_sources[0].host_path, world.paths.whiteouts);
  const mounts = request.containers[0].volume_mounts;
  assert.deepEqual(request.containers[0].resources, { cpu: "2000m", mem: "2000Mi" });
  assert.equal(mounts.find((mount) => mount.name === "lower").readonly, true);
  assert.equal(mounts.find((mount) => mount.name === "upper").readonly, false);
  assert.match(request.containers[0].args[0], /mount -t overlay/);
});

test("cube request supports CubeSandbox direct mount modes", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-"));
  const source = path.join(tmp, "source");
  await fs.mkdir(source);
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  const store = new WorldStore(config);
  const world = await store.create({
    name: "cube-direct",
    sourcePath: source,
    backend: "cube-sandbox-overlay",
    backendConfig: { mountMode: "cubesandbox-readonly" }
  });

  const readonlyRequest = buildCubeSandboxRequest(world, { template: "base", workspacePath: "/workspace" });
  assert.equal(readonlyRequest.volumes.length, 1);
  assert.equal(readonlyRequest.volumes[0].name, "workspace");
  assert.equal(readonlyRequest.containers[0].volume_mounts[0].container_path, "/workspace");
  assert.equal(readonlyRequest.containers[0].volume_mounts[0].readonly, true);
  assert.doesNotMatch(readonlyRequest.containers[0].args[0], /mount -t overlay/);

  world.backendConfig.mountMode = "unsafe-rw";
  const unsafeRequest = buildCubeSandboxRequest(world, { template: "base", workspacePath: "/workspace" });
  assert.equal(unsafeRequest.containers[0].volume_mounts[0].readonly, false);
  assert.equal(unsafeRequest.annotations["kakurizai.mountMode"], "unsafe-rw");
});
