import React from "react";
import { createRoot } from "react-dom/client";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  Activity,
  Box,
  Code2,
  Cpu,
  Database,
  ExternalLink,
  Folder,
  FolderOpen,
  Globe2,
  HardDrive,
  KeyRound,
  Layers,
  Monitor,
  Moon,
  MoreHorizontal,
  Network,
  Pause,
  Plus,
  Play,
  RefreshCcw,
  Route,
  Search,
  Server,
  Shield,
  Sun,
  Terminal,
  Trash2,
  X
} from "lucide-react";
import "./styles.css";

type AuthConfig = {
  provider: string;
  label: string;
  issuer?: string;
  audience?: string;
  requiresToken: boolean;
};

type World = {
  id: string;
  name: string;
  status: string;
  sourcePath: string;
  backend: string;
  createdAt: string;
  updatedAt: string;
  sandbox?: {
    id?: string;
    baseId?: string;
    status?: string;
    reason?: string;
    sandboxIp?: string | null;
    runtimeSandboxIp?: string | null;
    mountMode?: string;
    pausedAt?: string | null;
    bootstrap?: {
      pending?: boolean;
      applied?: boolean;
      skipped?: boolean;
      reason?: string | null;
    } | null;
  } | null;
  backendConfig?: {
    mountMode?: string;
    template?: string | null;
    cpu?: string | null;
    memory?: string | null;
    writableLayerSize?: string | null;
    writableLayerMinimumSize?: string | null;
    networkType?: string | null;
    network?: NetworkConfig | null;
    kubernetes?: KubernetesConfig | null;
    hostMount?: boolean | null;
    mounts?: HostMountConfig[] | Record<string, unknown>;
  };
  diskUsage?: {
    upperBytes: number;
    logsBytes: number;
  };
};

type CubeTemplate = {
  id: string;
  status: string;
  createdAt?: string;
  image?: string;
  instanceType?: string | null;
  version?: string | null;
  cpu?: string | null;
  memory?: string | null;
  writableLayerSize?: string | null;
  artifactSizeBytes?: number | null;
  exposedPorts?: string | null;
  probePath?: string | null;
  probePort?: number | string | null;
  networkType?: string | null;
  allowInternetAccess?: boolean | null;
  replicas?: Array<Record<string, unknown>>;
  env?: string[];
  detailError?: string;
};

type CubeNode = {
  id: string;
  nodeId: string;
  ip?: string | null;
  instanceType?: string | null;
  status: string;
  healthy: boolean;
  clusterLabel?: string | null;
  cpuTotal?: number | null;
  memTotalMB?: number | null;
  quotaCpu?: number | null;
  quotaMemMB?: number | null;
  quotaCpuUsage?: number | null;
  quotaMemUsage?: number | null;
  maxMvmLimit?: number | null;
  mvmNum?: number | null;
  dataDiskUsagePer?: number | null;
  storageDiskUsagePer?: number | null;
  sysDiskUsagePer?: number | null;
  metadataUpdatedAt?: string | null;
  metricUpdatedAt?: string | null;
  labels?: Record<string, string>;
};

type CubeStorage = {
  nodeId: string;
  nodeIp: string;
  mode: string;
  usagePct?: number | null;
  lastError?: string;
  updatedAt?: string;
};

type CubeVolumeMount = {
  name?: string;
  container_path?: string;
  readonly?: boolean;
  host_path?: string;
  recursive_read_only?: boolean;
  mode?: string;
};

type CubePortMapping = {
  container_port?: number;
  host_port?: number;
};

type NetworkConfig = {
  type?: string;
  mode?: string;
  sandboxIp?: string | null;
  vlan?: VlanConfig | null;
  nat?: NatConfig | null;
  exposedPorts?: number[];
  allowInternetAccess?: boolean;
  allowOut?: string[];
  denyOut?: string[];
  rules?: EgressRule[];
  dns?: {
    servers?: string[];
    searches?: string[];
    options?: string[];
  };
};

type VlanConfig = {
  enabled?: boolean;
  vlanId?: number | null;
  hostInterface?: string | null;
  bridgeName?: string | null;
};

type NatConfig = {
  enabled?: boolean;
  masquerade?: boolean;
  outboundInterface?: string | null;
  subnet?: string | null;
  gateway?: string | null;
  portForwards?: PortForwardConfig[];
};

type PortForwardConfig = {
  name?: string;
  protocol?: "tcp" | "udp" | string;
  listenAddress?: string | null;
  hostPort?: number;
  sandboxPort?: number;
  targetAddress?: string | null;
};

type EgressRule = Record<string, unknown>;

type KubernetesConfig = {
  enabled?: boolean;
  profile?: string;
  clusterName?: string;
  nodeRole?: string;
  nodeName?: string;
  cni?: string;
  podCidr?: string;
  serviceCidr?: string;
  joinEndpoint?: string;
  joinToken?: string;
  advertiseAddress?: string;
  extraArgs?: string[];
  apiServerPort?: number;
  nodePorts?: number[];
  sysctls?: Record<string, string>;
};

type RuntimeSandbox = {
  id: string;
  status: string;
  hostId?: string;
  hostIp?: string | null;
  sandboxIp?: string | null;
  createdAt?: string;
  pausedAt?: string;
  templateId?: string | null;
  namespace?: string | null;
  cpu?: string | null;
  memory?: string | null;
  image?: string | null;
  instanceType?: string | null;
  writableLayerSize?: string | null;
  systemDiskSize?: string | null;
  artifactSizeBytes?: number | null;
  hostDataDiskMB?: number | null;
  hostStorageDiskMB?: number | null;
  volumeMounts?: CubeVolumeMount[];
  portMappings?: CubePortMapping[];
  exposedEndpoint?: string | null;
  exposedPortMode?: string | null;
  requestedContainerPort?: number | null;
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
  inspectError?: string | null;
  logs?: string;
  logsError?: string | null;
};

type CubeInspect = {
  available: boolean;
  mode: string;
  reason?: string | null;
  namespace: string;
  template?: string | null;
  cubecli?: { path: string; version?: string | null } | null;
  mastercli?: { path: string } | null;
  templates: CubeTemplate[];
  sandboxes: RuntimeSandbox[];
  nodes?: CubeNode[];
  storage?: CubeStorage[];
  config?: {
    apiEndpoint?: string | null;
    authEnabled?: boolean;
    sandboxDomain?: string | null;
    instanceType?: string | null;
    networkType?: string | null;
  };
  capabilities?: {
    destroy: boolean;
    logs: boolean;
    pause: boolean;
    resume: boolean;
  };
  templatesError?: string | null;
  sandboxesError?: string | null;
  nodesError?: string | null;
  storageError?: string | null;
};

type BrowseResult = {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string; type: "directory" }>;
};

type DevAccessSession = {
  worldId: string;
  worldName: string;
  sandboxIp?: string | null;
  workspace?: string | null;
  vscodeUrl?: string | null;
  vscodePort?: number | null;
  vscodeForwardPort?: number | null;
  sshHost?: string | null;
  sshPort?: number | null;
  sshUri?: string | null;
  sshCommand?: string | null;
};

type NetworkProbePlan = {
  generatedAt: string;
  nodes: ProbeNode[];
  edges: ProbeEdge[];
  forwards: PortForwardConfig[];
};

type ProbeNode = {
  worldId: string;
  name: string;
  sandboxIp?: string | null;
  host?: string | null;
  canProbe?: boolean;
  kubernetes?: {
    enabled?: boolean;
    profile?: string;
    clusterName?: string;
    nodeRole?: string;
    nodeName?: string;
    podCidr?: string;
    serviceCidr?: string;
    joinEndpoint?: string;
    apiServerPort?: number;
    nodePorts?: number[];
  };
};

type ProbeEdge = {
  fromWorldId: string;
  fromName: string;
  toWorldId: string;
  toName: string;
  toSandboxIp?: string | null;
  hostPath?: string;
  reachable?: boolean | null;
  reason?: string | null;
  checks?: Array<{ kind: string; port?: number | null; status: string; ok?: boolean; detail?: string }>;
};

type HostMountConfig = {
  id?: string;
  name?: string;
  sourcePath?: string;
  hostPath?: string;
  sandboxPath?: string;
  mode?: string;
};

type LaunchMount = {
  name: string;
  sourcePath: string;
  mode: string;
};

type NatForwardDraft = {
  name: string;
  protocol: string;
  listenAddress: string;
  hostPort: string;
  sandboxPort: string;
  targetAddress: string;
};

type EgressInjectDraft = {
  header: string;
  secret: string;
  format: string;
};

type EgressRuleDraft = {
  name: string;
  sni: string;
  host: string;
  methods: string;
  path: string;
  scheme: string;
  allow: boolean;
  audit: string;
  injects: EgressInjectDraft[];
};

type InventoryRow = {
  key: string;
  name: string;
  status: string;
  origin: string;
  sourcePath: string;
  mountMode: string;
  sandboxId: string;
  templateId?: string | null;
  cpu?: string | null;
  memory?: string | null;
  host?: string | null;
  createdAt?: string | null;
  world?: World;
  runtime?: RuntimeSandbox;
};

type StateFilter = "all" | "running" | "paused" | "other";
type AppView = "sandboxes" | "network";
type ThemeMode = "dark" | "light";
type DnsPresetKey = "default" | "cloudflare" | "google" | "quad9" | "custom";

const mountModes = [
  {
    id: "agctl-overlay",
    label: "agctl overlay",
    description: "Read-only host folder plus KakuriZai upper/work layers inside the sandbox."
  },
  {
    id: "cubesandbox-readonly",
    label: "Default read-only",
    description: "Mount the selected host folder directly as read-only inside the sandbox."
  },
  {
    id: "unsafe-rw",
    label: "Unsafe read-write",
    description: "Mount the host folder directly as writable inside the sandbox."
  }
];
const diskUnits = ["M", "G", "T"] as const;
const dnsPresets: Array<{ id: DnsPresetKey; label: string; servers: string[]; summary: string }> = [
  { id: "default", label: "Default", servers: [], summary: "Use CubeSandbox or image default DNS." },
  { id: "cloudflare", label: "Cloudflare", servers: ["1.1.1.1", "1.0.0.1"], summary: "1.1.1.1, 1.0.0.1" },
  { id: "google", label: "Google", servers: ["8.8.8.8", "8.8.4.4"], summary: "8.8.8.8, 8.8.4.4" },
  { id: "quad9", label: "Quad9", servers: ["9.9.9.9", "149.112.112.112"], summary: "9.9.9.9, 149.112.112.112" },
  { id: "custom", label: "Custom", servers: [], summary: "Set DNS servers, searches, and options." }
];

function Root() {
  const shellWorldId = shellWorldIdFromLocation();
  return shellWorldId ? <ShellPage worldId={shellWorldId} /> : <App />;
}

