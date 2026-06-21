// @ts-nocheck
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { commandExists } from "../core/fs.js";
import { runCommand } from "../core/process.js";
import { mountSpecsForWorld } from "./request.js";

export class CubeSandboxClient {
  constructor(config = {}) {
    this.config = config;
  }

  available() {
    const mode = this.config.mode || "auto";
    if (mode === "disabled") return { available: false, reason: "cube mode disabled" };
    if (mode === "api") {
      if (this.config.apiBaseUrl) return { available: true, mode: "api" };
      return { available: false, reason: "cube apiBaseUrl is not configured" };
    }
    const masterBinary = commandExists(this.config.mastercli || "cubemastercli");
    if (mode === "master") {
      if (masterBinary) return { available: true, mode: "master", binary: masterBinary };
      return { available: false, reason: "cubemastercli not found" };
    }
    if (mode === "auto" && masterBinary) {
      return { available: true, mode: "master", binary: masterBinary };
    }
    const binary = commandExists(this.config.cubecli || "cubecli");
    if (binary) return { available: true, mode: "cli", binary };
    if (mode === "auto" || mode === "cli") return { available: false, reason: "cubecli not found" };
    return { available: false, reason: `cube mode ${mode} is not available` };
  }

  async createSandbox(world, request) {
    const status = this.available();
    if (!status.available) {
      return {
        provisioned: false,
        mode: "planned",
        reason: status.reason,
        request
      };
    }
    if (status.mode === "api") {
      return this.createSandboxViaApi(world, request);
    }
    if (status.mode === "master") {
      return this.createSandboxViaMaster(world, request, status.binary);
    }
    return this.createSandboxViaCli(world, request, status.binary);
  }

  async createSandboxViaMaster(world, request, binary) {
    const requestPath = path.join(world.paths.logs, "cubemaster-create-request.json");
    await fs.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
    const result = await runCommand(binary, ["multirun", "--norm", requestPath], {
      allowFailure: true
    });
    const output = `${result.stdout}\n${result.stderr}`;
    await fs.writeFile(path.join(world.paths.logs, "cubemaster-create.log"), output, "utf8");
    if (result.code !== 0 || !/code:200/.test(output)) {
      return {
        provisioned: false,
        mode: "master",
        reason: parseFailure(output) || `cubemastercli exited with ${result.code}`,
        requestPath,
        output
      };
    }
    const sandboxId = parseMasterSandboxId(output) || world.id;
    const overlayMounts = Number(request.annotations?.["kakurizai.overlayMounts"] || 0);
    const overlay = overlayMounts > 0 ? await this.setupOverlay(world, sandboxId) : null;
    return {
      provisioned: true,
      mode: "master",
      sandboxId,
      containerId: sandboxId,
      requestPath,
      output,
      overlay
    };
  }

  async createSandboxViaCli(world, request, binary) {
    const requestPath = path.join(world.paths.logs, "cube-create-request.json");
    await fs.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
    const result = await runCommand(binary, ["cubebox", "create", "--rm=false", requestPath], {
      allowFailure: true
    });
    const output = `${result.stdout}\n${result.stderr}`;
    await fs.writeFile(path.join(world.paths.logs, "cube-create.log"), output, "utf8");
    if (result.code !== 0) {
      return {
        provisioned: false,
        mode: "cli",
        reason: `cubecli exited with ${result.code}`,
        requestPath,
        output
      };
    }
    const sandboxId = parseSandboxId(output) || world.id;
    return {
      provisioned: true,
      mode: "cli",
      sandboxId,
      containerId: sandboxId,
      requestPath,
      output
    };
  }

  async createSandboxViaApi(_world, _request) {
    throw new Error("CubeSandbox API create is not wired yet; use cube.mode=auto, cube.mode=master, or cube.mode=cli");
  }

  async inspect() {
    const status = this.available();
    const cubecli = commandExists(this.config.cubecli || "cubecli");
    const mastercli = commandExists(this.config.mastercli || "cubemastercli");
    const [cubeVersion, masterTemplates, masterSandboxes, masterNodes, storageStatus, taskStatuses] = await Promise.all([
      cubecli ? commandSummary(cubecli, ["--version"]) : Promise.resolve({ ok: false, reason: "cubecli not found" }),
      mastercli ? commandSummary(mastercli, ["tpl", "list"], parseTemplates) : Promise.resolve({ ok: false, reason: "cubemastercli not found" }),
      mastercli ? commandSummary(mastercli, ["list", "--all", "--wide"], parseSandboxesWide) : Promise.resolve({ ok: false, reason: "cubemastercli not found" }),
      mastercli ? commandSummary(mastercli, ["node", "list", "--json"], parseNodesJson) : Promise.resolve({ ok: false, reason: "cubemastercli not found" }),
      mastercli ? commandSummary(mastercli, ["storage", "status"], parseStorageStatus) : Promise.resolve({ ok: false, reason: "cubemastercli not found" }),
      cubecli ? cubeCliCommandSummary(cubecli, [...cubeCliGlobalArgs(this.config), "containerd-ctr", "tasks", "list"], parseTaskStatuses) : Promise.resolve({ ok: false, reason: "cubecli not found" })
    ]);
    const templates = masterTemplates.ok ? masterTemplates.value : [];
    const templateDetails = mastercli
      ? await Promise.all(templates.map((template) => this.inspectTemplate(template, mastercli)))
      : templates;
    const sandboxes = masterSandboxes.ok ? masterSandboxes.value : [];
    const rawSandboxDetails = await Promise.all(
      sandboxes.map((sandbox) => this.inspectSandbox(sandbox, { mastercli, cubecli }))
    );
    const sandboxDetails = rawSandboxDetails.map((sandbox) => {
      const taskStatus = taskStatusForSandbox(taskStatuses.ok ? taskStatuses.value : {}, sandbox.id);
      return taskStatus ? { ...sandbox, status: taskStatus.toLowerCase() } : sandbox;
    });
    return {
      available: status.available,
      mode: status.mode || this.config.mode || "auto",
      reason: status.reason || null,
      namespace: this.config.namespace || "default",
      template: this.config.template || null,
      cubecli: cubecli ? { path: cubecli, version: cubeVersion.stdout?.trim() || null } : null,
      mastercli: mastercli ? { path: mastercli } : null,
      templates: templateDetails,
      templatesError: masterTemplates.ok ? null : masterTemplates.reason,
      sandboxes: sandboxDetails,
      sandboxesError: masterSandboxes.ok ? null : masterSandboxes.reason,
      nodes: masterNodes.ok ? masterNodes.value : [],
      nodesError: masterNodes.ok ? null : masterNodes.reason,
      storage: storageStatus.ok ? storageStatus.value : [],
      storageError: storageStatus.ok ? null : storageStatus.reason,
      capabilities: {
        destroy: Boolean(mastercli),
        logs: Boolean(cubecli),
        pause: Boolean(mastercli || this.config.apiBaseUrl),
        resume: Boolean(mastercli || this.config.apiBaseUrl)
      },
      config: {
        apiEndpoint: this.config.apiBaseUrl || null,
        authEnabled: Boolean(this.config.authEnabled),
        sandboxDomain: this.config.sandboxDomain || null,
        instanceType: this.config.instanceType || "cubebox",
        networkType: this.config.networkType || "tap"
      }
    };
  }

