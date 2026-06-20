// @ts-nocheck
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";

export function nowIso() {
  return new Date().toISOString();
}

export function randomId(prefix = "w") {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}

export function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "world";
}

export function defaultHome() {
  return process.env.KAKURIZAI_HOME || path.join(os.homedir(), ".kakurizai");
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(file, value) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

export async function removePath(target) {
  await fs.rm(target, { recursive: true, force: true });
}

export function assertSafeRelativePath(relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`unsafe relative path: ${relativePath}`);
  }
  const normalized = path.normalize(relativePath);
  if (normalized === "." || normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error(`unsafe relative path: ${relativePath}`);
  }
  return normalized;
}

export function resolveInside(root, relativePath) {
  const safe = assertSafeRelativePath(relativePath);
  const resolved = path.resolve(root, safe);
  const relative = path.relative(path.resolve(root), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path escapes root: ${relativePath}`);
  }
  return resolved;
}

export async function* walkFiles(root, base = root) {
  if (!(await pathExists(root))) return;
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    const relativePath = path.relative(base, fullPath);
    if (entry.isDirectory()) {
      yield { type: "directory", path: fullPath, relativePath };
      yield* walkFiles(fullPath, base);
    } else if (entry.isSymbolicLink()) {
      yield { type: "symlink", path: fullPath, relativePath };
    } else if (entry.isFile()) {
      yield { type: "file", path: fullPath, relativePath };
    } else {
      yield { type: "special", path: fullPath, relativePath };
    }
  }
}

export async function copyTreeEntry(source, destination) {
  const stat = await fs.lstat(source);
  await ensureDir(path.dirname(destination));
  await fs.rm(destination, { recursive: true, force: true });
  if (stat.isSymbolicLink()) {
    const link = await fs.readlink(source);
    await fs.symlink(link, destination);
    return;
  }
  if (stat.isDirectory()) {
    await ensureDir(destination);
    return;
  }
  if (stat.isFile()) {
    await fs.copyFile(source, destination);
    await fs.chmod(destination, stat.mode);
    return;
  }
  throw new Error(`cannot apply special filesystem entry: ${source}`);
}

export async function directorySize(root) {
  let total = 0;
  if (!(await pathExists(root))) return total;
  for await (const entry of walkFiles(root)) {
    if (entry.type !== "file") continue;
    total += (await fs.lstat(entry.path)).size;
  }
  return total;
}

export function commandExists(command) {
  if (!command) return null;
  if (command.includes("/") || command.includes("\\")) {
    return commandExistsAtPath(command);
  }
  const pathEnv = process.env.PATH || "";
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const part of pathEnv.split(path.delimiter)) {
    for (const ext of extensions) {
      const candidate = path.join(part, `${command}${ext}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function commandExistsAtPath(command) {
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const ext of extensions) {
    const candidate = `${command}${ext}`;
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(candidate) {
  try {
    fssync.accessSync(candidate, process.platform === "win32" ? fssync.constants.F_OK : fssync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
