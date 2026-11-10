// Thin router. Business logic lives in /routes and /lib.
const sql = require("../lib/db");
const { send, HttpError } = require("../lib/http");
const { authenticate } = require("../lib/auth");
const github = require("../routes/github");

const authedRoutes = [
  github.authed,
  require("../routes/agent"),
  require("../routes/providers"),
  require("../routes/deployments"),
  require("../routes/ai"),
  require("../routes/projects"),
  require("../routes/admin")
];

async function runCleanup() {
  await sql`DELETE FROM sessions WHERE expires_at < NOW()`;
  await sql`DELETE FROM github_oauth_states WHERE expires_at < NOW()`;
  await sql`DELETE FROM rate_limits WHERE window_start < NOW() - INTERVAL '1 hour'`;
}

module.exports = async function handler(req, res) {
  try {
    if (!sql.isConfigured()) return send(res, 500, { error: "DATABASE_URL is not configured" });
    const url = new URL(req.url, "https://devnexa.local");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method || "GET";
    const ctx = { req, res, url, path, method };

    if (method === "GET" && path === "/api/health") {
      await sql`SELECT 1`;
      return send(res, 200, { ok: true, service: "DevNexa Cloud API", phase: 4 });
    }
    
    if (method === "GET" && path === "/api/github/callback") return void (await github.callback(ctx));

    if (method === "GET" && path === "/api/cron/cleanup") {
      const secret = process.env.CRON_SECRET;
      if (!secret) return send(res, 503, { error: "CRON_SECRET not configured" });
      const auth = req.headers["authorization"] || "";
      if (auth !== `Bearer ${secret}`) return send(res, 401, { error: "Unauthorized" });
      await runCleanup();
      return send(res, 200, { ok: true, ran_at: new Date().toISOString() });
    }

    if (await require("../routes/auth")(ctx)) return;

    const user = await authenticate(req);
    if (!user) return send(res, 401, { error: "Authentication required. Open DevNexa Cloud inside Telegram." });
    ctx.user = user;

    for (const route of authedRoutes) if (await route(ctx)) return;
    return send(res, 404, { error: "Route not found" });
  } catch (error) {
    // Yahan error log hoga taaki Vercel par asli error dikhe
    console.error("DevNexa API error:", error.message);
    if (error instanceof HttpError || error.expose) return send(res, error.status || 400, { error: error.message });
    return send(res, 500, { error: "Internal server error: " + error.message });
  }
};