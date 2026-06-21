import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../dist/src/core/config.js";
import { normalizeKubernetesConfig, normalizeNetworkConfig } from "../dist/src/core/network.js";
import { parseSandboxManifest, manifestToCreateInput, writeTerraformBundle } from "../dist/src/core/spec.js";
import { WorldStore } from "../dist/src/core/store.js";
import { updateWorldConfig } from "../dist/src/core/worlds.js";
import { buildCubeSandboxRequest } from "../dist/src/cube/request.js";

test("cube request mounts source readonly and upper writable", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-"));
  const source = path.join(tmp, "source");
  await fs.mkdir(source);
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  const store = new WorldStore(config);
  const world = await store.create({
    name: "cube",
    sourcePath: source,
    backend: "cube-sandbox-overlay"
  });
  const request = buildCubeSandboxRequest(world, { template: "base", workspacePath: "/workspace" });
  assert.equal(request.annotations["kakurizai.backend"], "cube-sandbox-overlay");
  assert.equal(request.annotations["cube.master.appsnapshot.template.id"], "base");
  assert.equal(request.annotations["cube.master.appsnapshot.template.version"], "v2");
  assert.equal(request.instance_type, "cubebox");
  assert.equal(request.network_type, "tap");
  const volumes = new Map(request.volumes.map((volume) => [volume.name, volume]));
  assert.equal(volumes.size, 4);
  assert.equal(volumes.get("lower-source").volume_source.host_dir_volumes.volume_sources[0].host_path, world.sourcePath);
  assert.equal(volumes.get("upper").volume_source.host_dir_volumes.volume_sources[0].host_path, world.paths.upper);
  assert.equal(volumes.get("work").volume_source.host_dir_volumes.volume_sources[0].host_path, world.paths.workdir);
  assert.equal(volumes.get("whiteouts").volume_source.host_dir_volumes.volume_sources[0].host_path, world.paths.whiteouts);
  const mounts = request.containers[0].volume_mounts;
  assert.deepEqual(request.containers[0].resources, { cpu: "2000m", mem: "2000Mi" });
  assert.equal(mounts.find((mount) => mount.name === "lower-source").readonly, true);
  assert.equal(mounts.find((mount) => mount.name === "lower-source").container_path, "/kakurizai/mounts/source/lower");
  assert.equal(mounts.find((mount) => mount.name === "upper").readonly, false);
  assert.match(request.containers[0].args[0], /\/workspace\/source/);
  assert.match(request.containers[0].args[0], /tail -f \/dev\/null/);
  assert.doesNotMatch(request.containers[0].args[0], /mount -t overlay/);
});

test("cube request supports CubeSandbox direct mount modes", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-"));
  const source = path.join(tmp, "source");
  await fs.mkdir(source);
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  const store = new WorldStore(config);
  const world = await store.create({
    name: "cube-direct",
    sourcePath: source,
    backend: "cube-sandbox-overlay",
    backendConfig: { mountMode: "cubesandbox-readonly" }
  });

  const readonlyRequest = buildCubeSandboxRequest(world, { template: "base", workspacePath: "/workspace" });
  assert.equal(readonlyRequest.volumes.length, 1);
  assert.equal(readonlyRequest.volumes[0].name, "mount-source");
  assert.equal(readonlyRequest.containers[0].volume_mounts[0].container_path, "/workspace/source");
  assert.equal(readonlyRequest.containers[0].volume_mounts[0].readonly, true);
  assert.doesNotMatch(readonlyRequest.containers[0].args[0], /mount -t overlay/);

  world.backendConfig.mountMode = "unsafe-rw";
  world.backendConfig.mounts[0].mode = "unsafe-rw";
  const unsafeRequest = buildCubeSandboxRequest(world, { template: "base", workspacePath: "/workspace" });
  assert.equal(unsafeRequest.containers[0].volume_mounts[0].readonly, false);
  assert.equal(unsafeRequest.annotations["kakurizai.mountMode"], "unsafe-rw");
});

