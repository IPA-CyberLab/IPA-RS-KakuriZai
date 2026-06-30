// @ts-nocheck
import crypto from "node:crypto";
import path from "node:path";
import { CubeSandboxClient } from "../cube/client.js";
import { buildCubeSandboxRequest } from "../cube/request.js";
import { ensureDir, nowIso, randomId, readJson, slugify, writeJsonAtomic } from "./fs.js";
import { runCommand } from "./process.js";
import { WorldStore } from "./store.js";
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
      executor: normalizeExecutor(input.executor || existing?.executor),
      replication: normalizeNodeReplication(input.replication || existing?.replication),
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

export async function checkpointFailoverReplicas(config, input = {}) {
  const worlds = await listWorlds(config);
  const sources = worlds.filter((world) => isFailoverSource(world, input));
  const results = [];
  for (const source of sources) {
    if (source.labels?.["kakurizai.failover.promoted"] === "true" && input.force !== true) continue;
    const replicas = worlds.filter((world) => world.labels?.["kakurizai.replicaOf"] === source.id && world.status !== "removed");
    const checkpointDue = input.force === true || replicas.length > 0 || input.bootstrap === true;
    if (!checkpointDue) continue;
    try {
      results.push(await replicateWorld(config, source.id, {
        ...(input.replicate || {}),
        node: input.node || input.nodes,
        replicas: input.replicas,
        stateMode: input.stateMode || "stateful",
        replace: input.replace !== false,
        continueOnError: input.continueOnError !== false,
        failFast: false
      }));
    } catch (error) {
      results.push({ source, error: error.message || String(error) });
    }
  }
  return { checkedAt: nowIso(), results };
}

export async function reconcileFailover(config, input = {}) {
  const store = new WorldStore(config);
  const worlds = await store.list();
  const health = await failoverHealth(config);
  const promoted = [];
  const skipped = [];
  for (const source of worlds.filter((world) => isFailoverSource(world, input))) {
    const sourceNode = source.backendConfig?.placement?.nodeId || source.sandbox?.hostId || null;
    if (source.labels?.["kakurizai.failover.promoted"] === "true" && input.force !== true) {
      skipped.push({ source: source.name, reason: "already promoted" });
      continue;
    }
    const unavailableByProbe = input.force === true ? true : await sourceProbeUnavailable(config, source, input);
    const unhealthy = input.force === true || sourceUnavailable(source, sourceNode, health) || unavailableByProbe;
    if (!unhealthy) {
      skipped.push({ source: source.name, reason: "source healthy" });
      continue;
    }
    const candidates = worlds
      .filter((world) => world.labels?.["kakurizai.replicaOf"] === source.id && world.status !== "removed")
      .filter((world) => failoverReplicaReady(world, health))
      .sort(replicaPreference);
    const replica = candidates[0];
    if (!replica) {
      skipped.push({ source: source.name, reason: "no healthy memory replica" });
      continue;
    }
    promoted.push(await promoteReplica(store, source, replica, {
      reason: input.force === true ? "forced" : "source unavailable",
      failedNode: sourceNode,
      health
    }));
  }
  return { checkedAt: nowIso(), health, promoted, skipped };
}

export function startFailoverController(config, options = {}) {
  if (config.cluster?.failover?.enabled === false || options.enabled === false) return { stop() {} };
  const detectMs = Math.max(1000, Number(options.intervalMs || config.cluster?.failover?.intervalMs || 5000));
  const checkpointMs = Math.max(detectMs, Number(options.checkpointIntervalMs || config.cluster?.failover?.checkpointIntervalMs || 60000));
  let stopped = false;
  let running = false;
  let lastCheckpoint = 0;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await reconcileFailover(config);
      const now = Date.now();
      if (now - lastCheckpoint >= checkpointMs) {
        lastCheckpoint = now;
        await checkpointFailoverReplicas(config, { continueOnError: true });
      }
    } catch {
      // The controller is best-effort; explicit CLI/API calls report failures.
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, detectMs);
  timer.unref?.();
  void tick();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}