  async inspectTemplate(template, mastercli) {
    const result = await commandSummary(
      mastercli,
      ["tpl", "info", "--template-id", template.id, "--include-request", "--json"],
      parseJson
    );
    if (!result.ok) return { ...template, detailError: result.reason };
    return { ...template, ...templateDetailFromRaw(result.value) };
  }

  async inspectSandbox(sandbox, binaries = {}) {
    const [info, rawInspect, logs] = await Promise.all([
      binaries.mastercli
        ? commandSummary(binaries.mastercli, ["info", "--sandboxid", sandbox.id], parseSandboxInfo)
        : Promise.resolve({ ok: false, reason: "cubemastercli not found" }),
      binaries.cubecli
        ? commandSummary(binaries.cubecli, [...cubeCliGlobalArgs(this.config), "cubebox", "inspect", sandboxIdForCubeCli(sandbox.id)], parseJson)
        : Promise.resolve({ ok: false, reason: "cubecli not found" }),
      binaries.cubecli
        ? commandSummary(binaries.cubecli, [...cubeCliGlobalArgs(this.config), "logs", "--tail", "80", sandboxIdForCubeCli(sandbox.id)])
        : Promise.resolve({ ok: false, reason: "cubecli not found" })
    ]);
    const inspect = rawInspect.ok ? rawInspect.value : null;
    return sandboxDetailFromRaw({
      base: sandbox,
      info: info.ok ? info.value : null,
      inspect,
      inspectError: rawInspect.ok ? null : rawInspect.reason,
      logs: logs.ok ? logs.stdout : "",
      logsError: logs.ok ? null : logs.reason
    });
  }

  async logs(sandboxId, options = {}) {
    const cubecli = commandExists(this.config.cubecli || "cubecli");
    if (!cubecli) return { sandboxId, logs: "", error: "cubecli not found" };
    const tail = String(options.tail || 120);
    const result = await commandSummary(cubecli, [...cubeCliGlobalArgs(this.config), "logs", "--tail", tail, sandboxIdForCubeCli(sandboxId)]);
    return {
      sandboxId,
      logs: result.stdout || "",
      stderr: result.stderr || "",
      error: result.ok ? null : result.reason
    };
  }

  async pauseSandboxById(sandboxId) {
    const cleanup = await this.cleanupExecTasks(sandboxId);
    const result = await this.masterUpdateAction(sandboxId, "pause");
    return { ...result, cleanup };
  }

  async resumeSandboxById(sandboxId) {
    return this.masterUpdateAction(sandboxId, "resume");
  }

  async pauseSandbox(world) {
    const sandboxId = world.sandbox?.containerId || world.sandbox?.id;
    if (!sandboxId) return { skipped: true, reason: "world has no sandbox id" };
    return this.pauseSandboxById(sandboxId);
  }

  async resumeSandbox(world) {
    const sandboxId = world.sandbox?.containerId || world.sandbox?.id;
    if (!sandboxId) return { skipped: true, reason: "world has no sandbox id" };
    return this.resumeSandboxById(sandboxId);
  }

  async applyRuntimeNetworkPolicy(world) {
    const network = world.backendConfig?.network || {};
    const sandboxId = world.sandbox?.containerId || world.sandbox?.id;
    if (!sandboxId) return { skipped: true, reason: "world has no sandbox id" };
    let detail = null;
    try {
      detail = await this.inspectWorldSandbox(world);
    } catch (error) {
      detail = { inspectError: error.message || String(error) };
    }
    const runtimeIp = detail?.sandboxIp || world.sandbox?.sandboxIp || null;
    const requestedIp = network.sandboxIp || null;
    const sandboxIps = [...new Set([runtimeIp, requestedIp].filter(Boolean))];
    if (!sandboxIps.length) {
      return { skipped: true, reason: "sandbox IP is not available", requestedIp, runtimeIp };
    }
    const firewall = await this.syncHostEgressRules(world, sandboxIps, network);
    return {
      skipped: false,
      requestedIp,
      runtimeIp,
      sandboxIp: requestedIp || runtimeIp,
      sandboxIps,
      firewall
    };
  }

  async syncHostEgressRules(world, sandboxIps, network = {}) {
    const iptables = commandExists(this.config.iptables || "iptables");
    if (!iptables) return { skipped: true, reason: "iptables not found" };
    const chain = "KAKURIZAI-EGRESS";
    const tag = `kakurizai:${world.id}`;
    const commands = [
      `${shellQuote(iptables)} -N ${chain} 2>/dev/null || true`,
      `${shellQuote(iptables)} -C FORWARD -j ${chain} 2>/dev/null || ${shellQuote(iptables)} -I FORWARD 1 -j ${chain}`,
      `while line=$(${shellQuote(iptables)} -L ${chain} --line-numbers -n | awk -v tag=${shellQuote(tag)} '$0 ~ tag { print $1 }' | sort -rn | head -n 1); [ -n "$line" ]; do ${shellQuote(iptables)} -D ${chain} "$line"; done`
    ];
    const cidrRules = [];
    for (const ip of sandboxIps) {
      if (network.allowInternetAccess === false) {
        cidrRules.push(`${shellQuote(iptables)} -A ${chain} -s ${shellQuote(`${ip}/32`)} -d 192.168.0.0/18 -m comment --comment ${shellQuote(tag)} -j RETURN`);
        cidrRules.push(`${shellQuote(iptables)} -A ${chain} -s ${shellQuote(`${ip}/32`)} -d 169.254.0.0/16 -m comment --comment ${shellQuote(tag)} -j RETURN`);
        cidrRules.push(`${shellQuote(iptables)} -A ${chain} -s ${shellQuote(`${ip}/32`)} -m comment --comment ${shellQuote(tag)} -j REJECT --reject-with icmp-net-unreachable`);
      } else {
        for (const cidr of network.denyOut || []) {
          cidrRules.push(`${shellQuote(iptables)} -A ${chain} -s ${shellQuote(`${ip}/32`)} -d ${shellQuote(cidr)} -m comment --comment ${shellQuote(tag)} -j REJECT --reject-with icmp-net-unreachable`);
        }
      }
      if (network.allowInternetAccess !== false && network.allowOut?.length) {
        for (const cidr of network.allowOut) {
          cidrRules.push(`${shellQuote(iptables)} -A ${chain} -s ${shellQuote(`${ip}/32`)} -d ${shellQuote(cidr)} -m comment --comment ${shellQuote(tag)} -j RETURN`);
        }
        cidrRules.push(`${shellQuote(iptables)} -A ${chain} -s ${shellQuote(`${ip}/32`)} -m comment --comment ${shellQuote(tag)} -j REJECT --reject-with icmp-net-unreachable`);
      }
    }
    commands.push(...cidrRules);
    const script = commands.join("\n");
    const result = await runHostNetworkCommand(script);
    return {
      skipped: false,
      applied: result.code === 0,
      code: result.code,
      sudo: result.sudo || false,
      ruleCount: cidrRules.length,
      reason: result.code === 0 ? null : result.stderr || result.stdout || `iptables exited with ${result.code}`
    };
  }

