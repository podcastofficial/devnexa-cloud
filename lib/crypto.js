const crypto = require("node:crypto");

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function loadKey(raw, name) {
  let key;
  try { key = Buffer.from(raw || "", "base64"); } catch { key = Buffer.alloc(0); }
  if (key.length !== 32) throw new Error(`${name} must be a base64-encoded 32-byte key`);
  return key;
}

const githubKey = () => loadKey(process.env.GITHUB_TOKEN_ENCRYPTION_KEY, "GITHUB_TOKEN_ENCRYPTION_KEY");
const providerKey = () => loadKey(
  process.env.PROVIDER_TOKEN_ENCRYPTION_KEY || process.env.GITHUB_TOKEN_ENCRYPTION_KEY,
  "PROVIDER_TOKEN_ENCRYPTION_KEY"
);

function encrypt(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { encrypted: encrypted.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function decrypt(row, key) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(row.token_iv, "base64"));
  decipher.setAuthTag(Buffer.from(row.token_tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(row.encrypted_access_token, "base64")),
    decipher.final()
  ]).toString("utf8");
}

module.exports = {
  hashToken, safeEqual,
  encryptGitHubToken: t => encrypt(t, githubKey()),
  decryptGitHubToken: row => decrypt(row, githubKey()),
  encryptProviderToken: t => encrypt(t, providerKey()),
  decryptProviderToken: row => decrypt(row, providerKey())
};
