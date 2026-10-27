-- Student card auto-renew (27 Oct 2026). One row per student email that paid by card through Checkout
-- (card saved with setup_future_usage=off_session). LOCKqz charges it off-session each new semester
-- (Fall/Spring) from /pay/tick. rterm = the semester the row was last handled for (reminded/charged/paid);
-- state: reminded | pending | paid | failed | skipped. charge_on = the day the charge is due (>= 7 days after
-- the reminder email). Written on a card purchase, a reminder, a charge, a cancel -- never per request.
CREATE TABLE IF NOT EXISTS card_renew (
  email TEXT PRIMARY KEY, customer TEXT, pm TEXT, brand TEXT, last4 TEXT,
  autorenew INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT,
  rterm TEXT, state TEXT, charge_on TEXT, amount INTEGER, reminded_at TEXT,
  tries INTEGER DEFAULT 0, fail_day TEXT, fail_msg TEXT, pi TEXT
);
CREATE INDEX IF NOT EXISTS idx_card_renew_due ON card_renew(autorenew, rterm);
