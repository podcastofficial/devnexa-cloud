const { HttpError } = require("../http");

const BASES = {
  vercel: "https://api.vercel.com",
  cloudflare: "https://api.cloudflare.com/client/v4",
  netlify: "https://api.netlify.com/api/v1"
};
const NAMES = { vercel: "Vercel", cloudflare: "Cloudflare Pages", netlify: "Netlify" };

async function providerRequest(provider, path, token, options = {}) {
  const isRaw = options.body instanceof Buffer || options.body instanceof FormData;
  const response = await fetch(`${BASES[provider]}${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
      ...(options.body && !isRaw ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  const ok = provider === "cloudflare" ? response.ok && data.success !== false : response.ok;
  if (!ok) {
    const message = provider === "cloudflare"
      ? (data.errors || []).map(x => x.message).join("; ") || `Cloudflare API error (${response.status})`
      : data.error?.message || data.message || `${NAMES[provider]} API error (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return provider === "cloudflare" ? data.result : data;
}

// Turns a raw provider failure into a user-safe HttpError.
function toUserError(provider, error) {
  if (error instanceof HttpError) return error;
  const name = NAMES[provider] || provider;
  if (error.status === 401 || error.status === 403) {
    return new HttpError(409, `${name} rejected the saved token (expired or missing permissions). Reconnect ${name} in Profile.`);
  }
  if (error.status === 429) return new HttpError(429, `${name} rate limit reached. Try again shortly.`);
  if (error.status && error.status < 500) return new HttpError(400, `${name}: ${error.message}`);
  return new HttpError(502, `${name} is not responding correctly. Try again later.`);
}

function safeProviderProjectName(name, projectId) {
  const base = String(name || "project").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 35) || "project";
  return `${base}-${String(projectId).replace(/-/g, "").slice(0, 6)}`.slice(0, 58);
}

module.exports = { providerRequest, toUserError, safeProviderProjectName, NAMES };
