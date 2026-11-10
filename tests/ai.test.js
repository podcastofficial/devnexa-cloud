const test = require("node:test");
const assert = require("node:assert/strict");
const { call, fakeSql } = require("./helpers");
const sql = require("../lib/db");
const { rateLimit } = require("../lib/ratelimit");
const handler = require("../api/index");
const P = require("../lib/ai/providers");
const { validateMessages } = require("../lib/ai/gateway");
const { encryptProviderToken } = require("../lib/crypto");

const TOKEN = "A".repeat(43);
const USER = { id: "11111111-1111-1111-1111-111111111111", telegram_id: 1, role: "user", plan: "free", status: "active", session_id: "s1" };
const authH = { authorization: `Bearer ${TOKEN}` };
const sessionRow = [/FROM sessions s JOIN users/, [USER]];
const realFetch = global.fetch;
const ok = d => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => d });
const fail = (status, message, retryAfter) => ({ ok: false, status, headers: { get: () => retryAfter || null }, json: async () => ({ error: { message } }) });
const completion = (text = "hello", pt = 10, ct = 5) => ok({ choices: [{ message: { content: text } }], usage: { prompt_tokens: pt, completion_tokens: ct } });
const chat = body => call(handler, "POST", "/api/ai/chat", { headers: authH, body });
const msgs = [{ role: "user", content: "How do I fix this error?" }];

test.beforeEach(() => {
  rateLimit.reset(); P.resetCooldowns();
  process.env.GROQ_API_KEY = "groq-platform-key"; process.env.GEMINI_API_KEY = "gem-platform-key"; delete process.env.OPENROUTER_API_KEY;
});
test.afterEach(() => { global.fetch = realFetch; });

test("platform: first provider 429 -> falls back to next, ledger finalized ok, cooldown set", async () => {
  const log = [];
  sql.setImpl(fakeSql([sessionRow, [/INSERT INTO usage_ledger/, [{ id: 7 }]]], log));
  const seen = [];
  global.fetch = async url => { seen.push(String(url)); return String(url).includes("groq") ? fail(429, "rate limited", "30") : completion("from gemini"); };
  const r = await chat({ messages: msgs });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.provider, "gemini"); assert.equal(r.body.fallback_used, true);
  assert.equal(r.body.message.content, "from gemini");
  assert.ok(P.isCoolingDown("groq"));
  assert.ok(log.some(l => /UPDATE usage_ledger SET status/.test(l.text) && l.vals.includes("ok")));
  // second request skips cooled-down groq entirely
  seen.length = 0; await chat({ messages: msgs });
  assert.ok(seen.every(u => !u.includes("groq")));
});

test("platform: all providers fail -> 503, ledger marked error (allowance not consumed)", async () => {
  const log = [];
  sql.setImpl(fakeSql([sessionRow, [/INSERT INTO usage_ledger/, [{ id: 7 }]]], log));
  global.fetch = async () => fail(500, "boom");
  const r = await chat({ messages: msgs });
  assert.equal(r.statusCode, 503);
  assert.match(r.body.error, /did not use your allowance/);
  assert.ok(log.some(l => /UPDATE usage_ledger SET status/.test(l.text) && l.vals.includes("error")));
});

test("platform: quota exhausted -> 429 with BYOK hint, no provider call", async () => {
  sql.setImpl(fakeSql([sessionRow,
    [/INSERT INTO usage_ledger/, []],                                   // reservation refused
    [/FROM usage_ledger/, [{ month_tokens: 59000, day_requests: 20, pending: 0 }]]]));
  let called = 0; global.fetch = async () => { called++; return completion(); };
  const r = await chat({ messages: msgs });
  assert.equal(r.statusCode, 429); assert.match(r.body.error, /Daily free AI limit/); assert.equal(called, 0);
});

test("platform: not configured -> clear 503", async () => {
  delete process.env.GROQ_API_KEY; delete process.env.GEMINI_API_KEY;
  sql.setImpl(fakeSql([sessionRow]));
  const r = await chat({ messages: msgs });
  assert.equal(r.statusCode, 503); assert.match(r.body.error, /not available/);
});

test("secrets in prompts are rejected before any provider call", async () => {
  sql.setImpl(fakeSql([sessionRow]));
  global.fetch = async () => { throw new Error("must not be called"); };
  for (const bad of ["my key sk-abcdefghijklmnopqrstuvwxyz123456", "ghp_" + "a".repeat(36), "postgres://u:pass@host/db", "-----BEGIN RSA PRIVATE KEY-----"]) {
    const r = await chat({ messages: [{ role: "user", content: bad }] });
    assert.equal(r.statusCode, 400, bad); assert.match(r.body.error, /secret/);
  }
});

