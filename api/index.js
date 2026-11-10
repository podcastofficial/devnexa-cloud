// Thin router. Business logic lives in /routes and /lib.
const sql = require("../lib/db");
const { send, HttpError } = require("../lib/http");
const { authenticate } = require("../lib/auth");
const github = require("../routes/github");

const authedRoutes = [
  github.authed,
  require("../routes/providers"),
  require("../routes/deployments"),
  require("../routes/projects"),
  require("../routes/admin")
];

module.exports = async function handler(req, res) {
  try {
    if (!sql.isConfigured()) return send(res, 500, { error: "DATABASE_URL is not configured" });
    const url = new URL(req.url, "https://devnexa.local");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method || "GET";
    const ctx = { req, res, url, path, method };

    if (method === "GET" && path === "/api/health") {
      await sql`SELECT 1`;
      return send(res, 200, { ok: true, service: "DevNexa Cloud API", phase: 2 });
    }
    if (method === "GET" && path === "/api/github/callback") return void (await github.callback(ctx));
    if (await require("../routes/auth")(ctx)) return;

    const user = await authenticate(req);
    if (!user) return send(res, 401, { error: "Authentication required. Open DevNexa Cloud inside Telegram." });
    ctx.user = user;

    for (const route of authedRoutes) if (await route(ctx)) return;
    return send(res, 404, { error: "Route not found" });
  } catch (error) {
    if (error instanceof HttpError || error.expose) return send(res, error.status || 400, { error: error.message });
    console.error("DevNexa API error:", error.message);
    return send(res, 500, { error: "Internal server error" });
  }
};
