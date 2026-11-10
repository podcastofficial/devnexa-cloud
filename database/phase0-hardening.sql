-- DevNexa Cloud Phase 0/2: allow Netlify deployments + idempotency. Additive; run once in Neon SQL Editor.
ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_provider_check;
ALTER TABLE deployments ADD CONSTRAINT deployments_provider_check
  CHECK (provider IN ('vercel', 'cloudflare', 'netlify'));

ALTER TABLE deployments ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS deployments_idempotency_idx
  ON deployments(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