  async masterUpdateAction(sandboxId, action) {
    const response = await postJson(`${masterApiBaseUrl(this.config)}/cube/sandbox/update`, {
      requestID: `kakurizai-${action}-${Date.now()}`,
      sandbox_id: sandboxId,
      instance_type: this.config.instanceType || "cubebox",
      action
    });
    const ret = response?.ret || {};
    const retCode = Number(ret.ret_code);
    const applied = retCode === 0 || retCode === 200;
    return {
      sandboxId,
      action,
      applied,
      code: retCode,
      stdout: JSON.stringify(response),
      stderr: "",
      reason: applied ? null : ret.ret_msg || `CubeMaster ${action} returned ${ret.ret_code}`,
      response
    };
  }

  async cleanupExecTasks(sandboxId) {
    const binary = commandExists(this.config.cubecli || "cubecli");
    if (!binary) return { skipped: true, reason: "cubecli not found" };
    const fifoRoot = this.config.fifoDir || "/data/cubelet/fifo";
    const script = [
      "set -eu",
      `fifo_root=${shellQuote(fifoRoot)}`,
      `cube_bin=${shellQuote(binary)}`,
      "run_cube() { if command -v sudo >/dev/null 2>&1 && sudo -n \"$cube_bin\" \"$@\" >/dev/null 2>&1; then return 0; fi; \"$cube_bin\" \"$@\" >/dev/null 2>&1; }",
      "if [ ! -d \"$fifo_root\" ]; then exit 0; fi",
      "find \"$fifo_root\" -maxdepth 2 -type p -name 'exec-*-stdin' 2>/dev/null | sed -E 's#.*/(exec-[^-]+)-stdin#\\1#' | sort -u | while read -r exec_id; do",
      "  [ -n \"$exec_id\" ] || continue",
      `  run_cube ${cubeCliGlobalArgs(this.config).map(shellQuote).join(" ")} containerd-ctr tasks kill --exec-id "$exec_id" --signal SIGKILL ${shellQuote(sandboxId)} || true`,
      `  run_cube ${cubeCliGlobalArgs(this.config).map(shellQuote).join(" ")} containerd-ctr tasks delete --exec-id "$exec_id" ${shellQuote(sandboxId)} || true`,
      "  printf '%s\\n' \"$exec_id\"",
      "done"
    ].join("\n");
    const result = await runCommand("sh", ["-lc", script], { allowFailure: true });
    if (result.code === 0) {
      return {
        skipped: false,
        code: result.code,
        execIds: result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      };
    }
    const sudo = commandExists("sudo");
    if (!sudo || !shouldRetryWithSudo(result)) {
      return {
        skipped: false,
        code: result.code,
        execIds: [],
        reason: result.stderr || result.stdout || `exec cleanup exited with ${result.code}`
      };
    }
    const sudoScript = script.replaceAll(shellQuote(binary), `${shellQuote(sudo)} -n ${shellQuote(binary)}`);
    const sudoResult = await runCommand("sh", ["-lc", sudoScript], { allowFailure: true });
    return {
      skipped: false,
      code: sudoResult.code,
      sudo: true,
      execIds: sudoResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      reason: sudoResult.code === 0 ? null : sudoResult.stderr || sudoResult.stdout || `sudo exec cleanup exited with ${sudoResult.code}`
    };
  }

  async destroySandboxById(sandboxId) {
    const masterBinary = commandExists(this.config.mastercli || "cubemastercli");
    if (!masterBinary) return { skipped: true, reason: "cubemastercli not found" };
    const result = await runCommand(masterBinary, ["cubebox", "destroy", sandboxId], { allowFailure: true });
    return {
      sandboxId,
      destroyed: result.code === 0,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      reason: result.code === 0 ? null : parseFailure(`${result.stdout}\n${result.stderr}`) || `cubemastercli exited with ${result.code}`
    };
  }

  async destroySandbox(world) {
    const sandboxId = world.sandbox?.id;
    if (!sandboxId) return { skipped: true, reason: "world has no sandbox id" };
    if (world.sandbox?.mode === "master") {
      const masterBinary = commandExists(this.config.mastercli || "cubemastercli");
      if (!masterBinary) return { skipped: true, reason: "cubemastercli not found" };
      return runCommand(masterBinary, ["cubebox", "destroy", sandboxId], { allowFailure: true });
    }
    const status = this.available();
    if (!status.available || status.mode !== "cli") return { skipped: true, reason: status.reason };
    return runCommand(status.binary, ["cubebox", "destroy", "--force", sandboxId], { allowFailure: true });
  }

  async exec(world, command, options = {}) {
    const sandboxId = world.sandbox?.containerId || world.sandbox?.id;
    if (!sandboxId) throw new Error(`world ${world.name} is not provisioned in CubeSandbox`);
    const binary = commandExists(this.config.cubecli || "cubecli");
    if (!binary) throw new Error("CubeSandbox is unavailable: cubecli not found");
    const args = [...cubeCliGlobalArgs(this.config), "exec"];
    if (options.tty) args.push("-i", "-t");
    args.push("-w", this.config.workspacePath || "/workspace", sandboxIdForCubeCli(sandboxId), ...command);
    return runCommand(binary, args, { inherit: options.inherit, allowFailure: options.allowFailure });
  }

  shellCommand(world) {
    const sandboxId = world.sandbox?.containerId || world.sandbox?.id;
    if (!sandboxId) throw new Error(`world ${world.name} is not provisioned in CubeSandbox`);
    const binary = commandExists(this.config.cubecli || "cubecli");
    if (!binary) throw new Error("CubeSandbox is unavailable: cubecli not found");
    return {
      command: binary,
      args: [
        ...cubeCliGlobalArgs(this.config),
        "exec",
        "-i",
        "-t",
        "-w",
        this.config.workspacePath || "/workspace",
        sandboxIdForCubeCli(sandboxId),
        "/bin/sh",
        "-lc",
        buildInteractiveShellScript()
      ]
    };
  }

