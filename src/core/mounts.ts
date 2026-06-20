// @ts-nocheck
import path from "node:path";

export const DEFAULT_WORKSPACE_PATH = "/workspace";
export const DEFAULT_MOUNT_MODE = "agctl-overlay";
export const MOUNT_MODES = new Set(["agctl-overlay", "cubesandbox-readonly", "unsafe-rw", "none"]);

export function normalizeHostMounts(input = {}, options = {}) {
  if (input.hostMount === false) return [];
  const workspacePath = normalizeWorkspacePath(options.workspacePath || input.workspacePath || DEFAULT_WORKSPACE_PATH);
  const defaultMode = normalizeMountMode(input.mountMode || options.mountMode || DEFAULT_MOUNT_MODE);
  const rawMounts = Array.isArray(input.mounts) && input.mounts.length
    ? input.mounts
    : input.sourcePath
      ? [{ sourcePath: input.sourcePath, hostPath: input.sourcePath, name: input.mountName, mode: input.mountMode }]
      : [];
  const usedNames = new Set();
  const usedIds = new Set();
  return rawMounts.flatMap((mount, index) => {
    const sourcePath = String(mount.sourcePath || mount.hostPath || mount.path || "").trim();
    if (!sourcePath) return [];
    const mode = normalizeMountMode(mount.mode || defaultMode);
    if (mode === "none") return [];
    const baseName = mount.name || mount.id || path.basename(sourcePath) || `mount-${index + 1}`;
    const name = uniqueSlug(baseName, usedNames, `mount-${index + 1}`);
    const id = uniqueSlug(mount.id || name, usedIds, name);
    return [{
      id,
      name,
      sourcePath: path.resolve(sourcePath),
      mode,
      sandboxPath: normalizeSandboxPath(mount.sandboxPath || mount.containerPath, workspacePath, name)
    }];
  });
}

export function primaryMount(mounts = []) {
  return mounts[0] || null;
}

export function hasHostMounts(input = {}) {
  return normalizeHostMounts(input).length > 0;
}

export function normalizeMountMode(value) {
  const mode = String(value || DEFAULT_MOUNT_MODE).trim() || DEFAULT_MOUNT_MODE;
  if (!MOUNT_MODES.has(mode)) return DEFAULT_MOUNT_MODE;
  return mode;
}

export function normalizeWorkspacePath(value) {
  const normalized = path.posix.normalize(`/${String(value || DEFAULT_WORKSPACE_PATH).replace(/^\/+/, "")}`);
  return normalized === "/" ? DEFAULT_WORKSPACE_PATH : normalized;
}

export function normalizeSandboxPath(value, workspacePath = DEFAULT_WORKSPACE_PATH, mountName = "mount") {
  const workspace = normalizeWorkspacePath(workspacePath);
  const fallback = path.posix.join(workspace, slugMountName(mountName));
  if (!value) return fallback;
  const normalized = path.posix.normalize(`/${String(value).replace(/^\/+/, "")}`);
  if (normalized === workspace) return fallback;
  if (!normalized.startsWith(`${workspace}/`)) {
    throw new Error(`mount sandboxPath must be inside ${workspace}: ${value}`);
  }
  return normalized;
}

export function slugMountName(value, fallback = "mount") {
  return String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || fallback;
}

function uniqueSlug(value, used, fallback) {
  const base = slugMountName(value, fallback);
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}
