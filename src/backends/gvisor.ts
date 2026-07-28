// @ts-nocheck
import fs from "node:fs/promises";
import path from "node:path";
import { commandExists, ensureDir, pathExists } from "../core/fs.js";
import { primaryMount } from "../core/mounts.js";
import { runCommand } from "../core/process.js";

const GVISOR_INPUT_CHAIN = "KAKURIZAI-GVISOR-IN";
const GVISOR_EGRESS_CHAIN = "KAKURIZAI-GVISOR-OUT";
const MANDATORY_PROTECTED_IPV4_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4"
];

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
    const restartPolicy = this.restartPolicy();
    const persistentVolumes = this.persistentVolumeSpecs(world);
    const existing = await this.inspectState(docker, containerName);
    let created = false;
    if (existing.exists) {
      if (existing.runtime !== this.runtimeName()) {
        throw new Error(`existing container ${containerName} uses runtime ${existing.runtime || "unknown"}, expected ${this.runtimeName()}`);
      }
      this.assertPersistentVolumes(existing, persistentVolumes);
      if (existing.restartPolicy !== restartPolicy) {
        await this.docker(docker, ["update", "--restart", restartPolicy, containerName]);
      }
      if (existing.status !== "running") {
        await this.docker(docker, ["start", containerName]);
      }
    } else {
      const mounts = await this.prepareMounts(world);
      await this.ensurePersistentVolumes(docker, world, persistentVolumes);
      const image = world.backendConfig?.template || this.runtime.image;
      if (!image) throw new Error("gvisor.image or create.template is required");
      const args = [
        "run",
        "-d",
        "--name", containerName,
        "--runtime", this.runtimeName(),
        "--restart", restartPolicy,
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
      for (const volume of persistentVolumes) {
        args.push("--mount", `type=volume,src=${volume.name},dst=${volume.target}`);
      }
      args.push(String(image), ...keepAliveCommand(this.runtime.keepAliveCommand));
      await this.docker(docker, args, { timeoutMs: Number(this.runtime.createTimeoutMs || 300000) });
      created = true;
    }

    const state = await this.inspectState(docker, containerName);
    if (!state.exists || state.status !== "running" || state.runtime !== this.runtimeName() || state.restartPolicy !== restartPolicy) {
      throw new Error(`gVisor container verification failed: status=${state.status || "missing"} runtime=${state.runtime || "unknown"} restart=${state.restartPolicy || "unknown"}`);
    }
    this.assertPersistentVolumes(state, persistentVolumes);
    let networkPolicy;
    try {
      networkPolicy = await this.applyNetworkPolicy(world, state);
    } catch (error) {
      await this.stopUnsafeContainer(docker, containerName);
      if (created) {
        await this.docker(docker, ["rm", "-f", containerName], { allowFailure: true });
      }
      await this.clearNetworkPolicy(world).catch(() => {});
      throw new Error(`gVisor network isolation failed closed: ${error.message || String(error)}`);
    }
    const managedTmux = await this.ensureManagedTmux(docker, world).catch((error) => ({
      enabled: true,
      applied: false,
      reason: error.message || String(error)
    }));
    world.backendConfig.template = world.backendConfig?.template || this.runtime.image;
    world.backendConfig.workspaceStrategy = world.backendConfig?.hostMount ? "copy-on-write" : "none";
    world.backendConfig.gvisor = {
      containerName,
      runtime: state.runtime,
      restartPolicy: state.restartPolicy,
      persistentVolumes,
      managedTmux,
      dockerHost: this.runtime.dockerHost || null,
      networkPolicy
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
    const firewall = await this.clearNetworkPolicy(world).catch((error) => ({
      applied: false,
      reason: error.message || String(error)
    }));
    return {
      applied: result.code === 0,
      skipped: result.code !== 0,
      reason: result.code === 0 ? null : "container was already absent",
      firewall
    };
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
    if (result.code === 0 && action === "unpause") {
      try {
        await this.reconcileSecurity(world);
      } catch (error) {
        return {
          applied: false,
          reason: error.message || String(error)
        };
      }
    }
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
      "{{json .}}",
      name
    ], { allowFailure: true });
    if (result.code !== 0) return { exists: false, status: null, runtime: null };
    let detail;
    try {
      detail = JSON.parse(result.stdout);
    } catch {
      throw new Error(`Docker returned invalid inspect JSON for ${name}`);
    }
    const networks = Object.entries(detail.NetworkSettings?.Networks || {});
    const mounts = (detail.Mounts || []).map((mount) => ({
      type: String(mount?.Type || ""),
      name: String(mount?.Name || ""),
      source: String(mount?.Source || ""),
      target: String(mount?.Destination || "")
    }));
    const ipv4s = [...new Set(networks.map(([, network]) => String(network?.IPAddress || "").trim()).filter(Boolean))];
    const ipv6s = [...new Set(networks.map(([, network]) => String(network?.GlobalIPv6Address || "").trim()).filter(Boolean))];
    return {
      exists: true,
      status: detail.State?.Status || null,
      runtime: detail.HostConfig?.Runtime || null,
      paused: detail.State?.Paused === true,
      oomKilled: detail.State?.OOMKilled === true,
      exitCode: detail.State?.ExitCode ?? null,
      restartPolicy: dockerRestartPolicy(detail.HostConfig?.RestartPolicy),
      ipv4s,
      ipv6s,
      networks: networks.map(([network]) => network),
      mounts
    };
  }

  async reconcileSecurity(world) {
    const docker = this.dockerCommand();
    const containerName = this.containerName(world);
    const restartPolicy = this.restartPolicy();
    const state = await this.inspectState(docker, containerName);
    if (!state.exists) return { skipped: true, reason: "container is absent" };
    if (state.restartPolicy !== restartPolicy) {
      await this.docker(docker, ["update", "--restart", restartPolicy, containerName]);
      state.restartPolicy = restartPolicy;
    }
    if (state.status !== "running") return { skipped: true, reason: `container is ${state.status}` };
    let networkPolicy;
    try {
      networkPolicy = await this.applyNetworkPolicy(world, state);
    } catch (error) {
      await this.stopUnsafeContainer(docker, containerName);
      throw new Error(`gVisor network isolation failed closed for ${world.id}: ${error.message || String(error)}`);
    }
    const managedTmux = await this.ensureManagedTmux(docker, world);
    return {
      ...networkPolicy,
      managedTmux
    };
  }

  async applyNetworkPolicy(world, state = null) {
    const docker = this.dockerCommand();
    const runtimeState = state || await this.inspectState(docker, this.containerName(world));
    if (!runtimeState.exists || runtimeState.status !== "running") {
      throw new Error(`container ${this.containerName(world)} is not running`);
    }
    if (runtimeState.ipv6s?.length) {
      throw new Error(`container has IPv6 addresses but IPv6 firewall isolation is not configured: ${runtimeState.ipv6s.join(", ")}`);
    }
    const ips = [...new Set((runtimeState.ipv4s || []).map((ip) => normalizeIpv4(ip, "gVisor container IPv4 address")))];
    if (!ips.length) throw new Error("gVisor container has no IPv4 address to secure");
    const iptables = this.iptablesCommand();
    const tag = `kakurizai:${world.id}`;
    const network = world.backendConfig?.network || {};
    const protectedCidrs = uniqueCidrs([
      ...MANDATORY_PROTECTED_IPV4_CIDRS,
      ...(this.runtime.protectedCidrs || []),
      ...(network.denyOut || [])
    ]);
    const allowCidrs = uniqueCidrs(network.allowOut || []);
    const commands = [
      "set -eu",
      `${shellQuote(iptables)} -N ${GVISOR_INPUT_CHAIN} 2>/dev/null || true`,
      `${shellQuote(iptables)} -C INPUT -j ${GVISOR_INPUT_CHAIN} 2>/dev/null || ${shellQuote(iptables)} -I INPUT 1 -j ${GVISOR_INPUT_CHAIN}`,
      deleteTaggedRulesCommand(iptables, GVISOR_INPUT_CHAIN, tag),
      `${shellQuote(iptables)} -N ${GVISOR_EGRESS_CHAIN} 2>/dev/null || true`,
      `${shellQuote(iptables)} -C DOCKER-USER -j ${GVISOR_EGRESS_CHAIN} 2>/dev/null || ${shellQuote(iptables)} -I DOCKER-USER 1 -j ${GVISOR_EGRESS_CHAIN}`,
      deleteTaggedRulesCommand(iptables, GVISOR_EGRESS_CHAIN, tag)
    ];
    const internetDenied = network.allowInternetAccess === false || network.nat?.enabled === false;
    for (const ip of ips) {
      commands.push(`${shellQuote(iptables)} -A ${GVISOR_INPUT_CHAIN} -s ${shellQuote(`${ip}/32`)} -m comment --comment ${shellQuote(tag)} -j REJECT --reject-with icmp-host-prohibited`);
      for (const cidr of protectedCidrs) {
        commands.push(`${shellQuote(iptables)} -A ${GVISOR_EGRESS_CHAIN} -s ${shellQuote(`${ip}/32`)} -d ${shellQuote(cidr)} -m comment --comment ${shellQuote(tag)} -j REJECT --reject-with icmp-net-unreachable`);
      }
      if (internetDenied) {
        commands.push(`${shellQuote(iptables)} -A ${GVISOR_EGRESS_CHAIN} -s ${shellQuote(`${ip}/32`)} -m comment --comment ${shellQuote(tag)} -j REJECT --reject-with icmp-net-unreachable`);
      } else if (allowCidrs.length) {
        for (const cidr of allowCidrs) {
          commands.push(`${shellQuote(iptables)} -A ${GVISOR_EGRESS_CHAIN} -s ${shellQuote(`${ip}/32`)} -d ${shellQuote(cidr)} -m comment --comment ${shellQuote(tag)} -j RETURN`);
        }
        commands.push(`${shellQuote(iptables)} -A ${GVISOR_EGRESS_CHAIN} -s ${shellQuote(`${ip}/32`)} -m comment --comment ${shellQuote(tag)} -j REJECT --reject-with icmp-net-unreachable`);
      }
    }
    const result = await this.runFirewallScript(commands.join("\n"));
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `iptables exited with ${result.code}`);
    }
    return {
      applied: true,
      ipv4: ips[0],
      ipv4s: ips,
      networks: runtimeState.networks || [],
      hostAccess: "denied",
      protectedCidrs,
      allowCidrs,
      internetAccess: !internetDenied,
      sudo: result.sudo || false
    };
  }

  async clearNetworkPolicy(world) {
    const iptables = this.iptablesCommand();
    const tag = `kakurizai:${world.id}`;
    const result = await this.runFirewallScript([
      "set -eu",
      `${shellQuote(iptables)} -N ${GVISOR_INPUT_CHAIN} 2>/dev/null || true`,
      deleteTaggedRulesCommand(iptables, GVISOR_INPUT_CHAIN, tag),
      `${shellQuote(iptables)} -N ${GVISOR_EGRESS_CHAIN} 2>/dev/null || true`,
      deleteTaggedRulesCommand(iptables, GVISOR_EGRESS_CHAIN, tag)
    ].join("\n"));
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `iptables cleanup exited with ${result.code}`);
    }
    return { applied: true, sudo: result.sudo || false };
  }

  async runFirewallScript(script) {
    const direct = await runCommand("sh", ["-lc", script], { allowFailure: true });
    if (direct.code === 0) return { ...direct, sudo: false };
    const sudo = commandExists("sudo");
    if (!sudo) return direct;
    const elevated = await runCommand(sudo, ["-n", "sh", "-lc", script], { allowFailure: true });
    return { ...elevated, sudo: true };
  }

  async stopUnsafeContainer(docker, containerName) {
    await this.docker(docker, ["stop", "-t", "0", containerName], {
      allowFailure: true,
      timeoutMs: 30000
    });
  }

  iptablesCommand() {
    const configured = this.runtime.iptables || "iptables";
    const command = commandExists(configured)
      || commandExists("/usr/sbin/iptables")
      || commandExists("/sbin/iptables");
    if (!command) throw new Error(`iptables command is unavailable: ${configured}`);
    return command;
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

  restartPolicy() {
    const value = String(this.runtime.restartPolicy || "on-failure:5").trim();
    if (!/^(?:no|always|unless-stopped|on-failure(?::\d+)?)$/.test(value)) {
      throw new Error(`invalid gvisor.restartPolicy: ${value}`);
    }
    return value;
  }

  persistentVolumeSpecs(world) {
    const saved = world.backendConfig?.gvisor?.persistentVolumes;
    const configured = Array.isArray(saved) && saved.length
      ? Object.fromEntries(saved.map((volume) => [volume.key, volume.target]))
      : this.runtime.persistentVolumes || {};
    if (!configured || Array.isArray(configured) || typeof configured !== "object") {
      throw new Error("gvisor.persistentVolumes must be an object of volume keys to absolute container paths");
    }
    const targets = new Set();
    return Object.entries(configured).map(([key, configuredTarget]) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,47}$/.test(key)) {
        throw new Error(`invalid gvisor persistent volume key: ${key}`);
      }
      const target = String(configuredTarget || "").trim();
      if (!target.startsWith("/") || target === "/" || target.includes(",") || path.posix.normalize(target) !== target) {
        throw new Error(`invalid gvisor persistent volume target for ${key}: ${target || "missing"}`);
      }
      if (targets.has(target)) {
        throw new Error(`duplicate gvisor persistent volume target: ${target}`);
      }
      targets.add(target);
      return {
        key,
        name: `${this.containerName(world)}-${key}`,
        target
      };
    });
  }

  async ensurePersistentVolumes(docker, world, volumes) {
    for (const volume of volumes) {
      await this.docker(docker, [
        "volume", "create",
        "--label", `io.kakurizai.world=${world.id}`,
        "--label", `io.kakurizai.state=${volume.key}`,
        volume.name
      ]);
    }
  }

  assertPersistentVolumes(state, expected) {
    for (const volume of expected) {
      const mounted = (state.mounts || []).some((mount) => mount.type === "volume"
        && (mount.name === volume.name || mount.source === volume.name)
        && mount.target === volume.target);
      if (!mounted) {
        throw new Error(`existing container is missing persistent volume ${volume.name} at ${volume.target}; recreate the runtime without deleting the named volume`);
      }
    }
  }

  managedTmuxSpec() {
    const configured = this.runtime.managedTmux;
    if (configured == null) return null;
    if (Array.isArray(configured) || typeof configured !== "object") {
      throw new Error("gvisor.managedTmux must be an object");
    }
    if (configured.enabled !== true) return null;
    const sessionName = String(configured.sessionName || "codex-0").trim();
    const windowName = String(configured.windowName || "codex").trim();
    for (const [label, value] of [["sessionName", sessionName], ["windowName", windowName]]) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,47}$/.test(value)) {
        throw new Error(`invalid gvisor.managedTmux.${label}: ${value || "missing"}`);
      }
    }
    const workdir = String(configured.workdir || this.runtime.workspacePath || "/workspace").trim();
    if (!workdir.startsWith("/") || workdir === "/" || workdir.includes(",") || path.posix.normalize(workdir) !== workdir) {
      throw new Error(`invalid gvisor.managedTmux.workdir: ${workdir || "missing"}`);
    }
    const command = configured.command == null ? [] : configured.command;
    if (!Array.isArray(command) || command.some((entry) => typeof entry !== "string" || !entry.length || entry.includes("\0"))) {
      throw new Error("gvisor.managedTmux.command must be an array of non-empty strings");
    }
    const fallbackShell = String(configured.fallbackShell || "bash").trim();
    if (!/^(?:\/[^\0]+|[a-zA-Z0-9_.-]+)$/.test(fallbackShell)) {
      throw new Error(`invalid gvisor.managedTmux.fallbackShell: ${fallbackShell || "missing"}`);
    }
    return {
      sessionName,
      windowName,
      workdir,
      command: command.map(String),
      fallbackShell
    };
  }

  async ensureManagedTmux(docker, world) {
    const spec = this.managedTmuxSpec();
    if (!spec) {
      return {
        enabled: false,
        applied: false,
        reason: "disabled"
      };
    }
    const containerName = this.containerName(world);
    const version = await this.docker(docker, ["exec", containerName, "tmux", "-V"], { allowFailure: true });
    if (version.code !== 0) {
      throw new Error(`managed tmux is enabled but tmux is unavailable in ${containerName}`);
    }
    const existing = await this.docker(docker, [
      "exec", containerName, "tmux", "has-session", "-t", spec.sessionName
    ], { allowFailure: true });
    if (existing.code === 0) {
      return {
        enabled: true,
        applied: false,
        sessionName: spec.sessionName,
        windowName: spec.windowName,
        reason: "session is already running"
      };
    }
    const args = [
      "exec", containerName,
      "tmux", "new-session",
      "-d",
      "-s", spec.sessionName,
      "-n", spec.windowName,
      "-c", spec.workdir
    ];
    if (spec.command.length) {
      const command = spec.command.map(shellQuote).join(" ");
      args.push(`${command}; status=$?; printf '\\n[managed command exited with status %s; shell retained]\\n' "$status"; exec ${shellQuote(spec.fallbackShell)}`);
    }
    await this.docker(docker, args);
    return {
      enabled: true,
      applied: true,
      sessionName: spec.sessionName,
      windowName: spec.windowName,
      resumedCommand: spec.command.length > 0,
      reason: "session created"
    };
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

function deleteTaggedRulesCommand(iptables, chain, tag) {
  return `while line=$(${shellQuote(iptables)} -L ${chain} --line-numbers -n | awk -v tag=${shellQuote(tag)} '$0 ~ tag { print $1; exit }'); [ -n "$line" ]; do ${shellQuote(iptables)} -D ${chain} "$line"; done`;
}

function uniqueCidrs(values) {
  return [...new Set((values || []).map((value) => normalizeIpv4Cidr(value)))];
}

function dockerRestartPolicy(value) {
  const name = String(value?.Name || "no");
  const retries = Number(value?.MaximumRetryCount || 0);
  return name === "on-failure" && retries > 0 ? `${name}:${retries}` : name;
}

function normalizeIpv4Cidr(value) {
  const text = String(value || "").trim();
  const [address, prefixText = "32", ...extra] = text.split("/");
  if (extra.length) throw new Error(`invalid IPv4 CIDR: ${value}`);
  normalizeIpv4(address, "IPv4 CIDR");
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`invalid IPv4 CIDR prefix: ${value}`);
  }
  return `${address}/${prefix}`;
}

function normalizeIpv4(value, label) {
  const text = String(value || "").trim();
  const parts = text.split(".");
  if (parts.length !== 4) throw new Error(`${label} is unavailable or invalid: ${value || "missing"}`);
  for (const part of parts) {
    if (!/^\d+$/.test(part)) throw new Error(`${label} is unavailable or invalid: ${value}`);
    const number = Number(part);
    if (!Number.isInteger(number) || number < 0 || number > 255) {
      throw new Error(`${label} is unavailable or invalid: ${value}`);
    }
  }
  return parts.map((part) => String(Number(part))).join(".");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