  async inspectWorldSandbox(world) {
    const sandboxId = world.sandbox?.containerId || world.sandbox?.id;
    if (!sandboxId) throw new Error(`world ${world.name} is not provisioned in CubeSandbox`);
    const mastercli = commandExists(this.config.mastercli || "cubemastercli");
    const cubecli = commandExists(this.config.cubecli || "cubecli");
    const [info, rawInspect] = await Promise.all([
      mastercli
        ? commandSummary(mastercli, ["info", "--sandboxid", sandboxId], parseSandboxInfo)
        : Promise.resolve({ ok: false, reason: "cubemastercli not found" }),
      cubecli
        ? commandSummary(cubecli, [...cubeCliGlobalArgs(this.config), "cubebox", "inspect", sandboxIdForCubeCli(sandboxId)], parseJson)
        : Promise.resolve({ ok: false, reason: "cubecli not found" })
    ]);
    return sandboxDetailFromRaw({
      base: { id: sandboxId, status: world.sandbox?.status || world.status },
      info: info.ok ? info.value : null,
      inspect: rawInspect.ok ? rawInspect.value : null,
      inspectError: rawInspect.ok ? null : rawInspect.reason,
      logs: "",
      logsError: null
    });
  }

  async startDevAccessServices(world, options = {}) {
    const sandboxId = world.sandbox?.containerId || world.sandbox?.id;
    if (!sandboxId) throw new Error(`world ${world.name} is not provisioned in CubeSandbox`);
    const binary = commandExists(this.config.cubecli || "cubecli");
    if (!binary) throw new Error("CubeSandbox is unavailable: cubecli not found");
    const mounts = mountSpecsForWorld(world, this.config);
    const workspace = options.workspace || mounts[0]?.sandboxPath || this.config.workspacePath || "/workspace";
    const script = buildDevAccessScript({
      workspace,
      vscodePort: options.vscodePort || 13337,
      sshPort: options.sshPort || 2222,
      enableVscode: options.enableVscode !== false,
      enableSsh: options.enableSsh === true,
      vscodeHashedPassword: options.vscodeHashedPassword || "",
      sshPassword: options.sshPassword || ""
    });
    const result = await runCommand(binary, [
      ...cubeCliGlobalArgs(this.config),
      "exec",
      sandboxIdForCubeCli(sandboxId),
      "/bin/sh",
      "-lc",
      script
    ], {
      allowFailure: true
    });
    const output = `${result.stdout}\n${result.stderr}`;
    await fs.writeFile(path.join(world.paths.logs, "cube-dev-access.log"), output, "utf8");
    return {
      applied: result.code === 0,
      code: result.code,
      workspace,
      vscodePort: options.vscodePort || 13337,
      sshPort: options.sshPort || 2222,
      vscode: options.enableVscode !== false,
      ssh: options.enableSsh === true,
      reason: result.code === 0 ? null : parseFailure(output) || `cubecli exec exited with ${result.code}`,
      output
    };
  }

  async setupOverlay(world, sandboxId) {
    const binary = commandExists(this.config.cubecli || "cubecli");
    if (!binary) return { mounted: false, reason: "cubecli not found" };
    const workspace = shellQuote(this.config.workspacePath || "/workspace");
    const mounts = mountSpecsForWorld(world, this.config).filter((mount) => mount.mode === "agctl-overlay");
    if (!mounts.length) return { mounted: true, driver: null, reason: null, output: "" };
    const setupCalls = mounts.map((mount) => [
      "setup_mount",
      shellQuote(mount.name),
      shellQuote(mount.lower),
      shellQuote(mount.upper),
      shellQuote(mount.work),
      shellQuote(mount.sandboxPath)
    ].join(" ")).join("; ");
    const script = [
      "set -eu",
      `workspace=${workspace}`,
      "driver_file=/kakurizai/work/.kakurizai-overlay-driver",
      "mkdir -p \"$workspace\" /kakurizai/work",
      ": > \"$driver_file\"",
      "probe_mount() { lower=$1; upper=$2; target=$3; sample_file=$(find \"$lower\" -mindepth 1 -maxdepth 4 -type f -print -quit 2>/dev/null || true); if [ -n \"$sample_file\" ]; then rel=${sample_file#\"$lower\"/}; head -c 1 \"$target/$rel\" >/dev/null || return 1; fi; sample_dir=$(find \"$lower\" -mindepth 1 -maxdepth 4 -type d -print -quit 2>/dev/null || true); if [ -n \"$sample_dir\" ]; then rel=${sample_dir#\"$lower\"/}; (cd \"$target/$rel\") || return 1; fi; probe=\".kakurizai-overlay-probe-$$\"; printf kakurizai > \"$target/$probe\" || return 1; test -f \"$upper/$probe\" || return 1; rm -f \"$upper/$probe\"; return 0; }",
      "install_unionfs_fuse() { command -v unionfs-fuse >/dev/null 2>&1 && return 0; if command -v apt-get >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; apt-get update; apt-get install -y --no-install-recommends unionfs-fuse fuse3; return 0; fi; if command -v apk >/dev/null 2>&1; then apk add --no-cache unionfs-fuse fuse3; return 0; fi; if command -v dnf >/dev/null 2>&1; then dnf install -y unionfs-fuse fuse3; return 0; fi; if command -v yum >/dev/null 2>&1; then yum install -y unionfs-fuse fuse3; return 0; fi; return 1; }",
      "install_fuse_overlayfs() { command -v fuse-overlayfs >/dev/null 2>&1 && return 0; if command -v apt-get >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; apt-get update; apt-get install -y --no-install-recommends fuse-overlayfs fuse3; return 0; fi; if command -v apk >/dev/null 2>&1; then apk add --no-cache fuse-overlayfs fuse3; return 0; fi; if command -v dnf >/dev/null 2>&1; then dnf install -y fuse-overlayfs fuse3; return 0; fi; if command -v yum >/dev/null 2>&1; then yum install -y fuse-overlayfs fuse3; return 0; fi; return 1; }",
      "setup_mount() { name=$1; lower=$2; upper=$3; work=$4; target=$5; mkdir -p \"$lower\" \"$upper\" \"$work\" \"$target\"; if mountpoint -q \"$target\" && probe_mount \"$lower\" \"$upper\" \"$target\"; then printf '%s=%s\\n' \"$name\" mounted >> \"$driver_file\"; return 0; fi; if mountpoint -q \"$target\"; then umount -l \"$target\" || true; fi; if [ -L \"$target\" ]; then rm -f \"$target\"; fi; mkdir -p \"$target\"; if mount -t overlay overlay -o lowerdir=\"$lower\",upperdir=\"$upper\",workdir=\"$work\" \"$target\" 2>/tmp/kakurizai-overlay.err && probe_mount \"$lower\" \"$upper\" \"$target\"; then printf '%s=%s\\n' \"$name\" kernel-overlay >> \"$driver_file\"; return 0; fi; if mountpoint -q \"$target\"; then umount -l \"$target\" || true; fi; install_unionfs_fuse; if unionfs-fuse -o cow \"$upper=RW:$lower=RO\" \"$target\" && probe_mount \"$lower\" \"$upper\" \"$target\"; then printf '%s=%s\\n' \"$name\" unionfs-fuse >> \"$driver_file\"; return 0; fi; if mountpoint -q \"$target\"; then fusermount3 -uz \"$target\" || fusermount -uz \"$target\" || umount -l \"$target\" || true; fi; install_fuse_overlayfs; if fuse-overlayfs -o lowerdir=\"$lower\",upperdir=\"$upper\",workdir=\"$work\" \"$target\" && probe_mount \"$lower\" \"$upper\" \"$target\"; then printf '%s=%s\\n' \"$name\" fuse-overlayfs >> \"$driver_file\"; return 0; fi; if mountpoint -q \"$target\"; then fusermount3 -uz \"$target\" || fusermount -uz \"$target\" || umount -l \"$target\" || true; fi; echo \"KakuriZai agctl overlay mount failed for $name: no usable overlay driver could read, cd, and write $target\" >&2; return 1; }",
      setupCalls
    ].join("; ");
    const result = await runCommand(binary, [
      ...cubeCliGlobalArgs(this.config),
      "exec",
      sandboxIdForCubeCli(sandboxId),
      "/bin/sh",
      "-lc",
      script
    ], {
      allowFailure: true
    });
    const output = `${result.stdout}\n${result.stderr}`;
    await fs.writeFile(path.join(world.paths.logs, "cube-overlay-setup.log"), output, "utf8");
    const driverPath = path.join(world.paths.workdir, ".kakurizai-overlay-driver");
    const driver = await fs.readFile(driverPath, "utf8").then((value) => value.trim()).catch(() => null);
    return {
      mounted: result.code === 0,
      driver,
      reason: result.code === 0 ? null : parseFailure(output) || `cubecli exec exited with ${result.code}`,
      output
    };
  }