test("cube request supports multiple workspace subfolder mounts", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-multi-"));
  const sourceA = path.join(tmp, "alpha");
  const sourceB = path.join(tmp, "beta");
  await fs.mkdir(sourceA);
  await fs.mkdir(sourceB);
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  const store = new WorldStore(config);
  const world = await store.create({
    name: "cube-multi",
    backend: "cube-sandbox-overlay",
    backendConfig: {
      mounts: [
        { name: "repo", sourcePath: sourceA, mode: "agctl-overlay" },
        { name: "data", sourcePath: sourceB, mode: "cubesandbox-readonly" }
      ]
    }
  });

  const request = buildCubeSandboxRequest(world, { template: "base", workspacePath: "/workspace" });
  const mounts = request.containers[0].volume_mounts;

  assert.equal(request.annotations["kakurizai.mountMode"], "mixed");
  assert.equal(request.annotations["kakurizai.overlayMounts"], "1");
  assert.equal(mounts.find((mount) => mount.name === "lower-repo").container_path, "/kakurizai/mounts/repo/lower");
  assert.equal(mounts.find((mount) => mount.name === "mount-data").container_path, "/workspace/data");
  assert.equal(mounts.find((mount) => mount.name === "mount-data").readonly, true);
  assert.match(request.containers[0].args[0], /\/workspace\/repo/);
  assert.doesNotMatch(request.containers[0].volume_mounts.map((mount) => mount.container_path).join(","), /(^|,)\/workspace(,|$)/);
});

test("cube request carries writable layer and network settings", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-"));
  const source = path.join(tmp, "source");
  await fs.mkdir(source);
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  const store = new WorldStore(config);
  const world = await store.create({
    name: "cube-network",
    sourcePath: source,
    backend: "cube-sandbox-overlay"
  });

  const request = buildCubeSandboxRequest(world, {
    template: "base",
    workspacePath: "/workspace",
    writableLayerSize: "2G",
    networkType: "tap"
  });

  assert.equal(request.network_type, "tap");
  assert.equal(request.annotations["cube.master.rootfs.writable_layer_size"], "2G");
  assert.equal(request.annotations["cube.master.system_disk_size"], "2");
  assert.equal(request.containers[0].annotations["cube.master.rootfs.writable_layer_size"], "2G");
  const rootVolume = request.volumes.find((volume) => volume.name === "cube_rootfs_rw");
  assert.equal(rootVolume.volume_source.empty_dir.size_limit, "2G");
  const rootMount = request.containers[0].volume_mounts.find((mount) => mount.name === "cube_rootfs_rw");
  assert.equal(rootMount.container_path, "/");
});

test("cube request can launch without a host mount", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-"));
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  const store = new WorldStore(config);
  const world = await store.create({
    name: "cube-unmounted",
    backend: "cube-sandbox-overlay",
    backendConfig: { hostMount: false, mountMode: "none" }
  });

  const sourceStat = await fs.stat(world.sourcePath);
  const request = buildCubeSandboxRequest(world, { template: "base", workspacePath: "/workspace" });

  assert.equal(sourceStat.isDirectory(), true);
  assert.equal(world.sourcePath, world.paths.source);
  assert.deepEqual(request.volumes, []);
  assert.deepEqual(request.containers[0].volume_mounts, []);
  assert.equal(request.annotations["kakurizai.hostMount"], "false");
  assert.equal(request.annotations["kakurizai.mountMode"], "none");
  assert.doesNotMatch(request.containers[0].args[0], /mount -t overlay/);
});

test("world disk size update is saved for later CubeSandbox requests", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-"));
  const source = path.join(tmp, "source");
  await fs.mkdir(source);
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  const store = new WorldStore(config);
  const world = await store.create({
    name: "cube-resize",
    sourcePath: source,
    backend: "cube-sandbox-overlay",
    backendConfig: { writableLayerSize: "1G" }
  });
  world.backendConfig.cubeRequest = buildCubeSandboxRequest(world, {
    template: "base",
    workspacePath: "/workspace",
    writableLayerSize: "1G"
  });
  await store.save(world);

  const result = await updateWorldConfig(config, world.id, { writableLayerSize: "3G" });

  assert.equal(result.appliedToRunningSandbox, false);
  assert.match(result.reason, /saved for next sandbox create or recreate/);
  assert.equal(result.world.backendConfig.writableLayerSize, "3G");
  assert.equal(result.world.backendConfig.writableLayerMinimumSize, "1G");
  assert.equal(result.world.backendConfig.cubeRequest.annotations["cube.master.rootfs.writable_layer_size"], "3G");
  assert.equal(result.world.backendConfig.cubeRequest.annotations["cube.master.system_disk_size"], "3");
  assert.equal(result.world.backendConfig.cubeRequest.containers[0].annotations["cube.master.rootfs.writable_layer_size"], "3G");
  const rootVolume = result.world.backendConfig.cubeRequest.volumes.find((volume) => volume.name === "cube_rootfs_rw");
  assert.equal(rootVolume.volume_source.empty_dir.size_limit, "3G");
  const rootMount = result.world.backendConfig.cubeRequest.containers[0].volume_mounts.find((mount) => mount.name === "cube_rootfs_rw");
  assert.equal(rootMount.container_path, "/");
});

