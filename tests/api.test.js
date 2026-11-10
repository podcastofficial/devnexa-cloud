const test = require("node:test");
const assert = require("node:assert/strict");
const { call, signedInitData, fakeSql } = require("./helpers");
const sql = require("../lib/db");
const { rateLimit } = require("../lib/ratelimit");
const handler = require("../api/index");
const { encryptProviderToken } = require("../lib/crypto");

const TOKEN = "A".repeat(43);
const USER = { id: "11111111-1111-1111-1111-111111111111", telegram_id: 1, role: "user", plan: "free", status: "active", session_id: "s1" };
const PID = "22222222-2222-2222-2222-222222222222";
const authH = { authorization: `Bearer ${TOKEN}` };
const sessionRow = [/FROM sessions s JOIN users/, [USER]];
const realFetch = global.fetch;
test.beforeEach(() => rateLimit.reset());
test.afterEach(() => { global.fetch = realFetch; });

test("health works; unauthenticated requests get 401", async () => {
  sql.setImpl(fakeSql([]));
  assert.equal((await call(handler, "GET", "/api/health")).body.ok, true);
  assert.equal((await call(handler, "GET", "/api/projects")).statusCode, 401);
  assert.equal((await call(handler, "GET", "/api/projects", { headers: { authorization: "Bearer nope" } })).statusCode, 401);
});

test("telegram login creates session; forged initData rejected", async () => {
  sql.setImpl(fakeSql([[/INSERT INTO users/, [{ id: USER.id, status: "active", role: "user", plan: "free" }]]]));
  const ok = await call(handler, "POST", "/api/auth/telegram", { body: { initData: signedInitData({ id: 5, first_name: "Z" }) } });
  assert.equal(ok.statusCode, 200); assert.ok(ok.body.token);
  const bad = await call(handler, "POST", "/api/auth/telegram", { body: { initData: signedInitData({ id: 5, first_name: "Z" }, { token: "x:y" }) } });
  assert.equal(bad.statusCode, 401);
});

test("ownership isolation: other user's project/deployments -> 404", async () => {
  sql.setImpl(fakeSql([sessionRow])); // project queries return [] (not owned)
  for (const [m, p] of [["GET", `/api/projects/${PID}`], ["GET", `/api/projects/${PID}/deployments`], ["DELETE", `/api/projects/${PID}`]])
    assert.equal((await call(handler, m, p, { headers: authH })).statusCode, 404, p);
  const d = await call(handler, "POST", `/api/projects/${PID}/deploy`, { headers: authH, body: { provider: "netlify" } });
  assert.equal(d.statusCode, 404);
});

test("admin routes forbidden for normal users", async () => {
  sql.setImpl(fakeSql([sessionRow]));
  assert.equal((await call(handler, "GET", "/api/admin/stats", { headers: authH })).statusCode, 403);
});

test("provider connect: rejected token -> clear 400 (not 500)", async () => {
  sql.setImpl(fakeSql([sessionRow]));
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ message: "Unauthorized" }) });
  const r = await call(handler, "POST", "/api/providers/connect", { headers: authH, body: { provider: "netlify", access_token: "x".repeat(20) } });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /rejected this token/);
});

test("provider connect: unsupported provider -> 400", async () => {
  sql.setImpl(fakeSql([sessionRow]));
  const r = await call(handler, "POST", "/api/providers/connect", { headers: authH, body: { provider: "heroku", access_token: "x".repeat(20) } });
  assert.equal(r.statusCode, 400);
});

function deployFixtures(extra = []) {
  const enc = encryptProviderToken("prov-token");
  const conn = { provider: "netlify", account_id: "9", encrypted_access_token: enc.encrypted, token_iv: enc.iv, token_tag: enc.tag };
  return fakeSql([
    sessionRow,
    [/FROM projects WHERE id/, [{ id: PID, name: "Demo", github_repo: "https://github.com/o/r" }]],
    [/FROM provider_connections/, [conn]],
    [/FROM github_connections/, [conn]],
    [/INSERT INTO deployments/, [{ id: "d1", provider: "netlify", status: "building" }]],
    ...extra
  ]);
}