export async function replicateWorld(config, ref, input = {}) {
  const source = await getWorld(config, ref);
  const store = new ClusterStore(config);
  const nodes = await selectTargetNodes(store, input);
  const statePlan = await prepareReplicationState(config, source, nodes, input);
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
        state: statePlan.stateForNode(node),
        index: created.length + existing.length + skipped.length + 1
      }));
    } catch (error) {
      if (input.continueOnError === false) throw error;
      skipped.push({ node, reason: error.message || String(error) });
    }
  }
  return { source, group, nodes, state: statePlan.summary, created, existing, skipped };
}

async function failoverHealth(config) {
  const nodes = await new CubeSandboxClient(config.cube).inspect().then((cube) => cube.nodes || []).catch(() => []);
  const nodeMap = new Map();
  for (const node of nodes) {
    const key = node.nodeId || node.id || node.ip;
    if (!key) continue;
    nodeMap.set(key, node);
  }
  return { nodes, nodeMap };
}

function isFailoverSource(world, input = {}) {
  if (!world || world.status === "removed") return false;
  if (world.labels?.["kakurizai.replicaOf"]) return false;
  if (input.world || input.ref) return [world.id, world.name].includes(input.world || input.ref);
  return world.labels?.["kakurizai.failover.enabled"] !== "false";
}

function sourceUnavailable(source, sourceNode, health) {
  if (!sourceNode) return false;
  const runtimeNode = health.nodeMap.get(sourceNode);
  if (!runtimeNode) return true;
  if (runtimeNode.healthy === false) return true;
  if (/failed|down|unhealthy|notready/i.test(String(runtimeNode.status || runtimeNode.HostStatus || ""))) return true;
  return false;
}

async function sourceProbeUnavailable(config, source, input = {}) {
  if (!source.sandbox?.id || source.sandbox?.mode === "direct-cubelet") return false;
  try {
    const timeoutMs = Number(input.probeTimeoutMs || config.cluster?.failover?.probeTimeoutMs || 5000);
    const result = await new CubeSandboxClient(config.cube).exec(source, ["/bin/sh", "-lc", "true"], {
      allowFailure: true,
      timeoutMs
    });
    return result.code !== 0;
  } catch {
    return true;
  }
}

function failoverReplicaReady(world, health) {
  if (!world.sandbox?.id) return false;
  const state = world.backendConfig?.replication?.state || {};
  if (state.capturesMemory !== true) return false;
  const nodeId = world.backendConfig?.placement?.nodeId || world.labels?.["kakurizai.replication.node"];
  if (!nodeId) return true;
  const runtimeNode = health.nodeMap.get(nodeId);
  if (!runtimeNode) return true;
  if (runtimeNode.healthy === false) return false;
  if (/failed|down|unhealthy|notready/i.test(String(runtimeNode.status || runtimeNode.HostStatus || ""))) return false;
  return true;
}

function replicaPreference(a, b) {
  const aAt = Date.parse(a.backendConfig?.replication?.state?.capturedAt || a.updatedAt || 0) || 0;
  const bAt = Date.parse(b.backendConfig?.replication?.state?.capturedAt || b.updatedAt || 0) || 0;
  return bAt - aAt;
}