  async bootstrapSandboxTools(world, sandboxId) {
    const config = normalizeBootstrapConfig(this.config.bootstrapTools);
    if (!config.enabled) {
      return { skipped: true, reason: "terminal tool bootstrap disabled" };
    }
    const binary = commandExists(this.config.cubecli || "cubecli");
    if (!binary) return { skipped: true, reason: "cubecli not found" };
    const script = buildBootstrapToolsScript(config);
    const result = await runCommand(binary, [
      ...cubeCliGlobalArgs(this.config),
      "exec",
      sandboxIdForCubeCli(sandboxId),
      "/bin/sh",
      "-lc",
      script
    ], {
      allowFailure: true
    });
    const output = `${result.stdout}\n${result.stderr}`;
    await fs.writeFile(path.join(world.paths.logs, "cube-terminal-bootstrap.log"), output, "utf8");
    return {
      skipped: false,
      applied: result.code === 0,
      packages: config.packages,
      commands: config.commands,
      code: result.code,
      reason: result.code === 0 ? null : parseFailure(output) || `cubecli exec exited with ${result.code}`,
      output
    };
  }
}

function normalizeBootstrapConfig(config = {}) {
  const defaults = {
    enabled: true,
    packages: [
      "bash",
      "ca-certificates",
      "curl",
      "dnsutils",
      "fuse-overlayfs",
      "fuse3",
      "git",
      "iproute2",
      "iputils-ping",
      "less",
      "nano",
      "ncurses-base",
      "ncurses-bin",
      "ncurses-term",
      "net-tools",
      "procps",
      "sudo",
      "tmux",
      "unionfs-fuse",
      "vim-tiny"
    ],
    commands: ["bash", "curl", "git", "ip", "nano", "ping", "ps", "sudo", "tmux"]
  };
  if (config === false) return { ...defaults, enabled: false };
  return {
    enabled: config.enabled !== false,
    packages: Array.isArray(config.packages) && config.packages.length ? config.packages.map(String) : defaults.packages,
    commands: Array.isArray(config.commands) && config.commands.length ? config.commands.map(String) : defaults.commands
  };
}

function buildBootstrapToolsScript(config) {
  const commands = config.commands.map(shellQuote).join(" ");
  const aptPackages = config.packages.map(shellQuote).join(" ");
  const apkPackages = config.packages.map((pkg) => apkPackageName(pkg)).map(shellQuote).join(" ");
  const rpmPackages = config.packages.map((pkg) => rpmPackageName(pkg)).map(shellQuote).join(" ");
  return [
    "set -eu",
    "need_install=0",
    `for command_name in ${commands}; do command -v \"$command_name\" >/dev/null 2>&1 || need_install=1; done`,
    "[ \"$need_install\" = \"0\" ] && exit 0",
    "if command -v apt-get >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; apt-get update; apt-get install -y --no-install-recommends " + aptPackages + "; exit 0; fi",
    "if command -v apk >/dev/null 2>&1; then apk add --no-cache " + apkPackages + "; exit 0; fi",
    "if command -v dnf >/dev/null 2>&1; then dnf install -y " + rpmPackages + "; exit 0; fi",
    "if command -v yum >/dev/null 2>&1; then yum install -y " + rpmPackages + "; exit 0; fi",
    "echo 'No supported package manager found for KakuriZai terminal bootstrap' >&2",
    "exit 0"
  ].join("; ");
}

function apkPackageName(pkg) {
  return {
    dnsutils: "bind-tools",
    "iputils-ping": "iputils",
    "ncurses-base": "ncurses-terminfo-base",
    "ncurses-bin": "ncurses",
    "ncurses-term": "ncurses-terminfo",
    "vim-tiny": "vim"
  }[pkg] || pkg;
}

function rpmPackageName(pkg) {
  return {
    dnsutils: "bind-utils",
    "iputils-ping": "iputils",
    "ncurses-bin": "ncurses",
    "vim-tiny": "vim-minimal"
  }[pkg] || pkg;
}

function buildInteractiveShellScript() {
  return [
    "export TERM=xterm-256color COLORTERM=truecolor CLICOLOR=1",
    "cat > /tmp/kakurizai-bashrc <<'KAKURIZAI_RC'",
    "export TERM=xterm-256color",
    "export COLORTERM=truecolor",
    "export CLICOLOR=1",
    "export GREP_COLORS='ms=01;38;5;203:mc=01;38;5;203:sl=:cx=:fn=38;5;111:ln=38;5;246:bn=38;5;150:se=38;5;246'",
    "if command -v dircolors >/dev/null 2>&1; then eval \"$(dircolors -b 2>/dev/null || true)\"; fi",
    "alias ls='ls --color=auto --group-directories-first'",
    "alias ll='ls -alF --color=auto --group-directories-first'",
    "alias la='ls -A --color=auto --group-directories-first'",
    "alias grep='grep --color=auto'",
    "alias egrep='egrep --color=auto'",
    "alias fgrep='fgrep --color=auto'",
    "alias diff='diff --color=auto'",
    "alias ip='ip -color=auto'",
    "show() { if [ \"${1:-}\" = \"ip\" ]; then shift; ip -brief -color=auto addr \"$@\"; else printf 'show: unsupported command: %s\\n' \"$*\" >&2; return 127; fi; }",
    "PS1='\\[\\e[38;5;45m\\]\\u@\\h\\[\\e[0m\\]:\\[\\e[38;5;111m\\]\\w\\[\\e[0m\\]\\\\$ '",
    "KAKURIZAI_RC",
    "if command -v bash >/dev/null 2>&1; then exec bash --rcfile /tmp/kakurizai-bashrc -i; fi",
    "export PS1='\\033[36m\\u@\\h\\033[0m:\\033[94m\\w\\033[0m# '",
    "exec /bin/sh -i"
  ].join("\n");
}

