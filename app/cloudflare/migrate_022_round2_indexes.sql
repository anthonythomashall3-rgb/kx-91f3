-- 25 Oct 2026 (round-2 audit, I-B2/I-B3/H11/H15). Safe to re-run (every statement is idempotent).
-- I-B2: /password's developer-mode check and release de-dup read events by (device_id, quiz_id, event);
-- with only events(event, ts) the planner scanned every 'lock'/'password_released' row of the day.
-- The live monitor reads events by (quiz_id, event). The two composite indexes replace the old
-- single-column ones (same number of indexes = same rows written per event).
CREATE INDEX IF NOT EXISTS idx_events_dev_quiz ON events(device_id, quiz_id, event);
CREATE INDEX IF NOT EXISTS idx_events_quiz_ev ON events(quiz_id, event);
DROP INDEX IF EXISTS idx_events_dev;
DROP INDEX IF EXISTS idx_events_quiz;
-- The Sync bookmark's key is looked up on every Sync-tab request; the admin's email (developer mode,
-- never listed as a student) on every /live and /bs.
CREATE INDEX IF NOT EXISTS idx_teachers_sync_key ON teachers(sync_key);
CREATE INDEX IF NOT EXISTS idx_teachers_role ON teachers(role);
-- I-B3: /bs finds installed devices by email through devices(student) (emails stored lowercase).
UPDATE devices SET student=lower(student) WHERE student LIKE '%@%' AND student<>lower(student);
UPDATE roster SET email=lower(email) WHERE email IS NOT NULL AND email<>lower(email);
CREATE INDEX IF NOT EXISTS idx_devices_student ON devices(student);
-- H15: students deleted on request (admin /forget); the Sync never imports them again.
CREATE TABLE IF NOT EXISTS forgotten (email TEXT PRIMARY KEY, at TEXT);
-- Expired email codes (never deleted before).
DELETE FROM email_codes WHERE expires < (CAST(strftime('%s','now') AS INTEGER) * 1000 - 86400000);
