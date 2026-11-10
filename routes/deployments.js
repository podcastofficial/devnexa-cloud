const sql = require("../lib/db");
const { send, readBody, getHeader, HttpError } = require("../lib/http");
const { decryptProviderToken } = require("../lib/crypto");
const { audit } = require("../lib/auth");
const { rateLimit } = require("../lib/ratelimit");
const { parseGitHubRepo, getUserGitHubToken } = require("../lib/github");
const { toUserError, safeProviderProjectName, NAMES } = require("../lib/providers/request");
const { normalizeStatus, projectStatusFor } = require("../lib/providers/status");
const { adapters, DEPLOYABLE } = require("../lib/providers");
const { validBranch, validDir, validBuildCommand } = require("../lib/validate");

const UUID = "([0-9a-f-]{36})";

module.exports = async function deploymentRoutes({ req, res, path, method, user }) {
  const deployMatch = path.match(new RegExp(`^/api/projects/${UUID}/deploy$`, "i"));
  if (method === "POST" && deployMatch) {
    rateLimit(`deploy:${user.id}`, 6, 60_000);
    const body = await readBody(req);
    const provider = body.provider;
    if (!DEPLOYABLE.includes(provider)) throw new HttpError(400, "Choose Vercel, Cloudflare Pages or Netlify.");
    const branch = validBranch(body.branch);
    const outputDir = validDir(body.output_dir);
    const buildCommand = validBuildCommand(body.build_command);
    if (outputDir === false) throw new HttpError(400, "Output folder is invalid (example: dist or public).");
    if (buildCommand === false) throw new HttpError(400, "Build command contains unsupported characters.");
    const idemKey = (getHeader(req, "idempotency-key") || "").slice(0, 100);
    if (idemKey && !/^[A-Za-z0-9_-]{8,100}$/.test(idemKey)) throw new HttpError(400, "Invalid Idempotency-Key.");

    const projects = await sql`SELECT id, name, github_repo FROM projects WHERE id = ${deployMatch[1]} AND user_id = ${user.id} AND deleted_at IS NULL LIMIT 1`;
    if (!projects.length) throw new HttpError(404, "Project not found.");
    const project = projects[0];
    if (!project.github_repo) throw new HttpError(400, "Connect a GitHub repository to this project first.");

    // Duplicate protection: same Idempotency-Key, or an identical deploy still in flight.
    const dup = idemKey
      ? await sql`SELECT id, provider, provider_project_name, provider_deployment_id, deployment_url, branch, status, created_at FROM deployments WHERE user_id = ${user.id} AND idempotency_key = ${idemKey} LIMIT 1`
      : await sql`SELECT id, provider, provider_project_name, provider_deployment_id, deployment_url, branch, status, created_at FROM deployments
                  WHERE project_id = ${project.id} AND user_id = ${user.id} AND provider = ${provider} AND branch = ${branch}
                    AND status IN ('queued','building') AND created_at > NOW() - INTERVAL '2 minutes' ORDER BY created_at DESC LIMIT 1`;
    if (dup.length) return send(res, 200, { deployment: dup[0], duplicate: true }), true;

    const conns = await sql`SELECT provider, account_id, encrypted_access_token, token_iv, token_tag FROM provider_connections WHERE user_id = ${user.id} AND provider = ${provider} LIMIT 1`;
    if (!conns.length) throw new HttpError(409, `Connect your ${NAMES[provider]} account in Profile first.`);
    const connection = conns[0];
    const token = decryptProviderToken(connection);
    const repo = parseGitHubRepo(project.github_repo);
    const githubToken = provider === "cloudflare" ? null : await getUserGitHubToken(user.id);
    const providerProjectName = safeProviderProjectName(project.name, project.id);

    let result;
    try {
      result = await adapters[provider].deploy({
        token, connection, githubToken, repo, branch, providerProjectName,
        options: { outputDir, buildCommand }
      });
    } catch (e) { throw toUserError(provider, e); }

    const status = normalizeStatus(result.rawState);
    const metadata = { provider_state: String(result.rawState), repo: `${repo.owner}/${repo.repo}`, ...(result.extra || {}) };
    const inserted = await sql`
      INSERT INTO deployments (user_id, project_id, provider, provider_project_id, provider_project_name, provider_deployment_id, deployment_url, branch, status, provider_metadata, idempotency_key)
      VALUES (${user.id}, ${project.id}, ${provider}, ${result.externalProjectId}, ${providerProjectName}, ${result.externalDeploymentId}, ${result.deploymentUrl}, ${branch}, ${status}, ${JSON.stringify(metadata)}::jsonb, ${idemKey || null})
      RETURNING id, provider, provider_project_name, provider_deployment_id, deployment_url, branch, status, created_at`;
    await sql`UPDATE projects SET status = ${projectStatusFor(status)}, updated_at = NOW() WHERE id = ${project.id}`;
    await audit(user.id, "deployment.started", "deployment", inserted[0].id, { provider, branch, repo: metadata.repo });
    return send(res, 201, { deployment: inserted[0] }), true;
  }

  const listMatch = path.match(new RegExp(`^/api/projects/${UUID}/deployments$`, "i"));
  if (method === "GET" && listMatch) {
    const owned = await sql`SELECT id FROM projects WHERE id = ${listMatch[1]} AND user_id = ${user.id} AND deleted_at IS NULL LIMIT 1`;
    if (!owned.length) throw new HttpError(404, "Project not found.");
    const rows = await sql`SELECT id, provider, provider_project_name, provider_deployment_id, deployment_url, branch, status, error_message, created_at, updated_at
      FROM deployments WHERE project_id = ${listMatch[1]} AND user_id = ${user.id} ORDER BY created_at DESC LIMIT 20`;
    return send(res, 200, { deployments: rows }), true;
  }

  const refreshMatch = path.match(new RegExp(`^/api/deployments/${UUID}/refresh$`, "i"));
  if (method === "POST" && refreshMatch) {
    rateLimit(`refresh:${user.id}`, 30, 60_000);
    const rows = await sql`
      SELECT d.*, pc.account_id, pc.encrypted_access_token, pc.token_iv, pc.token_tag
      FROM deployments d JOIN provider_connections pc ON pc.user_id = d.user_id AND pc.provider = d.provider
      WHERE d.id = ${refreshMatch[1]} AND d.user_id = ${user.id} LIMIT 1`;
    if (!rows.length) throw new HttpError(404, "Deployment or provider connection not found.");
    const d = rows[0];
    let ext;
    try {
      ext = await adapters[d.provider].refresh({ token: decryptProviderToken(d), connection: { account_id: d.account_id }, deployment: d });
    } catch (e) { throw toUserError(d.provider, e); }
    const status = normalizeStatus(ext.rawState);
    const updated = await sql`
      UPDATE deployments SET status = ${status}, deployment_url = ${ext.url || d.deployment_url},
        error_message = ${status === "error" ? (ext.error || "Provider build failed") : null},
        provider_metadata = ${JSON.stringify({ ...(d.provider_metadata || {}), provider_state: String(ext.rawState).toLowerCase() })}::jsonb, updated_at = NOW()
      WHERE id = ${d.id}
      RETURNING id, provider, deployment_url, branch, status, error_message, updated_at`;
    await sql`UPDATE projects SET status = ${projectStatusFor(status)}, updated_at = NOW() WHERE id = ${d.project_id}`;
    return send(res, 200, { deployment: updated[0] }), true;
  }
  return false;
};