function buildDevAccessScript(options) {
  const workspace = shellQuote(options.workspace || "/workspace");
  const vscodePort = Number(options.vscodePort || 13337);
  const sshPort = Number(options.sshPort || 2222);
  const enableVscode = options.enableVscode !== false;
  const enableSsh = options.enableSsh === true;
  const vscodeHashedPassword = shellQuote(options.vscodeHashedPassword || "");
  const sshPassword = shellQuote(enableSsh ? options.sshPassword || "" : "");
  const packages = [
    "bash",
    "ca-certificates",
    "curl",
    "git",
    "procps",
    ...(enableSsh ? ["openssh-server"] : [])
  ];
  const vscodeExtensions = ["GitHub.vscode-pull-request-github"];
  const vscodeExtensionArgs = vscodeExtensions.map(shellQuote).join(" ");
  const aptPackages = packages.map(shellQuote).join(" ");
  const apkPackages = packages.map((pkg) => pkg === "openssh-server" ? "openssh-server" : pkg).map(shellQuote).join(" ");
  const rpmPackages = packages.map((pkg) => pkg === "procps" ? "procps-ng" : pkg).map(shellQuote).join(" ");
  return [
    "set -eu",
    "export DEBIAN_FRONTEND=noninteractive",
    `workspace=${workspace}`,
    `vscode_port=${vscodePort}`,
    `ssh_port=${sshPort}`,
    `enable_vscode=${enableVscode ? 1 : 0}`,
    `enable_ssh=${enableSsh ? 1 : 0}`,
    `vscode_hashed_password=${vscodeHashedPassword}`,
    `ssh_password=${sshPassword}`,
    "mkdir -p \"$workspace\" /tmp/kakurizai-dev-access",
    "install_packages() { if command -v apt-get >/dev/null 2>&1; then apt-get update; apt-get install -y --no-install-recommends " + aptPackages + "; return 0; fi; if command -v apk >/dev/null 2>&1; then apk add --no-cache " + apkPackages + "; return 0; fi; if command -v dnf >/dev/null 2>&1; then dnf install -y " + rpmPackages + "; return 0; fi; if command -v yum >/dev/null 2>&1; then yum install -y " + rpmPackages + "; return 0; fi; return 1; }",
    "need_packages=0",
    "[ \"$enable_vscode\" = \"0\" ] || command -v curl >/dev/null 2>&1 || need_packages=1",
    "[ \"$enable_vscode\" = \"0\" ] || command -v git >/dev/null 2>&1 || need_packages=1",
    "[ \"$enable_ssh\" = \"0\" ] || command -v sshd >/dev/null 2>&1 || need_packages=1",
    "[ \"$need_packages\" = \"0\" ] || install_packages",
    "if [ \"$enable_ssh\" = \"1\" ]; then mkdir -p /run/sshd /root/.ssh; chmod 700 /root/.ssh; ssh-keygen -A >/tmp/kakurizai-dev-access/ssh-keygen.log 2>&1 || true; if [ -n \"$ssh_password\" ] && command -v chpasswd >/dev/null 2>&1; then printf 'root:%s\\n' \"$ssh_password\" | chpasswd; fi; cat > /tmp/kakurizai-dev-access/sshd_config <<KAKURIZAI_SSHD\nPort ${ssh_port}\nListenAddress 0.0.0.0\nPermitRootLogin yes\nPasswordAuthentication yes\nPubkeyAuthentication yes\nUsePAM no\nPidFile /tmp/kakurizai-dev-access/sshd.pid\nAuthorizedKeysFile .ssh/authorized_keys\nSubsystem sftp internal-sftp\nKAKURIZAI_SSHD\nsshd_binary=$(command -v sshd || printf /usr/sbin/sshd); sshd_pid_file=/tmp/kakurizai-dev-access/sshd.pid; sshd_running=0; if [ -f \"$sshd_pid_file\" ]; then sshd_pid=$(cat \"$sshd_pid_file\" 2>/dev/null || true); if [ -n \"$sshd_pid\" ] && kill -0 \"$sshd_pid\" 2>/dev/null; then sshd_running=1; fi; fi; if [ \"$sshd_running\" = \"0\" ]; then \"$sshd_binary\" -f /tmp/kakurizai-dev-access/sshd_config -E /tmp/kakurizai-dev-access/sshd.log; fi; fi",
    "if [ \"$enable_vscode\" = \"1\" ]; then if [ -z \"$vscode_hashed_password\" ]; then echo 'missing code-server hashed password' >&2; exit 1; fi; install_code_server() { command -v code-server >/dev/null 2>&1 && return 0; if command -v npm >/dev/null 2>&1; then npm install -g code-server && return 0; fi; curl -fsSL https://code-server.dev/install.sh | sh; }; install_vscode_extensions() { mkdir -p /tmp/kakurizai-dev-access; for extension_id in " + vscodeExtensionArgs + "; do code-server --list-extensions 2>/dev/null | grep -Fqi \"$extension_id\" && continue; code-server --install-extension \"$extension_id\" --force >>/tmp/kakurizai-dev-access/extensions.log 2>&1 || true; done; }; stop_code_server() { code_pid_file=/tmp/kakurizai-dev-access/code-server.pid; if [ -f \"$code_pid_file\" ]; then code_pid=$(cat \"$code_pid_file\" 2>/dev/null || true); if [ -n \"$code_pid\" ] && kill -0 \"$code_pid\" 2>/dev/null; then kill \"$code_pid\" 2>/dev/null || true; fi; fi; if command -v fuser >/dev/null 2>&1; then fuser -k \"${vscode_port}/tcp\" >/dev/null 2>&1 || true; fi; if command -v lsof >/dev/null 2>&1; then lsof -ti tcp:\"$vscode_port\" | xargs -r kill 2>/dev/null || true; fi; if command -v ss >/dev/null 2>&1; then ss -ltnp 2>/dev/null | awk -v port=\":$vscode_port\" '$4 ~ port {print $NF}' | sed -n 's/.*pid=\\([0-9][0-9]*\\).*/\\1/p' | xargs -r kill 2>/dev/null || true; fi; if command -v ps >/dev/null 2>&1; then code_server_port=:$vscode_port; ps -eo pid=,comm=,args= 2>/dev/null | while read -r pid comm args; do if [ \"$comm\" = node ]; then case \"$args\" in *code-server*$code_server_port*) [ \"$pid\" = \"$$\" ] || kill \"$pid\" 2>/dev/null || true ;; esac; fi; done; fi; sleep 1; }; command -v code-server >/dev/null 2>&1 || install_code_server; install_vscode_extensions; stop_code_server; code_pid_file=/tmp/kakurizai-dev-access/code-server.pid; HASHED_PASSWORD=\"$vscode_hashed_password\" nohup code-server --bind-addr \"0.0.0.0:$vscode_port\" --auth password --disable-telemetry --disable-update-check \"$workspace\" >/tmp/kakurizai-dev-access/code-server.log 2>&1 & echo $! > \"$code_pid_file\"; fi",
    "sleep 1",
    "printf 'workspace=%s\\nvscode_port=%s\\nssh_port=%s\\n' \"$workspace\" \"$vscode_port\" \"$ssh_port\""
  ].join("\n");
}

