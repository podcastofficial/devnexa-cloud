const crypto = require("node:crypto");
const sql = require("./db");
const { hashToken } = require("./crypto");
const { getHeader } = require("./http");

const SESSION_DAYS = 30;
const BEARER = /^Bearer ([A-Za-z0-9_-]{30,})$/;

function bearerToken(req) {
  const m = (getHeader(req, "authorization") || "").match(BEARER);
  return m ? m[1] : null;
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await sql`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (${userId}, ${hashToken(token)}, ${expiresAt})`;
  return token;
}

async function authenticate(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const rows = await sql`
    SELECT u.id, u.telegram_id, u.username, u.first_name, u.last_name,
           u.photo_url, u.role, u.plan, u.status, s.id AS session_id
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${hashToken(token)} AND s.expires_at > NOW()
    LIMIT 1`;
  const user = rows[0];
  if (!user || user.status !== "active") return null;
  await sql`UPDATE sessions SET last_used_at = NOW() WHERE id = ${user.session_id}`;
  return user;
}

async function audit(userId, action, targetType = null, targetId = null, metadata = {}) {
  await sql`
    INSERT INTO audit_logs (user_id, action, target_type, target_id, metadata)
    VALUES (${userId}, ${action}, ${targetType}, ${targetId}, ${JSON.stringify(metadata)}::jsonb)`;
}

module.exports = { bearerToken, createSession, authenticate, audit, SESSION_DAYS };
