import fs from "node:fs/promises";
import path from "node:path";
import { commandExists } from "../core/fs.js";
import { runCommand } from "../core/process.js";

export class CubeSandboxClient {
  constructor(config = {}) {
    this.config = config;
  }

  available() {
    if (this.config.mode === "disabled") return { available: false, reason: "cube mode disabled" };
    if (this.config.mode === "api" && this.config.apiBaseUrl) return { available: true, mode: "api" };
    const binary = commandExists(this.config.cubecli || "cubecli");
    if (binary) return { available: true, mode: "cli", binary };
    if (this.config.mode === "auto") return { available: false, reason: "cubecli not found" };
    return { available: false, reason: `cube mode ${this.config.mode} is not available` };
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
    return this.createSandboxViaCli(world, request, status.binary);
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
    throw new Error("CubeSandbox API create is not wired yet; use cube.mode=auto or cube.mode=cli");
  }

  async destroySandbox(world) {
    const sandboxId = world.sandbox?.id;
    if (!sandboxId) return { skipped: true, reason: "world has no sandbox id" };
    const status = this.available();
    if (!status.available || status.mode !== "cli") return { skipped: true, reason: status.reason };
    return runCommand(status.binary, ["cubebox", "destroy", "--force", sandboxId], { allowFailure: true });
  }

  async exec(world, command, options = {}) {
    const sandboxId = world.sandbox?.containerId || world.sandbox?.id;
    if (!sandboxId) throw new Error(`world ${world.name} is not provisioned in CubeSandbox`);
    const status = this.available();
    if (!status.available || status.mode !== "cli") {
      throw new Error(`CubeSandbox is unavailable: ${status.reason}`);
    }
    const args = ["container", "exec"];
    if (options.tty) args.push("-i", "-t");
    args.push("-w", this.config.workspacePath || "/workspace", sandboxId, "--", ...command);
    return runCommand(status.binary, args, { inherit: options.inherit });
  }
}

function parseSandboxId(output) {
  return /create sandbox\s+([A-Za-z0-9._:-]+)\s+success/.exec(output)?.[1] || null;
}