function parseSandboxId(output) {
  return /create sandbox\s+([A-Za-z0-9._:-]+)\s+success/.exec(output)?.[1] || null;
}

function parseMasterSandboxId(output) {
  return /sandBoxId:([A-Za-z0-9._:-]+)/.exec(output)?.[1] || null;
}

function parseFailure(output) {
  return /message:([^,\n]+)/.exec(output)?.[1]?.trim() || /run fail:\s*(.+)/.exec(output)?.[1]?.trim() || null;
}

async function commandSummary(command, args, parser = null) {
  const result = await runCommand(command, args, { allowFailure: true });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (result.code !== 0) {
    return { ok: false, reason: parseFailure(`${stdout}\n${stderr}`) || `${command} ${args.join(" ")} exited with ${result.code}`, stdout, stderr };
  }
  return { ok: true, stdout, stderr, value: parser ? parser(stdout) : stdout };
}

async function cubeCliCommandSummary(command, args, parser = null) {
  const result = await runCubeCliCommand(command, args, { allowFailure: true });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (result.code !== 0) {
    return { ok: false, reason: parseFailure(`${stdout}\n${stderr}`) || `${command} ${args.join(" ")} exited with ${result.code}`, stdout, stderr };
  }
  return { ok: true, stdout, stderr, value: parser ? parser(stdout) : stdout };
}

async function runCubeCliCommand(command, args, options = {}) {
  const result = await runCommand(command, args, { allowFailure: true, input: options.input });
  if (result.code === 0 || !shouldRetryWithSudo(result)) return result;
  const sudo = commandExists("sudo");
  if (!sudo) return result;
  const sudoResult = await runCommand(sudo, ["-n", command, ...args], { allowFailure: true, input: options.input });
  return { ...sudoResult, sudo: true };
}

async function runHostNetworkCommand(script) {
  const sudo = commandExists("sudo");
  if (sudo) {
    const sudoResult = await runCommand(sudo, ["-n", "sh", "-lc", script], { allowFailure: true });
    if (sudoResult.code === 0 || !shouldRetryWithoutSudo(sudoResult)) return { ...sudoResult, sudo: true };
  }
  return runCommand("sh", ["-lc", script], { allowFailure: true });
}

function shouldRetryWithoutSudo(result) {
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  return /a password is required|may not run sudo|sudo: .*not found/i.test(output);
}

function shouldRetryWithSudo(result) {
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  return /permission denied|operation not permitted|connect: permission denied/i.test(output);
}

function masterApiBaseUrl(config = {}) {
  return String(config.apiBaseUrl || "http://127.0.0.1:8089").replace(/\/+$/, "");
}

function postJson(url, body) {
  const target = new URL(url);
  const payload = `${JSON.stringify(body)}\n`;
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      method: "POST",
      path: `${target.pathname}${target.search}`,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload)
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`CubeMaster API returned HTTP ${response.statusCode}: ${text}`));
          return;
        }
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

function parseTemplates(output) {
  const rows = tableRows(output, "TEMPLATE_ID");
  return rows.map((columns) => ({
    id: columns[0],
    status: columns[1],
    createdAt: columns[2],
    image: columns.slice(3).join(" ")
  }));
}

function parseSandboxes(output) {
  const rows = tableRows(output, "sandbox_id");
  return rows.map((columns) => ({
    id: columns[0],
    status: columns[1],
    hostId: columns[2],
    createdAt: columns[3],
    pausedAt: columns[4] || "-"
  }));
}

function parseSandboxesWide(output) {
  const rows = tableRows(output, "sandbox_id");
  if (rows.length === 0) return parseSandboxes(output);
  return rows.map((columns) => {
    const labels = parseJsonObject(columns.slice(8).join(" "));
    return {
      id: columns[0],
      status: columns[1],
      hostId: columns[2],
      createdAt: columns[3],
      pausedAt: columns[4] || "-",
      templateId: columns[5] || null,
      namespace: columns[6] || null,
      hostIp: columns[7] || null,
      labels
    };
  });
}

function parseTaskStatuses(output) {
  const rows = tableRows(output, "TASK");
  const statuses = {};
  for (const columns of rows) {
    if (columns[0] && columns[2]) statuses[columns[0]] = columns[2];
  }
  return statuses;
}

function parseJson(output) {
  return JSON.parse(output);
}

function parseNodesJson(output) {
  const raw = parseJson(output);
  const items = Array.isArray(raw?.data) ? raw.data : [];
  return items.map((node) => ({
    id: node.InstanceID || node.uuid || node.IP,
    nodeId: node.InstanceID || node.uuid || node.IP,
    ip: node.IP || null,
    instanceType: node.InstanceType || null,
    status: node.HostStatus || (node.Healthy ? "RUNNING" : "DEGRADED"),
    healthy: Boolean(node.Healthy),
    clusterLabel: node.ClusterLabel || null,
    cpuTotal: numberOrNull(node.CpuTotal),
    memTotalMB: numberOrNull(node.MemMBTotal),
    quotaCpu: numberOrNull(node.QuotaCpu),
    quotaMemMB: numberOrNull(node.QuotaMem),
    quotaCpuUsage: numberOrNull(node.QuotaCpuUsage),
    quotaMemUsage: numberOrNull(node.QuotaMemUsage),
    maxMvmLimit: numberOrNull(node.MaxMvmLimit),
    mvmNum: numberOrNull(node.mvm_num),
    dataDiskUsagePer: numberOrNull(node.DataDiskUsagePer),
    storageDiskUsagePer: numberOrNull(node.StorageDiskUsagePer),
    sysDiskUsagePer: numberOrNull(node.SysDiskUsagePer),
    metadataUpdatedAt: node.MetaDataUpdateAt || null,
    metricUpdatedAt: node.MetricUpdateAt || null,
    labels: node.NodeLabels || {}
  }));
}

