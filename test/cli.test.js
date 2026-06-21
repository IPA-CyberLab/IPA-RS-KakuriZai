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
  assert.match(show.stdout, /Runtime\s+cube-sandbox-overlay/);
  assert.match(show.stdout, /Sessions\s+0/);

  const showJson = JSON.parse((await runCli(home, ["show", "cli-world", "--json"])).stdout);
  assert.equal(showJson.id, world.id);
  assert.ok(showJson.paths.upper.startsWith(home));

  const mountUpper = path.join(showJson.paths.upper, showJson.backendConfig.mounts[0].id);
  await fs.mkdir(mountUpper, { recursive: true });
  await fs.writeFile(path.join(mountUpper, "new.txt"), "new\n");
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
  assert.match(afterRemove.stdout, /no sandboxes/);
});

test("help exposes CLI equivalents for Studio buttons", async () => {
  const result = await runCli(await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-help-")), ["help"]);
  for (const command of [
    "agctl show <sandbox>",
    "agctl lab kubernetes --name <name>",
    "agctl file <sandbox>",
    "agctl terminal <sandbox>",
    "agctl vscode <sandbox>",
    "agctl agent <sandbox>",
    "agctl apply <sandbox>",
    "agctl pause <sandbox>",
    "agctl resume <sandbox>",
    "agctl remove <sandbox>"
  ]) {
    assert.match(result.stdout, new RegExp(escapeRegExp(command)));
  }
});

test("cli creates Kubernetes lab batches", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cli-k8s-lab-"));
  const home = path.join(tmp, "home");

  const created = JSON.parse((await runCli(home, [
    "lab",
    "kubernetes",
    "--name",
    "cli-lab",
    "--control-planes",
    "1",
    "--workers",
    "1",
    "--node-ports",
    "30080,30081",
    "--deny-out-cidr",
    "10.0.0.0/8",
    "--sysctl",
    "net.ipv4.conf.all.route_localnet=1",
    "--json"
  ])).stdout);

  assert.equal(created.lab.name, "cli-lab");
  assert.deepEqual(created.worlds.map((world) => world.name), ["cli-lab-cp-1", "cli-lab-worker-1"]);
  const worker = created.worlds.find((world) => world.name === "cli-lab-worker-1");
  assert.equal(worker.backendConfig.kubernetes.nodeRole, "worker");
  assert.equal(worker.backendConfig.kubernetes.joinEndpoint, "https://cli-lab-cp-1:6443");
  assert.deepEqual(worker.backendConfig.kubernetes.nodePorts, [30080, 30081]);
  assert.equal(worker.backendConfig.kubernetes.sysctls["net.ipv4.conf.all.route_localnet"], "1");
  assert.deepEqual(worker.backendConfig.network.denyOut, ["10.0.0.0/8"]);
});

test("cli applies sandbox yaml and exports terraform bundle", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cli-yaml-"));
  const home = path.join(tmp, "home");
  const manifest = path.join(tmp, "sandbox.yaml");
  await fs.writeFile(manifest, `
apiVersion: kakurizai.dev/v1
kind: Sandbox
metadata:
  name: yaml-lab
spec:
  hostMount: false
  resources:
    cpu: 3000m
    memory: 3072Mi
    writableLayerSize: 3G
  network:
    type: tap
    exposedPorts: [6443, 30000]
    dns:
      servers: [8.8.8.8]
    allowInternetAccess: false
  kubernetes:
    enabled: true
    profile: k3s
`, "utf8");

  const apply = JSON.parse((await runCli(home, ["apply", "-f", manifest, "--json"])).stdout);
  assert.equal(apply.action, "created");
  assert.equal(apply.world.name, "yaml-lab");
  assert.equal(apply.world.backendConfig.network.exposedPorts[0], 6443);
  assert.equal(apply.world.backendConfig.kubernetes.enabled, true);

  const exported = await runCli(home, ["export", "yaml-lab", "--yaml"]);
  assert.match(exported.stdout, /name: yaml-lab/);
  assert.match(exported.stdout, /kubernetes:/);

  const tfDir = path.join(tmp, "tf");
  const terraform = await runCli(home, ["terraform", "export", "yaml-lab", "--out", tfDir]);
  assert.match(terraform.stdout, /main\.tf/);
  assert.match(await fs.readFile(path.join(tfDir, "main.tf"), "utf8"), /terraform_data/);
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
