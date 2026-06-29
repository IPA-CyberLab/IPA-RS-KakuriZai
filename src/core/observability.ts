// @ts-nocheck
import path from "node:path";
import { CubeSandboxClient } from "../cube/client.js";
import { ensureDir, nowIso, randomId, readJson, writeJsonAtomic } from "./fs.js";
import { listClusterNodes } from "./cluster.js";
import { listWorlds } from "./worlds.js";

export class ObservabilityStore {
  constructor(config) {
    this.config = config;
    this.root = path.join(config.storeDir, "observability");
    this.metricsFile = path.join(this.root, "metrics.json");
    this.tracesFile = path.join(this.root, "traces.json");
    this.maxSamples = Number(config.observability?.retentionSamples || 288);
    this.maxEvents = Number(config.observability?.traceEvents || 2000);
  }

  async init() {
    await ensureDir(this.root);
  }

  async readMetrics() {
    await this.init();
    return readJson(this.metricsFile, { version: 1, samples: [] });
  }

  async appendMetric(sample) {
    const data = await this.readMetrics();
    data.samples = [...(data.samples || []), sample].slice(-this.maxSamples);
    await writeJsonAtomic(this.metricsFile, data);
    return data.samples;
  }

  async readTraces() {
    await this.init();
    return readJson(this.tracesFile, { version: 1, traces: [] });
  }

  async writeTraces(traces) {
    await writeJsonAtomic(this.tracesFile, { version: 1, traces });
  }

  async startTrace(input = {}) {
    const data = await this.readTraces();
    const now = Date.now();
    const ttlSeconds = Number(input.ttlSeconds || input.ttl || 60 * 60);
    const trace = {
      id: randomId("tr"),
      name: input.name || `${input.targetType || "all"}:${input.target || "*"}`,
      targetType: input.targetType || input.type || "all",
      target: input.target || input.ref || null,
      enabled: true,
      startedAt: nowIso(),
      expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
      events: []
    };
    data.traces.push(trace);
    await this.writeTraces(data.traces);
    return trace;
  }

  async stopTrace(id) {
    const data = await this.readTraces();
    const trace = data.traces.find((item) => item.id === id);
    if (!trace) throw new Error(`trace not found: ${id}`);
    trace.enabled = false;
    trace.stoppedAt = nowIso();
    await this.writeTraces(data.traces);
    return trace;
  }

  async listTraces() {
    const data = await this.readTraces();
    return data.traces || [];
  }

  async recordEvent(event) {
    const data = await this.readTraces();
    const now = Date.now();
    let changed = false;
    for (const trace of data.traces || []) {
      if (!trace.enabled) continue;
      if (trace.expiresAt && Date.parse(trace.expiresAt) <= now) {
        trace.enabled = false;
        trace.stoppedAt = nowIso();
        changed = true;
        continue;
      }
      if (!traceMatches(trace, event)) continue;
      trace.events = [...(trace.events || []), { ...event, ts: event.ts || nowIso() }].slice(-this.maxEvents);
      changed = true;
    }
    if (changed) await this.writeTraces(data.traces);
  }
}

export async function collectMetrics(config, options = {}) {
  const [worlds, cube, clusterNodes] = await Promise.all([
    listWorlds(config),
    new CubeSandboxClient(config.cube).inspect(),
    listClusterNodes(config).catch(() => [])
  ]);
  const nodes = mergeNodes(clusterNodes, cube.nodes || [], worlds);
  const replicas = worlds.filter((world) => world.labels?.["kakurizai.replicaOf"]);
  const sample = {
    ts: nowIso(),
    summary: {
      worlds: worlds.length,
      replicas: replicas.length,
      running: worlds.filter((world) => /ready|running/.test(world.status || "")).length,
      failed: worlds.filter((world) => /failed/.test(world.status || "")).length,
      nodes: nodes.length,
      healthyNodes: nodes.filter((node) => node.healthy !== false && node.status !== "failed").length
    },
    nodes,
    worlds: worlds.map((world) => worldMetric(world)),
    storage: cube.storage || [],
    cube: {
      available: cube.available,
      mode: cube.mode,
      namespace: cube.namespace,
      templates: cube.templates?.length || 0,
      sandboxes: cube.sandboxes?.length || 0,
      reason: cube.reason || null
    }
  };
  const store = new ObservabilityStore(config);
  const history = options.persist === false ? (await store.readMetrics()).samples || [] : await store.appendMetric(sample);
  return { sample, history };
}

