const test = require("node:test");
const assert = require("node:assert/strict");
const { signedInitData } = require("./helpers");
const { normalizeStatus, projectStatusFor } = require("../lib/providers/status");
const { stageToState } = require("../lib/providers/cloudflare");
const c = require("../lib/crypto");
const { verifyTelegramInitData } = require("../lib/telegram");
const v = require("../lib/validate");
const { rateLimit } = require("../lib/ratelimit");

test("status: Cloudflare 'failure' is an error (regression)", () => {
  assert.equal(normalizeStatus("failure"), "error");
  assert.equal(normalizeStatus("FAILED"), "error");
});
test("status: provider states map correctly", () => {
  for (const [raw, want] of [["READY","ready"],["ERROR","error"],["CANCELED","canceled"],["BUILDING","building"],["INITIALIZING","building"],["QUEUED","queued"],["uploading","building"],["processing","building"],["enqueued","queued"],["weird","queued"],[undefined,"queued"]])
    assert.equal(normalizeStatus(raw), want, raw);
  assert.equal(projectStatusFor("ready"), "live");
  assert.equal(projectStatusFor("error"), "failed");
  assert.equal(projectStatusFor("building"), "deploying");
});
test("cloudflare: build-stage success is NOT ready; deploy-stage success is", () => {
  assert.equal(normalizeStatus(stageToState({ name: "build", status: "success" })), "building");
  assert.equal(normalizeStatus(stageToState({ name: "deploy", status: "success" })), "ready");
  assert.equal(normalizeStatus(stageToState({ name: "build", status: "failure" })), "error");
});
test("crypto: roundtrip, unique IV, tamper detection", () => {
  const a = c.encryptProviderToken("secret-token"), b = c.encryptProviderToken("secret-token");
  assert.notEqual(a.encrypted, b.encrypted);
  const row = { encrypted_access_token: a.encrypted, token_iv: a.iv, token_tag: a.tag };
  assert.equal(c.decryptProviderToken(row), "secret-token");
  const bad = { ...row, encrypted_access_token: Buffer.from("x".repeat(12)).toString("base64") };
  assert.throws(() => c.decryptProviderToken(bad));
});
test("telegram: valid, forged, expired", () => {
  const u = { id: 42, first_name: "A" };
  assert.equal(verifyTelegramInitData(signedInitData(u)).id, 42);
  assert.throws(() => verifyTelegramInitData(signedInitData(u, { token: "other:token" })), /signature/);
  assert.throws(() => verifyTelegramInitData(signedInitData(u, { authDate: 1000 })), /expired/);
  assert.throws(() => verifyTelegramInitData(""), /invalid/i);
});
test("validators", () => {
  assert.equal(v.validProjectName("My App"), true);
  assert.equal(v.validProjectName("<script>"), false);
  assert.equal(v.validGitHubRepo("https://github.com/a/b"), "https://github.com/a/b");
  assert.equal(v.validGitHubRepo("https://evil.com/a/b"), false);
  assert.equal(v.validBranch("feat/x"), "feat/x");
  assert.equal(v.validBranch("a..b"), "main");
  assert.equal(v.validDir("dist/"), "dist");
  assert.equal(v.validDir("../etc"), false);
  assert.equal(v.validDir(""), "");
  assert.equal(v.validBuildCommand("npm run build"), "npm run build");
  assert.equal(v.validBuildCommand("rm -rf /; curl x|sh"), false);
});
test("rateLimit blocks after max", () => {
  rateLimit.reset();
  for (let i = 0; i < 3; i++) rateLimit("k", 3, 1000);
  assert.throws(() => rateLimit("k", 3, 1000), e => e.status === 429);
});
