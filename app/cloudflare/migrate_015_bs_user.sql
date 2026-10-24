-- 25 Oct 2026: the teacher's own Brightspace user id (from whoami), captured on first sync. A teacher
-- is verified only if a trusted roster lists their email as Instructor AND with this same user id, so a
-- different person cannot pre-register someone else's email and later verify as them.
ALTER TABLE teachers ADD COLUMN bs_user_id TEXT;
