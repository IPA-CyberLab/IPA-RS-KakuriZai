// @ts-nocheck
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultHome, ensureDir, pathExists, readJson, writeJsonAtomic } from "./fs.js";

export function defaultBackendForPlatform(platform = process.platform) {
  if (platform === "darwin") return "apfs-clone";
  if (platform === "win32") return "windows-block-clone";
  if (platform === "linux") return "linux-native";
  return "cube-sandbox-overlay";
}

export function defaultConfig(home = defaultHome()) {
  return {
    version: 1,
    home,
    storeDir: path.join(home, "store"),
    defaultBackend: defaultBackendForPlatform(),
    studio: {
      host: process.env.KAKURIZAI_HOST || "127.0.0.1",
      port: Number(process.env.KAKURIZAI_PORT || 38476),
      publicUrl: process.env.KAKURIZAI_STUDIO_PUBLIC_URL || null,
      secureCookies: process.env.KAKURIZAI_SECURE_COOKIES === "true",
      trustProxy: process.env.KAKURIZAI_TRUST_PROXY === "true",
      trustedProxies: [],
      allowedHosts: [],
      trustedOrigins: [],
      ipAllowlist: [],
      ipDenylist: [],
      rateLimit: {
        enabled: true,
        windowSeconds: 60,
        maxRequests: 600
      },
      tls: {
        certFile: process.env.KAKURIZAI_TLS_CERT || null,
        keyFile: process.env.KAKURIZAI_TLS_KEY || null
      }
    },
    auth: {
      provider: process.env.KAKURIZAI_AUTH_PROVIDER || "self",
      issuer: "kakurizai",
      audience: "kakurizai-studio",
      secretFile: path.join(home, "auth", "self-secret"),
      sessionTtlSeconds: 8 * 60 * 60,
      maxLoginAttempts: 12,
      persistSessions: true,
      sessionFile: path.join(home, "auth", "studio-sessions.json"),
      rbac: {
        enabled: true,
        defaultRole: null,
        users: {},
        roles: {}
      },
      totp: {
        enabled: false,
        issuer: "KakuriZai",
        users: {}
      },
      mfa: {
        required: false
      }
    },
    audit: {
      enabled: true,
      logReads: false,
      file: path.join(home, "audit", "studio.jsonl"),
      chain: true
    },
    security: {
      enforceRemoteAccess: true,
      allowInsecureRemote: false
    },
    cube: {
      mode: process.env.KAKURIZAI_CUBE_MODE || "auto",
      cubecli: process.env.KAKURIZAI_CUBECLI || "cubecli",
      mastercli: process.env.KAKURIZAI_CUBEMASTERCLI || "cubemastercli",
      apiBaseUrl: process.env.KAKURIZAI_CUBE_API || null,
      template: process.env.KAKURIZAI_CUBE_TEMPLATE || "kakurizai-base",
      namespace: process.env.KAKURIZAI_CUBE_NAMESPACE || "kakurizai",
      workspacePath: "/workspace",
      bootstrapTools: {
        enabled: process.env.KAKURIZAI_CUBE_BOOTSTRAP_TOOLS !== "false",
        packages: [
          "bash",
          "ca-certificates",
          "curl",
          "dnsutils",
          "fuse-overlayfs",
          "fuse3",
          "git",
          "iproute2",
          "iputils-ping",
          "less",
          "nano",
          "ncurses-base",
          "ncurses-bin",
          "ncurses-term",
          "net-tools",
          "procps",
          "sudo",
          "tmux",
          "unionfs-fuse",
          "vim-tiny"
        ],
        commands: ["bash", "curl", "git", "ip", "nano", "ping", "ps", "sudo", "tmux"]
      }
    },
    isolatedAgent: {
      agentctl: process.env.AGCTL_AGENTCTL || process.env.AGENTCTL || "agentctl",
      sourceTree: "vendor/IPA-RS-IsolatedAgent"
    }
  };
}

