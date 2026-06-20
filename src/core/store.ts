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
    const hostMount = input.backendConfig?.hostMount !== false && Boolean(input.sourcePath);
    const sourcePath = hostMount ? path.resolve(input.sourcePath) : paths.source;
    if (hostMount) {
      const sourceStat = await fs.stat(sourcePath);
      if (!sourceStat.isDirectory()) {
        throw new Error(`source path is not a directory: ${sourcePath}`);
      }
    }
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
      backendConfig: input.backendConfig || {}
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
    const changed = [];
    for await (const entry of walkFiles(world.paths.upper)) {
      const unionfsWhiteout = unionfsFuseWhiteoutTarget(entry.relativePath);
      if (unionfsWhiteout) {
        changed.push({ action: "delete", path: unionfsWhiteout, source: "unionfs-fuse-whiteout" });
        continue;
      }
      if (isUnionfsFuseControlPath(entry.relativePath)) continue;
      if (entry.type === "directory") continue;
      const overlayWhiteout = overlayWhiteoutTarget(entry.relativePath);
      if (overlayWhiteout) {
        changed.push({ action: "delete", path: overlayWhiteout, source: "overlay-whiteout" });
        continue;
      }
      changed.push({ action: "upsert", path: entry.relativePath, source: "upper" });
    }
    for await (const entry of walkFiles(world.paths.whiteouts)) {
      if (entry.type === "directory") continue;
      changed.push({ action: "delete", path: entry.relativePath, source: "whiteouts" });
    }
    return dedupeChanges(changed);
  }

  async markWhiteout(ref, relativePath) {
    const world = typeof ref === "string" ? await this.get(ref) : ref;
    const marker = resolveInside(world.paths.whiteouts, relativePath);
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
      const target = resolveInside(world.sourcePath, change.path);
      if (change.action === "delete") {
        await fs.rm(target, { recursive: true, force: true });
      }
    }
    for (const change of changes) {
      if (change.action !== "upsert") continue;
      const source = resolveInside(world.paths.upper, change.path);
      const target = resolveInside(world.sourcePath, change.path);
      await copyTreeEntry(source, target);
    }
    world.apply.state = "clean";
    world.apply.lastAppliedAt = nowIso();
    await this.save(world);
    return { world, changes, applied: true };
  }
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
    map.set(`${change.action}:${change.path}`, change);
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}
