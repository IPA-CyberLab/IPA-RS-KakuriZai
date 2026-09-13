import React from "react";
import {
  Activity,
  Ban,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  FileCode2,
  LogOut,
  Monitor,
  Square,
  UserRound,
  X
} from "lucide-react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Input } from "./components/ui/input";

type ApiClient = <T = unknown>(path: string, options?: { method?: string; token?: string | null; body?: unknown }) => Promise<T>;

type AccountUser = {
  subject: string;
  username: string;
  name: string;
  email: string;
  avatarUrl: string;
  provider: string;
  loginType: string;
  status: "active" | "suspended";
  roles: string[];
  assignedRoles: string[];
  permissions?: string[];
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
};

type SessionResponse = {
  user: AccountUser;
  auth: string;
  permissions: string[];
};

type AccountSession = {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip?: string | null;
  userAgent?: string | null;
};

type TerraformRun = {
  id: string;
  projectId: string;
  worldId: string;
  worldName: string;
  action: "validate" | "plan" | "apply" | "destroy-plan" | "destroy";
  status: "queued" | "running" | "canceling" | "succeeded" | "failed" | "canceled";
  stage: string;
  subject?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: string | null;
  exitCode?: number | null;
  log: string;
};

type TerraformProject = {
  projectId: string;
  worldId: string;
  worldName: string;
  sourceHash: string;
  createdAt: string;
  updatedAt: string;
  worldExists: boolean;
  statePresent: boolean;
  lockPresent: boolean;
  plan?: {
    kind: "apply" | "destroy";
    sourceHash: string;
    runId: string;
    hasChanges: boolean;
    createdAt: string;
  } | null;
};

type TerraformOverview = {
  terraform: {
    installed: boolean;
    binary: string;
    version?: string | null;
    platform?: string | null;
    error?: string;
  };
  workDir: string;
  stages: string[];
  projects: TerraformProject[];
  runs: TerraformRun[];
};

type TerraformPreview = {
  projectId: string;
  worldId: string;
  worldName: string;
  sourceHash: string;
  files: Record<string, string>;
};

type WorldSummary = { id: string; name: string };

function ManagementDisclosure({
  icon,
  title,
  hint,
  children,
  danger = false
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <details className={`disclosureCard managementDisclosure ${danger ? "dangerDisclosure" : ""}`}>
      <summary>
        <span className="disclosureIcon">{icon}</span>
        <span className="disclosureCopy"><strong>{title}</strong><small>{hint}</small></span>
        <ChevronRight className="disclosureChevron" size={18} aria-hidden="true" />
      </summary>
      <div className="disclosureBody">{children}</div>
    </details>
  );
}

