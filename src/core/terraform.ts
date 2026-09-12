// @ts-nocheck
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  stringifySandboxManifest,
  terraformForManifest,
  worldToManifest,
  writeTerraformBundle
} from "./spec.js";

const execFileAsync = promisify(execFile);
const RUN_ACTIONS = new Set(["validate", "plan", "apply", "destroy-plan", "destroy"]);
const ACTIVE_STATUSES = new Set(["queued", "running", "canceling"]);

export class TerraformManager {
  constructor(config) {
    this.config = config;
    this.enabled = config.terraform?.enabled !== false;
    this.root = path.resolve(config.terraform?.workDir || path.join(config.home || config.storeDir || process.cwd(), "terraform"));
    this.projectsRoot = path.join(this.root, "projects");
    this.runsRoot = path.join(this.root, "runs");
    this.pluginCacheDir = path.resolve(config.terraform?.pluginCacheDir || path.join(this.root, "plugin-cache"));
    this.binary = config.terraform?.binary || process.env.KAKURIZAI_TERRAFORM || "terraform";
    this.agctl = config.terraform?.agctl || fileURLToPath(new URL("../../bin/agctl.js", import.meta.url));
    this.commandTimeoutMs = Math.max(10, Number(config.terraform?.commandTimeoutSeconds || 30 * 60)) * 1000;
    this.maxLogBytes = Math.max(64 * 1024, Number(config.terraform?.maxLogBytes || 2 * 1024 * 1024));
    this.runs = new Map();
    this.projectLocks = new Map();
    this.versionCache = null;
    this.closed = false;
  }

