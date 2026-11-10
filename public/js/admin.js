(() => {
  const tg = window.Telegram?.WebApp;
  const $ = id => document.getElementById(id);
  let token = sessionStorage.getItem("devnexa_session") || "";
  if (tg) { tg.ready(); tg.expand(); }

  async function api(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(path, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }
  function error(message) { $("adminError").textContent = message; $("adminError").hidden = false; }

  async function boot() {
    try {
      if (!token) {
        if (!tg?.initData) throw new Error("Open the admin page from inside Telegram.");
        const login = await api("/api/auth/telegram", { method: "POST", body: JSON.stringify({ initData: tg.initData }) });
        token = login.token;
        sessionStorage.setItem("devnexa_session", token);
      }
      await refresh();
      $("adminLoading").hidden = true;
      $("adminContent").hidden = false;
    } catch (e) { $("adminLoading").hidden = true; error(e.message); }
  }
  async function refresh() {
    const [stats, users] = await Promise.all([api("/api/admin/stats"), api("/api/admin/users")]);
    $("totalUsers").textContent = stats.stats.total_users;
    $("activeUsers").textContent = stats.stats.active_users;
    $("activeProjects").textContent = stats.stats.active_projects;
    $("activeSessions").textContent = stats.stats.active_sessions;
    const tbody = $("usersTable");
    tbody.replaceChildren();
    users.users.forEach(user => {
      const tr = document.createElement("tr");
      [user.first_name || user.username || "Developer", String(user.telegram_id), user.plan, user.status].forEach(value => {
        const td = document.createElement("td"); td.textContent = value; tr.append(td);
      });
      tbody.append(tr);
    });
  }
  $("refreshAdmin").addEventListener("click", () => refresh().catch(e => error(e.message)));
  boot();
})();
