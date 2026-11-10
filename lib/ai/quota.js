// Indicative launch quotas (PDF §9.1: validate with real cost data before publishing prices).
// Only PLATFORM-mode usage is metered; BYOK usage is logged but unlimited by us (user pays the provider).
const sql = require("../db");
const { HttpError } = require("../http");

const QUOTAS = {
  free:      { dayRequests: 20,  monthTokens: 60000,   maxOutput: 800 },
  developer: { dayRequests: 100, monthTokens: 600000,  maxOutput: 2000 },
  pro:       { dayRequests: 300, monthTokens: 2000000, maxOutput: 4000 }
};
const quotaFor = plan => QUOTAS[plan] || QUOTAS.free;
const MAX_PENDING = 2;

// Tokens counted per row: reserved while pending (max 2 min, so a crashed request can't hold quota forever), actual when finished.
async function getUsage(userId) {
  const r = await sql`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'pending' THEN (CASE WHEN created_at > NOW() - INTERVAL '2 minutes' THEN reserved_tokens ELSE 0 END) ELSE input_tokens + output_tokens END), 0)::int AS month_tokens,
      COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW()))::int AS day_requests,
      COUNT(*) FILTER (WHERE status = 'pending' AND created_at > NOW() - INTERVAL '2 minutes')::int AS pending
    FROM usage_ledger
    WHERE user_id = ${userId} AND mode = 'platform' AND status IN ('pending', 'ok')
      AND created_at >= date_trunc('month', NOW())`;
  return r[0] || { month_tokens: 0, day_requests: 0, pending: 0 };
}

// Atomically reserve quota (advisory lock per user). Returns the ledger id, or throws 429 with the reason.
async function reserve(user, { provider, model, reserved }) {
  const q = quotaFor(user.plan);
  const rows = await sql`
    WITH lock AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtext(${"ai:" + user.id}))),
    u AS (
      SELECT
        COALESCE(SUM(CASE WHEN l.status = 'pending' THEN (CASE WHEN l.created_at > NOW() - INTERVAL '2 minutes' THEN l.reserved_tokens ELSE 0 END) ELSE l.input_tokens + l.output_tokens END), 0) AS month_tokens,
        COUNT(*) FILTER (WHERE l.created_at >= date_trunc('day', NOW())) AS day_requests,
        COUNT(*) FILTER (WHERE l.status = 'pending' AND l.created_at > NOW() - INTERVAL '2 minutes') AS pending
      FROM lock LEFT JOIN usage_ledger l
        ON l.user_id = ${user.id} AND l.mode = 'platform' AND l.status IN ('pending', 'ok')
       AND l.created_at >= date_trunc('month', NOW())
    )
    INSERT INTO usage_ledger (user_id, mode, provider, model, status, reserved_tokens)
    SELECT ${user.id}, 'platform', ${provider}, ${model}, 'pending', ${reserved}
    FROM u
    WHERE u.month_tokens + ${reserved} <= ${q.monthTokens}
      AND u.day_requests < ${q.dayRequests}
      AND u.pending < ${MAX_PENDING}
    RETURNING id`;
  if (rows.length) return rows[0].id;

  const used = await getUsage(user.id);
  if (used.pending >= MAX_PENDING) throw new HttpError(429, "You already have AI requests running. Wait for them to finish.");
  if (used.day_requests >= q.dayRequests) throw new HttpError(429, `Daily free AI limit reached (${q.dayRequests} requests). It resets at 00:00 UTC — or add your own API key to continue.`);
  throw new HttpError(429, `Monthly free AI allowance reached (${q.monthTokens.toLocaleString("en-US")} tokens). Add your own API key (BYOK) or upgrade your plan.`);
}

module.exports = { QUOTAS, quotaFor, getUsage, reserve };
