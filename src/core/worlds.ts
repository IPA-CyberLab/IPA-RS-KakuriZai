// @ts-nocheck
import fs from "node:fs/promises";
import path from "node:path";
import { getBackend } from "../backends/index.js";
import { applyNetworkToCubeRequest } from "../cube/request.js";
import { normalizeKubernetesConfig, normalizeNetworkConfig } from "./network.js";
import { WorldStore } from "./store.js";
import { openTarget } from "./openers.js";

export async function createWorld(config, input) {
  const store = new WorldStore(config);
  const backendName = input.backend || config.defaultBackend;
  const backend = getBackend(config, backendName);
  const hostMount = input.hostMount !== false && Boolean(input.sourcePath);
  const mountMode = hostMount ? input.mountMode || config.cube?.mountMode || "agctl-overlay" : "none";
  const network = normalizeNetworkConfig({
    ...(input.network || {}),
    type: input.network?.type || input.networkType || config.cube?.networkType || "tap"
  });
  const kubernetes = normalizeKubernetesConfig(input.kubernetes || input.k8s || {});
  const world = await store.create({
    name: input.name,
    sourcePath: input.sourcePath,
    backend: backendName,
    status: "creating",
    labels: {
      ...(input.labels || {}),
      "kakurizai.mountMode": mountMode,
      "kakurizai.hostMount": String(hostMount),
      "kakurizai.network.type": network.type,
      "kakurizai.kubernetes": String(kubernetes.enabled)
    },
    backendConfig: {
      hostMount,
      mountMode,
      template: input.template || config.cube?.template || null,
      cpu: input.cpu || config.cube?.cpu || null,
      memory: input.memory || config.cube?.memory || null,
      writableLayerSize: input.writableLayerSize || config.cube?.writableLayerSize || null,
      networkType: network.type,
      network,
      kubernetes
    }
  });
  try {
    return await backend.afterCreate(world, store);
  } catch (error) {
    world.status = "failed";
    world.sandbox = {
      id: null,
      baseId: null,
      runtime: backendName,
      status: "failed",
      reason: error.message
    };
    await store.save(world);
    throw error;
  }
}

export async function updateWorldConfig(config, ref, input = {}) {
  const store = new WorldStore(config);
  const world = await store.get(ref);
  world.backendConfig = world.backendConfig || {};
  if (input.template !== undefined) {
    world.backendConfig.template = input.template || null;
    updateCubeRequestTemplate(world, world.backendConfig.template);
  }
  if (input.cpu !== undefined) {
    world.backendConfig.cpu = cleanRequired(input.cpu, "cpu");
    updateCubeRequestResources(world);
  }
  if (input.memory !== undefined) {
    world.backendConfig.memory = cleanRequired(input.memory, "memory");
    updateCubeRequestResources(world);
  }
  if (input.writableLayerSize !== undefined) {
    const writableLayerSize = normalizeSize(input.writableLayerSize, "writableLayerSize");
    world.backendConfig.writableLayerSize = writableLayerSize;
    updateCubeRequestWritableLayer(world, writableLayerSize);
  }
  if (input.networkType !== undefined) {
    world.backendConfig.network = normalizeNetworkConfig({
      ...(world.backendConfig.network || {}),
      type: input.networkType
    });
    world.backendConfig.networkType = world.backendConfig.network.type;
  }
  if (input.network !== undefined) {
    world.backendConfig.network = normalizeNetworkConfig({
      ...(world.backendConfig.network || {}),
      ...input.network
    });
    world.backendConfig.networkType = world.backendConfig.network.type;
  }
  if (input.kubernetes !== undefined || input.k8s !== undefined) {
    world.backendConfig.kubernetes = normalizeKubernetesConfig(input.kubernetes || input.k8s || {});
  }
  if (input.network !== undefined || input.networkType !== undefined || input.kubernetes !== undefined || input.k8s !== undefined) {
    updateCubeRequestNetwork(world);
  }
  if (input.hostMount !== undefined) {
    world.backendConfig.hostMount = Boolean(input.hostMount);
  }
  if (input.sourcePath !== undefined && input.hostMount !== false) {
    const sourcePath = path.resolve(input.sourcePath);
    const sourceStat = await fs.stat(sourcePath);
    if (!sourceStat.isDirectory()) {
      throw new Error(`source path is not a directory: ${sourcePath}`);
    }
    world.sourcePath = sourcePath;
  }
  if (input.mountMode !== undefined) {
    world.backendConfig.mountMode = String(input.mountMode || "none").trim() || "none";
  }
  await store.save(world);
  return {
    world,
    appliedToRunningSandbox: false,
    reason: "CubeSandbox open-source CLI does not support live network or disk mutation; saved for next sandbox create or recreate."
  };
}

