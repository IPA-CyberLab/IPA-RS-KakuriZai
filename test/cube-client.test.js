import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { loadConfig } from "../dist/src/core/config.js";
import { createWorld } from "../dist/src/core/worlds.js";
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

test("cube client finds a CubeMaster sandbox by its KakuriZai world label", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-lookup-"));
  const mastercli = path.join(tmp, "cubemastercli");
  const argsFile = path.join(tmp, "args.txt");
  await fs.writeFile(mastercli, `#!/bin/sh
printf '%s\\n' "$@" > "${argsFile}"
cat <<'TABLE'
NODE_SCOPE    all
NODES_SCANNED    1/1
SANDBOX_COUNT    1

sandbox_id	status	host_id	create_at	pause_at	template_id	namespace	host_ip	labels
4fac1c9a074d49bf8e29ee1d90592b22	running	host-a	2026-07-23 08:00:00	-	tpl-test	kakurizai	192.0.2.10	{"kakurizai.world":"escape-a137c152cf22"}
TABLE
`, "utf8");
  await fs.chmod(mastercli, 0o755);

  const client = new CubeSandboxClient({ mode: "master", mastercli });
  const result = await client.findWorldSandboxes({ id: "escape-a137c152cf22" });

  assert.equal(result.checked, true);
  assert.equal(result.mode, "master");
  assert.deepEqual(result.sandboxes.map((sandbox) => sandbox.id), ["4fac1c9a074d49bf8e29ee1d90592b22"]);
  assert.equal(result.sandboxes[0].labels["kakurizai.world"], "escape-a137c152cf22");
  const args = (await fs.readFile(argsFile, "utf8")).trim().split("\n");
  assert.deepEqual(args, ["list", "--all", "--wide", "--filter", "kakurizai.world=escape-a137c152cf22"]);
});

test("cube client builds a resource-compatible template before sandbox creation", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-template-resources-"));
  const mastercli = path.join(tmp, "cubemastercli");
  const argsFile = path.join(tmp, "args.txt");
  await fs.writeFile(mastercli, `#!/bin/sh
printf '%s\\n' "$*" >> "${argsFile}"
case "$1 $2" in
  "template list")
    printf '%s\\n' '{"ret":{"ret_code":200,"ret_msg":"success"},"data":[{"template_id":"tpl-source","status":"READY","version":"v2","image_info":"registry.example/sandbox@sha256:abc"}]}'
    ;;
  "tpl info")
    case "$*" in
      *"tpl-compatible"*)
        printf '%s\\n' '{"ret":{"ret_code":200},"template_id":"tpl-compatible","status":"READY","version":"v2","instance_type":"cubebox","create_request":{"network_type":"tap","annotations":{"cube.master.rootfs.writable_layer_size":"20G"},"containers":[{"resources":{"cpu":"2000m","mem":"4000Mi"}}]}}'
        ;;
      *)
        printf '%s\\n' '{"ret":{"ret_code":200},"template_id":"tpl-source","status":"READY","version":"v2","instance_type":"cubebox","create_request":{"network_type":"tap","annotations":{"cube.master.rootfs.writable_layer_size":"1G"},"containers":[{"resources":{"cpu":"2000m","mem":"2000Mi"}}]}}'
        ;;
    esac
    ;;
  "template create-from-image")
    printf '%s\\n' '{"ret":{"ret_code":200,"ret_msg":"success"},"job":{"job_id":"job-compatible","template_id":"tpl-compatible","status":"PENDING"}}'
    ;;
  "template status")
    printf '%s\\n' '{"ret":{"ret_code":200,"ret_msg":"success"},"job":{"job_id":"job-compatible","template_id":"tpl-compatible","status":"READY","progress":100}}'
    ;;
  *)
    printf 'unexpected args: %s\\n' "$*" >&2
    exit 9
    ;;
esac
`, "utf8");
  await fs.chmod(mastercli, 0o755);

  const client = new CubeSandboxClient({
    mode: "master",
    mastercli,
    templateBuildPollIntervalMs: 1,
    templateBuildTimeoutMs: 1000
  });
  const result = await client.resolveTemplateForResources({
    template: "tpl-source",
    writableLayerSize: "20G",
    cpu: "2000m",
    memory: "4000Mi",
    instanceType: "cubebox",
    networkType: "tap"
  });

  assert.equal(result.templateId, "tpl-compatible");
  assert.equal(result.sourceTemplateId, "tpl-source");
  assert.equal(result.changed, true);
  assert.equal(result.created, true);
  const args = await fs.readFile(argsFile, "utf8");
  assert.match(args, /template create-from-image --image registry\.example\/sandbox@sha256:abc/);
  assert.match(args, /--writable-layer-size 20G/);
  assert.match(args, /--cpu 2000 --memory 4000/);
});

