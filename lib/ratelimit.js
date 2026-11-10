// Sliding-window rate limiter.
// Strategy: try DB-backed (shared across serverless instances); fall back to
// in-memory per-instance bucket if DATABASE_URL is not configured or DB fails.
const { HttpError } = require("./http");
const sql = require("./db");

const buckets = new Map();
const DB_ENABLED = () => Boolean(process.env.DATABASE_URL);

function memoryLimit(key, max, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter(t => now - t < windowMs);
  if (hits.length >= max) {
    buckets.set(key, hits);
    throw new HttpError(429, "Too many requests. Please wait a moment and try again.");
  }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000) for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > windowMs) buckets.delete(k);
}

async function dbLimit(key, max, windowMs) {
  // Fixed 10s windows granularity keeps the table small while still blocking bursts.
  const windowStart = new Date(Math.floor(Date.now() / 10000) * 10000).toISOString();
  const rows = await sql`
    INSERT INTO rate_limits (key, window_start, hits)
    VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT (key, window_start) DO UPDATE SET hits = rate_limits.hits + 1
    RETURNING hits`;
  const hits = rows[0]?.hits ?? 1;
  if (hits > max) {
    throw new HttpError(429, "Too many requests. Please wait a moment and try again.");
  }
}

// Synchronous signature retained for existing callers; DB path fires in the
// background on a best-effort basis so the in-memory bucket stays the primary gate.
// For callers that must be strictly global, use `rateLimitStrict` (awaited).
function rateLimit(key, max, windowMs) {
  memoryLimit(key, max, windowMs);
  if (DB_ENABLED()) {
    // Fire-and-forget global check; we log but do not throw here to keep API sync.
    dbLimit(key, max * 4, windowMs).catch(err => {
      if (err.status !== 429) console.error("rateLimit db error:", err.message);
    });
  }
}

async function rateLimitStrict(key, max, windowMs) {
  if (DB_ENABLED()) {
    try { await dbLimit(key, max, windowMs); return; }
    catch (err) {
      if (err.status === 429) throw err;
      console.error("rateLimit db fallback:", err.message);
    }
  }
  memoryLimit(key, max, windowMs);
}

rateLimit.reset = () => buckets.clear();

module.exports = { rateLimit, rateLimitStrict };