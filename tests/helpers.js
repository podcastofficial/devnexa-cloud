const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

process.env.TELEGRAM_BOT_TOKEN = "123456:TEST_BOT_TOKEN";
process.env.GITHUB_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.DATABASE_URL = "postgres://fake";

function mockReq(method, url, { headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method; req.url = url; req.headers = headers;
  req.destroy = () => {};
  process.nextTick(() => { if (body !== undefined) req.emit("data", JSON.stringify(body)); req.emit("end"); });
  return req;
}
function mockRes() {
  return { statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
}
async function call(handler, method, url, opts) {
  const res = mockReslast_nameit handler(mockReq(method, url, opts), res);
  return res;
}
function signedInitData(user, { authDate = Math.floor(Date.now() / 1000), token = process.env.TELEGRAM_BOT_TOKEN } = {}) {
  const p = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify(user), query_id: "AAA" });
  const dcs = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  p.set("hash", crypto.createHmac("sha256", secret).update(dcs).digest("hex"));
  return p.toString();
}
// Fake tagged-template DB: handlers is [[regex-on-sql-text, rowsOrFn], ...]
function fakeSql(handlers, log = []) {
  return (strings, ...vals) => {
    const text = strings.join("?").replace(/\s+/g, " ");
    log.push({ text, vals });
    for (const [re, out] of handlers) if (re.test(text)) return Promise.resolve(typeof out === "function" ? out(vals, text) : out);
    return Promise.resolve([]);
  };
}
module.exports = { call, signedInitData, fakeSql, mockReq, mockRes };
