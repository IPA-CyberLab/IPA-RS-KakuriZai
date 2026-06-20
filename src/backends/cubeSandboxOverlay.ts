// @ts-nocheck
import { CubeSandboxClient } from "../cube/client.js";
import { buildCubeSandboxRequest, mountSpecsForWorld } from "../cube/request.js";

export class CubeSandboxOverlayBackend {
  name = "cube-sandbox-overlay";

  constructor(config) {
    this.config = config;
    this.client = new CubeSandboxClient(config.cube);
  }

  async afterCreate(world, store) {
    const mountMode = world.backendConfig?.mountMode || this.config.cube.mountMode || "agctl-overlay";
    const cubeConfig = {
      ...this.config.cube,
      template: world.backendConfig?.template || this.config.cube.template,
      cpu: world.backendConfig?.cpu || this.config.cube.cpu,
      memory: world.backendConfig?.memory || this.config.cube.memory,
      writableLayerSize: world.backendConfig?.writableLayerSize || this.config.cube.writableLayerSize,
      networkType: world.backendConfig?.networkType || this.config.cube.networkType,
      network: world.backendConfig?.network || null,
      kubernetes: world.backendConfig?.kubernetes || null,
      mountMode
    };
    const request = buildCubeSandboxRequest(world, cubeConfig);
    const mountSpecs = mountSpecsForWorld(world, cubeConfig);
    world.backendConfig.cubeRequest = request;
    world.backendConfig.mountMode = mountMode;
    world.backendConfig.mounts = mountSpecs.map((mount) => ({
      id: mount.id,
      name: mount.name,
      sourcePath: mount.sourcePath,
      sandboxPath: mount.sandboxPath,
      mode: mount.mode
    }));
    world.backendConfig.mountMap = mountMapForMode(world, mountSpecs);
    const provision = await this.client.createSandbox(world, request);
    const overlayPending = provision.provisioned && provision.overlay?.mounted === false;
    world.sandbox = {
      id: provision.sandboxId || null,
      containerId: provision.containerId || null,
      baseId: cubeConfig.template || "kakurizai-base",
      runtime: "CubeSandbox",
      mode: provision.mode,
      mountMode,
      status: overlayPending ? "running-overlay-pending" : provision.provisioned ? "running" : "planned",
      reason: provision.reason || provision.overlay?.reason || null,
      overlay: provision.overlay || null,
      bootstrap: provision.provisioned
        ? { pending: true, skipped: false, applied: false, reason: "installing terminal tools in background" }
        : null
    };
    world.status = overlayPending ? "pending-overlay" : provision.provisioned ? "ready" : "pending-cube";
    const saved = await store.save(world);
    if (provision.provisioned) {
      this.bootstrapToolsInBackground(saved, store, provision.sandboxId || provision.containerId);
    }
    return saved;
  }

  bootstrapToolsInBackground(world, store, sandboxId) {
    this.client.bootstrapSandboxTools(world, sandboxId)
      .then(async (bootstrap) => {
        const latest = await store.get(world.id, { exactId: true });
        if (latest.sandbox?.id !== world.sandbox?.id) return;
        latest.sandbox = {
          ...(latest.sandbox || {}),
          bootstrap
        };
        await store.save(latest);
      })
      .catch(async (error) => {
        try {
          const latest = await store.get(world.id, { exactId: true });
          if (latest.sandbox?.id !== world.sandbox?.id) return;
          latest.sandbox = {
            ...(latest.sandbox || {}),
            bootstrap: {
              pending: false,
              skipped: false,
              applied: false,
              reason: error.message || String(error)
            }
          };
          await store.save(latest);
        } catch {
          // Nothing useful to do if metadata disappeared while bootstrap was running.
        }
      });
  }

  async remove(world) {
    return this.client.destroySandbox(world);
  }

  async pause(world) {
    return this.client.pauseSandbox(world);
  }

  async resume(world) {
    return this.client.resumeSandbox(world);
  }

  async exec(world, command, options = {}) {
    return this.client.exec(world, command, options);
  }
}

function mountMapForMode(world, mounts) {
  const result = {};
  for (const mount of mounts) {
    result[mount.id] = {
      name: mount.name,
      hostPath: mount.sourcePath,
      sandboxPath: mount.sandboxPath,
      readonly: mount.mode !== "unsafe-rw",
      mode: mount.mode,
      lower: mount.mode === "agctl-overlay" ? mount.lower : null,
      upper: mount.mode === "agctl-overlay" ? mount.upper : null,
      workdir: mount.mode === "agctl-overlay" ? mount.work : null,
      whiteouts: mount.mode === "agctl-overlay" ? mount.whiteouts : null
    };
  }
  if (mounts.some((mount) => mount.mode === "agctl-overlay")) {
    result.kakurizaiStorage = {
      upper: world.paths.upper,
      workdir: world.paths.workdir,
      whiteouts: world.paths.whiteouts
    };
  }
  return result;
}
