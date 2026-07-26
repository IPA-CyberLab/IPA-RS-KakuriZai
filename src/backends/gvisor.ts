// @ts-nocheck
import fs from "node:fs/promises";
import path from "node:path";
import { commandExists, ensureDir, pathExists } from "../core/fs.js";
import { primaryMount } from "../core/mounts.js";
import { runCommand } from "../core/process.js";

export class GVisorBackend {
  name = "gvisor";

  constructor(config) {
    this.config = config;
    this.runtime = config.gvisor || {};
  }

  async afterCreate(world, store) {
    const docker = this.dockerCommand();
    await this.assertRuntime(docker);
    const containerName = this.containerName(world);
    const existing = await this.inspectState(docker, containerName);
    if (existing.exists) {
      if (existing.runtime !== this.runtimeName()) {
        throw new Error(`existing container ${containerName} uses runtime ${existing.runtime || "unknown"}, expected ${this.runtimeName()}`);
      }
      if (existing.status !== "running") {
        await this.docker(docker, ["start", containerName]);
      }
    } else {
      const mounts = await this.prepareMounts(world);
      const image = world.backendConfig?.template || this.runtime.image;
      if (!image) throw new Error("gvisor.image or create.template is required");
      const args = [
        "run",
        "-d",
        "--name", containerName,
        "--runtime", this.runtimeName(),
        "--label", `io.kakurizai.world=${world.id}`,
        "--label", "io.kakurizai.backend=gvisor",
        "--workdir", primaryMount(mounts)?.sandboxPath || this.runtime.workspacePath || "/workspace"
      ];
      const pull = String(this.runtime.pull || "missing");
      if (pull) args.push(`--pull=${pull}`);
      if (this.runtime.dockerNetwork) args.push("--network", String(this.runtime.dockerNetwork));
      args.push(...resourceArgs(world.backendConfig || {}));
      args.push(...networkArgs(world.backendConfig?.network || {}));
      for (const mount of mounts) {
        args.push("--mount", dockerMount(mount));
      }
      args.push(String(image), ...keepAliveCommand(this.runtime.keepAliveCommand));
      await this.docker(docker, args, { timeoutMs: Number(this.runtime.createTimeoutMs || 300000) });
    }

    const state = await this.inspectState(docker, containerName);
    if (!state.exists || state.status !== "running" || state.runtime !== this.runtimeName()) {
      throw new Error(`gVisor container verification failed: status=${state.status || "missing"} runtime=${state.runtime || "unknown"}`);
    }
    world.backendConfig.template = world.backendConfig?.template || this.runtime.image;
    world.backendConfig.workspaceStrategy = world.backendConfig?.hostMount ? "copy-on-write" : "none";
    world.backendConfig.gvisor = {
      containerName,
      runtime: state.runtime,
      dockerHost: this.runtime.dockerHost || null
    };
    world.sandbox = {
      id: containerName,
      containerId: containerName,
      baseId: world.backendConfig.template,
      runtime: "gVisor",
      mode: "docker-runsc",
      mountMode: world.backendConfig?.mountMode || "none",
      status: "running",
      reason: null
    };
    world.status = "ready";
    return store.save(world);
  }

  async remove(world) {
    const docker = this.dockerCommand();
    const name = this.containerName(world);
    const result = await this.docker(docker, ["rm", "-f", name], { allowFailure: true });
    if (result.code !== 0 && !/No such container/i.test(result.stderr || result.stdout)) {
      throw commandError("remove", result);
    }
    return { applied: result.code === 0, skipped: result.code !== 0, reason: result.code === 0 ? null : "container was already absent" };
  }

  async pause(world) {
    return this.lifecycle(world, "pause");
  }

  async resume(world) {
    return this.lifecycle(world, "unpause");
  }

  async lifecycle(world, action) {
    const docker = this.dockerCommand();
    const result = await this.docker(docker, [action, this.containerName(world)], { allowFailure: true });
    return {
      applied: result.code === 0,
      reason: result.code === 0 ? null : result.stderr.trim() || result.stdout.trim() || `docker ${action} failed`
    };
  }

  async exec(world, command, options = {}) {
    const docker = this.dockerCommand();
    const args = ["exec"];
    if (options.input != null || options.tty) args.push("-i");
    if (options.tty) args.push("-t");
    if (options.cwd) args.push("--workdir", String(options.cwd));
    args.push(this.containerName(world), ...command.map(String));
    return this.docker(docker, args, options);
  }

  shellCommand(world) {
    const shell = this.runtime.shell || "sh";
    return {
      command: this.dockerCommand(),
      args: [
        "exec",
        "-it",
        "--env", "TERM=xterm-256color",
        "--env", "COLORTERM=truecolor",
        "--env", "LANG=C.UTF-8",
        "--env", "LC_ALL=C.UTF-8",
        this.containerName(world),
        shell
      ],
      env: this.dockerEnv()
    };
  }

