const crypto = require("node:crypto");
const { neon } = require("@neondatabase/serverless");

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const SESSION_DAYS = 30;
const FREE_PROJECT_LIMIT = 2;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function getHeader(req, name) {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 32 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function verifyTelegramInitData(initData) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  if (typeof initData !== "string" || !initData || initData.length > 10000) {
    throw new Error("Missing or invalid Telegram initData");
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) throw new Error("Telegram signature is missing");

  params.delete("hash");
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([key, value]) => `${key}=${value}`).join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculatedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (!safeEqual(calculatedHash, receivedHash)) throw new Error("Telegram signature verification failed");

  const authDate = Number(params.get("auth_date"));
  const maxAge = Number(process.env.TELEGRAM_AUTH_MAX_AGE || 86400);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authDate) || authDate > now + 60 || now - authDate > maxAge) {
    throw new Error("Telegram login data has expired. Reopen the Mini App.");
  }

  let user;
  try { user = JSON.parse(params.get("user") || ""); }
  catch { throw new Error("Telegram user data is invalid"); }

  if (!user || !/^\d+$/.test(String(user.id)) || !user.first_name) {
    throw new Error("Telegram user information is incomplete");
  }
  return user;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await sql`
    INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (${userId}, ${tokenHash}, ${expiresAt})
  `;
  return token;
}

async function authenticate(req) {
  const header = getHeader(req, "authorization") || "";
  const match = header.match(/^Bearer ([A-Za-z0-9_-]{30,})$/);
  if (!match) return null;
  const tokenHash = hashToken(match[1]);
  const rows = await sql`
    SELECT u.id, u.telegram_id, u.username, u.first_name, u.last_name,
           u.photo_url, u.role, u.plan, u.status, s.id AS session_id
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${tokenHash}
      AND s.expires_at > NOW()
    LIMIT 1
  `;
  const user = rows[0];
  if (!user || user.status !== "active") return null;
  await sql`UPDATE sessions SET last_used_at = NOW() WHERE id = ${user.session_id}`;
  return user;
}

async function audit(userId, action, targetType = null, targetId = null, metadata = {}) {
  await sql`
    INSERT INTO audit_logs (user_id, action, target_type, target_id, metadata)
    VALUES (${userId}, ${action}, ${targetType}, ${targetId}, ${JSON.stringify(metadata)}::jsonb)
  `;
}

function validProjectName(value) {
  return typeof value === "string" && value.trim().length >= 2 &&
    value.trim().length <= 50 && /^[\p{L}\p{N} _.-]+$/u.test(value.trim());
}

function validGitHubRepo(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 300) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return false;
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length >= 2 && parts.length <= 3 ? url.toString().replace(/\/$/, "") : false;
  } catch { return false; }
}

