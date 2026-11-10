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

    const details = document.createElement("button");
    details.className = "secondary detail-btn";
    details.type = "button";
    details.textContent = "Details";
    details.addEventListener("click", () => openProjectDetails(project.id));

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
    actions.append(status, details, del);
    el.append(info, actions);
    return el;
  }

  let selectedProjectId = null;

  async function openProjectDetails(projectId) {
    clearError();
    try {
      const data = await api(`/api/projects/${projectId}`);
      const p = data.project;
      selectedProjectId = p.id;
      $("detailProjectName").textContent = p.name;
      $("detailProjectType").textContent = p.project_type.replaceAll("_", " ");
      $("detailProjectStatus").textContent = p.status;
      $("detailProjectDescription").textContent = p.description || "No description";
      $("detailRepo").textContent = p.github_repo || "Not connected";
      $("projectDetailPanel").hidden = false;
      $("profilePanel").hidden = true;
      await loadGitHubReposIntoSelect();
      $("projectDetailPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      showError(e.message);
    }
  }

  async function loadGitHubStatus() {
    const data = await api("/api/github/status");
    const status = $("githubStatus");
    if (data.connected) {
      status.textContent = `Connected as @${data.account.github_login}`;
      $("githubConnectBtn").textContent = "Reconnect GitHub";
      $("githubDisconnectBtn").hidden = false;
    } else {
      status.textContent = "Not connected";
      $("githubConnectBtn").textContent = "Connect GitHub";
      $("githubDisconnectBtn").hidden = true;
    }
    return data.connected;
  }

  async function loadGitHubReposIntoSelect() {
    const select = $("repoSelect");
    select.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Loading repositories…";
    select.append(placeholder);
    try {
      const connected = await loadGitHubStatus();
      if (!connected) {
        placeholder.textContent = "Connect GitHub from Profile first";
        return;
      }
      const data = await api("/api/github/repos");
      select.replaceChildren();
      if (!data.repositories.length) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No public repositories found";
        select.append(option);
        return;
      }
      const first = document.createElement("option");
      first.value = "";
      first.textContent = "Select a repository";
      select.append(first);
      data.repositories.forEach(repo => {
        const option = document.createElement("option");
        option.value = repo.full_name;
        option.textContent = `${repo.full_name} · ${repo.default_branch || "main"}`;
        select.append(option);
      });
    } catch (e) {
      placeholder.textContent = e.message;
    }
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


  $("profileBtn").addEventListener("click", async () => {
    clearError();
    $("projectDetailPanel").hidden = true;
    $("profilePanel").hidden = false;
    $("profileName").textContent = [currentUser.first_name, currentUser.last_name].filter(Boolean).join(" ") || "Developer";
    $("profileTelegram").textContent = currentUser.username ? `@${currentUser.username}` : "Telegram account";
    $("profileId").textContent = `Telegram ID: ${currentUser.telegram_id}`;
    $("profileAvatar").textContent = (currentUser.first_name || "D").slice(0, 1).toUpperCase();
    try { await loadGitHubStatus(); } catch (e) { showError(e.message); }
    $("profilePanel").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  $("closeProfile").addEventListener("click", () => { $("profilePanel").hidden = true; });
  $("closeDetails").addEventListener("click", () => { $("projectDetailPanel").hidden = true; });

  $("githubConnectBtn").addEventListener("click", async () => {
    clearError();
    const button = $("githubConnectBtn");
    button.disabled = true;
    button.textContent = "Preparing…";
    try {
      const data = await api("/api/github/connect");
      if (tg?.openLink) tg.openLink(data.authorize_url);
      else window.location.href = data.authorize_url;
    } catch (e) {
      showError(e.message);
    } finally {
      button.disabled = false;
      button.textContent = "Connect GitHub";
    }
  });

  $("githubDisconnectBtn").addEventListener("click", async () => {
    if (!confirm("Disconnect your GitHub account from DevNexa Cloud?")) return;
    try {
      await api("/api/github/disconnect", { method: "POST", body: "{}" });
      await loadGitHubStatus();
      await loadGitHubReposIntoSelect();
      showNotice("GitHub account disconnected.");
    } catch (e) { showError(e.message); }
  });

  $("connectRepoBtn").addEventListener("click", async () => {
    if (!selectedProjectId) return;
    const fullName = $("repoSelect").value;
    if (!fullName) { showError("Select a GitHub repository first."); return; }
    const button = $("connectRepoBtn");
    button.disabled = true;
    button.textContent = "Connecting…";
    try {
      const data = await api(`/api/projects/${selectedProjectId}/connect-repo`, {
        method: "POST",
        body: JSON.stringify({ full_name: fullName })
      });
      $("detailRepo").textContent = data.project.github_repo;
      await loadProjects();
      showNotice(`Connected ${data.repository} to this project.`);
    } catch (e) { showError(e.message); }
    finally { button.disabled = false; button.textContent = "Connect selected repository"; }
  });

  const githubResult = new URLSearchParams(location.search).get("github");
  if (githubResult === "connected") {
    history.replaceState({}, "", location.pathname);
    setTimeout(() => {
      showNotice("GitHub account connected. Open Profile to view your account and connect a repository.");
      loadGitHubStatus().catch(() => {});
    }, 500);
  } else if (githubResult === "error") {
    history.replaceState({}, "", location.pathname);
    setTimeout(() => showError("GitHub connection failed or expired. Please try connecting again."), 500);
  }

  $("logoutBtn").addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch {}
    sessionStorage.removeItem("devnexa_session");
    location.reload();
  });

  boot();
})();