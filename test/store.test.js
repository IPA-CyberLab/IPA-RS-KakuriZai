import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/core/config.js";
import { WorldStore } from "../src/core/store.js";

test("apply copies upper changes only when requested", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-store-"));
  const source = path.join(tmp, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "keep.txt"), "old\n");
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  const store = new WorldStore(config);
  const world = await store.create({
    name: "test",
    sourcePath: source,
    backend: "cube-sandbox-overlay"
  });
  await fs.writeFile(path.join(world.paths.upper, "keep.txt"), "new\n");
  await fs.mkdir(path.join(world.paths.upper, "nested"));
  await fs.writeFile(path.join(world.paths.upper, "nested", "file.txt"), "nested\n");
  assert.equal(await fs.readFile(path.join(source, "keep.txt"), "utf8"), "old\n");
  const dryRun = await store.apply(world, { dryRun: true });
  assert.equal(dryRun.applied, false);
  assert.equal(await fs.readFile(path.join(source, "keep.txt"), "utf8"), "old\n");
  const applied = await store.apply(world);
  assert.equal(applied.applied, true);
  assert.equal(await fs.readFile(path.join(source, "keep.txt"), "utf8"), "new\n");
  assert.equal(await fs.readFile(path.join(source, "nested", "file.txt"), "utf8"), "nested\n");
});

test("whiteouts delete only during apply", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-whiteout-"));
  const source = path.join(tmp, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "remove.txt"), "remove\n");
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  const store = new WorldStore(config);
  const world = await store.create({
    name: "delete-test",
    sourcePath: source,
    backend: "cube-sandbox-overlay"
  });
  await store.markWhiteout(world, "remove.txt");
  assert.equal(await fs.readFile(path.join(source, "remove.txt"), "utf8"), "remove\n");
  await store.apply(world);
  await assert.rejects(fs.readFile(path.join(source, "remove.txt"), "utf8"), /ENOENT/);
});
