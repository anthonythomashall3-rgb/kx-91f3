-- Unique Zelle amount per unpaid student per term ($fee + cents/100), so a Zelle with no memo still says who paid.
CREATE TABLE IF NOT EXISTS pay_slots (term TEXT NOT NULL, cents INTEGER NOT NULL, code TEXT NOT NULL, at TEXT, PRIMARY KEY (term, cents), UNIQUE (term, code));