export async function startTrace(config, input = {}) {
  return new ObservabilityStore(config).startTrace(input);
}

export async function stopTrace(config, id) {
  return new ObservabilityStore(config).stopTrace(id);
}

export async function listTraces(config) {
  return new ObservabilityStore(config).listTraces();
}

export async function recordTraceEvent(config, event) {
  if (config.observability?.tracing === false) return;
  return new ObservabilityStore(config).recordEvent(event);
}

export function prometheusText(snapshot) {
  const lines = [
    "# HELP kakurizai_worlds Total worlds managed by KakuriZai",
    "# TYPE kakurizai_worlds gauge",
    `kakurizai_worlds ${snapshot.sample.summary.worlds}`,
    "# HELP kakurizai_replicas Total replica worlds managed by KakuriZai",
    "# TYPE kakurizai_replicas gauge",
    `kakurizai_replicas ${snapshot.sample.summary.replicas}`,
    "# HELP kakurizai_nodes Total joined/runtime nodes",
    "# TYPE kakurizai_nodes gauge",
    `kakurizai_nodes ${snapshot.sample.summary.nodes}`,
    "# HELP kakurizai_node_cpu_usage CPU quota usage reported by CubeMaster",
    "# TYPE kakurizai_node_cpu_usage gauge"
  ];
  for (const node of snapshot.sample.nodes) {
    const labels = labelsText({ node: node.nodeId || node.id, name: node.name });
    if (node.quotaCpuUsage != null) lines.push(`kakurizai_node_cpu_usage${labels} ${node.quotaCpuUsage}`);
    if (node.quotaMemUsage != null) lines.push(`kakurizai_node_mem_usage_mb${labels} ${node.quotaMemUsage}`);
    if (node.replicaCount != null) lines.push(`kakurizai_node_replicas${labels} ${node.replicaCount}`);
  }
  lines.push("# HELP kakurizai_world_upper_bytes Writable overlay bytes per world");
  lines.push("# TYPE kakurizai_world_upper_bytes gauge");
  for (const world of snapshot.sample.worlds) {
    lines.push(`kakurizai_world_upper_bytes${labelsText({ world: world.id, name: world.name })} ${world.upperBytes || 0}`);
  }
  return `${lines.join("\n")}\n`;
}

function mergeNodes(clusterNodes, runtimeNodes, worlds) {
  const map = new Map();
  for (const node of clusterNodes || []) {
    map.set(node.nodeId || node.id, {
      ...node,
      source: "kakurizai",
      healthy: node.status !== "failed"
    });
  }
  for (const node of runtimeNodes || []) {
    const key = node.nodeId || node.id || node.ip;
    map.set(key, {
      ...(map.get(key) || {}),
      ...node,
      id: map.get(key)?.id || key,
      name: map.get(key)?.name || node.nodeId || node.ip || key,
      source: map.has(key) ? "kakurizai+cubemaster" : "cubemaster"
    });
  }
  return [...map.values()].map((node) => {
    const replicaCount = worlds.filter((world) => {
      const placement = world.backendConfig?.placement || {};
      return placement.nodeId === node.nodeId || placement.nodeId === node.id || world.labels?.["kakurizai.replication.node"] === node.id;
    }).length;
    return { ...node, replicaCount };
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function worldMetric(world) {
  return {
    id: world.id,
    name: world.name,
    status: world.status,
    backend: world.backend,
    sandboxId: world.sandbox?.id || null,
    replicaOf: world.labels?.["kakurizai.replicaOf"] || null,
    replicationGroup: world.labels?.["kakurizai.replication.group"] || null,
    nodeId: world.backendConfig?.placement?.nodeId || world.sandbox?.hostId || null,
    upperBytes: world.diskUsage?.upperBytes || 0,
    logsBytes: world.diskUsage?.logsBytes || 0
  };
}

function traceMatches(trace, event) {
  if (trace.targetType === "all" || !trace.targetType) return true;
  if (trace.targetType === "world") return event.worldId === trace.target || event.target === trace.target;
  if (trace.targetType === "node") return event.nodeId === trace.target || event.nodeName === trace.target;
  if (trace.targetType === "path") return String(event.path || "").startsWith(trace.target || "");
  return false;
}

function labelsText(labels) {
  return `{${Object.entries(labels).map(([key, value]) => `${key}="${String(value || "").replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`).join(",")}}`;
}
