-- 25 Oct 2026 (C9): when the current lock began, so a submission from an EARLIER attempt never tells
-- the helper to unlock a new attempt. Run once (deploy.sh records it; "duplicate column" = in place).
ALTER TABLE locks ADD COLUMN locked_at TEXT;
