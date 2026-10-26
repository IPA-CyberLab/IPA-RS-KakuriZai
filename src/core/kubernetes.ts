// @ts-nocheck
import crypto from "node:crypto";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { CubeSandboxClient } from "../cube/client.js";
import { WorldStore } from "./store.js";

export const DEFAULT_K3S_VERSION = "v1.36.5+k3s1";
const bootstraps = new Map();
const STATE_DIR = "/var/lib/kakurizai/kubernetes";

export function bootstrapKubernetesLab(config, worlds, options = {}) {
  const nodes = worlds.filter((world) => world.backend === "cube-sandbox-overlay"
    && world.backendConfig?.kubernetes?.enabled && world.backendConfig.kubernetes.bootstrap !== false);
  if (!nodes.length) return Promise.resolve({ status: "skipped", reason: "no managed Kubernetes nodes" });
  const key = `${config.storeDir}:${nodes[0].backendConfig.kubernetes.clusterName}`;
  if (bootstraps.has(key)) return bootstraps.get(key);
  const operation = bootstrap(config, nodes, options).finally(() => bootstraps.delete(key));
  bootstraps.set(key, operation);
  return operation;
}

async function bootstrap(config, nodes, options) {
  const store = new WorldStore(config);
  const client = options.client || new CubeSandboxClient(config.cube || {});
  const signal = options.signal;
  const timeoutMs = duration(options.timeoutMs || config.cube?.kubernetesBootstrap?.timeoutMs, 10 * 60 * 1000);
  const deadline = Date.now() + timeoutMs;
  const intervalMs = duration(options.pollIntervalMs || config.cube?.kubernetesBootstrap?.pollIntervalMs, 2000);
  const expectedNodes = [...new Set(nodes.flatMap((world) => world.backendConfig.kubernetes.expectedNodes || []))];
  const presentNames = new Set(nodes.map((world) => world.backendConfig.kubernetes.nodeName || world.name));
  const readyRuntime = (world) => (world.sandbox?.containerId || world.sandbox?.id)
    && ["ready", "running"].includes(world.status)
    && !["failed", "paused", "planned"].includes(world.sandbox?.status);
  if (!nodes.every(readyRuntime) || expectedNodes.some((name) => !presentNames.has(name))) {
    for (const world of nodes) await saveStatus(store, world, { status: "pending", reason: "waiting for CubeSandbox nodes" });
    return { status: "pending", reason: "waiting for CubeSandbox nodes" };
  }
  const servers = nodes.filter((world) => world.backendConfig.kubernetes.nodeRole !== "worker");
  const leader = servers.find((world) => world.backendConfig.kubernetes.clusterInit)
    || servers.find((world) => !world.backendConfig.kubernetes.joinEndpoint) || servers[0];
  if (!leader) return { status: "pending", reason: "waiting for a control-plane World" };
  const ip = runtimeIp(leader);
  if (!ip) return { status: "pending", reason: "control-plane runtime IP is not available" };
  const token = leader.backendConfig.kubernetes.joinToken || crypto.randomBytes(32).toString("hex");
  const endpoint = `https://${ip}:${leader.backendConfig.kubernetes.apiServerPort || 6443}`;
  const plans = [];
  try {
    if (presentNames.size !== nodes.length) throw new Error("Kubernetes node names must be unique within a cluster");
    for (const world of [leader, ...nodes.filter((world) => world.id !== leader.id)]) {
      if (!runtimeIp(world)) throw new Error(`runtime IP is not available for ${world.name}`);
      const k = world.backendConfig.kubernetes;
      if (k.profile !== "k3s") throw new Error(`automatic Kubernetes bootstrap supports profile=k3s; set bootstrap=false for an external ${k.profile} bootstrapper`);
      if (k.cni !== "flannel") throw new Error(`automatic k3s bootstrap supports cni=flannel; set bootstrap=false for an external ${k.cni} bootstrapper`);
      const desired = {
        ...k,
        version: k.version || config.cube?.kubernetesBootstrap?.version || DEFAULT_K3S_VERSION,
        nodeName: k.nodeName || world.name,
        joinToken: token,
        joinEndpoint: world.id === leader.id ? "" : endpoint,
        clusterInit: world.id === leader.id && servers.length > 1
      };
      const script = buildK3sBootstrapScript(desired, runtimeIp(world));
      const fingerprint = crypto.createHash("sha256").update(script).digest("hex");
      const latest = await store.get(world.id, { exactId: true });
      latest.backendConfig.kubernetes = desired;
      await store.save(latest);
      plans.push({ world: latest, script, fingerprint });
    }
    if (plans.every(({ world, fingerprint }) => world.sandbox?.kubernetesBootstrap?.status === "ready"
      && world.sandbox.kubernetesBootstrap.runtimeId === (world.sandbox.containerId || world.sandbox.id)
      && world.sandbox.kubernetesBootstrap.fingerprint === fingerprint)) {
      return { status: "ready", endpoint, nodes: plans.map(({ world }) => world.backendConfig.kubernetes.nodeName) };
    }
    // Planned labs can become runnable long after the original create request.
    // Reconcile their TAP topology here too, before any node tries to join.
    const topology = await client.syncCubeSandboxHairpinTopology?.(nodes);
    if (topology && !topology.skipped && !topology.applied) throw new Error(`Kubernetes network setup failed: ${topology.reason || "hairpin rules were not applied"}`);
    const exec = (world, command) => {
      signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Kubernetes bootstrap timed out after ${timeoutMs}ms`);
      return client.exec(world, command, {
        allowFailure: true,
        timeoutMs: Math.min(remaining, 3 * 60 * 1000),
        killProcessGroup: true,
        signal
      });
    };
    const waitFor = async (check) => {
      let detail = "not ready";
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const result = await check();
        if (result.ready) return result;
        detail = String(result.detail || detail).slice(-2000);
        await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())), undefined, { signal });
      }
      throw new Error(`Kubernetes bootstrap timed out after ${timeoutMs}ms: ${detail}`);
    };
    for (const plan of plans) {
      await saveStatus(store, plan.world, { status: "starting", fingerprint: plan.fingerprint });
      const result = await exec(plan.world, ["/bin/sh", "-lc", plan.script]);
      if (result.code !== 0) throw new Error(`k3s bootstrap failed for ${plan.world.name}: ${result.stderr || result.stdout || result.signal || result.code}`);
      if (plan.world.id === leader.id) {
        await waitFor(async () => {
          const result = await exec(plan.world, ["/usr/local/bin/k3s", "kubectl", "--kubeconfig", "/etc/rancher/k3s/k3s.yaml", "get", "--raw=/readyz"]);
          return { ready: result.code === 0 && result.stdout.trim() === "ok", detail: result.stderr || result.stdout };
        });
      }
    }
    const expected = plans.map(({ world }) => world.backendConfig.kubernetes.nodeName);
    await waitFor(async () => {
      const result = await exec(plans[0].world, ["/usr/local/bin/k3s", "kubectl", "--kubeconfig", "/etc/rancher/k3s/k3s.yaml", "get", "nodes", "-o", "json"]);
      let items = [];
      try { items = JSON.parse(result.stdout).items || []; } catch { /* The API may still be starting. */ }
      const ready = new Set(items.filter((node) => node.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True")).map((node) => node.metadata?.name));
      return { ready: result.code === 0 && expected.every((name) => ready.has(name)), detail: result.stderr || `waiting for Ready nodes: ${expected.filter((name) => !ready.has(name)).join(", ")}` };
    });
    for (const plan of plans) await saveStatus(store, plan.world, { status: "ready", fingerprint: plan.fingerprint, endpoint, readyAt: new Date().toISOString() });
    return { status: "ready", endpoint, nodes: expected };
  } catch (error) {
    const aborted = error.name === "AbortError" || signal?.aborted;
    const reason = String(error.message || error).replaceAll(token, "[redacted]").slice(-4000);
    for (const world of nodes) await saveStatus(store, world, { status: aborted ? "pending" : "failed", reason, ...(aborted ? {} : { nextRetryAt: Date.now() + 30_000 }) });
    if (aborted) throw error;
    return { status: "failed", reason };
  }
}

async function saveStatus(store, world, status) {
  const latest = await store.get(world.id, { exactId: true });
  if ((latest.sandbox?.containerId || latest.sandbox?.id) !== (world.sandbox?.containerId || world.sandbox?.id)) {
    throw new Error(`Kubernetes runtime changed for ${world.name}`);
  }
  latest.sandbox = {
    ...(latest.sandbox || {}),
    kubernetesBootstrap: {
      ...status,
      runtimeId: latest.sandbox?.containerId || latest.sandbox?.id || null,
      updatedAt: new Date().toISOString()
    }
  };
  await store.save(latest);
}

function runtimeIp(world) {
  return world.sandbox?.sandboxIp || world.sandbox?.runtimeSandboxIp || world.backendConfig?.network?.sandboxIp || null;
}

export function buildK3sBootstrapScript(k, externalIp) {
  const version = k.version || DEFAULT_K3S_VERSION;
  if (!/^v1\.\d+\.\d+\+k3s\d+$/.test(version)) throw new Error(`invalid k3s version: ${version}`);
  if (!/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(k.nodeName || "") || k.nodeName.length > 253) throw new Error("invalid Kubernetes node name");
  if (!k.joinToken) throw new Error("Kubernetes join token is required");
  if (isIP(externalIp || "") !== 4) throw new Error("Kubernetes bootstrap requires an IPv4 runtime IP");
  const worker = k.nodeRole === "worker";
  if (worker || k.joinEndpoint) {
    let endpoint;
    try { endpoint = new URL(k.joinEndpoint); } catch { throw new Error("invalid Kubernetes join endpoint"); }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") throw new Error("invalid Kubernetes join endpoint");
  }
  const settings = {
    "node-name": k.nodeName,
    "node-external-ip": externalIp,
    token: k.joinToken
  };
  if (k.joinEndpoint) settings.server = k.joinEndpoint;
  if (!worker) Object.assign(settings, {
    "https-listen-port": k.apiServerPort || 6443,
    "cluster-cidr": k.podCidr || "10.42.0.0/16",
    "service-cidr": k.serviceCidr || "10.43.0.0/16",
    "flannel-backend": "vxlan",
    "flannel-external-ip": true,
    "advertise-address": k.advertiseAddress || externalIp,
    "tls-san": [externalIp],
    "kube-apiserver-arg": ["kubelet-preferred-address-types=ExternalIP,InternalIP,Hostname"],
    disable: ["traefik", "servicelb"],
    ...(k.clusterInit ? { "cluster-init": true } : {})
  });
  const json = JSON.stringify(settings);
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ settings, version, extraArgs: k.extraArgs || [], sysctls: k.sysctls || {} })).digest("hex");
  const sysctls = Object.entries(k.sysctls || {}).map(([key, value]) => {
    if (!/^[a-zA-Z0-9_.-]+$/.test(key)) throw new Error(`invalid sysctl name: ${key}`);
    return `sysctl -w ${quote(`${key}=${value}`)} >/dev/null`;
  });
  return [
    "set -eu",
    "umask 077",
    `state=${quote(STATE_DIR)}`,
    "mkdir -p \"$state\" /usr/local/bin",
    `fingerprint=${quote(fingerprint)}`,
    "managed_pid() { [ -f \"$state/pid\" ] || return 1; pid=$(cat \"$state/pid\"); case \"$pid\" in ''|*[!0-9]*) return 1 ;; esac; kill -0 \"$pid\" 2>/dev/null && tr '\\000' ' ' < \"/proc/$pid/cmdline\" | grep -Fq -- \"$state/config.yaml\"; }",
    "if managed_pid && [ \"$(cat \"$state/fingerprint\" 2>/dev/null || true)\" = \"$fingerprint\" ]; then exit 0; fi",
    "if ! command -v curl >/dev/null 2>&1 || ! command -v sha256sum >/dev/null 2>&1; then if command -v apt-get >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; apt-get -o DPkg::Lock::Timeout=180 update; apt-get -o DPkg::Lock::Timeout=180 install -y --no-install-recommends ca-certificates curl coreutils iproute2 procps; elif command -v apk >/dev/null 2>&1; then apk add --no-cache ca-certificates curl coreutils iproute2 procps; else echo 'k3s bootstrap needs curl, sha256sum, ip and sysctl' >&2; exit 1; fi; fi",
    `version=${quote(version)}`,
    "case $(uname -m) in x86_64) arch=amd64; artifact=k3s ;; aarch64|arm64) arch=arm64; artifact=k3s-arm64 ;; armv7l) arch=arm; artifact=k3s-armhf ;; *) echo 'unsupported k3s architecture' >&2; exit 1 ;; esac",
    "if ! /usr/local/bin/k3s --version 2>/dev/null | grep -Fq -- \"$version \"; then base=https://github.com/k3s-io/k3s/releases/download/$version; curl -fLsS --connect-timeout 15 --max-time 120 --retry 2 \"$base/$artifact\" -o \"$state/k3s.download\"; curl -fLsS --connect-timeout 15 --max-time 60 --retry 2 \"$base/sha256sum-$arch.txt\" -o \"$state/checksums\"; digest=$(awk -v name=\"$artifact\" '$2 == name || $2 == \"*\" name { print $1; exit }' \"$state/checksums\"); [ -n \"$digest\" ] || { echo 'k3s checksum is missing' >&2; exit 1; }; printf '%s  %s\\n' \"$digest\" \"$state/k3s.download\" | sha256sum -c -; chmod 755 \"$state/k3s.download\"; mv \"$state/k3s.download\" /usr/local/bin/k3s; fi",
    "modprobe overlay 2>/dev/null || true; modprobe br_netfilter 2>/dev/null || true",
    ...sysctls,
    `printf '%s\\n' ${quote(json)} > "$state/config.yaml"`,
    "iface=$(ip -4 route show default | awk '{ for (i=1;i<=NF;i++) if ($i == \"dev\") { print $(i+1); exit } }'); [ -n \"$iface\" ] || { echo 'default network interface is missing' >&2; exit 1; }",
    "node_ip=$(ip -4 -o addr show dev \"$iface\" | awk '{split($4,a,\"/\"); print a[1]; exit}'); [ -n \"$node_ip\" ] || { echo 'node IPv4 address is missing' >&2; exit 1; }",
    "if managed_pid; then kill \"$pid\"; for attempt in 1 2 3 4 5; do kill -0 \"$pid\" 2>/dev/null || break; sleep 1; done; if kill -0 \"$pid\" 2>/dev/null; then echo 'previous managed k3s process has not stopped' >&2; exit 1; fi; fi",
    `nohup /usr/local/bin/k3s ${worker ? "agent" : "server"} --config "$state/config.yaml" --node-ip "$node_ip" --flannel-iface "$iface" ${(k.extraArgs || []).map(quote).join(" ")} > "$state/service.log" 2>&1 < /dev/null &`,
    "printf '%s\\n' \"$!\" > \"$state/pid\"",
    "printf '%s\\n' \"$fingerprint\" > \"$state/fingerprint\""
  ].join("\n");
}

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function duration(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
