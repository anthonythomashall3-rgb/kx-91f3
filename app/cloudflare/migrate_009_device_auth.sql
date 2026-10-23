-- Device authentication (23 Oct 2026): per-install keys sign device reports and password
-- requests, so a script that never installed LOCKqz cannot fake a lock. Apply once;
-- re-running reports "duplicate column" = already applied.
ALTER TABLE devices ADD COLUMN device_key TEXT;
ALTER TABLE devices ADD COLUMN registered_at TEXT;
ALTER TABLE devices ADD COLUMN reg_ip TEXT;
ALTER TABLE devices ADD COLUMN revoked INTEGER DEFAULT 0;
ALTER TABLE locks ADD COLUMN signed INTEGER DEFAULT 0;
