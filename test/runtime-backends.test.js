import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GVisorBackend } from "../dist/src/backends/gvisor.js";
import { loadConfig } from "../dist/src/core/config.js";
import {
  createWorld,
  execWorld,
  pauseWorld,
  removeWorld,
  resumeWorld
} from "../dist/src/core/worlds.js";

test("gVisor backend drives Docker with the registered runsc runtime", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-gvisor-backend-"));
  const runtime = await fakeDocker(tmp);
  const firewall = await fakeIptables(tmp);
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  config.gvisor = {
    ...config.gvisor,
    docker: runtime.binary,
    iptables: firewall.binary,
    runtime: "runsc",
    image: "alpine:3.23",
    pull: "never",
    persistentVolumes: {
      "codex-home": "/root/.codex"
    },
    managedTmux: {
      enabled: true,
      sessionName: "codex-0",
      windowName: "codex",
      workdir: "/workspace",
      command: ["codex", "resume", "--last", "--no-alt-screen"],
      fallbackShell: "bash"
    }
  };

  const world = await createWorld(config, {
    name: "gvisor-test",
    backend: "gvisor",
    hostMount: false,
    network: {
      allowInternetAccess: true,
      nat: { enabled: true, masquerade: true },
      denyOut: ["8.8.8.0/24"]
    }
  });
  assert.equal(world.status, "ready");
  assert.equal(world.sandbox.runtime, "gVisor");
  assert.equal(world.sandbox.mode, "docker-runsc");
  assert.equal(world.backendConfig.gvisor.networkPolicy.applied, true);
  assert.equal(world.backendConfig.gvisor.restartPolicy, "on-failure");
  assert.deepEqual(world.backendConfig.gvisor.persistentVolumes, [{
    key: "codex-home",
    name: `${world.backendConfig.gvisor.containerName}-codex-home`,
    target: "/root/.codex"
  }]);
  assert.equal(world.backendConfig.gvisor.managedTmux.enabled, true);
  assert.equal(world.backendConfig.gvisor.managedTmux.applied, true);
  assert.equal(world.backendConfig.gvisor.managedTmux.sessionName, "codex-0");
  assert.equal(world.backendConfig.gvisor.managedTmux.resumedCommand, true);
  assert.equal(world.backendConfig.gvisor.networkPolicy.ipv4, "172.30.0.2");
  assert.equal(world.backendConfig.gvisor.networkPolicy.hostAccess, "denied");
  assert.equal(world.backendConfig.gvisor.networkPolicy.internetAccess, true);
  assert.ok(world.backendConfig.gvisor.networkPolicy.protectedCidrs.includes("192.168.0.0/16"));
  assert.ok(world.backendConfig.gvisor.networkPolicy.protectedCidrs.includes("8.8.8.0/24"));

  await fs.writeFile(runtime.restartPolicy, "5\n", "utf8");
  await fs.writeFile(runtime.state, "oom-exited\n", "utf8");
  const stopped = await new GVisorBackend(config).reconcileSecurity(world);
  assert.equal(stopped.skipped, true);
  assert.equal(stopped.reason, "container is exited");
  assert.equal((await fs.readFile(runtime.restartPolicy, "utf8")).trim(), "0");
  await fs.writeFile(runtime.state, "running\n", "utf8");
  const retained = await new GVisorBackend(config).reconcileSecurity(world);
  assert.equal(retained.managedTmux.applied, false);
  assert.equal(retained.managedTmux.reason, "session is already running");
  await fs.rm(runtime.tmuxSession, { force: true });
  const reconciled = await new GVisorBackend(config).reconcileSecurity(world);
  assert.equal(reconciled.managedTmux.applied, true);

  const executed = await execWorld(config, world.id, ["sh", "-lc", "echo ok"]);
  assert.match(executed.stdout, /GVisor fake exec OK/);
  const shell = new GVisorBackend(config).shellCommand(world);
  assert.deepEqual(shell.args, [
    "exec",
    "-it",
    "--env", "TERM=xterm-256color",
    "--env", "COLORTERM=truecolor",
    "--env", "LANG=C.UTF-8",
    "--env", "LC_ALL=C.UTF-8",
    world.backendConfig.gvisor.containerName,
    "sh"
  ]);
  assert.equal((await pauseWorld(config, world.id)).applied, true);
  assert.equal((await resumeWorld(config, world.id)).applied, true);
  await removeWorld(config, world.id, { exactId: true });

  const log = await fs.readFile(runtime.log, "utf8");
  assert.match(log, /run .*--runtime runsc/);
  assert.match(log, /run .*--restart on-failure:0/);
  assert.match(log, /update --restart on-failure:0/);
  assert.match(log, new RegExp(`volume create .*${world.backendConfig.gvisor.containerName}-codex-home`));
  assert.match(log, new RegExp(`--mount type=volume,src=${world.backendConfig.gvisor.containerName}-codex-home,dst=/root/\\.codex`));
  assert.match(log, /exec kz-gvisor-test-[^ ]+ tmux new-session -d -s codex-0 -n codex -c \/workspace .*codex.*resume.*--last.*--no-alt-screen/);
  assert.doesNotMatch(log, /volume rm/);
  assert.doesNotMatch(log, /^start kz-gvisor-test-/m);
  assert.match(log, /--label io\.kakurizai\.backend=gvisor/);
  assert.match(log, /pause kz-gvisor-test-/);
  assert.match(log, /unpause kz-gvisor-test-/);
  const firewallLog = await fs.readFile(firewall.log, "utf8");
  assert.match(firewallLog, /-I INPUT 1 -j KAKURIZAI-GVISOR-IN/);
  assert.match(firewallLog, /-I DOCKER-USER 1 -j KAKURIZAI-GVISOR-OUT/);
  assert.match(firewallLog, /-A KAKURIZAI-GVISOR-IN -s 172\.30\.0\.2\/32 .* -j REJECT/);
  assert.match(firewallLog, /-A KAKURIZAI-GVISOR-OUT -s 172\.30\.0\.2\/32 -d 169\.254\.0\.0\/16 .* -j REJECT/);
  assert.match(firewallLog, /-A KAKURIZAI-GVISOR-OUT -s 172\.30\.0\.2\/32 -d 192\.168\.0\.0\/16 .* -j REJECT/);
  assert.match(firewallLog, /-A KAKURIZAI-GVISOR-OUT -s 172\.30\.0\.2\/32 -d 8\.8\.8\.0\/24 .* -j REJECT/);
});

