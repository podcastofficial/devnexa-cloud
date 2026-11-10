const { providerRequest } = require("./request");
const { HttpError } = require("../http");

async function verify({ token, accountId }) {
  if (!accountId || !/^[a-f0-9]{32}$/i.test(accountId)) throw new HttpError(400, "Cloudflare Account ID must be 32 hexadecimal characters.");
  const v = await providerRequest("cloudflare", "/user/tokens/verify", token);
  if (v.status !== "active") throw new HttpError(400, "Cloudflare API token is not active.");
  return { label: `Cloudflare account ${accountId.slice(0, 8)}…`, accountId };
}

// Pages deployment is only finished when the final "deploy" stage succeeds; an earlier stage
// reporting "success" (e.g. build) does not mean the site is live.
function stageToState(stage) {
  if (!stage) return "queued";
  const s = String(stage.status || "").toLowerCase();
  if (s === "success") return stage.name === "deploy" ? "success" : "active";
  return s || "queued";
}

async function deploy({ token, connection, repo, branch, providerProjectName, options }) {
  const accountId = connection.account_id;
  const projectPath = `/accounts/${accountId}/pages/projects/${encodeURIComponent(providerProjectName)}`;
  let project = await providerRequest("cloudflare", projectPath, token).catch(e => e.status === 404 ? null : Promise.reject(e));
  if (!project) {
    project = await providerRequest("cloudflare", `/accounts/${accountId}/pages/projects`, token, {
      method: "POST",
      body: JSON.stringify({
        name: providerProjectName,
        production_branch: branch,
        source: { type: "github", config: { owner: repo.owner, repo_name: repo.repo, production_branch: branch, pr_comments_enabled: false, production_deployments_enabled: true, preview_deployment_setting: "all" } },
        // Configurable: static repos use no build command and the repo root ("").
        build_config: { build_command: options.buildCommand, destination_dir: options.outputDir, root_dir: "" }
      })
    });
  }
  const form = new FormData();
  form.set("branch", branch);
  const d = await providerRequest("cloudflare", `${projectPath}/deployments`, token, { method: "POST", body: form });
  return {
    externalProjectId: project.id || project.name || providerProjectName,
    externalDeploymentId: d.id || null,
    deploymentUrl: d.url || (project.subdomain ? `https://${project.subdomain.includes(".") ? project.subdomain : project.subdomain + ".pages.dev"}` : null),
    rawState: stageToState(d.latest_stage)
  };
}

async function refresh({ token, connection, deployment }) {
  const d = await providerRequest("cloudflare",
    `/accounts/${connection.account_id}/pages/projects/${encodeURIComponent(deployment.provider_project_name)}/deployments/${encodeURIComponent(deployment.provider_deployment_id)}`, token);
  const rawState = stageToState(d.latest_stage);
  return { rawState, url: d.url || null, error: rawState === "failure" ? `Cloudflare stage "${d.latest_stage?.name}" failed` : null };
}

module.exports = { verify, deploy, refresh, stageToState };
