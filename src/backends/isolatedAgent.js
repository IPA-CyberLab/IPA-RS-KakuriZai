import { commandExists } from "../core/fs.js";
import { runCommand } from "../core/process.js";

const BACKEND_ARGS = {
  "apfs-clone": "apfs-clone",
  "windows-block-clone": "windows-block-clone",
  "path-preserving-overlay": "path-preserving-overlay",
  "windows-minifilter-overlay": "windows-minifilter-overlay"
};

export class IsolatedAgentBackend {
  constructor(config, name) {
    this.config = config;
    this.name = name;
  }

  agentctl() {
    return commandExists(this.config.isolatedAgent.agentctl) || commandExists("agentctl");
  }

  async afterCreate(world, store) {
    const binary = this.agentctl();
    world.backendConfig.delegatedTo = {
      submodule: this.config.isolatedAgent.sourceTree,
      binary: binary || this.config.isolatedAgent.agentctl
    };
    if (!binary) {
      world.status = "pending-agentctl";
      world.sandbox = {
        id: null,
        baseId: null,
        runtime: "IPA-RS-IsolatedAgent",
        status: "agentctl-not-found",
        reason: "install agentctl or set AGCTL_AGENTCTL"
      };
      return store.save(world);
    }
    const args = ["new", "-t", world.name, "--from", world.sourcePath];
    if (BACKEND_ARGS[this.name]) args.push("--backend", BACKEND_ARGS[this.name]);
    const result = await runCommand(binary, args, { allowFailure: true });
    world.sandbox = {
      id: world.name,
      baseId: null,
      runtime: "IPA-RS-IsolatedAgent",
      status: result.code === 0 ? "created" : "failed",
      reason: result.code === 0 ? null : result.stderr || result.stdout
    };
    world.status = result.code === 0 ? "ready" : "failed";
    return store.save(world);
  }

  async remove(world) {
    const binary = this.agentctl();
    if (!binary || !world.sandbox?.id) return { skipped: true };
    return runCommand(binary, ["rm", world.sandbox.id], { allowFailure: true });
  }

  async exec(world, command, options = {}) {
    const binary = this.agentctl();
    if (!binary) throw new Error("agentctl is unavailable");
    return runCommand(binary, ["exec", world.sandbox?.id || world.name, "--", ...command], {
      inherit: options.inherit
    });
  }
}
