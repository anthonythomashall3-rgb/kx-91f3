-- 24 Nov 2026: every completion time Brightspace reported for a student's attempts at a quiz (a JSON list of ISO
-- times, oldest first, at most 20), beside `at` (the latest). The live view matches each unlock with the attempt of
-- the lock it ended, so a student who takes an exam twice is never shown as having left the first attempt early.
ALTER TABLE submissions ADD COLUMN ats TEXT;
