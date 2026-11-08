-- 8 Nov 2026: one reminder email to pay, to a student whose LOCKqz is installed but unpaid a couple of hours later.
-- One row per email (sent = 1 emailed, 0 = already paid when checked): never emailed twice.
CREATE TABLE IF NOT EXISTS pay_nudge (email TEXT PRIMARY KEY, at TEXT NOT NULL, sent INTEGER DEFAULT 1);
