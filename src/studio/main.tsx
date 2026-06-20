import React from "react";
import { createRoot } from "react-dom/client";
import { Terminal as XTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  Activity,
  Box,
  Cpu,
  Database,
  Folder,
  FolderOpen,
  Globe2,
  HardDrive,
  KeyRound,
  Layers,
  MoreHorizontal,
  Network,
  Plus,
  RefreshCcw,
  Route,
  Search,
  Server,
  Shield,
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
    mountMode?: string;
  } | null;
  backendConfig?: {
    mountMode?: string;
    template?: string | null;
    cpu?: string | null;
    memory?: string | null;
    writableLayerSize?: string | null;
    networkType?: string | null;
    network?: NetworkConfig | null;
    kubernetes?: KubernetesConfig | null;
    hostMount?: boolean | null;
    mounts?: Record<string, unknown>;
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
};

type CubePortMapping = {
  container_port?: number;
  host_port?: number;
};

type NetworkConfig = {
  type?: string;
  mode?: string;
  vlan?: VlanConfig | null;
  exposedPorts?: number[];
  allowInternetAccess?: boolean;
  allowOut?: string[];
  denyOut?: string[];
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

type KubernetesConfig = {
  enabled?: boolean;
  profile?: string;
  apiServerPort?: number;
  nodePorts?: number[];
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

function App() {
  const [authConfig, setAuthConfig] = React.useState<AuthConfig | null>(null);
  const [token, setToken] = React.useState(() => localStorage.getItem("kakurizai.token") || "");
  const [session, setSession] = React.useState<string | null>(null);
  const [worlds, setWorlds] = React.useState<World[]>([]);
  const [cube, setCube] = React.useState<CubeInspect | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState("Starting");
  const [busy, setBusy] = React.useState(false);
  const [actionMenuOpen, setActionMenuOpen] = React.useState(false);
  const [launchMenuOpen, setLaunchMenuOpen] = React.useState(false);
  const [formMessage, setFormMessage] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [stateFilter, setStateFilter] = React.useState<StateFilter>("all");
  const [launch, setLaunch] = React.useState({
    name: "kakurizai-sandbox",
    hostMount: false,
    sourcePath: "",
    mountMode: "agctl-overlay",
    cpu: "2000m",
    memory: "2000Mi",
    writableLayerSize: "1G",
    networkType: "tap",
    exposedPorts: "",
    dnsServers: "",
    allowInternetAccess: true,
    allowOut: "",
    denyOut: "10.0.0.0/8,100.64.0.0/10,172.16.0.0/12,192.168.0.0/18",
    kubernetesEnabled: false
  });
  const [browser, setBrowser] = React.useState<BrowseResult | null>(null);

  const inventory = React.useMemo(() => buildInventory(worlds, cube), [worlds, cube]);
  const filteredInventory = React.useMemo(
    () => filterInventory(inventory, search, stateFilter),
    [inventory, search, stateFilter]
  );
  const selected = inventory.find((row) => row.key === selectedId) || filteredInventory[0] || inventory[0] || null;
  const selectedTemplate = findTemplateForSandbox(cube, selected);
  const selectedNode = findNodeForSandbox(cube, selected);

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
        await browse(launch.sourcePath || "/home/mizuame");
      } catch (error) {
        setFormMessage(error instanceof Error ? error.message : String(error));
      }
    }
  }

  async function browse(path: string) {
    const result = await api<BrowseResult>(`/api/host/browse?path=${encodeURIComponent(path || "/")}`, { token });
    setBrowser(result);
    setLaunch((current) => ({ ...current, sourcePath: result.path }));
  }

  async function toggleHostMount(enabled: boolean) {
    setLaunch((current) => ({
      ...current,
      hostMount: enabled,
      mountMode: enabled && current.mountMode === "none" ? "agctl-overlay" : current.mountMode
    }));
    if (enabled && !browser) {
      try {
        await browse(launch.sourcePath || "/home/mizuame");
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
    if (launch.hostMount && !launch.sourcePath.trim()) {
      setFormMessage("Choose a host folder first.");
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
          sourcePath: launch.hostMount ? launch.sourcePath.trim() : undefined,
          backend: "cube-sandbox-overlay",
          hostMount: launch.hostMount,
          mountMode: launch.hostMount ? launch.mountMode : "none",
          cpu: launch.cpu,
          memory: launch.memory,
          writableLayerSize: launch.writableLayerSize,
          networkType: launch.networkType,
          network: {
            type: launch.networkType,
            exposedPorts: parsePortList(launch.exposedPorts),
            dns: { servers: parseCsv(launch.dnsServers) },
            allowInternetAccess: launch.allowInternetAccess,
            allowOut: parseCsv(launch.allowOut),
            denyOut: parseCsv(launch.denyOut)
          },
          kubernetes: {
            enabled: launch.kubernetesEnabled,
            profile: "k3s",
            apiServerPort: 6443,
            nodePorts: launch.kubernetesEnabled ? [30000, 30001] : []
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

  async function saveDiskSize(world: World, writableLayerSize: string) {
    const nextSize = writableLayerSize.trim();
    if (!nextSize) {
      setStatus("Enter writable layer size.");
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ world: World; appliedToRunningSandbox: boolean; reason: string }>(
        `/api/worlds/${encodeURIComponent(world.id)}/config`,
        { method: "PATCH", token, body: { writableLayerSize: nextSize } }
      );
      setWorlds((current) => current.map((candidate) => candidate.id === result.world.id ? result.world : candidate));
      setStatus(result.appliedToRunningSandbox ? `Disk updated for ${result.world.name}` : `Disk saved for next create/recreate: ${result.world.name}`);
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
        { method: "PATCH", token, body: { network, networkType: network.type, kubernetes } }
      );
      setWorlds((current) => current.map((candidate) => candidate.id === result.world.id ? result.world : candidate));
      setStatus(result.appliedToRunningSandbox ? `Network updated for ${result.world.name}` : `Network saved for next create/recreate: ${result.world.name}`);
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
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

  return (
    <main className="workbench">
      <aside className="activityBar">
        <button
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
      </aside>

      {actionMenuOpen ? (
        <section className="actionMenu">
          <button className="actionMenuItem" onClick={() => void openCreateMenu()} type="button">
            <Plus size={16} />
            <span>Create Sandbox</span>
          </button>
        </section>
      ) : null}

      {launchMenuOpen ? (
        <form className="newSandboxMenu" onSubmit={createSandbox}>
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
              <label>Host folder</label>
              <div className="inputRow">
                <input value={launch.sourcePath} onChange={(event) => setLaunch({ ...launch, sourcePath: event.target.value })} placeholder="/home/mizuame/project" />
                <button className="iconButton" type="button" onClick={() => browse(launch.sourcePath || "/home/mizuame")} title="Browse">
                  <FolderOpen size={16} />
                </button>
              </div>

              {browser ? (
                <div className="folderBrowser">
                  <div className="folderHeader">
                    <button className="ghost" type="button" disabled={!browser.parent} onClick={() => browser.parent && browse(browser.parent)}>Up</button>
                    <strong>{browser.path}</strong>
                  </div>
                  <div className="folderList">
                    {browser.entries.map((entry) => (
                      <button type="button" key={entry.path} onClick={() => browse(entry.path)}>
                        <Folder size={14} />
                        <span>{entry.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <label>Mount</label>
              <div className="mountModes">
                {mountModes.map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    className={`mountChoice ${launch.mountMode === mode.id ? "active" : ""}`}
                    onClick={() => setLaunch({ ...launch, mountMode: mode.id })}
                  >
                    <strong>{mode.label}</strong>
                    <span>{mode.description}</span>
                  </button>
                ))}
              </div>
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
              <label>Writable layer</label>
              <input value={launch.writableLayerSize} onChange={(event) => setLaunch({ ...launch, writableLayerSize: event.target.value })} placeholder="1G" />
            </div>
            <div>
              <label>Network type</label>
              <select value={launch.networkType} onChange={(event) => setLaunch({ ...launch, networkType: event.target.value })}>
                <option value="tap">tap</option>
              </select>
            </div>
          </div>

          <label>Expose ports</label>
          <input value={launch.exposedPorts} onChange={(event) => setLaunch({ ...launch, exposedPorts: event.target.value })} placeholder="6443,30000,30001" />

          <label>DNS servers</label>
          <input value={launch.dnsServers} onChange={(event) => setLaunch({ ...launch, dnsServers: event.target.value })} placeholder="8.8.8.8,1.1.1.1" />

          <div className="togglePair">
            <label className="checkRow compactCheck">
              <input
                type="checkbox"
                checked={launch.allowInternetAccess}
                onChange={(event) => setLaunch({ ...launch, allowInternetAccess: event.target.checked })}
              />
              <span>
                <strong>Internet egress</strong>
                <small>Allow outbound access</small>
              </span>
            </label>
            <label className="checkRow compactCheck">
              <input
                type="checkbox"
                checked={launch.kubernetesEnabled}
                onChange={(event) => setLaunch({
                  ...launch,
                  kubernetesEnabled: event.target.checked,
                  exposedPorts: event.target.checked && !launch.exposedPorts.trim() ? "6443,30000,30001" : launch.exposedPorts
                })}
              />
              <span>
                <strong>Kubernetes lab</strong>
                <small>Expose API and node ports</small>
              </span>
            </label>
          </div>

          <label>Deny egress CIDRs</label>
          <input value={launch.denyOut} onChange={(event) => setLaunch({ ...launch, denyOut: event.target.value })} placeholder="10.0.0.0/8,172.16.0.0/12" />

          <div className="sectionEmpty inlineNote">VLAN/macvlan is not enabled in the installed CubeSandbox OSS runtime. This Studio only sends supported tap networking.</div>

          {formMessage ? <div className="formMessage">{formMessage}</div> : null}

          <button className="primary wide" disabled={busy} type="submit">
            <Plus size={16} />
            {busy ? "Creating" : "Create"}
          </button>
        </form>
      ) : null}

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

      <section className="mainArea">
        <header className="titleBar">
          <div>
            <strong>{selected ? selected.name : "No sandbox selected"}</strong>
            <span>{selected ? subtitleForSandbox(selected) : status}</span>
          </div>
          <div className="toolbarActions">
            <button className="ghost" onClick={() => void refresh()} title="Refresh" type="button" disabled={busy}>
              <RefreshCcw size={16} />
            </button>
            {selected ? (
              <button className="danger" onClick={() => void destroySelected()} type="button" disabled={busy || !selected.sandboxId && !selected.world}>
                <Trash2 size={16} />
                Delete
              </button>
            ) : null}
          </div>
        </header>

        <section className="editorPane">
          {selected ? (
            <div className="sandboxDashboard">
              <div className="overviewGrid">
                <Kpi icon={<Activity size={16} />} label="Status" value={selected.status} tone={statusTone(selected.status)} />
                <Kpi icon={<Cpu size={16} />} label="CPU" value={selected.cpu || selectedTemplate?.cpu || "-"} />
                <Kpi icon={<HardDrive size={16} />} label="Memory" value={selected.memory || selectedTemplate?.memory || "-"} />
                <Kpi icon={<Database size={16} />} label="Writable layer" value={selected.runtime?.writableLayerSize || selected.world?.backendConfig?.writableLayerSize || selectedTemplate?.writableLayerSize || "-"} />
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
                  <Metric label="Sandbox ID" value={selected.sandboxId || "-"} wide />
                  <Metric label="Source" value={hasHostMount(selected) ? selected.world?.sourcePath || selected.sourcePath || "-" : "-"} wide />
                  <Metric label="Base template" value={selected.templateId || selected.world?.sandbox?.baseId || cube?.template || "-"} wide />
                  <Metric label="Reason" value={selected.world?.sandbox?.reason || selected.runtime?.inspectError || "-"} wide />
                </div>
              </DetailSection>

              <DetailSection icon={<Terminal size={16} />} title="Web Shell">
                <WebShell world={selected.world} token={token} />
              </DetailSection>

              <DetailSection icon={<Database size={16} />} title="Disk and Mounts">
                <div className="metricStrip compact">
                  <Metric label="Writable layer" value={selected.runtime?.writableLayerSize || selected.world?.backendConfig?.writableLayerSize || selectedTemplate?.writableLayerSize || "-"} />
                  <Metric label="System disk" value={selected.runtime?.systemDiskSize || "-"} />
                  <Metric label="Artifact" value={formatBytesNullable(selected.runtime?.artifactSizeBytes ?? selectedTemplate?.artifactSizeBytes)} />
                  <Metric label="Upper" value={formatBytes(selected.world?.diskUsage?.upperBytes || 0)} />
                  <Metric label="Logs" value={formatBytes(selected.world?.diskUsage?.logsBytes || 0)} />
                  <Metric label="Host data disk" value={formatDiskMb(selected.runtime?.hostDataDiskMB)} />
                </div>
                <DiskEditor
                  world={selected.world}
                  runtimeSize={selected.runtime?.writableLayerSize || selectedTemplate?.writableLayerSize || ""}
                  busy={busy}
                  onSave={saveDiskSize}
                />
                <MountTable mounts={selected.runtime?.volumeMounts || mountsFromWorld(selected.world)} />
              </DetailSection>

              <DetailSection icon={<Route size={16} />} title="Network">
                <NetworkEditor
                  world={selected.world}
                  runtimeNetworkType={selectedTemplate?.networkType || cube?.config?.networkType || "tap"}
                  busy={busy}
                  onSave={saveNetworkSettings}
                />
                <div className="metricStrip compact">
                  <Metric label="Sandbox IP" value={selected.runtime?.sandboxIp || "-"} />
                  <Metric label="Host IP" value={selected.runtime?.hostIp || selected.host || "-"} />
                  <Metric label="Endpoint" value={selected.runtime?.exposedEndpoint || "-"} />
                  <Metric label="Port mode" value={selected.runtime?.exposedPortMode || "-"} />
                  <Metric label="Requested port" value={selected.runtime?.requestedContainerPort ? String(selected.runtime.requestedContainerPort) : "-"} />
                  <Metric label="Domain" value={cube?.config?.sandboxDomain || "-"} />
                  <Metric label="Configured ports" value={formatList(effectiveNetworkForWorld(selected.world).exposedPorts)} />
                  <Metric label="DNS" value={formatList(effectiveNetworkForWorld(selected.world).dns?.servers)} />
                  <Metric label="Internet egress" value={formatBool(effectiveNetworkForWorld(selected.world).allowInternetAccess)} />
                  <Metric label="Kubernetes" value={selected.world?.backendConfig?.kubernetes?.enabled ? selected.world.backendConfig.kubernetes.profile || "enabled" : "disabled"} />
                </div>
                <PortTable ports={selected.runtime?.portMappings || []} />
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
                  <Metric label="Internet access" value={formatBool(selectedTemplate?.allowInternetAccess)} />
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

function WebShell({ world, token }: { world?: World; token: string }) {
  const terminalRef = React.useRef<HTMLDivElement | null>(null);
  const socketRef = React.useRef<WebSocket | null>(null);
  const terminalInstanceRef = React.useRef<XTerminal | null>(null);
  const [session, setSession] = React.useState(0);
  const [connected, setConnected] = React.useState(false);

  React.useEffect(() => {
    if (!world || session === 0 || !terminalRef.current) return;
    const term = new XTerminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 12,
      rows: 18,
      cols: 100,
      theme: {
        background: "#07080a",
        foreground: "#e5e5e8",
        cursor: "#1493ff"
      }
    });
    terminalRef.current.innerHTML = "";
    term.open(terminalRef.current);
    term.writeln(`Connecting to ${world.name}...`);
    const url = new URL(`/api/worlds/${encodeURIComponent(world.id)}/shell`, window.location.href);
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    if (token) url.searchParams.set("token", token);
    const socket = new WebSocket(url);
    socketRef.current = socket;
    terminalInstanceRef.current = term;
    const disposable = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    });
    socket.addEventListener("open", () => setConnected(true));
    socket.addEventListener("message", (event) => term.write(String(event.data)));
    socket.addEventListener("close", () => {
      setConnected(false);
      term.writeln("\r\nDisconnected.");
    });
    socket.addEventListener("error", () => {
      term.writeln("\r\nShell connection error.");
    });
    return () => {
      disposable.dispose();
      socket.close();
      term.dispose();
      socketRef.current = null;
      terminalInstanceRef.current = null;
      setConnected(false);
    };
  }, [session, token, world?.id]);

  function disconnect() {
    socketRef.current?.close();
  }

  if (!world) {
    return <div className="sectionEmpty">Web Shell is available for KakuriZai-managed sandboxes only.</div>;
  }

  return (
    <div className="webShell">
      <div className="shellToolbar">
        <button className="primary" onClick={() => setSession((value) => value + 1)} type="button">
          <Terminal size={15} />
          {connected ? "Reconnect shell" : "Connect shell"}
        </button>
        <button className="ghost" onClick={disconnect} type="button" disabled={!connected}>Disconnect</button>
        <span>{connected ? "connected" : "disconnected"}</span>
      </div>
      <div className="terminalSurface" ref={terminalRef} />
    </div>
  );
}

function DiskEditor({
  world,
  runtimeSize,
  busy,
  onSave
}: {
  world?: World;
  runtimeSize: string;
  busy: boolean;
  onSave: (world: World, writableLayerSize: string) => Promise<void>;
}) {
  const configuredSize = world?.backendConfig?.writableLayerSize || runtimeSize || "1G";
  const [value, setValue] = React.useState(configuredSize);

  React.useEffect(() => {
    setValue(configuredSize);
  }, [configuredSize, world?.id]);

  if (!world) {
    return <div className="sectionEmpty">Disk settings are read-only for runtime-only sandboxes.</div>;
  }

  return (
    <form
      className="diskEditor"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(world, value);
      }}
    >
      <div>
        <label>Writable layer</label>
        <div className="inputRow">
          <input value={value} onChange={(event) => setValue(event.target.value)} placeholder="1G" />
          <button className="primary" disabled={busy || !value.trim()} type="submit">Save</button>
        </div>
      </div>
      <Metric label="Runtime size" value={runtimeSize || "-"} />
    </form>
  );
}

function NetworkEditor({
  world,
  runtimeNetworkType,
  busy,
  onSave
}: {
  world?: World;
  runtimeNetworkType: string;
  busy: boolean;
  onSave: (world: World, network: NetworkConfig, kubernetes: KubernetesConfig) => Promise<void>;
}) {
  const configuredNetwork = effectiveNetworkForWorld(world, runtimeNetworkType);
  const configuredKubernetes = world?.backendConfig?.kubernetes || { enabled: false, profile: "k3s", apiServerPort: 6443, nodePorts: [] };
  const [form, setForm] = React.useState({
    type: configuredNetwork.type || runtimeNetworkType || "tap",
    exposedPorts: formatList(configuredNetwork.exposedPorts),
    dnsServers: formatList(configuredNetwork.dns?.servers),
    allowInternetAccess: configuredNetwork.allowInternetAccess ?? true,
    allowOut: formatList(configuredNetwork.allowOut),
    denyOut: formatList(configuredNetwork.denyOut),
    kubernetesEnabled: Boolean(configuredKubernetes.enabled),
    kubernetesProfile: configuredKubernetes.profile || "k3s",
    apiServerPort: String(configuredKubernetes.apiServerPort || 6443),
    nodePorts: formatList(configuredKubernetes.nodePorts)
  });

  React.useEffect(() => {
    setForm({
      type: configuredNetwork.type || runtimeNetworkType || "tap",
      exposedPorts: formatList(configuredNetwork.exposedPorts),
      dnsServers: formatList(configuredNetwork.dns?.servers),
      allowInternetAccess: configuredNetwork.allowInternetAccess ?? true,
      allowOut: formatList(configuredNetwork.allowOut),
      denyOut: formatList(configuredNetwork.denyOut),
      kubernetesEnabled: Boolean(configuredKubernetes.enabled),
      kubernetesProfile: configuredKubernetes.profile || "k3s",
      apiServerPort: String(configuredKubernetes.apiServerPort || 6443),
      nodePorts: formatList(configuredKubernetes.nodePorts)
    });
  }, [world?.id, runtimeNetworkType]);

  if (!world) {
    return <div className="sectionEmpty">Network settings are read-only for runtime-only sandboxes.</div>;
  }

  return (
    <form
      className="networkEditor"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(
          world,
          {
            type: form.type,
            exposedPorts: form.exposedPorts as unknown as number[],
            dns: { servers: parseCsv(form.dnsServers) },
            allowInternetAccess: form.allowInternetAccess,
            allowOut: parseCsv(form.allowOut),
            denyOut: parseCsv(form.denyOut)
          },
          {
            enabled: form.kubernetesEnabled,
            profile: form.kubernetesProfile,
            apiServerPort: Number(form.apiServerPort || 6443),
            nodePorts: form.nodePorts as unknown as number[]
          }
        );
      }}
    >
      <div className="splitFields">
        <div>
          <label>Network type</label>
          <select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
            <option value="tap">tap</option>
          </select>
        </div>
        <div>
          <label>Expose ports</label>
          <input value={form.exposedPorts} onChange={(event) => setForm({ ...form, exposedPorts: event.target.value })} placeholder="6443,30000,30001" />
        </div>
      </div>
      <div className="splitFields">
        <div>
          <label>DNS servers</label>
          <input value={form.dnsServers} onChange={(event) => setForm({ ...form, dnsServers: event.target.value })} placeholder="8.8.8.8,1.1.1.1" />
        </div>
        <div>
          <label>Allow egress CIDRs</label>
          <input value={form.allowOut} onChange={(event) => setForm({ ...form, allowOut: event.target.value })} placeholder="0.0.0.0/0" />
        </div>
      </div>
      <label>Deny egress CIDRs</label>
      <input value={form.denyOut} onChange={(event) => setForm({ ...form, denyOut: event.target.value })} placeholder="10.0.0.0/8,172.16.0.0/12" />
      <div className="togglePair">
        <label className="checkRow compactCheck">
          <input
            type="checkbox"
            checked={form.allowInternetAccess}
            onChange={(event) => setForm({ ...form, allowInternetAccess: event.target.checked })}
          />
          <span>
            <strong>Internet egress</strong>
            <small>Set CubeNetworkConfig</small>
          </span>
        </label>
        <label className="checkRow compactCheck">
          <input
            type="checkbox"
            checked={form.kubernetesEnabled}
            onChange={(event) => setForm({
              ...form,
              kubernetesEnabled: event.target.checked,
              exposedPorts: event.target.checked && !form.exposedPorts.trim() ? "6443,30000,30001" : form.exposedPorts,
              nodePorts: event.target.checked && !form.nodePorts.trim() ? "30000,30001" : form.nodePorts
            })}
          />
          <span>
            <strong>Kubernetes lab</strong>
            <small>Privileged sysctls and ports</small>
          </span>
        </label>
      </div>
      {form.kubernetesEnabled ? (
        <div className="splitFields">
          <div>
            <label>K8s profile</label>
            <input value={form.kubernetesProfile} onChange={(event) => setForm({ ...form, kubernetesProfile: event.target.value })} placeholder="k3s" />
          </div>
          <div>
            <label>Node ports</label>
            <input value={form.nodePorts} onChange={(event) => setForm({ ...form, nodePorts: event.target.value })} placeholder="30000,30001" />
          </div>
        </div>
      ) : null}
      <button className="primary" disabled={busy} type="submit">Save network</button>
      <div className="sectionEmpty inlineNote">VLAN/macvlan requires a CubeSandbox network plugin or host-side bridge integration. The OSS runtime here accepts tap only.</div>
    </form>
  );
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

function MountTable({ mounts }: { mounts: CubeVolumeMount[] }) {
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
        <div className="dataRow" key={`${mount.name || "mount"}-${index}`}>
          <span>{mount.name || "-"}</span>
          <span>{mount.container_path || "-"}</span>
          <span>{mount.host_path || "-"}</span>
          <span>{mount.readonly || mount.recursive_read_only ? "read-only" : "read-write"}</span>
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
    return {
      key: `world:${world.id}`,
      name: world.name,
      status: runtime?.status || world.status,
      origin: runtime ? "KakuriZai + CubeSandbox" : "KakuriZai",
      sourcePath: world.sourcePath,
      mountMode: world.backendConfig?.mountMode || world.sandbox?.mountMode || "-",
      sandboxId: world.sandbox?.id || runtime?.id || "",
      templateId: runtime?.templateId || world.backendConfig?.template || world.sandbox?.baseId || null,
      cpu: runtime?.cpu || world.backendConfig?.cpu || null,
      memory: runtime?.memory || world.backendConfig?.memory || null,
      host: runtime?.hostIp || runtime?.hostId || null,
      createdAt: runtime?.createdAt || world.createdAt,
      world,
      runtime
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

function mountsFromWorld(world?: World): CubeVolumeMount[] {
  const mounts = world?.backendConfig?.mounts;
  if (!mounts) return [];
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

function sameSandboxId(left?: string, right?: string) {
  if (!left || !right) return false;
  return left === right || shortId(left) === shortId(right);
}

function statusTone(status: string): "ok" | "warn" | "muted" {
  const normalized = status.toLowerCase();
  if (["ready", "running", "active", "up", "healthy"].includes(normalized)) return "ok";
  if (normalized.startsWith("pending") || normalized.includes("creating") || normalized.includes("starting") || normalized.includes("paused")) return "warn";
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

function formatList(value?: Array<string | number> | string | null) {
  if (!value) return "";
  if (Array.isArray(value)) return value.join(",");
  return String(value);
}

function parseCsv(value: string) {
  return String(value || "")
    .split(/[,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
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

function effectiveNetworkForWorld(world?: World, fallbackType = "tap"): NetworkConfig {
  return {
    type: world?.backendConfig?.network?.type || world?.backendConfig?.networkType || fallbackType,
    exposedPorts: world?.backendConfig?.network?.exposedPorts || [],
    allowInternetAccess: world?.backendConfig?.network?.allowInternetAccess,
    allowOut: world?.backendConfig?.network?.allowOut || [],
    denyOut: world?.backendConfig?.network?.denyOut || [],
    dns: world?.backendConfig?.network?.dns || { servers: [], searches: [], options: [] }
  };
}

createRoot(document.getElementById("root")!).render(<App />);
