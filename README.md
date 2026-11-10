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


## GitHub OAuth integration (Phase 1 extension)

### Required Neon migration

Run `database/github-oauth.sql` once in Neon SQL Editor. This is additive and does not modify or delete existing user/project data.

### Create a GitHub OAuth App

In GitHub: Settings → Developer settings → OAuth Apps → New OAuth App.

Use:
- Application name: DevNexa Cloud
- Homepage URL: your deployed DevNexa Cloud HTTPS URL
- Authorization callback URL: `https://YOUR-DEPLOYMENT-DOMAIN/api/github/callback`

The callback URL must exactly match `GITHUB_CALLBACK_URL` in Vercel.

### Generate encryption key

Generate a 32-byte key encoded as Base64. For example, in Node.js:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Keep the output private. If you lose or change this key, existing encrypted GitHub tokens cannot be decrypted; users will need to reconnect GitHub.

### Add Vercel environment variables

- `GITHUB_CLIENT_ID`: OAuth App client ID
- `GITHUB_CLIENT_SECRET`: OAuth App client secret
- `GITHUB_CALLBACK_URL`: exact callback URL above
- `GITHUB_TOKEN_ENCRYPTION_KEY`: Base64-encoded 32-byte key

Never put the client secret or encryption key in frontend code or GitHub.

### OAuth permission scope and current limitation

This first OAuth integration requests `read:user` only and lists public repositories visible to the authenticated account. Private repositories are intentionally not requested in this version. For private repository access and production-grade least-privilege repository permissions, implement a GitHub App with explicit read-only Contents/Metadata permissions in a later iteration.

### User flow

1. User opens Profile in the Telegram Mini App.
2. Selects Connect GitHub.
3. GitHub authorization opens.
4. GitHub redirects to `/api/github/callback`.
5. The backend validates one-time state, exchanges the code, fetches GitHub identity and encrypts the access token using AES-256-GCM.
6. User returns to DevNexa Cloud and opens Profile again.
7. Open a project → Details → select a public repository → Connect selected repository.

The callback completes in the browser opened by Telegram. Depending on Telegram/device behavior, the user may need to return to the Telegram chat and reopen the Mini App after authorization.

### Added API routes

| Method | Route | Auth | Purpose |
|---|---|---|---|
| GET | `/api/github/callback` | OAuth state | Complete GitHub OAuth |
| GET | `/api/github/connect` | Bearer | Start OAuth and return authorization URL |
| GET | `/api/github/status` | Bearer | Show connected GitHub account |
| GET | `/api/github/repos` | Bearer | List public repositories |
| POST | `/api/github/disconnect` | Bearer | Remove stored GitHub connection |
| GET | `/api/projects/:id` | Bearer | Project details |
| POST | `/api/projects/:id/connect-repo` | Bearer | Attach selected public repository |

GitHub connection stores an encrypted OAuth token server-side. The raw token is never returned to the frontend. This integration links repositories only; automatic builds/deployments are a separate Phase 2 feature.


## Phase 0 / Netlify update

### Run this migration (Neon SQL Editor, once)
`database/phase0-hardening.sql` — allows `netlify` in `deployments.provider` and adds idempotency keys.

### Code layout
- `api/index.js` — thin router
- `routes/` — auth, github, providers, deployments, projects, admin
- `lib/` — http, db, crypto, telegram, auth, github, validate, ratelimit
- `lib/providers/` — one adapter per provider (`verify`, `deploy`, `refresh`) + status normalization
- `tests/` — `npm test` (Node built-in runner, no extra dependencies; DB and provider APIs are mocked)

### Fixed
- Cloudflare `failure` was shown as "queued"; a finished build stage was treated as "live" — now only the deploy stage counts.
- Vercel `gitSource.type` corrected to `github` (+ `ref`).
- Cloudflare build command / output folder are now configurable instead of hardcoded `dist`.
- Invalid or expired provider tokens return clear 400/409 messages instead of 500.
- Duplicate deploy protection (in-flight check + optional `Idempotency-Key` header).
- In-memory rate limits on login, provider connect, deploy, refresh (per-instance only — move to a shared store before public launch).

### Netlify deploy = direct static deploy
Reads a public repo (optionally one folder such as `dist`/`public`) via the GitHub API and uploads it with Netlify's file-digest deploy. Requires `index.html`; limits: 150 files, 5 MB/file, 8 MB total. **No build step** — build-based deploys need the isolated worker (Phase 4).

### Still unverified against live APIs (tested with mocks only)
Run one real deploy per provider with a throwaway repo and token before calling any provider "supported".


## Phase 3 — AI Gateway

### Run migration (Neon SQL Editor, once)
`database/phase3-ai-gateway.sql` → tables `ai_keys` (encrypted BYOK keys) and `usage_ledger` (metering only; **prompts/answers are not stored**).

### Environment variables
Free/platform models are used only for providers whose key is set (all optional):
- `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`
- `AI_PLATFORM_ORDER` — fallback order, default `groq,gemini,openrouter`
- `AI_MODEL_GROQ`, `AI_MODEL_GEMINI`, `AI_MODEL_OPENROUTER`, `AI_MODEL_OPENAI`, `AI_MODEL_ANTHROPIC` — override default model names. **Free tiers and model names change; check each provider's current free-tier model and terms (including commercial use) before launch.**
- `AI_TIMEOUT_MS` — per-provider timeout, default 20000 (`vercel.json` sets maxDuration 30).
- BYOK keys reuse `PROVIDER_TOKEN_ENCRYPTION_KEY` (or `GITHUB_TOKEN_ENCRYPTION_KEY`).

### Behaviour
- **Platform mode:** tries providers in order, skips ones in cooldown, falls back on 429/5xx/timeouts/bad platform key. A failed request does not consume allowance.
- **Quota (free / developer / pro):** 20 / 100 / 300 requests per day (UTC) and 60k / 600k / 2M tokens per month, max output 800 / 2000 / 4000 tokens. Reserved atomically per user (advisory lock) before the call, settled with real token counts after. Constants in `lib/ai/quota.js` — indicative only; set after measuring real costs.
- **BYOK:** OpenAI, Anthropic, Groq, Gemini, OpenRouter. Key verified on save, AES-256-GCM encrypted, never returned (only last 4 chars). Not metered against the free allowance.
- **Safety:** prompts containing obvious secrets (API keys, private keys, DB URLs) are rejected; fixed server-side system prompt treats user content as untrusted; provider errors are redacted of keys.

### API
| Method | Route | Purpose |
|---|---|---|
| GET | `/api/ai/status` | Platform availability, saved key providers, quota usage |
| GET | `/api/ai/usage` | Last 20 ledger rows |
| POST | `/api/ai/keys` | Verify + save BYOK key |
| POST | `/api/ai/keys/remove` | Delete BYOK key |
| POST | `/api/ai/chat` | `{mode: "platform"|"byok", provider?, messages[], max_tokens?}` |

Non-streaming for now. Rate limits are in-memory per instance (move to a shared store before public launch).
