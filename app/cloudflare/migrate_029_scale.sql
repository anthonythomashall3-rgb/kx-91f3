-- 26 Oct 2026: D1 row budget (Free plan: 5M rows read / 100k written per day). Run once (deploy.sh
-- records it; "duplicate column" = already in place, as on a database made from the new schema.sql).
-- locks carries a copy of the device's student / platform / student_verified, so /live reads only the
-- lock rows (no devices join: -1 row per locked student per call). Same row as the lock: no extra write.
ALTER TABLE locks ADD COLUMN student TEXT;
ALTER TABLE locks ADD COLUMN platform TEXT;
ALTER TABLE locks ADD COLUMN sv INTEGER;
UPDATE locks SET (student, platform, sv) = (SELECT d.student, d.platform, COALESCE(d.student_verified,0) FROM devices d WHERE d.device_id=locks.device_id) WHERE sv IS NULL AND EXISTS (SELECT 1 FROM devices d WHERE d.device_id=locks.device_id);
CREATE TABLE IF NOT EXISTS roster_snap (ou TEXT PRIMARY KEY, hash TEXT, rows TEXT, at TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS bsq_hash (ou TEXT PRIMARY KEY, hash TEXT, own TEXT) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_bsq_orig ON bs_quizzes(ou, qi) WHERE orig IS NOT NULL;
-- Rate-limit index made PARTIAL: only the account/rate-limit events are read by (event, ts), and every
-- query for them repeats this exact IN list (RL_EV in the API). Lock/unlock/install/password events then
-- write one index row less each.
DROP INDEX IF EXISTS idx_events_event_ts;
CREATE INDEX IF NOT EXISTS idx_events_event_ts ON events(event, ts) WHERE event IN ('login_fail','pay_code_new','pay_start','pay_stripe','pay_bank','signup','stripe_sess','code_sent','code_send_failed','reset_request','email_verified');