async function promoteReplica(store, source, replica, context = {}) {
  const promotedAt = nowIso();
  source.status = "ready";
  source.sandbox = {
    ...(replica.sandbox || {}),
    status: "running",
    reason: null
  };
  source.backend = replica.backend || source.backend;
  source.backendConfig = {
    ...(source.backendConfig || {}),
    ...(replica.backendConfig || {}),
    failover: {
      active: true,
      promotedAt,
      promotedFrom: replica.id,
      failedNode: context.failedNode || null,
      reason: context.reason || "source unavailable"
    }
  };
  source.labels = {
    ...(source.labels || {}),
    "kakurizai.failover.enabled": "true",
    "kakurizai.failover.promoted": "true",
    "kakurizai.failover.promotedAt": promotedAt,
    "kakurizai.failover.activeReplica": replica.id,
    ...(context.failedNode ? { "kakurizai.failover.failedNode": context.failedNode } : {})
  };
  const savedSource = await store.save(source);
  replica.status = "standby-promoted";
  replica.labels = {
    ...(replica.labels || {}),
    "kakurizai.failover.promotedAs": source.id,
    "kakurizai.failover.promotedAt": promotedAt
  };
  await store.save(replica);
  return {
    source: savedSource,
    replica,
    promotedAt,
    failedNode: context.failedNode || null,
    reason: context.reason || "source unavailable"
  };
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
  backendConfig.template = options.state?.templateId || backendConfig.template || source.sandbox?.baseId || config.cube?.template || null;
  backendConfig.replication = {
    sourceWorldId: source.id,
    sourceWorldName: source.name,
    group: options.group,
    role: "replica",
    targetNodeId: node.id,
    targetNodeName: node.name,
    stateMode: options.state?.mode || "definition",
    state: options.state || { mode: "definition" },
    ...(options.state?.executor ? { executor: options.state.executor } : {}),
    ...(options.state?.directSandbox ? { directRestore: options.state.directSandbox } : {})
  };
  const name = cleanReplicaName(options.name || `${source.name}-${node.name}`);
  const createInput = {
    name,
    backend: source.backend,
    sourcePath: includeHostMounts ? source.sourcePath : undefined,
    hostMount: includeHostMounts,
    mountMode: includeHostMounts ? source.backendConfig?.mountMode : "none",
    mounts: includeHostMounts ? source.backendConfig?.mounts : undefined,
    template: options.state?.templateId || backendConfig.template || source.sandbox?.baseId || config.cube?.template,
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
      "kakurizai.replication.nodeName": node.name,
      "kakurizai.replication.stateMode": options.state?.mode || "definition",
      ...(options.state?.templateId ? { "kakurizai.replication.stateTemplate": options.state.templateId } : {}),
      ...(options.state?.snapshotId ? { "kakurizai.replication.runtimeSnapshot": options.state.snapshotId } : {})
    },
    backendConfig
  };
  if (options.state?.directSandbox) {
    return createDirectReplicaWorld(config, createInput, node, options.state);
  }
  return createWorld(config, createInput);
}

