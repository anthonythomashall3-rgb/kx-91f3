-- 25 Oct 2026: a student's email is bound to a device only after they type the 6-digit code
-- LOCKqz emailed to that address (proves they own it: no typos, no classmate's email).
CREATE TABLE IF NOT EXISTS email_codes (device_id TEXT PRIMARY KEY, email TEXT, code_hash TEXT, expires INTEGER, tries INTEGER DEFAULT 0, created_at TEXT);
ALTER TABLE devices ADD COLUMN student_verified INTEGER DEFAULT 0;
