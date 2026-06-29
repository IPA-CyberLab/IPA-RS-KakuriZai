// @ts-nocheck
import { normalizeHostMounts } from "../core/mounts.js";
import {
  cubeNetworkPolicy,
  effectiveNetworkConfig,
  normalizeKubernetesConfig,
  normalizeNetworkConfig
} from "../core/network.js";

export function buildCubeSandboxRequest(world, cubeConfig = {}) {
  const workspace = cubeConfig.workspacePath || "/workspace";
  const mounts = mountSpecsForWorld(world, cubeConfig);
  const mountMode = summarizeMountMode(mounts);
  const network = normalizeNetworkConfig({
    type: cubeConfig.networkType || world.backendConfig?.networkType || "tap",
    ...(world.backendConfig?.network || {}),
    ...(cubeConfig.network || {})
  });
  const kubernetes = normalizeKubernetesConfig(cubeConfig.kubernetes || world.backendConfig?.kubernetes || {});
  const placement = normalizePlacement(world.backendConfig?.placement || cubeConfig.placement || {});
  const replication = world.backendConfig?.replication || {};
  const workspaceArg = shellQuote(workspace);
  const setup = setupCommandForMounts(mounts, { workspaceArg });
  const writableLayerSize = cubeConfig.writableLayerSize || world.backendConfig?.writableLayerSize || null;
  const writableLayerRequestAnnotations = writableLayerAnnotations(writableLayerSize);
  const volumes = volumesForMounts(mounts, world, { writableLayerSize });
  const volumeMounts = volumeMountsForMounts(mounts, world, { writableLayerSize });
  const primaryMount = mounts[0] || null;
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
          ...kubernetesAnnotations(kubernetes),
          ...(writableLayerSize ? { "cube.master.rootfs.writable_layer_size": writableLayerSize } : {})
        }
      }
    ],
    annotations: {
      "kakurizai.backend": "cube-sandbox-overlay",
      "kakurizai.world": world.id,
      "kakurizai.source": primaryMount?.sourcePath || world.sourcePath,
      "kakurizai.upper": world.paths.upper,
      "kakurizai.workspace": workspace,
      "kakurizai.mountMode": mountMode,
      "kakurizai.hostMount": String(mounts.length > 0),
      "kakurizai.mounts": JSON.stringify(mounts.map(publicMountSpec)),
      "kakurizai.overlayMounts": String(mounts.filter((mount) => mount.mode === "agctl-overlay").length),
      ...placementAnnotations(placement),
      ...replicationAnnotations(replication),
      ...kubernetesAnnotations(kubernetes),
      "cube.master.appsnapshot.template.id": cubeConfig.template || "kakurizai-base",
      "cube.master.appsnapshot.template.version": cubeConfig.templateVersion || "v2",
      ...writableLayerRequestAnnotations
    },
    labels: {
      "app.kubernetes.io/managed-by": "kakurizai",
      "kakurizai.world": world.id,
      ...(placement.nodeId ? { "kakurizai.placement.node": placement.nodeId } : {}),
      ...(replication.sourceWorldId ? { "kakurizai.replica-of": replication.sourceWorldId } : {}),
      ...(kubernetes.enabled ? {
        "kakurizai.kubernetes.cluster": kubernetes.clusterName,
        "kakurizai.kubernetes.node-role": kubernetes.nodeRole
      } : {})
    },
    instance_type: cubeConfig.instanceType || "cubebox",
    network_type: network.type || "tap",
    namespace: cubeConfig.namespace || "kakurizai"
  };
  if (placement.nodeId) {
    request.ins_id = placement.nodeId;
    request.annotations["com.cube.debug"] = "true";
  }
  if (placement.nodeIp) {
    request.ins_ip = placement.nodeIp;
    request.annotations["com.cube.debug"] = "true";
  }
  return applyNetworkToCubeRequest(request, network, kubernetes);
}

export function writableLayerAnnotations(writableLayerSize) {
  if (!writableLayerSize) return {};
  const annotations = {
    "cube.master.rootfs.writable_layer_size": writableLayerSize
  };
  const systemDiskGi = sizeToGi(writableLayerSize);
  if (systemDiskGi) annotations["cube.master.system_disk_size"] = String(systemDiskGi);
  return annotations;
}

export function mountSpecsForWorld(world, cubeConfig = {}) {
  const workspace = cubeConfig.workspacePath || "/workspace";
  return normalizeHostMounts({
    hostMount: world.backendConfig?.hostMount,
    sourcePath: world.sourcePath,
    mountMode: cubeConfig.mountMode || world.backendConfig?.mountMode || "agctl-overlay",
    mounts: world.backendConfig?.mounts
  }, {
    workspacePath: workspace
  }).map((mount) => ({
    ...mount,
    lower: `/kakurizai/mounts/${mount.id}/lower`,
    upper: `/kakurizai/upper/${mount.id}`,
    work: `/kakurizai/work/${mount.id}`,
    whiteouts: `/kakurizai/whiteouts/${mount.id}`
  }));
}

