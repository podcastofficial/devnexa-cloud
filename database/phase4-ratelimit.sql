-- DevNexa Cloud Phase 4: shared rate-limit store.
-- Run once in Neon SQL Editor. Safe to re-run.

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hits INT NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS rate_limits_window_idx
  ON rate_limits(window_start);

-- Optional cleanup: delete windows older than 1 hour (call from cron or manually).
-- DELETE FROM rate_limits WHERE window_start < NOW() - INTERVAL '1 hour';