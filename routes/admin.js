const sql = require("../lib/db");
const { send, HttpError } = require("../lib/http");

module.exports = async function adminRoutes({ res, path, method, user }) {
  if (!path.startsWith("/api/admin/")) return false;
  if (user.role !== "admin") throw new HttpError(403, "Admin access required");
  if (method === "GET" && path === "/api/admin/stats") {
    const rows = await sql`SELECT
      (SELECT COUNT(*)::int FROM users) AS total_users,
      (SELECT COUNT(*)::int FROM users WHERE status = 'active') AS active_users,
      (SELECT COUNT(*)::int FROM projects WHERE deleted_at IS NULL) AS active_projects,
      (SELECT COUNT(*)::int FROM sessions WHERE expires_at > NOW()) AS active_sessions,
      (SELECT COUNT(*)::int FROM deployments) AS total_deployments`;
    return send(res, 200, { stats: rows[0] }), true;
  }
  if (method === "GET" && path === "/api/admin/users") {
    const rows = await sql`SELECT id, telegram_id, username, first_name, role, plan, status, created_at, last_login_at FROM users ORDER BY created_at DESC LIMIT 100`;
    return send(res, 200, { users: rows }), true;
  }
  return false;
};
