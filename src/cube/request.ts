// @ts-nocheck
import {
  cubeNetworkPolicy,
  effectiveNetworkConfig,
  normalizeKubernetesConfig,
  normalizeNetworkConfig
} from "../core/network.js";

export function buildCubeSandboxRequest(world, cubeConfig = {}) {
  const workspace = cubeConfig.workspacePath || "/workspace";
  const mountMode = cubeConfig.mountMode || world.backendConfig?.mountMode || "agctl-overlay";
  const network = normalizeNetworkConfig({
    type: cubeConfig.networkType || world.backendConfig?.networkType || "tap",
    ...(world.backendConfig?.network || {}),
    ...(cubeConfig.network || {})
  });
  const kubernetes = normalizeKubernetesConfig(cubeConfig.kubernetes || world.backendConfig?.kubernetes || {});
  const lower = "/kakurizai/lower";
  const upper = "/kakurizai/upper";
  const work = "/kakurizai/work";
  const whiteouts = "/kakurizai/whiteouts";
  const workspaceArg = shellQuote(workspace);
  const setup = setupCommandForMountMode(mountMode, { workspaceArg, lower, upper, work, whiteouts });
  const volumes = volumesForMountMode(mountMode, world);
  const volumeMounts = volumeMountsForMountMode(mountMode, world, { workspace, lower, upper, work, whiteouts });
  const request = {
    requestID: `kakurizai-${world.id}`,
    volumes,
    containers: [
      {
        name: "workspace",
        image: cubeConfig.image ? { image: cubeConfig.image } : undefined,
        command: ["/bin/sh", "-lc"],
        args: [setup],
        working_dir: workspace,
        resources: {
          cpu: cubeConfig.cpu || "2000m",
          mem: cubeConfig.memory || "2000Mi"
        },
        volume_mounts: volumeMounts,
        annotations: {
          "kakurizai.workspace": workspace,
          "kakurizai.world": world.id,
          "kakurizai.mountMode": mountMode,
          "kakurizai.kubernetes": String(kubernetes.enabled),
          "kakurizai.kubernetes.profile": kubernetes.profile,
          ...(cubeConfig.writableLayerSize ? { "cube.master.rootfs.writable_layer_size": cubeConfig.writableLayerSize } : {})
        }
      }
    ],
    annotations: {
      "kakurizai.backend": "cube-sandbox-overlay",
      "kakurizai.world": world.id,
      "kakurizai.source": world.sourcePath,
      "kakurizai.upper": world.paths.upper,
      "kakurizai.workspace": workspace,
      "kakurizai.mountMode": mountMode,
      "kakurizai.hostMount": String(mountMode !== "none"),
      "kakurizai.kubernetes": String(kubernetes.enabled),
      "kakurizai.kubernetes.profile": kubernetes.profile,
      "cube.master.appsnapshot.template.id": cubeConfig.template || "kakurizai-base",
      "cube.master.appsnapshot.template.version": cubeConfig.templateVersion || "v2",
      ...(cubeConfig.writableLayerSize ? { "cube.master.rootfs.writable_layer_size": cubeConfig.writableLayerSize } : {})
    },
    labels: {
      "app.kubernetes.io/managed-by": "kakurizai",
      "kakurizai.world": world.id
    },
    instance_type: cubeConfig.instanceType || "cubebox",
    network_type: network.type || "tap",
    namespace: cubeConfig.namespace || "kakurizai"
  };
  return applyNetworkToCubeRequest(request, network, kubernetes);
}

export function applyNetworkToCubeRequest(request, networkInput = {}, kubernetesInput = {}) {
  const kubernetes = normalizeKubernetesConfig(kubernetesInput);
  const network = effectiveNetworkConfig(networkInput, kubernetes);
  request.network_type = network.type || "tap";
  request.exposed_ports = network.exposedPorts;
  request.annotations = {
    ...(request.annotations || {}),
    "kakurizai.network.type": request.network_type,
    "kakurizai.kubernetes": String(kubernetes.enabled),
    "kakurizai.kubernetes.profile": kubernetes.profile
  };
  if (network.exposedPorts.length) {
    request.annotations["com.exposed_ports"] = network.exposedPorts.join(":");
  } else {
    delete request.annotations["com.exposed_ports"];
  }
  const policy = cubeNetworkPolicy(network);
  if (policy) request.cube_network_config = policy;
  else delete request.cube_network_config;

  for (const container of request.containers || []) {
    container.annotations = {
      ...(container.annotations || {}),
      "kakurizai.network.type": request.network_type,
      "kakurizai.kubernetes": String(kubernetes.enabled),
      "kakurizai.kubernetes.profile": kubernetes.profile
    };
    if (network.dns.servers.length || network.dns.searches.length || network.dns.options.length) {
      container.dns_config = {
        servers: network.dns.servers,
        searches: network.dns.searches,
        options: network.dns.options
      };
    } else {
      delete container.dns_config;
    }
    if (kubernetes.enabled) {
      container.security_context = {
        ...(container.security_context || {}),
        privileged: true
      };
      container.sysctls = {
        ...(container.sysctls || {}),
        ...kubernetes.sysctls
      };
    }
  }
  return request;
}

function setupCommandForMountMode(mountMode, paths) {
  if (mountMode === "agctl-overlay") {
    return [
      "set -eu",
      `mkdir -p ${paths.workspaceArg} ${paths.lower} ${paths.upper} ${paths.work} ${paths.whiteouts}`,
      `mount -t overlay overlay -o lowerdir=${paths.lower},upperdir=${paths.upper},workdir=${paths.work} ${paths.workspaceArg} || fuse-overlayfs -o lowerdir=${paths.lower},upperdir=${paths.upper},workdir=${paths.work} ${paths.workspaceArg}`,
      "tail -f /dev/null"
    ].join("; ");
  }
  return ["set -eu", `mkdir -p ${paths.workspaceArg}`, "tail -f /dev/null"].join("; ");
}

function volumesForMountMode(mountMode, world) {
  if (mountMode === "none") {
    return [];
  }
  if (mountMode === "cubesandbox-readonly" || mountMode === "unsafe-rw") {
    return [hostDirVolume("workspace", world.sourcePath)];
  }
  return [
    hostDirVolume("lower", world.sourcePath),
    hostDirVolume("upper", world.paths.upper),
    hostDirVolume("work", world.paths.workdir),
    hostDirVolume("whiteouts", world.paths.whiteouts)
  ];
}

function volumeMountsForMountMode(mountMode, world, paths) {
  if (mountMode === "none") {
    return [];
  }
  if (mountMode === "cubesandbox-readonly" || mountMode === "unsafe-rw") {
    return [
      {
        name: "workspace",
        container_path: paths.workspace,
        readonly: mountMode === "cubesandbox-readonly",
        host_path: world.sourcePath
      }
    ];
  }
  return [
    { name: "lower", container_path: paths.lower, readonly: true, host_path: world.sourcePath },
    { name: "upper", container_path: paths.upper, readonly: false, host_path: world.paths.upper },
    { name: "work", container_path: paths.work, readonly: false, host_path: world.paths.workdir },
    { name: "whiteouts", container_path: paths.whiteouts, readonly: false, host_path: world.paths.whiteouts }
  ];
}

function hostDirVolume(name, hostPath) {
  return {
    name,
    volume_source: {
      host_dir_volumes: {
        volume_sources: [
          {
            name,
            host_path: hostPath
          }
        ]
      }
    }
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
