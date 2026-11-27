-- 27 Nov 2026: what Brightspace answered when it did not take LOCKqz's change to an exam (its password on or off).
-- Set by /sync-result (status "error"), cleared when Brightspace takes the change or the professor changes the switch.
-- The dashboard shows "Brightspace refused" for that exam (the reason on hover) instead of waiting for it.
ALTER TABLE bs_quizzes ADD COLUMN sync_err TEXT;