  async prepareMounts(world) {
    const mounts = Array.isArray(world.backendConfig?.mounts) ? world.backendConfig.mounts : [];
    for (const mount of mounts) {
      if (mount.mode !== "agctl-overlay") continue;
      const destination = path.join(world.paths.upper, mount.id);
      const marker = path.join(world.paths.workdir, `gvisor-${mount.id}.initialized`);
      if (!(await pathExists(marker))) {
        await fs.rm(destination, { recursive: true, force: true });
        await fs.cp(mount.sourcePath, destination, {
          recursive: true,
          force: true,
          preserveTimestamps: true,
          verbatimSymlinks: true
        });
        await ensureDir(path.dirname(marker));
        await fs.writeFile(marker, `${mount.sourcePath}\n`, "utf8");
      }
      mount.runtimeSourcePath = destination;
    }
    return mounts;
  }

  async assertRuntime(docker) {
    const result = await this.docker(docker, ["info", "--format", "{{json .Runtimes}}"], {
      timeoutMs: Number(this.runtime.infoTimeoutMs || 30000)
    });
    let runtimes = {};
    try {
      runtimes = JSON.parse(result.stdout.trim());
    } catch {
      // Keep the raw-output check for older Docker versions and test doubles.
    }
    if (!Object.prototype.hasOwnProperty.call(runtimes, this.runtimeName())
      && !new RegExp(`["']?${escapeRegExp(this.runtimeName())}["']?`).test(result.stdout)) {
      throw new Error(`Docker runtime ${this.runtimeName()} is not registered; install runsc and add it to the Docker daemon runtimes`);
    }
  }

  async inspectState(docker, name) {
    const result = await this.docker(docker, [
      "inspect",
      "--format",
      "{{.State.Status}}|{{.HostConfig.Runtime}}",
      name
    ], { allowFailure: true });
    if (result.code !== 0) return { exists: false, status: null, runtime: null };
    const [status, runtime] = result.stdout.trim().split("|");
    return { exists: true, status, runtime };
  }

  dockerCommand() {
    const configured = this.runtime.docker || "docker";
    const command = commandExists(configured);
    if (!command) throw new Error(`Docker command is unavailable: ${configured}`);
    return command;
  }

  runtimeName() {
    return String(this.runtime.runtime || "runsc");
  }

  containerName(world) {
    return world.backendConfig?.gvisor?.containerName || `kz-${world.id}`.slice(0, 63);
  }

  dockerEnv() {
    return this.runtime.dockerHost ? { DOCKER_HOST: String(this.runtime.dockerHost) } : {};
  }

  docker(command, args, options = {}) {
    return runCommand(command, args, {
      ...options,
      env: { ...this.dockerEnv(), ...(options.env || {}) }
    });
  }
}

function dockerMount(mount) {
  const source = mount.mode === "agctl-overlay" ? mount.runtimeSourcePath : mount.sourcePath;
  const readonly = mount.mode === "cubesandbox-readonly";
  return [
    "type=bind",
    `src=${source}`,
    `dst=${mount.sandboxPath}`,
    ...(readonly ? ["readonly"] : [])
  ].join(",");
}

function resourceArgs(config) {
  const args = [];
  if (config.cpu) args.push("--cpus", cpuCount(config.cpu));
  if (config.memory) args.push("--memory", byteQuantity(config.memory));
  return args;
}

function networkArgs(network) {
  const args = [];
  for (const value of network.exposedPorts || []) {
    const port = Number(typeof value === "object" ? value.port || value.sandboxPort : value);
    if (Number.isInteger(port) && port > 0 && port <= 65535) args.push("--expose", String(port));
  }
  for (const forward of network.nat?.portForwards || []) {
    const hostPort = Number(forward.hostPort);
    const sandboxPort = Number(forward.sandboxPort || forward.containerPort);
    if (!Number.isInteger(hostPort) || !Number.isInteger(sandboxPort)) continue;
    const address = forward.listenAddress || "127.0.0.1";
    const protocol = forward.protocol || "tcp";
    args.push("-p", `${address}:${hostPort}:${sandboxPort}/${protocol}`);
  }
  return args;
}

function cpuCount(value) {
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?m$/.test(text)) return String(Number(text.slice(0, -1)) / 1000);
  if (/^\d+(?:\.\d+)?$/.test(text)) return text;
  throw new Error(`gVisor CPU must be a core count or millicores: ${value}`);
}

function byteQuantity(value) {
  const text = String(value).trim();
  const match = /^(\d+(?:\.\d+)?)\s*([kmgtp])?(i)?(?:b)?$/i.exec(text);
  if (!match) throw new Error(`gVisor memory must look like 512M or 2GiB: ${value}`);
  const power = match[2] ? "kmgtp".indexOf(match[2].toLowerCase()) + 1 : 0;
  const base = match[3] ? 1024 : 1000;
  return String(Math.ceil(Number(match[1]) * (base ** power)));
}

function keepAliveCommand(value) {
  if (Array.isArray(value) && value.length) return value.map(String);
  return ["sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 3600; done"];
}

function commandError(action, result) {
  return new Error(`gVisor ${action} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