function App() {
  const [authConfig, setAuthConfig] = React.useState<AuthConfig | null>(null);
  const [token, setToken] = React.useState(() => localStorage.getItem("kakurizai.token") || "");
  const [session, setSession] = React.useState<string | null>(null);
  const [theme, setTheme] = React.useState<ThemeMode>(() => localStorage.getItem("kakurizai.theme") === "light" ? "light" : "dark");
  const [worlds, setWorlds] = React.useState<World[]>([]);
  const [cube, setCube] = React.useState<CubeInspect | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState("Starting");
  const [busy, setBusy] = React.useState(false);
  const [probeBusy, setProbeBusy] = React.useState(false);
  const [networkProbe, setNetworkProbe] = React.useState<NetworkProbePlan | null>(null);
  const [activeView, setActiveView] = React.useState<AppView>("sandboxes");
  const [actionMenuOpen, setActionMenuOpen] = React.useState(false);
  const [launchMenuOpen, setLaunchMenuOpen] = React.useState(false);
  const activityMenuRef = React.useRef<HTMLButtonElement | null>(null);
  const actionMenuRef = React.useRef<HTMLElement | null>(null);
  const launchMenuRef = React.useRef<HTMLFormElement | null>(null);
  const [formMessage, setFormMessage] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [stateFilter, setStateFilter] = React.useState<StateFilter>("all");
  const [launch, setLaunch] = React.useState({
    name: "kakurizai-sandbox",
    hostMount: false,
    sourcePath: "",
    mountMode: "agctl-overlay",
    mounts: [{ name: "project", sourcePath: "", mode: "agctl-overlay" }] as LaunchMount[],
    cpu: "2000m",
    memory: "2000Mi",
    writableLayerSize: "1G",
    networkType: "tap",
    networkMode: "tap",
    sandboxIp: "",
    exposedPorts: "",
    dnsServers: "",
    dnsSearches: "",
    dnsOptions: "",
    allowInternetAccess: true,
    allowOut: "",
    denyOut: "10.0.0.0/8,100.64.0.0/10,172.16.0.0/12,192.168.0.0/18",
    egressRules: [] as EgressRuleDraft[],
    vlanEnabled: false,
    vlanId: "",
    vlanHostInterface: "eth0",
    vlanBridgeName: "",
    natEnabled: true,
    natPortForwards: [] as NatForwardDraft[],
    kubernetesEnabled: false,
    kubernetesProfile: "k3s",
    kubernetesClusterName: "kakurizai",
    kubernetesNodeRole: "control-plane",
    kubernetesNodeName: "",
    kubernetesCni: "flannel",
    kubernetesPodCidr: "10.42.0.0/16",
    kubernetesServiceCidr: "10.43.0.0/16",
    kubernetesApiServerPort: "6443",
    kubernetesNodePorts: "30000,30001",
    kubernetesJoinEndpoint: "",
    kubernetesJoinToken: "",
    kubernetesAdvertiseAddress: "",
    kubernetesExtraArgs: "",
    kubernetesSysctls: defaultKubernetesSysctlsText()
  });
  const [browser, setBrowser] = React.useState<BrowseResult | null>(null);
  const [browserMountIndex, setBrowserMountIndex] = React.useState(0);

  const inventory = React.useMemo(() => buildInventory(worlds, cube), [worlds, cube]);
  const filteredInventory = React.useMemo(
    () => filterInventory(inventory, search, stateFilter),
    [inventory, search, stateFilter]
  );
  const selected = inventory.find((row) => row.key === selectedId) || filteredInventory[0] || inventory[0] || null;
  const selectedTemplate = findTemplateForSandbox(cube, selected);
  const selectedNode = findNodeForSandbox(cube, selected);

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("kakurizai.theme", theme);
  }, [theme]);

  React.useEffect(() => {
    api<AuthConfig>("/api/auth/config", { token: null })
      .then(setAuthConfig)
      .catch((error) => setStatus(error.message));
  }, []);

  React.useEffect(() => {
    if (!authConfig) return;
    if (!authConfig.requiresToken || token) void refresh();
    else setStatus("Sign in required");
  }, [authConfig]);

  React.useEffect(() => {
    if (!actionMenuOpen && !launchMenuOpen) return;

    function closeMenus() {
      setActionMenuOpen(false);
      setLaunchMenuOpen(false);
    }

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (activityMenuRef.current?.contains(target)) return;
      if (actionMenuRef.current?.contains(target)) return;
      if (launchMenuRef.current?.contains(target)) return;
      closeMenus();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeMenus();
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [actionMenuOpen, launchMenuOpen]);

  async function refresh() {
    setBusy(true);
    try {
      const [sessionResult, worldsResult, cubeResult] = await Promise.all([
        api<{ user: { subject: string } }>("/api/session", { token }),
        api<World[]>("/api/worlds", { token }),
        api<CubeInspect>("/api/cube/inspect", { token })
      ]);
      const nextInventory = buildInventory(worldsResult, cubeResult);
      setSession(sessionResult.user.subject);
      setWorlds(worldsResult);
      setCube(cubeResult);
      setSelectedId((current) => nextInventory.some((row) => row.key === current) ? current : nextInventory[0]?.key || null);
      setStatus(`${nextInventory.length} Sandbox${nextInventory.length === 1 ? "" : "es"} / ${cubeResult.sandboxes.length} runtime`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    localStorage.setItem("kakurizai.token", token);
    await refresh();
  }

  async function openCreateMenu() {
    setActionMenuOpen(false);
    setLaunchMenuOpen(true);
    setFormMessage("");
    if (launch.hostMount && !browser) {
      try {
        await browse(activeLaunchMount().sourcePath || "/home/mizuame", browserMountIndex);
      } catch (error) {
        setFormMessage(error instanceof Error ? error.message : String(error));
      }
    }
  }

  async function browse(path: string, mountIndex = browserMountIndex) {
    const result = await api<BrowseResult>(`/api/host/browse?path=${encodeURIComponent(path || "/")}`, { token });
    setBrowser(result);
    setBrowserMountIndex(mountIndex);
    setLaunch((current) => {
      const mounts = ensureLaunchMounts(current.mounts).map((mount, index) => index === mountIndex
        ? {
            ...mount,
            sourcePath: result.path,
            name: mount.name.trim() ? mount.name : suggestMountName(result.path)
          }
        : mount
      );
      return {
        ...current,
        mounts,
        sourcePath: mounts[0]?.sourcePath || "",
        mountMode: mounts[0]?.mode || current.mountMode
      };
    });
  }

  async function toggleHostMount(enabled: boolean) {
    setLaunch((current) => ({
      ...current,
      hostMount: enabled,
      mountMode: enabled && current.mountMode === "none" ? "agctl-overlay" : current.mountMode,
      mounts: ensureLaunchMounts(current.mounts)
    }));
    if (enabled && !browser) {
      try {
        await browse(activeLaunchMount().sourcePath || "/home/mizuame", 0);
      } catch (error) {
        setFormMessage(error instanceof Error ? error.message : String(error));
      }
    }
  }

  async function createSandbox(event: React.FormEvent) {
    event.preventDefault();
    if (!launch.name.trim()) {
      setFormMessage("Enter a sandbox name.");
      return;
    }
    const launchMounts = ensureLaunchMounts(launch.mounts)
      .filter((mount) => mount.sourcePath.trim())
      .map((mount) => ({
        name: mount.name.trim() || suggestMountName(mount.sourcePath),
        sourcePath: mount.sourcePath.trim(),
        mode: mount.mode
      }));
    if (launch.hostMount && launchMounts.length === 0) {
      setFormMessage("Choose at least one host folder.");
      return;
    }
    setBusy(true);
    setFormMessage("");
    try {
      const world = await api<World>("/api/worlds", {
        method: "POST",
        token,
        body: {
          name: launch.name.trim(),
          sourcePath: launch.hostMount ? launchMounts[0]?.sourcePath : undefined,
          mounts: launch.hostMount ? launchMounts : undefined,
          backend: "cube-sandbox-overlay",
          hostMount: launch.hostMount,
          mountMode: launch.hostMount ? launchMounts[0]?.mode || launch.mountMode : "none",
          cpu: launch.cpu,
          memory: launch.memory,
          writableLayerSize: launch.writableLayerSize,
          networkType: launch.networkType,
          network: {
            type: launch.networkType,
            mode: launch.networkMode,
            sandboxIp: launch.sandboxIp,
            exposedPorts: parsePortList(launch.exposedPorts),
            dns: {
              servers: parseCsv(launch.dnsServers),
              searches: parseCsv(launch.dnsSearches),
              options: parseCsv(launch.dnsOptions)
            },
            allowInternetAccess: launch.allowInternetAccess,
            allowOut: parseCsv(launch.allowOut),
            denyOut: parseCsv(launch.denyOut),
            rules: egressRuleDraftsToRules(launch.egressRules),
            vlan: {
              enabled: launch.vlanEnabled,
              vlanId: launch.vlanId ? Number(launch.vlanId) : null,
              hostInterface: launch.vlanHostInterface,
              bridgeName: launch.vlanBridgeName
            },
            nat: {
              enabled: !launch.vlanEnabled && launch.natEnabled,
              masquerade: !launch.vlanEnabled && launch.natEnabled,
              portForwards: natForwardDraftsToForwards(launch.natPortForwards)
            }
          },
          kubernetes: {
            enabled: launch.kubernetesEnabled,
            profile: launch.kubernetesProfile,
            clusterName: launch.kubernetesClusterName,
            nodeRole: launch.kubernetesNodeRole,
            nodeName: launch.kubernetesNodeName,
            cni: launch.kubernetesCni,
            podCidr: launch.kubernetesPodCidr,
            serviceCidr: launch.kubernetesServiceCidr,
            apiServerPort: Number(launch.kubernetesApiServerPort || 6443),
            nodePorts: launch.kubernetesEnabled ? parsePortList(launch.kubernetesNodePorts) : [],
            joinEndpoint: launch.kubernetesJoinEndpoint,
            joinToken: launch.kubernetesJoinToken,
            advertiseAddress: launch.kubernetesAdvertiseAddress,
            extraArgs: parseLines(launch.kubernetesExtraArgs),
            sysctls: parseKeyValueLines(launch.kubernetesSysctls)
          }
        }
      });
      setLaunchMenuOpen(false);
      setSelectedId(`world:${world.id}`);
      await refresh();
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function activeLaunchMount() {
    return ensureLaunchMounts(launch.mounts)[browserMountIndex] || ensureLaunchMounts(launch.mounts)[0];
  }

  function updateLaunchMount(index: number, patch: Partial<LaunchMount>) {
    setLaunch((current) => {
      const mounts = ensureLaunchMounts(current.mounts).map((mount, mountIndex) => mountIndex === index ? { ...mount, ...patch } : mount);
      return {
        ...current,
        mounts,
        sourcePath: mounts[0]?.sourcePath || "",
        mountMode: mounts[0]?.mode || current.mountMode
      };
    });
  }

  function addLaunchMount() {
    setLaunch((current) => ({
      ...current,
      hostMount: true,
      mounts: [
        ...ensureLaunchMounts(current.mounts),
        { name: `mount-${ensureLaunchMounts(current.mounts).length + 1}`, sourcePath: "", mode: "agctl-overlay" }
      ]
    }));
  }

  function removeLaunchMount(index: number) {
    setLaunch((current) => {
      const mounts = ensureLaunchMounts(current.mounts).filter((_, mountIndex) => mountIndex !== index);
      const nextMounts = mounts.length ? mounts : [{ name: "project", sourcePath: "", mode: "agctl-overlay" }];
      return {
        ...current,
        mounts: nextMounts,
        sourcePath: nextMounts[0]?.sourcePath || "",
        mountMode: nextMounts[0]?.mode || current.mountMode
      };
    });
    setBrowserMountIndex(0);
  }

  async function saveDiskSize(world: World, writableLayerSize: string, recreate = false) {
    const nextSize = writableLayerSize.trim();
    if (!nextSize) {
      setStatus("Enter writable layer size.");
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ world: World; appliedToRunningSandbox: boolean; reason: string }>(
        `/api/worlds/${encodeURIComponent(world.id)}/config`,
        { method: "PATCH", token, body: { writableLayerSize: nextSize, recreate } }
      );
      setWorlds((current) => current.map((candidate) => candidate.id === result.world.id ? result.world : candidate));
      setStatus(result.appliedToRunningSandbox ? `Disk applied by recreating ${result.world.name}` : `Disk saved for next recreate: ${result.world.name}`);
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveNetworkSettings(world: World, network: NetworkConfig, kubernetes: KubernetesConfig) {
    setBusy(true);
    try {
      const result = await api<{ world: World; appliedToRunningSandbox: boolean; reason: string }>(
        `/api/worlds/${encodeURIComponent(world.id)}/config`,
        { method: "PATCH", token, body: { network, networkType: network.type, kubernetes, recreate: true } }
      );
      setWorlds((current) => current.map((candidate) => candidate.id === result.world.id ? result.world : candidate));
      setStatus(result.appliedToRunningSandbox ? `Network applied by recreating ${result.world.name}` : `Network saved for next create/recreate: ${result.world.name}`);
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function runNetworkProbe(live = true) {
    setProbeBusy(true);
    try {
      const result = await api<NetworkProbePlan>("/api/network/probe", {
        method: "POST",
        token,
        body: { live, timeoutSeconds: 2, maxPortsPerTarget: 8 }
      });
      setNetworkProbe(result);
      const reachable = result.edges.filter((edge) => edge.reachable === true).length;
      const failed = result.edges.filter((edge) => edge.reachable === false).length;
      setStatus(`Network probe: ${reachable} reachable / ${failed} blocked`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setProbeBusy(false);
    }
  }

  async function destroySelected() {
    if (!selected) return;
    if (!confirm(`Delete sandbox ${selected.name}?`)) return;
    setBusy(true);
    try {
      if (selected.world) {
        await api(`/api/worlds/${encodeURIComponent(selected.world.id)}`, { method: "DELETE", token });
      } else if (selected.sandboxId) {
        await api(`/api/cube/sandboxes/${encodeURIComponent(selected.sandboxId)}/destroy`, { method: "POST", token });
      }
      setSelectedId(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function pauseSelected() {
    if (!selected?.sandboxId) return;
    setBusy(true);
    try {
      const result = selected.world
        ? await api<{ world: World; applied?: boolean; reason?: string }>(`/api/worlds/${encodeURIComponent(selected.world.id)}/pause`, { method: "POST", token })
        : await api<{ applied?: boolean; reason?: string }>(`/api/cube/sandboxes/${encodeURIComponent(selected.sandboxId)}/pause`, { method: "POST", token });
      if (result.applied === false) throw new Error(result.reason || `Failed to pause ${selected.name}`);
      setStatus(`Paused ${selected.name}`);
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function resumeSelected() {
    if (!selected?.sandboxId) return;
    setBusy(true);
    try {
      const result = selected.world
        ? await api<{ world: World; applied?: boolean; reason?: string }>(`/api/worlds/${encodeURIComponent(selected.world.id)}/resume`, { method: "POST", token })
        : await api<{ applied?: boolean; reason?: string }>(`/api/cube/sandboxes/${encodeURIComponent(selected.sandboxId)}/resume`, { method: "POST", token });
      if (result.applied === false) throw new Error(result.reason || `Failed to resume ${selected.name}`);
      setStatus(`Resumed ${selected.name}`);
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (authConfig?.requiresToken && !session) {
    return (
      <div className="loginPage">
        <form className="loginPanel" onSubmit={signIn}>
          <div className="mark"><Shield size={22} /></div>
          <h1>KakuriZai Console</h1>
          <p>{authConfig.label}</p>
          <div className="authMeta">
            <span>Provider</span><strong>{authConfig.provider}</strong>
            <span>Issuer</span><strong>{authConfig.issuer || "-"}</strong>
            <span>Audience</span><strong>{authConfig.audience || "-"}</strong>
          </div>
          <label>
            Bearer token
            <input value={token} onChange={(event) => setToken(event.target.value)} placeholder="eyJ..." />
          </label>
          <button className="primary wide" type="submit"><KeyRound size={16} /> Sign in</button>
        </form>
      </div>
    );
  }

  const isNetworkView = activeView === "network";
  const titleLabel = isNetworkView ? "Network" : selected ? selected.name : "No sandbox selected";
  const subtitleLabel = isNetworkView
    ? selected ? `${selected.name} / ${selected.runtime?.sandboxIp || selected.sandboxId || subtitleForSandbox(selected)}` : status
    : selected ? subtitleForSandbox(selected) : status;

  return (
    <main className={`workbench ${isNetworkView ? "networkWorkbench" : ""}`}>
      <aside className="activityBar">
        <button
          ref={activityMenuRef}
          className={`activityButton ${actionMenuOpen || launchMenuOpen ? "active" : ""}`}
          onClick={() => {
            setLaunchMenuOpen(false);
            setActionMenuOpen((value) => !value);
          }}
          title="Menu"
          type="button"
        >
          <MoreHorizontal size={22} />
        </button>
        <button
          className={`activityButton ${activeView === "sandboxes" ? "active" : ""}`}
          onClick={() => {
            setActiveView("sandboxes");
            setActionMenuOpen(false);
            setLaunchMenuOpen(false);
          }}
          title="Sandboxes"
          type="button"
        >
          <Monitor size={21} />
        </button>
        <button
          className={`activityButton ${activeView === "network" ? "active" : ""}`}
          onClick={() => {
            setActiveView("network");
            setActionMenuOpen(false);
            setLaunchMenuOpen(false);
          }}
          title="Network"
          type="button"
        >
          <Network size={21} />
        </button>
      </aside>

      {actionMenuOpen ? (
        <section className="actionMenu" ref={actionMenuRef}>
          <button className="actionMenuItem" onClick={() => void openCreateMenu()} type="button">
            <Plus size={16} />
            <span>Create Sandbox</span>
          </button>
        </section>
      ) : null}

      {launchMenuOpen ? (
        <form className="newSandboxMenu" onSubmit={createSandbox} ref={launchMenuRef}>
          <header>
            <strong>New Sandbox</strong>
            <button className="iconButton ghost" onClick={() => setLaunchMenuOpen(false)} title="Close" type="button">
              <X size={16} />
            </button>
          </header>

          <label>Name</label>
          <input value={launch.name} onChange={(event) => setLaunch({ ...launch, name: event.target.value })} autoFocus />

          <div className="toggleRow">
            <label className="checkRow">
              <input
                type="checkbox"
                checked={launch.hostMount}
                onChange={(event) => void toggleHostMount(event.target.checked)}
              />
              <span>
                <strong>Host mount</strong>
                <small>Attach a host folder</small>
              </span>
            </label>
          </div>

          {launch.hostMount ? (
            <>
              <div className="fieldHeader">
                <label>Host mounts</label>
                <button className="ghost smallButton" type="button" onClick={addLaunchMount}>
                  <Plus size={14} />
                  Add
                </button>
              </div>
              <div className="mountEditorList">
                {ensureLaunchMounts(launch.mounts).map((mount, index) => (
                  <div className="mountEditorRow" key={index}>
                    <div className="splitFields compactFields">
                      <div>
                        <label>Name</label>
                        <input value={mount.name} onChange={(event) => updateLaunchMount(index, { name: event.target.value })} placeholder="project" />
                      </div>
                      <div>
                        <label>Sandbox path</label>
                        <input value={`/workspace/${slugMountName(mount.name || `mount-${index + 1}`)}`} readOnly />
                      </div>
                    </div>
                    <label>Host folder</label>
                    <div className="inputRow">
                      <input value={mount.sourcePath} onChange={(event) => updateLaunchMount(index, { sourcePath: event.target.value })} placeholder="/home/mizuame/project" />
                      <button className="iconButton" type="button" onClick={() => browse(mount.sourcePath || "/home/mizuame", index)} title="Browse">
                        <FolderOpen size={16} />
                      </button>
                      <button className="iconButton dangerIcon" type="button" onClick={() => removeLaunchMount(index)} title="Remove mount" disabled={ensureLaunchMounts(launch.mounts).length <= 1}>
                        <Trash2 size={16} />
                      </button>
                    </div>
                    <div className="mountModes compactMountModes">
                      {mountModes.map((mode) => (
                        <button
                          key={mode.id}
                          type="button"
                          className={`mountChoice ${mount.mode === mode.id ? "active" : ""}`}
                          onClick={() => updateLaunchMount(index, { mode: mode.id })}
                        >
                          <strong>{mode.label}</strong>
                          <span>{mode.description}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {browser ? (
                <div className="folderBrowser">
                  <div className="folderHeader">
                    <button className="ghost" type="button" disabled={!browser.parent} onClick={() => browser.parent && browse(browser.parent, browserMountIndex)}>Up</button>
                    <strong>{browser.path}</strong>
                  </div>
                  <div className="folderList">
                    {browser.entries.map((entry) => (
                      <button type="button" key={entry.path} onClick={() => browse(entry.path, browserMountIndex)}>
                        <Folder size={14} />
                        <span>{entry.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

          <div className="splitFields">
            <div>
              <label>CPU</label>
              <input value={launch.cpu} onChange={(event) => setLaunch({ ...launch, cpu: event.target.value })} />
            </div>
            <div>
              <label>Memory</label>
              <input value={launch.memory} onChange={(event) => setLaunch({ ...launch, memory: event.target.value })} />
            </div>
          </div>

          <div className="splitFields">
            <div>
              <label>Disk size</label>
              <input value={launch.writableLayerSize} onChange={(event) => setLaunch({ ...launch, writableLayerSize: event.target.value })} placeholder="1G" />
            </div>
            <div>
              <label>Network type</label>
              <select value={launch.networkType} onChange={(event) => setLaunch({ ...launch, networkType: event.target.value })}>
                <option value="tap">tap</option>
              </select>
            </div>
          </div>

          <label>Sandbox IP</label>
          <input value={launch.sandboxIp} onChange={(event) => setLaunch({ ...launch, sandboxIp: event.target.value })} placeholder="auto, e.g. 192.168.1.50" />

          <DnsSettings
            servers={launch.dnsServers}
            searches={launch.dnsSearches}
            options={launch.dnsOptions}
            onChange={(next) => setLaunch((current) => ({ ...current, ...next }))}
          />

          <div className="togglePair">
            <div className="networkOptionCard">
              <label className="checkRow compactCheck">
                <input
                  type="checkbox"
                  checked={launch.allowInternetAccess}
                  onChange={(event) => setLaunch({ ...launch, allowInternetAccess: event.target.checked })}
                />
                <span>
                  <strong>Outbound internet</strong>
                  <small>Allow sandbox traffic to internet</small>
                </span>
              </label>
              {launch.allowInternetAccess ? (
                <div className="networkOptionFields">
                  <div>
                    <label>Allow CIDRs</label>
                    <input value={launch.allowOut} onChange={(event) => setLaunch({ ...launch, allowOut: event.target.value })} placeholder="0.0.0.0/0" />
                  </div>
                  <div>
                    <label>Deny CIDRs</label>
                    <input value={launch.denyOut} onChange={(event) => setLaunch({ ...launch, denyOut: event.target.value })} placeholder="10.0.0.0/8,172.16.0.0/12" />
                  </div>
                </div>
              ) : null}
            </div>
            {!launch.vlanEnabled ? <div className="networkOptionCard">
              <label className="checkRow compactCheck">
                <input
                  type="checkbox"
                  checked={launch.natEnabled}
                  onChange={(event) => setLaunch({ ...launch, natEnabled: event.target.checked })}
                />
                <span>
                  <strong>Outbound NAT</strong>
                  <small>Allow public outbound SNAT</small>
                </span>
              </label>
            </div> : null}
          </div>

          <NatForwardEditor
            forwards={launch.natPortForwards}
            onChange={(natPortForwards) => setLaunch({ ...launch, natPortForwards })}
          />

          <div className="toggleRow">
            <label className="checkRow compactCheck">
              <input
                type="checkbox"
                checked={launch.vlanEnabled}
                onChange={(event) => setLaunch({ ...launch, vlanEnabled: event.target.checked, natEnabled: event.target.checked ? false : launch.natEnabled })}
              />
              <span>
                <strong>VLAN</strong>
                <small>Host VLAN access bridge</small>
              </span>
            </label>
          </div>

          {launch.vlanEnabled ? (
            <div className="splitFields">
              <div>
                <label>VLAN ID</label>
                <input value={launch.vlanId} onChange={(event) => setLaunch({ ...launch, vlanId: event.target.value })} placeholder="100" />
              </div>
              <div>
                <label>Host interface</label>
                <input value={launch.vlanHostInterface} onChange={(event) => setLaunch({ ...launch, vlanHostInterface: event.target.value })} placeholder="eth0" />
              </div>
              <div>
                <label>Bridge name</label>
                <input value={launch.vlanBridgeName} onChange={(event) => setLaunch({ ...launch, vlanBridgeName: event.target.value })} placeholder="kzbr100" />
              </div>
            </div>
          ) : null}

          <EgressRuleEditor
            rules={launch.egressRules}
            onChange={(egressRules) => setLaunch({ ...launch, egressRules })}
          />

          {formMessage ? <div className="formMessage">{formMessage}</div> : null}

          <button className="primary wide" disabled={busy} type="submit">
            <Plus size={16} />
            {busy ? "Creating" : "Create"}
          </button>
        </form>
      ) : null}

      {!isNetworkView ? (
        <section className="sandboxPanel">
          <header className="panelHeader">
            <span>Sandboxes</span>
            <button className="iconButton ghost" onClick={() => void refresh()} title="Refresh" type="button" disabled={busy}>
              <RefreshCcw size={15} />
            </button>
          </header>
          <div className="panelSearch">
            <Search size={14} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search sandbox, template, host" />
          </div>
          <div className="stateFilters">
            {(["all", "running", "paused", "other"] as StateFilter[]).map((filter) => (
              <button key={filter} className={stateFilter === filter ? "active" : ""} onClick={() => setStateFilter(filter)} type="button">
                {filter}
              </button>
            ))}
          </div>
          <div className="sandboxList">
            {filteredInventory.map((row) => (
              <button key={row.key} className={`sandboxItem ${row.key === selected?.key ? "selected" : ""}`} onClick={() => setSelectedId(row.key)} type="button">
                <span className="sandboxTopLine">
                  <span className="sandboxName">{row.name}</span>
                  <span className={`sandboxState ${statusTone(row.status)}`}>{row.status}</span>
                </span>
                <span className="sandboxPath">{row.templateId || subtitleForSandbox(row)}</span>
                <span className="sandboxMetaLine">
                  <span>{row.cpu || "-"}</span>
                  <span>{row.memory || "-"}</span>
                  <span>{row.host || "-"}</span>
                </span>
              </button>
            ))}
            {filteredInventory.length === 0 ? <div className="emptyList">No sandboxes</div> : null}
          </div>
        </section>
      ) : null}

      <section className="mainArea">
        <header className="titleBar">
          <div>
            <strong>{titleLabel}</strong>
            <span>{subtitleLabel}</span>
          </div>
          <div className="toolbarActions">
            <button
              className="ghost iconButton"
              onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              type="button"
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button className="ghost" onClick={() => void refresh()} title="Refresh" type="button" disabled={busy}>
              <RefreshCcw size={16} />
            </button>
            {!isNetworkView && selected && isPausedStatus(selected.status) ? (
              <button
                className="ghost"
                onClick={() => void resumeSelected()}
                title={cube?.capabilities?.resume ? "Resume sandbox" : "Resume is not available on this CubeSandbox runtime"}
                type="button"
                disabled={busy || !selected.sandboxId || !cube?.capabilities?.resume}
              >
                <Play size={16} />
                Resume
              </button>
            ) : !isNetworkView && selected ? (
              <button
                className="ghost"
                onClick={() => void pauseSelected()}
                title={cube?.capabilities?.pause ? "Pause sandbox" : "Pause is not available on this CubeSandbox runtime"}
                type="button"
                disabled={busy || !selected.sandboxId || !cube?.capabilities?.pause}
              >
                <Pause size={16} />
                Pause
              </button>
            ) : null}
            {!isNetworkView && selected ? (
              <button className="danger" onClick={() => void destroySelected()} type="button" disabled={busy || !selected.sandboxId && !selected.world}>
                <Trash2 size={16} />
                Delete
              </button>
            ) : null}
          </div>
        </header>

        <section className="editorPane">
          {isNetworkView ? (
            <NetworkWorkspace
              selected={selected}
              rows={inventory}
              cube={cube}
              networkProbe={networkProbe}
              probeBusy={probeBusy}
              busy={busy}
              selectedTemplate={selectedTemplate}
              onProbe={runNetworkProbe}
              onSaveNetwork={saveNetworkSettings}
              onSelectSandbox={setSelectedId}
            />
          ) : selected ? (
            <div className="sandboxDashboard">
              <div className="overviewGrid">
                <Kpi icon={<Activity size={16} />} label="Status" value={selected.status} tone={statusTone(selected.status)} />
                <Kpi icon={<Cpu size={16} />} label="CPU" value={selected.cpu || selectedTemplate?.cpu || "-"} />
                <Kpi icon={<HardDrive size={16} />} label="Memory" value={selected.memory || selectedTemplate?.memory || "-"} />
                <Kpi icon={<Database size={16} />} label="Disk size" value={selected.runtime?.writableLayerSize || selected.world?.backendConfig?.writableLayerSize || selectedTemplate?.writableLayerSize || "-"} />
                <Kpi icon={<Server size={16} />} label="Node" value={selected.host || "-"} tone={selectedNode?.healthy === false ? "warn" : "ok"} />
                <Kpi icon={<Network size={16} />} label="Network" value={selectedTemplate?.networkType || cube?.config?.networkType || "-"} />
              </div>

              <DetailSection icon={<Box size={16} />} title="Sandbox">
                <div className="metricStrip">
                  <Metric label="Origin" value={selected.origin} />
                  <Metric label="Runtime" value={cube?.mode || "-"} />
                  <Metric label="Namespace" value={selected.runtime?.namespace || cube?.namespace || "-"} />
                  <Metric label="Created" value={formatDate(selected.createdAt)} />
                  <Metric label="Host mount" value={hasHostMount(selected) ? "enabled" : "disabled"} />
                  <Metric label="Terminal tools" value={formatBootstrapStatus(selected.world?.sandbox?.bootstrap)} />
                  <Metric label="Sandbox ID" value={selected.sandboxId || "-"} wide />
                  <Metric label="Source" value={hasHostMount(selected) ? selected.world?.sourcePath || selected.sourcePath || "-" : "-"} wide />
                  <Metric label="Base template" value={selected.templateId || selected.world?.sandbox?.baseId || cube?.template || "-"} wide />
                  <Metric label="Reason" value={selected.world?.sandbox?.reason || selected.runtime?.inspectError || "-"} wide />
                </div>
              </DetailSection>

              <DetailSection icon={<Terminal size={16} />} title="Terminal">
                <SandboxAccessLauncher world={selected.world} token={token} />
              </DetailSection>

              <DetailSection icon={<Database size={16} />} title="Storage and Mounts">
                <div className="metricStrip compact">
                  <Metric label="Disk size" value={selected.runtime?.writableLayerSize || selected.world?.backendConfig?.writableLayerSize || selectedTemplate?.writableLayerSize || "-"} />
                  <Metric label="System disk" value={selected.runtime?.systemDiskSize || "-"} />
                  <Metric label="Artifact" value={formatBytesNullable(selected.runtime?.artifactSizeBytes ?? selectedTemplate?.artifactSizeBytes)} />
                  <Metric label="Overlay usage" value={formatBytes(selected.world?.diskUsage?.upperBytes || 0)} />
                  <Metric label="Logs" value={formatBytes(selected.world?.diskUsage?.logsBytes || 0)} />
                  <Metric label="Host data disk" value={formatDiskMb(selected.runtime?.hostDataDiskMB)} />
                </div>
                <DiskEditor
                  world={selected.world}
                  runtimeSize={selected.runtime?.writableLayerSize || selectedTemplate?.writableLayerSize || ""}
                  minimumSize={diskMinimumForSelection(selected, selectedTemplate)}
                  busy={busy}
                  onSave={saveDiskSize}
                />
                <MountTable row={selected} mounts={mountRowsForSelection(selected)} />
              </DetailSection>

              <DetailSection icon={<Layers size={16} />} title="Template">
                {selectedTemplate ? (
                  <>
                    <div className="metricStrip compact">
                      <Metric label="Template" value={selectedTemplate.id} wide />
                      <Metric label="Status" value={selectedTemplate.status} />
                      <Metric label="Instance" value={selectedTemplate.instanceType || "-"} />
                      <Metric label="Version" value={selectedTemplate.version || "-"} />
                      <Metric label="CPU" value={selectedTemplate.cpu || "-"} />
                      <Metric label="Memory" value={selectedTemplate.memory || "-"} />
                      <Metric label="Exposed ports" value={selectedTemplate.exposedPorts || "-"} />
                      <Metric label="Probe" value={selectedTemplate.probePath ? `${selectedTemplate.probePath}:${selectedTemplate.probePort || "-"}` : "-"} />
                    </div>
                    <ReplicaList replicas={selectedTemplate.replicas || []} />
                  </>
                ) : (
                  <div className="sectionEmpty">No template detail available.</div>
                )}
              </DetailSection>

              <DetailSection icon={<Globe2 size={16} />} title="Gateway and Policy">
                <div className="metricStrip compact">
                  <Metric label="API endpoint" value={cube?.config?.apiEndpoint || "-"} wide />
                  <Metric label="Auth" value={cube?.config?.authEnabled ? "enabled" : "disabled"} />
                  <Metric label="Instance type" value={cube?.config?.instanceType || "-"} />
                  <Metric label="Default network" value={cube?.config?.networkType || "-"} />
                  <Metric label="Outbound internet" value={formatBool(selectedTemplate?.allowInternetAccess)} />
                </div>
              </DetailSection>
            </div>
          ) : (
            <div className="emptyState">
              <MoreHorizontal size={24} />
              <span>Open the top-left menu to create a sandbox.</span>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

function DetailSection({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="detailSection">
      <header>
        <span>{icon}</span>
        <strong>{title}</strong>
      </header>
      {children}
    </section>
  );
}

function NetworkWorkspace({
  selected,
  rows,
  cube,
  networkProbe,
  probeBusy,
  busy,
  selectedTemplate,
  onProbe,
  onSaveNetwork,
  onSelectSandbox
}: {
  selected: InventoryRow | null;
  rows: InventoryRow[];
  cube: CubeInspect | null;
  networkProbe: NetworkProbePlan | null;
  probeBusy: boolean;
  busy: boolean;
  selectedTemplate?: CubeTemplate | null;
  onProbe: (live?: boolean) => Promise<void>;
  onSaveNetwork: (world: World, network: NetworkConfig, kubernetes: KubernetesConfig) => Promise<void>;
  onSelectSandbox: (key: string) => void;
}) {
  if (!selected) {
    return (
      <div className="emptyState">
        <Network size={24} />
        <span>No sandbox network metadata.</span>
      </div>
    );
  }

  return (
    <div className="networkWorkspace">
      <section className="networkWorkspaceTop">
        <header className="networkWorkspaceHeader">
          <span><Route size={18} /></span>
          <div>
            <strong>Network</strong>
            <small>{selected.name} / {selected.runtime?.sandboxIp || selected.sandboxId || "planned"}</small>
          </div>
          <div className="probeToolbar">
            <button className="primary" onClick={() => void onProbe(true)} type="button" disabled={probeBusy || busy}>
              <Activity size={15} />
              {probeBusy ? "Probing" : "Probe"}
            </button>
            <button onClick={() => void onProbe(false)} type="button" disabled={probeBusy || busy}>
              <Network size={15} />
              Plan
            </button>
            <span>{networkProbe ? `Updated ${formatDate(networkProbe.generatedAt)}` : "No live probe yet"}</span>
          </div>
        </header>
        <SwitchNetworkPanel
          selected={selected}
          rows={rows}
          cube={cube}
          probe={networkProbe}
          onSelect={onSelectSandbox}
        />
      </section>

      <DetailSection icon={<Network size={16} />} title="Settings">
        <NetworkEditor
          world={selected.world}
          runtimeNetworkType={selectedTemplate?.networkType || cube?.config?.networkType || "tap"}
          runtimeSandboxIp={selected.runtime?.sandboxIp || selected.world?.sandbox?.sandboxIp || ""}
          busy={busy}
          onSave={onSaveNetwork}
        />
      </DetailSection>

      <DetailSection icon={<Layers size={16} />} title="Reachability">
        <ConnectivityMatrix rows={rows} probe={networkProbe} />
      </DetailSection>
    </div>
  );
}

function SandboxAccessLauncher({ world, token }: { world?: World; token: string }) {
  const [access, setAccess] = React.useState<DevAccessSession | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    setAccess(null);
    setError("");
  }, [world?.id]);

  if (!world) {
    return <div className="sectionEmpty">Terminal is available for KakuriZai-managed sandboxes only.</div>;
  }

  async function startSshForward() {
    setBusy(true);
    setError("");
    try {
      const session = await api<DevAccessSession>(`/api/worlds/${encodeURIComponent(world.id)}/dev-access`, {
        method: "POST",
        token,
        body: { vscode: false, ssh: true }
      });
      setAccess(session);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="accessPanel">
      <div className="terminalLauncher accessLauncher">
        <button
          className="primary"
          onClick={() => window.open(shellPageUrl(world.id, token), "_blank", "noopener,noreferrer")}
          type="button"
        >
          <Terminal size={15} />
          Open Terminal
          <ExternalLink size={14} />
        </button>
        <button onClick={() => window.open(devAccessOpenUrl(world.id, token), "_blank", "noopener,noreferrer")} type="button">
          <Code2 size={15} />
          VS Code Web
          <ExternalLink size={14} />
        </button>
        <button onClick={() => void startSshForward()} type="button" disabled={busy}>
          <KeyRound size={15} />
          SSH Forward
        </button>
      </div>
      {access ? (
        <div className="accessDetails">
          <Metric label="Sandbox IP" value={access.sandboxIp || "-"} />
          <Metric label="Workspace" value={access.workspace || "-"} />
          <Metric label="SSH host" value={access.sshHost || "-"} />
          <Metric label="SSH port" value={access.sshPort ? String(access.sshPort) : "-"} />
          <Metric label="SSH command" value={access.sshCommand || access.sshUri || "-"} wide />
        </div>
      ) : null}
      {error ? <div className="fieldError">{error}</div> : null}
    </div>
  );
}

function ShellPage({ worldId }: { worldId: string }) {
  const terminalRef = React.useRef<HTMLDivElement | null>(null);
  const socketRef = React.useRef<WebSocket | null>(null);
  const terminalInstanceRef = React.useRef<XTerminal | null>(null);
  const [token] = React.useState(() => shellTokenFromLocation());
  const [session, setSession] = React.useState(1);
  const [connectionState, setConnectionState] = React.useState("connecting");
  const [worldName, setWorldName] = React.useState("");

  React.useEffect(() => {
    api<World[]>("/api/worlds", { token })
      .then((worlds) => {
        const world = worlds.find((candidate) => candidate.id === worldId);
        setWorldName(world?.name || worldId);
      })
      .catch(() => setWorldName(worldId));
  }, [token, worldId]);

  React.useEffect(() => {
    if (!terminalRef.current) return;
    let disposed = false;
    const term = new XTerminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      scrollback: 10000,
      theme: {
        background: "#091018",
        foreground: "#dce7f3",
        cursor: "#57c7ff",
        selectionBackground: "#1e4f75",
        black: "#0b1118",
        red: "#ff6b7a",
        green: "#4ade80",
        yellow: "#facc15",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#dce7f3",
        brightBlack: "#5d6b7a",
        brightRed: "#ff8fa3",
        brightGreen: "#86efac",
        brightYellow: "#fde047",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#ffffff"
      }
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    terminalRef.current.innerHTML = "";
    term.open(terminalRef.current);
    term.writeln(`Connecting to ${worldName || worldId}...`);
    const url = new URL(`/api/worlds/${encodeURIComponent(worldId)}/shell`, window.location.href);
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    if (token) url.searchParams.set("token", token);
    const socket = new WebSocket(url);
    socketRef.current = socket;
    terminalInstanceRef.current = term;
    const send = (payload: Record<string, unknown>) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    };
    const sendResize = () => {
      send({ type: "resize", cols: term.cols, rows: term.rows });
    };
    const fit = () => {
      if (disposed) return;
      try {
        fitAddon.fit();
        sendResize();
      } catch {
        // xterm can throw before the font metrics are ready.
      }
    };
    const disposable = term.onData((data) => {
      send({ type: "input", data });
    });
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    resizeObserver?.observe(terminalRef.current);
    window.addEventListener("resize", fit);
    socket.addEventListener("open", () => {
      if (disposed) return;
      setConnectionState("connected");
      window.requestAnimationFrame(() => {
        fit();
        term.focus();
      });
    });
    socket.addEventListener("message", (event) => term.write(String(event.data)));
    socket.addEventListener("close", () => {
      if (disposed) return;
      setConnectionState("disconnected");
      term.writeln("\r\nDisconnected.");
    });
    socket.addEventListener("error", () => {
      if (disposed) return;
      setConnectionState("error");
      term.writeln("\r\nShell connection error.");
    });
    window.requestAnimationFrame(fit);
    return () => {
      disposed = true;
      disposable.dispose();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", fit);
      socket.close();
      term.dispose();
      socketRef.current = null;
      terminalInstanceRef.current = null;
    };
  }, [session, token, worldId]);

  function disconnect() {
    socketRef.current?.close();
  }

  return (
    <main className="terminalPage">
      <header className="terminalTopbar">
        <div>
          <strong>{worldName || "Sandbox Terminal"}</strong>
          <span>{worldId}</span>
        </div>
        <div className="toolbarActions">
          <span className={`terminalStatus ${statusTone(connectionState)}`}>{connectionState}</span>
          <button className="ghost" onClick={() => window.location.assign("/")} type="button">Console</button>
          <button className="primary" onClick={() => setSession((value) => value + 1)} type="button">
            <RefreshCcw size={15} />
            Reconnect
          </button>
          <button className="danger" onClick={disconnect} type="button" disabled={connectionState !== "connected"}>Disconnect</button>
        </div>
      </header>
      <div className="terminalFrame" ref={terminalRef} />
    </main>
  );
}

function shellWorldIdFromLocation() {
  const match = /^\/shell\/(.+)$/.exec(window.location.pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

function shellTokenFromLocation() {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token") || localStorage.getItem("kakurizai.token") || "";
  if (token) localStorage.setItem("kakurizai.token", token);
  return token;
}

function shellPageUrl(worldId: string, token: string) {
  const url = new URL(`/shell/${encodeURIComponent(worldId)}`, window.location.href);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

function devAccessOpenUrl(worldId: string, token: string) {
  const url = new URL(`/api/worlds/${encodeURIComponent(worldId)}/dev-access/open`, window.location.href);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

function DiskEditor({
  world,
  runtimeSize,
  minimumSize,
  busy,
  onSave
}: {
  world?: World;
  runtimeSize: string;
  minimumSize: string;
  busy: boolean;
  onSave: (world: World, writableLayerSize: string, recreate?: boolean) => Promise<void>;
}) {
  const configuredSize = world?.backendConfig?.writableLayerSize || runtimeSize || "1G";
  const minimumBytes = parseSizeToBytes(minimumSize);
  const initialParts = nextDiskInputParts(minimumSize || configuredSize);
  const [amount, setAmount] = React.useState(String(initialParts.amount));
  const [unit, setUnit] = React.useState(initialParts.unit);
  const minimumAmount = minimumDiskAmountForUnit(minimumBytes, unit);
  const nextSize = `${amount || minimumAmount}${unit}`;

  React.useEffect(() => {
    const next = nextDiskInputParts(minimumSize || configuredSize);
    setAmount(String(next.amount));
    setUnit(next.unit);
  }, [configuredSize, minimumSize, world?.id]);

  if (!world) {
    return <div className="sectionEmpty">Disk settings are read-only for runtime-only sandboxes.</div>;
  }

  function setSafeAmount(value: string) {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed)) {
      setAmount(String(minimumAmount));
      return;
    }
    setAmount(String(Math.max(parsed, minimumAmount)));
  }

  function setSafeUnit(nextUnit: string) {
    const nextMinimum = minimumDiskAmountForUnit(minimumBytes, nextUnit);
    setUnit(nextUnit);
    setAmount(String(nextMinimum));
  }

  return (
    <form
      className="diskEditor"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(world, nextSize, true);
      }}
    >
      <Metric label="Current disk" value={minimumSize || runtimeSize || configuredSize || "-"} />
      <label className="diskInputCard">
        <span>New disk</span>
        <div className="diskSizeControl">
          <input
            min={minimumAmount}
            step={1}
            type="number"
            value={amount}
            onBlur={(event) => setSafeAmount(event.target.value)}
            onChange={(event) => setSafeAmount(event.target.value)}
          />
          <select value={unit} onChange={(event) => setSafeUnit(event.target.value)}>
            {diskUnits.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
          </select>
        </div>
      </label>
      <div className="diskActionCard">
        <span>Apply</span>
        <button className="primary wide" disabled={busy || !amount.trim()} type="submit">
          Apply resize
        </button>
      </div>
    </form>
  );
}

function DnsSettings({
  servers,
  searches,
  options,
  onChange
}: {
  servers: string;
  searches: string;
  options: string;
  onChange: (next: { dnsServers: string; dnsSearches: string; dnsOptions: string }) => void;
}) {
  const inferredPreset = dnsPresetForDraft(servers, searches, options);
  const [selectedPresetId, setSelectedPresetId] = React.useState<DnsPresetKey>(inferredPreset);
  const selectedPreset = dnsPresets.find((candidate) => candidate.id === selectedPresetId) || dnsPresets[0];
  const isCustom = selectedPresetId === "custom";

  React.useEffect(() => {
    setSelectedPresetId(inferredPreset);
  }, [inferredPreset, servers, searches, options]);

  function selectPreset(nextPreset: DnsPresetKey) {
    const selected = dnsPresets.find((candidate) => candidate.id === nextPreset) || dnsPresets[0];
    setSelectedPresetId(selected.id);
    if (selected.id === "custom") {
      onChange({ dnsServers: servers, dnsSearches: searches, dnsOptions: options });
      return;
    }
    onChange({
      dnsServers: selected.servers.join(","),
      dnsSearches: "",
      dnsOptions: ""
    });
  }

  return (
    <section className="dnsSettingsCard">
      <div className="dnsSettingsTop">
        <label>
          <span>DNS</span>
          <select value={selectedPresetId} onChange={(event) => selectPreset(event.target.value as DnsPresetKey)}>
            {dnsPresets.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
            ))}
          </select>
        </label>
        <small>{isCustom ? customDnsSummary(servers, searches, options) : selectedPreset.summary}</small>
      </div>
      {isCustom ? (
        <div className="dnsCustomFields">
          <div>
            <label>Servers</label>
            <input value={servers} onChange={(event) => onChange({ dnsServers: event.target.value, dnsSearches: searches, dnsOptions: options })} placeholder="8.8.8.8,1.1.1.1" />
          </div>
          <div>
            <label>Search domains</label>
            <input value={searches} onChange={(event) => onChange({ dnsServers: servers, dnsSearches: event.target.value, dnsOptions: options })} placeholder="svc.cluster.local,cluster.local" />
          </div>
          <div>
            <label>Options</label>
            <input value={options} onChange={(event) => onChange({ dnsServers: servers, dnsSearches: searches, dnsOptions: event.target.value })} placeholder="ndots:5" />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function NetworkEditor({
  world,
  runtimeNetworkType,
  runtimeSandboxIp,
  busy,
  onSave
}: {
  world?: World;
  runtimeNetworkType: string;
  runtimeSandboxIp: string;
  busy: boolean;
  onSave: (world: World, network: NetworkConfig, kubernetes: KubernetesConfig) => Promise<void>;
}) {
  const configuredNetwork = effectiveNetworkForWorld(world, runtimeNetworkType);
  const configuredKubernetes = world?.backendConfig?.kubernetes || { enabled: false, profile: "k3s", apiServerPort: 6443, nodePorts: [] };
  const [error, setError] = React.useState("");
  const [form, setForm] = React.useState({
    type: configuredNetwork.type || runtimeNetworkType || "tap",
    mode: configuredNetwork.mode || "tap",
    sandboxIp: configuredNetwork.sandboxIp || "",
    exposedPorts: formatList(configuredNetwork.exposedPorts),
    dnsServers: formatList(configuredNetwork.dns?.servers),
    dnsSearches: formatList(configuredNetwork.dns?.searches),
    dnsOptions: formatList(configuredNetwork.dns?.options),
    allowInternetAccess: configuredNetwork.allowInternetAccess ?? true,
    allowOut: formatList(configuredNetwork.allowOut),
    denyOut: formatList(configuredNetwork.denyOut),
    egressRules: rulesToEgressRuleDrafts(configuredNetwork.rules),
    vlanEnabled: Boolean(configuredNetwork.vlan?.enabled),
    vlanId: configuredNetwork.vlan?.vlanId ? String(configuredNetwork.vlan.vlanId) : "",
    vlanHostInterface: configuredNetwork.vlan?.hostInterface || "eth0",
    vlanBridgeName: configuredNetwork.vlan?.bridgeName || "",
    natEnabled: configuredNetwork.nat?.enabled ?? false,
    natPortForwards: forwardsToNatForwardDrafts(configuredNetwork.nat?.portForwards),
    kubernetesEnabled: Boolean(configuredKubernetes.enabled),
    kubernetesProfile: configuredKubernetes.profile || "k3s",
    kubernetesClusterName: configuredKubernetes.clusterName || "kakurizai",
    kubernetesNodeRole: configuredKubernetes.nodeRole || "control-plane",
    kubernetesNodeName: configuredKubernetes.nodeName || "",
    kubernetesCni: configuredKubernetes.cni || "flannel",
    kubernetesPodCidr: configuredKubernetes.podCidr || "10.42.0.0/16",
    kubernetesServiceCidr: configuredKubernetes.serviceCidr || "10.43.0.0/16",
    kubernetesJoinEndpoint: configuredKubernetes.joinEndpoint || "",
    kubernetesJoinToken: configuredKubernetes.joinToken || "",
    kubernetesAdvertiseAddress: configuredKubernetes.advertiseAddress || "",
    kubernetesExtraArgs: formatLines(configuredKubernetes.extraArgs),
    kubernetesSysctls: formatKeyValueLines(configuredKubernetes.sysctls || defaultKubernetesSysctls()),
    apiServerPort: String(configuredKubernetes.apiServerPort || 6443),
    nodePorts: formatList(configuredKubernetes.nodePorts)
  });

  React.useEffect(() => {
    setForm({
      type: configuredNetwork.type || runtimeNetworkType || "tap",
      mode: configuredNetwork.mode || "tap",
      sandboxIp: configuredNetwork.sandboxIp || "",
      exposedPorts: formatList(configuredNetwork.exposedPorts),
      dnsServers: formatList(configuredNetwork.dns?.servers),
      dnsSearches: formatList(configuredNetwork.dns?.searches),
      dnsOptions: formatList(configuredNetwork.dns?.options),
      allowInternetAccess: configuredNetwork.allowInternetAccess ?? true,
      allowOut: formatList(configuredNetwork.allowOut),
      denyOut: formatList(configuredNetwork.denyOut),
      egressRules: rulesToEgressRuleDrafts(configuredNetwork.rules),
      vlanEnabled: Boolean(configuredNetwork.vlan?.enabled),
      vlanId: configuredNetwork.vlan?.vlanId ? String(configuredNetwork.vlan.vlanId) : "",
      vlanHostInterface: configuredNetwork.vlan?.hostInterface || "eth0",
      vlanBridgeName: configuredNetwork.vlan?.bridgeName || "",
      natEnabled: configuredNetwork.nat?.enabled ?? false,
      natPortForwards: forwardsToNatForwardDrafts(configuredNetwork.nat?.portForwards),
      kubernetesEnabled: Boolean(configuredKubernetes.enabled),
      kubernetesProfile: configuredKubernetes.profile || "k3s",
      kubernetesClusterName: configuredKubernetes.clusterName || "kakurizai",
      kubernetesNodeRole: configuredKubernetes.nodeRole || "control-plane",
      kubernetesNodeName: configuredKubernetes.nodeName || "",
      kubernetesCni: configuredKubernetes.cni || "flannel",
      kubernetesPodCidr: configuredKubernetes.podCidr || "10.42.0.0/16",
      kubernetesServiceCidr: configuredKubernetes.serviceCidr || "10.43.0.0/16",
      kubernetesJoinEndpoint: configuredKubernetes.joinEndpoint || "",
      kubernetesJoinToken: configuredKubernetes.joinToken || "",
      kubernetesAdvertiseAddress: configuredKubernetes.advertiseAddress || "",
      kubernetesExtraArgs: formatLines(configuredKubernetes.extraArgs),
      kubernetesSysctls: formatKeyValueLines(configuredKubernetes.sysctls || defaultKubernetesSysctls()),
      apiServerPort: String(configuredKubernetes.apiServerPort || 6443),
      nodePorts: formatList(configuredKubernetes.nodePorts)
    });
    setError("");
  }, [world?.id, runtimeNetworkType]);

  if (!world) {
    return <div className="sectionEmpty">Network settings are read-only for runtime-only sandboxes.</div>;
  }

  return (
    <form
      className="networkEditor"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          setError("");
          void onSave(
            world,
            {
              type: form.type,
              mode: form.mode,
              sandboxIp: form.sandboxIp,
              exposedPorts: parsePortList(form.exposedPorts),
              dns: {
                servers: parseCsv(form.dnsServers),
                searches: parseCsv(form.dnsSearches),
                options: parseCsv(form.dnsOptions)
              },
              allowInternetAccess: form.allowInternetAccess,
              allowOut: parseCsv(form.allowOut),
              denyOut: parseCsv(form.denyOut),
              rules: egressRuleDraftsToRules(form.egressRules),
              vlan: {
                enabled: form.vlanEnabled,
                vlanId: form.vlanId ? Number(form.vlanId) : null,
                hostInterface: form.vlanHostInterface,
                bridgeName: form.vlanBridgeName
              },
              nat: {
                enabled: !form.vlanEnabled && form.natEnabled,
                masquerade: !form.vlanEnabled && form.natEnabled,
                portForwards: natForwardDraftsToForwards(form.natPortForwards)
              }
            },
            {
              enabled: form.kubernetesEnabled,
              profile: form.kubernetesProfile,
              clusterName: form.kubernetesClusterName,
              nodeRole: form.kubernetesNodeRole,
              nodeName: form.kubernetesNodeName,
              cni: form.kubernetesCni,
              podCidr: form.kubernetesPodCidr,
              serviceCidr: form.kubernetesServiceCidr,
              joinEndpoint: form.kubernetesJoinEndpoint,
              joinToken: form.kubernetesJoinToken,
              advertiseAddress: form.kubernetesAdvertiseAddress,
              extraArgs: parseLines(form.kubernetesExtraArgs),
              apiServerPort: Number(form.apiServerPort || 6443),
              nodePorts: parsePortList(form.nodePorts),
              sysctls: parseKeyValueLines(form.kubernetesSysctls)
            }
          );
        } catch (nextError) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      }}
    >
      <label>Network type</label>
      <select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
        <option value="tap">tap</option>
      </select>

      <label>Sandbox IP</label>
      <input value={form.sandboxIp} onChange={(event) => setForm({ ...form, sandboxIp: event.target.value })} placeholder={runtimeSandboxIp || "auto, e.g. 192.168.1.50"} />

      <DnsSettings
        servers={form.dnsServers}
        searches={form.dnsSearches}
        options={form.dnsOptions}
        onChange={(next) => setForm((current) => ({ ...current, ...next }))}
      />
      <div className="togglePair">
        <div className="networkOptionCard">
          <label className="checkRow compactCheck">
            <input
              type="checkbox"
              checked={form.allowInternetAccess}
              onChange={(event) => setForm({ ...form, allowInternetAccess: event.target.checked })}
            />
            <span>
              <strong>Outbound internet</strong>
              <small>Allow sandbox traffic to internet</small>
            </span>
          </label>
          {form.allowInternetAccess ? (
            <div className="networkOptionFields">
              <div>
                <label>Allow CIDRs</label>
                <input value={form.allowOut} onChange={(event) => setForm({ ...form, allowOut: event.target.value })} placeholder="0.0.0.0/0" />
              </div>
              <div>
                <label>Deny CIDRs</label>
                <input value={form.denyOut} onChange={(event) => setForm({ ...form, denyOut: event.target.value })} placeholder="10.0.0.0/8,172.16.0.0/12" />
              </div>
            </div>
          ) : null}
        </div>
        {!form.vlanEnabled ? <div className="networkOptionCard">
          <label className="checkRow compactCheck">
            <input
              type="checkbox"
              checked={form.natEnabled}
              onChange={(event) => setForm({ ...form, natEnabled: event.target.checked })}
            />
            <span>
              <strong>Outbound NAT</strong>
              <small>Allow public outbound SNAT</small>
            </span>
          </label>
        </div> : null}
      </div>
      <NatForwardEditor
        forwards={form.natPortForwards}
        onChange={(natPortForwards) => setForm({ ...form, natPortForwards })}
      />
      <div className="toggleRow">
        <label className="checkRow compactCheck">
          <input
            type="checkbox"
            checked={form.vlanEnabled}
            onChange={(event) => setForm({ ...form, vlanEnabled: event.target.checked, natEnabled: event.target.checked ? false : form.natEnabled })}
          />
          <span>
            <strong>VLAN</strong>
            <small>Host VLAN access bridge</small>
          </span>
        </label>
      </div>
      {form.vlanEnabled ? (
        <div className="splitFields">
          <div>
            <label>VLAN ID</label>
            <input value={form.vlanId} onChange={(event) => setForm({ ...form, vlanId: event.target.value })} placeholder="100" />
          </div>
          <div>
            <label>Host interface</label>
            <input value={form.vlanHostInterface} onChange={(event) => setForm({ ...form, vlanHostInterface: event.target.value })} placeholder="eth0" />
          </div>
          <div>
            <label>Bridge name</label>
            <input value={form.vlanBridgeName} onChange={(event) => setForm({ ...form, vlanBridgeName: event.target.value })} placeholder="kzbr100" />
          </div>
        </div>
      ) : null}
      <EgressRuleEditor
        rules={form.egressRules}
        onChange={(egressRules) => setForm({ ...form, egressRules })}
      />
      {error ? <div className="fieldError">{error}</div> : null}
      <button className="primary" disabled={busy} type="submit">Apply network</button>
    </form>
  );
}

function NatForwardEditor({ forwards, onChange }: { forwards: NatForwardDraft[]; onChange: (forwards: NatForwardDraft[]) => void }) {
  function update(index: number, patch: Partial<NatForwardDraft>) {
    onChange(forwards.map((forward, forwardIndex) => forwardIndex === index ? { ...forward, ...patch } : forward));
  }

  function add() {
    onChange([...forwards, emptyNatForwardDraft(forwards.length)]);
  }

  function remove(index: number) {
    onChange(forwards.filter((_, forwardIndex) => forwardIndex !== index));
  }

  return (
    <div className="structuredEditor">
      <div className="fieldHeader">
        <label>Ingress port forwards</label>
        <button className="ghost smallButton" type="button" onClick={add}>
          <Plus size={14} />
          Add
        </button>
      </div>
      {forwards.length ? forwards.map((forward, index) => (
        <div className="structuredRow" key={index}>
          <div className="fieldHeader">
            <strong>{forward.name || `forward-${index + 1}`}</strong>
            <button className="iconButton dangerIcon" type="button" onClick={() => remove(index)} title="Remove forward">
              <Trash2 size={15} />
            </button>
          </div>
          <div className="splitFields">
            <div>
              <label>Name</label>
              <input value={forward.name} onChange={(event) => update(index, { name: event.target.value })} placeholder={`forward-${index + 1}`} />
            </div>
            <div>
              <label>Protocol</label>
              <select value={forward.protocol} onChange={(event) => update(index, { protocol: event.target.value })}>
                <option value="tcp">tcp</option>
                <option value="udp">udp</option>
              </select>
            </div>
          </div>
          <div className="splitFields">
            <div>
              <label>Listen address</label>
              <input value={forward.listenAddress} onChange={(event) => update(index, { listenAddress: event.target.value })} placeholder="0.0.0.0" />
            </div>
            <div>
              <label>Host port</label>
              <input inputMode="numeric" value={forward.hostPort} onChange={(event) => update(index, { hostPort: event.target.value })} placeholder="2222" />
            </div>
          </div>
          <div className="splitFields">
            <div>
              <label>Sandbox port</label>
              <input inputMode="numeric" value={forward.sandboxPort} onChange={(event) => update(index, { sandboxPort: event.target.value })} placeholder="22" />
            </div>
            <div>
              <label>Target address</label>
              <input value={forward.targetAddress} onChange={(event) => update(index, { targetAddress: event.target.value })} placeholder="sandbox IP" />
            </div>
          </div>
        </div>
      )) : <div className="sectionEmpty inlineNote">No ingress port forwards configured.</div>}
    </div>
  );
}

function EgressRuleEditor({ rules, onChange }: { rules: EgressRuleDraft[]; onChange: (rules: EgressRuleDraft[]) => void }) {
  function update(index: number, patch: Partial<EgressRuleDraft>) {
    onChange(rules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...patch } : rule));
  }

  function add() {
    onChange([...rules, emptyEgressRuleDraft(rules.length)]);
  }

  function remove(index: number) {
    onChange(rules.filter((_, ruleIndex) => ruleIndex !== index));
  }

  function updateInject(ruleIndex: number, injectIndex: number, patch: Partial<EgressInjectDraft>) {
    const rule = rules[ruleIndex];
    const injects = rule.injects.map((inject, current) => current === injectIndex ? { ...inject, ...patch } : inject);
    update(ruleIndex, { injects });
  }

  function addInject(ruleIndex: number) {
    const rule = rules[ruleIndex];
    update(ruleIndex, { injects: [...rule.injects, emptyEgressInjectDraft()] });
  }

  function removeInject(ruleIndex: number, injectIndex: number) {
    const rule = rules[ruleIndex];
    update(ruleIndex, { injects: rule.injects.filter((_, current) => current !== injectIndex) });
  }

  return (
    <div className="structuredEditor">
      <div className="fieldHeader">
        <label>Egress rules</label>
        <button className="ghost smallButton" type="button" onClick={add}>
          <Plus size={14} />
          Add
        </button>
      </div>
      {rules.length ? rules.map((rule, index) => (
        <div className="structuredRow" key={index}>
          <div className="fieldHeader">
            <strong>{rule.name || `rule-${index + 1}`}</strong>
            <button className="iconButton dangerIcon" type="button" onClick={() => remove(index)} title="Remove rule">
              <Trash2 size={15} />
            </button>
          </div>
          <div className="splitFields">
            <div>
              <label>Name</label>
              <input value={rule.name} onChange={(event) => update(index, { name: event.target.value })} placeholder={`rule-${index + 1}`} />
            </div>
            <label className="checkRow compactCheck inlineCheck">
              <input type="checkbox" checked={rule.allow} onChange={(event) => update(index, { allow: event.target.checked })} />
              <span>
                <strong>Allow</strong>
                <small>Uncheck to block</small>
              </span>
            </label>
          </div>
          <div className="splitFields">
            <div>
              <label>Host</label>
              <input value={rule.host} onChange={(event) => update(index, { host: event.target.value })} placeholder="api.example.com" />
            </div>
            <div>
              <label>SNI</label>
              <input value={rule.sni} onChange={(event) => update(index, { sni: event.target.value })} placeholder="api.example.com" />
            </div>
          </div>
          <div className="splitFields">
            <div>
              <label>Methods</label>
              <input value={rule.methods} onChange={(event) => update(index, { methods: event.target.value })} placeholder="GET,POST" />
            </div>
            <div>
              <label>Scheme</label>
              <select value={rule.scheme} onChange={(event) => update(index, { scheme: event.target.value })}>
                <option value="">any</option>
                <option value="http">http</option>
                <option value="https">https</option>
              </select>
            </div>
          </div>
          <div className="splitFields">
            <div>
              <label>Path</label>
              <input value={rule.path} onChange={(event) => update(index, { path: event.target.value })} placeholder="/v1/*" />
            </div>
            <div>
              <label>Audit</label>
              <input value={rule.audit} onChange={(event) => update(index, { audit: event.target.value })} placeholder="log" />
            </div>
          </div>
          <div className="fieldHeader nestedHeader">
            <label>Header injections</label>
            <button className="ghost smallButton" type="button" onClick={() => addInject(index)}>
              <Plus size={14} />
              Add
            </button>
          </div>
          {rule.injects.length ? rule.injects.map((inject, injectIndex) => (
            <div className="splitFields compactFields" key={injectIndex}>
              <div>
                <label>Header</label>
                <input value={inject.header} onChange={(event) => updateInject(index, injectIndex, { header: event.target.value })} placeholder="Authorization" />
              </div>
              <div>
                <label>Secret</label>
                <input value={inject.secret} onChange={(event) => updateInject(index, injectIndex, { secret: event.target.value })} placeholder="secret ref" />
              </div>
              <div>
                <label>Format</label>
                <input value={inject.format} onChange={(event) => updateInject(index, injectIndex, { format: event.target.value })} placeholder="Bearer {secret}" />
              </div>
              <button className="iconButton dangerIcon fieldAlignedButton" type="button" onClick={() => removeInject(index, injectIndex)} title="Remove injection">
                <Trash2 size={15} />
              </button>
            </div>
          )) : null}
        </div>
      )) : <div className="sectionEmpty inlineNote">No L7 egress rules configured.</div>}
    </div>
  );
}

function SwitchNetworkPanel({
  selected,
  rows,
  cube,
  probe,
  onSelect
}: {
  selected: InventoryRow;
  rows: InventoryRow[];
  cube: CubeInspect | null;
  probe?: NetworkProbePlan | null;
  onSelect?: (key: string) => void;
}) {
  const ports = buildSwitchPorts(rows, selected, cube?.config?.networkType || "tap", probe);
  const selectedPort = ports.find((port) => port.row.key === selected.key) || ports[0];
  const inUse = ports.filter((port) => port.state !== "disabled").length;
  return (
    <div className="switchPanel">
      <div className="switchToolbar">
        <div>
          <strong>KakuriZai Switch</strong>
          <span>{selected.host || selected.runtime?.hostIp || "local"} / {ports.length} ports</span>
        </div>
        <div className="switchStats">
          <span>{inUse} in use</span>
        </div>
      </div>

      <div className="switchDevice">
        <div className="switchDeviceHeader">
          <div>
            <strong>{selectedPort?.row.name || "Sandbox"}</strong>
            <span>{selectedPort?.row.runtime?.sandboxIp || selectedPort?.row.sandboxId || "planned"}</span>
          </div>
          <span>{selectedPort?.profile || "TAP"}</span>
        </div>
        <div className="switchPortGrid">
          {ports.map((port) => (
            <button
              className={`switchPort ${port.tone} ${port.row.key === selected.key ? "selected" : ""}`}
              key={port.row.key}
              onClick={() => onSelect?.(port.row.key)}
              type="button"
              title={`${port.row.name} ${port.connection}`}
            >
              <span>{port.index}</span>
              <strong>{port.label}</strong>
              <small>{port.badge}</small>
            </button>
          ))}
        </div>
        <div className="switchLegend">
          <span><i className="legendDot ok" /> Reachable</span>
          <span><i className="legendDot warn" /> Blocked</span>
          <span><i className="legendDot muted" /> Planned</span>
        </div>
      </div>

      <div className="switchPortTable">
        <div className="switchPortRow head">
          <span>Port</span>
          <span>Name</span>
          <span>Operation</span>
          <span>Profile</span>
          <span>Connection</span>
          <span>Port forward</span>
          <span>Probe</span>
        </div>
        {ports.map((port) => (
          <div className="switchPortRow" key={`${port.row.key}-table`}>
            <span><i className={`legendDot ${port.tone}`} /> {port.index}</span>
            <span>{port.row.name}</span>
            <span>{port.operation}</span>
            <span>{port.profile}</span>
            <span>{port.connection}</span>
            <span>{port.forward}</span>
            <span>{port.probe}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConnectivityMatrix({ rows, probe }: { rows: InventoryRow[]; probe?: NetworkProbePlan | null }) {
  if (!rows.length) return <div className="sectionEmpty">No sandbox connectivity metadata.</div>;
  if (probe?.edges?.length) {
    return (
      <div className="dataTable networkMatrix probeMatrix">
        <div className="dataRow head">
          <span>Source</span>
          <span>Target</span>
          <span>Target IP</span>
          <span>Path</span>
          <span>Probe</span>
          <span>Checks</span>
          <span>Reason</span>
        </div>
        {probe.edges.map((edge) => (
          <div className={`dataRow ${probeTone(edge)}`} key={`${edge.fromWorldId}-${edge.toWorldId}`}>
            <span>{edge.fromName}</span>
            <span>{edge.toName}</span>
            <span>{edge.toSandboxIp || "-"}</span>
            <span>{edge.hostPath || "-"}</span>
            <span>{probeLabel(edge)}</span>
            <span>{formatProbeChecks(edge.checks)}</span>
            <span>{edge.reason || "-"}</span>
          </div>
        ))}
      </div>
    );
  }
  return <div className="sectionEmpty">Run Probe to show reachability results.</div>;
}

function Kpi({ icon, label, value, tone = "muted" }: { icon: React.ReactNode; label: string; value: string; tone?: "ok" | "warn" | "muted" }) {
  return (
    <div className={`kpi ${tone}`}>
      <span>{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function Metric({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "metric wideMetric" : "metric"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function MountTable({ row, mounts }: { row: InventoryRow; mounts: CubeVolumeMount[] }) {
  if (!mounts.length) return <div className="sectionEmpty">No mounts reported.</div>;
  return (
    <div className="dataTable">
      <div className="dataRow head">
        <span>Name</span>
        <span>Sandbox path</span>
        <span>Host path</span>
        <span>Mode</span>
      </div>
      {mounts.map((mount, index) => (
        <div className={`dataRow ${mount.name === "cube_rootfs_rw" ? "internalMount" : ""}`} key={`${mount.name || "mount"}-${index}`}>
          <span>{mount.name || "-"}</span>
          <span>{mount.container_path || "-"}</span>
          <span>{mount.host_path || "-"}</span>
          <span>{mountModeLabel(row, mount)}</span>
        </div>
      ))}
    </div>
  );
}

function PortTable({ ports }: { ports: CubePortMapping[] }) {
  if (!ports.length) return <div className="sectionEmpty">No port mappings reported.</div>;
  return (
    <div className="dataTable narrow">
      <div className="dataRow head">
        <span>Container</span>
        <span>Host</span>
      </div>
      {ports.map((port, index) => (
        <div className="dataRow" key={`${port.container_port || "port"}-${index}`}>
          <span>{port.container_port ?? "-"}</span>
          <span>{port.host_port ?? "-"}</span>
        </div>
      ))}
    </div>
  );
}

function ReplicaList({ replicas }: { replicas: Array<Record<string, unknown>> }) {
  if (!replicas.length) return <div className="sectionEmpty">No replicas reported.</div>;
  return (
    <div className="dataTable">
      <div className="dataRow head">
        <span>Node</span>
        <span>Status</span>
        <span>Spec</span>
        <span>Phase</span>
      </div>
      {replicas.map((replica, index) => (
        <div className="dataRow" key={index}>
          <span>{String(replica.node_ip || replica.node_id || "-")}</span>
          <span>{String(replica.status || "-")}</span>
          <span>{String(replica.spec || "-")}</span>
          <span>{String(replica.phase || "-")}</span>
        </div>
      ))}
    </div>
  );
}

function buildInventory(worlds: World[], cube: CubeInspect | null): InventoryRow[] {
  const runtimes = cube?.sandboxes || [];
  const matchedRuntimeIds = new Set<string>();
  const rows = worlds.map((world) => {
    const runtime = runtimes.find((candidate) => sameSandboxId(candidate.id, world.sandbox?.id));
    if (runtime) matchedRuntimeIds.add(runtime.id);
    const displayRuntime = runtime && world.sandbox?.sandboxIp ? { ...runtime, sandboxIp: world.sandbox.sandboxIp } : runtime;
    const worldStatus = world.sandbox?.status || world.status;
    return {
      key: `world:${world.id}`,
      name: world.name,
      status: isPausedStatus(worldStatus) ? worldStatus : displayRuntime?.status || world.status,
      origin: displayRuntime ? "KakuriZai + CubeSandbox" : "KakuriZai",
      sourcePath: world.sourcePath,
      mountMode: world.backendConfig?.mountMode || world.sandbox?.mountMode || "-",
      sandboxId: world.sandbox?.id || displayRuntime?.id || "",
      templateId: displayRuntime?.templateId || world.backendConfig?.template || world.sandbox?.baseId || null,
      cpu: displayRuntime?.cpu || world.backendConfig?.cpu || null,
      memory: displayRuntime?.memory || world.backendConfig?.memory || null,
      host: displayRuntime?.hostIp || displayRuntime?.hostId || null,
      createdAt: displayRuntime?.createdAt || world.createdAt,
      world,
      runtime: displayRuntime
    };
  });
  for (const runtime of runtimes) {
    if (matchedRuntimeIds.has(runtime.id)) continue;
    rows.push({
      key: `runtime:${runtime.id}`,
      name: `sandbox-${shortId(runtime.id)}`,
      status: runtime.status || "unknown",
      origin: "CubeSandbox",
      sourcePath: runtime.hostId ? `host ${runtime.hostId}` : "runtime-only",
      mountMode: runtime.annotations?.["kakurizai.mountMode"] || "-",
      sandboxId: runtime.id,
      templateId: runtime.templateId,
      cpu: runtime.cpu,
      memory: runtime.memory,
      host: runtime.hostIp || runtime.hostId,
      createdAt: runtime.createdAt,
      runtime
    });
  }
  return rows;
}

function hasHostMount(row: InventoryRow) {
  if (row.world?.backendConfig?.hostMount != null) return row.world.backendConfig.hostMount !== false;
  const annotation = row.runtime?.annotations?.["kakurizai.hostMount"];
  if (annotation != null) return annotation === "true";
  return row.mountMode !== "none";
}

function subtitleForSandbox(row: InventoryRow) {
  if (!hasHostMount(row)) return "host mount disabled";
  return row.sourcePath || row.runtime?.hostId || "-";
}

function filterInventory(rows: InventoryRow[], search: string, stateFilter: StateFilter) {
  const needle = search.trim().toLowerCase();
  return rows.filter((row) => {
    const status = row.status.toLowerCase();
    if (stateFilter === "running" && !["running", "ready", "up"].includes(status)) return false;
    if (stateFilter === "paused" && !status.includes("paused")) return false;
    if (stateFilter === "other" && (["running", "ready", "up"].includes(status) || status.includes("paused"))) return false;
    if (!needle) return true;
    return [row.name, row.sandboxId, row.templateId, row.sourcePath, row.host]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
}

function findTemplateForSandbox(cube: CubeInspect | null, selected: InventoryRow | null) {
  if (!cube || !selected) return null;
  return cube.templates.find((template) => template.id === selected.templateId || template.id === selected.world?.sandbox?.baseId) || null;
}

function findNodeForSandbox(cube: CubeInspect | null, selected: InventoryRow | null) {
  if (!cube || !selected) return null;
  return (cube.nodes || []).find((node) => node.nodeId === selected.host || node.ip === selected.host || node.nodeId === selected.runtime?.hostId || node.ip === selected.runtime?.hostIp) || null;
}

function diskMinimumForSelection(selected: InventoryRow, template: CubeTemplate | null) {
  return maxSizeLabel([
    selected.world?.backendConfig?.writableLayerMinimumSize,
    selected.world?.backendConfig?.writableLayerSize,
    selected.runtime?.writableLayerSize,
    template?.writableLayerSize
  ]) || "1G";
}

function mountRowsForSelection(row: InventoryRow): CubeVolumeMount[] {
  const hasRuntimeMounts = Boolean(row.runtime?.volumeMounts?.length);
  const rawMounts = hasRuntimeMounts ? row.runtime!.volumeMounts : mountsFromWorld(row.world);
  const visibleMounts = rawMounts.filter((mount) => mount.name !== "cube_rootfs_rw");
  const internalMounts = rawMounts.filter((mount) => mount.name === "cube_rootfs_rw");
  const configuredMounts = hasRuntimeMounts ? mountsFromWorld(row.world).filter((mount) => mount.mode === "overlay") : [];
  return [...configuredMounts, ...visibleMounts, ...internalMounts];
}

function mountsFromWorld(world?: World): CubeVolumeMount[] {
  const mounts = world?.backendConfig?.mounts;
  if (!mounts) return [];
  if (Array.isArray(mounts)) {
    return mounts.map((mount) => ({
      name: mount.name || mount.id || "mount",
      container_path: mount.sandboxPath || `/workspace/${slugMountName(mount.name || mount.id || "mount")}`,
      host_path: mount.sourcePath || mount.hostPath || "-",
      readonly: mount.mode !== "unsafe-rw",
      mode: mount.mode === "agctl-overlay" ? "overlay" : mount.mode
    }));
  }
  return Object.entries(mounts).flatMap(([name, value]) => {
    if (!value || typeof value !== "object") return [];
    const mount = value as { sandboxPath?: string; hostPath?: string; readonly?: boolean };
    if (!mount.hostPath && !mount.sandboxPath) return [];
    return [{
      name,
      container_path: mount.sandboxPath,
      host_path: mount.hostPath,
      readonly: mount.readonly
    }];
  });
}

function mountModeLabel(row: InventoryRow, mount: CubeVolumeMount) {
  if (mount.mode === "overlay") return "overlay";
  if (mount.name === "cube_rootfs_rw") return "internal rootfs";
  if (row.mountMode === "unsafe-rw" || mount.mode === "unsafe-rw") return "read-write direct";
  if (row.mountMode === "cubesandbox-readonly" || mount.mode === "cubesandbox-readonly") return "read-only direct";
  return mount.readonly || mount.recursive_read_only ? "read-only" : "read-write";
}

function sameSandboxId(left?: string, right?: string) {
  if (!left || !right) return false;
  return left === right || shortId(left) === shortId(right);
}

function isPausedStatus(status?: string | null) {
  return String(status || "").toLowerCase().includes("paused");
}

function statusTone(status: string): "ok" | "warn" | "muted" {
  const normalized = status.toLowerCase();
  if (["ready", "running", "active", "up", "healthy", "connected"].includes(normalized)) return "ok";
  if (normalized.startsWith("pending") || normalized.includes("creating") || normalized.includes("starting") || normalized.includes("paused") || normalized === "connecting" || normalized === "error") return "warn";
  return "muted";
}

async function api<T = unknown>(path: string, options: { method?: string; token?: string | null; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.body) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await fetch(path, { method: options.method || "GET", headers, body });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status}: ${data?.error || response.statusText}`);
  return data;
}

function shortId(value?: string) {
  return value ? value.slice(0, 12) : "-";
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatBytesNullable(bytes?: number | null) {
  return bytes == null ? "-" : formatBytes(bytes);
}

function formatDiskMb(value?: number | null) {
  return value == null ? "-" : `${value} MB`;
}

function formatDate(value?: string | null) {
  if (!value || value === "-") return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatBool(value?: boolean | null) {
  if (value == null) return "-";
  return value ? "allowed" : "blocked";
}

function formatNatSummary(value?: NatConfig | null) {
  if (!value?.enabled) return "disabled";
  return "outbound snat";
}

function formatPortForwardSummary(value?: PortForwardConfig[] | null) {
  if (!value?.length) return "";
  return value
    .map((forward) => `${forward.name || forward.protocol || "forward"}:${forward.hostPort || "-"}->${forward.sandboxPort || "-"}/${forward.protocol || "tcp"}`)
    .join(",");
}

function formatRuntimePortSummary(value?: CubePortMapping[] | null) {
  if (!value?.length) return "";
  return value.map((port) => `${port.host_port ?? "-"}->${port.container_port ?? "-"}`).join(",");
}

function buildSwitchPorts(rows: InventoryRow[], selected: InventoryRow, fallbackType = "tap", probe?: NetworkProbePlan | null) {
  const selectedWorldId = selected.world?.id || "";
  const edgeByTarget = new Map(
    (probe?.edges || [])
      .filter((edge) => edge.fromWorldId === selectedWorldId)
      .map((edge) => [edge.toWorldId, edge])
  );
  return rows.map((row, index) => {
    const network = networkForRow(row, fallbackType);
    const edge = row.world ? edgeByTarget.get(row.world.id) : null;
    const forward = formatPortForwardSummary(network.nat?.portForwards) || formatRuntimePortSummary(row.runtime?.portMappings || []);
    const hasRuntime = Boolean(row.runtime?.sandboxIp || row.sandboxId);
    const tone = switchPortTone(row, edge, hasRuntime);
    const outboundNat = !network.vlan?.enabled && formatNatSummary(network.nat) !== "disabled";
    const hasForward = Boolean(network.nat?.portForwards?.length);
    const profile = [
      network.type || "tap",
      network.vlan?.enabled ? `vlan ${network.vlan.vlanId || ""}`.trim() : "",
      outboundNat ? "outbound nat" : "",
      hasForward ? "ingress forward" : ""
    ].filter(Boolean).join(" / ");
    return {
      index: index + 1,
      row,
      tone,
      state: hasRuntime ? "in-use" : "disabled",
      label: network.type || "TAP",
      badge: outboundNat ? "SNAT" : hasForward ? "FWD" : "TAP",
      operation: row.status || "-",
      profile,
      connection: row.runtime?.sandboxIp || shortId(row.sandboxId) || "-",
      forward: forward || "-",
      probe: row.key === selected.key ? "selected" : edge ? probeLabel(edge) : "not probed"
    };
  });
}

function switchPortTone(row: InventoryRow, edge?: ProbeEdge | null, hasRuntime = false) {
  if (edge?.reachable === true) return "ok";
  if (edge?.reachable === false) return "warn";
  if (hasRuntime && /running|ready/i.test(row.status || "")) return "ok";
  return "muted";
}

function formatSysctls(value?: Record<string, string> | null) {
  if (!value || !Object.keys(value).length) return "-";
  return Object.entries(value).map(([key, sysctlValue]) => `${key}=${sysctlValue}`).join(",");
}

function probeLabel(edge: ProbeEdge) {
  if (edge.reachable === true) return "reachable";
  if (edge.reachable === false) return "blocked";
  return "unknown";
}

function probeTone(edge: ProbeEdge) {
  if (edge.reachable === true) return "ok";
  if (edge.reachable === false) return "warn";
  return "muted";
}

function formatProbeChecks(checks?: ProbeEdge["checks"]) {
  if (!checks?.length) return "-";
  return checks
    .map((check) => `${check.kind}${check.port ? `:${check.port}` : ""}=${check.ok || check.status === "ok" ? "ok" : check.status}`)
    .join(",");
}

function formatBootstrapStatus(value?: { pending?: boolean; applied?: boolean; skipped?: boolean; reason?: string | null } | null) {
  if (!value) return "-";
  if (value.pending) return "installing";
  if (value.applied) return "installed";
  if (value.skipped) return value.reason || "skipped";
  return value.reason || "failed";
}

function formatList(value?: Array<string | number> | string | null) {
  if (!value) return "";
  if (Array.isArray(value)) return value.join(",");
  return String(value);
}

function formatLines(value?: Array<string | number> | string | null) {
  if (!value) return "";
  if (Array.isArray(value)) return value.join("\n");
  return String(value);
}

function dnsPresetForDraft(servers: string, searches: string, options: string): DnsPresetKey {
  const serverList = parseCsv(servers);
  if (parseCsv(searches).length || parseCsv(options).length) return "custom";
  if (!serverList.length) return "default";
  const match = dnsPresets.find((preset) => {
    if (preset.id === "default" || preset.id === "custom") return false;
    return sameStringList(serverList, preset.servers);
  });
  return match?.id || "custom";
}

function customDnsSummary(servers: string, searches: string, options: string) {
  const parts = [
    parseCsv(servers).length ? `${parseCsv(servers).length} servers` : "",
    parseCsv(searches).length ? `${parseCsv(searches).length} searches` : "",
    parseCsv(options).length ? `${parseCsv(options).length} options` : ""
  ].filter(Boolean);
  return parts.length ? parts.join(" / ") : "No custom DNS values.";
}

function sameStringList(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatKeyValueLines(value?: Record<string, string> | null) {
  if (!value) return "";
  return Object.entries(value).map(([key, nextValue]) => `${key}=${nextValue}`).join("\n");
}

function defaultKubernetesSysctls() {
  return {
    "net.ipv4.ip_forward": "1",
    "net.bridge.bridge-nf-call-iptables": "1",
    "net.bridge.bridge-nf-call-ip6tables": "1"
  };
}

function defaultKubernetesSysctlsText() {
  return formatKeyValueLines(defaultKubernetesSysctls());
}

function maxSizeLabel(values: Array<string | null | undefined>) {
  let best = "";
  for (const value of values) {
    const bytes = parseSizeToBytes(value || "");
    if (bytes == null) continue;
    if (!best || bytes > (parseSizeToBytes(best) || 0)) best = String(value);
  }
  return best;
}

function nextDiskInputParts(value: string) {
  const match = /^(\d+(?:\.\d+)?)([KMGTP])i?B?$/i.exec(String(value || "1G").trim());
  const unit = diskUnits.includes(match?.[2]?.toUpperCase() as (typeof diskUnits)[number])
    ? match![2].toUpperCase()
    : "G";
  const bytes = parseSizeToBytes(value) || 1024 ** 3;
  return {
    unit,
    amount: minimumDiskAmountForUnit(bytes, unit)
  };
}

function minimumDiskAmountForUnit(minimumBytes: number | null, unit: string) {
  if (!minimumBytes) return 1;
  const power = { M: 2, G: 3, T: 4 }[unit as "M" | "G" | "T"] || 3;
  return Math.max(1, Math.floor(minimumBytes / 1024 ** power) + 1);
}

function parseSizeToBytes(value: string) {
  const match = /^(\d+(?:\.\d+)?)([KMGTP])i?B?$/i.exec(String(value || "").trim());
  if (!match) return null;
  const power = { K: 1, M: 2, G: 3, T: 4, P: 5 }[match[2].toUpperCase() as "K" | "M" | "G" | "T" | "P"];
  return Number(match[1]) * 1024 ** power;
}

function parseCsv(value: string) {
  return String(value || "")
    .split(/[,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseLines(value: string) {
  return String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseKeyValueLines(value: string) {
  const result: Record<string, string> = {};
  for (const rawLine of String(value || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`Invalid key=value line: ${line}`);
    const key = line.slice(0, separator).trim();
    const nextValue = line.slice(separator + 1).trim();
    if (!key || !nextValue) throw new Error(`Invalid key=value line: ${line}`);
    result[key] = nextValue;
  }
  return result;
}

function parsePortList(value: string) {
  return parseCsv(value).map((item) => {
    const port = Number(item);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port: ${item}`);
    }
    return port;
  });
}

function parsePortAnnotation(value?: string | null) {
  if (!value) return [];
  return String(value)
    .split(/[: ,]+/)
    .map((item) => Number(item))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
}

function emptyNatForwardDraft(index: number): NatForwardDraft {
  return {
    name: "",
    protocol: "tcp",
    listenAddress: "",
    hostPort: "",
    sandboxPort: "",
    targetAddress: ""
  };
}

function forwardsToNatForwardDrafts(value?: PortForwardConfig[] | null): NatForwardDraft[] {
  return (value || []).map((forward, index) => ({
    name: String(forward.name || `forward-${index + 1}`),
    protocol: String(forward.protocol || "tcp"),
    listenAddress: String(forward.listenAddress || ""),
    hostPort: forward.hostPort == null ? "" : String(forward.hostPort),
    sandboxPort: forward.sandboxPort == null ? "" : String(forward.sandboxPort),
    targetAddress: String(forward.targetAddress || "")
  }));
}

function natForwardDraftsToForwards(drafts: NatForwardDraft[]): PortForwardConfig[] {
  return drafts.filter(hasNatForwardDraftContent).map((draft, index) => ({
    name: draft.name.trim() || `forward-${index + 1}`,
    protocol: draft.protocol || "tcp",
    ...(draft.listenAddress.trim() ? { listenAddress: draft.listenAddress.trim() } : {}),
    hostPort: parseRequiredPort(draft.hostPort, "port forward host port"),
    sandboxPort: parseRequiredPort(draft.sandboxPort, "port forward sandbox port"),
    ...(draft.targetAddress.trim() ? { targetAddress: draft.targetAddress.trim() } : {})
  }));
}

function hasNatForwardDraftContent(draft: NatForwardDraft) {
  return [draft.name, draft.listenAddress, draft.hostPort, draft.sandboxPort, draft.targetAddress]
    .some((value) => String(value || "").trim()) || draft.protocol !== "tcp";
}

function emptyEgressInjectDraft(): EgressInjectDraft {
  return { header: "", secret: "", format: "" };
}

function emptyEgressRuleDraft(index: number): EgressRuleDraft {
  return {
    name: "",
    sni: "",
    host: "",
    methods: "",
    path: "",
    scheme: "",
    allow: true,
    audit: "",
    injects: []
  };
}

function rulesToEgressRuleDrafts(value?: EgressRule[] | null): EgressRuleDraft[] {
  return (value || []).map((rule, index) => {
    const source = rule as {
      name?: string;
      match?: { sni?: string; host?: string; method?: string[]; methods?: string[]; path?: string; scheme?: string };
      action?: { allow?: boolean; audit?: string; inject?: EgressInjectDraft[] };
    };
    return {
      name: String(source.name || `rule-${index + 1}`),
      sni: String(source.match?.sni || ""),
      host: String(source.match?.host || ""),
      methods: formatList(source.match?.method || source.match?.methods || []),
      path: String(source.match?.path || ""),
      scheme: String(source.match?.scheme || ""),
      allow: source.action?.allow !== false,
      audit: String(source.action?.audit || ""),
      injects: (source.action?.inject || []).map((inject) => ({
        header: String(inject.header || ""),
        secret: String(inject.secret || ""),
        format: String(inject.format || "")
      }))
    };
  });
}

function egressRuleDraftsToRules(drafts: EgressRuleDraft[]): EgressRule[] {
  return drafts.filter(hasEgressRuleDraftContent).map((draft, index) => {
    const match = {
      ...(draft.sni.trim() ? { sni: draft.sni.trim() } : {}),
      ...(draft.host.trim() ? { host: draft.host.trim() } : {}),
      ...(parseCsv(draft.methods).length ? { method: parseCsv(draft.methods) } : {}),
      ...(draft.path.trim() ? { path: draft.path.trim() } : {}),
      ...(draft.scheme.trim() ? { scheme: draft.scheme.trim() } : {})
    };
    const inject = draft.injects
      .map((item) => ({
        header: item.header.trim(),
        secret: item.secret.trim(),
        ...(item.format.trim() ? { format: item.format.trim() } : {})
      }))
      .filter((item) => item.header && item.secret);
    return {
      name: draft.name.trim() || `rule-${index + 1}`,
      ...(Object.keys(match).length ? { match } : {}),
      action: {
        allow: draft.allow,
        ...(draft.audit.trim() ? { audit: draft.audit.trim() } : {}),
        ...(inject.length ? { inject } : {})
      }
    };
  });
}

function hasEgressRuleDraftContent(draft: EgressRuleDraft) {
  return !draft.allow
    || [draft.name, draft.sni, draft.host, draft.methods, draft.path, draft.scheme, draft.audit]
      .some((value) => String(value || "").trim())
    || draft.injects.some((inject) => [inject.header, inject.secret, inject.format].some((value) => String(value || "").trim()));
}

function parseRequiredPort(value: string, name: string) {
  const port = Number(String(value || "").trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a TCP/UDP port between 1 and 65535`);
  }
  return port;
}

function ensureLaunchMounts(mounts?: LaunchMount[]) {
  return mounts?.length ? mounts : [{ name: "project", sourcePath: "", mode: "agctl-overlay" }];
}

function suggestMountName(sourcePath: string) {
  const parts = String(sourcePath || "").split(/[\\/]+/).filter(Boolean);
  return slugMountName(parts.at(-1) || "project");
}

function slugMountName(value: string) {
  return String(value || "mount")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "mount";
}

function networkForRow(row: InventoryRow, fallbackType = "tap"): NetworkConfig {
  const annotations = row.runtime?.annotations || {};
  if (row.world) return effectiveNetworkForWorld(row.world, annotations["kakurizai.network.type"] || fallbackType);
  const natAnnotation = parseAnnotationJson<NatConfig>(annotations["kakurizai.network.nat"]);
  const portForwards = parseAnnotationJson<PortForwardConfig[]>(annotations["kakurizai.network.portForwards"]) || natAnnotation?.portForwards || [];
  return {
    type: annotations["kakurizai.network.type"] || fallbackType,
    mode: annotations["kakurizai.network.mode"] || annotations["kakurizai.network.type"] || fallbackType,
    sandboxIp: annotations["kakurizai.network.sandboxIp"] || null,
    exposedPorts: parsePortAnnotation(annotations["com.exposed_ports"]),
    allowOut: [],
    denyOut: [],
    rules: [],
    vlan: parseAnnotationJson<VlanConfig>(annotations["kakurizai.network.vlan"]) || { enabled: false },
    nat: { ...(natAnnotation || { enabled: annotations["kakurizai.network.nat.enabled"] === "true" }), portForwards },
    dns: { servers: [], searches: [], options: [] }
  };
}

function kubernetesForRow(row: InventoryRow): KubernetesConfig {
  if (row.world?.backendConfig?.kubernetes) return row.world.backendConfig.kubernetes;
  const annotations = row.runtime?.annotations || {};
  const hasKubernetes = annotations["kakurizai.kubernetes"] === "true" || Boolean(annotations["kakurizai.kubernetes.cluster"]);
  if (!hasKubernetes) return { enabled: false };
  const apiServerPort = Number(annotations["kakurizai.kubernetes.apiServerPort"] || 6443);
  return {
    enabled: annotations["kakurizai.kubernetes"] !== "false",
    profile: annotations["kakurizai.kubernetes.profile"] || "k3s",
    clusterName: annotations["kakurizai.kubernetes.cluster"] || "kakurizai",
    nodeRole: annotations["kakurizai.kubernetes.nodeRole"] || "standalone",
    nodeName: annotations["kakurizai.kubernetes.nodeName"] || row.name,
    cni: annotations["kakurizai.kubernetes.cni"] || "flannel",
    podCidr: annotations["kakurizai.kubernetes.podCidr"] || "10.42.0.0/16",
    serviceCidr: annotations["kakurizai.kubernetes.serviceCidr"] || "10.43.0.0/16",
    joinEndpoint: annotations["kakurizai.kubernetes.joinEndpoint"] || "",
    joinToken: annotations["kakurizai.kubernetes.joinToken"] || "",
    advertiseAddress: annotations["kakurizai.kubernetes.advertiseAddress"] || "",
    extraArgs: parseLines(annotations["kakurizai.kubernetes.extraArgs"] || ""),
    apiServerPort: Number.isInteger(apiServerPort) && apiServerPort > 0 ? apiServerPort : 6443,
    nodePorts: parsePortAnnotation(annotations["kakurizai.kubernetes.nodePorts"]),
    sysctls: parseAnnotationJson<Record<string, string>>(annotations["kakurizai.kubernetes.sysctls"]) || {}
  };
}

function connectivityPathForRow(row: InventoryRow, network: NetworkConfig) {
  const parts = [];
  if (row.host) parts.push(`host ${row.host}`);
  parts.push(network.type || "tap");
  if (network.mode && network.mode !== network.type) parts.push(network.mode);
  if (network.nat?.enabled) parts.push("nat");
  if (row.runtime?.exposedEndpoint) parts.push("endpoint");
  return parts.join(" -> ");
}

function parseAnnotationJson<T>(value?: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function effectiveNetworkForWorld(world?: World, fallbackType = "tap"): NetworkConfig {
  return {
    type: world?.backendConfig?.network?.type || world?.backendConfig?.networkType || fallbackType,
    mode: world?.backendConfig?.network?.mode || world?.backendConfig?.network?.type || world?.backendConfig?.networkType || fallbackType,
    sandboxIp: world?.backendConfig?.network?.sandboxIp || null,
    exposedPorts: world?.backendConfig?.network?.exposedPorts || [],
    allowInternetAccess: world?.backendConfig?.network?.allowInternetAccess,
    allowOut: world?.backendConfig?.network?.allowOut || [],
    denyOut: world?.backendConfig?.network?.denyOut || [],
    rules: world?.backendConfig?.network?.rules || [],
    vlan: world?.backendConfig?.network?.vlan || { enabled: false },
    nat: world?.backendConfig?.network?.nat || { enabled: false, portForwards: [] },
    dns: world?.backendConfig?.network?.dns || { servers: [], searches: [], options: [] }
  };
}

createRoot(document.getElementById("root")!).render(<Root />);
