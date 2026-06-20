import { CubeSandboxClient } from "../cube/client.js";
import { buildCubeSandboxRequest } from "../cube/request.js";

export class CubeSandboxOverlayBackend {
  name = "cube-sandbox-overlay";

  constructor(config) {
    this.config = config;
    this.client = new CubeSandboxClient(config.cube);
  }

  async afterCreate(world, store) {
    const request = buildCubeSandboxRequest(world, this.config.cube);
    world.backendConfig.cubeRequest = request;
    world.backendConfig.mounts = {
      lower: { hostPath: world.sourcePath, sandboxPath: "/kakurizai/lower", readonly: true },
      upper: { hostPath: world.paths.upper, sandboxPath: "/kakurizai/upper", readonly: false },
      workdir: { hostPath: world.paths.workdir, sandboxPath: "/kakurizai/work", readonly: false },
      whiteouts: { hostPath: world.paths.whiteouts, sandboxPath: "/kakurizai/whiteouts", readonly: false },
      workspace: this.config.cube.workspacePath || "/workspace"
    };
    const provision = await this.client.createSandbox(world, request);
    world.sandbox = {
      id: provision.sandboxId || null,
      containerId: provision.containerId || null,
      baseId: this.config.cube.template || "kakurizai-base",
      runtime: "CubeSandbox",
      mode: provision.mode,
      status: provision.provisioned && provision.overlay?.mounted === false ? "running-overlay-pending" : provision.provisioned ? "running" : "planned",
      reason: provision.reason || provision.overlay?.reason || null,
      overlay: provision.overlay || null
    };
    world.status = provision.provisioned && provision.overlay?.mounted === false ? "pending-overlay" : provision.provisioned ? "ready" : "pending-cube";
    return store.save(world);
  }

  async remove(world) {
    return this.client.destroySandbox(world);
  }

  async exec(world, command, options = {}) {
    return this.client.exec(world, command, options);
  }
}
