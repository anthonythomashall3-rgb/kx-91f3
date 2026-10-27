-- 27 Oct 2026: professor zero-effort pass.
-- mail_sent: one row per class per kind per day -- kind 'all' / 'missing' (dashboard "Email students"),
-- 'r48:<qi>' / 'r3:<qi>' (automatic reminders 48 h / 3 h before an exam), 'ck:<qi>' (T-70 professor
-- check-in). The daily cap (400) sums n over the day so Gmail's 500/day always leaves room for codes.
CREATE TABLE IF NOT EXISTS mail_sent (ou TEXT NOT NULL, kind TEXT NOT NULL, day TEXT NOT NULL, n INTEGER, at TEXT, PRIMARY KEY (ou, kind, day));
CREATE INDEX IF NOT EXISTS idx_mail_sent_day ON mail_sent(day);
-- class_mail: a class the professor turned automatic reminders OFF for (no row = on).
CREATE TABLE IF NOT EXISTS class_mail (ou TEXT PRIMARY KEY, reminders INTEGER DEFAULT 1, teacher_id TEXT, at TEXT);
-- teachers.ext_seen: when the professor's browser extension last checked in (/ext-seen, every few hours).
ALTER TABLE teachers ADD COLUMN ext_seen TEXT;