function parseStorageStatus(output) {
  const rows = tableRows(output, "NODE_ID");
  return rows.map((columns) => ({
    nodeId: columns[0],
    nodeIp: columns[1],
    mode: columns[2],
    usagePct: numberOrNull(columns[3]),
    lastError: columns[4] && !isTimestamp(columns[4]) ? columns[4] : "",
    updatedAt: columns[5] || (isTimestamp(columns[4]) ? columns[4] : "")
  }));
}

function parseSandboxInfo(output) {
  const info = {};
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const match = /^([A-Z_]+)\s{2,}(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = sandboxInfoKey(match[1]);
    if (!key || key === "containers") continue;
    info[key] = parseInfoValue(match[1], match[2]);
  }
  const containers = tableRows(output, "NAME");
  info.containers = containers.map((columns) => ({
    name: columns[0],
    id: columns[1],
    image: columns[2],
    status: columns[3],
    createdAt: columns[4],
    cpu: columns[5],
    memory: columns[6],
    type: columns[7]
  }));
  return info;
}

function sandboxInfoKey(key) {
  return {
    SANDBOX_ID: "id",
    STATUS: "status",
    HOST_ID: "hostId",
    HOST_IP: "hostIp",
    SANDBOX_IP: "sandboxIp",
    TEMPLATE_ID: "templateId",
    NAMESPACE: "namespace",
    ANNOTATIONS: "annotations",
    LABELS: "labels",
    EXPOSED_PORT_MODE: "exposedPortMode",
    EXPOSED_ENDPOINT: "exposedEndpoint",
    REQUESTED_CONTAINER_PORT: "requestedContainerPort",
    CONTAINERS: "containers"
  }[key];
}

function parseInfoValue(key, value) {
  if (key === "ANNOTATIONS" || key === "LABELS") return parseJsonObject(value);
  if (key === "REQUESTED_CONTAINER_PORT") return numberOrNull(value);
  return value;
}

function templateDetailFromRaw(raw) {
  const request = raw?.create_request || raw?.createRequest || {};
  const container = request.containers?.[0] || {};
  const image = container.image || {};
  const imageAnnotations = image.annotations || {};
  const annotations = request.annotations || {};
  const env = Array.isArray(container.envs)
    ? container.envs.map((item) => `${item.key || ""}=${item.value || ""}`).filter((line) => !line.startsWith("="))
    : [];
  return {
    id: raw.template_id || raw.templateID,
    instanceType: raw.instance_type || raw.instanceType || request.instance_type || null,
    version: raw.version || null,
    status: raw.status || "UNKNOWN",
    replicas: raw.replicas || [],
    createRequest: request,
    cpu: container.resources?.cpu || null,
    memory: container.resources?.mem || null,
    writableLayerSize: image.writable_layer_size || imageAnnotations["cube.master.rootfs.writable_layer_size"] || annotations["cube.master.rootfs.writable_layer_size"] || findEmptyDirSize(request.volumes) || null,
    artifactSizeBytes: numberOrNull(imageAnnotations["cube.master.rootfs.artifact.size_bytes"]),
    exposedPorts: annotations["com.exposed_ports"] || null,
    probePath: container.probe?.probe_handler?.http_get?.path || null,
    probePort: container.probe?.probe_handler?.http_get?.port || null,
    networkType: request.network_type || raw.network_type || null,
    allowInternetAccess: raw.allowInternetAccess ?? raw.allow_internet_access ?? null,
    env
  };
}

function sandboxDetailFromRaw({ base, info, inspect, inspectError, logs, logsError }) {
  const config = inspect?.config || {};
  const annotations = {
    ...(base.annotations || {}),
    ...(info?.annotations || {}),
    ...(inspect?.Annotations || {}),
    ...(config.annotations || {})
  };
  const labels = {
    ...(base.labels || {}),
    ...(info?.labels || {}),
    ...(inspect?.Labels || {})
  };
  const container = info?.containers?.[0] || {};
  const imageAnnotations = config.image?.annotations || {};
  const resources = config.resources || {};
  const overhead = inspect?.ResourceWithOverHead || {};
  return {
    ...base,
    ...(info || {}),
    id: base.id,
    status: info?.status || base.status,
    hostId: info?.hostId || base.hostId,
    hostIp: info?.hostIp || base.hostIp,
    sandboxIp: info?.sandboxIp || inspect?.IP || null,
    templateId: info?.templateId || base.templateId || labels["cube.master.appsnapshot.template.id"] || annotations["cube.master.appsnapshot.template.id"] || null,
    namespace: info?.namespace || base.namespace || inspect?.namespace || null,
    cpu: resources.cpu || container.cpu || null,
    memory: resources.mem || container.memory || null,
    image: config.image?.image || container.image || null,
    instanceType: inspect?.instance_type || labels["cube.master.instance.type"] || null,
    writableLayerSize: annotations["cube.master.rootfs.writable_layer_size"] || imageAnnotations["cube.master.rootfs.writable_layer_size"] || config.image?.writable_layer_size || null,
    systemDiskSize: annotations["cube.master.system_disk_size"] || null,
    artifactSizeBytes: numberOrNull(imageAnnotations["cube.master.rootfs.artifact.size_bytes"]),
    hostDataDiskMB: numberOrNull(overhead.HostDataDiskMB),
    hostStorageDiskMB: numberOrNull(overhead.HostStorageDiskMB),
    volumeMounts: config.volume_mounts || [],
    portMappings: inspect?.PortMappings || [],
    exposedEndpoint: info?.exposedEndpoint || null,
    exposedPortMode: info?.exposedPortMode || null,
    requestedContainerPort: info?.requestedContainerPort || null,
    annotations,
    labels,
    inspectError,
    logs,
    logsError
  };
}

function findEmptyDirSize(volumes = []) {
  for (const volume of volumes || []) {
    const emptyDir = volume?.volume_source?.empty_dir;
    const size = emptyDir?.size_limit || emptyDir?.SizeLimit;
    if (size) return size;
  }
  return null;
}

function parseJsonObject(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function taskStatusForSandbox(statuses, sandboxId) {
  if (!sandboxId) return null;
  if (statuses[sandboxId]) return statuses[sandboxId];
  const short = sandboxIdForCubeCli(sandboxId);
  const match = Object.entries(statuses).find(([taskId]) => taskId === short || sandboxIdForCubeCli(taskId) === short);
  return match ? match[1] : null;
}

function isTimestamp(value) {
  return /^\d{4}-\d{2}-\d{2}T/.test(String(value || ""));
}

function tableRows(output, headerPrefix) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const headerIndex = lines.findIndex((line) => line.startsWith(headerPrefix));
  if (headerIndex < 0) return [];
  return lines.slice(headerIndex + 1).filter((line) => !/^[A-Z_]+\s+/.test(line)).map((line) => line.split(/\s{2,}|\t+/).filter(Boolean));
}

function sandboxIdForCubeCli(sandboxId) {
  return sandboxId.length > 12 ? sandboxId.slice(0, 12) : sandboxId;
}

function cubeCliGlobalArgs(config) {
  return config.namespace ? ["--namespace", config.namespace] : [];
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