async function prepareReplicationState(config, source, nodes, input = {}) {
  const mode = normalizeStateMode(input.stateMode || input.state || (input.definitionOnly ? "definition" : "stateful"));
  const sandboxId = source.sandbox?.containerId || source.sandbox?.id;
  if (mode === "definition" || !sandboxId) {
    const reason = mode === "definition"
      ? "definition-only replication was explicitly requested"
      : "source sandbox is not running; only the saved definition can be replicated";
    return definitionStatePlan(reason);
  }
  const client = new CubeSandboxClient(config.cube);
  const capturedAt = nowIso();
  const workspaceSnapshotPath = "/kakurizai/replication-state/workspace";
  const sourceNode = await resolveSourceNode(client, source);
  const materialize = source.backendConfig?.hostMount === true || (source.backendConfig?.mounts || []).length > 0;
  let materialized = null;
  if (materialize && input.materializeWorkspace !== false) {
    materialized = await client.materializeReplicationState(source, {
      workspace: config.cube?.workspacePath || "/workspace",
      target: workspaceSnapshotPath
    });
    if (!materialized.applied && input.allowPartialState !== true) {
      throw new Error(`cannot capture mounted workspace state before replication: ${materialized.reason || "materialize failed"}`);
    }
  }

  let runtimeSnapshot = null;
  if (mode !== "template-snapshot" && input.captureMemory !== false) {
    const snapshot = await client.createRuntimeSnapshot(source, {
      displayName: `${source.name}-replication-${Date.now().toString(36)}`,
      wait: input.waitForState !== false
    });
    if (snapshot.created && snapshot.snapshotId) {
      runtimeSnapshot = snapshot;
    } else if (mode === "runtime-snapshot") {
      throw new Error(`runtime snapshot failed: ${snapshot.reason || "snapshot id was not returned"}`);
    }
  }

  let committedTemplate = null;
  const directRestores = new Map();
  const needsPortableTemplate = nodes.some((node) => !runtimeSnapshot || !nodeMatchesRuntimeSnapshot(node, runtimeSnapshot, sourceNode));
  if (mode === "runtime-snapshot" && needsPortableTemplate) {
    throw new Error("runtime snapshots are local to the origin node; use stateful or template-snapshot for cross-node replication");
  }
  if (mode !== "runtime-snapshot" && needsPortableTemplate) {
    const request = sourceCubeRequest(config, source);
    const commit = await client.commitSandboxTemplate(source, request, { wait: input.waitForState !== false });
    if (!commit.committed || !commit.templateId) {
      throw new Error(`portable state template failed: ${commit.reason || "template id was not returned"}`);
    }
    const distribution = await client.distributeTemplate(commit.templateId, nodes, {
      logDir: source.paths?.logs,
      interval: input.waitInterval || "2s"
    });
    if (!distribution.distributed) {
      const direct = await restoreDirectReplicas(config, source, nodes, {
        input,
        request,
        commit,
        distribution,
        runtimeSnapshot,
        sourceNode,
        capturedAt
      });
      if (!direct.restored) {
        throw new Error(`state template distribution failed: ${distribution.reason || "template redo failed"}`);
      }
      for (const [key, restore] of direct.byNode) directRestores.set(key, restore);
    }
    committedTemplate = { ...commit, distribution };
  }

  const summary = {
    requestedMode: mode,
    capturedAt,
    materializedWorkspace: materialized ? Boolean(materialized.applied) : false,
    runtimeSnapshotId: runtimeSnapshot?.snapshotId || null,
    runtimeSnapshotOriginNode: runtimeSnapshot?.originNodeId || sourceNode.nodeId || null,
    portableTemplateId: committedTemplate?.templateId || null,
    portableTemplateScope: committedTemplate?.distribution?.scope || [],
    directRestoredNodes: [...directRestores.values()].map((restore) => restore.nodeId || restore.nodeName).filter(Boolean),
    directMemoryRestoredNodes: [...directRestores.values()].filter((restore) => restore.capturesMemory).map((restore) => restore.nodeId || restore.nodeName).filter(Boolean),
    memoryContinuous: [...directRestores.values()].some((restore) => restore.continuousMemory === true),
    memoryCaptured: Boolean(runtimeSnapshot?.snapshotId) || [...directRestores.values()].some((restore) => restore.capturesMemory === true),
    reason: replicationStateReason(runtimeSnapshot, directRestores)
  };
  return {
    summary,
    stateForNode(node) {
      if (runtimeSnapshot?.snapshotId && nodeMatchesRuntimeSnapshot(node, runtimeSnapshot, sourceNode)) {
        return {
          mode: "runtime-snapshot",
          templateId: runtimeSnapshot.snapshotId,
          snapshotId: runtimeSnapshot.snapshotId,
          capturedAt,
          capturesMemory: true,
          continuousMemory: false,
          hydrateWorkspace: Boolean(materialized?.applied),
          workspaceSnapshotPath,
          reason: "runtime snapshot is local to this target node"
        };
      }
      if (committedTemplate?.templateId) {
        const directRestore = directRestores.get(nodeKey(node));
        if (directRestore) {
          const capturesMemory = directRestore.capturesMemory === true;
          return {
            mode: "direct-cubelet",
            templateId: committedTemplate.templateId,
            snapshotId: directRestore.snapshotId || directRestore.runtimeSnapshotId || committedTemplate.templateId,
            capturedAt,
            capturesMemory,
            continuousMemory: directRestore.continuousMemory === true,
            hydrateWorkspace: Boolean(materialized?.applied),
            workspaceSnapshotPath,
            directSandbox: directRestore.sandbox,
            executor: directRestore.executor,
            reason: capturesMemory
              ? "runtime memory and rootfs restored directly on the target cubelet"
              : "portable template state restored directly on the target cubelet"
          };
        }
        return {
          mode: "template-snapshot",
          templateId: committedTemplate.templateId,
          capturedAt,
          capturesMemory: false,
          continuousMemory: false,
          hydrateWorkspace: Boolean(materialized?.applied),
          workspaceSnapshotPath,
          reason: "portable AppSnapshot template distributed to the target node"
        };
      }
      return {
        mode: "definition",
        capturedAt,
        capturesMemory: false,
        continuousMemory: false,
        hydrateWorkspace: false,
        reason: "no runtime state capture was available"
      };
    }
  };
}

