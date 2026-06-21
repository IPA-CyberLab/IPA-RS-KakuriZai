// @ts-nocheck
import fs from "node:fs/promises";
import path from "node:path";
import { getBackend } from "../backends/index.js";
import { applyNetworkToCubeRequest, writableLayerAnnotations } from "../cube/request.js";
import { normalizeHostMounts, primaryMount } from "./mounts.js";
import { normalizeKubernetesConfig, normalizeNetworkConfig } from "./network.js";
import { WorldStore } from "./store.js";
import { openTarget } from "./openers.js";

export async function createWorld(config, input) {
  const store = new WorldStore(config);
  const backendName = input.backend || config.defaultBackend;
  const backend = getBackend(config, backendName);
  const requestedMounts = Array.isArray(input.mounts) && input.mounts.length
    ? input.mounts
    : input.sourcePath
      ? [{ sourcePath: input.sourcePath, name: input.mountName, mode: input.mountMode }]
      : [];
  const hostMount = input.hostMount !== false && requestedMounts.length > 0;
  const mountMode = hostMount ? input.mountMode || config.cube?.mountMode || "agctl-overlay" : "none";
  const network = normalizeNetworkConfig({
    ...(input.network || {}),
    type: input.network?.type || input.networkType || config.cube?.networkType || "tap"
  });
  const kubernetes = normalizeKubernetesConfig(input.kubernetes || input.k8s || {});
  const writableLayerSize = input.writableLayerSize || config.cube?.writableLayerSize || null;
  const world = await store.create({
    name: input.name,
    sourcePath: input.sourcePath || requestedMounts[0]?.sourcePath,
    backend: backendName,
    status: "creating",
    labels: {
      ...(input.labels || {}),
      "kakurizai.mountMode": mountMode,
      "kakurizai.hostMount": String(hostMount),
      "kakurizai.network.type": network.type,
      "kakurizai.kubernetes": String(kubernetes.enabled),
      ...(kubernetes.enabled ? {
        "kakurizai.kubernetes.cluster": kubernetes.clusterName,
        "kakurizai.kubernetes.nodeRole": kubernetes.nodeRole
      } : {})
    },
    backendConfig: {
      hostMount,
      mountMode,
      mounts: hostMount ? requestedMounts : [],
      template: input.template || config.cube?.template || null,
      cpu: input.cpu || config.cube?.cpu || null,
      memory: input.memory || config.cube?.memory || null,
      writableLayerSize,
      writableLayerMinimumSize: writableLayerSize,
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

export async function createKubernetesLab(config, input = {}) {
  const labName = cleanLabName(input.name || input.clusterName || "kakurizai-lab");
  const controlPlanes = clampCount(input.controlPlanes ?? input.controlPlaneCount ?? 1, "controlPlanes", { min: 1 });
  const workers = clampCount(input.workers ?? input.workerCount ?? 2, "workers");
  const profile = input.profile || input.kubernetes?.profile || "k3s";
  const apiServerPort = Number(input.apiServerPort || input.kubernetes?.apiServerPort || 6443);
  const nodePorts = input.nodePorts || input.kubernetes?.nodePorts || [30000, 30001];
  const joinEndpoint = input.joinEndpoint || `https://${labName}-cp-1:${apiServerPort}`;
  const sharedNetwork = {
    type: "tap",
    mode: "tap",
    exposedPorts: [apiServerPort, ...nodePorts],
    ...(input.network || {})
  };
  const baseInput = {
    backend: input.backend || "cube-sandbox-overlay",
    hostMount: input.hostMount === true,
    mounts: input.hostMount === true ? input.mounts : undefined,
    sourcePath: input.hostMount === true ? input.sourcePath : undefined,
    mountMode: input.hostMount === true ? input.mountMode : "none",
    cpu: input.cpu,
    memory: input.memory,
    writableLayerSize: input.writableLayerSize,
    networkType: "tap",
    network: sharedNetwork
  };
  const created = [];
  for (let index = 1; index <= controlPlanes; index += 1) {
    created.push(await createWorld(config, {
      ...baseInput,
      name: `${labName}-cp-${index}`,
      kubernetes: kubernetesNodeConfig(input, {
        enabled: true,
        profile,
        clusterName: labName,
        nodeRole: "control-plane",
        nodeName: `${labName}-cp-${index}`,
        apiServerPort,
        nodePorts,
        joinEndpoint: index === 1 ? input.joinEndpoint || "" : joinEndpoint
      }),
      labels: labLabels(input.labels, labName, "control-plane", index)
    }));
  }
  for (let index = 1; index <= workers; index += 1) {
    created.push(await createWorld(config, {
      ...baseInput,
      name: `${labName}-worker-${index}`,
      kubernetes: kubernetesNodeConfig(input, {
        enabled: true,
        profile,
        clusterName: labName,
        nodeRole: "worker",
        nodeName: `${labName}-worker-${index}`,
        apiServerPort,
        nodePorts,
        joinEndpoint
      }),
      labels: labLabels(input.labels, labName, "worker", index)
    }));
  }
  return {
    lab: {
      name: labName,
      clusterName: labName,
      controlPlanes,
      workers,
      joinEndpoint
    },
    worlds: created
  };
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
    assertWritableLayerCanGrow(world, writableLayerSize, { requireIncrease: input.recreate === true });
    world.backendConfig.writableLayerMinimumSize = maxSizeLabel([
      world.backendConfig.writableLayerMinimumSize,
      world.backendConfig.writableLayerSize,
      cubeRequestWritableLayerSize(world)
    ]) || writableLayerSize;
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
  if (input.mounts !== undefined) {
    const mounts = normalizeHostMounts({
      hostMount: input.hostMount ?? world.backendConfig.hostMount,
      sourcePath: input.sourcePath ?? world.sourcePath,
      mountMode: input.mountMode ?? world.backendConfig.mountMode,
      mounts: input.mounts
    }, {
      workspacePath: config.cube?.workspacePath
    });
    for (const mount of mounts) {
      const sourceStat = await fs.stat(mount.sourcePath);
      if (!sourceStat.isDirectory()) {
        throw new Error(`source path is not a directory: ${mount.sourcePath}`);
      }
    }
    const modes = [...new Set(mounts.map((mount) => mount.mode))];
    world.backendConfig.mounts = mounts;
    world.backendConfig.hostMount = mounts.length > 0;
    world.backendConfig.mountMode = mounts.length ? (modes.length === 1 ? modes[0] : "mixed") : "none";
    const primary = primaryMount(mounts);
    if (primary) world.sourcePath = primary.sourcePath;
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
    if (Array.isArray(world.backendConfig.mounts)) {
      world.backendConfig.mounts = world.backendConfig.mounts.map((mount) => ({
        ...mount,
        mode: world.backendConfig.mountMode === "mixed" ? mount.mode : world.backendConfig.mountMode
      }));
    }
  }
  await store.save(world);
  if (input.recreate === true) {
    const recreated = await recreateSavedWorld(config, store, world);
    const networkChanged = input.network !== undefined || input.networkType !== undefined || input.kubernetes !== undefined || input.k8s !== undefined;
    return {
      world: recreated,
      appliedToRunningSandbox: true,
      recreated: true,
      reason: networkChanged
        ? "CubeSandbox does not expose safe live network mutation; the sandbox was recreated with the requested network settings."
        : "CubeSandbox does not expose a safe live writable-layer resize; the sandbox was recreated with the requested disk size."
    };
  }
  return {
    world,
    appliedToRunningSandbox: false,
    reason: "CubeSandbox open-source CLI does not support live network or disk mutation; saved for next sandbox create or recreate."
  };
}

function kubernetesNodeConfig(input, defaults) {
  return normalizeKubernetesConfig({
    ...(input.kubernetes || {}),
    enabled: true,
    profile: defaults.profile,
    clusterName: defaults.clusterName,
    nodeRole: defaults.nodeRole,
    nodeName: defaults.nodeName,
    cni: input.cni || input.kubernetes?.cni,
    podCidr: input.podCidr || input.kubernetes?.podCidr,
    serviceCidr: input.serviceCidr || input.kubernetes?.serviceCidr,
    joinEndpoint: defaults.joinEndpoint,
    joinToken: input.joinToken || input.kubernetes?.joinToken,
    advertiseAddress: input.advertiseAddress || input.kubernetes?.advertiseAddress,
    extraArgs: input.extraArgs || input.kubernetes?.extraArgs,
    sysctls: input.sysctls || input.kubernetes?.sysctls,
    apiServerPort: defaults.apiServerPort,
    nodePorts: defaults.nodePorts
  });
}

function labLabels(labels = {}, labName, role, index) {
  return {
    ...(labels || {}),
    "kakurizai.lab": labName,
    "kakurizai.kubernetes.cluster": labName,
    "kakurizai.kubernetes.nodeRole": role,
    "kakurizai.kubernetes.nodeIndex": String(index)
  };
}

function cleanLabName(value) {
  const name = String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) throw new Error("lab name is required");
  return name;
}

function clampCount(value, name, options = {}) {
  const number = Number(value);
  const min = options.min ?? 0;
  if (!Number.isInteger(number) || number < min || number > 20) {
    throw new Error(`${name} must be an integer between ${min} and 20`);
  }
  return number;
}

async function recreateSavedWorld(config, store, world) {
  const backend = getBackend(config, world.backend);
  if (world.sandbox?.id) {
    const removal = await backend.remove(world);
    if (removal?.skipped) {
      throw new Error(`cannot recreate sandbox: ${removal.reason || "remove skipped"}`);
    }
    if (typeof removal?.code === "number" && removal.code !== 0) {
      throw new Error(`cannot recreate sandbox: ${removal.stderr || removal.stdout || `remove exited with ${removal.code}`}`);
    }
  }
  world.status = "creating";
  world.sandbox = {
    ...(world.sandbox || {}),
    id: null,
    containerId: null,
    status: "recreating",
    reason: "recreating sandbox to apply disk/configuration changes"
  };
  await store.save(world);
  return backend.afterCreate(world, store);
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

export async function pauseWorld(config, ref) {
  const store = new WorldStore(config);
  const world = await store.get(ref);
  const backend = getBackend(config, world.backend);
  if (typeof backend.pause !== "function") throw new Error(`backend ${world.backend} does not support pause`);
  const result = await backend.pause(world);
  if (result.applied) {
    world.status = "paused";
    world.sandbox = {
      ...(world.sandbox || {}),
      status: "paused",
      pausedAt: new Date().toISOString(),
      reason: null
    };
  } else {
    world.sandbox = {
      ...(world.sandbox || {}),
      reason: result.reason || "pause failed"
    };
  }
  await store.save(world);
  return { ...result, world };
}

export async function resumeWorld(config, ref) {
  const store = new WorldStore(config);
  const world = await store.get(ref);
  const backend = getBackend(config, world.backend);
  if (typeof backend.resume !== "function") throw new Error(`backend ${world.backend} does not support resume`);
  const result = await backend.resume(world);
  if (result.applied) {
    world.status = "ready";
    world.sandbox = {
      ...(world.sandbox || {}),
      status: "running",
      pausedAt: null,
      reason: null
    };
  } else {
    world.sandbox = {
      ...(world.sandbox || {}),
      reason: result.reason || "resume failed"
    };
  }
  await store.save(world);
  return { ...result, world };
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

function assertWritableLayerCanGrow(world, nextSize, options = {}) {
  const minimumSize = maxSizeLabel([
    world.backendConfig?.writableLayerMinimumSize,
    world.backendConfig?.writableLayerSize,
    cubeRequestWritableLayerSize(world)
  ]);
  if (!minimumSize) return;
  const nextBytes = sizeToBytes(nextSize);
  const minimumBytes = sizeToBytes(minimumSize);
  if (nextBytes < minimumBytes || (options.requireIncrease && nextBytes <= minimumBytes)) {
    throw statusError(`writableLayerSize must be larger than the current/original size ${minimumSize}`, 400);
  }
}

function statusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function cubeRequestWritableLayerSize(world) {
  return world.backendConfig?.cubeRequest?.annotations?.["cube.master.rootfs.writable_layer_size"]
    || world.backendConfig?.cubeRequest?.containers?.[0]?.annotations?.["cube.master.rootfs.writable_layer_size"]
    || cubeRequestWritableLayerVolumeSize(world.backendConfig?.cubeRequest)
    || null;
}

function cubeRequestWritableLayerVolumeSize(request) {
  const volume = (request?.volumes || []).find((item) => item?.name === "cube_rootfs_rw");
  const emptyDir = volume?.volume_source?.empty_dir;
  return emptyDir?.size_limit || emptyDir?.SizeLimit || null;
}

function maxSizeLabel(values) {
  let best = null;
  for (const value of values || []) {
    if (!value) continue;
    const size = normalizeSize(value, "size");
    if (!best || sizeToBytes(size) > sizeToBytes(best)) best = size;
  }
  return best;
}

function sizeToBytes(value) {
  const match = /^(\d+(?:\.\d+)?)([KMGTP])i?B?$/i.exec(String(value || "").trim());
  if (!match) throw new Error(`invalid size: ${value}`);
  const power = { K: 1, M: 2, G: 3, T: 4, P: 5 }[match[2].toUpperCase()];
  return Number(match[1]) * 1024 ** power;
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
    ...writableLayerAnnotations(writableLayerSize)
  };
  request.volumes = request.volumes || [];
  let rootfsVolume = request.volumes.find((volume) => volume?.name === "cube_rootfs_rw");
  if (!rootfsVolume) {
    rootfsVolume = {
      name: "cube_rootfs_rw",
      volume_source: {
        empty_dir: {}
      }
    };
    request.volumes.unshift(rootfsVolume);
  }
  rootfsVolume.volume_source = rootfsVolume.volume_source || {};
  rootfsVolume.volume_source.empty_dir = {
    ...(rootfsVolume.volume_source.empty_dir || {}),
    size_limit: writableLayerSize
  };
  for (const container of request.containers || []) {
    container.annotations = {
      ...(container.annotations || {}),
      "cube.master.rootfs.writable_layer_size": writableLayerSize
    };
    container.volume_mounts = container.volume_mounts || [];
    if (!container.volume_mounts.some((mount) => mount?.name === "cube_rootfs_rw" && mount?.container_path === "/")) {
      container.volume_mounts.unshift({ name: "cube_rootfs_rw", container_path: "/" });
    }
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
