const state = {
  worlds: [],
  selected: null,
  token: null
};

const elements = {
  list: document.querySelector("#world-list"),
  details: document.querySelector("#details"),
  status: document.querySelector("#status-line"),
  form: document.querySelector("#create-form"),
  refresh: document.querySelector("#refresh"),
  busy: document.querySelector("#busy"),
  busyText: document.querySelector("#busy-text"),
  authBox: document.querySelector("#auth-box"),
  tokenInput: document.querySelector("#token-input"),
  tokenSave: document.querySelector("#token-save")
};

boot();

function boot() {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token") || localStorage.getItem("kakurizai.token");
  if (token) {
    localStorage.setItem("kakurizai.token", token);
    state.token = token;
    url.searchParams.delete("token");
    history.replaceState(null, "", url);
  }
  elements.form.addEventListener("submit", createWorld);
  elements.refresh.addEventListener("click", loadWorlds);
  elements.tokenSave.addEventListener("click", () => {
    state.token = elements.tokenInput.value.trim();
    localStorage.setItem("kakurizai.token", state.token);
    elements.authBox.hidden = true;
    loadWorlds();
  });
  loadWorlds();
}

async function loadWorlds() {
  try {
    const worlds = await api("/api/worlds");
    state.worlds = worlds;
    state.selected = state.selected || worlds[0]?.id || null;
    elements.status.textContent = `${worlds.length} world${worlds.length === 1 ? "" : "s"}`;
    render();
  } catch (error) {
    if (/401/.test(error.message)) {
      elements.authBox.hidden = false;
      elements.status.textContent = "Authentication required";
      return;
    }
    elements.status.textContent = error.message;
  }
}

async function createWorld(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(elements.form).entries());
  await withBusy("Creating World", async () => {
    const world = await api("/api/worlds", { method: "POST", body: data });
    state.selected = world.id;
    elements.form.reset();
    await loadWorlds();
  });
}

function render() {
  elements.list.replaceChildren(...state.worlds.map((world) => worldButton(world)));
  const selected = state.worlds.find((world) => world.id === state.selected);
  renderDetails(selected);
}

function worldButton(world) {
  const button = document.createElement("button");
  button.className = "world";
  button.type = "button";
  button.setAttribute("aria-selected", String(world.id === state.selected));
  button.addEventListener("click", () => {
    state.selected = world.id;
    render();
  });
  button.innerHTML = `
    <div class="world-title">
      <strong>${escapeHtml(world.name)}</strong>
      <span class="badge ${world.status?.startsWith("pending") ? "warn" : ""}">${escapeHtml(world.status)}</span>
    </div>
    <div class="meta">
      <span>${escapeHtml(world.backend)}</span>
      <span>${escapeHtml(world.sourcePath)}</span>
      <span>${formatBytes(world.diskUsage?.upperBytes || 0)} upper · ${(world.sessions || []).length} sessions</span>
    </div>
  `;
  return button;
}

function renderDetails(world) {
  if (!world) {
    elements.details.innerHTML = '<div class="empty">No world selected</div>';
    return;
  }
  elements.details.innerHTML = `
    <div class="detail-head">
      <div>
        <h2>${escapeHtml(world.name)}</h2>
        <p>${escapeHtml(world.id)}</p>
      </div>
      <span class="badge ${world.status?.startsWith("pending") ? "warn" : ""}">${escapeHtml(world.status)}</span>
    </div>
    <div class="actions">
      <button data-action="file">File</button>
      <button data-action="terminal">Terminal</button>
      <button data-action="vscode">VS Code</button>
      <button data-action="agent">Agent</button>
      <button data-action="apply">Apply</button>
      <button data-action="remove" class="danger">Remove</button>
    </div>
    <div class="grid">
      ${field("Source", world.sourcePath)}
      ${field("Backend", world.backend)}
      ${field("Sandbox", world.sandbox?.id || world.sandbox?.status || "none")}
      ${field("Base", world.sandbox?.baseId || "none")}
      ${field("Upper", world.paths?.upper || "none")}
      ${field("Disk", `${formatBytes(world.diskUsage?.upperBytes || 0)} upper`)}
      ${field("Sessions", String((world.sessions || []).length))}
      ${field("Updated", world.updatedAt)}
    </div>
  `;
  elements.details.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => detailAction(world, button.dataset.action));
  });
}

async function detailAction(world, action) {
  if (["file", "terminal", "vscode", "agent"].includes(action)) {
    return api(`/api/worlds/${encodeURIComponent(world.id)}/open`, {
      method: "POST",
      body: { target: action }
    });
  }
  if (action === "apply") {
    await withBusy("Applying changes", () =>
      api(`/api/worlds/${encodeURIComponent(world.id)}/apply`, { method: "POST", body: {} }).then(loadWorlds)
    );
  }
  if (action === "remove" && confirm(`Remove ${world.name}?`)) {
    await withBusy("Removing World", () =>
      api(`/api/worlds/${encodeURIComponent(world.id)}`, { method: "DELETE" }).then(loadWorlds)
    );
  }
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let body = options.body;
  if (body && typeof body !== "string") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  const response = await fetch(path, { ...options, headers, body });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status}: ${data?.error || response.statusText}`);
  return data;
}

async function withBusy(label, fn) {
  elements.busyText.textContent = label;
  elements.busy.hidden = false;
  try {
    return await fn();
  } finally {
    elements.busy.hidden = true;
  }
}

function field(label, value) {
  return `<div class="field"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "")}</strong></div>`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}
