// Netlify adapter: DIRECT STATIC DEPLOY. DevNexa reads the files of a public GitHub repo
// (optionally one sub-folder, e.g. "dist" or "public") and uploads them with Netlify's file-digest
// deploy API. No build step runs here — build-based deploys need the isolated worker (Phase 4).
const crypto = require("node:crypto");
const { providerRequest } = require("./request");
const { githubApi } = require("../github");
const { HttpError } = require("../http");

const LIMITS = { files: 150, fileBytes: 5 * 1024 * 1024, totalBytes: 8 * 1024 * 1024, concurrency: 6 };
const SKIP = /(^|\/)(\.git|\.github|node_modules)(\/|$)/;

async function verify({ token }) {
  const u = await providerRequest("netlify", "/user", token);
  return { label: u.full_name || u.email || u.slug || "Netlify account", accountId: u.id ? String(u.id) : null };
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); }
  }));
  return out;
}

async function collectFiles({ githubToken, repo, branch, dir }) {
  const tree = await githubApi(`/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, githubToken);
  if (tree.truncated) throw new HttpError(400, "Repository is too large for direct static deploy.");
  const prefix = dir ? `${dir}/` : "";
  const blobs = tree.tree.filter(n => n.type === "blob" && n.path.startsWith(prefix) && !SKIP.test(n.path));
  if (!blobs.length) throw new HttpError(400, dir ? `Folder "${dir}" has no files on branch ${branch}.` : "Repository has no deployable files.");
  if (blobs.length > LIMITS.files) throw new HttpError(400, `Too many files (${blobs.length}). Direct static deploy supports up to ${LIMITS.files}; set an output folder such as "dist".`);
  const total = blobs.reduce((s, b) => s + (b.size || 0), 0);
  if (blobs.some(b => (b.size || 0) > LIMITS.fileBytes) || total > LIMITS.totalBytes) {
    throw new HttpError(400, "Files are too large for direct static deploy (limit 5 MB per file, 8 MB total).");
  }
  const files = await pool(blobs, LIMITS.concurrency, async b => {
    const blob = await githubApi(`/repos/${repo.owner}/${repo.repo}/git/blobs/${b.sha}`, githubToken);
    const content = Buffer.from(blob.content || "", blob.encoding === "base64" ? "base64" : "utf8");
    return { path: "/" + b.path.slice(prefix.length), content, sha1: crypto.createHash("sha1").update(content).digest("hex") };
  });
  if (!files.some(f => f.path === "/index.html")) {
    throw new HttpError(400, `No index.html found${dir ? ` in "${dir}"` : " in the repository root"}. Direct deploy serves static files only (no build step yet) — set the output folder (e.g. dist) or commit built files.`);
  }
  return files;
}

async function deploy({ token, githubToken, repo, branch, providerProjectName, options }) {
  const files = await collectFiles({ githubToken, repo, branch, dir: options.outputDir });
  const siteName = providerProjectName;
  let site = await providerRequest("netlify", `/sites/${encodeURIComponent(siteName)}.netlify.app`, token)
    .catch(e => e.status === 404 ? null : Promise.reject(e));
  if (!site) site = await providerRequest("netlify", "/sites", token, { method: "POST", body: JSON.stringify({ name: siteName }) });

  const manifest = {};
  files.forEach(f => { manifest[f.path] = f.sha1; });
  const created = await providerRequest("netlify", `/sites/${site.id}/deploys`, token, { method: "POST", body: JSON.stringify({ files: manifest }) });

  const required = new Set(created.required || []);
  const toUpload = files.filter(f => required.has(f.sha1));
  const seen = new Set();
  const unique = toUpload.filter(f => (seen.has(f.sha1) ? false : seen.add(f.sha1)));
  await pool(unique, LIMITS.concurrency, f =>
    providerRequest("netlify", `/deploys/${created.id}/files${f.path.split("/").map(encodeURIComponent).join("/")}`, token, {
      method: "PUT", body: f.content, headers: { "Content-Type": "application/octet-stream" }
    }));

  return {
    externalProjectId: site.id,
    externalDeploymentId: created.id,
    deploymentUrl: site.ssl_url || site.url || created.ssl_url || null,
    rawState: created.state || "uploading",
    extra: { files: files.length, uploaded: unique.length }
  };
}

async function refresh({ token, deployment }) {
  const d = await providerRequest("netlify", `/deploys/${encodeURIComponent(deployment.provider_deployment_id)}`, token);
  return { rawState: d.state || "unknown", url: d.ssl_url || d.url || null, error: d.error_message || null };
}

module.exports = { verify, deploy, refresh, collectFiles };
