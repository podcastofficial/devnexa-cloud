const sql = require("../lib/db");
const { send, readBody, HttpError } = require("../lib/http");
const { encryptProviderToken } = require("../lib/crypto");
const { audit } = require("../lib/auth");
const { rateLimit } = require("../lib/ratelimit");
const P = require("../lib/ai/providers");
const { runChat } = require("../lib/ai/gateway");
const { quotaFor, getUsage } = require("../lib/ai/quota");

module.exports = async function aiRoutes({ req, res, path, method, user }) {
  if (!path.startsWith("/api/ai/")) return false;

  if (method === "GET" && path === "/api/ai/status") {
    const [keys, used] = [
      await sql`SELECT provider, key_last4, updated_at FROM ai_keys WHERE user_id = ${user.id} ORDER BY provider`,
      await getUsage(user.id)
    ];
    const q = quotaFor(user.plan);
    return send(res, 200, {
      platform: { available: P.platformOrder().length > 0, providers: P.platformOrder() },
      byok_providers: P.BYOK_PROVIDERS,
      keys,
      quota: { plan: user.plan, day_requests: { used: used.day_requests, limit: q.dayRequests }, month_tokens: { used: used.month_tokens, limit: q.monthTokens }, max_output_tokens: q.maxOutput }
    }), true;
  }

  if (method === "GET" && path === "/api/ai/usage") {
    const recent = await sql`SELECT created_at, mode, provider, model, status, input_tokens, output_tokens, latency_ms FROM usage_ledger WHERE user_id = ${user.id} ORDER BY created_at DESC LIMIT 20`;
    return send(res, 200, { recent }), true;
  }

  if (method === "POST" && path === "/api/ai/keys") {
    rateLimit(`aikey:${user.id}`, 10, 60_000);
    const body = await readBody(req);
    if (!P.BYOK_PROVIDERS.includes(body.provider)) throw new HttpError(400, "Unsupported AI provider.");
    const key = typeof body.api_key === "string" ? body.api_key.trim() : "";
    if (key.length < 16 || key.length > 400 || /\s/.test(key)) throw new HttpError(400, "Enter a valid API key.");
    try { await P.verifyKey(body.provider, key); }
    catch (e) {
      if (e.status === 401 || e.status === 403) throw new HttpError(400, `${body.provider} rejected this API key.`);
      throw new HttpError(502, `Could not verify the key with ${body.provider} right now. Try again.`);
    }
    const enc = encryptProviderToken(key);
    await sql`
      INSERT INTO ai_keys (user_id, provider, key_last4, encrypted_access_token, token_iv, token_tag, updated_at)
      VALUES (${user.id}, ${body.provider}, ${key.slice(-4)}, ${enc.encrypted}, ${enc.iv}, ${enc.tag}, NOW())
      ON CONFLICT (user_id, provider) DO UPDATE SET key_last4 = EXCLUDED.key_last4, encrypted_access_token = EXCLUDED.encrypted_access_token,
        token_iv = EXCLUDED.token_iv, token_tag = EXCLUDED.token_tag, updated_at = NOW()`;
    await audit(user.id, "ai.key_saved", "ai_key", body.provider);
    return send(res, 200, { ok: true, provider: body.provider, key_last4: key.slice(-4) }), true; // never return the key
  }

  if (method === "POST" && path === "/api/ai/keys/remove") {
    const body = await readBody(req);
    if (!P.BYOK_PROVIDERS.includes(body.provider)) throw new HttpError(400, "Unsupported AI provider.");
    await sql`DELETE FROM ai_keys WHERE user_id = ${user.id} AND provider = ${body.provider}`;
    await audit(user.id, "ai.key_removed", "ai_key", body.provider);
    return send(res, 200, { ok: true }), true;
  }

  if (method === "POST" && path === "/api/ai/chat") {
    rateLimit(`aichat:${user.id}`, 15, 60_000);
    const body = await readBody(req, 64 * 1024);
    return send(res, 200, await runChat(user, body)), true;
  }
  return false;
};