module.exports = async function handler(req, res) {
  try {
    if (!sql) return send(res, 500, { error: "DATABASE_URL is not configured" });

    const path = new URL(req.url, "https://devnexa.local").pathname.replace(/\/+$/, "") || "/";
    const method = req.method || "GET";

    if (method === "GET" && path === "/api/health") {
      await sql`SELECT 1`;
      return send(res, 200, { ok: true, service: "DevNexa Cloud API", phase: 1 });
    }

    if (method === "POST" && path === "/api/auth/telegram") {
      const body = await readBody(req);
      const tgUser = verifyTelegramInitData(body.initData);
      const adminIds = (process.env.ADMIN_TELEGRAM_IDS || "")
        .split(",").map(x => x.trim()).filter(Boolean);
      const role = adminIds.includes(String(tgUser.id)) ? "admin" : "user";

      const rows = await sql`
        INSERT INTO users
          (telegram_id, username, first_name, last_name, photo_url, role, last_login_at, updated_at)
        VALUES
          (${String(tgUser.id)}, ${tgUser.username || null}, ${tgUser.first_name || ""},
           ${tgUser.last_name || null}, ${tgUser.photo_url || null}, ${role}, NOW(), NOW())
        ON CONFLICT (telegram_id) DO UPDATE SET
          username = EXCLUDED.username,
          first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name,
          photo_url = EXCLUDED.photo_url,
          role = EXCLUDED.role,
          last_login_at = NOW(),
          updated_at = NOW()
        RETURNING id, telegram_id, username, first_name, last_name, photo_url, role, plan, status
      `;
      const user = rows[0];
      if (user.status !== "active") return send(res, 403, { error: "Your account is suspended" });
      const token = await createSession(user.id);
      await audit(user.id, "auth.telegram_login");
      return send(res, 200, { token, user });
    }

    if (method === "POST" && path === "/api/auth/logout") {
      const header = getHeader(req, "authorization") || "";
      const match = header.match(/^Bearer ([A-Za-z0-9_-]{30,})$/);
      if (match) await sql`DELETE FROM sessions WHERE token_hash = ${hashToken(match[1])}`;
      return send(res, 200, { ok: true });
    }

    const user = await authenticate(req);
    if (!user) return send(res, 401, { error: "Authentication required. Open DevNexa Cloud inside Telegram." });

    if (method === "GET" && path === "/api/me") {
      const projectRows = await sql`
        SELECT COUNT(*)::int AS total
        FROM projects WHERE user_id = ${user.id} AND deleted_at IS NULL
      `;
      return send(res, 200, {
        user: {
          id: user.id, telegram_id: String(user.telegram_id),
          username: user.username, first_name: user.first_name,
          last_name: user.last_name, photo_url: user.photo_url,
          role: user.role, plan: user.plan
        },
        usage: { projects: projectRows[0].total, project_limit: user.plan === "free" ? FREE_PROJECT_LIMIT : null }
      });
    }

    if (method === "GET" && path === "/api/projects") {
      const rows = await sql`
        SELECT id, name, project_type, description, github_repo, status, created_at, updated_at
        FROM projects
        WHERE user_id = ${user.id} AND deleted_at IS NULL
        ORDER BY created_at DESC
      `;
      return send(res, 200, { projects: rows });
    }

    if (method === "POST" && path === "/api/projects") {
      const body = await readBody(req);
      if (!validProjectName(body.name)) {
        return send(res, 400, { error: "Project name must be 2–50 characters and use letters, numbers, spaces, dots, underscores or hyphens." });
      }
      const allowedTypes = ["website", "api", "telegram_bot", "node_app", "python_app"];
      const projectType = allowedTypes.includes(body.project_type) ? body.project_type : "website";
      const repo = validGitHubRepo(body.github_repo);
      if (repo === false) return send(res, 400, { error: "Please provide a valid https://github.com/owner/repository URL." });

      const inserted = await sql`
        WITH user_lock AS MATERIALIZED (
          SELECT pg_advisory_xact_lock(hashtext(${user.id}::text))
        )
        INSERT INTO projects (user_id, name, project_type, description, github_repo)
        SELECT ${user.id}, ${body.name.trim()}, ${projectType},
               ${typeof body.description === "string" ? body.description.trim().slice(0, 500) : null},
               ${repo}
        FROM user_lock
        WHERE (
          SELECT COUNT(*) FROM projects
          WHERE user_id = ${user.id} AND deleted_at IS NULL
        ) < ${user.plan === "free" ? FREE_PROJECT_LIMIT : 100}
        RETURNING id, name, project_type, description, github_repo, status, created_at
      `;
      if (!inserted.length) return send(res, 403, { error: "Free plan limit reached. Delete a project or upgrade your plan." });
      await audit(user.id, "project.created", "project", inserted[0].id);
      return send(res, 201, { project: inserted[0] });
    }

    const deleteMatch = path.match(/^\/api\/projects\/([0-9a-f-]{36})$/i);
    if (method === "DELETE" && deleteMatch) {
      const rows = await sql`
        UPDATE projects SET deleted_at = NOW(), updated_at = NOW()
        WHERE id = ${deleteMatch[1]} AND user_id = ${user.id} AND deleted_at IS NULL
        RETURNING id
      `;
      if (!rows.length) return send(res, 404, { error: "Project not found" });
      await audit(user.id, "project.deleted", "project", deleteMatch[1]);
      return send(res, 200, { ok: true });
    }

    if (method === "GET" && path === "/api/admin/stats") {
      if (user.role !== "admin") return send(res, 403, { error: "Admin access required" });
      const rows = await sql`
        SELECT
          (SELECT COUNT(*)::int FROM users) AS total_users,
          (SELECT COUNT(*)::int FROM users WHERE status = 'active') AS active_users,
          (SELECT COUNT(*)::int FROM projects WHERE deleted_at IS NULL) AS active_projects,
          (SELECT COUNT(*)::int FROM sessions WHERE expires_at > NOW()) AS active_sessions
      `;
      return send(res, 200, { stats: rows[0] });
    }

    if (method === "GET" && path === "/api/admin/users") {
      if (user.role !== "admin") return send(res, 403, { error: "Admin access required" });
      const rows = await sql`
        SELECT id, telegram_id, username, first_name, role, plan, status, created_at, last_login_at
        FROM users ORDER BY created_at DESC LIMIT 100
      `;
      return send(res, 200, { users: rows });
    }

    return send(res, 404, { error: "Route not found" });
  } catch (error) {
    console.error("DevNexa API error:", error.message);
    const status = error.message === "Invalid JSON body" ? 400 : 500;
    return send(res, status, { error: status === 400 ? error.message : "Internal server error" });
  }
};
