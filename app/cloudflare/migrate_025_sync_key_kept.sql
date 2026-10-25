-- 25 Oct 2026 (I-M2/I-M6): 1 = the Sync key survived a password reset/change only because a gate was
-- running; it is cleared when that professor's last gate stops.
ALTER TABLE teachers ADD COLUMN sync_key_kept INTEGER DEFAULT 0;
