-- DevNexa Cloud: GitHub OAuth migration
-- Run this migration ONCE in Neon SQL Editor before deploying the GitHub integration.

CREATE TABLE IF NOT EXISTS github_oauth_states (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS github_oauth_states_expiry_idx
  ON github_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS github_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  github_user_id BIGINT NOT NULL,
  github_login TEXT NOT NULL,
  avatar_url TEXT,
  encrypted_access_token TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  token_tag TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS github_connections_login_idx
  ON github_connections(github_login);

-- Expired one-time OAuth states can be cleaned periodically.
DELETE FROM github_oauth_states WHERE expires_at < NOW();
