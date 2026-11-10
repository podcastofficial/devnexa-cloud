# DevNexa Cloud — Phase 1

Telegram-first project dashboard starter using Node.js, Neon PostgreSQL and Vercel.

## Included in Phase 1

- Telegram Mini App authentication with server-side `initData` HMAC validation.
- Hashed bearer sessions stored in PostgreSQL.
- User dashboard and project CRUD.
- Free plan limit: 2 active projects.
- Admin dashboard restricted by `ADMIN_TELEGRAM_IDS`.
- Basic audit logging.
- Single API entry point: `api/index.js`.

## Requirements

- Node.js 20+
- Telegram bot created with @BotFather
- Neon PostgreSQL database
- GitHub repository
- Vercel account

## 1. Create the database

1. Create a Neon project.
2. Open Neon SQL Editor.
3. Run the complete `database/schema.sql`.
4. Copy the Neon connection string.

## 2. Configure Telegram

1. Open @BotFather.
2. Create a bot using `/newbot`.
3. Set a Mini App URL / menu button to your deployed HTTPS URL.
4. Copy the bot token. Never put it in frontend code.

Telegram Web App authentication only works when opened through the configured Telegram Mini App. Do not add a fake browser login bypass.

## 3. Configure environment variables

In local development create `.env` (do not commit it), or add these in Vercel Project Settings → Environment Variables:

- `DATABASE_URL`: Neon connection string
- `TELEGRAM_BOT_TOKEN`: BotFather token
- `ADMIN_TELEGRAM_IDS`: comma-separated numeric Telegram user IDs, e.g. `123456789`
- `TELEGRAM_AUTH_MAX_AGE`: optional, default `86400`

## 4. Install and run

```bash
npm install
npx vercel dev
```

Open the URL from the Telegram Mini App after configuring the bot URL. Browser-only preview intentionally cannot authenticate.

## 5. Deploy to GitHub + Vercel

```bash
git init
git add .
git commit -m "DevNexa Cloud Phase 1"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/devnexa-cloud.git
git push -u origin main
```

Import the repository in Vercel, add environment variables, and deploy.

## API routes

| Method | Route | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | No | API/database health |
| POST | `/api/auth/telegram` | Telegram initData | Login/register |
| POST | `/api/auth/logout` | Bearer | Revoke session |
| GET | `/api/me` | Bearer | Current user and usage |
| GET | `/api/projects` | Bearer | List own projects |
| POST | `/api/projects` | Bearer | Create project |
| DELETE | `/api/projects/:id` | Bearer | Soft-delete own project |
| GET | `/api/admin/stats` | Admin | Platform statistics |
| GET | `/api/admin/users` | Admin | Recent users |

## Important security notes

- `TELEGRAM_BOT_TOKEN` and `DATABASE_URL` must remain server-side.
- The frontend sends Telegram `initData`; backend validates the HMAC signature and `auth_date`.
- Session tokens are random and only their SHA-256 hashes are stored in the database.
- Every project read/delete is scoped by authenticated `user_id`.
- This is a Phase 1 starter, not yet a production hosting control plane. Do not run untrusted user code in this API.
- Before public launch, add persistent rate limiting, stronger operational monitoring, dependency scanning, backup/restore drills, privacy/terms pages, and a reviewed abuse-response process.
- Neon free-tier quotas and provider terms can change; verify current commercial-use and customer-sharing permissions before reselling or allocating resources.

## Phase 1 limitations

- GitHub URL is stored as project metadata only; deployment is not implemented yet.
- VPS, domain registration, managed database provisioning and payment processing are future phases.
- Admin panel currently provides read-only statistics and user listing.
