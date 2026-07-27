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
      provider: process.env.KAKURIZAI_AUTH_PROVIDER || "keycloak",
      issuer: process.env.KAKURIZAI_KEYCLOAK_ISSUER || null,
      serverUrl: process.env.KAKURIZAI_KEYCLOAK_URL || "http://127.0.0.1:8080",
      realm: process.env.KAKURIZAI_KEYCLOAK_REALM || "kakurizai",
      clientId: process.env.KAKURIZAI_KEYCLOAK_CLIENT_ID || "kakurizai-studio",
      clientSecret: process.env.KAKURIZAI_KEYCLOAK_CLIENT_SECRET || null,
      audience: process.env.KAKURIZAI_KEYCLOAK_AUDIENCE || process.env.KAKURIZAI_KEYCLOAK_CLIENT_ID || "kakurizai-studio",
      scopes: ["openid", "profile", "email"],
      authorizationParams: process.env.KAKURIZAI_KEYCLOAK_ACR_VALUES
        ? { acr_values: process.env.KAKURIZAI_KEYCLOAK_ACR_VALUES }
        : {},
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
      mfa: {
        required: process.env.KAKURIZAI_MFA_REQUIRED !== "false"
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
    observability: {
      retentionSamples: 288,
      traceEvents: 2000,
      tracing: true
    },
    cluster: {
      failover: {
        enabled: process.env.KAKURIZAI_FAILOVER_ENABLED !== "false",
        activeProbe: process.env.KAKURIZAI_FAILOVER_ACTIVE_PROBE === "true",
        intervalMs: Number(process.env.KAKURIZAI_FAILOVER_INTERVAL_MS || 5000),
        checkpointIntervalMs: Number(process.env.KAKURIZAI_FAILOVER_CHECKPOINT_INTERVAL_MS || 60000),
        probeTimeoutMs: Number(process.env.KAKURIZAI_FAILOVER_PROBE_TIMEOUT_MS || 5000)
      }
    },
    cube: {
      mode: process.env.KAKURIZAI_CUBE_MODE || "auto",
      cubecli: process.env.KAKURIZAI_CUBECLI || "cubecli",
      mastercli: process.env.KAKURIZAI_CUBEMASTERCLI || "cubemastercli",
      apiBaseUrl: process.env.KAKURIZAI_CUBE_API || null,
      apiTimeoutMs: Number(process.env.KAKURIZAI_CUBE_API_TIMEOUT_MS || 120000),
      apiKey: null,
      apiKeyFile: process.env.KAKURIZAI_CUBE_API_KEY_FILE || path.join(home, "auth", "cube-api.key"),
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
    gvisor: {
      docker: process.env.KAKURIZAI_GVISOR_DOCKER || "docker",
      dockerHost: process.env.KAKURIZAI_GVISOR_DOCKER_HOST || null,
      runtime: process.env.KAKURIZAI_GVISOR_RUNTIME || "runsc",
      image: process.env.KAKURIZAI_GVISOR_IMAGE || "ubuntu:24.04",
      workspacePath: "/workspace",
      dockerNetwork: process.env.KAKURIZAI_GVISOR_DOCKER_NETWORK || "bridge",
      mountMode: "agctl-overlay",
      cpu: process.env.KAKURIZAI_GVISOR_CPU || "1000m",
      memory: process.env.KAKURIZAI_GVISOR_MEMORY || "1024Mi",
      pull: process.env.KAKURIZAI_GVISOR_PULL || "missing",
      restartPolicy: process.env.KAKURIZAI_GVISOR_RESTART_POLICY || "on-failure:5",
      createTimeoutMs: 300000,
      iptables: process.env.KAKURIZAI_GVISOR_IPTABLES || "iptables",
      firewallReconcileMs: Number(process.env.KAKURIZAI_GVISOR_FIREWALL_RECONCILE_MS || 60000)
    },
    fuchsia: {
      ffx: process.env.KAKURIZAI_FFX || "ffx",
      isolateDir: process.env.KAKURIZAI_FUCHSIA_ISOLATE_DIR || path.join(home, "fuchsia", "ffx"),
      productBundle: process.env.KAKURIZAI_FUCHSIA_PRODUCT_BUNDLE || null,
      acceleration: process.env.KAKURIZAI_FUCHSIA_ACCELERATION || "auto",
      engine: process.env.KAKURIZAI_FUCHSIA_ENGINE || null,
      network: process.env.KAKURIZAI_FUCHSIA_NETWORK || "user",
      cpu: process.env.KAKURIZAI_FUCHSIA_CPU || "2",
      startupTimeoutSeconds: Number(process.env.KAKURIZAI_FUCHSIA_STARTUP_TIMEOUT || 180),
      targetTimeoutMs: 60000,
      repositoryEnabled: process.env.KAKURIZAI_FUCHSIA_REPOSITORY !== "false",
      repositoryAddress: process.env.KAKURIZAI_FUCHSIA_REPOSITORY_ADDRESS || "[::]:0",
      disableAnalytics: true
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
  result.auth.mfa = { ...base.auth?.mfa, ...(override?.auth?.mfa || {}) };
  result.audit = { ...base.audit, ...(override?.audit || {}) };
  result.security = { ...base.security, ...(override?.security || {}) };
  result.observability = { ...base.observability, ...(override?.observability || {}) };
  result.cluster = { ...base.cluster, ...(override?.cluster || {}) };
  result.cluster.failover = { ...base.cluster?.failover, ...(override?.cluster?.failover || {}) };
  result.cube = { ...base.cube, ...(override?.cube || {}) };
  result.gvisor = { ...base.gvisor, ...(override?.gvisor || {}) };
  result.fuchsia = { ...base.fuchsia, ...(override?.fuchsia || {}) };
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
  await loadCubeApiKey(config, options);
  return config;
}

async function loadCubeApiKey(config, options = {}) {
  const configured = String(process.env.KAKURIZAI_CUBE_API_KEY || config.cube?.apiKey || "").trim();
  if (configured) {
    assertCubeApiKey(configured);
    config.cube.apiKey = configured;
    return;
  }
  const configuredKeyFile = config.cube?.apiKeyFile || path.join(config.home, "auth", "cube-api.key");
  const keyFile = path.isAbsolute(configuredKeyFile)
    ? configuredKeyFile
    : path.resolve(config.home, configuredKeyFile);
  config.cube.apiKeyFile = keyFile;
  if (await pathExists(keyFile)) {
    config.cube.apiKey = await readCubeApiKeyFile(keyFile);
    return;
  }
  if (options.createSecrets === false) {
    config.cube.apiKey = null;
    return;
  }
  await ensureDir(path.dirname(keyFile));
  const key = crypto.randomBytes(32).toString("base64url");
  try {
    await fs.writeFile(keyFile, `${key}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    config.cube.apiKey = key;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    config.cube.apiKey = await readCubeApiKeyFile(keyFile);
  }
}

async function readCubeApiKeyFile(keyFile) {
  const stat = await fs.lstat(keyFile);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`cube.apiKeyFile must be a regular file, not a link: ${keyFile}`);
  }
  const key = (await fs.readFile(keyFile, "utf8")).trim();
  assertCubeApiKey(key);
  await fs.chmod(keyFile, 0o600);
  return key;
}

function assertCubeApiKey(value) {
  if (Buffer.byteLength(String(value || ""), "utf8") < 32) {
    throw new Error("cube.apiKey must contain at least 32 bytes");
  }
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
  if (auth.provider === "keycloak") return normalizeKeycloakAuth(auth);
  if (auth.provider === "oidc") return normalizeOidcAuth(auth);
  throw new Error(`unsupported auth provider: ${auth.provider}`);
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizeKeycloakAuth(auth) {
  const realm = required(auth.realm || process.env.KAKURIZAI_KEYCLOAK_REALM, "auth.realm");
  const serverUrl = trimTrailingSlash(auth.serverUrl || auth.baseUrl || auth.url || process.env.KAKURIZAI_KEYCLOAK_URL || "http://127.0.0.1:8080");
  const issuer = trimTrailingSlash(auth.issuer || `${serverUrl}/realms/${realm}`);
  const clientId = required(auth.clientId || process.env.KAKURIZAI_KEYCLOAK_CLIENT_ID, "auth.clientId");
  return normalizeOidcAuth({
    ...auth,
    provider: "keycloak",
    providerName: "keycloak",
    label: auth.label || "Keycloak",
    realm,
    serverUrl,
    issuer,
    clientId,
    audience: auth.audience || clientId,
    discoveryUrl: auth.discoveryUrl || `${issuer}/.well-known/openid-configuration`
  });
}

function normalizeOidcAuth(auth) {
  const issuer = trimTrailingSlash(required(auth.issuer, "auth.issuer"));
  const clientId = required(auth.clientId || auth.audience, "auth.clientId");
  return {
    ...auth,
    provider: auth.provider || "oidc",
    label: auth.label || auth.providerName || "OIDC",
    issuer,
    clientId,
    audience: auth.audience || clientId,
    clientSecret: auth.clientSecret || null,
    scopes: auth.scopes || ["openid", "profile", "email"],
    discoveryUrl: auth.discoveryUrl || `${issuer}/.well-known/openid-configuration`
  };
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

export function platformLabel(platform = os.platform()) {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return platform;
}
