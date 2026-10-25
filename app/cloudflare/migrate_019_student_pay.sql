-- Student fee ($5 per semester) + automatic payment matching (Venmo/Zelle alert emails -> /api/pay/notify).
CREATE TABLE IF NOT EXISTS pay_codes_students (email TEXT PRIMARY KEY, code TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS payments (
  txn TEXT PRIMARY KEY, code TEXT, amount REAL, via TEXT, payer TEXT, note TEXT, term TEXT, received_at TEXT, matched TEXT
);
CREATE INDEX IF NOT EXISTS payments_code ON payments (code, term);
