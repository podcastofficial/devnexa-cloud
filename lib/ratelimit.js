// Simple in-memory sliding-window limiter. NOTE: per serverless instance only —
// it blunts bursts but is not a global limit. Use a shared store (DB/Redis) before public launch.
const { HttpError } = require("./http");
const buckets = new Map();

function rateLimit(key, max, windowMs) {
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
rateLimit.reset = () => buckets.clear();

module.exports = { rateLimit };
