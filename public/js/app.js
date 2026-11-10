(() => {
  const tg = window.Telegram?.WebApp;
  const $ = id => document.getElementById(id);
  let token = sessionStorage.getItem("devnexa_session") || "";
  let currentUser = null;

  if (tg) { tg.ready(); tg.expand(); }

  function showError(message) {
    $("errorBox").textContent = message;
    $("errorBox").hidden = false;
  }
  function clearError() { $("errorBox").hidden = true; $("errorBox").textContent = ""; }

  async function api(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(path, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  async function login() {
    if (!tg?.initData) throw new Error("Please open DevNexa Cloud from its Telegram bot menu button. Browser preview login is disabled for security.");
    const data = await api("/api/auth/telegram", {
      method: "POST",
      body: JSON.stringify({ initData: tg.initData })
    });
    token = data.token;
    sessionStorage.setItem("devnexa_session", token);
    currentUser = data.user;
  }

  function renderProject(project) {
    const el = document.createElement("article");
    el.className = "project";
    const info = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = project.name;
    const meta = document.createElement("p");
    meta.textContent = `${project.project_type.replaceAll("_", " ")} · ${new Date(project.created_at).toLocaleDateString()}`;
    info.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "project-actions";
    const status = document.createElement("span");
    status.className = "tag";
    status.textContent = project.status;
    const del = document.createElement("button");
    del.className = "delete-btn";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete "${project.name}"?`)) return;
      try { await api(`/api/projects/${project.id}`, { method: "DELETE" }); await loadProjects(); }
      catch (e) { showError(e.message); }
    });
    actions.append(status, del);
    el.append(info, actions);
    return el;
  }

  async function loadProjects() {
    const data = await api("/api/projects");
    const list = $("projects");
    list.replaceChildren();
    if (!data.projects.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No projects yet. Create your first project to get started.";
      list.append(empty);
    } else data.projects.forEach(p => list.append(renderProject(p)));
    $("projectCount").textContent = data.projects.length;
    $("projectLimit").textContent = `${data.projects.length} / ${currentUser.plan === "free" ? 2 : "—"} used`;
  }

  async function boot() {
    try {
      if (!token) await login();
      const me = await api("/api/me");
      currentUser = me.user;
      $("welcomeName").textContent = currentUser.first_name || "Developer";
      $("avatar").textContent = (currentUser.first_name || "D").slice(0, 1).toUpperCase();
      $("planName").textContent = currentUser.plan.toUpperCase();
      $("planBadge").textContent = `${currentUser.plan.toUpperCase()} PLAN`;
      await loadProjects();
      $("loading").hidden = true;
      $("app").hidden = false;
    } catch (e) {
      sessionStorage.removeItem("devnexa_session");
      token = "";
      $("loading").hidden = true;
      showError(e.message);
    }
  }

  $("newProjectBtn").addEventListener("click", () => { $("createPanel").hidden = false; });
  $("closeCreate").addEventListener("click", () => { $("createPanel").hidden = true; });
  $("projectForm").addEventListener("submit", async event => {
    event.preventDefault();
    clearError();
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    try {
      await api("/api/projects", { method: "POST", body: JSON.stringify(payload) });
      event.currentTarget.reset();
      $("createPanel").hidden = true;
      await loadProjects();
    } catch (e) { showError(e.message); }
  });
  $("logoutBtn").addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch {}
    sessionStorage.removeItem("devnexa_session");
    location.reload();
  });
  boot();
})();