  async load() {
    await Promise.all([
      fs.mkdir(this.projectsRoot, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.runsRoot, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.pluginCacheDir, { recursive: true, mode: 0o700 })
    ]);
    const entries = await fs.readdir(this.runsRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const job = JSON.parse(await fs.readFile(path.join(this.runsRoot, entry.name), "utf8"));
        if (!job?.id || !job?.worldId) continue;
        if (ACTIVE_STATUSES.has(job.status)) {
          job.status = "failed";
          job.stage = "interrupted";
          job.error = "Studio restarted while this Terraform run was active";
          job.finishedAt = new Date().toISOString();
          await this.persistJob(job);
        }
        this.runs.set(job.id, job);
      } catch {
        // Ignore a corrupt historical run while leaving its file available for recovery.
      }
    }
  }

  async close() {
    this.closed = true;
    for (const job of this.runs.values()) {
      if (ACTIVE_STATUSES.has(job.status) && job.child) job.child.kill("SIGTERM");
    }
  }

  async availability(options = {}) {
    if (!this.enabled) {
      return {
        installed: false,
        enabled: false,
        binary: this.binary,
        version: null,
        platform: null,
        providerSelections: {},
        error: "Terraform integration is disabled"
      };
    }
    const now = Date.now();
    if (!options.refresh && this.versionCache && now - this.versionCache.checkedAtMs < 30_000) return this.versionCache.value;
    let value;
    try {
      const { stdout } = await execFileAsync(this.binary, ["version", "-json"], {
        env: this.safeEnvironment(),
        timeout: 5000,
        maxBuffer: 1024 * 1024
      });
      const result = JSON.parse(stdout);
      value = {
        installed: true,
        enabled: true,
        binary: this.binary,
        version: result.terraform_version || result.version || null,
        platform: result.platform || null,
        providerSelections: result.provider_selections || {}
      };
    } catch (error) {
      value = {
        installed: false,
        enabled: true,
        binary: this.binary,
        version: null,
        platform: null,
        providerSelections: {},
        error: commandError(error)
      };
    }
    this.versionCache = { checkedAtMs: now, value };
    return value;
  }

  async overview(worlds = []) {
    const [terraform, projects, runs] = await Promise.all([
      this.availability(),
      this.listProjects(worlds),
      Promise.all([...this.runs.values()]
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
        .slice(0, 30)
        .map((job) => this.publicJob(job)))
    ]);
    return {
      terraform,
      workDir: this.root,
      stages: ["init", "validate", "plan", "apply"],
      projects,
      runs
    };
  }

  preview(world) {
    const manifest = worldToManifest(world);
    const files = {
      "sandbox.yaml": stringifySandboxManifest(manifest),
      "main.tf": terraformForManifest(manifest, "sandbox.yaml")
    };
    return {
      projectId: projectId(world.id),
      worldId: world.id,
      worldName: world.name,
      sourceHash: sourceHash(files),
      files
    };
  }

  async prepare(world, options = {}) {
    if (!this.enabled) {
      const error = new Error("Terraform integration is disabled");
      error.statusCode = 503;
      throw error;
    }
    const requestedLock = options.runId || `prepare-${crypto.randomBytes(6).toString("hex")}`;
    const activeId = this.projectLocks.get(world.id);
    if (activeId && activeId !== options.runId) throw conflict(`Terraform run ${activeId} is already active for ${world.name}`);
    const ownsLock = !activeId;
    if (ownsLock) this.projectLocks.set(world.id, requestedLock);
    try {
      const preview = this.preview(world);
      const directory = this.projectDirectory(world.id);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await writeTerraformBundle(worldToManifest(world), directory);
      const previous = await readJson(path.join(directory, "project.json"), {});
      let plan = await readJson(path.join(directory, "plan.json"), null);
      if (previous.sourceHash && previous.sourceHash !== preview.sourceHash) {
        await Promise.all([
          fs.rm(path.join(directory, "terraform.tfplan"), { force: true }),
          fs.rm(path.join(directory, "plan.json"), { force: true })
        ]);
        plan = null;
      }
      const project = {
        version: 1,
        projectId: preview.projectId,
        worldId: world.id,
        worldName: world.name,
        sourceHash: preview.sourceHash,
        createdAt: previous.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        statePresent: await fileExists(path.join(directory, "terraform.tfstate")),
        plan
      };
      await writeJsonAtomic(path.join(directory, "project.json"), project);
      return { ...project, directory, files: preview.files };
    } finally {
      if (ownsLock && this.projectLocks.get(world.id) === requestedLock) this.projectLocks.delete(world.id);
    }
  }

  async listProjects(worlds = []) {
    const byId = new Map(worlds.map((world) => [world.id, world]));
    const entries = await fs.readdir(this.projectsRoot, { withFileTypes: true }).catch(() => []);
    const projects = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(this.projectsRoot, entry.name);
      const metadata = await readJson(path.join(directory, "project.json"), null);
      if (!metadata?.worldId) continue;
      projects.push({
        ...metadata,
        worldExists: byId.has(metadata.worldId),
        statePresent: await fileExists(path.join(directory, "terraform.tfstate")),
        lockPresent: await fileExists(path.join(directory, ".terraform.lock.hcl")),
        plan: await readJson(path.join(directory, "plan.json"), null)
      });
    }
    return projects.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  async startRun(world, action, options = {}) {
    if (this.closed) throw conflict("Terraform manager is shutting down");
    if (!RUN_ACTIONS.has(action)) throw badRequest(`unsupported Terraform action: ${action}`);
    const activeId = this.projectLocks.get(world.id);
    if (activeId) throw conflict(`Terraform run ${activeId} is already active for ${world.name}`);
    const reservation = `pending-${crypto.randomBytes(6).toString("hex")}`;
    this.projectLocks.set(world.id, reservation);
    let id = null;
    try {
      const availability = await this.availability();
      if (!availability.installed) {
        const error = new Error(`Terraform is unavailable: ${availability.error || availability.binary}`);
        error.statusCode = 503;
        throw error;
      }
      if (action === "destroy" && options.confirmation !== world.name) {
        throw badRequest(`confirmation must exactly match ${world.name}`);
      }
      if (action === "apply" || action === "destroy") await this.assertPlanned(world, action === "destroy" ? "destroy" : "apply");

      id = `tfr-${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
      const job = {
        version: 1,
        id,
        projectId: projectId(world.id),
        worldId: world.id,
        worldName: world.name,
        action,
        status: "queued",
        stage: "queued",
        subject: options.subject || null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        error: null,
        exitCode: null,
        logFile: path.join(this.runsRoot, `${id}.log`),
        logBytes: 0,
        logTask: Promise.resolve(),
        child: null,
        cancelRequested: false
      };
      this.runs.set(id, job);
      this.projectLocks.set(world.id, id);
      await this.persistJob(job);
      const publicJob = await this.publicJob(job);
      queueMicrotask(() => this.executeRun(job, world).catch(() => {}));
      return publicJob;
    } catch (error) {
      if (this.projectLocks.get(world.id) === reservation || this.projectLocks.get(world.id) === id) {
        this.projectLocks.delete(world.id);
      }
      if (id) this.runs.delete(id);
      throw error;
    }
  }

  async getRun(id) {
    const job = this.runs.get(id);
    if (!job) {
      const error = new Error("Terraform run not found");
      error.statusCode = 404;
      throw error;
    }
    return this.publicJob(job);
  }

  async cancelRun(id) {
    const job = this.runs.get(id);
    if (!job) {
      const error = new Error("Terraform run not found");
      error.statusCode = 404;
      throw error;
    }
    if (!ACTIVE_STATUSES.has(job.status)) return this.publicJob(job);
    job.cancelRequested = true;
    job.status = "canceling";
    await this.appendLog(job, `\n[${new Date().toISOString()}] cancellation requested\n`);
    if (job.child) job.child.kill("SIGINT");
    await this.persistJob(job);
    return this.publicJob(job);
  }

  async assertPlanned(world, kind) {
    const directory = this.projectDirectory(world.id);
    const [project, plan] = await Promise.all([
      readJson(path.join(directory, "project.json"), null),
      readJson(path.join(directory, "plan.json"), null)
    ]);
    const preview = this.preview(world);
    if (!project || !plan || !await fileExists(path.join(directory, "terraform.tfplan"))) {
      throw conflict(`run a Terraform ${kind === "destroy" ? "destroy plan" : "plan"} first`);
    }
    if (plan.kind !== kind) throw conflict(`the saved Terraform plan is for ${plan.kind}, not ${kind}`);
    if (project.sourceHash !== preview.sourceHash || plan.sourceHash !== preview.sourceHash) {
      throw conflict("the sandbox definition changed after the saved Terraform plan; create a new plan");
    }
  }

  async executeRun(job, world) {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    await this.persistJob(job);
    try {
      if (job.action === "apply" || job.action === "destroy") {
        await this.assertPlanned(world, job.action === "destroy" ? "destroy" : "apply");
      }
      if (["validate", "plan", "destroy-plan"].includes(job.action)) await this.prepare(world, { runId: job.id });
      const directory = this.projectDirectory(world.id);
      if (["validate", "plan", "destroy-plan"].includes(job.action)) {
        await this.runCommand(job, "init", ["init", "-no-color", "-input=false"], directory);
        await this.runCommand(job, "validate", ["validate", "-no-color"], directory);
      }
      if (job.action === "plan" || job.action === "destroy-plan") {
        const destroy = job.action === "destroy-plan";
        const args = ["plan", "-no-color", "-input=false", "-detailed-exitcode", "-out=terraform.tfplan"];
        if (destroy) args.splice(1, 0, "-destroy");
        const result = await this.runCommand(job, "plan", args, directory, { allowExitCodes: [0, 2] });
        await this.runCommand(job, "show", ["show", "-no-color", "terraform.tfplan"], directory);
        const metadata = await readJson(path.join(directory, "project.json"), {});
        metadata.plan = {
          kind: destroy ? "destroy" : "apply",
          sourceHash: metadata.sourceHash,
          runId: job.id,
          hasChanges: result.code === 2,
          createdAt: new Date().toISOString()
        };
        metadata.updatedAt = new Date().toISOString();
        await Promise.all([
          writeJsonAtomic(path.join(directory, "plan.json"), metadata.plan),
          writeJsonAtomic(path.join(directory, "project.json"), metadata)
        ]);
      }
      if (job.action === "apply" || job.action === "destroy") {
        await this.runCommand(job, "apply", ["apply", "-no-color", "-input=false", "-auto-approve", "terraform.tfplan"], directory);
        await fs.rm(path.join(directory, "plan.json"), { force: true });
        const metadata = await readJson(path.join(directory, "project.json"), {});
        metadata.plan = null;
        metadata.statePresent = await fileExists(path.join(directory, "terraform.tfstate"));
        metadata.updatedAt = new Date().toISOString();
        await writeJsonAtomic(path.join(directory, "project.json"), metadata);
      }
      job.status = "succeeded";
      job.stage = "complete";
      job.exitCode = 0;
    } catch (error) {
      job.status = job.cancelRequested ? "canceled" : "failed";
      job.stage = job.cancelRequested ? "canceled" : job.stage;
      job.error = commandError(error);
      job.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : null;
      await this.appendLog(job, `\n[${new Date().toISOString()}] ${job.status}: ${job.error}\n`);
    } finally {
      job.child = null;
      job.finishedAt = new Date().toISOString();
      this.projectLocks.delete(world.id);
      await job.logTask;
      await this.persistJob(job);
    }
  }

  async runCommand(job, stage, args, directory, options = {}) {
    if (job.cancelRequested) throw new Error("Terraform run canceled");
    job.stage = stage;
    await this.appendLog(job, `\n[${new Date().toISOString()}] terraform ${args.join(" ")}\n`);
    await this.persistJob(job);
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, {
        cwd: directory,
        env: this.safeEnvironment(),
        stdio: ["ignore", "pipe", "pipe"]
      });
      job.child = child;
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      }, this.commandTimeoutMs);
      timeout.unref();
      child.stdout.on("data", (chunk) => void this.appendLog(job, chunk.toString("utf8")));
      child.stderr.on("data", (chunk) => void this.appendLog(job, chunk.toString("utf8")));
      child.once("error", (error) => {
        clearTimeout(timeout);
        job.child = null;
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        job.child = null;
        const allowed = options.allowExitCodes || [0];
        if (allowed.includes(code)) return resolve({ code, signal });
        const error = new Error(signal ? `terraform ${stage} terminated by ${signal}` : `terraform ${stage} exited with ${code}`);
        error.exitCode = code;
        reject(error);
      });
    });
  }

  safeEnvironment() {
    const keep = [
      "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR",
      "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"
    ];
    const env = {};
    for (const key of keep) if (process.env[key] != null) env[key] = process.env[key];
    env.TF_IN_AUTOMATION = "1";
    env.TF_INPUT = "0";
    env.TF_PLUGIN_CACHE_DIR = this.pluginCacheDir;
    env.TF_VAR_agctl = this.agctl;
    if (this.config.home) env.KAKURIZAI_HOME = this.config.home;
    if (this.config.configPath) env.KAKURIZAI_CONFIG = this.config.configPath;
    return env;
  }

  projectDirectory(worldId) {
    const directory = path.resolve(this.projectsRoot, projectId(worldId));
    if (path.dirname(directory) !== this.projectsRoot) throw badRequest("invalid Terraform project id");
    return directory;
  }

  async publicJob(job) {
    return {
      id: job.id,
      projectId: job.projectId,
      worldId: job.worldId,
      worldName: job.worldName,
      action: job.action,
      status: job.status,
      stage: job.stage,
      subject: job.subject,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      exitCode: job.exitCode,
      log: await tailFile(job.logFile, 256 * 1024)
    };
  }

  appendLog(job, text) {
    const input = String(text || "");
    job.logTask = (job.logTask || Promise.resolve()).then(async () => {
      if (job.logBytes >= this.maxLogBytes) return;
      const remaining = this.maxLogBytes - job.logBytes;
      const buffer = Buffer.from(input);
      const output = buffer.subarray(0, remaining);
      await fs.appendFile(job.logFile, output, { mode: 0o600 });
      job.logBytes += output.length;
      if (output.length < buffer.length) {
        const marker = Buffer.from("\n[log truncated]\n");
        await fs.appendFile(job.logFile, marker, { mode: 0o600 });
        job.logBytes = this.maxLogBytes;
      }
    });
    return job.logTask;
  }

  async persistJob(job) {
    const serializable = {
      version: 1,
      id: job.id,
      projectId: job.projectId,
      worldId: job.worldId,
      worldName: job.worldName,
      action: job.action,
      status: job.status,
      stage: job.stage,
      subject: job.subject,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      exitCode: job.exitCode,
      logFile: job.logFile
    };
    await writeJsonAtomic(path.join(this.runsRoot, `${job.id}.json`), serializable);
  }
}

function projectId(worldId) {
  const input = String(worldId || "");
  const slug = input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  if (!slug) throw badRequest("world id is required");
  return slug;
}

function sourceHash(files) {
  return crypto.createHash("sha256")
    .update(files["sandbox.yaml"])
    .update("\0")
    .update(files["main.tf"])
    .digest("hex");
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
}

async function tailFile(file, maxBytes) {
  try {
    const handle = await fs.open(file, "r");
    try {
      const stat = await handle.stat();
      const length = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
      return `${stat.size > maxBytes ? "[earlier log omitted]\n" : ""}${buffer.toString("utf8")}`;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function commandError(error) {
  const stderr = String(error?.stderr || "").trim();
  return stderr || error?.message || String(error);
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function conflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}