async function createDirectReplicaWorld(config, input, node, state) {
  const store = new WorldStore(config);
  const sandbox = state.directSandbox || {};
  const world = await store.create({
    ...input,
    status: "ready",
    sandbox: {
      id: sandbox.sandboxId || sandbox.id,
      containerId: sandbox.containerId || sandbox.sandboxId || sandbox.id,
      baseId: state.templateId || input.backendConfig?.template || config.cube?.template || null,
      runtime: "CubeSandbox",
      mode: "direct-cubelet",
      mountMode: input.backendConfig?.mountMode || "none",
      status: "running",
      reason: sandbox.reason || null,
      sandboxIp: sandbox.sandboxIp || sandbox.ip || null,
      runtimeSandboxIp: sandbox.runtimeSandboxIp || sandbox.sandboxIp || sandbox.ip || null,
      network: sandbox.network || null,
      bootstrap: { skipped: true, reason: "direct cubelet replica was restored by the target executor" }
    }
  });
  const request = buildCubeSandboxRequest(world, {
    ...config.cube,
    template: state.templateId || world.backendConfig?.template || config.cube?.template,
    cpu: world.backendConfig?.cpu || config.cube?.cpu,
    memory: world.backendConfig?.memory || config.cube?.memory,
    writableLayerSize: world.backendConfig?.writableLayerSize || config.cube?.writableLayerSize,
    networkType: world.backendConfig?.networkType || config.cube?.networkType,
    network: world.backendConfig?.network || null,
    kubernetes: world.backendConfig?.kubernetes || null,
    mountMode: world.backendConfig?.mountMode || "none"
  });
  world.backendConfig.cubeRequest = request;
  world.backendConfig.mountMap = {};
  world.backendConfig.replication = {
    ...(world.backendConfig.replication || {}),
    executor: state.executor,
    directRestore: state.directSandbox
  };
  world.labels = {
    ...(world.labels || {}),
    "kakurizai.replication.direct": "true"
  };
  return store.save(world);
}

