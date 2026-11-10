const crypto = require("node:crypto");
const sql = require("../lib/db");
const { send } = require("../lib/http");
const { hashToken, encryptGitHubToken, decryptGitHubToken } = require("../lib/crypto");
const { githubApi, redirectToApp } = require("../lib/github");
const { audit } = require("../lib/auth");

// Public (no bearer): OAuth callback. State is one-time, short-lived and bound to the initiating user.
async function callback({ req, res, url }) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error") || !code || !state || state.length > 200) return redirectToApp(res, "error"), true;

  const states = await sql`
    DELETE FROM github_oauth_states WHERE state_hash = ${hashToken(state)} AND expires_at > NOW() RETURNING user_id`;
  if (!states.length) return redirectToApp(res, "error"), true;

  const { GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret, GITHUB_CALLBACK_URL: callbackUrl } = process.env;
  if (!clientId || !clientSecret || !callbackUrl) { console.error("GitHub OAuth env incomplete"); return redirectToApp(res, "error"), true; }

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json", "User-Agent": "DevNexa-Cloud" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: callbackUrl })
  });
  const tokenData = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenData.access_token) { console.error("GitHub token exchange failed:", tokenData.error || tokenResponse.status); return redirectToApp(res, "error"), true; }

  const gh = await githubApi("/user", tokenData.access_token);
  const enc = encryptGitHubToken(tokenData.access_token);
  await sql`
    INSERT INTO github_connections (user_id, github_user_id, github_login, avatar_url, encrypted_access_token, token_iv, token_tag, scopes, updated_at)
    VALUES (${states[0].user_id}, ${String(gh.id)}, ${gh.login}, ${gh.avatar_url || null}, ${enc.encrypted}, ${enc.iv}, ${enc.tag}, ${tokenData.scope || ""}, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      github_user_id = EXCLUDED.github_user_id, github_login = EXCLUDED.github_login, avatar_url = EXCLUDED.avatar_url,
      encrypted_access_token = EXCLUDED.encrypted_access_token, token_iv = EXCLUDED.token_iv, token_tag = EXCLUDED.token_tag,
      scopes = EXCLUDED.scopes, updated_at = NOW()`;
  await audit(states[0].user_id, "github.connected", "github_account", String(gh.id));
  return redirectToApp(res, "connected"), true;
}

async function authed({ res, path, method, user }) {
  if (method === "GET" && path === "/api/github/status") {
    const rows = await sql`SELECT github_login, github_user_id, avatar_url, scopes, created_at, updated_at FROM github_connections WHERE user_id = ${user.id} LIMIT 1`;
    return send(res, 200, { connected: Boolean(rows.length), account: rows[0] || null }), true;
  }

  if (method === "GET" && path === "/api/github/connect") {
    const { GITHUB_CLIENT_ID: clientId, GITHUB_CALLBACK_URL: callbackUrl } = process.env;
    if (!clientId || !callbackUrl || !process.env.GITHUB_CLIENT_SECRET || !process.env.GITHUB_TOKEN_ENCRYPTION_KEY) {
      return send(res, 503, { error: "GitHub integration is not configured by the platform administrator yet." }), true;
    }
    const state = crypto.randomBytes(32).toString("base64url");
    await sql`INSERT INTO github_oauth_states (user_id, state_hash, expires_at) VALUES (${user.id}, ${hashToken(state)}, ${new Date(Date.now() + 600000).toISOString()})`;
    const a = new URL("https://github.com/login/oauth/authorize");
    a.searchParams.set("client_id", clientId);
    a.searchParams.set("redirect_uri", callbackUrl);
    a.searchParams.set("scope", "read:user");
    a.searchParams.set("state", state);
    return send(res, 200, { authorize_url: a.toString() }), true;
  }

  if (method === "GET" && path === "/api/github/repos") {
    const rows = await sql`SELECT encrypted_access_token, token_iv, token_tag FROM github_connections WHERE user_id = ${user.id} LIMIT 1`;
    if (!rows.length) return send(res, 409, { error: "Connect your GitHub account first." }), true;
    const repos = await githubApi("/user/repos?visibility=public&affiliation=owner%2Ccollaborator%2Corganization_member&per_page=100&sort=updated", decryptGitHubToken(rows[0]));
    return send(res, 200, {
      repositories: repos.map(r => ({ id: r.id, full_name: r.full_name, name: r.name, description: r.description, html_url: r.html_url, default_branch: r.default_branch, private: r.private, updated_at: r.updated_at }))
    }), true;
  }

  if (method === "POST" && path === "/api/github/disconnect") {
    const rows = await sql`SELECT github_user_id FROM github_connections WHERE user_id = ${user.id}`;
    await sql`DELETE FROM github_connections WHERE user_id = ${user.id}`;
    await audit(user.id, "github.disconnected", "github_account", rows[0] ? String(rows[0].github_user_id) : null);
    return send(res, 200, { ok: true }), true;
  }
  return false;
}

module.exports = { callback, authed };