test("deploy: provider 401 -> 409 reconnect message", async () => {
  sql.setImpl(deployFixtures());
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ message: "Bad credentials" }) });
  const r = await call(handler, "POST", `/api/projects/${PID}/deploy`, { headers: authH, body: { provider: "netlify" } });
  assert.equal(r.statusCode, 409);
  assert.match(r.body.error, /Reconnect/);
});

test("deploy: duplicate in-flight deploy returns existing, creates no new one", async () => {
  const log = [];
  const f = deployFixtures([[/status IN \('queued','building'\)/, [{ id: "existing", status: "building" }]]]);
  sql.setImpl((s, ...v) => f(s, ...v));
  let fetched = 0; global.fetch = async () => { fetched++; return { ok: true, status: 200, json: async () => ({}) }; };
  const r = await call(handler, "POST", `/api/projects/${PID}/deploy`, { headers: authH, body: { provider: "netlify" } });
  assert.equal(r.statusCode, 200); assert.equal(r.body.duplicate, true); assert.equal(fetched, 0);
});

test("deploy: invalid output_dir / build command rejected", async () => {
  sql.setImpl(deployFixtures());
  assert.equal((await call(handler, "POST", `/api/projects/${PID}/deploy`, { headers: authH, body: { provider: "netlify", output_dir: "../x" } })).statusCode, 400);
});

test("netlify deploy end-to-end (mocked): uploads only required files, maps state", async () => {
  sql.setImpl(deployFixtures());
  const sha = require("node:crypto").createHash("sha1");
  const indexBody = Buffer.from("<h1>hi</h1>"), cssBody = Buffer.from("a{}");
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || "GET", body: opts.body });
    const u = String(url);
    const json = d => ({ ok: true, status: 200, json: async () => d });
    if (u.includes("/git/trees/")) return json({ truncated: false, tree: [
      { type: "blob", path: "public/index.html", sha: "b1", size: 11 },
      { type: "blob", path: "public/app.css", sha: "b2", size: 3 },
      { type: "blob", path: "README.md", sha: "b3", size: 5 },
      { type: "blob", path: "node_modules/x.js", sha: "b4", size: 5 }] });
    if (u.endsWith("/git/blobs/b1")) return json({ encoding: "base64", content: indexBody.toString("base64") });
    if (u.endsWith("/git/blobs/b2")) return json({ encoding: "base64", content: cssBody.toString("base64") });
    if (u.includes("/sites/") && u.endsWith(".netlify.app")) return { ok: false, status: 404, json: async () => ({ message: "Not Found" }) };
    if (u.endsWith("/sites") && opts.method === "POST") return json({ id: "site1", ssl_url: "https://demo.netlify.app" });
    if (u.endsWith("/sites/site1/deploys")) {
      const manifest = JSON.parse(opts.body).files;
      assert.deepEqual(Object.keys(manifest).sort(), ["/app.css", "/index.html"]);
      return json({ id: "dep1", state: "uploading", required: [manifest["/index.html"]] });
    }
    if (u.includes("/deploys/dep1/files/") && opts.method === "PUT") return json({});
    throw new Error("unexpected fetch " + u);
  };
  const r = await call(handler, "POST", `/api/projects/${PID}/deploy`, { headers: authH, body: { provider: "netlify", output_dir: "public" } });
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  const puts = calls.filter(c => c.method === "PUT");
  assert.equal(puts.length, 1);
  assert.ok(puts[0].url.endsWith("/deploys/dep1/files/index.html"));
});

test("netlify deploy: no index.html -> helpful 400", async () => {
  sql.setImpl(deployFixtures());
  global.fetch = async (url) => {
    const u = String(url), json = d => ({ ok: true, status: 200, json: async () => d });
    if (u.includes("/git/trees/")) return json({ tree: [{ type: "blob", path: "src/main.js", sha: "b1", size: 3 }] });
    return json({ encoding: "base64", content: "YQ==" });
  };
  const r = await call(handler, "POST", `/api/projects/${PID}/deploy`, { headers: authH, body: { provider: "netlify" } });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /index\.html/);
});