test("CubeSandbox create failure is saved as failed, not pending", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-create-failed-"));
  const mastercli = path.join(tmp, "cubemastercli");
  await fs.writeFile(mastercli, `#!/bin/sh
case "$1 $2" in
  "template list")
    printf '%s\\n' '{"ret":{"ret_code":200,"ret_msg":"success"},"data":[{"template_id":"tpl-test","status":"READY","version":"v2","image_info":"registry.example/sandbox@sha256:test"}]}'
    ;;
  "tpl info")
    printf '%s\\n' '{"ret":{"ret_code":200},"template_id":"tpl-test","status":"READY","version":"v2","instance_type":"cubebox","create_request":{"network_type":"tap","annotations":{"cube.master.rootfs.writable_layer_size":"10G"},"containers":[{"resources":{"cpu":"2000m","mem":"2000Mi"}}]}}'
    ;;
  "multirun --norm")
    cat <<'LOG'
2026/06/25 04:41:18 doCreateSandbox RequestId:test,sandBoxId:,Ip:,HostID:,HostIP:,code:130545, message:derive v2 default-medium from template fail: cubecow error code=invalid_argument raw_rc=-4 action=bug: invalid argument: 'rootfs-gen0' is a snapshot; cannot resize,cost:39
2026/06/25 04:41:23 totalRunSuccCnt:0
2026/06/25 04:41:23 totalRunErr:2
LOG
    exit 1
    ;;
esac
`, "utf8");
  await fs.chmod(mastercli, 0o755);

  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  config.defaultBackend = "cube-sandbox-overlay";
  config.cube = {
    ...config.cube,
    mode: "master",
    mastercli,
    template: "tpl-test"
  };

  const world = await createWorld(config, {
    name: "resize-fails",
    backend: "cube-sandbox-overlay",
    hostMount: false,
    cpu: "2000m",
    memory: "2000Mi",
    writableLayerSize: "10G"
  });

  assert.equal(world.status, "failed");
  assert.equal(world.sandbox.status, "failed");
  assert.match(world.sandbox.reason, /cannot resize/);
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
  assert.match(args[6], /n 22/);
  assert.match(args[6], /@openai\/codex/);
  assert.match(args[6], /@anthropic-ai\/claude-code/);
  assert.match(args[6], /code-server\.dev\/install\.sh/);
  assert.match(args[6], /GitHub\.vscode-pull-request-github/);
  assert.match(args[6], /install_agents >"\$bootstrap_logs\/agents\.log" 2>&1 & agents_pid=\$!/);
  assert.match(args[6], /install_vscode >"\$bootstrap_logs\/vscode\.log" 2>&1 & vscode_pid=\$!/);
  assert.match(args[6], /wait "\$agents_pid"/);
  assert.match(args[6], /wait "\$vscode_pid"/);
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

test("cube client runs exec and interactive shell through configured passwordless sudo", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-sudo-"));
  const cubecli = path.join(tmp, "cubecli");
  const sudo = path.join(tmp, "sudo");
  const argsFile = path.join(tmp, "sudo-args.txt");
  await fs.writeFile(cubecli, "#!/bin/sh\nprintf 'cubelet socket: permission denied\\n' >&2\nexit 77\n", "utf8");
  await fs.writeFile(sudo, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nexit 0\n`, "utf8");
  await fs.chmod(cubecli, 0o755);
  await fs.chmod(sudo, 0o755);
  const client = new CubeSandboxClient({
    cubecli,
    namespace: "kakurizai",
    workspacePath: "/workspace",
    sudo: "required",
    sudoCommand: sudo
  });
  const world = {
    name: "cube",
    sandbox: { id: "4fac1c9a074d49bf8e29ee1d90592b22" }
  };

  const result = await client.exec(world, ["printf", "hello world"]);
  assert.equal(result.code, 0);
  assert.equal(result.sudo, true);
  const execArgs = (await fs.readFile(argsFile, "utf8")).trim().split("\n");
  assert.deepEqual(execArgs.slice(0, 9), [
    "-n",
    cubecli,
    "--namespace",
    "kakurizai",
    "exec",
    "-w",
    "/workspace",
    "4fac1c9a074d",
    "printf"
  ]);

  const shell = client.shellCommand(world);
  assert.equal(shell.command, sudo);
  assert.equal(shell.sudo, true);
  assert.deepEqual(shell.args.slice(0, 9), [
    "-n",
    cubecli,
    "--namespace",
    "kakurizai",
    "exec",
    "-i",
    "-t",
    "-w",
    "/workspace"
  ]);
});

test("cube client opens direct replica shells through ssh lxc executor", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-direct-"));
  const ssh = path.join(tmp, "ssh");
  await fs.writeFile(ssh, "#!/bin/sh\nexit 0\n", "utf8");
  await fs.chmod(ssh, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${tmp}${path.delimiter}${originalPath || ""}`;
  try {
    const client = new CubeSandboxClient({
      namespace: "kakurizai",
      workspacePath: "/workspace"
    });
    const shell = client.shellCommand({
      name: "worker-replica",
      sandbox: {
        id: "4fac1c9a074d49bf8e29ee1d90592b22",
        mode: "direct-cubelet"
      },
      backendConfig: {
        replication: {
          executor: {
            type: "ssh-lxc",
            host: "100.123.154.79",
            user: "mizuame",
            key: "/root/.ssh/kz-host-key",
            container: "kz-cs-worker",
            cubecli: "/usr/local/services/cubetoolbox/Cubelet/bin/cubecli"
          }
        }
      }
    });

    assert.equal(shell.command, ssh);
    assert.deepEqual(shell.args.slice(0, 5), [
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-i",
      "/root/.ssh/kz-host-key",
      "mizuame@100.123.154.79"
    ]);
    assert.match(shell.args[5], /^lxc exec 'kz-cs-worker' -- bash -lc /);
    assert.match(shell.args[5], /--namespace/);
    assert.match(shell.args[5], /kakurizai/);
    assert.match(shell.args[5], /exec/);
    assert.match(shell.args[5], /\/workspace/);
    assert.match(shell.args[5], /4fac1c9a074d/);
  } finally {
    process.env.PATH = originalPath;
  }
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
  assert.match(argsText, /code-server\.dev\/install\.sh/);
  assert.doesNotMatch(argsText, /npm install -g code-server/);
  assert.match(argsText, /--install-extension "\$extension_id" --force/);
  assert.match(argsText, /GitHub\.vscode-pull-request-github/);
  assert.match(argsText, /--auth password/);
  assert.match(argsText, /--disable-workspace-trust/);
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
      enableSsh: true,
      sshPublicKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMMbPV2O0rGvBDkuoqe89uWQ2f6B+2o5ABPclGVCHG1X test@example.com"]
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
  assert.match(sshArgsText, /AAAAC3NzaC1lZDI1NTE5AAAAIMMbPV2O0rGvBDkuoqe89uWQ2f6B/);
  assert.match(sshArgsText, /authorized_keys/);
  assert.match(sshArgsText, /chmod 600 \/root\/\.ssh\/authorized_keys/);
  assert.match(sshArgsText, /PermitRootLogin prohibit-password/);
  assert.match(sshArgsText, /PasswordAuthentication no/);
  assert.match(sshArgsText, /KbdInteractiveAuthentication no/);
  assert.doesNotMatch(sshArgsText, /ssh_password|chpasswd/);
});

test("cube client builds host inbound firewall rules", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-ingress-firewall-"));
  const iptables = path.join(tmp, "iptables");
  const sudo = path.join(tmp, "sudo");
  const scriptFile = path.join(tmp, "host-script.sh");
  await fakeBinary(iptables);
  await fs.writeFile(sudo, `#!/bin/sh\nprintf '%s' "$4" > "${scriptFile}"\nexit 0\n`, "utf8");
  await fs.chmod(sudo, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${tmp}${path.delimiter}${originalPath || ""}`;
  try {
    const client = new CubeSandboxClient({ iptables });
    const result = await client.syncHostIngressRules(
      { id: "world-ingress" },
      ["192.168.0.60"],
      {
        inbound: {
          defaultPolicy: "deny",
          allowFrom: ["192.168.0.10/32"],
          denyFrom: ["10.0.0.0/8"]
        }
      }
    );
    const script = await fs.readFile(scriptFile, "utf8");

    assert.equal(result.applied, true);
    assert.equal(result.ruleCount, 4);
    assert.match(script, /KAKURIZAI-INGRESS/);
    assert.match(script, /-m conntrack --ctstate ESTABLISHED,RELATED/);
    assert.match(script, new RegExp(`${escapeRegExp(iptables)}' -A KAKURIZAI-INGRESS -d '192\\.168\\.0\\.60/32' -s '192\\.168\\.0\\.10/32'.*-j ACCEPT`));
    assert.match(script, new RegExp(`${escapeRegExp(iptables)}' -A KAKURIZAI-INGRESS -d '192\\.168\\.0\\.60/32' -s '10\\.0\\.0\\.0/8'.*-j DROP`));
    assert.match(script, new RegExp(`${escapeRegExp(iptables)}' -A KAKURIZAI-INGRESS -d '192\\.168\\.0\\.60/32'.*-j DROP`));
  } finally {
    process.env.PATH = originalPath;
  }
});

