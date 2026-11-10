const { providerRequest } = require("./request");
const { githubApi } = require("../github");
const { HttpError } = require("../http");

async function verify({ token }) {
  const identity = await providerRequest("vercel", "/v2/user", token);
  return { label: identity.user?.username || identity.user?.email || "Vercel account", accountId: null };
}

// Requires the Vercel GitHub App to be installed on the repository.
async function deploy({ token, githubToken, repo, branch, providerProjectName }) {
  const ghRepo = await githubApi(`/repos/${repo.owner}/${repo.repo}`, githubToken);
  const ghCommit = await githubApi(`/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(branch)}`, githubToken);
  const existing = await providerRequest("vercel", `/v9/projects/${encodeURIComponent(providerProjectName)}`, token)
    .catch(e => e.status === 404 ? null : Promise.reject(e));
  const project = existing || await providerRequest("vercel", "/v10/projects", token, {
    method: "POST",
    body: JSON.stringify({ name: providerProjectName, framework: null, gitRepository: { type: "github", repo: `${repo.owner}/${repo.repo}` } })
  });
  const projectId = project.id || project.project?.id || null;
  const created = await providerRequest("vercel", "/v13/deployments", token, {
    method: "POST",
    body: JSON.stringify({
      name: providerProjectName,
      project: projectId || providerProjectName,
      target: "production",
      // Vercel's API expects type "github" with repoId + ref + sha.
      gitSource: { type: "github", repoId: String(ghRepo.id), ref: branch, sha: ghCommit.sha }
    })
  });
  return {
    externalProjectId: projectId,
    externalDeploymentId: created.id || null,
    deploymentUrl: created.url ? `https://${created.url}` : null,
    rawState: created.readyState || created.status || "QUEUED"
  };
}

async function refresh({ token, deployment }) {
  if (!deployment.provider_deployment_id) throw new HttpError(409, "Deployment has no provider ID yet.");
  const d = await providerRequest("vercel", `/v13/deployments/${encodeURIComponent(deployment.provider_deployment_id)}`, token);
  return {
    rawState: d.readyState || d.status || "unknown",
    url: d.url ? `https://${d.url}` : null,
    error: d.errorMessage || null
  };
}

module.exports = { verify, deploy, refresh };
