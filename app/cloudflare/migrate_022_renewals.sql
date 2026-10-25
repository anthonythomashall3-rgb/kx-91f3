-- Renewal emails: who opted out, and who was already reminded for a term.
CREATE TABLE IF NOT EXISTS renew_optout (email TEXT PRIMARY KEY, at TEXT);
CREATE TABLE IF NOT EXISTS renew_sent (email TEXT NOT NULL, term TEXT NOT NULL, at TEXT, PRIMARY KEY (email, term));
