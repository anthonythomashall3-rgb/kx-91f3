-- 25 Oct 2026 (C3): the professor's own Brightspace settings saved before LOCKqz first changed the
-- quiz, as JSON {"pw": "<their password>"|null, "hidden": true|false}; restored on release.
ALTER TABLE bs_quizzes ADD COLUMN orig TEXT;