async function restoreDirectReplicas(config, source, nodes, context) {
  const targets = nodes.filter((node) => !context.runtimeSnapshot || !nodeMatchesRuntimeSnapshot(node, context.runtimeSnapshot, context.sourceNode));
  const byNode = new Map();
  for (const node of targets) {
    const restoreCommand = resolveRestoreCommand(config, node, context.input);
    if (!restoreCommand) {
      return { restored: false, byNode, reason: "no direct restore command configured" };
    }
    const executor = resolveNodeExecutor(config, node, context.input);
    const contextPath = path.join(source.paths.logs, `direct-restore-${context.commit.templateId}-${nodeKey(node)}.json`);
    await writeJsonAtomic(contextPath, {
      version: 1,
      source: {
        id: source.id,
        name: source.name,
        sandboxId: source.sandbox?.containerId || source.sandbox?.id,
        node: context.sourceNode
      },
      target: node,
      executor,
      templateId: context.commit.templateId,
      runtimeSnapshotId: context.runtimeSnapshot?.snapshotId || null,
      capturedAt: context.capturedAt,
      cube: {
        namespace: config.cube?.namespace || "default",
        workspacePath: config.cube?.workspacePath || "/workspace"
      },
      createRequest: context.request,
      distributionFailure: {
        code: context.distribution?.code ?? null,
        reason: context.distribution?.reason || null
      }
    });
    const result = await runCommand("sh", ["-lc", restoreCommand], {
      allowFailure: true,
      env: {
        KAKURIZAI_REPLICATION_CONTEXT: contextPath,
        KAKURIZAI_TEMPLATE_ID: context.commit.templateId,
        KAKURIZAI_RUNTIME_SNAPSHOT_ID: context.runtimeSnapshot?.snapshotId || "",
        KAKURIZAI_SOURCE_SANDBOX_ID: source.sandbox?.containerId || source.sandbox?.id || "",
        KAKURIZAI_SOURCE_WORLD_ID: source.id,
        KAKURIZAI_TARGET_NODE_ID: node.nodeId || node.id || "",
        KAKURIZAI_TARGET_NODE_NAME: node.name || "",
        KAKURIZAI_TARGET_NODE_IP: node.ip || ""
      }
    });
    await writeJsonAtomic(path.join(source.paths.logs, `direct-restore-${context.commit.templateId}-${nodeKey(node)}.result.json`), {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr
    });
    if (result.code !== 0) {
      if (context.input.allowPartialState === true) continue;
      return { restored: false, byNode, reason: result.stderr || result.stdout || `direct restore exited with ${result.code}` };
    }
    const response = parseJsonFromOutput(`${result.stdout}\n${result.stderr}`) || {};
    const sandboxId = response.sandboxId || response.sandbox_id || response.containerId || response.id;
    if (!sandboxId) {
      if (context.input.allowPartialState === true) continue;
      return { restored: false, byNode, reason: "direct restore did not return sandboxId" };
    }
    byNode.set(nodeKey(node), {
      nodeId: node.nodeId || node.id,
      nodeName: node.name,
      executor,
      capturesMemory: boolFromResponse(response.capturesMemory ?? response.captures_memory ?? response.memoryCaptured ?? response.memory_captured, false),
      continuousMemory: boolFromResponse(response.continuousMemory ?? response.continuous_memory ?? response.memoryContinuous ?? response.memory_continuous, false),
      runtimeSnapshotId: cleanOptional(response.runtimeSnapshotId || response.runtime_snapshot_id),
      snapshotId: cleanOptional(response.snapshotId || response.snapshot_id || response.runtimeSnapshotId || response.runtime_snapshot_id || context.commit.templateId),
      sandbox: {
        ...response,
        sandboxId,
        containerId: response.containerId || response.container_id || sandboxId
      }
    });
  }
  return { restored: byNode.size === targets.length, byNode };
}

function replicationStateReason(runtimeSnapshot, directRestores) {
  const directMemory = [...directRestores.values()].filter((restore) => restore.capturesMemory === true);
  if (runtimeSnapshot?.snapshotId && directMemory.length) {
    return "runtime snapshot memory and rootfs captured; remote direct restores reported memory image restoration";
  }
  if (runtimeSnapshot?.snapshotId) {
    return "runtime snapshot captures rootfs and memory on the origin node; remote nodes need a direct restore hook that reports capturesMemory=true for memory failover";
  }
  return "portable template state captures current rootfs/writable state for remote nodes";
}

function boolFromResponse(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return fallback;
}

function definitionStatePlan(reason) {
  return {
    summary: {
      requestedMode: "definition",
      capturedAt: null,
      materializedWorkspace: false,
      runtimeSnapshotId: null,
      runtimeSnapshotOriginNode: null,
      portableTemplateId: null,
      portableTemplateScope: [],
      memoryCaptured: false,
      memoryContinuous: false,
      reason
    },
    stateForNode() {
      return {
        mode: "definition",
        capturesMemory: false,
        continuousMemory: false,
        hydrateWorkspace: false,
        reason
      };
    }
  };
}

