-- 24 Oct 2026: special-access users that existed BEFORE the gate started (accommodations: extended
-- time, other dates). The gate never changes or removes them. JSON array of Brightspace user ids.
ALTER TABLE quizzes ADD COLUMN sa_keep TEXT;
