const sql = require("../lib/db");
const { send, readBody, HttpError } = require("../lib/http");
const { audit } = require("../lib/auth");
const { githubApi, getUserGitHubToken } = require("../lib/github");
const { validProjectName, validGitHubRepo } = require("../lib/validate");

const FREE_PROJECT_LIMIT = 2;
const UUID = "([0-9a-f-]{36})";
const TYPES = ["website", "api", "telegram_bot", "node_app", "python_app"];

module.exports = async function projectRoutes({ req, res, path, method, user }) {
  if (method === "GET" && path === "/api/me") {
    const r = await sql`SELECT COUNT(*)::int AS total FROM projects WHERE user_id = ${user.id} AND deleted_at IS NULL`;
    return send(res, 200, {
      user: { id: user.id, telegram_id: String(user.telegram_id), username: user.username, first_name: user.first_name, last_name: user.last_name, photo_url: user.photo_url, role: user.role, plan: user.plan },
      usage: { projects: r[0].total, project_limit: user.plan === "free" ? FREE_PROJECT_LIMIT : null }
    }), true;
  }

  const detail = path.match(new RegExp(`^/api/projects/${UUID}$`, "i"));
  if (method === "GET" && detail) {
    const rows = await sql`SELECT id, name, project_type, description, github_repo, default_branch, status, created_at, updated_at
      FROM projects WHERE id = ${detail[1]} AND user_id = ${user.id} AND deleted_at IS NULL LIMIT 1`;
    if (!rows.length) throw new HttpError(404, "Project not found");
    return send(res, 200, { project: rows[0] }), true;
  }

  const connect = path.match(new RegExp(`^/api/projects/${UUID}/connect-repo$`, "i"));
  if (method === "POST" && connect) {
    const body = await readBody(req);
    if (typeof body.full_name !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(body.full_name)) throw new HttpError(400, "Choose a valid repository from your GitHub account.");
    const token = await getUserGitHubToken(user.id);
    const owned = await sql`SELECT id FROM projects WHERE id = ${connect[1]} AND user_id = ${user.id} AND deleted_at IS NULL LIMIT 1`;
    if (!owned.length) throw new HttpError(404, "Project not found");
    const repo = await githubApi(`/repos/${body.full_name}`, token);
    if (repo.private) throw new HttpError(403, "This initial integration supports public repositories only. Private repository access will use a GitHub App with fine-grained permissions.");
    const rows = await sql`
      UPDATE projects
      SET github_repo = ${repo.html_url}, default_branch = ${repo.default_branch || "main"}, updated_at = NOW()
      WHERE id = ${connect[1]} AND user_id = ${user.id} AND deleted_at IS NULL
      RETURNING id, name, github_repo, default_branch, updated_at`;
    await audit(user.id, "project.github_connected", "project", connect[1], { repository: repo.full_name, default_branch: repo.default_branch });
    return send(res, 200, { project: rows[0], repository: repo.full_name, default_branch: repo.default_branch }), true;
  }

  if (method === "GET" && path === "/api/projects") {
    const rows = await sql`SELECT id, name, project_type, description, github_repo, default_branch, status, created_at, updated_at
      FROM projects WHERE user_id = ${user.id} AND deleted_at IS NULL ORDER BY created_at DESC`;
    return send(res, 200, { projects: rows }), true;
  }

  if (method === "POST" && path === "/api/projects") {
    const body = await readBody(req);
    if (!validProjectName(body.name)) throw new HttpError(400, "Project name must be 2–50 characters and use letters, numbers, spaces, dots, underscores or hyphens.");
    const projectType = TYPES.includes(body.project_type) ? body.project_type : "website";
    const repo = validGitHubRepo(body.github_repo);
    if (repo === false) throw new HttpError(400, "Please provide a valid https://github.com/owner/repository URL.");
    const inserted = await sql`
      WITH user_lock AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtext(${user.id}::text)))
      INSERT INTO projects (user_id, name, project_type, description, github_repo)
      SELECT ${user.id}, ${body.name.trim()}, ${projectType}, ${typeof body.description === "string" ? body.description.trim().slice(0, 500) : null}, ${repo}
      FROM user_lock
      WHERE (SELECT COUNT(*) FROM projects WHERE user_id = ${user.id} AND deleted_at IS NULL) < ${user.plan === "free" ? FREE_PROJECT_LIMIT : 100}
      RETURNING id, name, project_type, description, github_repo, default_branch, status, created_at`;
    if (!inserted.length) throw new HttpError(403, "Free plan limit reached. Delete a project or upgrade your plan.");
    await audit(user.id, "project.created", "project", inserted[0].id);
    return send(res, 201, { project: inserted[0] }), true;
  }

  if (method === "DELETE" && detail) {
    const rows = await sql`UPDATE projects SET deleted_at = NOW(), updated_at = NOW() WHERE id = ${detail[1]} AND user_id = ${user.id} AND deleted_at IS NULL RETURNING id`;
    if (!rows.length) throw new HttpError(404, "Project not found");
    await audit(user.id, "project.deleted", "project", detail[1]);
    return send(res, 200, { ok: true }), true;
  }
  return false;
};