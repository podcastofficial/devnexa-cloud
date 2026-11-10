const sql = require("../lib/db");
const { send, readBody, HttpError } = require("../lib/http");
const { encryptProviderToken } = require("../lib/crypto");
const { audit } = require("../lib/auth");
const { rateLimit } = require("../lib/ratelimit");
const { toUserError, NAMES } = require("../lib/providers/request");
const { adapters, CONNECTABLE } = require("../lib/providers");

module.exports = async function providerRoutes({ req, res, path, method, user }) {
  if (method === "GET" && path === "/api/providers") {
    const rows = await sql`SELECT provider, account_id, account_label, created_at, updated_at FROM provider_connections WHERE user_id = ${user.id} ORDER BY provider`;
    return send(res, 200, { providers: rows }), true;
  }

  if (method === "POST" && path === "/api/providers/connect") {
    rateLimit(`pconnect:${user.id}`, 10, 60_000);
    const body = await readBody(req);
    const provider = body.provider;
    if (!CONNECTABLE.includes(provider)) throw new HttpError(400, "Choose a supported provider: Vercel, Cloudflare Pages, or Netlify.");
    const token = typeof body.access_token === "string" ? body.access_token.trim() : "";
    if (token.length < 12 || token.length > 5000) throw new HttpError(400, "Enter a valid provider API token.");
    const accountIdInput = typeof body.account_id === "string" ? body.account_id.trim() : null;

    let identity;
    try { identity = await adapters[provider].verify({ token, accountId: accountIdInput }); }
    catch (e) {
      if (e.status === 401 || e.status === 403) throw new HttpError(400, `${NAMES[provider]} rejected this token. Check it is valid and has the needed permissions.`);
      throw toUserError(provider, e);
    }
    const enc = encryptProviderToken(token);
    await sql`
      INSERT INTO provider_connections (user_id, provider, account_id, account_label, encrypted_access_token, token_iv, token_tag, updated_at)
      VALUES (${user.id}, ${provider}, ${identity.accountId}, ${identity.label}, ${enc.encrypted}, ${enc.iv}, ${enc.tag}, NOW())
      ON CONFLICT (user_id, provider) DO UPDATE SET
        account_id = EXCLUDED.account_id, account_label = EXCLUDED.account_label,
        encrypted_access_token = EXCLUDED.encrypted_access_token, token_iv = EXCLUDED.token_iv, token_tag = EXCLUDED.token_tag, updated_at = NOW()`;
    await audit(user.id, "provider.connected", "provider", provider, { account_label: identity.label });
    return send(res, 200, { ok: true, provider, account_label: identity.label }), true;
  }

  if (method === "POST" && path === "/api/providers/disconnect") {
    const body = await readBody(req);
    if (!CONNECTABLE.includes(body.provider)) throw new HttpError(400, "Invalid provider.");
    await sql`DELETE FROM provider_connections WHERE user_id = ${user.id} AND provider = ${body.provider}`;
    await audit(user.id, "provider.disconnected", "provider", body.provider);
    return send(res, 200, { ok: true }), true;
  }
  return false;
};
