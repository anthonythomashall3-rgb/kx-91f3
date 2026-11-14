-- 13 Nov 2026: one counter row per address per hour for the busy public steps (install, pay page, card checkout,
-- new pay code). Counting costs one row however many people are doing the same step in that hour.
CREATE TABLE IF NOT EXISTS rl (k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_rl_at ON rl(at);
