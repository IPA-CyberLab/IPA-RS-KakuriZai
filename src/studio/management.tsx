import React from "react";
import {
  Pulse as Activity,
  Prohibit as Ban,
  Stack as Boxes,
  CheckCircle as CheckCircle2,
  CaretRight as ChevronRight,
  ArrowSquareOut as ExternalLink,
  FileCode as FileCode2,
  SignOut as LogOut,
  Monitor,
  Plus,
  Rocket,
  FloppyDisk as Save,
  Square,
  UserCircle as UserRound,
  X
} from "@phosphor-icons/react";
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
  worldId?: string | null;
  worldName: string;
  action: "validate" | "plan" | "apply" | "destroy-plan" | "destroy" | "deploy";
  projectKind?: "sandbox" | "template-instance";
  templateId?: string | null;
  templateSlug?: string | null;
  templateVersion?: string | null;
  instanceName?: string | null;
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
  projectKind?: "sandbox" | "template-instance";
  templateId?: string | null;
  templateSlug?: string | null;
  templateVersion?: string | null;
  instanceName?: string | null;
  worldId?: string | null;
  worldName?: string;
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

type TerraformTemplateParameter = {
  name: string;
  type: string;
  description: string;
  required: boolean;
  sensitive: boolean;
  default?: unknown;
  defaultHcl?: string | null;
  sourceFile: string;
};

type TerraformTemplate = {
  id: string;
  slug: string;
  name: string;
  displayName: string;
  description: string;
  activeVersion: string;
  sourceHash: string;
  parameters: TerraformTemplateParameter[];
  versions: Array<{ version: string; createdAt: string; fileCount: number; sizeBytes: number }>;
  createdAt: string;
  updatedAt: string;
};

type TerraformTemplateDetail = TerraformTemplate & {
  files: Record<string, string>;
  sourceFiles: Array<{ path: string; size: number; text: boolean }>;
};

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

