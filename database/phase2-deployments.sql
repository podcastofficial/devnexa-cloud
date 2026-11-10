-- DevNexa Cloud Phase 2: multi-provider deployment foundation
-- Run once in Neon SQL Editor. Additive migration; preserves all existing data.

CREATE TABLE IF NOT EXISTS provider_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('vercel', 'cloudflare')),
  account_id TEXT,
  account_label TEXT,
  encrypted_access_token TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  token_tag TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, provider)
);

CREATE INDEX IF NOT EXISTS provider_connections_user_idx
  ON provider_connections(user_id);

CREATE TABLE IF NOT EXISTS deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('vercel', 'cloudflare')),
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

CREATE INDEX IF NOT EXISTS deployments_project_idx
  ON deployments(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deployments_user_idx
  ON deployments(user_id, created_at DESC);