test("message validation", () => {
  assert.throws(() => validateMessages([]), /between 1/);
  assert.throws(() => validateMessages([{ role: "system", content: "x" }]), /role/);
  assert.throws(() => validateMessages([{ role: "user", content: "x".repeat(9000) }]), /too long/);
  assert.throws(() => validateMessages([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]), /last message/);
});

test("BYOK key save: verified, encrypted, key never returned", async () => {
  const log = [];
  sql.setImpl(fakeSql([sessionRow], log));
  global.fetch = async () => ok({ data: [] });
  const key = "sk-ant-SECRETSECRETSECRET1234";
  const r = await call(handler, "POST", "/api/ai/keys", { headers: authH, body: { provider: "anthropic", api_key: key } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.key_last4, "1234");
  assert.ok(!JSON.stringify(r.body).includes("SECRETSECRET"));
  const ins = log.find(l => /INSERT INTO ai_keys/.test(l.text));
  assert.ok(!ins.vals.includes(key), "plaintext key must not reach the DB");
});

test("BYOK key save: provider rejects key -> 400", async () => {
  sql.setImpl(fakeSql([sessionRow]));
  global.fetch = async () => fail(401, "invalid x-api-key");
  const r = await call(handler, "POST", "/api/ai/keys", { headers: authH, body: { provider: "openai", api_key: "sk-" + "x".repeat(30) } });
  assert.equal(r.statusCode, 400);
});

test("status never exposes keys; reports quota and platform availability", async () => {
  sql.setImpl(fakeSql([sessionRow,
    [/FROM ai_keys/, [{ provider: "openai", key_last4: "abcd", updated_at: "x" }]],
    [/FROM usage_ledger/, [{ month_tokens: 100, day_requests: 2, pending: 0 }]]]));
  const r = await call(handler, "GET", "/api/ai/status", { headers: authH });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.platform.available, true);
  assert.equal(r.body.quota.day_requests.limit, 20);
  assert.ok(!JSON.stringify(r.body).includes("encrypted"));
});

function byokFixtures(extra = []) {
  const enc = encryptProviderToken("sk-ant-userkey-0000000000");
  return fakeSql([sessionRow,
    [/FROM ai_keys/, [{ encrypted_access_token: enc.encrypted, token_iv: enc.iv, token_tag: enc.tag }]],
    [/INSERT INTO usage_ledger/, [{ id: 9 }]], ...extra]);
}

test("BYOK chat via Anthropic: correct wire format, no platform quota reservation", async () => {
  const log = [];
  const f = byokFixtures(); sql.setImpl((s, ...v) => { log.push({ text: s.join("?"), vals: v }); return f(s, ...v); });
  let req;
  global.fetch = async (url, init) => { req = { url: String(url), init }; return ok({ content: [{ type: "text", text: "claude says hi" }], usage: { input_tokens: 12, output_tokens: 4 } }); };
  const r = await chat({ mode: "byok", provider: "anthropic", messages: msgs });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.message.content, "claude says hi");
  assert.equal(req.url, "https://api.anthropic.com/v1/messages");
  assert.equal(req.init.headers["x-api-key"], "sk-ant-userkey-0000000000");
  const sent = JSON.parse(req.init.body);
  assert.ok(sent.system && sent.messages[0].role === "user" && sent.max_tokens > 0);
  assert.ok(!log.some(l => /pg_advisory_xact_lock/.test(l.text)), "BYOK must not touch platform quota");
});

test("BYOK: provider 401 -> 409 and provider error text never leaks the key", async () => {
  sql.setImpl(byokFixtures());
  global.fetch = async () => fail(401, "Invalid key sk-ant-userkey-0000000000");
  const r = await chat({ mode: "byok", provider: "anthropic", messages: msgs });
  assert.equal(r.statusCode, 409);
  assert.ok(!JSON.stringify(r.body).includes("userkey"));
  global.fetch = async () => fail(500, "upstream said key sk-ant-userkey-0000000000 broke");
  const r2 = await chat({ mode: "byok", provider: "anthropic", messages: msgs });
  assert.ok(!JSON.stringify(r2.body).includes("userkey"));
});

test("BYOK without saved key -> 409", async () => {
  sql.setImpl(fakeSql([sessionRow]));
  const r = await chat({ mode: "byok", provider: "openai", messages: msgs });
  assert.equal(r.statusCode, 409);
});

test("max_tokens is capped by plan in platform mode", async () => {
  sql.setImpl(fakeSql([sessionRow, [/INSERT INTO usage_ledger/, [{ id: 1 }]]]));
  let sent; global.fetch = async (u, init) => { sent = JSON.parse(init.body); return completion(); };
  await chat({ messages: msgs, max_tokens: 100000 });
  assert.equal(sent.max_tokens, 800);
});

test("ai routes require authentication", async () => {
  sql.setImpl(fakeSql([]));
  assert.equal((await call(handler, "POST", "/api/ai/chat", { body: { messages: msgs } })).statusCode, 401);
});