test("cube client builds CubeSandbox hairpin topology rules", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-hairpin-"));
  const ip = path.join(tmp, "ip");
  const tc = path.join(tmp, "tc");
  const bpftool = path.join(tmp, "bpftool");
  const sudo = path.join(tmp, "sudo");
  const scriptFile = path.join(tmp, "host-script.sh");
  await fakeBinary(ip);
  await fakeBinary(tc);
  await fakeBinary(bpftool);
  await fs.writeFile(sudo, `#!/bin/sh\nprintf '%s' "$4" > "${scriptFile}"\nexit 0\n`, "utf8");
  await fs.chmod(sudo, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${tmp}${path.delimiter}${originalPath || ""}`;
  try {
    const client = new CubeSandboxClient({ ip, tc, bpftool });
    const result = await client.syncCubeSandboxHairpinTopology([
      {
        id: "cp",
        name: "cp",
        backendConfig: {
          network: {},
          kubernetes: { nodeRole: "control-plane" }
        },
        sandbox: { sandboxIp: "192.168.0.73" }
      },
      {
        id: "worker",
        name: "worker",
        backendConfig: {
          network: { inbound: { defaultPolicy: "deny" } },
          kubernetes: { nodeRole: "worker" }
        },
        sandbox: { sandboxIp: "192.168.0.168" }
      }
    ]);
    const script = await fs.readFile(scriptFile, "utf8");

    assert.equal(result.applied, true);
    assert.equal(result.nodeCount, 2);
    assert.equal(result.pairCount, 2);
    assert.equal(result.ruleCount, 11);
    assert.match(script, /for pref in \$\(seq 250 899\)/);
    assert.match(script, new RegExp(`${escapeRegExp(tc)}' filter add dev 'z192\\.168\\.0\\.168' ingress pref 254 protocol ip flower dst_ip '192\\.168\\.0\\.73/32' ip_proto icmp type 8`));
    assert.match(script, new RegExp(`${escapeRegExp(tc)}' filter add dev 'z192\\.168\\.0\\.168' ingress pref 256 protocol ip flower dst_ip '192\\.168\\.0\\.73/32' ip_proto udp .*redirect dev 'z192\\.168\\.0\\.73'`));
    assert.match(script, /action pedit ex munge eth src set '20:90:6f:cf:cf:cf' munge eth dst set '20:90:6f:fc:fc:fc'/);
    assert.match(script, /munge ip src set '192\.168\.0\.168' munge ip dst set '169\.254\.68\.6'/);
    assert.match(script, new RegExp(`${escapeRegExp(tc)}' filter add dev 'z192\\.168\\.0\\.73' ingress pref 258 protocol ip flower dst_ip '192\\.168\\.0\\.168/32' ip_proto tcp tcp_flags 0x02/0x12 action drop`));
    assert.match(script, new RegExp(`${escapeRegExp(tc)}' filter add dev 'z192\\.168\\.0\\.73' ingress pref 259 protocol ip flower dst_ip '192\\.168\\.0\\.168/32' ip_proto tcp .*redirect dev 'z192\\.168\\.0\\.168'`));
    assert.match(script, new RegExp(`${escapeRegExp(tc)}' filter add dev 'z192\\.168\\.0\\.73' ingress pref 260 protocol ip flower dst_ip '192\\.168\\.0\\.168/32' ip_proto udp .*redirect dev 'z192\\.168\\.0\\.168'`));
  } finally {
    process.env.PATH = originalPath;
  }
});