test("gVisor fails closed and removes a new container when firewall installation fails", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-gvisor-fail-closed-"));
  const runtime = await fakeDocker(tmp);
  const firewall = await fakeIptables(tmp, { fail: true });
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  config.gvisor = {
    ...config.gvisor,
    docker: runtime.binary,
    iptables: firewall.binary,
    runtime: "runsc",
    image: "alpine:3.23",
    pull: "never"
  };

  await assert.rejects(
    createWorld(config, {
      name: "gvisor-fail-closed",
      backend: "gvisor",
      hostMount: false
    }),
    /network isolation failed closed/
  );

  const log = await fs.readFile(runtime.log, "utf8");
  assert.match(log, /stop -t 0 kz-gvisor-fail-closed-/);
  assert.match(log, /rm -f kz-gvisor-fail-closed-/);
});

test("Fuchsia backend starts, executes, persists, reuses, and removes an ffx emulator", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-fuchsia-backend-"));
  const runtime = await fakeFfx(tmp);
  const productBundle = path.join(tmp, "product-bundle");
  await fs.mkdir(productBundle);
  await fs.writeFile(path.join(productBundle, "product_bundle.json"), "{}\n");
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  config.fuchsia = {
    ...config.fuchsia,
    ffx: runtime.binary,
    productBundle,
    acceleration: "none",
    network: "user",
    repositoryEnabled: false
  };

  const world = await createWorld(config, {
    name: "fuchsia-test",
    backend: "fuchsia",
    hostMount: false,
    cpu: "2"
  });
  assert.equal(world.status, "ready");
  assert.equal(world.sandbox.runtime, "Fuchsia");
  assert.equal(world.sandbox.mode, "ffx-emulator");

  const executed = await execWorld(config, world.id, ["echo", "ok"]);
  assert.match(executed.stdout, /Fuchsia fake ssh OK/);
  assert.equal((await pauseWorld(config, world.id)).applied, true);
  assert.equal((await resumeWorld(config, world.id)).applied, true);
  await removeWorld(config, world.id, { exactId: true });

  const log = await fs.readFile(runtime.log, "utf8");
  assert.match(log, /emu start .*--headless .*--accel none .*--net user .*--smp 2/);
  assert.match(log, /emu stop --persist kz-fuchsia-test-/);
  assert.match(log, /emu start .*--reuse/);
  assert.match(log, /emu stop kz-fuchsia-test-/);
});

test("Fuchsia rejects host bind mounts before starting ffx", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-fuchsia-mount-"));
  const source = path.join(tmp, "source");
  await fs.mkdir(source);
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });

  await assert.rejects(
    createWorld(config, {
      name: "fuchsia-mounted",
      backend: "fuchsia",
      sourcePath: source
    }),
    /does not support Linux host bind mounts/
  );
});

