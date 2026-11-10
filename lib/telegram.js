const crypto = require("node:crypto");
const { safeEqual } = require("./crypto");
const { HttpError } = require("./http");

function verifyTelegramInitData(initData) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  if (typeof initData !== "string" || !initData || initData.length > 10000) {
    throw new HttpError(401, "Missing or invalid Telegram initData");
  }
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) throw new HttpError(401, "Telegram signature is missing");

  params.delete("hash");
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculated = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (!safeEqual(calculated, receivedHash)) throw new HttpError(401, "Telegram signature verification failed");

  const authDate = Number(params.get("auth_date"));
  const maxAge = Number(process.env.TELEGRAM_AUTH_MAX_AGE || 86400);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authDate) || authDate > now + 60 || now - authDate > maxAge) {
    throw new HttpError(401, "Telegram login data has expired. Reopen the Mini App.");
  }
  let user;
  try { user = JSON.parse(params.get("user") || ""); }
  catch { throw new HttpError(401, "Telegram user data is invalid"); }
  if (!user || !/^\d+$/.test(String(user.id)) || !user.first_name) {
    throw new HttpError(401, "Telegram user information is incomplete");
  }
  return user;
}

module.exports = { verifyTelegramInitData };