test("cube client builds host VLAN access bridge setup", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-vlan-bridge-"));
  const ip = path.join(tmp, "ip");
  const tc = path.join(tmp, "tc");
  const bpftool = path.join(tmp, "bpftool");
  const sudo = path.join(tmp, "sudo");
  const scriptFile = path.join(tmp, "host-script.sh");
  await fakeBinary(ip);
  await fakeBinary(tc);
  await fakeBinary(bpftool);
  await fs.writeFile(sudo, `#!/bin/sh\nprintf '%s' "$4" > "${scriptFile}"\nexit 0\n`, "utf8");
  await fs.chmod(sudo, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${tmp}${path.delimiter}${originalPath || ""}`;
  try {
    const client = new CubeSandboxClient({ ip, tc, bpftool });
    const result = await client.syncHostVlanBridge(
      { id: "world-vlan" },
      ["192.168.0.50"],
      {
        allowInternetAccess: false,
        denyOut: ["10.0.0.0/8"],
        vlan: { enabled: true, vlanId: 123, hostInterface: "eth0", bridgeName: "kzbr123" },
        nat: { enabled: false }
      }
    );
    const script = await fs.readFile(scriptFile, "utf8");

    assert.equal(result.applied, true);
    assert.equal(result.bridgeName, "kzbr123");
    assert.equal(result.vlanInterface, "eth0.123");
    assert.match(script, new RegExp(`${escapeRegExp(ip)}' link add link 'eth0' name 'eth0\\.123' type vlan id '123'`));
    assert.match(script, new RegExp(`${escapeRegExp(ip)}' link add name 'kzbr123' type bridge`));
    assert.match(script, new RegExp(`${escapeRegExp(ip)}' link set dev 'eth0\\.123' master 'kzbr123'`));
    assert.match(script, new RegExp(`${escapeRegExp(ip)}' link set dev 'z192\\.168\\.0\\.50' master 'kzbr123'`));
    assert.match(script, new RegExp(`${escapeRegExp(tc)}' filter del dev 'z192\\.168\\.0\\.50' ingress pref 1`));
    assert.match(script, new RegExp(`${escapeRegExp(tc)}' filter del dev 'z192\\.168\\.0\\.50' ingress pref 1000`));
    assert.match(script, new RegExp(`${escapeRegExp(tc)}' filter add dev 'z192\\.168\\.0\\.50' ingress pref 100 protocol ip flower dst_ip '10\\.0\\.0\\.0/8' action drop`));
  } finally {
    process.env.PATH = originalPath;
  }
});