async function fakeDocker(tmp) {
  const binary = path.join(tmp, "docker");
  const state = path.join(tmp, "docker-state");
  const restartPolicy = path.join(tmp, "docker-restart-policy");
  const tmuxSession = path.join(tmp, "tmux-session");
  const log = path.join(tmp, "docker.log");
  await fs.writeFile(binary, `#!/bin/sh
state=${quote(state)}
restart_policy=${quote(restartPolicy)}
tmux_session=${quote(tmuxSession)}
log=${quote(log)}
printf '%s\\n' "$*" >> "$log"
case "$1" in
  info)
    printf '{"runsc":{"path":"runsc"}}\\n'
    ;;
  inspect)
    if [ ! -f "$state" ]; then exit 1; fi
    status="$(cat "$state")"
    oom=false
    exit_code=0
    if [ "$status" = "oom-exited" ]; then
      status=exited
      oom=true
      exit_code=137
    fi
    retries=0
    if [ -f "$restart_policy" ]; then retries=$(cat "$restart_policy"); fi
    ip=
    if [ "$status" = "running" ]; then ip=172.30.0.2; fi
    container="$4"
    printf '{"State":{"Status":"%s","Paused":false,"OOMKilled":%s,"ExitCode":%s},"HostConfig":{"Runtime":"runsc","RestartPolicy":{"Name":"on-failure","MaximumRetryCount":%s}},"Mounts":[{"Type":"volume","Name":"%s-codex-home","Source":"/var/lib/docker/volumes/%s-codex-home/_data","Destination":"/root/.codex"}],"NetworkSettings":{"Networks":{"bridge":{"IPAddress":"%s","GlobalIPv6Address":""}}}}\\n' "$status" "$oom" "$exit_code" "$retries" "$container" "$container" "$ip"
    ;;
  run)
    previous=
    for arg in "$@"; do
      if [ "$previous" = "--restart" ]; then
        case "$arg" in
          on-failure:*) printf '%s\\n' "\${arg#*:}" > "$restart_policy" ;;
          on-failure) printf '0\\n' > "$restart_policy" ;;
        esac
        break
      fi
      previous="$arg"
    done
    printf 'running\\n' > "$state"
    printf 'fake-container\\n'
    ;;
  update)
    policy="$3"
    case "$policy" in
      on-failure:*) printf '%s\\n' "\${policy#*:}" > "$restart_policy" ;;
      on-failure) printf '0\\n' > "$restart_policy" ;;
    esac
    ;;
  exec)
    if [ "$3" = "tmux" ]; then
      case "$4" in
        -V)
          printf 'tmux 3.4\\n'
          ;;
        has-session)
          [ -f "$tmux_session" ]
          ;;
        new-session)
          : > "$tmux_session"
          ;;
      esac
      exit $?
    fi
    printf 'GVisor fake exec OK\\n'
    ;;
  pause)
    printf 'paused\\n' > "$state"
    ;;
  unpause|start)
    printf 'running\\n' > "$state"
    ;;
  stop)
    printf 'stopped\\n' > "$state"
    ;;
  rm)
    rm -f "$state"
    rm -f "$restart_policy"
    rm -f "$tmux_session"
    ;;
esac
`, "utf8");
  await fs.chmod(binary, 0o755);
  return { binary, log, state, restartPolicy, tmuxSession };
}

async function fakeIptables(tmp, options = {}) {
  const binary = path.join(tmp, "iptables");
  const log = path.join(tmp, "iptables.log");
  await fs.writeFile(binary, `#!/bin/sh
printf '%s\\n' "$*" >> ${quote(log)}
${options.fail ? "exit 42" : ""}
if [ "$1" = "-C" ]; then exit 1; fi
exit 0
`, "utf8");
  await fs.chmod(binary, 0o755);
  return { binary, log };
}

async function fakeFfx(tmp) {
  const binary = path.join(tmp, "ffx");
  const state = path.join(tmp, "ffx-state");
  const log = path.join(tmp, "ffx.log");
  await fs.writeFile(binary, `#!/bin/sh
state=${quote(state)}
log=${quote(log)}
printf '%s\\n' "$*" >> "$log"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--isolate-dir" ]; then shift 2; continue; fi
  break
done
case " $* " in
  *" --machine json emu list "*)
    if [ -f "$state" ]; then
      name=$(cat "$state")
      printf '{"ok":{"data":[{"name":"%s","state":"running"}]}}\\n' "$name"
    else
      printf '{"ok":{"data":[]}}\\n'
    fi
    ;;
  *" emu start "*)
    previous=
    for arg in "$@"; do
      if [ "$previous" = "--name" ]; then printf '%s\\n' "$arg" > "$state"; break; fi
      previous=$arg
    done
    ;;
  *" emu stop --persist "*)
    ;;
  *" emu stop "*)
    rm -f "$state"
    ;;
  *" target show "*)
    printf 'Target: fake-fuchsia\\n'
    ;;
  *" target ssh "*)
    printf 'Fuchsia fake ssh OK\\n'
    ;;
esac
`, "utf8");
  await fs.chmod(binary, 0o755);
  return { binary, log, state };
}

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
