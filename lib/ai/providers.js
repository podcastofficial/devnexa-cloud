// Provider registry + adapters. Two wire formats cover everything we need:
//  - "openai": OpenAI-compatible /chat/completions (OpenAI, Groq, Gemini compat endpoint, OpenRouter)
//  - "anthropic": Anthropic Messages API
// Model names change often and free tiers come and go: every platform model is overridable with
// AI_MODEL_<PROVIDER> env vars, and free providers are only used if their API key env var is set.
const PROVIDERS = {
  groq:       { type: "openai", base: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", envKey: "GROQ_API_KEY", platform: true },
  gemini:     { type: "openai", base: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash", envKey: "GEMINI_API_KEY", platform: true },
  openrouter: { type: "openai", base: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free", envKey: "OPENROUTER_API_KEY", platform: true },
  openai:     { type: "openai", base: "https://api.openai.com/v1", model: "gpt-4o-mini", platform: false },
  anthropic:  { type: "anthropic", base: "https://api.anthropic.com/v1", model: "claude-haiku-5-5", platform: false }
};
const BYOK_PROVIDERS = Object.keys(PROVIDERS);
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 20000);

class AiProviderError extends Error {
  constructor(message, { status = 0, retryable = false, retryAfterMs = 0 } = {}) {
    super(message);
    this.status = status; this.retryable = retryable; this.retryAfterMs = retryAfterMs;
  }
}

const modelFor = id => process.env[`AI_MODEL_${id.toUpperCase()}`] || PROVIDERS[id].model;
const platformKey = id => (PROVIDERS[id].envKey && process.env[PROVIDERS[id].envKey]) || null;

function platformOrder() {
  const order = (process.env.AI_PLATFORM_ORDER || "groq,gemini,openrouter").split(",").map(s => s.trim()).filter(Boolean);
  return order.filter(id => PROVIDERS[id]?.platform && platformKey(id));
}

function redact(text, secret) {
  let out = String(text || "");
  if (secret) out = out.split(secret).join("[redacted]");
  return out.slice(0, 300);
}

async function http(url, init, secret) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let response;
  try { response = await fetch(url, { ...init, signal: ctrl.signal }); }
  catch (e) {
    throw new AiProviderError(e.name === "AbortError" ? "Provider timed out" : "Provider unreachable", { retryable: true });
  } finally { clearTimeout(timer); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = redact(data.error?.message || data.message || `HTTP ${response.status}`, secret);
    const ra = Number(response.headers?.get?.("retry-after")) || 0;
    throw new AiProviderError(msg, {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
      retryAfterMs: Math.min(ra * 1000, 300000)
    });
  }
  return data;
}

const openaiHeaders = (id, key) => ({
  "Authorization": `Bearer ${key}`, "Content-Type": "application/json",
  ...(id === "openrouter" ? { "X-Title": "DevNexa Cloud" } : {})
});
const anthropicHeaders = key => ({ "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" });

async function chat(id, apiKey, { model, system, messages, maxTokens }) {
  const p = PROVIDERS[id];
  const useModel = model || modelFor(id);
  const started = Date.now();
  if (p.type === "anthropic") {
    const d = await http(`${p.base}/messages`, {
      method: "POST", headers: anthropicHeaders(apiKey),
      body: JSON.stringify({ model: useModel, max_tokens: maxTokens, system, messages })
    }, apiKey);
    const text = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    return { text, model: useModel, inputTokens: d.usage?.input_tokens ?? 0, outputTokens: d.usage?.output_tokens ?? 0, latencyMs: Date.now() - started };
  }
  const d = await http(`${p.base}/chat/completions`, {
    method: "POST", headers: openaiHeaders(id, apiKey),
    body: JSON.stringify({ model: useModel, max_tokens: maxTokens, messages: [{ role: "system", content: system }, ...messages] })
  }, apiKey);
  const text = d.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new AiProviderError("Provider returned an empty response", { retryable: true });
  return { text, model: useModel, inputTokens: d.usage?.prompt_tokens ?? 0, outputTokens: d.usage?.completion_tokens ?? 0, latencyMs: Date.now() - started };
}

// Cheap key check used when a user saves a BYOK key (lists models; no tokens consumed).
async function verifyKey(id, apiKey) {
  const p = PROVIDERS[id];
  await http(`${p.base}/models`, { method: "GET", headers: p.type === "anthropic" ? anthropicHeaders(apiKey) : openaiHeaders(id, apiKey) }, apiKey);
}

// Short in-memory circuit breaker (per serverless instance) so a failing free provider is skipped for a while.
const cooldowns = new Map();
const isCoolingDown = id => (cooldowns.get(id) || 0) > Date.now();
const coolDown = (id, ms) => cooldowns.set(id, Date.now() + (ms || 60000));
const resetCooldowns = () => cooldowns.clear();

module.exports = { PROVIDERS, BYOK_PROVIDERS, AiProviderError, modelFor, platformKey, platformOrder, chat, verifyKey, isCoolingDown, coolDown, resetCooldowns };