test("cube client bypasses CubeSandbox datapath when VLAN is enabled", async () => {
  class VlanClient extends CubeSandboxClient {
    async inspectWorldSandbox() {
      return { sandboxIp: "192.168.0.51" };
    }

    async syncHostEgressRules() {
      return { applied: true };
    }

    async syncHostVlanBridge() {
      return { applied: true, enabled: true };
    }

    async syncCubeDatapathEgressRules() {
      throw new Error("datapath should not be used for VLAN bridge mode");
    }
  }

  const client = new VlanClient();
  const result = await client.applyRuntimeNetworkPolicy({
    id: "world-vlan",
    sandbox: { id: "sandbox-vlan" },
    backendConfig: {
      network: {
        type: "tap",
        vlan: { enabled: true, vlanId: 123, hostInterface: "eth0" },
        nat: { enabled: false }
      }
    }
  });

  assert.equal(result.skipped, false);
  assert.equal(result.vlan.enabled, true);
  assert.equal(result.datapath.skipped, true);
  assert.match(result.datapath.reason, /bypasses/);
});

test("cube client captures runtime snapshots and distributes committed templates", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-replication-state-"));
  const mastercli = path.join(tmp, "cubemastercli");
  const argsFile = path.join(tmp, "args.txt");
  await fs.writeFile(mastercli, `#!/bin/sh
printf '%s\\n' "$*" >> "${argsFile}"
case "$1 $2" in
  "snapshot create")
    printf '%s\\n' '{"ret":{"ret_code":200,"ret_msg":"success"},"snapshot":{"snapshot_id":"snap-1","origin_node_id":"node-a","origin_sandbox_id":"sb-1","status":"READY"},"operation":{"operation_id":"op-1","snapshot_id":"snap-1","status":"READY","progress":100}}'
    ;;
  "tpl commit")
    printf '%s\\n' '{"ret":{"ret_code":200,"ret_msg":"success"},"template_id":"tpl-1","build_id":"build-1"}'
    ;;
  "tpl build-watch")
    printf '%s\\n' '{"ret":{"ret_code":200,"ret_msg":"success"},"build_id":"build-1","template_id":"tpl-1","status":"ready","progress":100}'
    ;;
  "tpl redo")
    printf '%s\\n' '{"ret":{"ret_code":200,"ret_msg":"success"},"job":{"job_id":"job-1","template_id":"tpl-1","status":"READY","progress":100}}'
    ;;
  *)
    printf 'unexpected args: %s\\n' "$*" >&2
    exit 9
    ;;
esac
`, "utf8");
  await fs.chmod(mastercli, 0o755);

  const client = new CubeSandboxClient({ mastercli });
  const world = {
    id: "world-1",
    name: "source",
    paths: { logs: tmp },
    sandbox: { id: "sb-1" }
  };
  const request = {
    requestID: "req-1",
    containers: [{ name: "workspace", resources: { cpu: "1000m", mem: "512Mi" } }],
    annotations: { "cube.master.appsnapshot.template.id": "base", "cube.master.appsnapshot.template.version": "v2" }
  };

  const snapshot = await client.createRuntimeSnapshot(world);
  const commit = await client.commitSandboxTemplate(world, request);
  const redo = await client.distributeTemplate("tpl-1", [{ id: "node-b", nodeId: "node-b" }], { logDir: tmp });

  assert.equal(snapshot.snapshotId, "snap-1");
  assert.equal(snapshot.originNodeId, "node-a");
  assert.equal(commit.templateId, "tpl-1");
  assert.equal(commit.build.ready, true);
  assert.equal(redo.distributed, true);

  const args = await fs.readFile(argsFile, "utf8");
  assert.match(args, /snapshot create --sandbox-id sb-1/);
  assert.match(args, /tpl commit --sandbox-id sb-1 --file /);
  assert.match(args, /tpl build-watch --build-id build-1/);
  assert.match(args, /tpl redo --template-id tpl-1 .*--node node-b/);
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
