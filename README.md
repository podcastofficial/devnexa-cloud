# DevNexa Cloud — Phase 1–4

Telegram-first project dashboard starter using Node.js, Neon PostgreSQL and Vercel.

## Included

- Telegram Mini App authentication with server-side `initData` HMAC validation.
- Hashed bearer sessions stored in PostgreSQL (30-day expiry).
- User dashboard and project CRUD. Free plan limit: 2 active projects.
- Admin dashboard restricted by `ADMIN_TELEGRAM_IDS`.
- Basic audit logging. Single API entry point: `api/index.js`.
- GitHub OAuth (public repos) + repo linking per project.
- Vercel / Cloudflare Pages / Netlify provider connections and deployments.
- AI Gateway (free-first platform mode + BYOK + per-plan quota ledger).
- Shared (DB-backed) rate limiting with in-memory fallback.
- Hourly cron cleanup of expired sessions, OAuth states and rate-limit rows.

## Requirements

- Node.js 20+
- Telegram bot created with @BotFather
- Neon PostgreSQL database
- GitHub repository
- Vercel account

## 1. Database setup (run migrations in this order)

In Neon SQL Editor, run **all** of the following **once, in order**:

1. `database/schema.sql` — base tables (users, sessions, projects, audit_logs)
2. `database/github-oauth.sql` — GitHub OAuth states + connections
3. `database/phase2-deployments.sql` — provider connections + deployments (Netlify included)
4. `database/phase3-ai-gateway.sql` — AI BYOK keys + usage ledger
5. `database/phase4-ratelimit.sql` — shared rate-limit table
6. `database/phase4-project-branch.sql` — `projects.default_branch`

> `database/phase0-hardening.sql` is kept for older installs; on a fresh install it is redundant (phase2 already includes its changes).

## 2. Configure Telegram

1. Open @BotFather → `/newbot`.
2. Set a Mini App URL / menu button to your deployed HTTPS URL.
3. Copy the bot token. Never put it in frontend code.

Telegram Web App auth only works when opened through the configured Mini App. Browser preview login is intentionally disabled.

## 3. Configure GitHub OAuth

In GitHub: Settings → Developer settings → OAuth Apps → New OAuth App.

- Homepage URL: your deployed HTTPS URL
- Authorization callback URL: `https://YOUR-DOMAIN/api/github/callback`

Generate a 32-byte encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"