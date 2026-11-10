-- DevNexa Cloud Phase 2: multi-provider deployment foundation
-- Run once in Neon SQL Editor. Additive migration; preserves all existing data.
-- NOTE: Netlify included from the start (was previously added in phase0-hardening).

CREATE TABLE IF NOT EXISTS provider_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('vercel', 'cloudflare', 'netlify')),
  account_id TEXT,
  account_label TEXT,
  encrypted_access_token TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  token_tag TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, provider)
);

-- Idempotent upgrade for existing installs that had the 2-provider check.
ALTER TABLE provider_connections DROP CONSTRAINT IF EXISTS provider_connections_provider_check;
ALTER TABLE provider_connections
  ADD CONSTRAINT provider_connections_provider_check
  CHECK (provider IN ('vercel', 'cloudflare', 'netlify'));

CREATE INDEX IF NOT EXISTS provider_connections_user_idx
  ON provider_connections(user_id);

CREATE TABLE IF NOT EXISTS deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('vercel', 'cloudflare', 'netlify')),
  provider_project_id TEXT,
  provider_project_name TEXT,
  provider_deployment_id TEXT,
  deployment_url TEXT,
  branch TEXT NOT NULL DEFAULT 'main',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'building', 'ready', 'error', 'canceled', 'unknown')),
  error_message TEXT,
  provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent upgrade for existing installs.
ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_provider_check;
ALTER TABLE deployments ADD CONSTRAINT deployments_provider_check
  CHECK (provider IN ('vercel', 'cloudflare', 'netlify'));

CREATE INDEX IF NOT EXISTS deployments_project_idx
  ON deployments(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deployments_user_idx
  ON deployments(user_id, created_at DESC);

-- Idempotency support (was in phase0-hardening).
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS deployments_idempotency_idx
  ON deployments(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;