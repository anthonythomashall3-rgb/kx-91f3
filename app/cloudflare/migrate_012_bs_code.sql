-- 24 Oct 2026: the exact password the professor's Sync tab last wrote into Brightspace for a gated
-- quiz. Students are given THIS (never a computed code), so a closed/asleep Sync tab can never cause
-- a password mismatch. Apply once; "duplicate column" = already applied.
ALTER TABLE quizzes ADD COLUMN bs_code TEXT;
