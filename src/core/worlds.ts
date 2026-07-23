// @ts-nocheck
import fs from "node:fs/promises";
import path from "node:path";
import { getBackend } from "../backends/index.js";
import { CubeSandboxClient } from "../cube/client.js";
import { applyNetworkToCubeRequest, writableLayerAnnotations } from "../cube/request.js";
import { normalizeHostMounts, primaryMount } from "./mounts.js";
import { normalizeKubernetesConfig, normalizeNetworkConfig } from "./network.js";
import { WorldStore } from "./store.js";
import { openTarget } from "./openers.js";

const HETERONETWORK_TCP_PORTS = [8443, 9443, 9580, 9780];
const HETERONETWORK_UDP_PORTS = [3478, 51820];
const HETERONETWORK_EXPOSED_PORTS = [...HETERONETWORK_TCP_PORTS, ...HETERONETWORK_UDP_PORTS];
const worldProvisioning = new Map();

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
  const extraBackendConfig = input.backendConfig || {};
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
      kubernetes,
      ...extraBackendConfig
    }
  });
  try {
    return await serializeWorldProvisioning(world.id, () => backend.afterCreate(world, store));
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

export async function createHeteroNetworkLab(config, input = {}) {
  const labName = cleanLabName(input.name || input.labName || "hetero-network-lab");
  const publicNodes = clampCount(input.publicNodes ?? input.publicNodeCount ?? 1, "publicNodes", { min: 1 });
  const natNodes = clampCount(input.natNodes ?? input.natNodeCount ?? 1, "natNodes");
  const doubleNatNodes = clampCount(input.doubleNatNodes ?? input.doubleNatNodeCount ?? 1, "doubleNatNodes");
  const addressBase = cleanOptionalString(input.addressBase || input.sandboxIpBase || input.ipBase || "");
  const addressStart = Number(input.addressStart || 20);
  if (addressBase && (!Number.isInteger(addressStart) || addressStart < 2 || addressStart > 250)) {
    throw new Error("addressStart must be an integer between 2 and 250");
  }
  const portOffset = Number(input.portOffset || 0);
  if (!Number.isInteger(portOffset) || portOffset < 0 || portOffset > 13715) {
    throw new Error("portOffset must be an integer between 0 and 13715");
  }

  const inputNetwork = input.network || {};
  const sharedNetwork = {
    type: "tap",
    mode: "tap",
    allowInternetAccess: true,
    nat: { enabled: true, masquerade: true },
    ...inputNetwork,
    nat: inputNetwork.nat === false
      ? { enabled: false }
      : { enabled: true, masquerade: true, ...(inputNetwork.nat || {}) }
  };
  const baseInput = {
    backend: input.backend || "cube-sandbox-overlay",
    hostMount: input.hostMount === true,
    mounts: input.hostMount === true ? input.mounts : undefined,
    sourcePath: input.hostMount === true ? input.sourcePath : undefined,
    mountMode: input.hostMount === true ? input.mountMode : "none",
    cpu: input.cpu,
    memory: input.memory,
    writableLayerSize: input.writableLayerSize || input.disk,
    networkType: "tap",
    kubernetes: { enabled: false }
  };

  const created = [];
  let addressIndex = 0;
  const nextAddress = () => {
    addressIndex += 1;
    return labAddress(addressBase, addressStart + addressIndex - 1);
  };

  for (let index = 1; index <= publicNodes; index += 1) {
    const hostOffset = portOffset + ((index - 1) * 100);
    const network = mergeNetworkConfig(sharedNetwork, {
      sandboxIp: nextAddress(),
      exposedPorts: HETERONETWORK_EXPOSED_PORTS,
      inbound: { defaultPolicy: "allow" },
      nat: {
        enabled: true,
        masquerade: true,
        portForwards: heteroPublicPortForwards(hostOffset)
      },
      topology: {
        profile: "hetero-network",
        role: "public",
        natDepth: 0,
        path: "direct",
        publicEndpoint: true,
        stun: true,
        relay: true
      }
    });
    created.push(await createWorld(config, {
      ...baseInput,
      name: `${labName}-public-${index}`,
      network,
      labels: heteroLabLabels(input.labels, labName, "public", index)
    }));
  }

  for (let index = 1; index <= natNodes; index += 1) {
    const network = mergeNetworkConfig(sharedNetwork, {
      sandboxIp: nextAddress(),
      exposedPorts: [9780],
      inbound: { defaultPolicy: "deny" },
      topology: {
        profile: "hetero-network",
        role: "nat",
        natDepth: 1,
        path: "negotiated",
        publicEndpoint: false,
        stun: true,
        relay: false
      }
    });
    created.push(await createWorld(config, {
      ...baseInput,
      name: `${labName}-nat-${index}`,
      network,
      labels: heteroLabLabels(input.labels, labName, "nat", index)
    }));
  }

  for (let index = 1; index <= doubleNatNodes; index += 1) {
    const network = mergeNetworkConfig(sharedNetwork, {
      sandboxIp: nextAddress(),
      exposedPorts: [9780],
      inbound: { defaultPolicy: "deny" },
      topology: {
        profile: "hetero-network",
        role: "double-nat",
        natDepth: 2,
        path: "relay",
        publicEndpoint: false,
        stun: true,
        relay: true
      }
    });
    created.push(await createWorld(config, {
      ...baseInput,
      name: `${labName}-double-nat-${index}`,
      network,
      labels: heteroLabLabels(input.labels, labName, "double-nat", index)
    }));
  }

  const networkTopology = await syncLabNetworkTopology(config, created);
  const namespaceSetup = await setupHeteroNetworkNamespaces(config, created);
  return {
    lab: {
      name: labName,
      profile: "hetero-network",
      publicNodes,
      natNodes,
      doubleNatNodes,
      expectedPathStates: ["DIRECT_PUBLIC", "DIRECT_NAT_TRAVERSAL", "RELAY"],
      servicePorts: {
        controlPlane: 8443,
        signal: 9443,
        stunUdp: 3478,
        relayUdp: 51820,
        relayHttp: 9580,
        agent: 9780
      },
      networkTopology,
      namespaceSetup
    },
    worlds: created
  };
}

async function setupHeteroNetworkNamespaces(config, worlds) {
  const client = new CubeSandboxClient(config.cube || {});
  const store = new WorldStore(config);
  const results = await Promise.all(worlds.map(async (world) => {
    const role = world.backendConfig?.network?.topology?.role || world.labels?.["kakurizai.heteroNetwork.role"];
    if (role !== "nat" && role !== "double-nat") {
      return { worldId: world.id, name: world.name, role, skipped: true, reason: "public node does not need an inner NAT namespace" };
    }
    if (world.backend !== "cube-sandbox-overlay" || !world.sandbox?.id) {
      return { worldId: world.id, name: world.name, role, skipped: true, reason: "world is not a running CubeSandbox sandbox" };
    }
    const namespace = role === "double-nat" ? "kzhd-node" : "kzhn-node";
    const script = role === "double-nat" ? heteroDoubleNatSetupScript() : heteroNatSetupScript();
    const result = await client.exec(world, ["/bin/sh", "-lc", script], {
      allowFailure: true,
      timeoutMs: 180000
    });
    const setup = {
      worldId: world.id,
      name: world.name,
      role,
      namespace,
      applied: result.code === 0,
      skipped: false,
      code: result.code,
      reason: result.code === 0 ? null : result.stderr || result.stdout || `namespace setup exited with ${result.code}`
    };
    world.backendConfig.network.topology = {
      ...(world.backendConfig.network.topology || {}),
      runtimeNamespace: namespace
    };
    world.sandbox = {
      ...(world.sandbox || {}),
      network: {
        ...(world.sandbox?.network || {}),
        heteroNamespace: setup
      }
    };
    await store.save(world);
    return setup;
  }));
  return results;
}

function heteroNatSetupScript() {
  return [
    "set -eu",
    heteroNamespaceToolBootstrapScript(),
    "ip netns del kzhn-node 2>/dev/null || true",
    "ip link del kzhn-h0 2>/dev/null || true",
    "ip netns add kzhn-node",
    "ip link add kzhn-h0 type veth peer name kzhn-n0",
    "ip link set kzhn-n0 netns kzhn-node",
    "ip addr add 10.88.1.1/24 dev kzhn-h0",
    "ip link set kzhn-h0 up",
    "ip netns exec kzhn-node ip addr add 10.88.1.2/24 dev kzhn-n0",
    "ip netns exec kzhn-node ip link set lo up",
    "ip netns exec kzhn-node ip link set kzhn-n0 up",
    "ip netns exec kzhn-node ip route add default via 10.88.1.1",
    "sysctl -w net.ipv4.ip_forward=1 >/dev/null",
    "iptables -t nat -C POSTROUTING -s 10.88.1.0/24 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s 10.88.1.0/24 -j MASQUERADE",
    "cat >/usr/local/bin/kz-hetero-shell <<'KZ_HETERONETWORK_SHELL'",
    "#!/bin/sh",
    "if [ \"$#\" -eq 0 ]; then set -- /bin/bash; fi",
    "exec ip netns exec kzhn-node \"$@\"",
    "KZ_HETERONETWORK_SHELL",
    "chmod +x /usr/local/bin/kz-hetero-shell",
    "printf 'kzhn-node 10.88.1.2/24 via 10.88.1.1\\n' >/tmp/kz-hetero-nat.txt"
  ].join("\n");
}

function heteroDoubleNatSetupScript() {
  return [
    "set -eu",
    heteroNamespaceToolBootstrapScript(),
    "ip netns del kzhd-node 2>/dev/null || true",
    "ip netns del kzhd-cpe 2>/dev/null || true",
    "ip link del kzhd-h0 2>/dev/null || true",
    "ip netns add kzhd-cpe",
    "ip netns add kzhd-node",
    "ip link add kzhd-h0 type veth peer name kzhd-c0",
    "ip link set kzhd-c0 netns kzhd-cpe",
    "ip link add kzhd-c1 type veth peer name kzhd-n0",
    "ip link set kzhd-c1 netns kzhd-cpe",
    "ip link set kzhd-n0 netns kzhd-node",
    "ip addr add 10.89.0.1/24 dev kzhd-h0",
    "ip link set kzhd-h0 up",
    "ip netns exec kzhd-cpe ip addr add 10.89.0.2/24 dev kzhd-c0",
    "ip netns exec kzhd-cpe ip addr add 10.89.1.1/24 dev kzhd-c1",
    "ip netns exec kzhd-cpe ip link set lo up",
    "ip netns exec kzhd-cpe ip link set kzhd-c0 up",
    "ip netns exec kzhd-cpe ip link set kzhd-c1 up",
    "ip netns exec kzhd-cpe ip route add default via 10.89.0.1",
    "ip netns exec kzhd-node ip addr add 10.89.1.2/24 dev kzhd-n0",
    "ip netns exec kzhd-node ip link set lo up",
    "ip netns exec kzhd-node ip link set kzhd-n0 up",
    "ip netns exec kzhd-node ip route add default via 10.89.1.1",
    "sysctl -w net.ipv4.ip_forward=1 >/dev/null",
    "ip netns exec kzhd-cpe sysctl -w net.ipv4.ip_forward=1 >/dev/null",
    "iptables -t nat -C POSTROUTING -s 10.89.0.0/16 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s 10.89.0.0/16 -j MASQUERADE",
    "ip netns exec kzhd-cpe iptables -t nat -C POSTROUTING -s 10.89.1.0/24 -j MASQUERADE 2>/dev/null || ip netns exec kzhd-cpe iptables -t nat -A POSTROUTING -s 10.89.1.0/24 -j MASQUERADE",
    "cat >/usr/local/bin/kz-hetero-shell <<'KZ_HETERONETWORK_SHELL'",
    "#!/bin/sh",
    "if [ \"$#\" -eq 0 ]; then set -- /bin/bash; fi",
    "exec ip netns exec kzhd-node \"$@\"",
    "KZ_HETERONETWORK_SHELL",
    "chmod +x /usr/local/bin/kz-hetero-shell",
    "printf 'kzhd-node 10.89.1.2/24 via kzhd-cpe 10.89.1.1 then host 10.89.0.1\\n' >/tmp/kz-hetero-double-nat.txt"
  ].join("\n");
}

function heteroNamespaceToolBootstrapScript() {
  return [
    "need_pkg=0",
    "command -v ip >/dev/null 2>&1 || need_pkg=1",
    "command -v iptables >/dev/null 2>&1 || need_pkg=1",
    "command -v ping >/dev/null 2>&1 || need_pkg=1",
    "command -v sysctl >/dev/null 2>&1 || need_pkg=1",
    "if [ \"$need_pkg\" -eq 1 ]; then",
    "  if command -v apt-get >/dev/null 2>&1; then",
    "    export DEBIAN_FRONTEND=noninteractive",
    "    apt-get -o DPkg::Lock::Timeout=180 update >/dev/null",
    "    apt-get -o DPkg::Lock::Timeout=180 install -y --no-install-recommends iproute2 iputils-ping iptables procps >/dev/null",
    "  elif command -v apk >/dev/null 2>&1; then",
    "    apk add --no-cache iproute2 iputils iptables procps >/dev/null",
    "  else",
    "    echo 'HeteroNetwork namespace setup requires iproute2, ping, iptables, and procps' >&2",
    "    exit 127",
    "  fi",
    "fi",
    "command -v ip >/dev/null 2>&1",
    "command -v iptables >/dev/null 2>&1",
    "command -v ping >/dev/null 2>&1",
    "command -v sysctl >/dev/null 2>&1"
  ].join("\n");
}

export async function createKubernetesLab(config, input = {}) {
  const labName = cleanLabName(input.name || input.clusterName || "kakurizai-lab");
  const controlPlanes = clampCount(input.controlPlanes ?? input.controlPlaneCount ?? 1, "controlPlanes", { min: 1 });
  const workers = clampCount(input.workers ?? input.workerCount ?? 2, "workers");
  const profile = input.profile || input.kubernetes?.profile || "k3s";
  const apiServerPort = Number(input.apiServerPort || input.kubernetes?.apiServerPort || 6443);
  const nodePorts = input.nodePorts || input.kubernetes?.nodePorts || [30000, 30001];
  const firstControlPlaneIp = cleanOptionalString(input.controlPlaneIp || input.controlPlaneNetwork?.sandboxIp || input.controlPlane?.network?.sandboxIp || input.network?.controlPlane?.sandboxIp || input.network?.controlPlanes?.sandboxIp);
  let joinEndpoint = input.joinEndpoint || `https://${firstControlPlaneIp || `${labName}-cp-1`}:${apiServerPort}`;
  const inputNetwork = input.network || {};
  const sharedNetwork = {
    type: "tap",
    mode: "tap",
    exposedPorts: [apiServerPort, ...nodePorts],
    nat: { enabled: true, masquerade: true },
    ...inputNetwork,
    nat: inputNetwork.nat === false
      ? { enabled: false }
      : { enabled: true, masquerade: true, ...(inputNetwork.nat || {}) }
  };
  const controlPlaneNetwork = mergeNetworkConfig(
    sharedNetwork,
    input.controlPlaneNetwork || input.controlPlane?.network || input.network?.controlPlane || input.network?.controlPlanes
  );
  const workerNetwork = mergeNetworkConfig(
    sharedNetwork,
    input.workerNetwork || input.worker?.network || input.network?.worker || input.network?.workers
  );
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
    const network = mergeNetworkConfig(controlPlaneNetwork, {
      sandboxIp: index === 1 ? firstControlPlaneIp : null
    });
    const world = await createWorld(config, {
      ...baseInput,
      name: `${labName}-cp-${index}`,
      network,
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
    });
    created.push(world);
    if (index === 1 && !input.joinEndpoint) {
      const runtimeIp = cleanOptionalString(world.sandbox?.runtimeSandboxIp || world.sandbox?.sandboxIp || firstControlPlaneIp);
      if (runtimeIp) joinEndpoint = `https://${runtimeIp}:${apiServerPort}`;
    }
  }
  for (let index = 1; index <= workers; index += 1) {
    created.push(await createWorld(config, {
      ...baseInput,
      name: `${labName}-worker-${index}`,
      network: workerNetwork,
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
  const networkTopology = await syncLabNetworkTopology(config, created);
  return {
    lab: {
      name: labName,
      clusterName: labName,
      controlPlanes,
      workers,
      joinEndpoint,
      networkTopology
    },
    worlds: created
  };
}

async function syncLabNetworkTopology(config, worlds) {
  const cubeWorlds = worlds.filter((world) => (
    world.backend === "cube-sandbox-overlay" &&
    world.sandbox?.status !== "failed" &&
    (world.sandbox?.runtimeSandboxIp || world.sandbox?.sandboxIp || world.backendConfig?.network?.sandboxIp)
  ));
  if (!cubeWorlds.length) return { skipped: true, reason: "no running CubeSandbox lab nodes with sandbox IPs" };
  const client = new CubeSandboxClient(config.cube || {});
  const topology = await client.syncCubeSandboxHairpinTopology(cubeWorlds);
  const store = new WorldStore(config);
  await Promise.all(cubeWorlds.map(async (world) => {
    world.sandbox = {
      ...(world.sandbox || {}),
      network: {
        ...(world.sandbox?.network || {}),
        topology: topology.byWorld?.[world.id] || topology
      }
    };
    await store.save(world);
  }));
  return topology;
}

function mergeNetworkConfig(base = {}, override = {}) {
  const next = {
    ...(base || {}),
    ...(override || {})
  };
  if (base?.dns || override?.dns) next.dns = { ...(base?.dns || {}), ...(override?.dns || {}) };
  if (base?.vlan || override?.vlan) next.vlan = { ...(base?.vlan || {}), ...(override?.vlan || {}) };
  if (base?.nat || override?.nat) next.nat = { ...(base?.nat || {}), ...(override?.nat || {}) };
  if (base?.inbound || override?.inbound) next.inbound = { ...(base?.inbound || {}), ...(override?.inbound || {}) };
  if (next.sandboxIp == null || next.sandboxIp === "") delete next.sandboxIp;
  return next;
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

function heteroLabLabels(labels = {}, labName, role, index) {
  return {
    ...(labels || {}),
    "kakurizai.lab": labName,
    "kakurizai.experiment": "hetero-network",
    "kakurizai.heteroNetwork.role": role,
    "kakurizai.heteroNetwork.nodeIndex": String(index)
  };
}

function heteroPublicPortForwards(offset = 0) {
  return [
    ...HETERONETWORK_TCP_PORTS.map((port) => ({
      name: heteroPortName(port),
      protocol: "tcp",
      listenAddress: "0.0.0.0",
      hostPort: port + offset,
      sandboxPort: port
    })),
    ...HETERONETWORK_UDP_PORTS.map((port) => ({
      name: heteroPortName(port),
      protocol: "udp",
      listenAddress: "0.0.0.0",
      hostPort: port + offset,
      sandboxPort: port
    }))
  ];
}

function heteroPortName(port) {
  return ({
    8443: "control-plane",
    9443: "signal",
    9580: "relay-http",
    9780: "agent",
    3478: "stun",
    51820: "relay-udp"
  })[port] || `port-${port}`;
}

function labAddress(addressBase, hostIndex) {
  if (!addressBase) return null;
  const prefix = addressBase.replace(/\.$/, "");
  return `${prefix}.${hostIndex}`;
}

function cleanLabName(value) {
  const name = String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) throw new Error("lab name is required");
  return name;
}

function cleanOptionalString(value) {
  return String(value || "").trim();
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
  return serializeWorldProvisioning(world.id, async () => {
    world = await store.get(world.id, { exactId: true });
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
  });
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

export async function ensureWorldProvisioned(config, ref) {
  const store = new WorldStore(config);
  const initial = await store.get(ref);
  if (initial.backend !== "cube-sandbox-overlay") {
    throw statusError(`world ${initial.name} does not use the CubeSandbox backend`, 409);
  }
  return serializeWorldProvisioning(initial.id, async () => {
    let world = await store.get(initial.id, { exactId: true });
    const recordedSandboxId = world.sandbox?.containerId || world.sandbox?.id || null;
    if (world.sandbox?.mode === "direct-cubelet") {
      if (recordedSandboxId) return world;
      throw provisioningError(world, "direct Cubelet world has no sandbox id", 409);
    }

    const client = new CubeSandboxClient(config.cube || {});
    const lookup = await client.findWorldSandboxes(world);
    if (!lookup.checked) {
      throw provisioningError(world, lookup.reason || "CubeSandbox runtime lookup failed", 503);
    }

    const candidate = selectWorldSandbox(world, lookup.sandboxes || []);
    if (candidate) {
      assertConnectableSandbox(world, candidate);
      return saveReconciledWorld(store, world, candidate, lookup.mode);
    }
    const previousProvisioningFailed = world.status === "failed" || world.sandbox?.status === "failed";
    if (previousProvisioningFailed && recordedSandboxId) {
      throw provisioningError(world, world.sandbox?.reason || "the previous provisioning attempt failed", 409);
    }

    const previousFailureReason = previousProvisioningFailed ? world.sandbox?.reason : null;
    world.status = "creating";
    world.sandbox = {
      ...(world.sandbox || {}),
      id: null,
      containerId: null,
      runtime: "CubeSandbox",
      status: "provisioning",
      reason: recordedSandboxId
        ? `recorded CubeSandbox ${recordedSandboxId} no longer exists; provisioning a replacement`
        : previousFailureReason
          ? `retrying CubeSandbox provisioning after: ${previousFailureReason}`
          : "provisioning CubeSandbox before connection"
    };
    await store.save(world);

    const backend = getBackend(config, world.backend);
    try {
      world = await backend.afterCreate(world, store);
    } catch (error) {
      const failed = await store.get(world.id, { exactId: true });
      failed.status = "failed";
      failed.sandbox = {
        ...(failed.sandbox || {}),
        id: null,
        containerId: null,
        runtime: "CubeSandbox",
        status: "failed",
        reason: error.message || String(error)
      };
      await store.save(failed);
      throw provisioningError(failed, failed.sandbox.reason, 503);
    }
    const provisionedSandboxId = world.sandbox?.containerId || world.sandbox?.id || null;
    if (!provisionedSandboxId) {
      throw provisioningError(world, world.sandbox?.reason || "CubeSandbox did not return a sandbox id", 503);
    }

    const verification = await client.findWorldSandboxes(world);
    if (!verification.checked) {
      throw provisioningError(world, verification.reason || "created sandbox could not be verified", 503);
    }
    const verified = selectWorldSandbox(world, verification.sandboxes || []);
    if (!verified) {
      throw provisioningError(world, `created sandbox ${provisionedSandboxId} is not visible in CubeSandbox`, 503);
    }
    assertConnectableSandbox(world, verified);
    return saveReconciledWorld(store, world, verified, verification.mode);
  });
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
  let world = await store.get(ref);
  if (world.backend === "cube-sandbox-overlay") {
    world = await ensureWorldProvisioned(config, world.id);
  }
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

async function serializeWorldProvisioning(worldId, action) {
  const previous = worldProvisioning.get(worldId) || Promise.resolve();
  const task = previous.catch(() => {}).then(action);
  worldProvisioning.set(worldId, task);
  try {
    return await task;
  } finally {
    if (worldProvisioning.get(worldId) === task) worldProvisioning.delete(worldId);
  }
}

function selectWorldSandbox(world, candidates) {
  const unique = [...new Map(
    (candidates || []).filter((candidate) => candidate?.id).map((candidate) => [candidate.id, candidate])
  ).values()];
  const recordedIds = [world.sandbox?.containerId, world.sandbox?.id].filter(Boolean);
  const recorded = unique.find((candidate) => recordedIds.includes(candidate.id));
  if (recorded) return recorded;
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) {
    throw provisioningError(
      world,
      `multiple CubeSandbox sandboxes match this world (${unique.map((candidate) => candidate.id).join(", ")})`,
      409
    );
  }
  return null;
}

function assertConnectableSandbox(world, sandbox) {
  const status = String(sandbox.status || "").toLowerCase();
  if (/paused|pausing|exited|failed|stopped|deleted/.test(status)) {
    throw provisioningError(world, `CubeSandbox ${sandbox.id} is ${sandbox.status}`, 409);
  }
}

async function saveReconciledWorld(store, world, sandbox, mode) {
  const overlayPending = world.sandbox?.overlay?.mounted === false;
  const nextStatus = overlayPending ? "pending-overlay" : "ready";
  const nextSandbox = {
    ...(world.sandbox || {}),
    id: sandbox.id,
    containerId: sandbox.id,
    baseId: sandbox.templateId || world.sandbox?.baseId || world.backendConfig?.template || null,
    runtime: "CubeSandbox",
    mode: mode || world.sandbox?.mode || null,
    status: overlayPending ? "running-overlay-pending" : sandbox.status || "running",
    reason: overlayPending ? world.sandbox?.overlay?.reason || world.sandbox?.reason || null : null
  };
  const changed = world.status !== nextStatus
    || world.sandbox?.id !== nextSandbox.id
    || world.sandbox?.containerId !== nextSandbox.containerId
    || world.sandbox?.baseId !== nextSandbox.baseId
    || world.sandbox?.runtime !== nextSandbox.runtime
    || world.sandbox?.mode !== nextSandbox.mode
    || world.sandbox?.status !== nextSandbox.status
    || world.sandbox?.reason !== nextSandbox.reason;
  world.status = nextStatus;
  world.sandbox = nextSandbox;
  return changed ? store.save(world) : world;
}

function provisioningError(world, reason, statusCode) {
  return statusError(`world ${world.name} could not be provisioned in CubeSandbox: ${reason}`, statusCode);
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