export function AccountsWorkspace({
  initialSession,
  authConfig,
  apiClient,
  onSignOut
}: {
  initialSession: SessionResponse | null;
  authConfig: { accountUrl?: string } | null;
  apiClient: ApiClient;
  onSignOut: () => Promise<void>;
}) {
  const [account, setAccount] = React.useState<AccountUser | null>(initialSession?.user || null);
  const [sessions, setSessions] = React.useState<AccountSession[]>([]);
  const [users, setUsers] = React.useState<AccountUser[]>([]);
  const [form, setForm] = React.useState({
    username: initialSession?.user.username || "",
    name: initialSession?.user.name || "",
    avatarUrl: initialSession?.user.avatarUrl || ""
  });
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const permissions = initialSession?.permissions || [];
  const canManageUsers = permissions.includes("admin") || permissions.includes("users:read");

  React.useEffect(() => {
    let canceled = false;
    async function load() {
      try {
        const [nextAccount, nextSessions, nextUsers] = await Promise.all([
          apiClient<AccountUser>("/api/account"),
          apiClient<AccountSession[]>("/api/account/sessions"),
          canManageUsers ? apiClient<AccountUser[]>("/api/users") : Promise.resolve([])
        ]);
        if (canceled) return;
        setAccount(nextAccount);
        setSessions(nextSessions);
        setUsers(nextUsers);
        setForm({ username: nextAccount.username, name: nextAccount.name, avatarUrl: nextAccount.avatarUrl });
      } catch (error) {
        if (!canceled) setMessage(error instanceof Error ? error.message : String(error));
      }
    }
    void load();
    return () => { canceled = true; };
  }, [apiClient, canManageUsers]);

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const next = await apiClient<AccountUser>("/api/account", { method: "PATCH", body: form });
      setAccount(next);
      setMessage("Account updated");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function revokeSession(id: string) {
    setBusy(true);
    setMessage("");
    try {
      await apiClient(`/api/account/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      setSessions((current) => current.filter((item) => item.id !== id));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function revokeOtherSessions() {
    setBusy(true);
    setMessage("");
    try {
      await apiClient("/api/account/sessions", { method: "DELETE" });
      setSessions((current) => current.filter((item) => item.current));
      setMessage("Other sessions revoked");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function updateUser(subject: string, input: { roles?: string[]; status?: string }) {
    setBusy(true);
    setMessage("");
    try {
      const next = await apiClient<AccountUser>(`/api/users/${encodeURIComponent(subject)}`, { method: "PATCH", body: input });
      setUsers((current) => current.map((item) => item.subject === subject ? next : item));
      if (account?.subject === subject) setAccount(next);
      setMessage(`Updated ${next.username}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settingsWorkspace">
      <section className="settingsPageIntro">
        <div>
          <h1>Account</h1>
          <p>Manage your profile, identity-provider access, and signed-in devices.</p>
        </div>
        {authConfig?.accountUrl ? (
          <Button variant="outline" onClick={() => window.open(authConfig.accountUrl, "_blank", "noopener,noreferrer")}>
            <ExternalLink size={15} /> Identity provider
          </Button>
        ) : null}
      </section>

      {message ? <div className="settingsNotice" role="status">{message}</div> : null}

      <div className="settingsGrid">
        <Card className="settingsCard accountProfileCard">
          <header>
            <div className="accountAvatar" aria-hidden="true">
              {account?.avatarUrl ? <img src={account.avatarUrl} alt="" /> : <UserRound size={24} />}
            </div>
            <div>
              <strong>{account?.name || account?.username || "Account"}</strong>
              <span>{account?.email || account?.subject || "-"}</span>
            </div>
            <Badge variant={account?.status === "suspended" ? "destructive" : "secondary"}>{account?.status || "active"}</Badge>
          </header>
          <details className="inlineDisclosure">
            <summary>Edit profile</summary>
          <form className="accountForm" onSubmit={saveProfile}>
            <label htmlFor="account-email">Email</label>
            <Input id="account-email" value={account?.email || ""} disabled />
            <label htmlFor="account-username">Username</label>
            <Input id="account-username" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} autoComplete="username" />
            <label htmlFor="account-name">Name</label>
            <Input id="account-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} autoComplete="name" />
            <label htmlFor="account-avatar">Avatar URL</label>
            <Input id="account-avatar" value={form.avatarUrl} onChange={(event) => setForm({ ...form, avatarUrl: event.target.value })} inputMode="url" placeholder="https://…" />
            <div className="formActions">
              <Button type="submit" disabled={busy}>Save account</Button>
              <Button type="button" variant="outline" onClick={() => void onSignOut()} disabled={busy}><LogOut size={15} /> Sign out</Button>
            </div>
          </form>
          </details>
        </Card>

        <ManagementDisclosure icon={<Activity size={16} />} title="Access" hint="Identity and effective roles">
          <dl className="accountFacts">
            <div><dt>Provider</dt><dd>{account?.provider || initialSession?.auth || "-"}</dd></div>
            <div><dt>Login type</dt><dd>{account?.loginType || "-"}</dd></div>
            <div><dt>Subject</dt><dd className="monoValue">{account?.subject || "-"}</dd></div>
            <div><dt>Last seen</dt><dd>{formatDateTime(account?.lastSeenAt)}</dd></div>
          </dl>
          <div className="roleList" aria-label="Effective roles">
            {(account?.roles || []).map((role) => <Badge key={role} variant="secondary">{role}</Badge>)}
            {!account?.roles?.length ? <span className="mutedText">No application roles</span> : null}
          </div>
        </ManagementDisclosure>
      </div>

      <ManagementDisclosure icon={<Monitor size={16} />} title="Sessions" hint={`${sessions.length} signed-in ${sessions.length === 1 ? "device" : "devices"}`}>
          <div className="disclosureToolbar">
          <Button variant="outline" size="sm" onClick={() => void revokeOtherSessions()} disabled={busy || sessions.every((item) => item.current)}>
            Revoke other sessions
          </Button>
          </div>
        <div className="sessionList">
          {sessions.map((item) => (
            <div className="sessionRow" key={item.id}>
              <span className="sessionIcon"><Monitor size={17} /></span>
              <div>
                <strong>{browserLabel(item.userAgent)} {item.current ? <Badge variant="success">Current</Badge> : null}</strong>
                <span>{item.ip || "Unknown address"} · Last used {formatRelativeTime(item.lastSeenAt)}</span>
              </div>
              <span className="sessionExpiry">Expires {formatDateTime(item.expiresAt)}</span>
              {item.current ? (
                <Button variant="ghost" size="sm" onClick={() => void onSignOut()} disabled={busy}>Sign out</Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => void revokeSession(item.id)} disabled={busy}>Revoke</Button>
              )}
            </div>
          ))}
          {!sessions.length ? <div className="sectionEmpty">No active browser sessions.</div> : null}
        </div>
      </ManagementDisclosure>

      {canManageUsers ? (
        <ManagementDisclosure icon={<UserRound size={16} />} title="Users" hint={`${users.length} ${users.length === 1 ? "account" : "accounts"}`}>
          <div className="userAdminList">
            {users.map((user) => (
              <ManagedUserRow key={user.subject} user={user} current={user.subject === account?.subject} busy={busy} onUpdate={updateUser} />
            ))}
            {!users.length ? <div className="sectionEmpty">No accounts have signed in yet.</div> : null}
          </div>
        </ManagementDisclosure>
      ) : null}
    </div>
  );
}

