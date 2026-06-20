import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { CubeSandboxClient } from "../dist/src/cube/client.js";

const execFileAsync = promisify(execFile);

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

test("cube client pauses and resumes through CubeMaster update API", async () => {
  const master = await createMasterApi();
  try {
    const client = new CubeSandboxClient({
      apiBaseUrl: master.url,
      fifoDir: path.join(os.tmpdir(), "missing-kakurizai-fifo")
    });

    const paused = await client.pauseSandboxById("4fac1c9a074d49bf8e29ee1d90592b22");
    assert.equal(paused.applied, true);
    const resumed = await client.resumeSandboxById("4fac1c9a074d49bf8e29ee1d90592b22");
    assert.equal(resumed.applied, true);

    assert.deepEqual(master.requests.map((request) => request.body.action), ["pause", "resume"]);
    assert.equal(master.requests[0].body.sandbox_id, "4fac1c9a074d49bf8e29ee1d90592b22");
    assert.equal(master.requests[0].body.instance_type, "cubebox");
  } finally {
    await master.close();
  }
});

test("cube client clears stale exec fifos before pause", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-pause-cleanup-"));
  const fifoDir = path.join(tmp, "fifo", "session");
  const cubecli = path.join(tmp, "cubecli");
  const sudo = path.join(tmp, "sudo");
  const sudoArgsFile = path.join(tmp, "sudo-args.txt");
  await fs.mkdir(fifoDir, { recursive: true });
  await execFileAsync("mkfifo", [path.join(fifoDir, "exec-stale123-stdin")]);
  await fs.writeFile(cubecli, "#!/bin/sh\nexit 0\n", "utf8");
  await fs.writeFile(sudo, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${sudoArgsFile}"\nexit 0\n`, "utf8");
  await fs.chmod(cubecli, 0o755);
  await fs.chmod(sudo, 0o755);
  const master = await createMasterApi();
  const originalPath = process.env.PATH;
  process.env.PATH = `${tmp}${path.delimiter}${originalPath || ""}`;
  try {
    const client = new CubeSandboxClient({
      apiBaseUrl: master.url,
      cubecli,
      namespace: "kakurizai",
      fifoDir: path.join(tmp, "fifo")
    });
    const result = await client.pauseSandboxById("4fac1c9a074d49bf8e29ee1d90592b22");
    assert.equal(result.applied, true);
    assert.deepEqual(result.cleanup.execIds, ["exec-stale123"]);
    const sudoArgs = await fs.readFile(sudoArgsFile, "utf8");
    assert.match(sudoArgs, new RegExp(`-n\\n${escapeRegExp(cubecli)}\\n--namespace\\nkakurizai\\ncontainerd-ctr\\ntasks\\nkill\\n--exec-id\\nexec-stale123`));
    assert.match(sudoArgs, new RegExp(`-n\\n${escapeRegExp(cubecli)}\\n--namespace\\nkakurizai\\ncontainerd-ctr\\ntasks\\ndelete\\n--exec-id\\nexec-stale123`));
  } finally {
    process.env.PATH = originalPath;
    await master.close();
  }
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
      packages: ["fuse-overlayfs", "fuse3", "iproute2", "nano", "ncurses-bin", "ncurses-term", "tmux", "unionfs-fuse"],
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
  assert.match(args[6], /unionfs-fuse/);
});

