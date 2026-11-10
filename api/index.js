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


function getEncryptionKey() {
  const raw = process.env.GITHUB_TOKEN_ENCRYPTION_KEY || "";
  let key;
  try { key = Buffer.from(raw, "base64"); } catch { key = Buffer.alloc(0); }
  if (key.length !== 32) {
    throw new Error("GITHUB_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

function encryptGitHubToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    encrypted: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64")
  };
}

function decryptGitHubToken(row) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(row.token_iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(row.token_tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(row.encrypted_access_token, "base64")),
    decipher.final()
  ]).toString("utf8");
}

function getProviderEncryptionKey() {
  const raw = process.env.PROVIDER_TOKEN_ENCRYPTION_KEY || process.env.GITHUB_TOKEN_ENCRYPTION_KEY || "";
  let key;
  try { key = Buffer.from(raw, "base64"); } catch { key = Buffer.alloc(0); }
  if (key.length !== 32) throw new Error("PROVIDER_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return key;
}

function encryptProviderToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getProviderEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return { encrypted: encrypted.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function decryptProviderToken(row) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", getProviderEncryptionKey(), Buffer.from(row.token_iv, "base64"));
  decipher.setAuthTag(Buffer.from(row.token_tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(row.encrypted_access_token, "base64")), decipher.final()]).toString("utf8");
}

