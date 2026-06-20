import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CubeSandboxClient } from "../dist/src/cube/client.js";

test("cube client prefers cubemastercli in auto mode", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-client-"));
  await fakeBinary(path.join(tmp, "cubemastercli"));
  await fakeBinary(path.join(tmp, "cubecli"));
  const originalPath = process.env.PATH;
  process.env.PATH = `${tmp}${path.delimiter}${originalPath || ""}`;
  try {
    const client = new CubeSandboxClient({ mode: "auto", mastercli: "cubemastercli", cubecli: "cubecli" });
    assert.equal(client.available().mode, "master");
  } finally {
    process.env.PATH = originalPath;
  }
});

test("cube client does not fall back to cubecli when master mode is explicit", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-client-"));
  await fakeBinary(path.join(tmp, "cubecli"));
  const originalPath = process.env.PATH;
  process.env.PATH = `${tmp}${path.delimiter}${originalPath || ""}`;
  try {
    const client = new CubeSandboxClient({
      mode: "master",
      mastercli: "missing-kakurizai-cubemastercli",
      cubecli: "cubecli"
    });
    assert.deepEqual(client.available(), { available: false, reason: "cubemastercli not found" });
  } finally {
    process.env.PATH = originalPath;
  }
});

test("cube client accepts absolute cubemastercli paths", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-client-"));
  const mastercli = path.join(tmp, "cubemastercli-root");
  await fakeBinary(mastercli);
  const client = new CubeSandboxClient({ mode: "master", mastercli });
  assert.equal(client.available().binary, mastercli);
});

test("cube client passes namespace to cubecli exec", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-client-"));
  const cubecli = path.join(tmp, "cubecli");
  const argsFile = path.join(tmp, "args.txt");
  await fs.writeFile(cubecli, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\n`, "utf8");
  await fs.chmod(cubecli, 0o755);
  const client = new CubeSandboxClient({
    cubecli,
    namespace: "kakurizai",
    workspacePath: "/workspace"
  });
  await client.exec(
    {
      name: "cube",
      sandbox: {
        id: "4fac1c9a074d49bf8e29ee1d90592b22"
      }
    },
    ["id"]
  );
  const args = (await fs.readFile(argsFile, "utf8")).trim().split("\n");
  assert.deepEqual(args, ["--namespace", "kakurizai", "exec", "-w", "/workspace", "4fac1c9a074d", "id"]);
});

test("cube client bootstraps terminal tools after sandbox create", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-client-"));
  const cubecli = path.join(tmp, "cubecli");
  const argsFile = path.join(tmp, "args.txt");
  await fs.writeFile(cubecli, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\n`, "utf8");
  await fs.chmod(cubecli, 0o755);
  const client = new CubeSandboxClient({
    cubecli,
    namespace: "kakurizai",
    bootstrapTools: {
      packages: ["fuse-overlayfs", "fuse3", "iproute2", "nano", "ncurses-bin", "ncurses-term", "tmux"],
      commands: ["ip", "nano", "tmux"]
    }
  });

  const result = await client.bootstrapSandboxTools(
    { name: "cube", paths: { logs: tmp } },
    "4fac1c9a074d49bf8e29ee1d90592b22"
  );

  assert.equal(result.applied, true);
  const args = (await fs.readFile(argsFile, "utf8")).trim().split("\n");
  assert.deepEqual(args.slice(0, 5), ["--namespace", "kakurizai", "exec", "4fac1c9a074d", "/bin/sh"]);
  assert.equal(args[5], "-lc");
  assert.match(args[6], /apt-get install -y --no-install-recommends/);
  assert.match(args[6], /iproute2/);
  assert.match(args[6], /fuse-overlayfs/);
  assert.match(args[6], /fuse3/);
  assert.match(args[6], /nano/);
  assert.match(args[6], /ncurses-bin/);
  assert.match(args[6], /ncurses-term/);
  assert.match(args[6], /tmux/);
});

test("cube client opens web shell with colorized bash profile", () => {
  const client = new CubeSandboxClient({
    cubecli: "/bin/echo",
    namespace: "kakurizai",
    workspacePath: "/workspace"
  });
  const shell = client.shellCommand({
    name: "cube",
    sandbox: { id: "4fac1c9a074d49bf8e29ee1d90592b22" }
  });

  assert.deepEqual(shell.args.slice(0, 8), [
    "--namespace",
    "kakurizai",
    "exec",
    "-i",
    "-t",
    "-w",
    "/workspace",
    "4fac1c9a074d"
  ]);
  assert.equal(shell.args[8], "/bin/sh");
  assert.equal(shell.args[9], "-lc");
  assert.match(shell.args[10], /TERM=xterm-256color/);
  assert.match(shell.args[10], /alias ls='ls --color=auto/);
  assert.match(shell.args[10], /PS1=/);
  assert.match(shell.args[10], /exec bash --rcfile/);
});

async function fakeBinary(file) {
  await fs.writeFile(file, "#!/bin/sh\nexit 0\n", "utf8");
  await fs.chmod(file, 0o755);
}
