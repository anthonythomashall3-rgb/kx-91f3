-- Sync panel <-> dashboard parity (27 Oct 2026).
-- course_off: the professor turned LOCKqz OFF for a whole class (Sync panel or dashboard). Auto-protect
-- skips its new quizzes until the class is turned back on. One row per class, written only on a click.
CREATE TABLE IF NOT EXISTS course_off (ou TEXT PRIMARY KEY, teacher_id TEXT, at TEXT);
-- in_sync = 0: the professor's latest Sync no longer lists this class (ended, hidden, dropped), so the
-- dashboard stops showing it, exactly like the Sync panel. Written only when it changes.
ALTER TABLE teacher_courses ADD COLUMN in_sync INTEGER;
