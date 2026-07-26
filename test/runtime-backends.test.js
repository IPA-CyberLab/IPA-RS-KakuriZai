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
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  config.gvisor = {
    ...config.gvisor,
    docker: runtime.binary,
    runtime: "runsc",
    image: "alpine:3.23",
    pull: "never"
  };

  const world = await createWorld(config, {
    name: "gvisor-test",
    backend: "gvisor",
    hostMount: false
  });
  assert.equal(world.status, "ready");
  assert.equal(world.sandbox.runtime, "gVisor");
  assert.equal(world.sandbox.mode, "docker-runsc");

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
  assert.match(log, /--label io\.kakurizai\.backend=gvisor/);
  assert.match(log, /pause kz-gvisor-test-/);
  assert.match(log, /unpause kz-gvisor-test-/);
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
  const log = path.join(tmp, "docker.log");
  await fs.writeFile(binary, `#!/bin/sh
state=${quote(state)}
log=${quote(log)}
printf '%s\\n' "$*" >> "$log"
case "$1" in
  info)
    printf '{"runsc":{"path":"runsc"}}\\n'
    ;;
  inspect)
    if [ ! -f "$state" ]; then exit 1; fi
    printf '%s|runsc\\n' "$(cat "$state")"
    ;;
  run)
    printf 'running\\n' > "$state"
    printf 'fake-container\\n'
    ;;
  exec)
    printf 'GVisor fake exec OK\\n'
    ;;
  pause)
    printf 'paused\\n' > "$state"
    ;;
  unpause|start)
    printf 'running\\n' > "$state"
    ;;
  rm)
    rm -f "$state"
    ;;
esac
`, "utf8");
  await fs.chmod(binary, 0o755);
  return { binary, log, state };
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
