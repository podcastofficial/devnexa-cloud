// Lazy Neon wrapper so tests can inject a fake implementation (sql.setImpl).
const { HttpError } = require("./http");
let impl = null;

function getImpl() {
  if (!impl && process.env.DATABASE_URL) {
    const { neon } = require("@neondatabase/serverless");
    impl = neon(process.env.DATABASE_URL);
  }
  return impl;
}

function sql(strings, ...values) {
  const fn = getImpl();
  if (!fn) throw new HttpError(500, "DATABASE_URL is not configured");
  return fn(strings, ...values);
}
sql.setImpl = fn => { impl = fn; };
sql.isConfigured = () => Boolean(getImpl());

module.exports = sql;