test("world disk size cannot shrink below current or original size", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-"));
  const source = path.join(tmp, "source");
  await fs.mkdir(source);
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  const store = new WorldStore(config);
  const world = await store.create({
    name: "cube-no-shrink",
    sourcePath: source,
    backend: "cube-sandbox-overlay",
    backendConfig: { writableLayerSize: "2G", writableLayerMinimumSize: "2G" }
  });

  await assert.rejects(
    () => updateWorldConfig(config, world.id, { writableLayerSize: "1G" }),
    /must be larger/
  );
  await assert.rejects(
    () => updateWorldConfig(config, world.id, { writableLayerSize: "2G", recreate: true }),
    /must be larger/
  );
});

test("cube request carries network, DNS, and Kubernetes lab settings", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-"));
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  const store = new WorldStore(config);
  const world = await store.create({
    name: "cube-k8s",
    backend: "cube-sandbox-overlay",
    backendConfig: {
      hostMount: false,
      mountMode: "none",
      network: {
        type: "tap",
        exposedPorts: [8080],
        dns: { servers: ["8.8.8.8"] },
        allowInternetAccess: false,
        denyOut: ["10.0.0.0/8"]
      },
      kubernetes: {
        enabled: true,
        profile: "k3s",
        clusterName: "lab-a",
        nodeRole: "control-plane",
        nodeName: "cp-1",
        cni: "flannel",
        podCidr: "10.42.0.0/16",
        serviceCidr: "10.43.0.0/16",
        advertiseAddress: "10.0.0.20",
        joinEndpoint: "https://10.0.0.20:6443",
        joinToken: "token-123",
        extraArgs: ["--disable=traefik"],
        apiServerPort: 6443,
        nodePorts: [30000]
      }
    }
  });

  const request = buildCubeSandboxRequest(world, { template: "base" });

  assert.equal(request.network_type, "tap");
  assert.deepEqual(request.exposed_ports, [6443, 8080, 30000]);
  assert.equal(request.annotations["com.exposed_ports"], "6443:8080:30000");
  assert.equal(request.annotations["kakurizai.kubernetes.cluster"], "lab-a");
  assert.equal(request.annotations["kakurizai.kubernetes.nodeRole"], "control-plane");
  assert.equal(request.annotations["kakurizai.kubernetes.nodeName"], "cp-1");
  assert.equal(request.annotations["kakurizai.kubernetes.cni"], "flannel");
  assert.equal(request.annotations["kakurizai.kubernetes.podCidr"], "10.42.0.0/16");
  assert.equal(request.annotations["kakurizai.kubernetes.serviceCidr"], "10.43.0.0/16");
  assert.equal(request.annotations["kakurizai.kubernetes.joinEndpoint"], "https://10.0.0.20:6443");
  assert.equal(request.annotations["kakurizai.kubernetes.joinToken"], "token-123");
  assert.equal(request.annotations["kakurizai.kubernetes.advertiseAddress"], "10.0.0.20");
  assert.equal(request.annotations["kakurizai.kubernetes.extraArgs"], "--disable=traefik");
  assert.equal(request.labels["kakurizai.kubernetes.cluster"], "lab-a");
  assert.equal(request.labels["kakurizai.kubernetes.node-role"], "control-plane");
  assert.equal(request.containers[0].annotations["kakurizai.kubernetes.cluster"], "lab-a");
  assert.deepEqual(request.cube_network_config, {
    allowInternetAccess: false,
    denyOut: ["10.0.0.0/8"]
  });
  assert.deepEqual(request.containers[0].dns_config.servers, ["8.8.8.8"]);
  assert.match(request.containers[0].dns_config.searches.join(","), /cluster\.local/);
  assert.equal(request.containers[0].security_context.privileged, true);
  assert.equal(request.containers[0].sysctls["net.ipv4.ip_forward"], "1");
});

