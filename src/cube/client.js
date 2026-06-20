import fs from "node:fs/promises";
import path from "node:path";
import { commandExists } from "../core/fs.js";
import { runCommand } from "../core/process.js";

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
    const overlay = await this.setupOverlay(world, sandboxId);
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
    const args = ["exec"];
    if (options.tty) args.push("-i", "-t");
    args.push("-w", this.config.workspacePath || "/workspace", sandboxIdForCubeCli(sandboxId), ...command);
    return runCommand(binary, args, { inherit: options.inherit });
  }

  async setupOverlay(world, sandboxId) {
    const binary = commandExists(this.config.cubecli || "cubecli");
    if (!binary) return { mounted: false, reason: "cubecli not found" };
    const workspace = shellQuote(this.config.workspacePath || "/workspace");
    const script = [
      "set -eu",
      "mkdir -p /kakurizai/lower /kakurizai/upper /kakurizai/work /kakurizai/whiteouts",
      `mkdir -p ${workspace}`,
      `mount -t overlay overlay -o lowerdir=/kakurizai/lower,upperdir=/kakurizai/upper,workdir=/kakurizai/work ${workspace} || fuse-overlayfs -o lowerdir=/kakurizai/lower,upperdir=/kakurizai/upper,workdir=/kakurizai/work ${workspace}`
    ].join("; ");
    const result = await runCommand(binary, ["exec", sandboxIdForCubeCli(sandboxId), "/bin/sh", "-lc", script], {
      allowFailure: true
    });
    const output = `${result.stdout}\n${result.stderr}`;
    await fs.writeFile(path.join(world.paths.logs, "cube-overlay-setup.log"), output, "utf8");
    return {
      mounted: result.code === 0,
      reason: result.code === 0 ? null : parseFailure(output) || `cubecli exec exited with ${result.code}`,
      output
    };
  }
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

function sandboxIdForCubeCli(sandboxId) {
  return sandboxId.length > 12 ? sandboxId.slice(0, 12) : sandboxId;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
