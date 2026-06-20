// @ts-nocheck
import { CubeSandboxClient } from "../cube/client.js";
import { buildCubeSandboxRequest } from "../cube/request.js";

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
    world.backendConfig.cubeRequest = request;
    world.backendConfig.mountMode = mountMode;
    world.backendConfig.mounts = mountMapForMode(world, mountMode, this.config.cube.workspacePath || "/workspace");
    const provision = await this.client.createSandbox(world, request);
    const overlayPending = mountMode === "agctl-overlay" && provision.provisioned && provision.overlay?.mounted === false;
    world.sandbox = {
      id: provision.sandboxId || null,
      containerId: provision.containerId || null,
      baseId: cubeConfig.template || "kakurizai-base",
      runtime: "CubeSandbox",
      mode: provision.mode,
      mountMode,
      status: overlayPending ? "running-overlay-pending" : provision.provisioned ? "running" : "planned",
      reason: provision.reason || provision.overlay?.reason || null,
      overlay: provision.overlay || null
    };
    world.status = overlayPending ? "pending-overlay" : provision.provisioned ? "ready" : "pending-cube";
    return store.save(world);
  }

  async remove(world) {
    return this.client.destroySandbox(world);
  }

  async exec(world, command, options = {}) {
    return this.client.exec(world, command, options);
  }
}

function mountMapForMode(world, mountMode, workspacePath) {
  if (mountMode === "none") {
    return {};
  }
  if (mountMode === "cubesandbox-readonly" || mountMode === "unsafe-rw") {
    return {
      workspace: {
        hostPath: world.sourcePath,
        sandboxPath: workspacePath,
        readonly: mountMode === "cubesandbox-readonly",
        mode: mountMode
      }
    };
  }
  return {
    lower: { hostPath: world.sourcePath, sandboxPath: "/kakurizai/lower", readonly: true },
    upper: { hostPath: world.paths.upper, sandboxPath: "/kakurizai/upper", readonly: false },
    workdir: { hostPath: world.paths.workdir, sandboxPath: "/kakurizai/work", readonly: false },
    whiteouts: { hostPath: world.paths.whiteouts, sandboxPath: "/kakurizai/whiteouts", readonly: false },
    workspace: workspacePath
  };
}