test("cube request carries TAP NAT, VLAN, forward, and L7 egress settings", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-"));
  const config = await loadConfig({ home: path.join(tmp, "home"), createSecrets: false });
  const store = new WorldStore(config);
  const world = await store.create({
    name: "cube-tap-full",
    backend: "cube-sandbox-overlay",
    backendConfig: {
      hostMount: false,
      mountMode: "none",
      network: {
        type: "tap",
        mode: "tap-nat",
        exposedPorts: [22, 6443],
        dns: {
          servers: ["1.1.1.1"],
          searches: ["svc.cluster.local"],
          options: ["ndots:5"]
        },
        allowInternetAccess: true,
        allowOut: ["0.0.0.0/0"],
        denyOut: ["10.0.0.0/8"],
        rules: [
          {
            name: "allow-api",
            match: { host: "api.example.com", method: ["GET"] },
            action: { allow: true, audit: "log" }
          }
        ],
        vlan: {
          enabled: true,
          vlanId: 100,
          hostInterface: "eth0",
          bridgeName: "br100"
        },
        nat: {
          enabled: true,
          masquerade: true,
          outboundInterface: "tailscale0",
          subnet: "10.244.0.0/16",
          gateway: "10.244.0.1",
          portForwards: [
            { name: "ssh", protocol: "tcp", hostPort: 2222, sandboxPort: 22 }
          ]
        }
      }
    }
  });

  const request = buildCubeSandboxRequest(world, { template: "base" });

  assert.equal(request.network_type, "tap");
  assert.equal(request.annotations["kakurizai.network.mode"], "tap-nat");
  assert.equal(request.annotations["kakurizai.network.vlan.enabled"], "true");
  assert.equal(request.annotations["kakurizai.network.nat.enabled"], "true");
  assert.deepEqual(JSON.parse(request.annotations["kakurizai.network.vlan"]), {
    enabled: true,
    vlanId: 100,
    hostInterface: "eth0",
    bridgeName: "br100"
  });
  assert.deepEqual(JSON.parse(request.annotations["kakurizai.network.portForwards"]), [
    {
      name: "ssh",
      protocol: "tcp",
      listenAddress: null,
      hostPort: 2222,
      sandboxPort: 22,
      targetAddress: null
    }
  ]);
  assert.deepEqual(request.cube_network_config, {
    allowInternetAccess: true,
    allowOut: ["0.0.0.0/0"],
    denyOut: ["10.0.0.0/8"],
    rules: [
      {
        name: "allow-api",
        match: { host: "api.example.com", method: ["GET"] },
        action: { allow: true, audit: "log" }
      }
    ]
  });
  assert.deepEqual(request.containers[0].dns_config, {
    servers: ["1.1.1.1"],
    searches: ["svc.cluster.local"],
    options: ["ndots:5"]
  });
});

test("sandbox manifest drives create input and Terraform bundle", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-spec-"));
  const manifest = parseSandboxManifest(`
apiVersion: kakurizai.dev/v1
kind: Sandbox
metadata:
  name: lab
spec:
  hostMount: false
  resources:
    cpu: 4000m
    memory: 4096Mi
    writableLayerSize: 4G
  network:
    type: tap
    exposedPorts: [6443]
    dns:
      servers: [1.1.1.1]
    allowInternetAccess: false
  kubernetes:
    enabled: true
    profile: k3s
    clusterName: lab-a
    nodeRole: worker
    joinEndpoint: https://cp:6443
    joinToken: token-123
`);

  const input = manifestToCreateInput(manifest);
  assert.equal(input.name, "lab");
  assert.equal(input.hostMount, false);
  assert.equal(input.mountMode, "none");
  assert.equal(input.cpu, "4000m");
  assert.equal(input.network.exposedPorts[0], 6443);
  assert.equal(input.kubernetes.enabled, true);
  assert.equal(input.kubernetes.clusterName, "lab-a");
  assert.equal(input.kubernetes.nodeRole, "worker");
  assert.equal(input.kubernetes.joinEndpoint, "https://cp:6443");

  const result = await writeTerraformBundle(manifest, path.join(tmp, "tf"));
  assert.deepEqual(result.files.map((file) => path.basename(file)).sort(), ["README.md", "main.tf", "sandbox.yaml"]);
  const mainTf = await fs.readFile(path.join(tmp, "tf", "main.tf"), "utf8");
  assert.match(mainTf, /apply -f/);
  assert.match(mainTf, /remove/);
});

test("network config rejects unsupported CubeSandbox network types", () => {
  assert.throws(
    () => normalizeNetworkConfig({ type: "vlan", vlan: { enabled: true, vlanId: 100, hostInterface: "eth0" } }),
    /supports network\.type=tap only/
  );
});

test("kubernetes config validates node roles", () => {
  assert.equal(normalizeKubernetesConfig({ enabled: true, nodeRole: "worker" }).nodeRole, "worker");
  assert.throws(
    () => normalizeKubernetesConfig({ enabled: true, nodeRole: "database" }),
    /nodeRole/
  );
});

test("network config validates NAT forward ports", () => {
  assert.throws(
    () => normalizeNetworkConfig({
      type: "tap",
      nat: {
        enabled: true,
        portForwards: [{ name: "bad", protocol: "tcp", hostPort: 0, sandboxPort: 22 }]
      }
    }),
    /hostPort/
  );
});
