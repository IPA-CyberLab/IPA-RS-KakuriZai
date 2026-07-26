// @ts-nocheck
import fs from "node:fs/promises";
import path from "node:path";
import { commandExists, ensureDir, pathExists } from "../core/fs.js";
import { runCommand } from "../core/process.js";

export class FuchsiaBackend {
  name = "fuchsia";

  constructor(config) {
    this.config = config;
    this.runtime = config.fuchsia || {};
  }

  async afterCreate(world, store) {
    this.assertNoHostMount(world);
    const ffx = this.ffxCommand();
    const productBundle = await this.productBundle(world);
    await ensureDir(this.isolateDir());
    if (this.runtime.disableAnalytics !== false) {
      await this.ffx(ffx, ["config", "analytics", "disable"], { allowFailure: true, timeoutMs: 30000 });
    }
    const name = this.instanceName(world);
    const existing = await this.findEmulator(ffx, name);
    if (!existing || existing.state !== "running") {
      await this.ffx(ffx, this.startArgs(world, productBundle, existing?.state === "staged"), {
        timeoutMs: (Number(this.runtime.startupTimeoutSeconds || 180) + 30) * 1000
      });
    }
    const running = await this.findEmulator(ffx, name);
    if (!running || running.state !== "running") {
      throw new Error(`Fuchsia emulator ${name} did not reach the running state`);
    }
    const target = await this.ffx(ffx, ["-t", name, "target", "show"], {
      timeoutMs: Number(this.runtime.targetTimeoutMs || 60000)
    });
    const repository = this.runtime.repositoryEnabled === false
      ? null
      : await this.ensureRepository(ffx, world, productBundle);

    world.backendConfig.template = productBundle;
    world.backendConfig.workspaceStrategy = "none";
    world.backendConfig.fuchsia = {
      instanceName: name,
      productBundle,
      isolateDir: this.isolateDir(),
      acceleration: this.acceleration(),
      network: this.networkMode(),
      repository,
      targetSummary: target.stdout.trim()
    };
    world.sandbox = {
      id: name,
      containerId: null,
      baseId: productBundle,
      runtime: "Fuchsia",
      mode: "ffx-emulator",
      mountMode: "none",
      status: "running",
      reason: null
    };
    world.status = "ready";
    return store.save(world);
  }

