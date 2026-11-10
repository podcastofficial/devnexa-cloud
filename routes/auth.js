const sql = require("../lib/db");
const { send, readBody } = require("../lib/http");
const { verifyTelegramInitData } = require("../lib/telegram");
const { createSession, bearerToken, audit } = require("../lib/auth");
const { hashToken } = require("../lib/crypto");
const { rateLimitStrict } = require("../lib/ratelimit");

module.exports = async function authRoutes({ req, res, path, method }) {
  if (method === "POST" && path === "/api/auth/telegram") {
    const ip = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown";
    await rateLimitStrict(`auth:${ip}`, 20, 60_000);
    const body = await readBody(req);
    const tg = verifyTelegramInitData(body.initData);
    const adminIds = (process.env.ADMIN_TELEGRAM_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
    const role = adminIds.includes(String(tg.id)) ? "admin" : "user";
    const rows = await sql`
      INSERT INTO users (telegram_id, username, first_name, last_name, photo_url, role, last_login_at, updated_at)
      VALUES (${String(tg.id)}, ${tg.username || null}, ${tg.first_name || ""}, ${tg.last_name || null}, ${tg.photo_url || null}, ${role}, NOW(), NOW())
      ON CONFLICT (telegram_id) DO UPDATE SET
        username = EXCLUDED.username, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
        photo_url = EXCLUDED.photo_url, role = EXCLUDED.role, last_login_at = NOW(), updated_at = NOW()
      RETURNING id, telegram_id, username, first_name, last_name, photo_url, role, plan, status`;
    const user = rows[0];
    if (user.status !== "active") return send(res, 403, { error: "Your account is suspended" }), true;
    const token = await createSession(user.id);
    await audit(user.id, "auth.telegram_login");
    return send(res, 200, { token, user }), true;
  }

  if (method === "POST" && path === "/api/auth/logout") {
    const token = bearerToken(req);
    if (token) await sql`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`;
    return send(res, 200, { ok: true }), true;
  }
  return false;
};