export function TerraformWorkspace({
  worlds,
  apiClient,
  onSandboxesChanged
}: {
  worlds: WorldSummary[];
  apiClient: ApiClient;
  onSandboxesChanged?: () => Promise<void>;
}) {
  const [overview, setOverview] = React.useState<TerraformOverview | null>(null);
  const [templates, setTemplates] = React.useState<TerraformTemplate[]>([]);
  const [mode, setMode] = React.useState<"templates" | "sandboxes">("templates");
  const [selectedTemplateId, setSelectedTemplateId] = React.useState("");
  const [templateDetail, setTemplateDetail] = React.useState<TerraformTemplateDetail | null>(null);
  const [templateValues, setTemplateValues] = React.useState<Record<string, unknown>>({});
  const [instanceName, setInstanceName] = React.useState("kakurizai-sandbox");
  const [editor, setEditor] = React.useState<null | { name: string; displayName: string; description: string; mainTf: string }>(null);
  const [selectedWorldId, setSelectedWorldId] = React.useState(worlds[0]?.id || "");
  const [preview, setPreview] = React.useState<TerraformPreview | null>(null);
  const [previewFile, setPreviewFile] = React.useState("main.tf");
  const [selectedRunId, setSelectedRunId] = React.useState("");
  const [deployRunId, setDeployRunId] = React.useState("");
  const [confirmation, setConfirmation] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const worldKey = worlds.map((world) => world.id).join(",");

  React.useEffect(() => {
    if (selectedWorldId && worlds.some((world) => world.id === selectedWorldId)) return;
    setSelectedWorldId(worlds[0]?.id || "");
  }, [worldKey, selectedWorldId, worlds]);

  React.useEffect(() => {
    if (selectedTemplateId && templates.some((template) => template.id === selectedTemplateId)) return;
    setSelectedTemplateId(templates[0]?.id || "");
  }, [selectedTemplateId, templates]);

  React.useEffect(() => {
    let canceled = false;
    async function refresh() {
      try {
        const [nextOverview, nextTemplates] = await Promise.all([
          apiClient<TerraformOverview>("/api/terraform"),
          apiClient<TerraformTemplate[]>("/api/terraform/templates")
        ]);
        if (!canceled) {
          setOverview(nextOverview);
          setTemplates(nextTemplates);
        }
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
    if (!selectedTemplateId) {
      setTemplateDetail(null);
      return;
    }
    apiClient<TerraformTemplateDetail>(`/api/terraform/templates/${encodeURIComponent(selectedTemplateId)}`)
      .then((next) => {
        if (canceled) return;
        setTemplateDetail(next);
        setTemplateValues(Object.fromEntries(next.parameters
          .filter((parameter) => parameter.name !== "name")
          .map((parameter) => [parameter.name, templateInputDefault(parameter)])));
        setPreviewFile("main.tf");
      })
      .catch((error) => { if (!canceled) setMessage(`Error: ${error.message}`); });
    return () => { canceled = true; };
  }, [apiClient, selectedTemplateId]);

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

  React.useEffect(() => {
    if (!deployRunId) return;
    const run = overview?.runs.find((candidate) => candidate.id === deployRunId);
    if (!run || ["queued", "running", "canceling"].includes(run.status)) return;
    setDeployRunId("");
    if (run.status === "succeeded") {
      setMessage(`${run.instanceName || "Sandbox"} is ready`);
      void onSandboxesChanged?.();
    } else {
      setMessage(`Error: ${run.error || `Terraform ${run.status}`}`);
    }
  }, [deployRunId, onSandboxesChanged, overview]);

  const selectedWorld = worlds.find((world) => world.id === selectedWorldId) || null;
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) || null;
  const project = overview?.projects.find((item) => item.projectKind !== "template-instance" && item.worldId === selectedWorldId) || null;
  const activeRun = overview?.runs.find((run) => !run.templateId && run.worldId === selectedWorldId && ["queued", "running", "canceling"].includes(run.status)) || null;
  const activeTemplateRun = overview?.runs.find((run) => run.templateId === selectedTemplateId && ["queued", "running", "canceling"].includes(run.status)) || null;
  const scopedRuns = (overview?.runs || []).filter((run) => mode === "templates"
    ? run.templateId === selectedTemplateId
    : !run.templateId && (!selectedWorldId || run.worldId === selectedWorldId));
  const selectedRun = overview?.runs.find((run) => run.id === selectedRunId) || scopedRuns[0] || null;
  const sourceFiles = mode === "templates" ? templateDetail?.files || {} : preview?.files || {};
  const terraformReady = Boolean(overview?.terraform.installed);

  React.useEffect(() => {
    const names = Object.keys(sourceFiles);
    if (!names.length || names.includes(previewFile)) return;
    setPreviewFile(names.includes("main.tf") ? "main.tf" : names[0]);
  }, [previewFile, sourceFiles]);

  async function refreshOverview() {
    const [nextOverview, nextTemplates] = await Promise.all([
      apiClient<TerraformOverview>("/api/terraform"),
      apiClient<TerraformTemplate[]>("/api/terraform/templates")
    ]);
    setOverview(nextOverview);
    setTemplates(nextTemplates);
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

  async function startRun(action: Exclude<TerraformRun["action"], "deploy">) {
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

  async function openNewTemplate() {
    setBusy(true);
    setMessage("");
    try {
      const starter = await apiClient<{ files: Record<string, string> }>("/api/terraform/templates/starter");
      setEditor({ name: "developer-sandbox", displayName: "Developer sandbox", description: "", mainTf: starter.files["main.tf"] || "" });
    } catch (error) {
      setMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveTemplate(event: React.FormEvent) {
    event.preventDefault();
    if (!editor?.name.trim() || !editor.mainTf.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      const saved = await apiClient<TerraformTemplate>("/api/terraform/templates", {
        method: "POST",
        body: {
          name: editor.name.trim(),
          displayName: editor.displayName.trim() || editor.name.trim(),
          description: editor.description.trim(),
          files: { "main.tf": editor.mainTf }
        }
      });
      setEditor(null);
      setSelectedTemplateId(saved.id);
      await refreshOverview();
      setMessage(`${saved.displayName} ${saved.activeVersion} published`);
    } catch (error) {
      setMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function deployTemplate(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedTemplate || !instanceName.trim()) return;
    const variables = Object.fromEntries((templateDetail?.parameters || [])
      .filter((parameter) => parameter.name !== "name")
      .filter((parameter) => parameter.required || templateValues[parameter.name] !== "")
      .map((parameter) => [parameter.name, templateValues[parameter.name]]));
    setBusy(true);
    setMessage("");
    try {
      const run = await apiClient<TerraformRun>(`/api/terraform/templates/${encodeURIComponent(selectedTemplate.id)}/deployments`, {
        method: "POST",
        body: { name: instanceName.trim(), variables }
      });
      setSelectedRunId(run.id);
      setDeployRunId(run.id);
      setMessage("Terraform deployment started");
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
          <p>Define reusable sandbox templates in HCL, then launch isolated instances from their variables.</p>
        </div>
        <div className="terraformRuntime">
          <Badge variant={terraformReady ? "success" : "destructive"}>{terraformReady ? `Terraform ${overview?.terraform.version || "ready"}` : "Terraform unavailable"}</Badge>
          <span>{overview?.terraform.platform || overview?.terraform.error || "Checking runtime…"}</span>
        </div>
      </section>

      <div className="terraformModeTabs" role="tablist" aria-label="Terraform workspace mode">
        <button className={mode === "templates" ? "active" : ""} onClick={() => { setMode("templates"); setSelectedRunId(""); setPreviewFile("main.tf"); }} role="tab" aria-selected={mode === "templates"} type="button"><Boxes size={15} weight={mode === "templates" ? "fill" : "regular"} /> Templates</button>
        <button className={mode === "sandboxes" ? "active" : ""} onClick={() => { setMode("sandboxes"); setSelectedRunId(""); setPreviewFile("main.tf"); }} role="tab" aria-selected={mode === "sandboxes"} type="button"><Monitor size={15} weight={mode === "sandboxes" ? "fill" : "regular"} /> Existing sandboxes</button>
      </div>

      {message ? <div className="settingsNotice" role="status">{message}</div> : null}

      {mode === "templates" ? (
        <Card className="terraformControlCard templateControlCard">
          {editor ? (
            <form className="templateEditor" onSubmit={saveTemplate}>
              <header className="settingsCardHeading splitHeading">
                <div><strong>New template</strong><span>Standard Terraform variables become launch fields.</span></div>
                <Button variant="ghost" size="sm" type="button" onClick={() => setEditor(null)}>Cancel</Button>
              </header>
              <div className="templateMetadataFields">
                <div><label>Slug</label><Input value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></div>
                <div><label>Display name</label><Input value={editor.displayName} onChange={(event) => setEditor({ ...editor, displayName: event.target.value })} /></div>
              </div>
              <div><label>Description</label><Input value={editor.description} onChange={(event) => setEditor({ ...editor, description: event.target.value })} placeholder="What this sandbox provides" /></div>
              <div><label htmlFor="terraform-template-source">main.tf</label><textarea id="terraform-template-source" className="templateSourceEditor" value={editor.mainTf} onChange={(event) => setEditor({ ...editor, mainTf: event.target.value })} spellCheck={false} /></div>
              <div className="terraformActions"><Button type="submit" disabled={busy || !editor.name.trim() || !editor.mainTf.trim()}><Save size={15} /> Publish template</Button></div>
            </form>
          ) : (
            <>
              <div className="templatePickerRow">
                <div>
                  <label htmlFor="terraform-template">Template</label>
                  <select id="terraform-template" value={selectedTemplateId} onChange={(event) => { setSelectedTemplateId(event.target.value); setSelectedRunId(""); }}>
                    {templates.map((template) => <option value={template.id} key={template.id}>{template.displayName}</option>)}
                  </select>
                </div>
                <Button variant="outline" onClick={() => void openNewTemplate()} disabled={busy}><Plus size={15} /> New template</Button>
              </div>
              {!selectedTemplate ? (
                <div className="templateEmptyState">
                  <Boxes size={22} />
                  <strong>No Terraform templates</strong>
                  <span>Create one here or run <code>agctl templates push NAME --directory .</code>.</span>
                </div>
              ) : (
                <div className="templateLaunchLayout">
                  <div className="templateSummary">
                    <strong>{selectedTemplate.displayName}</strong>
                    <span>{selectedTemplate.description || "Reusable sandbox definition"}</span>
                    <small>{selectedTemplate.slug} · {selectedTemplate.activeVersion} · {selectedTemplate.parameters.length} variables</small>
                  </div>
                  <form className="templateLaunchForm" onSubmit={deployTemplate}>
                    <div>
                      <label htmlFor="template-instance-name">Sandbox name</label>
                      <Input id="template-instance-name" value={instanceName} onChange={(event) => setInstanceName(event.target.value)} />
                    </div>
                    {(templateDetail?.parameters.length || 0) > 1 ? (
                      <details className="templateParameters">
                        <summary>Variables <span>{templateDetail!.parameters.length - 1}</span></summary>
                        <div className="templateParameterGrid">
                          {templateDetail!.parameters.filter((parameter) => parameter.name !== "name").map((parameter) => (
                            <TemplateParameterField
                              key={parameter.name}
                              parameter={parameter}
                              value={templateValues[parameter.name]}
                              onChange={(value) => setTemplateValues((current) => ({ ...current, [parameter.name]: value }))}
                            />
                          ))}
                        </div>
                      </details>
                    ) : null}
                    <Button type="submit" disabled={busy || !terraformReady || Boolean(activeTemplateRun) || !instanceName.trim()}><Rocket size={15} /> {activeTemplateRun ? "Deploying" : "Create sandbox"}</Button>
                    {activeTemplateRun ? <Button variant="outline" type="button" onClick={() => void cancelRun()} disabled={busy}><Square size={13} /> Cancel</Button> : null}
                  </form>
                </div>
              )}
            </>
          )}
        </Card>
      ) : (
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
          {!worlds.length ? <div className="sectionEmpty">No sandbox available.</div> : (
            <div className="terraformActions">
              <Button variant="outline" onClick={() => void prepare()} disabled={busy || Boolean(activeRun)}><FileCode2 size={15} /> Prepare</Button>
              <Button variant="outline" onClick={() => void startRun("validate")} disabled={busy || !terraformReady || Boolean(activeRun)}><CheckCircle2 size={15} /> Validate</Button>
              <Button onClick={() => void startRun("plan")} disabled={busy || !terraformReady || Boolean(activeRun)}>Plan</Button>
              <Button onClick={() => void startRun("apply")} disabled={busy || !terraformReady || Boolean(activeRun) || project?.plan?.kind !== "apply"}>Apply saved plan</Button>
              {activeRun ? <Button variant="outline" onClick={() => void cancelRun()} disabled={busy}><Square size={13} /> Cancel</Button> : null}
            </div>
          )}
        </Card>
      )}

      <ManagementDisclosure icon={<FileCode2 size={16} />} title="Source and runs" hint="Terraform definition and execution history">
        <div className="terraformMainGrid">
          <Card className="terraformSourceCard">
            <header>
              <div className="fileTabs" role="tablist" aria-label="Terraform source files">
                {(Object.keys(sourceFiles).length ? Object.keys(sourceFiles) : ["main.tf"]).map((file) => (
                  <button className={previewFile === file ? "active" : ""} onClick={() => setPreviewFile(file)} type="button" role="tab" aria-selected={previewFile === file} key={file}>{file}</button>
                ))}
              </div>
              <Button variant="ghost" size="sm" onClick={() => downloadTextFile(previewFile, sourceFiles[previewFile] || "")} disabled={!sourceFiles[previewFile]}>
                <FileCode2 size={14} /> Download
              </Button>
            </header>
            <pre className="terraformSource"><code>{sourceFiles[previewFile] || (mode === "templates" ? "Select or create a template." : "Select a sandbox to preview its generated source.")}</code></pre>
          </Card>

          <Card className="terraformRunsCard">
            <header className="settingsCardHeading">
              <div><strong>Runs</strong><span>init, validate, plan, and apply</span></div>
            </header>
            <div className="terraformRunList">
              {scopedRuns.map((run) => (
                <button className={`terraformRunItem ${selectedRun?.id === run.id ? "selected" : ""}`} onClick={() => setSelectedRunId(run.id)} type="button" key={run.id}>
                  <span className={`runState ${run.status}`}>{run.status === "succeeded" ? <CheckCircle2 size={14} /> : run.status === "failed" ? <X size={14} /> : <Activity size={14} />}</span>
                  <span><strong>{run.instanceName || terraformActionLabel(run.action)}</strong><small>{run.stage} · {formatRelativeTime(run.createdAt)}</small></span>
                  <Badge variant={run.status === "succeeded" ? "success" : run.status === "failed" ? "destructive" : "secondary"}>{run.status}</Badge>
                </button>
              ))}
              {!scopedRuns.length ? <div className="sectionEmpty">No Terraform runs yet.</div> : null}
            </div>
          </Card>
        </div>
      </ManagementDisclosure>

      <ManagementDisclosure icon={<Activity size={16} />} title="Run log" hint={selectedRun ? `${terraformActionLabel(selectedRun.action)} · ${selectedRun.status}` : "No run selected"}>
        <Card className="terraformLogCard">
          <header className="settingsCardHeading splitHeading">
            <div>
              <strong>{selectedRun ? `${selectedRun.instanceName || terraformActionLabel(selectedRun.action)} log` : "Run log"}</strong>
              <span>{selectedRun ? `${selectedRun.status} · ${selectedRun.stage} · ${selectedRun.id}` : "Select a run to inspect its output."}</span>
            </div>
            {selectedRun && ["queued", "running", "canceling"].includes(selectedRun.status) ? <Badge variant="warning">Running</Badge> : null}
          </header>
          <pre>{selectedRun?.log || "No run selected."}</pre>
        </Card>
      </ManagementDisclosure>

      {mode === "sandboxes" ? (
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
      ) : null}
    </div>
  );
}

function TemplateParameterField({
  parameter,
  value,
  onChange
}: {
  parameter: TerraformTemplateParameter;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const type = parameter.type.replace(/\s+/g, "");
  if (type === "bool" || type === "boolean") {
    return (
      <label className="templateBooleanField">
        <input type="checkbox" checked={value === true || value === "true"} onChange={(event) => onChange(event.target.checked)} />
        <span><strong>{parameter.name}</strong><small>{parameter.description || parameter.type}</small></span>
      </label>
    );
  }
  const stringValue = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const multiline = parameter.name.includes("script") || stringValue.includes("\n") || /^(?:list|set|map|object|tuple)\(/.test(type);
  return (
    <div className="templateParameterField">
      <label htmlFor={`template-variable-${parameter.name}`}>{parameter.name}{parameter.required ? " *" : ""}</label>
      {multiline ? (
        <textarea id={`template-variable-${parameter.name}`} value={stringValue} onChange={(event) => onChange(event.target.value)} spellCheck={false} />
      ) : (
        <Input id={`template-variable-${parameter.name}`} type={parameter.sensitive ? "password" : type === "number" ? "number" : "text"} value={stringValue} onChange={(event) => onChange(event.target.value)} />
      )}
      <small>{parameter.description || parameter.type}</small>
    </div>
  );
}

function templateInputDefault(parameter: TerraformTemplateParameter) {
  if (parameter.default === undefined) return parameter.type.replace(/\s+/g, "") === "bool" ? false : "";
  if (typeof parameter.default === "string" || typeof parameter.default === "number" || typeof parameter.default === "boolean") return parameter.default;
  return JSON.stringify(parameter.default, null, 2);
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
