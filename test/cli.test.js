import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("cli covers studio world operations", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cli-"));
  const home = path.join(tmp, "home");
  const source = path.join(tmp, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "hello.txt"), "hello\n");

  const create = await runCli(home, [
    "create",
    "--source",
    source,
    "--name",
    "cli-world",
    "--backend",
    "cube-sandbox-overlay"
  ]);
  const world = JSON.parse(create.stdout);
  assert.equal(world.name, "cli-world");
  assert.equal(world.status, "pending-cube");

  const list = await runCli(home, ["list"]);
  assert.match(list.stdout, /cli-world\tpending-cube\tcube-sandbox-overlay/);

  const show = await runCli(home, ["show", "cli-world"]);
  assert.match(show.stdout, /Source\s+/);
  assert.match(show.stdout, /Backend\s+cube-sandbox-overlay/);
  assert.match(show.stdout, /Sessions\s+0/);

  const showJson = JSON.parse((await runCli(home, ["show", "cli-world", "--json"])).stdout);
  assert.equal(showJson.id, world.id);
  assert.ok(showJson.paths.upper.startsWith(home));

  await fs.writeFile(path.join(showJson.paths.upper, "new.txt"), "new\n");
  const changed = JSON.parse((await runCli(home, ["changed", "cli-world", "--json"])).stdout);
  assert.deepEqual(changed.map((change) => `${change.action}:${change.path}`), ["upsert:new.txt"]);

  const dryApply = JSON.parse((await runCli(home, ["apply", "cli-world", "--dry-run", "--json"])).stdout);
  assert.equal(dryApply.applied, false);
  await assert.rejects(fs.readFile(path.join(source, "new.txt"), "utf8"), /ENOENT/);

  const apply = JSON.parse((await runCli(home, ["apply", "cli-world", "--json"])).stdout);
  assert.equal(apply.applied, true);
  assert.equal(await fs.readFile(path.join(source, "new.txt"), "utf8"), "new\n");

  const remove = JSON.parse((await runCli(home, ["remove", "cli-world", "--yes", "--json"])).stdout);
  assert.equal(remove.name, "cli-world");
  const afterRemove = await runCli(home, ["list"]);
  assert.match(afterRemove.stdout, /no worlds/);
});

test("help exposes CLI equivalents for Studio buttons", async () => {
  const result = await runCli(await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-help-")), ["help"]);
  for (const command of [
    "agctl show <world>",
    "agctl file <world>",
    "agctl terminal <world>",
    "agctl vscode <world>",
    "agctl agent <world>",
    "agctl apply <world>",
    "agctl remove <world>"
  ]) {
    assert.match(result.stdout, new RegExp(escapeRegExp(command)));
  }
});

async function runCli(home, args) {
  return execFileAsync(process.execPath, ["./dist/bin/agctl.js", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, KAKURIZAI_CONFIG: "", KAKURIZAI_HOME: home, KAKURIZAI_CUBE_MODE: "disabled" },
    maxBuffer: 1024 * 1024
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