export function mergeConfig(base, override) {
  const result = { ...base, ...override };
  result.studio = { ...base.studio, ...(override?.studio || {}) };
  result.studio.tls = { ...base.studio?.tls, ...(override?.studio?.tls || {}) };
  result.studio.rateLimit = { ...base.studio?.rateLimit, ...(override?.studio?.rateLimit || {}) };
  result.auth = { ...base.auth, ...(override?.auth || {}) };
  result.auth.rbac = { ...base.auth?.rbac, ...(override?.auth?.rbac || {}) };
  result.auth.rbac.users = { ...base.auth?.rbac?.users, ...(override?.auth?.rbac?.users || {}) };
  result.auth.rbac.roles = { ...base.auth?.rbac?.roles, ...(override?.auth?.rbac?.roles || {}) };
  result.auth.totp = { ...base.auth?.totp, ...(override?.auth?.totp || {}) };
  result.auth.totp.users = { ...base.auth?.totp?.users, ...(override?.auth?.totp?.users || {}) };
  result.auth.mfa = { ...base.auth?.mfa, ...(override?.auth?.mfa || {}) };
  result.auth.users = { ...base.auth?.users, ...(override?.auth?.users || {}) };
  result.audit = { ...base.audit, ...(override?.audit || {}) };
  result.security = { ...base.security, ...(override?.security || {}) };
  result.cube = { ...base.cube, ...(override?.cube || {}) };
  result.isolatedAgent = { ...base.isolatedAgent, ...(override?.isolatedAgent || {}) };
  return result;
}

export async function loadConfig(options = {}) {
  const home = options.home || defaultHome();
  const base = defaultConfig(home);
  const configPath = options.configPath || process.env.KAKURIZAI_CONFIG || path.join(home, "config.json");
  const fileConfig = await readJson(configPath, {});
  const config = mergeConfig(base, fileConfig);
  config.home = home;
  config.configPath = configPath;
  config.storeDir = path.resolve(config.storeDir || path.join(home, "store"));
  await ensureDir(config.storeDir);
  await resolveAuthSecret(config, options);
  return config;
}

async function resolveAuthSecret(config, options) {
  if (config.auth.provider !== "self") return;
  if (process.env.KAKURIZAI_AUTH_SECRET) {
    config.auth.secret = process.env.KAKURIZAI_AUTH_SECRET;
    return;
  }
  if (config.auth.secret) return;
  const secretFile = config.auth.secretFile || path.join(config.home, "auth", "self-secret");
  if (await pathExists(secretFile)) {
    config.auth.secret = (await fs.readFile(secretFile, "utf8")).trim();
    return;
  }
  if (options.createSecrets === false) {
    config.auth.secret = "test-only-secret";
    return;
  }
  await ensureDir(path.dirname(secretFile));
  const secret = crypto.randomBytes(32).toString("base64url");
  await fs.writeFile(secretFile, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  config.auth.secret = secret;
}

export async function initConfigFile(options = {}) {
  const home = options.home || defaultHome();
  const configPath = options.configPath || process.env.KAKURIZAI_CONFIG || path.join(home, "config.json");
  if (await pathExists(configPath)) return { configPath, created: false };
  const config = defaultConfig(home);
  await writeJsonAtomic(configPath, config);
  return { configPath, created: true };
}

export function normalizeAuthConfig(auth) {
  if (!auth || auth.provider === "none") return { provider: "none" };
  if (auth.provider === "local") return auth;
  if (auth.provider === "self") return auth;
  if (auth.provider === "auth0") {
    const domain = required(auth.domain, "auth.domain");
    const issuer = auth.issuer || `https://${domain.replace(/^https?:\/\//, "").replace(/\/$/, "")}/`;
    return {
      provider: "oidc",
      providerName: "auth0",
      label: "Auth0",
      issuer,
      audience: required(auth.audience, "auth.audience"),
      jwksUri: auth.jwksUri || `${issuer}.well-known/jwks.json`
    };
  }
  if (auth.provider === "cognito") {
    const region = required(auth.region, "auth.region");
    const userPoolId = required(auth.userPoolId, "auth.userPoolId");
    const issuer = auth.issuer || `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
    return {
      provider: "oidc",
      providerName: "cognito",
      label: "AWS Cognito",
      issuer,
      audience: auth.clientId || auth.audience,
      jwksUri: auth.jwksUri || `${issuer}/.well-known/jwks.json`
    };
  }
  if (auth.provider === "oidc") return auth;
  throw new Error(`unsupported auth provider: ${auth.provider}`);
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function platformLabel(platform = os.platform()) {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return platform;
}
