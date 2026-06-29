// @ts-nocheck
import crypto from "node:crypto";
import path from "node:path";
import { ensureDir, nowIso, randomId, readJson, slugify, writeJsonAtomic } from "./fs.js";
import { createWorld, getWorld, listWorlds, removeWorld } from "./worlds.js";

const JOIN_TOKEN_PREFIX = "kzjoin";

export class ClusterStore {
  constructor(config) {
    this.config = config;
    this.root = path.join(config.storeDir, "cluster");
    this.nodesFile = path.join(this.root, "nodes.json");
    this.tokensFile = path.join(this.root, "join-tokens.json");
  }

  async init() {
    await ensureDir(this.root);
  }

  async listNodes() {
    await this.init();
    const raw = await readJson(this.nodesFile, { version: 1, nodes: [] });
    return (raw.nodes || []).sort((a, b) => a.name.localeCompare(b.name));
  }

  async saveNodes(nodes) {
    await writeJsonAtomic(this.nodesFile, { version: 1, nodes });
  }

  async getNode(ref) {
    const nodes = await this.listNodes();
    const matches = nodes.filter((node) => node.id === ref || node.name === ref || node.nodeId === ref);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`ambiguous node: ${ref}; use node id`);
    throw new Error(`node not found: ${ref}`);
  }

  async upsertNode(input) {
    const nodes = await this.listNodes();
    const now = nowIso();
    const nodeId = cleanNodeId(input.nodeId || input.id || input.name);
    const id = nodeId;
    const existingIndex = nodes.findIndex((node) => node.id === id || node.nodeId === nodeId);
    const existing = existingIndex >= 0 ? nodes[existingIndex] : null;
    const node = {
      ...(existing || {}),
      id,
      nodeId,
      name: cleanName(input.name || existing?.name || nodeId),
      endpoint: cleanOptional(input.endpoint || input.url || existing?.endpoint),
      publicHost: cleanOptional(input.publicHost || input.host || existing?.publicHost),
      ip: cleanOptional(input.ip || existing?.ip),
      roles: normalizeList(input.roles || input.role || existing?.roles || ["worker"]),
      labels: { ...(existing?.labels || {}), ...(input.labels || {}) },
      capacity: { ...(existing?.capacity || {}), ...(input.capacity || {}) },
      status: input.status || "joined",
      joinedAt: existing?.joinedAt || now,
      lastSeenAt: now,
      updatedAt: now
    };
    if (existingIndex >= 0) nodes[existingIndex] = node;
    else nodes.push(node);
    await this.saveNodes(nodes);
    return node;
  }

  async removeNode(ref) {
    const nodes = await this.listNodes();
    const node = await this.getNode(ref);
    await this.saveNodes(nodes.filter((candidate) => candidate.id !== node.id));
    return node;
  }

  async listTokens() {
    await this.init();
    const raw = await readJson(this.tokensFile, { version: 1, tokens: [] });
    return raw.tokens || [];
  }

  async saveTokens(tokens) {
    await writeJsonAtomic(this.tokensFile, { version: 1, tokens });
  }

  async createJoinToken(input = {}) {
    const tokens = await this.listTokens();
    const id = randomId("jt");
    const secret = crypto.randomBytes(32).toString("base64url");
    const token = `${JOIN_TOKEN_PREFIX}_${id}_${secret}`;
    const now = Date.now();
    const ttlSeconds = Number(input.ttlSeconds || input.ttl || 24 * 60 * 60);
    const record = {
      id,
      tokenHash: hashToken(token),
      name: input.name || null,
      maxUses: Number(input.uses || input.maxUses || 1),
      uses: 0,
      expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
      createdAt: nowIso()
    };
    tokens.push(record);
    await this.saveTokens(tokens);
    return { ...record, token };
  }

  async consumeJoinToken(token) {
    const tokens = await this.listTokens();
    const now = Date.now();
    const tokenHash = hashToken(token);
    const index = tokens.findIndex((candidate) => candidate.tokenHash === tokenHash);
    if (index < 0) throw statusError("invalid join token", 401);
    const record = tokens[index];
    if (Date.parse(record.expiresAt) <= now) throw statusError("join token expired", 401);
    if (record.maxUses > 0 && record.uses >= record.maxUses) throw statusError("join token exhausted", 401);
    record.uses += 1;
    record.lastUsedAt = nowIso();
    await this.saveTokens(tokens);
    return record;
  }
}

export async function createJoinToken(config, input = {}) {
  return new ClusterStore(config).createJoinToken(input);
}

export async function joinNode(config, input = {}) {
  if (input.token) await new ClusterStore(config).consumeJoinToken(input.token);
  else if (input.requireToken !== false) throw statusError("node join requires a join token", 401);
  return new ClusterStore(config).upsertNode(input);
}

