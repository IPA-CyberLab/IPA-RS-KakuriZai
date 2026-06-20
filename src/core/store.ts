// @ts-nocheck
import fs from "node:fs/promises";
import path from "node:path";
import {
  copyTreeEntry,
  directorySize,
  ensureDir,
  nowIso,
  pathExists,
  randomId,
  removePath,
  resolveInside,
  slugify,
  walkFiles,
  writeJsonAtomic
} from "./fs.js";
import { normalizeHostMounts, primaryMount } from "./mounts.js";

export class WorldStore {
  constructor(config) {
    this.config = config;
    this.root = path.join(config.storeDir, "worlds");
  }

  async init() {
    await ensureDir(this.root);
  }

  worldDir(id) {
    return path.join(this.root, id);
  }

  metadataPath(id) {
    return path.join(this.worldDir(id), "world.json");
  }

  async create(input) {
    await this.init();
    const id = `${slugify(input.name)}-${randomId().slice(2)}`;
    const dir = this.worldDir(id);
    const paths = {
      metadata: this.metadataPath(id),
      source: path.join(dir, "source"),
      upper: path.join(dir, "upper"),
      workdir: path.join(dir, "work"),
      whiteouts: path.join(dir, "whiteouts"),
      logs: path.join(dir, "logs"),
      exports: path.join(dir, "exports")
    };
    await Promise.all(Object.values(paths).filter((value) => value !== paths.metadata).map(ensureDir));
    const mountConfig = normalizeHostMounts({
      hostMount: input.backendConfig?.hostMount,
      sourcePath: input.sourcePath,
      mountMode: input.backendConfig?.mountMode,
      mounts: input.backendConfig?.mounts
    }, {
      workspacePath: this.config.cube?.workspacePath
    });
    const hostMount = mountConfig.length > 0;
    const sourcePath = hostMount ? primaryMount(mountConfig).sourcePath : paths.source;
    for (const mount of mountConfig) {
      const sourceStat = await fs.stat(mount.sourcePath);
      if (!sourceStat.isDirectory()) {
        throw new Error(`source path is not a directory: ${mount.sourcePath}`);
      }
    }
    const mountModes = [...new Set(mountConfig.map((mount) => mount.mode))];
    const now = nowIso();
    const world = {
      version: 1,
      id,
      name: input.name,
      status: input.status || "created",
      sourcePath,
      backend: input.backend,
      createdAt: now,
      updatedAt: now,
      paths,
      sandbox: input.sandbox || null,
      sessions: [],
      apply: {
        state: "clean",
        lastAppliedAt: null,
        lastExportPath: null
      },
      labels: input.labels || {},
      backendConfig: {
        ...(input.backendConfig || {}),
        hostMount,
        mountMode: hostMount ? (mountModes.length === 1 ? mountModes[0] : "mixed") : "none",
        mounts: mountConfig
      }
    };
    await this.save(world);
    return world;
  }

  async save(world) {
    world.updatedAt = nowIso();
    await writeJsonAtomic(this.metadataPath(world.id), world);
    return world;
  }

