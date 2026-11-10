(() => {
  const tg = window.Telegram?.WebApp;
  const $ = id => document.getElementById(id);
  let token = sessionStorage.getItem("devnexa_session") || "";
  let currentUser = null;
  let submittingProject = false;

  if (tg) { tg.ready(); tg.expand(); }

  function showError(message) {
    const box = $("errorBox");
    box.textContent = message;
    box.hidden = false;
    box.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function clearError() { $("errorBox").hidden = true; $("errorBox").textContent = ""; }
  function showNotice(message, kind = "success") {
    const box = $("noticeBox");
    box.className = `flash ${kind}`;
    box.textContent = message;
    box.hidden = false;
  }

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
    el.className = "project-card";
    const info = document.createElement("div");
    info.className = "project-info";
    const title = document.createElement("h3");
    title.textContent = project.name;
    const meta = document.createElement("p");
    meta.textContent = `${project.project_type.replaceAll("_", " ")} · ${new Date(project.created_at).toLocaleDateString()}`;
    info.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "project-actions";
    const status = document.createElement("span");
    status.className = "status-tag";
    status.textContent = project.status;
    const del = document.createElement("button");
    del.className = "delete-btn";
    del.type = "button";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete "${project.name}"?`)) return;
      del.disabled = true;
      del.textContent = "Deleting…";
      clearError();
      try {
        await api(`/api/projects/${project.id}`, { method: "DELETE" });
        await loadProjects();
        showNotice("Project deleted successfully.");
      } catch (e) {
        del.disabled = false;
        del.textContent = "Delete";
        showError(e.message);
      }
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
      empty.className = "empty-state";
      empty.innerHTML = '<span class="empty-icon">⌘</span><strong>No projects yet</strong><span>Create your first project to get started.</span>';
      list.append(empty);
    } else {
      data.projects.forEach(p => list.append(renderProject(p)));
    }
    $("projectCount").textContent = data.projects.length;
    $("projectLimit").textContent = `${data.projects.length} / ${currentUser.plan === "free" ? 2 : "—"} used`;
    $("projectLimitText").textContent = currentUser.plan === "free" ? "Free plan project limit" : "Projects in your workspace";
  }

  async function boot() {
    try {
      if (!token) await login();
      let me;
      try {
        me = await api("/api/me");
      } catch (error) {
        if (error.message.includes("Authentication required")) {
          sessionStorage.removeItem("devnexa_session");
          token = "";
          await login();
          me = await api("/api/me");
        } else {
          throw error;
        }
      }
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

  $("newProjectBtn").addEventListener("click", () => {
    clearError();
    $("createPanel").hidden = false;
    $("projectName").focus();
  });
  $("closeCreate").addEventListener("click", () => {
    $("createPanel").hidden = true;
  });

  $("projectForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (submittingProject) return;
    clearError();
    $("noticeBox").hidden = true;

    const form = event.currentTarget;
    if (!form.reportValidity()) return;

    const payload = Object.fromEntries(new FormData(form).entries());
    const submitButton = $("createProjectBtn");
    submittingProject = true;
    submitButton.disabled = true;
    submitButton.textContent = "Creating project…";
    submitButton.classList.add("is-loading");

    try {
      const result = await api("/api/projects", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      form.reset();
      $("createPanel").hidden = true;
      await loadProjects();
      showNotice(`"${result.project.name}" created successfully.`);
    } catch (e) {
      showError(e.message);
    } finally {
      submittingProject = false;
      submitButton.disabled = false;
      submitButton.textContent = "Create project";
      submitButton.classList.remove("is-loading");
    }
  });

  $("logoutBtn").addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch {}
    sessionStorage.removeItem("devnexa_session");
    location.reload();
  });

  boot();
})();