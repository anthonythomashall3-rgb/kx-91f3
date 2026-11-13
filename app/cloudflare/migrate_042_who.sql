-- Several schools on one site: which school a computer, a professor's sign-in or a Sync key belongs to.
-- Hashes only for sign-ins and keys. Kept in the first school's database; empty while there is one school.
CREATE TABLE IF NOT EXISTS who (kind TEXT NOT NULL, k TEXT NOT NULL, school TEXT NOT NULL, at TEXT, PRIMARY KEY (kind, k)) WITHOUT ROWID;