async function providerRequest(provider, path, token, options = {}) {
  const base = provider === "vercel" ? "https://api.vercel.com" : "https://api.cloudflare.com/client/v4";
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
      ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  const ok = provider === "cloudflare" ? response.ok && data.success !== false : response.ok;
  if (!ok) {
    const message = provider === "cloudflare"
      ? (data.errors || []).map(x => x.message).join("; ") || `Cloudflare API error (${response.status})`
      : data.error?.message || data.message || `Vercel API error (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return provider === "cloudflare" ? data.result : data;
}

function safeProviderProjectName(name, projectId) {
  const base = String(name || "project").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 35) || "project";
  return `${base}-${String(projectId).replace(/-/g, "").slice(0, 6)}`.slice(0, 58);
}

function parseGitHubRepo(url) {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parsed.hostname !== "github.com" || parts.length < 2) throw new Error("Connect a GitHub repository before deploying.");
  return { owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
}

async function githubApi(path, accessToken, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "DevNexa-Cloud",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.message || `GitHub API request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

function redirectToApp(res, status) {
  const callback = process.env.GITHUB_CALLBACK_URL;
  const origin = callback ? new URL(callback).origin : "";
  if (!origin) return send(res, 500, { error: "GITHUB_CALLBACK_URL is not configured" });
  const target = new URL("/", origin);
  target.searchParams.set("github", status);
  res.statusCode = 302;
  res.setHeader("Location", target.toString());
  res.setHeader("Cache-Control", "no-store");
  res.end();
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


    // GitHub OAuth callback: state is one-time, short-lived, and bound to the initiating DevNexa user.
    if (method === "GET" && path === "/api/github/callback") {
      const url = new URL(req.url, "https://devnexa.local");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const oauthError = url.searchParams.get("error");
      if (oauthError) return redirectToApp(res, "error");
      if (!code || !state || state.length > 200) return redirectToApp(res, "error");

      const stateHash = hashToken(state);
      const states = await sql`
        DELETE FROM github_oauth_states
        WHERE state_hash = ${stateHash} AND expires_at > NOW()
        RETURNING user_id
      `;
      if (!states.length) return redirectToApp(res, "error");

      const clientId = process.env.GITHUB_CLIENT_ID;
      const clientSecret = process.env.GITHUB_CLIENT_SECRET;
      const callbackUrl = process.env.GITHUB_CALLBACK_URL;
      if (!clientId || !clientSecret || !callbackUrl) {
        console.error("GitHub OAuth environment variables are incomplete");
        return redirectToApp(res, "error");
      }

      const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "User-Agent": "DevNexa-Cloud"
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: callbackUrl
        })
      });
      const tokenData = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok || !tokenData.access_token) {
        console.error("GitHub OAuth token exchange failed:", tokenData.error || tokenResponse.status);
        return redirectToApp(res, "error");
      }

      const ghUser = await githubApi("/user", tokenData.access_token);
      const encrypted = encryptGitHubToken(tokenData.access_token);
      await sql`
        INSERT INTO github_connections
          (user_id, github_user_id, github_login, avatar_url,
           encrypted_access_token, token_iv, token_tag, scopes, updated_at)
        VALUES
          (${states[0].user_id}, ${String(ghUser.id)}, ${ghUser.login}, ${ghUser.avatar_url || null},
           ${encrypted.encrypted}, ${encrypted.iv}, ${encrypted.tag},
           ${tokenData.scope || ""}, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          github_user_id = EXCLUDED.github_user_id,
          github_login = EXCLUDED.github_login,
          avatar_url = EXCLUDED.avatar_url,
          encrypted_access_token = EXCLUDED.encrypted_access_token,
          token_iv = EXCLUDED.token_iv,
          token_tag = EXCLUDED.token_tag,
          scopes = EXCLUDED.scopes,
          updated_at = NOW()
      `;
      await audit(states[0].user_id, "github.connected", "github_account", String(ghUser.id));
      return redirectToApp(res, "connected");
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


    if (method === "GET" && path === "/api/github/status") {
      const rows = await sql`
        SELECT github_login, github_user_id, avatar_url, scopes, created_at, updated_at
        FROM github_connections WHERE user_id = ${user.id} LIMIT 1
      `;
      return send(res, 200, { connected: Boolean(rows.length), account: rows[0] || null });
    }

    if (method === "GET" && path === "/api/github/connect") {
      const clientId = process.env.GITHUB_CLIENT_ID;
      const callbackUrl = process.env.GITHUB_CALLBACK_URL;
      if (!clientId || !callbackUrl || !process.env.GITHUB_CLIENT_SECRET || !process.env.GITHUB_TOKEN_ENCRYPTION_KEY) {
        return send(res, 503, { error: "GitHub integration is not configured by the platform administrator yet." });
      }
      const state = crypto.randomBytes(32).toString("base64url");
      await sql`
        INSERT INTO github_oauth_states (user_id, state_hash, expires_at)
        VALUES (${user.id}, ${hashToken(state)}, ${new Date(Date.now() + 10 * 60 * 1000).toISOString()})
      `;
      const authorize = new URL("https://github.com/login/oauth/authorize");
      authorize.searchParams.set("client_id", clientId);
      authorize.searchParams.set("redirect_uri", callbackUrl);
      authorize.searchParams.set("scope", "read:user");
      authorize.searchParams.set("state", state);
      return send(res, 200, { authorize_url: authorize.toString() });
    }

    if (method === "GET" && path === "/api/github/repos") {
      const rows = await sql`
        SELECT encrypted_access_token, token_iv, token_tag
        FROM github_connections WHERE user_id = ${user.id} LIMIT 1
      `;
      if (!rows.length) return send(res, 409, { error: "Connect your GitHub account first." });
      const accessToken = decryptGitHubToken(rows[0]);
      const repos = await githubApi("/user/repos?visibility=public&affiliation=owner%2Ccollaborator%2Corganization_member&per_page=100&sort=updated", accessToken);
      return send(res, 200, {
        repositories: repos.map(repo => ({
          id: repo.id,
          full_name: repo.full_name,
          name: repo.name,
          description: repo.description,
          html_url: repo.html_url,
          default_branch: repo.default_branch,
          private: repo.private,
          updated_at: repo.updated_at
        }))
      });
    }

    if (method === "POST" && path === "/api/github/disconnect") {
      const rows = await sql`
        SELECT github_user_id FROM github_connections WHERE user_id = ${user.id}
      `;
      await sql`DELETE FROM github_connections WHERE user_id = ${user.id}`;
      await audit(user.id, "github.disconnected", "github_account", rows[0] ? String(rows[0].github_user_id) : null);
      return send(res, 200, { ok: true });
    }


    // Multi-provider account connections. Provider API tokens are encrypted at rest.
    if (method === "GET" && path === "/api/providers") {
      const rows = await sql`
        SELECT provider, account_id, account_label, created_at, updated_at
        FROM provider_connections WHERE user_id = ${user.id}
        ORDER BY provider
      `;
      return send(res, 200, { providers: rows });
    }

    if (method === "POST" && path === "/api/providers/connect") {
      const body = await readBody(req);
      const provider = body.provider;
      const accessToken = typeof body.access_token === "string" ? body.access_token.trim() : "";
      const accountId = typeof body.account_id === "string" ? body.account_id.trim() : null;
      if (!["vercel", "cloudflare"].includes(provider)) return send(res, 400, { error: "Choose Vercel or Cloudflare Pages." });
      if (accessToken.length < 12 || accessToken.length > 5000) return send(res, 400, { error: "Enter a valid provider API token." });
      let accountLabel = null;
      if (provider === "vercel") {
        const identity = await providerRequest("vercel", "/v2/user", accessToken);
        accountLabel = identity.user?.username || identity.user?.email || "Vercel account";
      } else {
        if (!accountId || !/^[a-f0-9]{32}$/i.test(accountId)) return send(res, 400, { error: "Cloudflare Account ID must be 32 hexadecimal characters." });
        const verify = await providerRequest("cloudflare", "/user/tokens/verify", accessToken);
        if (verify.status !== "active") return send(res, 400, { error: "Cloudflare API token is not active." });
        accountLabel = `Cloudflare account ${accountId.slice(0, 8)}…`;
      }
      const encrypted = encryptProviderToken(accessToken);
      await sql`
        INSERT INTO provider_connections
          (user_id, provider, account_id, account_label, encrypted_access_token, token_iv, token_tag, updated_at)
        VALUES (${user.id}, ${provider}, ${accountId}, ${accountLabel}, ${encrypted.encrypted}, ${encrypted.iv}, ${encrypted.tag}, NOW())
        ON CONFLICT (user_id, provider) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          account_label = EXCLUDED.account_label,
          encrypted_access_token = EXCLUDED.encrypted_access_token,
          token_iv = EXCLUDED.token_iv,
          token_tag = EXCLUDED.token_tag,
          updated_at = NOW()
      `;
      await audit(user.id, "provider.connected", "provider", provider, { account_label: accountLabel });
      return send(res, 200, { ok: true, provider, account_label: accountLabel });
    }

    if (method === "POST" && path === "/api/providers/disconnect") {
      const body = await readBody(req);
      if (!["vercel", "cloudflare"].includes(body.provider)) return send(res, 400, { error: "Invalid provider." });
      await sql`DELETE FROM provider_connections WHERE user_id = ${user.id} AND provider = ${body.provider}`;
      await audit(user.id, "provider.disconnected", "provider", body.provider);
      return send(res, 200, { ok: true });
    }

    const deployMatch = path.match(/^\/api\/projects\/([0-9a-f-]{36})\/deploy$/i);
    if (method === "POST" && deployMatch) {
      const body = await readBody(req);
      const provider = body.provider;
      if (!["vercel", "cloudflare"].includes(provider)) return send(res, 400, { error: "Choose Vercel or Cloudflare Pages." });
      const projectRows = await sql`
        SELECT id, name, github_repo FROM projects
        WHERE id = ${deployMatch[1]} AND user_id = ${user.id} AND deleted_at IS NULL LIMIT 1
      `;
      if (!projectRows.length) return send(res, 404, { error: "Project not found." });
      if (!projectRows[0].github_repo) return send(res, 400, { error: "Connect a GitHub repository to this project first." });
      const connections = await sql`
        SELECT provider, account_id, encrypted_access_token, token_iv, token_tag
        FROM provider_connections WHERE user_id = ${user.id} AND provider = ${provider} LIMIT 1
      `;
      if (!connections.length) return send(res, 409, { error: `Connect your ${provider === "vercel" ? "Vercel" : "Cloudflare Pages"} account in Profile first.` });
      const connection = connections[0];
      const providerToken = decryptProviderToken(connection);
      const repo = parseGitHubRepo(projectRows[0].github_repo);
      const branch = typeof body.branch === "string" && /^[A-Za-z0-9._/-]{1,120}$/.test(body.branch) ? body.branch : "main";
      const providerProjectName = safeProviderProjectName(projectRows[0].name, projectRows[0].id);
      let externalProjectId = null;
      let externalDeploymentId = null;
      let deploymentUrl = null;
      let metadata = {};

      if (provider === "vercel") {
        // Vercel must already have the GitHub App installed for this repository.
        const ghRows = await sql`SELECT encrypted_access_token, token_iv, token_tag FROM github_connections WHERE user_id = ${user.id} LIMIT 1`;
        if (!ghRows.length) return send(res, 409, { error: "Connect GitHub first." });
        const ghToken = decryptGitHubToken(ghRows[0]);
        const ghRepo = await githubApi(`/repos/${repo.owner}/${repo.repo}`, ghToken);
        const ghCommit = await githubApi(`/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(branch)}`, ghToken);
        const existing = await providerRequest("vercel", `/v9/projects/${encodeURIComponent(providerProjectName)}`, providerToken).catch(e => e.status === 404 ? null : Promise.reject(e));
        const vProject = existing || await providerRequest("vercel", "/v10/projects", providerToken, {
          method: "POST",
          body: JSON.stringify({
            name: providerProjectName,
            framework: null,
            gitRepository: { type: "github", repo: `${repo.owner}/${repo.repo}` }
          })
        });
        externalProjectId = vProject.id || vProject.project?.id || null;
        const created = await providerRequest("vercel", "/v13/deployments", providerToken, {
          method: "POST",
          body: JSON.stringify({
            name: providerProjectName,
            project: externalProjectId || providerProjectName,
            target: "production",
            gitSource: { type: "vercel", repoId: String(ghRepo.id), sha: ghCommit.sha },
            gitMetadata: { remoteUrl: `https://github.com/${repo.owner}/${repo.repo}`, commitRef: branch, commitSha: ghCommit.sha }
          })
        });
        externalDeploymentId = created.id || null;
        deploymentUrl = created.url ? `https://${created.url}` : null;
        metadata = { provider_state: created.readyState || created.status || "QUEUED", repo: `${repo.owner}/${repo.repo}` };
      } else {
        const accountId = connection.account_id;
        const projectPath = `/accounts/${accountId}/pages/projects/${encodeURIComponent(providerProjectName)}`;
        let cfProject = await providerRequest("cloudflare", projectPath, providerToken).catch(e => e.status === 404 ? null : Promise.reject(e));
        if (!cfProject) {
          cfProject = await providerRequest("cloudflare", `/accounts/${accountId}/pages/projects`, providerToken, {
            method: "POST",
            body: JSON.stringify({
              name: providerProjectName,
              production_branch: branch,
              source: { type: "github", config: { owner: repo.owner, repo_name: repo.repo, production_branch: branch, pr_comments_enabled: false, production_deployments_enabled: true, preview_deployment_setting: "all" } },
              build_config: { build_command: null, destination_dir: "dist", root_dir: "" }
            })
          });
        }
        externalProjectId = cfProject.id || cfProject.name || providerProjectName;
        const form = new FormData();
        form.set("branch", branch);
        form.set("commit_dirty", "false");
        const cfDeployment = await providerRequest("cloudflare", `/accounts/${accountId}/pages/projects/${encodeURIComponent(providerProjectName)}/deployments`, providerToken, {
          method: "POST", body: form
        });
        externalDeploymentId = cfDeployment.id || null;
        deploymentUrl = cfDeployment.url || (cfProject.subdomain ? `https://${cfProject.subdomain}.pages.dev` : null);
        metadata = { provider_state: cfDeployment.latest_stage?.status || "queued", repo: `${repo.owner}/${repo.repo}` };
      }

      const statusRaw = String(metadata.provider_state || "queued").toLowerCase();
      const status = ["ready", "success"].includes(statusRaw) ? "ready" : ["error", "failed"].includes(statusRaw) ? "error" : "queued";
      const inserted = await sql`
        INSERT INTO deployments
          (user_id, project_id, provider, provider_project_id, provider_project_name,
           provider_deployment_id, deployment_url, branch, status, provider_metadata)
        VALUES (${user.id}, ${projectRows[0].id}, ${provider}, ${externalProjectId}, ${providerProjectName},
                ${externalDeploymentId}, ${deploymentUrl}, ${branch}, ${status}, ${JSON.stringify(metadata)}::jsonb)
        RETURNING id, provider, provider_project_name, provider_deployment_id, deployment_url, branch, status, created_at
      `;
      await sql`UPDATE projects SET status = ${status === "ready" ? "live" : status === "error" ? "failed" : "deploying"}, updated_at = NOW() WHERE id = ${projectRows[0].id}`;
      await audit(user.id, "deployment.started", "deployment", inserted[0].id, { provider, branch, repo: `${repo.owner}/${repo.repo}` });
      return send(res, 201, { deployment: inserted[0] });
    }

    const deploymentListMatch = path.match(/^\/api\/projects\/([0-9a-f-]{36})\/deployments$/i);
    if (method === "GET" && deploymentListMatch) {
      const owned = await sql`SELECT id FROM projects WHERE id = ${deploymentListMatch[1]} AND user_id = ${user.id} AND deleted_at IS NULL LIMIT 1`;
      if (!owned.length) return send(res, 404, { error: "Project not found." });
      const rows = await sql`
        SELECT id, provider, provider_project_name, provider_deployment_id, deployment_url, branch, status, error_message, created_at, updated_at
        FROM deployments WHERE project_id = ${deploymentListMatch[1]} AND user_id = ${user.id}
        ORDER BY created_at DESC LIMIT 20
      `;
      return send(res, 200, { deployments: rows });
    }

    const refreshDeploymentMatch = path.match(/^\/api\/deployments\/([0-9a-f-]{36})\/refresh$/i);
    if (method === "POST" && refreshDeploymentMatch) {
      const rows = await sql`
        SELECT d.*, pc.account_id, pc.encrypted_access_token, pc.token_iv, pc.token_tag
        FROM deployments d JOIN provider_connections pc
          ON pc.user_id = d.user_id AND pc.provider = d.provider
        WHERE d.id = ${refreshDeploymentMatch[1]} AND d.user_id = ${user.id} LIMIT 1
      `;
      if (!rows.length) return send(res, 404, { error: "Deployment or provider connection not found." });
      const d = rows[0];
      const providerToken = decryptProviderToken(d);
      let external;
      if (d.provider === "vercel") {
        external = await providerRequest("vercel", `/v13/deployments/${encodeURIComponent(d.provider_deployment_id)}`, providerToken);
      } else {
        external = await providerRequest("cloudflare", `/accounts/${d.account_id}/pages/projects/${encodeURIComponent(d.provider_project_name)}/deployments/${encodeURIComponent(d.provider_deployment_id)}`, providerToken);
      }
      const raw = String(external.readyState || external.status || external.latest_stage?.status || "unknown").toLowerCase();
      const status = ["ready", "success"].includes(raw) ? "ready" : ["error", "failed"].includes(raw) ? "error" : ["canceled", "cancelled"].includes(raw) ? "canceled" : ["building", "active", "in_progress"].includes(raw) ? "building" : "queued";
      const urlValue = external.url ? (String(external.url).startsWith("http") ? external.url : `https://${external.url}`) : external.deployment_url || d.deployment_url;
      const updated = await sql`
        UPDATE deployments SET status = ${status}, deployment_url = ${urlValue},
          error_message = ${status === "error" ? (external.errorMessage || external.latest_stage?.name || "Provider build failed") : null},
          provider_metadata = ${JSON.stringify({ provider_state: raw })}::jsonb, updated_at = NOW()
        WHERE id = ${d.id}
        RETURNING id, provider, deployment_url, branch, status, error_message, updated_at
      `;
      await sql`UPDATE projects SET status = ${status === "ready" ? "live" : status === "error" ? "failed" : "deploying"}, updated_at = NOW() WHERE id = ${d.project_id}`;
      return send(res, 200, { deployment: updated[0] });
    }

    const projectDetailMatch = path.match(/^\/api\/projects\/([0-9a-f-]{36})$/i);
    if (method === "GET" && projectDetailMatch) {
      const rows = await sql`
        SELECT id, name, project_type, description, github_repo, status, created_at, updated_at
        FROM projects
        WHERE id = ${projectDetailMatch[1]} AND user_id = ${user.id} AND deleted_at IS NULL
        LIMIT 1
      `;
      if (!rows.length) return send(res, 404, { error: "Project not found" });
      return send(res, 200, { project: rows[0] });
    }

    const connectRepoMatch = path.match(/^\/api\/projects\/([0-9a-f-]{36})\/connect-repo$/i);
    if (method === "POST" && connectRepoMatch) {
      const body = await readBody(req);
      if (typeof body.full_name !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(body.full_name)) {
        return send(res, 400, { error: "Choose a valid repository from your GitHub account." });
      }
      const connectionRows = await sql`
        SELECT encrypted_access_token, token_iv, token_tag
        FROM github_connections WHERE user_id = ${user.id} LIMIT 1
      `;
      if (!connectionRows.length) return send(res, 409, { error: "Connect your GitHub account first." });
      const owned = await sql`
        SELECT id FROM projects
        WHERE id = ${connectRepoMatch[1]} AND user_id = ${user.id} AND deleted_at IS NULL
        LIMIT 1
      `;
      if (!owned.length) return send(res, 404, { error: "Project not found" });
      const accessToken = decryptGitHubToken(connectionRows[0]);
      const repo = await githubApi(`/repos/${body.full_name}`, accessToken);
      if (repo.private) return send(res, 403, { error: "This initial integration supports public repositories only. Private repository access will use a GitHub App with fine-grained permissions." });
      const rows = await sql`
        UPDATE projects
        SET github_repo = ${repo.html_url}, updated_at = NOW()
        WHERE id = ${connectRepoMatch[1]} AND user_id = ${user.id} AND deleted_at IS NULL
        RETURNING id, name, github_repo, updated_at
      `;
      await audit(user.id, "project.github_connected", "project", connectRepoMatch[1], { repository: repo.full_name });
      return send(res, 200, { project: rows[0], repository: repo.full_name, default_branch: repo.default_branch });
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
