import React from "react";
import { createRoot } from "react-dom/client";
import {
  Bot,
  Code2,
  Folder,
  FolderOpen,
  KeyRound,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCcw,
  Server,
  Shield,
  Terminal,
  Trash2,
  Upload,
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

type RuntimeSandbox = CubeInspect["sandboxes"][number];

type InventoryRow = {
  key: string;
  name: string;
  status: string;
  origin: string;
  sourcePath: string;
  mountMode: string;
  sandboxId: string;
  world?: World;
  runtime?: RuntimeSandbox;
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
  const [status, setStatus] = React.useState("Starting");
  const [busy, setBusy] = React.useState(false);
  const [actionMenuOpen, setActionMenuOpen] = React.useState(false);
  const [launchMenuOpen, setLaunchMenuOpen] = React.useState(false);
  const [formMessage, setFormMessage] = React.useState("");
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
      setStatus(`${nextInventory.length} Sandbox${nextInventory.length === 1 ? "" : "es"} / ${cubeResult.sandboxes.length} CubeSandbox`);
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
    if (!browser) {
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

  async function createSandbox(event: React.FormEvent) {
    event.preventDefault();
    if (!launch.name.trim()) {
      setFormMessage("Enter a sandbox name.");
      return;
    }
    if (!launch.sourcePath.trim()) {
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
          sourcePath: launch.sourcePath.trim(),
          backend: "cube-sandbox-overlay",
          mountMode: launch.mountMode,
          cpu: launch.cpu,
          memory: launch.memory
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

  async function openTarget(target: "file" | "terminal" | "vscode" | "agent") {
    if (!selected?.world) {
      setStatus("Select a KakuriZai-managed sandbox");
      return;
    }
    try {
      await api(`/api/worlds/${encodeURIComponent(selected.world.id)}/open`, {
        method: "POST",
        token,
        body: { target }
      });
      setStatus(`Opened ${target} for ${selected.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function applySelected() {
    if (!selected?.world) {
      setStatus("Select a KakuriZai-managed sandbox");
      return;
    }
    setBusy(true);
    try {
      await api(`/api/worlds/${encodeURIComponent(selected.world.id)}/apply`, {
        method: "POST",
        token,
        body: { dryRun: false }
      });
      setStatus(`Applied ${selected.name}`);
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
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
        <div className="sandboxList">
          {inventory.map((row) => (
            <button key={row.key} className={`sandboxItem ${row.key === selected?.key ? "selected" : ""}`} onClick={() => setSelectedId(row.key)} type="button">
              <span className="sandboxTopLine">
                <span className="sandboxName">{row.name}</span>
                <span className={`sandboxState ${statusTone(row.status)}`}>{row.status}</span>
              </span>
              <span className="sandboxPath">{row.sourcePath}</span>
            </button>
          ))}
          {inventory.length === 0 ? <div className="emptyList">No sandboxes</div> : null}
        </div>
      </section>

      <section className="mainArea">
        <header className="titleBar">
          <div>
            <strong>{selected ? selected.name : "No sandbox selected"}</strong>
            <span>{selected ? selected.sourcePath : status}</span>
          </div>
          <div className="toolbarActions">
            <button className="ghost" onClick={() => void refresh()} title="Refresh" type="button" disabled={busy}>
              <RefreshCcw size={16} />
            </button>
            {selected?.world ? (
              <button className="danger" onClick={() => removeWorld(selected.world!)} type="button" disabled={busy}>
                <Trash2 size={16} />
                Remove
              </button>
            ) : null}
          </div>
        </header>

        <section className="editorPane">
          {selected ? (
            <div className="sandboxDashboard">
              <div className="launchStrip">
                <button className="launchButton" onClick={() => void openTarget("file")} disabled={!selected.world} type="button">
                  <FolderOpen size={18} />
                  <span>File</span>
                </button>
                <button className="launchButton" onClick={() => void openTarget("terminal")} disabled={!selected.world} type="button">
                  <Terminal size={18} />
                  <span>Terminal</span>
                </button>
                <button className="launchButton" onClick={() => void openTarget("vscode")} disabled={!selected.world} type="button">
                  <Code2 size={18} />
                  <span>VS Code</span>
                </button>
                <button className="launchButton" onClick={() => void openTarget("agent")} disabled={!selected.world} type="button">
                  <Bot size={18} />
                  <span>Agent</span>
                </button>
                <button className="launchButton" onClick={() => void applySelected()} disabled={!selected.world || busy} type="button">
                  <Upload size={18} />
                  <span>Apply</span>
                </button>
              </div>

              <div className="metricStrip">
                <Metric label="Status" value={selected.status} />
                <Metric label="Origin" value={selected.origin} />
                <Metric label="Mount" value={selected.mountMode} />
                <Metric label="Runtime" value={cube?.mode || "-"} />
                <Metric label="Host" value={selected.runtime?.hostId || "-"} />
                <Metric label="Created" value={selected.runtime?.createdAt || selected.world?.createdAt || "-"} />
                <Metric label="Sandbox ID" value={selected.sandboxId || "-"} wide />
                <Metric label="Source" value={selected.world?.sourcePath || "-"} wide />
                <Metric label="Base Template" value={selected.world?.sandbox?.baseId || cube?.template || "-"} wide />
                <Metric label="Reason" value={selected.world?.sandbox?.reason || "-"} wide />
                <Metric label="Upper" value={formatBytes(selected.world?.diskUsage?.upperBytes || 0)} />
                <Metric label="Logs" value={formatBytes(selected.world?.diskUsage?.logsBytes || 0)} />
              </div>
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

function Metric({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "metric wideMetric" : "metric"}>
      <span>{label}</span>
      <strong>{value}</strong>
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
      sandboxId: runtime.id,
      runtime
    });
  }
  return rows;
}

function sameSandboxId(left?: string, right?: string) {
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