function ManagedUserRow({
  user,
  current,
  busy,
  onUpdate
}: {
  user: AccountUser;
  current: boolean;
  busy: boolean;
  onUpdate: (subject: string, input: { roles?: string[]; status?: string }) => Promise<void>;
}) {
  const [role, setRole] = React.useState(user.assignedRoles?.[0] || "");
  React.useEffect(() => setRole(user.assignedRoles?.[0] || ""), [user.assignedRoles]);
  return (
    <div className="userAdminRow">
      <div className="userIdentity">
        <span className="accountAvatar small">{user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <UserRound size={17} />}</span>
        <span><strong>{user.username}</strong><small>{user.email || user.subject}</small></span>
      </div>
      <div className="effectiveRoles">
        {user.roles.map((item) => <Badge key={item} variant="secondary">{item}</Badge>)}
      </div>
      <select aria-label={`Local role for ${user.username}`} value={role} onChange={(event) => setRole(event.target.value)} disabled={busy}>
        <option value="">No local role</option>
        <option value="viewer">Viewer</option>
        <option value="operator">Operator</option>
        <option value="admin">Admin</option>
      </select>
      <Button variant="outline" size="sm" onClick={() => void onUpdate(user.subject, { roles: role ? [role] : [] })} disabled={busy || role === (user.assignedRoles?.[0] || "")}>Save role</Button>
      <Button
        variant={user.status === "suspended" ? "outline" : "destructive"}
        size="sm"
        onClick={() => void onUpdate(user.subject, { status: user.status === "suspended" ? "active" : "suspended" })}
        disabled={busy || current}
        title={current ? "You cannot suspend your own account" : undefined}
      >
        {user.status === "suspended" ? <CheckCircle2 size={14} /> : <Ban size={14} />}
        {user.status === "suspended" ? "Activate" : "Suspend"}
      </Button>
    </div>
  );
}

