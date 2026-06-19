import { getBackend } from "../backends/index.js";
import { WorldStore } from "./store.js";
import { openTarget } from "./openers.js";

export async function createWorld(config, input) {
  const store = new WorldStore(config);
  const backendName = input.backend || config.defaultBackend;
  const backend = getBackend(config, backendName);
  const world = await store.create({
    name: input.name,
    sourcePath: input.sourcePath,
    backend: backendName,
    status: "creating",
    labels: input.labels
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

export async function listWorlds(config) {
  return new WorldStore(config).list();
}

export async function removeWorld(config, ref) {
  const store = new WorldStore(config);
  const world = await store.get(ref);
  const backend = getBackend(config, world.backend);
  await backend.remove(world);
  return store.remove(ref);
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
