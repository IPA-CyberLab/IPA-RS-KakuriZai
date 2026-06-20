import React from "react";
import { createRoot } from "react-dom/client";
import {
  Folder,
  FolderOpen,
  KeyRound,
  Monitor,
  Play,
  RefreshCcw,
  Server,
  Shield,
  Trash2
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
    mounts?: Record<string, unknown>;
  };
  diskUsage?: {
    upperBytes: number;
    logsBytes: number;
  };
};

type CubeInspect = {
  available: boolean;
  mode: string;
  reason?: string | null;
  namespace: string;
  template?: string | null;
  cubecli?: { path: string; version?: string | null } | null;
  mastercli?: { path: string } | null;
  templates: Array<{ id: string; status: string; createdAt: string; image: string }>;
  sandboxes: Array<{ id: string; status: string; hostId: string; createdAt: string; pausedAt: string }>;
  templatesError?: string | null;
  sandboxesError?: string | null;
};

type BrowseResult = {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string; type: "directory" }>;
};

type RuntimeVm = CubeInspect["sandboxes"][number];

type InventoryRow = {
  key: string;
  name: string;
  status: string;
  origin: string;
  sourcePath: string;
  mountMode: string;
  vmId: string;
  world?: World;
  runtime?: RuntimeVm;
};

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
  const [status, setStatus] = React.useState("Loading");
  const [busy, setBusy] = React.useState(false);
  const [launch, setLaunch] = React.useState({
    name: "kakurizai-sandbox",
    sourcePath: "",
    mountMode: "agctl-overlay",
    cpu: "2000m",
    memory: "2000Mi"
  });
  const [browser, setBrowser] = React.useState<BrowseResult | null>(null);
  const inventory = React.useMemo(() => buildInventory(worlds, cube), [worlds, cube]);
  const selected = inventory.find((row) => row.key === selectedId) || inventory[0] || null;

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
      setStatus(`${nextInventory.length} Sandbox${nextInventory.length === 1 ? "" : "es"} · ${cubeResult.sandboxes.length} CubeSandbox`);
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

  async function browse(path: string) {
    const result = await api<BrowseResult>(`/api/host/browse?path=${encodeURIComponent(path || "/")}`, { token });
    setBrowser(result);
    setLaunch((current) => ({ ...current, sourcePath: result.path }));
  }

  async function launchVm(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const world = await api<World>("/api/worlds", {
        method: "POST",
        token,
        body: {
          name: launch.name,
          sourcePath: launch.sourcePath,
          backend: "cube-sandbox-overlay",
          mountMode: launch.mountMode,
          cpu: launch.cpu,
          memory: launch.memory
        }
      });
      setSelectedId(`world:${world.id}`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function removeWorld(world: World) {
    if (!confirm(`Delete sandbox ${world.name}?`)) return;
    setBusy(true);
    try {
      await api(`/api/worlds/${encodeURIComponent(world.id)}`, { method: "DELETE", token });
      setSelectedId(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  if (authConfig?.requiresToken && !session) {
    return (
      <div className="login-page">
        <form className="login-panel" onSubmit={signIn}>
          <div className="mark"><Shield size={22} /></div>
          <h1>KakuriZai Console</h1>
          <p>{authConfig.label}</p>
          <div className="auth-meta">
            <span>Provider</span><strong>{authConfig.provider}</strong>
            <span>Issuer</span><strong>{authConfig.issuer || "-"}</strong>
            <span>Audience</span><strong>{authConfig.audience || "-"}</strong>
          </div>
          <label className="field-label">
            Bearer token
            <input value={token} onChange={(event) => setToken(event.target.value)} placeholder="eyJ..." />
          </label>
          <button className="button primary" type="submit"><KeyRound size={16} /> Sign in</button>
          <p className="hint">Auth provider is server-configured: self, Auth0, AWS Cognito, any OIDC, or disabled.</p>
        </form>
      </div>
    );
  }

  return (
    <div className="console">
      <aside className="nav">
        <div className="brand-row">
          <div className="brand-icon"><Server size={18} /></div>
          <div>
            <strong>KakuriZai</strong>
            <span>Sandbox Console</span>
          </div>
        </div>
        <nav>
          <button className="nav-item active"><Monitor size={16} /> Sandboxes</button>
        </nav>
        <div className="node-card">
          <span>Node</span>
          <strong>100.105.153.15</strong>
          <small>{cube?.available ? "Sandbox runtime online" : cube?.reason || "Unknown"}</small>
        </div>
      </aside>

      <main className="workbench">
        <header className="topbar">
          <div>
            <h1>Sandboxes</h1>
            <p>{status} · {session || "anonymous"}</p>
          </div>
          <button className="button" onClick={refresh} disabled={busy}><RefreshCcw size={15} /> Refresh</button>
        </header>

        <section className="layout">
          <section className="panel list-panel">
            <div className="panel-head">
              <h2>Inventory</h2>
              <Badge tone={cube?.available ? "ok" : "warn"}>{cube?.available ? "ready" : "offline"}</Badge>
            </div>
            <table className="data-table">
              <thead><tr><th>Name</th><th>Status</th><th>Origin</th><th>Mount</th><th>Sandbox ID</th></tr></thead>
              <tbody>
                {inventory.map((row) => (
                  <tr key={row.key} className={row.key === selected?.key ? "selected" : ""} onClick={() => setSelectedId(row.key)}>
                    <td><strong>{row.name}</strong><span>{row.sourcePath}</span></td>
                    <td><Badge tone={statusTone(row.status)}>{row.status}</Badge></td>
                    <td>{row.origin}</td>
                    <td>{row.mountMode}</td>
                    <td>{shortId(row.vmId)}</td>
                  </tr>
                ))}
                {inventory.length === 0 && <tr><td colSpan={5} className="empty-cell">No sandboxes</td></tr>}
              </tbody>
            </table>
          </section>

          <section className="panel launch-panel">
            <div className="panel-head">
              <h2>Launch Sandbox</h2>
              <Badge tone={cube?.available ? "ok" : "warn"}>{cube?.available ? "ready" : "offline"}</Badge>
            </div>
            <form onSubmit={launchVm} className="form-grid">
              <label className="field-label">Name<input value={launch.name} onChange={(event) => setLaunch({ ...launch, name: event.target.value })} required /></label>
              <label className="field-label path-field">Host folder
                <div className="input-row">
                  <input value={launch.sourcePath} onChange={(event) => setLaunch({ ...launch, sourcePath: event.target.value })} placeholder="/home/mizuame/project" required />
                  <button className="button" type="button" onClick={() => browse(launch.sourcePath || "/home/mizuame")}><FolderOpen size={15} /> Browse</button>
                </div>
              </label>
              {browser && (
                <div className="browser">
                  <div className="browser-head">
                    <button type="button" className="link-button" disabled={!browser.parent} onClick={() => browser.parent && browse(browser.parent)}>Up</button>
                    <strong>{browser.path}</strong>
                  </div>
                  <div className="browser-list">
                    {browser.entries.map((entry) => (
                      <button type="button" key={entry.path} onClick={() => browse(entry.path)}><Folder size={14} /> {entry.name}</button>
                    ))}
                  </div>
                </div>
              )}
              <div className="mount-modes">
                {mountModes.map((mode) => (
                  <label key={mode.id} className={`choice ${launch.mountMode === mode.id ? "active" : ""}`}>
                    <input type="radio" name="mountMode" checked={launch.mountMode === mode.id} onChange={() => setLaunch({ ...launch, mountMode: mode.id })} />
                    <strong>{mode.label}</strong>
                    <span>{mode.description}</span>
                  </label>
                ))}
              </div>
              <div className="two-col">
                <label className="field-label">CPU<input value={launch.cpu} onChange={(event) => setLaunch({ ...launch, cpu: event.target.value })} /></label>
                <label className="field-label">Memory<input value={launch.memory} onChange={(event) => setLaunch({ ...launch, memory: event.target.value })} /></label>
              </div>
              <button className="button primary" type="submit" disabled={busy}><Play size={16} /> Start Sandbox</button>
            </form>
          </section>

          <section className="panel detail-panel">
            <div className="panel-head">
              <h2>Sandbox Details</h2>
              {selected?.world && <button className="button danger" onClick={() => removeWorld(selected.world!)}><Trash2 size={15} /> Delete</button>}
            </div>
            {selected ? <SandboxDetails row={selected} /> : <div className="empty-state">Select a sandbox</div>}
          </section>
        </section>
      </main>
    </div>
  );
}

function SandboxDetails({ row }: { row: InventoryRow }) {
  const world = row.world;
  const runtime = row.runtime;
  return (
    <div className="details-grid">
      <Info label="Name" value={row.name} />
      <Info label="Status" value={row.status} />
      <Info label="Origin" value={row.origin} />
      <Info label="Sandbox ID" value={row.vmId || "-"} />
      <Info label="Host" value={runtime?.hostId || "-"} />
      <Info label="Created" value={runtime?.createdAt || world?.createdAt || "-"} />
      <Info label="Source" value={world?.sourcePath || "-"} />
      <Info label="Mount mode" value={row.mountMode} />
      <Info label="Base template" value={world?.sandbox?.baseId || "-"} />
      <Info label="Reason" value={world?.sandbox?.reason || "-"} />
      <Info label="Upper bytes" value={formatBytes(world?.diskUsage?.upperBytes || 0)} />
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="info"><span>{label}</span><strong>{value}</strong></div>;
}

function Badge({ children, tone }: { children: React.ReactNode; tone: "ok" | "warn" | "muted" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function buildInventory(worlds: World[], cube: CubeInspect | null): InventoryRow[] {
  const runtimes = cube?.sandboxes || [];
  const matchedRuntimeIds = new Set<string>();
  const rows = worlds.map((world) => {
    const runtime = runtimes.find((candidate) => sameVmId(candidate.id, world.sandbox?.id));
    if (runtime) matchedRuntimeIds.add(runtime.id);
    return {
      key: `world:${world.id}`,
      name: world.name,
      status: runtime?.status || world.status,
      origin: runtime ? "KakuriZai + CubeSandbox" : "KakuriZai",
      sourcePath: world.sourcePath,
      mountMode: world.backendConfig?.mountMode || world.sandbox?.mountMode || "-",
      vmId: world.sandbox?.id || runtime?.id || "",
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
      mountMode: "-",
      vmId: runtime.id,
      runtime
    });
  }
  return rows;
}

function sameVmId(left?: string, right?: string) {
  if (!left || !right) return false;
  return left === right || shortId(left) === shortId(right);
}

function statusTone(status: string): "ok" | "warn" | "muted" {
  const normalized = status.toLowerCase();
  if (["ready", "running", "active"].includes(normalized)) return "ok";
  if (normalized.startsWith("pending") || normalized.includes("creating") || normalized.includes("starting")) return "warn";
  return "muted";
}

async function api<T>(path: string, options: { method?: string; token?: string | null; body?: unknown } = {}): Promise<T> {
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
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

createRoot(document.getElementById("root")!).render(<App />);