async function resolveSourceNode(client, source) {
  const placement = source.backendConfig?.placement || {};
  const fallback = {
    nodeId: source.sandbox?.hostId || placement.nodeId || null,
    nodeIp: source.sandbox?.hostIp || source.sandbox?.runtimeHostIp || placement.nodeIp || null
  };
  try {
    const detail = await client.inspectWorldSandbox(source);
    return {
      nodeId: detail?.hostId || fallback.nodeId,
      nodeIp: detail?.hostIp || fallback.nodeIp
    };
  } catch {
    return fallback;
  }
}

function nodeMatchesRuntimeSnapshot(node, snapshot, sourceNode = {}) {
  const originNode = snapshot?.originNodeId || sourceNode.nodeId;
  const originIp = snapshot?.originNodeIp || sourceNode.nodeIp;
  return Boolean(
    (originNode && [node.id, node.nodeId, node.name].includes(originNode))
    || (originIp && [node.ip, node.publicHost].includes(originIp))
  );
}

function normalizeStateMode(value) {
  const mode = String(value || "stateful").trim().toLowerCase();
  if (["definition", "definition-only", "placement"].includes(mode)) return "definition";
  if (["runtime", "runtime-snapshot", "memory", "memory-snapshot"].includes(mode)) return "runtime-snapshot";
  if (["template", "template-snapshot", "portable", "writable-layer", "rootfs"].includes(mode)) return "template-snapshot";
  return "stateful";
}

function sourceCubeRequest(config, source) {
  if (source.backendConfig?.cubeRequest) return source.backendConfig.cubeRequest;
  return buildCubeSandboxRequest(source, {
    ...config.cube,
    template: source.backendConfig?.template || source.sandbox?.baseId || config.cube?.template,
    cpu: source.backendConfig?.cpu || config.cube?.cpu,
    memory: source.backendConfig?.memory || config.cube?.memory,
    writableLayerSize: source.backendConfig?.writableLayerSize || config.cube?.writableLayerSize,
    networkType: source.backendConfig?.networkType || config.cube?.networkType,
    network: source.backendConfig?.network || null,
    kubernetes: source.backendConfig?.kubernetes || null,
    mountMode: source.backendConfig?.mountMode || config.cube?.mountMode || "agctl-overlay"
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

function normalizeExecutor(value) {
  if (!value || typeof value !== "object") return null;
  const host = cleanOptional(value.host || value.sshHost || value.ssh_host);
  const container = cleanOptional(value.container || value.lxcContainer || value.lxc_container);
  const type = cleanOptional(value.type || (host && container ? "ssh-lxc" : (container ? "lxc" : null)));
  if (!type) return null;
  return {
    ...value,
    type,
    container,
    namespace: cleanOptional(value.namespace),
    cubecli: cleanOptional(value.cubecli),
    lxc: cleanOptional(value.lxc),
    host,
    user: cleanOptional(value.user || value.sshUser || value.ssh_user),
    key: cleanOptional(value.key || value.sshKey || value.ssh_key),
    ssh: cleanOptional(value.ssh)
  };
}

function normalizeNodeReplication(value) {
  if (!value || typeof value !== "object") return null;
  return {
    ...value,
    restoreCommand: cleanOptional(value.restoreCommand || value.restore_command),
    executor: normalizeExecutor(value.executor)
  };
}

function resolveRestoreCommand(config, node, input = {}) {
  return cleanOptional(
    input.restoreCommand
    || input.directRestoreCommand
    || node.replication?.restoreCommand
    || node.labels?.["kakurizai.replication.restoreCommand"]
    || config.cube?.replication?.restoreCommand
  );
}

function resolveNodeExecutor(config, node, input = {}) {
  return normalizeExecutor(
    input.executor
    || node.replication?.executor
    || node.executor
    || config.cube?.replication?.executor
  );
}

function nodeKey(node) {
  return cleanOptional(node.nodeId || node.id || node.name || node.ip) || "node";
}

function parseJsonFromOutput(output) {
  const text = String(output || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
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