export async function upsertWorldFromManifest(config, manifest) {
  const { manifestToCreateInput } = await import("./spec.js");
  const input = manifestToCreateInput(manifest);
  const existing = (await listWorlds(config)).find((world) => world.name === input.name);
  if (!existing) {
    return { action: "created", world: await createWorld(config, input) };
  }
  const result = await updateWorldConfig(config, existing.id, input);
  return { action: "updated", ...result };
}

export async function listWorlds(config) {
  return new WorldStore(config).list();
}

export async function getWorld(config, ref) {
  return new WorldStore(config).get(ref);
}

export async function removeWorld(config, ref, options = {}) {
  const store = new WorldStore(config);
  const world = await store.get(ref, options);
  const backend = getBackend(config, world.backend);
  await backend.remove(world);
  return store.remove(world.id, { exactId: true });
}

export async function execWorld(config, ref, command, options = {}) {
  const store = new WorldStore(config);
  const world = await store.get(ref);
  const backend = getBackend(config, world.backend);
  return backend.exec(world, command, options);
}

export async function openWorld(config, ref, target) {
  const store = new WorldStore(config);
  const world = await store.get(ref);
  const pid = openTarget(world, target);
  return { world, pid };
}

export async function applyWorld(config, ref, options = {}) {
  return new WorldStore(config).apply(ref, options);
}

export async function changedPaths(config, ref) {
  return new WorldStore(config).changedPaths(ref);
}

function normalizeSize(value, name) {
  const normalized = String(value || "").trim().replace(/\s+/g, "");
  if (!/^\d+(?:\.\d+)?(?:[KMGTP]i?B?|[kmgtp]i?B?)$/.test(normalized)) {
    throw new Error(`${name} must look like 1G, 2048M, or 10GiB`);
  }
  return normalized;
}

function cleanRequired(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function updateCubeRequestWritableLayer(world, writableLayerSize) {
  const request = world.backendConfig?.cubeRequest;
  if (!request) return;
  request.annotations = {
    ...(request.annotations || {}),
    "cube.master.rootfs.writable_layer_size": writableLayerSize
  };
  for (const container of request.containers || []) {
    container.annotations = {
      ...(container.annotations || {}),
      "cube.master.rootfs.writable_layer_size": writableLayerSize
    };
  }
}

function updateCubeRequestResources(world) {
  const request = world.backendConfig?.cubeRequest;
  if (!request) return;
  for (const container of request.containers || []) {
    container.resources = {
      ...(container.resources || {}),
      cpu: world.backendConfig.cpu || container.resources?.cpu || "2000m",
      mem: world.backendConfig.memory || container.resources?.mem || "2000Mi"
    };
  }
}

function updateCubeRequestTemplate(world, template) {
  const request = world.backendConfig?.cubeRequest;
  if (!request || !template) return;
  request.annotations = {
    ...(request.annotations || {}),
    "cube.master.appsnapshot.template.id": template
  };
}

function updateCubeRequestNetwork(world) {
  const request = world.backendConfig?.cubeRequest;
  if (!request) return;
  applyNetworkToCubeRequest(
    request,
    world.backendConfig.network || { type: world.backendConfig.networkType || "tap" },
    world.backendConfig.kubernetes || {}
  );
}
