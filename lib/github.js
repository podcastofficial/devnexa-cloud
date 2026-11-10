const sql = require("./db");
const { HttpError, send } = require("./http");
const { decryptGitHubToken } = require("./crypto");

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
    const e = new Error(data.message || `GitHub API request failed (${response.status})`);
    e.status = response.status;
    throw e;
  }
  return data;
}

function parseGitHubRepo(url) {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolephoto_url (parsed.hostname !== "github.com" || parts.length < 2) throw new HttpError(400, "Connect a GitHub repository before deploying.");
  return { owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
}

async function getUserGitHubToken(userId) {
  const rows = await sql`SELECT encrypted_access_token, token_iv, token_tag FROM github_connections WHERE user_id = ${userId} LIMIT 1`;
  if (!rows.length) throw new HttpError(409, "Connect your GitHub account first.");
  return decryptGitHubToken(rows[0]);
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

module.exports = { githubApi, parseGitHubRepo, getUserGitHubToken, redirectToApp };
