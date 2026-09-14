// @ts-nocheck
import fs from "node:fs/promises";
import path from "node:path";

const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const ROLE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;
const SSH_KEY_TYPES = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com"
]);
const MAX_SSH_PUBLIC_KEYS = 32;
const MAX_SSH_PUBLIC_KEYS_LENGTH = 64 * 1024;

export class AccountStore {
  constructor(config) {
    this.config = config;
    this.accounts = new Map();
    this.file = config.auth?.accountFile || path.join(config.home || config.storeDir || process.cwd(), "auth", "accounts.json");
    this.saveTask = Promise.resolve();
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8"));
      for (const account of Array.isArray(raw.accounts) ? raw.accounts : []) {
        if (account?.subject) this.accounts.set(account.subject, normalizeStoredAccount(account));
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async touch(user, options = {}) {
    const now = new Date().toISOString();
    const claims = user?.claims || {};
    const subject = cleanRequired(user?.subject, "account subject", 256);
    const existing = this.accounts.get(subject);
    const identity = identityFromClaims(user);
    const shouldPersistSeen = !existing || Date.now() - Date.parse(existing.lastSeenAt || 0) >= 60_000 || options.force;
    const account = normalizeStoredAccount({
      subject,
      username: existing?.username ?? identity.username,
      name: existing?.name ?? identity.name,
      email: identity.email || existing?.email || "",
      avatarUrl: existing?.avatarUrl ?? identity.avatarUrl,
      provider: user?.provider || existing?.provider || "unknown",
      loginType: user?.provider || existing?.loginType || "unknown",
      status: existing?.status || "active",
      roles: existing?.roles || [],
      identityRoles: identity.roles,
      sshPublicKeys: existing?.sshPublicKeys || [],
      createdAt: existing?.createdAt || now,
      updatedAt: existing?.updatedAt || now,
      lastSeenAt: shouldPersistSeen ? now : existing?.lastSeenAt || now
    });
    this.accounts.set(subject, account);
    if (!existing || shouldPersistSeen || identityChanged(existing, account)) await this.save();
    return account;
  }

  get(subject) {
    return this.accounts.get(subject) || null;
  }

  list() {
    return [...this.accounts.values()]
      .map((account) => ({
        ...account,
        roles: [...account.roles],
        identityRoles: [...account.identityRoles],
        sshPublicKeys: [...account.sshPublicKeys]
      }))
      .sort((left, right) => String(right.lastSeenAt).localeCompare(String(left.lastSeenAt)));
  }

  async updateProfile(subject, input = {}) {
    const current = this.require(subject);
    const next = { ...current };
    if (Object.hasOwn(input, "username")) {
      const username = cleanRequired(input.username, "username", 64);
      if (!USERNAME_PATTERN.test(username)) throw badRequest("username must contain only letters, numbers, dots, dashes, or underscores");
      next.username = username;
    }
    if (Object.hasOwn(input, "name")) next.name = cleanOptional(input.name, "name", 128);
    if (Object.hasOwn(input, "avatarUrl")) next.avatarUrl = cleanAvatarUrl(input.avatarUrl);
    if (Object.hasOwn(input, "sshPublicKeys")) next.sshPublicKeys = normalizeSshPublicKeys(input.sshPublicKeys);
    next.updatedAt = new Date().toISOString();
    this.accounts.set(subject, normalizeStoredAccount(next));
    await this.save();
    return this.get(subject);
  }

  async updateAdmin(subject, input = {}, options = {}) {
    const current = this.require(subject);
    const next = { ...current };
    if (Object.hasOwn(input, "status")) {
      if (!new Set(["active", "suspended"]).has(input.status)) throw badRequest("status must be active or suspended");
      if (subject === options.currentSubject && input.status === "suspended") throw badRequest("you cannot suspend your own account");
      next.status = input.status;
    }
    if (Object.hasOwn(input, "roles")) {
      if (!Array.isArray(input.roles)) throw badRequest("roles must be an array");
      const knownRoles = options.knownRoles ? new Set(options.knownRoles) : null;
      next.roles = [...new Set(input.roles.map((role) => cleanRequired(role, "role", 64)))];
      for (const role of next.roles) {
        if (!ROLE_PATTERN.test(role)) throw badRequest(`invalid role: ${role}`);
        if (knownRoles && !knownRoles.has(role)) throw badRequest(`unknown role: ${role}`);
      }
    }
    next.updatedAt = new Date().toISOString();
    this.accounts.set(subject, normalizeStoredAccount(next));
    await this.save();
    return this.get(subject);
  }

  require(subject) {
    const account = this.get(subject);
    if (account) return account;
    const error = new Error("account not found");
    error.statusCode = 404;
    throw error;
  }

  save() {
    this.saveTask = this.saveTask.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      const accounts = this.list();
      await fs.writeFile(tmp, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(tmp, this.file);
    });
    return this.saveTask;
  }
}

export function publicAccount(account, options = {}) {
  if (!account) return null;
  return {
    subject: account.subject,
    username: account.username,
    name: account.name,
    email: account.email,
    avatarUrl: account.avatarUrl,
    provider: account.provider,
    loginType: account.loginType,
    status: account.status,
    roles: options.roles || account.roles || [],
    assignedRoles: account.roles || [],
    sshPublicKeys: account.sshPublicKeys || [],
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastSeenAt: account.lastSeenAt
  };
}

function identityFromClaims(user) {
  const claims = user?.claims || {};
  const email = cleanClaim(claims.email, 320);
  const username = cleanClaim(
    claims.preferred_username || claims.github_username || claims.login || claims.nickname || email.split("@")[0] || user?.subject,
    64
  ) || String(user?.subject || "user").slice(0, 64);
  return {
    username: USERNAME_PATTERN.test(username) ? username : safeUsername(username),
    name: cleanClaim(claims.name || claims.full_name || claims.given_name || username, 128),
    email,
    avatarUrl: safeClaimUrl(claims.picture || claims.avatar_url),
    roles: [...new Set([
      ...arrayClaim(claims.roles),
      ...arrayClaim(claims.role),
      ...arrayClaim(claims.groups)
    ].filter((role) => ROLE_PATTERN.test(role)))]
  };
}

function normalizeStoredAccount(account) {
  return {
    subject: String(account.subject),
    username: cleanClaim(account.username, 64) || safeUsername(account.subject),
    name: cleanClaim(account.name, 128),
    email: cleanClaim(account.email, 320),
    avatarUrl: safeClaimUrl(account.avatarUrl),
    provider: cleanClaim(account.provider, 64) || "unknown",
    loginType: cleanClaim(account.loginType, 64) || "unknown",
    status: account.status === "suspended" ? "suspended" : "active",
    roles: [...new Set(arrayClaim(account.roles).filter((role) => ROLE_PATTERN.test(role)))],
    identityRoles: [...new Set(arrayClaim(account.identityRoles).filter((role) => ROLE_PATTERN.test(role)))],
    sshPublicKeys: safeStoredSshPublicKeys(account.sshPublicKeys),
    createdAt: validDate(account.createdAt) || new Date().toISOString(),
    updatedAt: validDate(account.updatedAt) || validDate(account.createdAt) || new Date().toISOString(),
    lastSeenAt: validDate(account.lastSeenAt) || new Date().toISOString()
  };
}

export function normalizeSshPublicKeys(value) {
  if (value != null && !Array.isArray(value) && typeof value !== "string") {
    throw badRequest("SSH public keys must be a string or an array");
  }
  const source = Array.isArray(value) ? value.join("\n") : String(value || "");
  if (source.length > MAX_SSH_PUBLIC_KEYS_LENGTH) {
    throw badRequest(`SSH public keys must be at most ${MAX_SSH_PUBLIC_KEYS_LENGTH} characters`);
  }
  const keys = [];
  const seen = new Set();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2 || !SSH_KEY_TYPES.has(parts[0])) {
      throw badRequest("each SSH public key must begin with a supported OpenSSH key type");
    }
    const [type, encoded] = parts;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw badRequest("SSH public key data is not valid base64");
    let blob;
    try {
      blob = Buffer.from(encoded, "base64");
    } catch {
      throw badRequest("SSH public key data is not valid base64");
    }
    if (blob.length < 8 || blob.length > 16 * 1024) throw badRequest("SSH public key data is invalid");
    const embeddedLength = blob.readUInt32BE(0);
    const embeddedType = blob.subarray(4, 4 + embeddedLength).toString("utf8");
    if (embeddedLength < 1 || 4 + embeddedLength > blob.length || embeddedType !== type) {
      throw badRequest("SSH public key type does not match its encoded data");
    }
    const identity = `${type} ${encoded}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    keys.push(parts.join(" "));
    if (keys.length > MAX_SSH_PUBLIC_KEYS) throw badRequest(`at most ${MAX_SSH_PUBLIC_KEYS} SSH public keys are allowed`);
  }
  return keys;
}

function safeStoredSshPublicKeys(value) {
  try {
    return normalizeSshPublicKeys(Array.isArray(value) ? value : []);
  } catch {
    return [];
  }
}

function identityChanged(left, right) {
  return left.email !== right.email || left.provider !== right.provider || left.loginType !== right.loginType ||
    JSON.stringify(left.identityRoles || []) !== JSON.stringify(right.identityRoles || []);
}

function cleanRequired(value, label, maxLength) {
  const result = String(value ?? "").trim();
  if (!result) throw badRequest(`${label} is required`);
  if (result.length > maxLength) throw badRequest(`${label} must be at most ${maxLength} characters`);
  return result;
}

function cleanOptional(value, label, maxLength) {
  const result = String(value ?? "").trim();
  if (result.length > maxLength) throw badRequest(`${label} must be at most ${maxLength} characters`);
  return result;
}

function cleanAvatarUrl(value) {
  const result = cleanOptional(value, "avatar URL", 2048);
  if (!result) return "";
  try {
    const url = new URL(result);
    if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error();
    return url.toString();
  } catch {
    throw badRequest("avatar URL must be an http or https URL");
  }
}

function safeClaimUrl(value) {
  try {
    return value ? cleanAvatarUrl(value) : "";
  } catch {
    return "";
  }
}

function cleanClaim(value, maxLength) {
  if (value == null || typeof value === "object") return "";
  return String(value).trim().slice(0, maxLength);
}

function safeUsername(value) {
  const cleaned = String(value || "user").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[^a-zA-Z0-9]+/, "").slice(0, 64);
  return cleaned || "user";
}

function arrayClaim(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(arrayClaim);
  return String(value).split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
}

function validDate(value) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
