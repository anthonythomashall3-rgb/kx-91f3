-- 20 Nov 2026: a Zelle or Venmo with no memo is matched by the payer's name (PAY_NAME_MATCH). nkey is the
-- "first|last" (lower case) of the name Brightspace has for a student who has a pay code, written the first
-- time that student's pay page is asked for, so a payment finds its student by index.
CREATE TABLE IF NOT EXISTS pay_names (email TEXT PRIMARY KEY, nkey TEXT) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_pay_names_nkey ON pay_names(nkey);
