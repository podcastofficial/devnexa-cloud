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
      await loadDeploymentHistory();
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


  async function loadProviderConnections() {
    const data = await api("/api/providers");
    const list = $("providerList");
    list.replaceChildren();
    if (!data.providers.length) {
      const p = document.createElement("p"); p.className = "muted small"; p.textContent = "No hosting providers connected yet."; list.append(p); return;
    }
    data.providers.forEach(item => {
      const row = document.createElement("div"); row.className = "provider-row";
      const providerNames = { vercel: "Vercel", cloudflare: "Cloudflare Pages", netlify: "Netlify" };
      const label = document.createElement("span"); label.textContent = `${providerNames[item.provider] || item.provider} · ${item.account_label || "Connected"}`;
      const btn = document.createElement("button"); btn.className = "text-btn"; btn.type = "button"; btn.textContent = "Disconnect";
      btn.addEventListener("click", async () => {
        if (!confirm(`Disconnect ${item.provider}?`)) return;
        try { await api("/api/providers/disconnect", { method: "POST", body: JSON.stringify({ provider: item.provider }) }); await loadProviderConnections(); showNotice(`${item.provider} disconnected.`); }
        catch (e) { showError(e.message); }
      });
      row.append(label, btn); list.append(row);
    });
  }

  async function loadDeploymentHistory() {
    const box = $("deploymentHistory");
    box.replaceChildren();
    if (!selectedProjectId) return;
    try {
      const data = await api(`/api/projects/${selectedProjectId}/deployments`);
      if (!data.deployments.length) { const p = document.createElement("p"); p.className = "muted small"; p.textContent = "No deployments yet."; box.append(p); return; }
      data.deployments.forEach(d => {
        const row = document.createElement("div"); row.className = "deployment-row";
        const details = document.createElement("div");
        const title = document.createElement("strong"); title.textContent = `${d.provider === "vercel" ? "Vercel" : "Cloudflare Pages"} · ${d.status}`;
        const meta = document.createElement("p"); meta.className = "muted tiny"; meta.textContent = `${d.branch} · ${new Date(d.created_at).toLocaleString()}`;
        details.append(title, meta);
        const actions = document.createElement("div"); actions.className = "deployment-actions";
        if (d.deployment_url) { const link = document.createElement("a"); link.href = d.deployment_url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "Open"; actions.append(link); }
        if (d.status !== "ready" && d.status !== "error" && d.provider_deployment_id) {
          const refresh = document.createElement("button"); refresh.className = "text-btn"; refresh.textContent = "Refresh";
          refresh.addEventListener("click", async () => { refresh.disabled = true; try { await api(`/api/deployments/${d.id}/refresh`, { method: "POST", body: "{}" }); await loadDeploymentHistory(); } catch (e) { showError(e.message); } finally { refresh.disabled = false; } }); actions.append(refresh);
        }
        row.append(details, actions); box.append(row);
      });
    } catch (e) { const p = document.createElement("p"); p.className = "muted small"; p.textContent = e.message; box.append(p); }
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
    try { await loadGitHubStatus(); await loadProviderConnections(); } catch (e) { showError(e.message); }
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


  $("providerChoice").addEventListener("change", () => {
    $("cloudflareAccountWrap").hidden = $("providerChoice").value !== "cloudflare";
  });
  $("saveProviderBtn").addEventListener("click", async () => {
    const button = $("saveProviderBtn");
    const provider = $("providerChoice").value;
    const access_token = $("providerToken").value.trim();
    const account_id = $("cloudflareAccountId").value.trim();
    if (!access_token) return showError("Paste your provider API token first.");
    button.disabled = true; button.textContent = "Verifying…"; clearError();
    try {
      await api("/api/providers/connect", { method: "POST", body: JSON.stringify({ provider, access_token, account_id }) });
      $("providerToken").value = "";
      await loadProviderConnections();
      showNotice(`${({ vercel: "Vercel", cloudflare: "Cloudflare Pages", netlify: "Netlify" })[provider]} account connected securely.`);
    } catch (e) { showError(e.message); }
    finally { button.disabled = false; button.textContent = "Connect provider"; }
  });

  $("deployProjectBtn").addEventListener("click", async () => {
    if (!selectedProjectId) return;
    const button = $("deployProjectBtn");
    button.disabled = true; button.textContent = "Starting deployment…"; clearError();
    try {
      const data = await api(`/api/projects/${selectedProjectId}/deploy`, {
        method: "POST",
        body: JSON.stringify({ provider: $("deployProvider").value, branch: $("deployBranch").value.trim() || "main" })
      });
      await loadDeploymentHistory();
      showNotice(`Deployment request submitted to ${data.deployment.provider}. Check deployment history for status.`);
    } catch (e) { showError(e.message); }
    finally { button.disabled = false; button.textContent = "Deploy project"; }
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