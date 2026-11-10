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

function validBranch(v, fallback = "main") {
  return typeof v === "string" && /^[A-Za-z0-9._/-]{1,120}$/.test(v) && !v.includes("..") ? v : fallback;
}

// Relative sub-folder such as "dist" or "public"; "" means repo root.
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
