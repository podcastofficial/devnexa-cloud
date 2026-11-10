function validProjectName(v) {
  return typeof v === "string" && v.trim().length >= 2 && v.trim().length <= 50 && /^[\p{L}\p{N} _.-]+$/u.test(v.trim());
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

// Returns the branch name, or "main" if empty. Throws on clearly invalid input
// so the caller can return a 400 instead of silently deploying the wrong branch.
function validBranch(v, fallback = "main") {
  if (v == null || v === "") return fallback;
  if (typeof v !== "string" || v.length > 120) throw new Error("Branch name is too long.");
  if (!/^[A-Za-z0-9._/-]+$/.test(v)) throw new Error("Branch name contains invalid characters.");
  if (v.includes("..") || v.startsWith("/") || v.endsWith("/") || v.includes("//")) {
    throw new Error("Branch name is malformed.");
  }
  return v;
}

function validDir(v) {
  if (v == null || v === "" || v === "/" || v === ".") return "";
  if (typeof v !== "string" || v.length > 100) return false;
  const clean = v.replace(/^\/+|\/+$/g, "");
  return /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(clean) && !clean.split("/").includes("..") ? clean : false;
}

function validBuildCommand(v) {
  if (v == null || v === "") return null;
  return typeof v === "string" && v.length <= 200 && /^[\w@./: =+-]+$/.test(v) ? v : false;
}

module.exports = { validProjectName, validGitHubRepo, validBranch, validDir, validBuildCommand };