export async function listClusterNodes(config) {
  return new ClusterStore(config).listNodes();
}

export async function removeClusterNode(config, ref) {
  return new ClusterStore(config).removeNode(ref);
}

export async function replicateWorld(config, ref, input = {}) {
  const source = await getWorld(config, ref);
  const store = new ClusterStore(config);
  const nodes = await selectTargetNodes(store, input);
  const worlds = await listWorlds(config);
  const group = input.group || `rep-${source.id}-${Date.now().toString(36)}`;
  const created = [];
  const existing = [];
  const skipped = [];
  for (const node of nodes) {
    const duplicate = worlds.find((world) => (
      world.labels?.["kakurizai.replicaOf"] === source.id
      && world.labels?.["kakurizai.replication.node"] === node.id
      && world.status !== "removed"
    ));
    if (duplicate && input.replace !== true) {
      existing.push(duplicate);
      continue;
    }
    if (duplicate && input.replace === true) {
      await removeWorld(config, duplicate.id, { exactId: true });
    }
    try {
      created.push(await createReplicaWorld(config, source, node, {
        ...input,
        group,
        index: created.length + existing.length + skipped.length + 1
      }));
    } catch (error) {
      if (input.continueOnError === false) throw error;
      skipped.push({ node, reason: error.message || String(error) });
    }
  }
  return { source, group, nodes, created, existing, skipped };
}

async function createReplicaWorld(config, source, node, options = {}) {
  const backendConfig = cloneBackendConfig(source.backendConfig || {});
  const includeHostMounts = options.includeHostMounts === true;
  if (!includeHostMounts) {
    backendConfig.hostMount = false;
    backendConfig.mountMode = "none";
    backendConfig.mounts = [];
  }
  delete backendConfig.cubeRequest;
  delete backendConfig.mountMap;
  backendConfig.placement = {
    nodeId: node.nodeId || node.id,
    nodeName: node.name,
    nodeIp: node.ip || null,
    endpoint: node.endpoint || null
  };
  backendConfig.replication = {
    sourceWorldId: source.id,
    sourceWorldName: source.name,
    group: options.group,
    role: "replica",
    targetNodeId: node.id,
    targetNodeName: node.name
  };
  const name = cleanReplicaName(options.name || `${source.name}-${node.name}`);
  return createWorld(config, {
    name,
    backend: source.backend,
    sourcePath: includeHostMounts ? source.sourcePath : undefined,
    hostMount: includeHostMounts,
    mountMode: includeHostMounts ? source.backendConfig?.mountMode : "none",
    mounts: includeHostMounts ? source.backendConfig?.mounts : undefined,
    template: backendConfig.template || source.sandbox?.baseId || config.cube?.template,
    cpu: backendConfig.cpu,
    memory: backendConfig.memory,
    writableLayerSize: backendConfig.writableLayerSize,
    networkType: backendConfig.networkType,
    network: backendConfig.network,
    kubernetes: backendConfig.kubernetes,
    labels: {
      ...(source.labels || {}),
      "kakurizai.replicaOf": source.id,
      "kakurizai.replicaSourceName": source.name,
      "kakurizai.replication.group": options.group,
      "kakurizai.replication.node": node.id,
      "kakurizai.replication.nodeName": node.name
    },
    backendConfig
  });
}

async function selectTargetNodes(store, input) {
  const nodes = await store.listNodes();
  const refs = normalizeList(input.nodes || input.node || input.targets || input.target);
  const active = nodes.filter((node) => node.status !== "removed" && node.disabled !== true);
  let selected = refs.length
    ? await Promise.all(refs.map((ref) => store.getNode(ref)))
    : active;
  if (input.status) selected = selected.filter((node) => node.status === input.status);
  const count = input.replicas == null ? selected.length : Number(input.replicas);
  if (!Number.isInteger(count) || count < 1) throw new Error("replicas must be a positive integer");
  selected = selected.slice(0, count);
  if (!selected.length) throw new Error("no joined nodes available for replication");
  return selected;
}

function cloneBackendConfig(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function cleanNodeId(value) {
  const id = slugify(value || randomId("node"));
  if (!id) throw new Error("node id is required");
  return id;
}

function cleanName(value) {
  const name = String(value || "").trim();
  if (!name) throw new Error("node name is required");
  return name;
}

function cleanReplicaName(value) {
  return slugify(value).slice(0, 58);
}

function cleanOptional(value) {
  const text = String(value || "").trim();
  return text || null;
}

function normalizeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(normalizeList);
  return String(value).split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
}

function statusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