test("cube client mounts agctl overlay with a probed unionfs driver", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-overlay-"));
  const cubecli = path.join(tmp, "cubecli");
  const argsFile = path.join(tmp, "args.txt");
  await fs.writeFile(cubecli, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\n`, "utf8");
  await fs.chmod(cubecli, 0o755);
  const client = new CubeSandboxClient({
    cubecli,
    namespace: "kakurizai",
    workspacePath: "/workspace"
  });

  const result = await client.setupOverlay(
    {
      name: "cube",
      sourcePath: tmp,
      paths: { logs: tmp, workdir: tmp },
      backendConfig: {
        hostMount: true,
        mounts: [{ name: "repo", sourcePath: tmp, mode: "agctl-overlay" }]
      }
    },
    "4fac1c9a074d49bf8e29ee1d90592b22"
  );

  assert.equal(result.mounted, true);
  const args = (await fs.readFile(argsFile, "utf8")).trim().split("\n");
  const script = args.at(-1);
  assert.deepEqual(args.slice(0, 5), ["--namespace", "kakurizai", "exec", "4fac1c9a074d", "/bin/sh"]);
  assert.match(script, /probe_mount/);
  assert.match(script, /\/workspace\/repo/);
  assert.match(script, /unionfs-fuse -o cow/);
  assert.match(script, /fuse-overlayfs/);
  assert.match(script, /no usable overlay driver/);
  assert.doesNotMatch(script, /tar cf|cp -a|rsync/);
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

test("cube client starts sandbox dev access services", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-dev-access-"));
  const cubecli = path.join(tmp, "cubecli");
  const argsFile = path.join(tmp, "args.txt");
  const stdinFile = path.join(tmp, "stdin.txt");
  await fs.writeFile(cubecli, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\ncat > "${stdinFile}"\n`, "utf8");
  await fs.chmod(cubecli, 0o755);
  const client = new CubeSandboxClient({
    cubecli,
    namespace: "kakurizai",
    workspacePath: "/workspace"
  });

  const result = await client.startDevAccessServices(
    {
      name: "cube",
      sourcePath: tmp,
      sandbox: { id: "4fac1c9a074d49bf8e29ee1d90592b22" },
      paths: { logs: tmp },
      backendConfig: {
        hostMount: true,
        mounts: [{ name: "repo", sourcePath: tmp, mode: "agctl-overlay" }]
      }
    },
    {
      vscodePort: 13337,
      sshPort: 2222,
      vscodePassword: "code-secret",
      vscodeHashedPassword: "$argon2id$v=19$m=4096,t=3,p=1$salt$hash"
    }
  );

  assert.equal(result.applied, true);
  assert.equal(result.workspace, "/workspace/repo");
  assert.equal(result.vscode, true);
  assert.equal(result.ssh, false);
  const argsText = await fs.readFile(argsFile, "utf8");
  const stdinText = await fs.readFile(stdinFile, "utf8");
  assert.match(argsText, /^--namespace\nkakurizai\nexec\n4fac1c9a074d\n\/bin\/sh\n-lc\n/);
  assert.doesNotMatch(argsText, /code-secret|secret/);
  assert.equal(stdinText, "");
  assert.match(argsText, /enable_vscode=1/);
  assert.match(argsText, /enable_ssh=0/);
  assert.match(argsText, /vscode_hashed_password='?\$argon2id/);
  assert.match(argsText, /git/);
  assert.doesNotMatch(argsText, /openssh-server/);
  assert.match(argsText, /code-server/);
  assert.match(argsText, /--install-extension "\$extension_id" --force/);
  assert.match(argsText, /GitHub\.vscode-pull-request-github/);
  assert.match(argsText, /--auth password/);
  assert.match(argsText, /HASHED_PASSWORD="\$vscode_hashed_password"/);
  assert.doesNotMatch(argsText, /PASSWORD="\$vscode_password"/);
  assert.match(argsText, /Port \$\{ssh_port\}/);

  const sshResult = await client.startDevAccessServices(
    {
      name: "cube",
      sourcePath: tmp,
      sandbox: { id: "4fac1c9a074d49bf8e29ee1d90592b22" },
      paths: { logs: tmp },
      backendConfig: {
        hostMount: true,
        mounts: [{ name: "repo", sourcePath: tmp, mode: "agctl-overlay" }]
      }
    },
    {
      vscodePort: 13337,
      sshPort: 2222,
      enableVscode: false,
      enableSsh: true
    }
  );
  const sshArgsText = await fs.readFile(argsFile, "utf8");
  const sshStdinText = await fs.readFile(stdinFile, "utf8");
  assert.equal(sshResult.applied, true);
  assert.equal(sshResult.vscode, false);
  assert.equal(sshResult.ssh, true);
  assert.equal(sshStdinText, "");
  assert.match(sshArgsText, /enable_vscode=0/);
  assert.match(sshArgsText, /enable_ssh=1/);
  assert.match(sshArgsText, /openssh-server/);
  assert.match(sshArgsText, /Port \$\{ssh_port\}/);
});

async function createMasterApi() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ret: { ret_code: 200, ret_msg: "" } }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function fakeBinary(file) {
  await fs.writeFile(file, "#!/bin/sh\nexit 0\n", "utf8");
  await fs.chmod(file, 0o755);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
