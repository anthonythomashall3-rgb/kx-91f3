-- 27 Oct 2026: "was protected" must be proven, never assumed.
-- prot_at: when Brightspace confirmed LOCKqz's password went ON the quiz; unprot_at: when it came OFF.
-- A past exam is labelled protected only if prot_at <= its start and unprot_at is empty or after its end.
-- Rows from before this migration have no prot_at, so they are never claimed as protected.
ALTER TABLE bs_quizzes ADD COLUMN prot_at TEXT;
ALTER TABLE bs_quizzes ADD COLUMN unprot_at TEXT;