  async list() {
    await this.init();
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const worlds = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = this.metadataPath(entry.name);
      try {
        const world = JSON.parse(await fs.readFile(file, "utf8"));
        world.diskUsage = {
          upperBytes: await directorySize(world.paths.upper),
          logsBytes: await directorySize(world.paths.logs)
        };
        worlds.push(world);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return worlds.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(ref, options = {}) {
    const worlds = await this.list();
    const byId = worlds.find((candidate) => candidate.id === ref);
    if (byId) return byId;
    if (options.exactId) throw new Error(`world id not found: ${ref}`);
    const byName = worlds.filter((candidate) => candidate.name === ref);
    if (byName.length > 1) {
      throw new Error(`ambiguous world name: ${ref}; use a world id`);
    }
    if (byName.length === 1) return byName[0];
    throw new Error(`world not found: ${ref}`);
  }

  async remove(ref, options = {}) {
    const world = await this.get(ref, options);
    await removePath(this.worldDir(world.id));
    return world;
  }

  async changedPaths(ref) {
    const world = typeof ref === "string" ? await this.get(ref) : ref;
    const mounts = structuredMountsForWorld(world, this.config);
    if (mounts.length) {
      const changed = [];
      for (const mount of mounts) {
        if (mount.mode !== "agctl-overlay") continue;
        await collectUpperChanges({
          changed,
          upperRoot: path.join(world.paths.upper, mount.id),
          whiteoutsRoot: path.join(world.paths.whiteouts, mount.id),
          mount
        });
      }
      return dedupeChanges(changed);
    }
    const changed = [];
    await collectUpperChanges({
      changed,
      upperRoot: world.paths.upper,
      whiteoutsRoot: world.paths.whiteouts,
      mount: { id: null, name: "workspace", sourcePath: world.sourcePath }
    });
    return dedupeChanges(changed);
  }

  async markWhiteout(ref, relativePath) {
    const world = typeof ref === "string" ? await this.get(ref) : ref;
    const mount = structuredMountsForWorld(world, this.config)[0] || null;
    const whiteoutsRoot = mount ? path.join(world.paths.whiteouts, mount.id) : world.paths.whiteouts;
    const marker = resolveInside(whiteoutsRoot, relativePath);
    await ensureDir(path.dirname(marker));
    await fs.writeFile(marker, "", "utf8");
    world.apply.state = "dirty";
    await this.save(world);
    return marker;
  }

  async apply(ref, options = {}) {
    const world = typeof ref === "string" ? await this.get(ref) : ref;
    const changes = await this.changedPaths(world);
    if (options.dryRun) return { world, changes, applied: false };
    for (const change of changes) {
      const target = resolveInside(change.sourcePath || world.sourcePath, change.path);
      if (change.action === "delete") {
        await fs.rm(target, { recursive: true, force: true });
      }
    }
    for (const change of changes) {
      if (change.action !== "upsert") continue;
      const source = resolveInside(change.upperRoot || world.paths.upper, change.path);
      const target = resolveInside(change.sourcePath || world.sourcePath, change.path);
      await copyTreeEntry(source, target);
    }
    world.apply.state = "clean";
    world.apply.lastAppliedAt = nowIso();
    await this.save(world);
    return { world, changes, applied: true };
  }
}

async function collectUpperChanges({ changed, upperRoot, whiteoutsRoot, mount }) {
  for await (const entry of walkFiles(upperRoot)) {
    const unionfsWhiteout = unionfsFuseWhiteoutTarget(entry.relativePath);
    if (unionfsWhiteout) {
      changed.push(changeForMount("delete", unionfsWhiteout, "unionfs-fuse-whiteout", mount, upperRoot));
      continue;
    }
    if (isUnionfsFuseControlPath(entry.relativePath)) continue;
    if (entry.type === "directory") continue;
    const overlayWhiteout = overlayWhiteoutTarget(entry.relativePath);
    if (overlayWhiteout) {
      changed.push(changeForMount("delete", overlayWhiteout, "overlay-whiteout", mount, upperRoot));
      continue;
    }
    changed.push(changeForMount("upsert", entry.relativePath, "upper", mount, upperRoot));
  }
  for await (const entry of walkFiles(whiteoutsRoot)) {
    if (entry.type === "directory") continue;
    changed.push(changeForMount("delete", entry.relativePath, "whiteouts", mount, upperRoot));
  }
}

function changeForMount(action, relativePath, source, mount, upperRoot) {
  return {
    action,
    path: relativePath,
    source,
    mount: mount.name,
    mountId: mount.id,
    sourcePath: mount.sourcePath,
    upperRoot
  };
}

function structuredMountsForWorld(world, config) {
  if (!Array.isArray(world.backendConfig?.mounts)) return [];
  return normalizeHostMounts({
    hostMount: world.backendConfig?.hostMount,
    sourcePath: world.sourcePath,
    mountMode: world.backendConfig?.mountMode,
    mounts: world.backendConfig.mounts
  }, {
    workspacePath: config.cube?.workspacePath
  });
}

function overlayWhiteoutTarget(relativePath) {
  const parts = relativePath.split(path.sep);
  const leaf = parts.at(-1);
  if (!leaf?.startsWith(".wh.")) return null;
  parts[parts.length - 1] = leaf.slice(4);
  return parts.join(path.sep);
}

function unionfsFuseWhiteoutTarget(relativePath) {
  const prefix = `.unionfs-fuse${path.sep}`;
  if (!relativePath.startsWith(prefix)) return null;
  const target = relativePath.slice(prefix.length);
  const parts = target.split(path.sep);
  const leaf = parts.at(-1);
  if (!leaf?.endsWith("_HIDDEN~")) return null;
  parts[parts.length - 1] = leaf.slice(0, -"_HIDDEN~".length);
  return parts.join(path.sep);
}

function isUnionfsFuseControlPath(relativePath) {
  return relativePath === ".unionfs-fuse" || relativePath.startsWith(`.unionfs-fuse${path.sep}`);
}

function dedupeChanges(changes) {
  const map = new Map();
  for (const change of changes) {
    map.set(`${change.mountId || "legacy"}:${change.action}:${change.path}`, change);
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}