export function TerraformWorkspace({ worlds, apiClient }: { worlds: WorldSummary[]; apiClient: ApiClient }) {
  const [overview, setOverview] = React.useState<TerraformOverview | null>(null);
  const [selectedWorldId, setSelectedWorldId] = React.useState(worlds[0]?.id || "");
  const [preview, setPreview] = React.useState<TerraformPreview | null>(null);
  const [previewFile, setPreviewFile] = React.useState("main.tf");
  const [selectedRunId, setSelectedRunId] = React.useState("");
  const [confirmation, setConfirmation] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const worldKey = worlds.map((world) => world.id).join(",");

  React.useEffect(() => {
    if (selectedWorldId && worlds.some((world) => world.id === selectedWorldId)) return;
    setSelectedWorldId(worlds[0]?.id || "");
  }, [worldKey, selectedWorldId, worlds]);

  React.useEffect(() => {
    let canceled = false;
    async function refresh() {
      try {
        const next = await apiClient<TerraformOverview>("/api/terraform");
        if (!canceled) setOverview(next);
      } catch (error) {
        if (!canceled) setMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      canceled = true;
      window.clearInterval(timer);
    };
  }, [apiClient, worldKey]);

  React.useEffect(() => {
    let canceled = false;
    if (!selectedWorldId) {
      setPreview(null);
      return;
    }
    apiClient<TerraformPreview>(`/api/terraform/projects/${encodeURIComponent(selectedWorldId)}`)
      .then((next) => { if (!canceled) setPreview(next); })
      .catch((error) => { if (!canceled) setMessage(`Error: ${error.message}`); });
    return () => { canceled = true; };
  }, [apiClient, selectedWorldId]);

  const selectedWorld = worlds.find((world) => world.id === selectedWorldId) || null;
  const project = overview?.projects.find((item) => item.worldId === selectedWorldId) || null;
  const activeRun = overview?.runs.find((run) => run.worldId === selectedWorldId && ["queued", "running", "canceling"].includes(run.status)) || null;
  const selectedRun = overview?.runs.find((run) => run.id === selectedRunId)
    || overview?.runs.find((run) => run.worldId === selectedWorldId)
    || null;
  const terraformReady = Boolean(overview?.terraform.installed);

  async function refreshOverview() {
    setOverview(await apiClient<TerraformOverview>("/api/terraform"));
  }

  async function prepare() {
    if (!selectedWorldId) return;
    setBusy(true);
    setMessage("");
    try {
      await apiClient(`/api/terraform/projects/${encodeURIComponent(selectedWorldId)}/prepare`, { method: "POST" });
      await refreshOverview();
      setMessage("Terraform files prepared");
    } catch (error) {
      setMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function startRun(action: TerraformRun["action"]) {
    if (!selectedWorldId) return;
    setBusy(true);
    setMessage("");
    try {
      const run = await apiClient<TerraformRun>(`/api/terraform/projects/${encodeURIComponent(selectedWorldId)}/runs`, {
        method: "POST",
        body: { action, confirmation }
      });
      setSelectedRunId(run.id);
      setMessage(`${terraformActionLabel(action)} started`);
      await refreshOverview();
    } catch (error) {
      setMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function cancelRun() {
    if (!selectedRun) return;
    setBusy(true);
    try {
      await apiClient(`/api/terraform/runs/${encodeURIComponent(selectedRun.id)}/cancel`, { method: "POST" });
      await refreshOverview();
    } catch (error) {
      setMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="terraformWorkspace">
      <section className="settingsPageIntro terraformIntro">
        <div>
          <h1>Terraform</h1>
          <p>Each sandbox has an isolated working directory with retained state, plan, dependency lock, and run logs.</p>
        </div>
        <div className="terraformRuntime">
          <Badge variant={terraformReady ? "success" : "destructive"}>{terraformReady ? `Terraform ${overview?.terraform.version || "ready"}` : "Terraform unavailable"}</Badge>
          <span>{overview?.terraform.platform || overview?.terraform.error || "Checking runtime…"}</span>
        </div>
      </section>

      {message ? <div className="settingsNotice" role="status">{message}</div> : null}

      <Card className="terraformControlCard">
        <div className="terraformSelection">
          <div>
            <label htmlFor="terraform-world">Sandbox</label>
            <select id="terraform-world" value={selectedWorldId} onChange={(event) => { setSelectedWorldId(event.target.value); setSelectedRunId(""); setConfirmation(""); }}>
              {worlds.map((world) => <option value={world.id} key={world.id}>{world.name}</option>)}
            </select>
          </div>
          <dl>
            <div><dt>State</dt><dd>{project?.statePresent ? "Stored" : "Not created"}</dd></div>
            <div><dt>Lock file</dt><dd>{project?.lockPresent ? "Stored" : "Not created"}</dd></div>
            <div><dt>Saved plan</dt><dd>{project?.plan ? `${project.plan.kind}${project.plan.hasChanges ? " · changes" : " · no changes"}` : "None"}</dd></div>
          </dl>
        </div>
        {!worlds.length ? <div className="sectionEmpty">Create a sandbox before preparing a Terraform project.</div> : (
          <div className="terraformActions">
            <Button variant="outline" onClick={() => void prepare()} disabled={busy || Boolean(activeRun)}><FileCode2 size={15} /> Prepare</Button>
            <Button variant="outline" onClick={() => void startRun("validate")} disabled={busy || !terraformReady || Boolean(activeRun)}><CheckCircle2 size={15} /> Validate</Button>
            <Button onClick={() => void startRun("plan")} disabled={busy || !terraformReady || Boolean(activeRun)}>Plan</Button>
            <Button onClick={() => void startRun("apply")} disabled={busy || !terraformReady || Boolean(activeRun) || project?.plan?.kind !== "apply"}>Apply saved plan</Button>
            {activeRun ? <Button variant="outline" onClick={() => void cancelRun()} disabled={busy}><Square size={13} /> Cancel</Button> : null}
          </div>
        )}
      </Card>

      <ManagementDisclosure icon={<FileCode2 size={16} />} title="Source and runs" hint="Generated files and execution history">
      <div className="terraformMainGrid">
        <Card className="terraformSourceCard">
          <header>
            <div className="fileTabs" role="tablist" aria-label="Terraform source files">
              {Object.keys(preview?.files || { "main.tf": "", "sandbox.yaml": "" }).map((file) => (
                <button className={previewFile === file ? "active" : ""} onClick={() => setPreviewFile(file)} type="button" role="tab" aria-selected={previewFile === file} key={file}>{file}</button>
              ))}
            </div>
            <Button variant="ghost" size="sm" onClick={() => preview && downloadTextFile(previewFile, preview.files[previewFile] || "")} disabled={!preview}>
              <FileCode2 size={14} /> Download
            </Button>
          </header>
          <pre className="terraformSource"><code>{preview?.files[previewFile] || "Select a sandbox to preview its Terraform source."}</code></pre>
        </Card>

        <Card className="terraformRunsCard">
          <header className="settingsCardHeading">
            <div><strong>Runs</strong><span>init, validate, plan, and apply stages</span></div>
          </header>
          <div className="terraformRunList">
            {(overview?.runs || []).filter((run) => !selectedWorldId || run.worldId === selectedWorldId).map((run) => (
              <button className={`terraformRunItem ${selectedRun?.id === run.id ? "selected" : ""}`} onClick={() => setSelectedRunId(run.id)} type="button" key={run.id}>
                <span className={`runState ${run.status}`}>{run.status === "succeeded" ? <CheckCircle2 size={14} /> : run.status === "failed" ? <X size={14} /> : <Activity size={14} />}</span>
                <span><strong>{terraformActionLabel(run.action)}</strong><small>{run.stage} · {formatRelativeTime(run.createdAt)}</small></span>
                <Badge variant={run.status === "succeeded" ? "success" : run.status === "failed" ? "destructive" : "secondary"}>{run.status}</Badge>
              </button>
            ))}
            {!overview?.runs.some((run) => !selectedWorldId || run.worldId === selectedWorldId) ? <div className="sectionEmpty">No Terraform runs for this sandbox.</div> : null}
          </div>
        </Card>
      </div>
      </ManagementDisclosure>

      <ManagementDisclosure icon={<Activity size={16} />} title="Run log" hint={selectedRun ? `${terraformActionLabel(selectedRun.action)} · ${selectedRun.status}` : "No run selected"}>
      <Card className="terraformLogCard">
        <header className="settingsCardHeading splitHeading">
          <div>
            <strong>{selectedRun ? `${terraformActionLabel(selectedRun.action)} log` : "Run log"}</strong>
            <span>{selectedRun ? `${selectedRun.status} · ${selectedRun.stage} · ${selectedRun.id}` : "Select a run to inspect its output."}</span>
          </div>
          {selectedRun && ["queued", "running", "canceling"].includes(selectedRun.status) ? <Badge variant="warning">Running</Badge> : null}
        </header>
        <pre>{selectedRun?.log || "No run selected."}</pre>
      </Card>
      </ManagementDisclosure>

      <ManagementDisclosure icon={<Ban size={16} />} title="Destroy" hint="Plan and remove this sandbox" danger>
      <Card className="terraformDangerCard">
        <div>
          <strong>Destroy through Terraform</strong>
          <span>Create and review a destroy plan first. Applying it requires the exact sandbox name.</span>
        </div>
        <Button variant="outline" onClick={() => void startRun("destroy-plan")} disabled={busy || !terraformReady || Boolean(activeRun) || !selectedWorld}>Destroy plan</Button>
        <Input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={selectedWorld?.name || "sandbox name"} aria-label="Destroy confirmation" />
        <Button variant="destructive" onClick={() => void startRun("destroy")} disabled={busy || !terraformReady || Boolean(activeRun) || project?.plan?.kind !== "destroy" || confirmation !== selectedWorld?.name}>Apply destroy plan</Button>
      </Card>
      </ManagementDisclosure>
    </div>
  );
}

function terraformActionLabel(action: TerraformRun["action"]) {
  if (action === "destroy-plan") return "Destroy plan";
  return action.charAt(0).toUpperCase() + action.slice(1);
}

function downloadTextFile(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function browserLabel(userAgent?: string | null) {
  const value = userAgent || "";
  const browser = value.includes("Edg/") ? "Edge" : value.includes("Firefox/") ? "Firefox" : value.includes("Chrome/") ? "Chrome" : value.includes("Safari/") ? "Safari" : "Browser";
  const os = value.includes("Windows") ? "Windows" : value.includes("Mac OS") ? "macOS" : value.includes("Android") ? "Android" : value.includes("iPhone") || value.includes("iPad") ? "iOS" : value.includes("Linux") ? "Linux" : "Unknown OS";
  return `${browser} on ${os}`;
}

function formatRelativeTime(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "unknown";
  const seconds = Math.round((Date.parse(value) - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function formatDateTime(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "-";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