  async remove(world) {
    const ffx = this.ffxCommand();
    const repository = world.backendConfig?.fuchsia?.repository;
    if (repository?.name) {
      const args = ["repository", "server", "stop", repository.name];
      if (repository.port) args.push("--port", String(repository.port));
      await this.ffx(ffx, args, { allowFailure: true, timeoutMs: 30000 });
    }
    const result = await this.ffx(ffx, ["emu", "stop", this.instanceName(world)], {
      allowFailure: true,
      timeoutMs: Number(this.runtime.stopTimeoutMs || 60000)
    });
    if (result.code !== 0 && !/not found|no emulator|unknown instance/i.test(result.stderr || result.stdout)) {
      throw new Error(`Fuchsia emulator removal failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return { applied: result.code === 0, skipped: result.code !== 0, reason: result.code === 0 ? null : "emulator was already absent" };
  }

  async pause(world) {
    const ffx = this.ffxCommand();
    const result = await this.ffx(ffx, ["emu", "stop", "--persist", this.instanceName(world)], {
      allowFailure: true,
      timeoutMs: Number(this.runtime.stopTimeoutMs || 60000)
    });
    return lifecycleResult(result, "persistently stop Fuchsia emulator");
  }

  async resume(world) {
    const ffx = this.ffxCommand();
    const productBundle = await this.productBundle(world);
    const args = this.startArgs(world, productBundle, true);
    const result = await this.ffx(ffx, args, {
      allowFailure: true,
      timeoutMs: (Number(this.runtime.startupTimeoutSeconds || 180) + 30) * 1000
    });
    if (result.code !== 0) return lifecycleResult(result, "resume Fuchsia emulator");
    if (this.runtime.repositoryEnabled !== false) {
      world.backendConfig.fuchsia.repository = await this.ensureRepository(ffx, world, productBundle);
    }
    return { applied: true, reason: null };
  }

  async exec(world, command, options = {}) {
    const ffx = this.ffxCommand();
    const args = ["-t", this.instanceName(world), "target", "ssh"];
    if (command.length) args.push(shellCommand(command));
    return this.ffx(ffx, args, options);
  }

  shellCommand(world) {
    return {
      command: this.ffxCommand(),
      args: ["--isolate-dir", this.isolateDir(), "-t", this.instanceName(world), "target", "ssh"]
    };
  }

  startArgs(world, productBundle, reuse) {
    const args = [
      "emu", "start", productBundle,
      "--name", this.instanceName(world),
      "--headless",
      "--accel", this.acceleration(),
      "--net", this.networkMode(),
      "--smp", fuchsiaCpuCount(world.backendConfig?.cpu || this.runtime.cpu || 2),
      "--startup-timeout", String(Number(this.runtime.startupTimeoutSeconds || 180))
    ];
    if (this.runtime.engine) args.push("--engine", String(this.runtime.engine));
    if (reuse) args.push("--reuse");
    return args;
  }

  async ensureRepository(ffx, world, productBundle) {
    const desired = `kz-${world.id}`.slice(0, 40);
    const actualName = `${desired}.fuchsia.com`;
    let servers = await this.repositoryServers(ffx);
    let server = servers.find((candidate) => candidate.name === actualName);
    let port = server ? portFromAddress(server.address) : null;
    if (!server) {
      const portPath = path.join(world.paths.logs, "fuchsia-repository.port");
      await fs.rm(portPath, { force: true });
      await this.ffx(ffx, [
        "-t", this.instanceName(world),
        "repository", "server", "start",
        "--background",
        "--address", String(this.runtime.repositoryAddress || "[::]:0"),
        "--port-path", portPath,
        "--product-bundle", productBundle,
        "--repository", desired,
        "--alias", "fuchsia.com",
        "--alias-conflict-mode", "replace"
      ], { timeoutMs: Number(this.runtime.repositoryTimeoutMs || 120000) });
      if (await pathExists(portPath)) {
        port = Number((await fs.readFile(portPath, "utf8")).trim()) || null;
      }
      servers = await this.repositoryServers(ffx);
      server = servers.find((candidate) => candidate.name === actualName)
        || servers.find((candidate) => candidate.repo_path?.file === path.join(productBundle, "repository"));
      port = port || portFromAddress(server?.address);
    } else {
      const args = [
        "-t", this.instanceName(world),
        "target", "repository", "register",
        "--repository", server.name,
        "--alias", "fuchsia.com",
        "--alias-conflict-mode", "replace"
      ];
      if (port) args.push("--port", String(port));
      await this.ffx(ffx, args, { timeoutMs: Number(this.runtime.repositoryTimeoutMs || 120000) });
    }
    return {
      name: server?.name || actualName,
      port,
      address: server?.address || null
    };
  }

  async repositoryServers(ffx) {
    const result = await this.ffx(ffx, ["--machine", "json", "repository", "server", "list"], {
      allowFailure: true,
      timeoutMs: 30000
    });
    if (result.code !== 0) return [];
    try {
      const parsed = JSON.parse(result.stdout);
      return parsed?.ok?.data || parsed?.data || (Array.isArray(parsed) ? parsed : []);
    } catch {
      return [];
    }
  }

  async findEmulator(ffx, name) {
    const result = await this.ffx(ffx, ["--machine", "json", "emu", "list"], {
      allowFailure: true,
      timeoutMs: 30000
    });
    if (result.code !== 0) return null;
    try {
      const parsed = JSON.parse(result.stdout);
      const values = Array.isArray(parsed) ? parsed : parsed?.ok?.data || parsed?.data || [];
      return values.find((candidate) => candidate.name === name) || null;
    } catch {
      return null;
    }
  }

  async productBundle(world) {
    const value = world.backendConfig?.template || this.runtime.productBundle;
    if (!value) throw new Error("fuchsia.productBundle or create.template is required");
    const resolved = path.resolve(String(value));
    if (!(await pathExists(path.join(resolved, "product_bundle.json")))) {
      throw new Error(`Fuchsia product bundle is missing product_bundle.json: ${resolved}`);
    }
    return resolved;
  }

  assertNoHostMount(world) {
    if (world.backendConfig?.hostMount || world.backendConfig?.mounts?.length) {
      throw new Error("Fuchsia does not support Linux host bind mounts; create it with --no-host-mount");
    }
  }

  ffxCommand() {
    const configured = this.runtime.ffx || "ffx";
    const command = commandExists(configured);
    if (!command) throw new Error(`ffx command is unavailable: ${configured}`);
    return command;
  }

  isolateDir() {
    return path.resolve(this.runtime.isolateDir || path.join(this.config.home, "fuchsia", "ffx"));
  }

  acceleration() {
    return String(this.runtime.acceleration || "auto");
  }

  networkMode() {
    return String(this.runtime.network || "user");
  }

  instanceName(world) {
    return world.backendConfig?.fuchsia?.instanceName || `kz-${world.id}`.slice(0, 63);
  }

  ffx(command, args, options = {}) {
    return runCommand(command, ["--isolate-dir", this.isolateDir(), ...args], options);
  }
}

function fuchsiaCpuCount(value) {
  const text = String(value).trim();
  if (/^\d+m$/.test(text)) return String(Math.max(1, Math.ceil(Number(text.slice(0, -1)) / 1000)));
  if (/^\d+$/.test(text)) return String(Math.max(1, Number(text)));
  throw new Error(`Fuchsia CPU must be a core count or millicores: ${value}`);
}

function shellCommand(command) {
  return command.map((part) => {
    const value = String(part);
    return /^[a-zA-Z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
  }).join(" ");
}

function portFromAddress(address) {
  const match = /:(\d+)$/.exec(String(address || ""));
  return match ? Number(match[1]) : null;
}

function lifecycleResult(result, action) {
  return {
    applied: result.code === 0,
    reason: result.code === 0 ? null : result.stderr.trim() || result.stdout.trim() || `failed to ${action}`
  };
}
