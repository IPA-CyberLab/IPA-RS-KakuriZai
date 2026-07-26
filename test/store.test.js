import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../dist/src/core/config.js";
import { WorldStore } from "../dist/src/core/store.js";

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
  const upper = path.join(world.paths.upper, world.backendConfig.mounts[0].id);
  await fs.mkdir(upper, { recursive: true });
  await fs.writeFile(path.join(upper, "keep.txt"), "new\n");
  await fs.mkdir(path.join(upper, "nested"));
  await fs.writeFile(path.join(upper, "nested", "file.txt"), "nested\n");
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

test("unionfs-fuse whiteouts delete host paths during apply", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-unionfs-whiteout-"));
  const source = path.join(tmp, "source");
  await fs.mkdir(path.join(source, "docs"), { recursive: true });
  await fs.mkdir(path.join(source, "src"), { recursive: true });
  await fs.writeFile(path.join(source, "src", "cli.ts"), "old\n");
  await fs.writeFile(path.join(source, "docs", "architecture.md"), "old\n");
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  const store = new WorldStore(config);
  const world = await store.create({
    name: "union-delete-test",
    sourcePath: source,
    backend: "cube-sandbox-overlay"
  });
  const upper = path.join(world.paths.upper, world.backendConfig.mounts[0].id);
  await fs.mkdir(path.join(upper, ".unionfs-fuse", "src"), { recursive: true });
  await fs.writeFile(path.join(upper, ".unionfs-fuse", "src", "cli.ts_HIDDEN~"), "");
  await fs.mkdir(path.join(upper, ".unionfs-fuse", "docs_HIDDEN~"), { recursive: true });
  await fs.writeFile(path.join(upper, ".unionfs-fuse", "ignored-control-file"), "ignored\n");

  const dryRun = await store.apply(world, { dryRun: true });
  assert.deepEqual(
    dryRun.changes.map((change) => `${change.action}:${change.path}:${change.source}`),
    [
      "delete:docs:unionfs-fuse-whiteout",
      "delete:src/cli.ts:unionfs-fuse-whiteout"
    ]
  );
  await store.apply(world);
  await assert.rejects(fs.readFile(path.join(source, "src", "cli.ts"), "utf8"), /ENOENT/);
  await assert.rejects(fs.stat(path.join(source, "docs")), /ENOENT/);
});

test("duplicate world names require exact id for destructive operations", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-duplicate-"));
  const source = path.join(tmp, "source");
  await fs.mkdir(source);
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  const store = new WorldStore(config);
  const first = await store.create({
    name: "same-name",
    sourcePath: source,
    backend: "cube-sandbox-overlay"
  });
  const second = await store.create({
    name: "same-name",
    sourcePath: source,
    backend: "cube-sandbox-overlay"
  });

  await assert.rejects(store.get("same-name"), /ambiguous world name/);
  await assert.rejects(store.remove("same-name"), /ambiguous world name/);

  const removed = await store.remove(second.id, { exactId: true });
  const remaining = await store.list();
  assert.equal(removed.id, second.id);
  assert.deepEqual(remaining.map((world) => world.id), [first.id]);
});

test("gVisor copy-on-write workspace reports and applies an exact tree diff", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-gvisor-cow-"));
  const source = path.join(tmp, "source");
  await fs.mkdir(path.join(source, "deleted-dir"), { recursive: true });
  await fs.writeFile(path.join(source, "same.txt"), "same\n");
  await fs.writeFile(path.join(source, "changed.txt"), "before\n");
  await fs.writeFile(path.join(source, "deleted-dir", "old.txt"), "old\n");
  await fs.symlink("same.txt", path.join(source, "link"));
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  const store = new WorldStore(config);
  const world = await store.create({
    name: "gvisor-cow",
    sourcePath: source,
    backend: "gvisor",
    backendConfig: { mountMode: "agctl-overlay" }
  });
  world.backendConfig.workspaceStrategy = "copy-on-write";
  await store.save(world);

  const upper = path.join(world.paths.upper, world.backendConfig.mounts[0].id);
  await fs.cp(source, upper, { recursive: true, verbatimSymlinks: true });
  await fs.writeFile(path.join(upper, "changed.txt"), "after\n");
  await fs.rm(path.join(upper, "deleted-dir"), { recursive: true });
  await fs.rm(path.join(upper, "link"));
  await fs.symlink("changed.txt", path.join(upper, "link"));
  await fs.writeFile(path.join(upper, "new.txt"), "new\n");

  const dryRun = await store.apply(world, { dryRun: true });
  assert.deepEqual(
    dryRun.changes.map((change) => `${change.action}:${change.path}`),
    [
      "upsert:changed.txt",
      "delete:deleted-dir",
      "upsert:link",
      "upsert:new.txt"
    ]
  );
  assert.equal(await fs.readFile(path.join(source, "changed.txt"), "utf8"), "before\n");

  const applied = await store.apply(world);
  assert.equal(applied.applied, true);
  assert.equal(await fs.readFile(path.join(source, "changed.txt"), "utf8"), "after\n");
  assert.equal(await fs.readFile(path.join(source, "new.txt"), "utf8"), "new\n");
  assert.equal(await fs.readlink(path.join(source, "link")), "changed.txt");
  await assert.rejects(fs.stat(path.join(source, "deleted-dir")), /ENOENT/);
});