export function applyNetworkToCubeRequest(request, networkInput = {}, kubernetesInput = {}) {
  const kubernetes = normalizeKubernetesConfig(kubernetesInput);
  const network = effectiveNetworkConfig(networkInput, kubernetes);
  request.network_type = network.type || "tap";
  if (network.sandboxIp) request.sandbox_ip = network.sandboxIp;
  else delete request.sandbox_ip;
  request.exposed_ports = network.exposedPorts;
  request.annotations = {
    ...(request.annotations || {}),
    "kakurizai.network.type": request.network_type,
    "kakurizai.network.mode": network.mode || request.network_type,
    ...kubernetesAnnotations(kubernetes)
  };
  request.labels = {
    ...(request.labels || {}),
    ...(kubernetes.enabled ? {
      "kakurizai.kubernetes.cluster": kubernetes.clusterName,
      "kakurizai.kubernetes.node-role": kubernetes.nodeRole
    } : {})
  };
  applyNetworkAnnotations(request.annotations, network);
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
      "kakurizai.network.mode": network.mode || request.network_type,
      ...(network.sandboxIp ? { "kakurizai.network.sandboxIp": network.sandboxIp } : {}),
      ...kubernetesAnnotations(kubernetes)
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
    if (!network.sandboxIp) delete container.annotations["kakurizai.network.sandboxIp"];
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

function applyNetworkAnnotations(annotations, network) {
  const vlan = network.vlan || {};
  const nat = network.nat || {};
  annotations["kakurizai.network.vlan.enabled"] = String(Boolean(vlan.enabled));
  annotations["kakurizai.network.nat.enabled"] = String(Boolean(nat.enabled));
  annotations["kakurizai.network.nat.masquerade"] = String(Boolean(nat.masquerade));
  if (network.sandboxIp) annotations["kakurizai.network.sandboxIp"] = network.sandboxIp;
  else delete annotations["kakurizai.network.sandboxIp"];
  setJsonAnnotation(annotations, "kakurizai.network.vlan", vlan.enabled ? vlan : null);
  setJsonAnnotation(annotations, "kakurizai.network.nat", nat.enabled ? nat : null);
  setJsonAnnotation(annotations, "kakurizai.network.portForwards", nat.portForwards?.length ? nat.portForwards : null);
}

function kubernetesAnnotations(kubernetes) {
  const annotations = {
    "kakurizai.kubernetes": String(kubernetes.enabled),
    "kakurizai.kubernetes.profile": kubernetes.profile,
    "kakurizai.kubernetes.cluster": kubernetes.clusterName,
    "kakurizai.kubernetes.nodeRole": kubernetes.nodeRole,
    "kakurizai.kubernetes.nodeName": kubernetes.nodeName || "",
    "kakurizai.kubernetes.cni": kubernetes.cni,
    "kakurizai.kubernetes.podCidr": kubernetes.podCidr,
    "kakurizai.kubernetes.serviceCidr": kubernetes.serviceCidr,
    "kakurizai.kubernetes.apiServerPort": String(kubernetes.apiServerPort),
    "kakurizai.kubernetes.nodePorts": (kubernetes.nodePorts || []).join(",")
  };
  if (kubernetes.joinEndpoint) annotations["kakurizai.kubernetes.joinEndpoint"] = kubernetes.joinEndpoint;
  if (kubernetes.joinToken) annotations["kakurizai.kubernetes.joinToken"] = kubernetes.joinToken;
  if (kubernetes.advertiseAddress) annotations["kakurizai.kubernetes.advertiseAddress"] = kubernetes.advertiseAddress;
  if (kubernetes.extraArgs?.length) annotations["kakurizai.kubernetes.extraArgs"] = kubernetes.extraArgs.join("\n");
  if (kubernetes.sysctls && Object.keys(kubernetes.sysctls).length) annotations["kakurizai.kubernetes.sysctls"] = JSON.stringify(kubernetes.sysctls);
  return annotations;
}

function normalizePlacement(placement) {
  return {
    nodeId: cleanString(placement.nodeId || placement.id || placement.insId || placement.ins_id),
    nodeIp: cleanString(placement.nodeIp || placement.ip || placement.insIp || placement.ins_ip),
    nodeName: cleanString(placement.nodeName || placement.name),
    endpoint: cleanString(placement.endpoint)
  };
}

function placementAnnotations(placement) {
  const annotations = {};
  if (placement.nodeId) annotations["kakurizai.placement.nodeId"] = placement.nodeId;
  if (placement.nodeIp) annotations["kakurizai.placement.nodeIp"] = placement.nodeIp;
  if (placement.nodeName) annotations["kakurizai.placement.nodeName"] = placement.nodeName;
  if (placement.endpoint) annotations["kakurizai.placement.endpoint"] = placement.endpoint;
  return annotations;
}

function replicationAnnotations(replication = {}) {
  const annotations = {};
  if (replication.sourceWorldId) annotations["kakurizai.replication.sourceWorldId"] = replication.sourceWorldId;
  if (replication.sourceWorldName) annotations["kakurizai.replication.sourceWorldName"] = replication.sourceWorldName;
  if (replication.group) annotations["kakurizai.replication.group"] = replication.group;
  if (replication.role) annotations["kakurizai.replication.role"] = replication.role;
  if (replication.targetNodeId) annotations["kakurizai.replication.targetNodeId"] = replication.targetNodeId;
  if (replication.targetNodeName) annotations["kakurizai.replication.targetNodeName"] = replication.targetNodeName;
  return annotations;
}

function cleanString(value) {
  const text = String(value || "").trim();
  return text || null;
}

function setJsonAnnotation(annotations, key, value) {
  if (value) annotations[key] = JSON.stringify(value);
  else delete annotations[key];
}

function setupCommandForMounts(mounts, paths) {
  const agctlMounts = mounts.filter((mount) => mount.mode === "agctl-overlay");
  const dirs = [
    paths.workspaceArg,
    ...agctlMounts.flatMap((mount) => [
      shellQuote(mount.sandboxPath),
      shellQuote(mount.lower),
      shellQuote(mount.upper),
      shellQuote(mount.work),
      shellQuote(mount.whiteouts)
    ])
  ];
  return ["set -eu", `mkdir -p ${dirs.join(" ")}`, "tail -f /dev/null"].join("; ");
}

function volumesForMounts(mounts, world, options = {}) {
  const volumes = [];
  if (options.writableLayerSize) {
    volumes.push(rootfsWritableVolume(options.writableLayerSize));
  }
  if (!mounts.length) return volumes;
  if (mounts.some((mount) => mount.mode === "agctl-overlay")) {
    volumes.push(
      hostDirVolume("upper", world.paths.upper),
      hostDirVolume("work", world.paths.workdir),
      hostDirVolume("whiteouts", world.paths.whiteouts)
    );
  }
  for (const mount of mounts) {
    const volumeName = mount.mode === "agctl-overlay" ? `lower-${mount.id}` : `mount-${mount.id}`;
    volumes.push(hostDirVolume(volumeName, mount.sourcePath));
  }
  return volumes;
}

function volumeMountsForMounts(mounts, world, options = {}) {
  const volumeMounts = [];
  if (options.writableLayerSize) {
    volumeMounts.push({ name: "cube_rootfs_rw", container_path: "/" });
  }
  if (!mounts.length) return volumeMounts;
  if (mounts.some((mount) => mount.mode === "agctl-overlay")) {
    volumeMounts.push(
      { name: "upper", container_path: "/kakurizai/upper", readonly: false, host_path: world.paths.upper },
      { name: "work", container_path: "/kakurizai/work", readonly: false, host_path: world.paths.workdir },
      { name: "whiteouts", container_path: "/kakurizai/whiteouts", readonly: false, host_path: world.paths.whiteouts }
    );
  }
  for (const mount of mounts) {
    if (mount.mode === "agctl-overlay") {
      volumeMounts.push({
        name: `lower-${mount.id}`,
        container_path: mount.lower,
        readonly: true,
        host_path: mount.sourcePath
      });
    } else {
      volumeMounts.push({
        name: `mount-${mount.id}`,
        container_path: mount.sandboxPath,
        readonly: mount.mode === "cubesandbox-readonly",
        host_path: mount.sourcePath
      });
    }
  }
  return volumeMounts;
}

function rootfsWritableVolume(sizeLimit) {
  return {
    name: "cube_rootfs_rw",
    volume_source: {
      empty_dir: {
        size_limit: sizeLimit
      }
    }
  };
}

function sizeToGi(value) {
  const match = /^(\d+(?:\.\d+)?)([KMGTP])i?B?$/i.exec(String(value || "").trim());
  if (!match) return null;
  const power = { K: -2, M: -1, G: 0, T: 1, P: 2 }[match[2].toUpperCase()];
  const gib = Number(match[1]) * 1024 ** power;
  if (!Number.isFinite(gib) || gib <= 0) return null;
  return Math.max(1, Math.ceil(gib));
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

function summarizeMountMode(mounts) {
  if (!mounts.length) return "none";
  const modes = [...new Set(mounts.map((mount) => mount.mode))];
  return modes.length === 1 ? modes[0] : "mixed";
}

function publicMountSpec(mount) {
  return {
    id: mount.id,
    name: mount.name,
    sourcePath: mount.sourcePath,
    sandboxPath: mount.sandboxPath,
    mode: mount.mode
  };
}
