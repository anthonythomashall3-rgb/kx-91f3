-- 31 Oct 2026: Google sign-in for a computer's one-time setup. One row per sign-in link (n = one-time
-- nonce, also the ID token's nonce); done = the email was confirmed. Rows older than a day are removed.
CREATE TABLE IF NOT EXISTS gsign (n TEXT PRIMARY KEY, device_id TEXT NOT NULL, at TEXT NOT NULL, email TEXT, done INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_gsign_dev_at ON gsign(device_id, at);
CREATE INDEX IF NOT EXISTS idx_gsign_at ON gsign(at);
