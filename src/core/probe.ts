// @ts-nocheck
import { effectiveNetworkConfig } from "./network.js";

export function buildNetworkProbePlan(worlds = [], runtimes = [], options = {}) {
  const runtimeById = new Map();
  for (const runtime of runtimes || []) {
    if (!runtime?.id) continue;
    runtimeById.set(runtime.id, runtime);
    runtimeById.set(shortId(runtime.id), runtime);
  }

  const nodes = worlds.map((world) => {
    const runtime = runtimeById.get(world.sandbox?.id) || runtimeById.get(shortId(world.sandbox?.id)) || null;
    const network = effectiveNetworkConfig(
      world.backendConfig?.network || { type: world.backendConfig?.networkType || "tap" },
      world.backendConfig?.kubernetes || {}
    );
    const kubernetes = world.backendConfig?.kubernetes || {};
    return {
      worldId: world.id,
      name: world.name,
      status: runtime?.status || world.sandbox?.status || world.status,
      sandboxId: world.sandbox?.id || runtime?.id || null,
      sandboxIp: runtime?.sandboxIp || world.sandbox?.sandboxIp || null,
      host: runtime?.hostIp || runtime?.hostId || null,
      networkType: network.type,
      networkMode: network.mode,
      nat: network.nat,
      vlan: network.vlan,
      kubernetes: {
        enabled: Boolean(kubernetes.enabled),
        profile: kubernetes.profile || "k3s",
        clusterName: kubernetes.clusterName || "kakurizai",
        nodeRole: kubernetes.nodeRole || "standalone",
        nodeName: kubernetes.nodeName || world.name,
        podCidr: kubernetes.podCidr || "10.42.0.0/16",
        serviceCidr: kubernetes.serviceCidr || "10.43.0.0/16",
        joinEndpoint: kubernetes.joinEndpoint || "",
        apiServerPort: kubernetes.apiServerPort || 6443,
        nodePorts: kubernetes.nodePorts || []
      },
      allowInternetAccess: network.allowInternetAccess,
      exposedPorts: mergePorts([
        network.exposedPorts,
        runtimePorts(runtime),
        options.extraPorts
      ]),
      canProbe: Boolean(world.sandbox?.id)
    };
  });

  const edges = [];
  for (const source of nodes) {
    for (const target of nodes) {
      if (source.worldId === target.worldId) continue;
      edges.push({
        fromWorldId: source.worldId,
        fromName: source.name,
        toWorldId: target.worldId,
        toName: target.name,
        toSandboxIp: target.sandboxIp,
        hostPath: source.host && target.host && source.host === target.host ? "same-host" : source.host && target.host ? "cross-host" : "unknown-host",
        checks: checksForTarget(target, options),
        reachable: null,
        reason: source.canProbe ? null : "source sandbox is not provisioned"
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    forwards: nodes.flatMap((node) => (node.nat?.portForwards || []).map((forward) => ({
      worldId: node.worldId,
      worldName: node.name,
      ...forward
    })))
  };
}

export function buildProbeScript(targets = [], options = {}) {
  const timeout = Math.max(1, Math.min(10, Number(options.timeoutSeconds || 2)));
  const commands = [
    "probe_ping() { if command -v ping >/dev/null 2>&1; then ping -c 1 -W 1 \"$1\" >/dev/null 2>&1; else return 2; fi; }",
    "probe_tcp() { host=$1; port=$2; if command -v nc >/dev/null 2>&1; then nc -z -w " + timeout + " \"$host\" \"$port\" >/dev/null 2>&1; return $?; fi; if command -v timeout >/dev/null 2>&1 && command -v bash >/dev/null 2>&1; then timeout " + timeout + " bash -lc \"</dev/tcp/$0/$1\" \"$host\" \"$port\" >/dev/null 2>&1; return $?; fi; return 2; }",
    "emit() { printf 'KAKURIZAI_PROBE\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \"$1\" \"$2\" \"$3\" \"$4\" \"$5\"; }"
  ];
  for (const target of targets) {
    if (!target.ip) {
      commands.push(`emit ${shellQuote(target.worldId)} - icmp skip no-ip`);
      continue;
    }
    commands.push(`if probe_ping ${shellQuote(target.ip)}; then emit ${shellQuote(target.worldId)} ${shellQuote(target.ip)} icmp ok -; else rc=$?; emit ${shellQuote(target.worldId)} ${shellQuote(target.ip)} icmp fail "$rc"; fi`);
    for (const port of target.ports || []) {
      commands.push(`if probe_tcp ${shellQuote(target.ip)} ${shellQuote(port)}; then emit ${shellQuote(target.worldId)} ${shellQuote(target.ip)} tcp:${shellQuote(port)} ok -; else rc=$?; emit ${shellQuote(target.worldId)} ${shellQuote(target.ip)} tcp:${shellQuote(port)} fail "$rc"; fi`);
    }
  }
  return commands.join("\n");
}

export function parseProbeOutput(output = "") {
  const checks = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    if (!line.startsWith("KAKURIZAI_PROBE\t")) continue;
    const [, worldId, ip, kind, status, detail] = line.split("\t");
    checks.push({
      worldId,
      ip: ip === "-" ? null : ip,
      kind,
      status,
      ok: status === "ok",
      detail: detail === "-" ? "" : detail || ""
    });
  }
  return checks;
}

export function applyProbeChecks(plan, sourceWorldId, checks = [], error = null) {
  const byTarget = new Map();
  for (const check of checks) {
    const list = byTarget.get(check.worldId) || [];
    list.push(check);
    byTarget.set(check.worldId, list);
  }
  return {
    ...plan,
    edges: plan.edges.map((edge) => {
      if (edge.fromWorldId !== sourceWorldId) return edge;
      if (error) {
        return {
          ...edge,
          reachable: null,
          reason: error
        };
      }
      const edgeChecks = byTarget.get(edge.toWorldId) || [];
      if (!edgeChecks.length) {
        return {
          ...edge,
          reachable: false,
          reason: edge.reason || "no probe result"
        };
      }
      return {
        ...edge,
        checks: edgeChecks,
        reachable: edgeChecks.some((check) => check.ok),
        reason: edgeChecks.some((check) => check.ok) ? null : "all checks failed"
      };
    })
  };
}

function checksForTarget(target, options = {}) {
  const checks = [{ kind: "icmp", port: null, status: "pending" }];
  for (const port of target.exposedPorts.slice(0, Number(options.maxPortsPerTarget || 8))) {
    checks.push({ kind: "tcp", port, status: "pending" });
  }
  return checks;
}

function runtimePorts(runtime) {
  const ports = [];
  if (runtime?.requestedContainerPort) ports.push(runtime.requestedContainerPort);
  for (const mapping of runtime?.portMappings || []) {
    if (mapping.container_port) ports.push(mapping.container_port);
  }
  return ports;
}

function mergePorts(values) {
  const ports = [];
  for (const value of values || []) {
    const raw = Array.isArray(value) ? value : String(value || "").split(/[,\s:]+/);
    for (const item of raw) {
      const port = Number(item);
      if (Number.isInteger(port) && port > 0 && port <= 65535) ports.push(port);
    }
  }
  return [...new Set(ports)].sort((a, b) => a - b);
}

function shortId(value) {
  return value ? String(value).slice(0, 12) : "";
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
