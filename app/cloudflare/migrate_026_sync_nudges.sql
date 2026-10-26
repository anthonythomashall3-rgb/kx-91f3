-- A student opened a quiz LOCKqz has never seen: its professor was emailed once (see nudgeUnsynced).
CREATE TABLE IF NOT EXISTS sync_nudges (ou TEXT, qi TEXT, at TEXT, PRIMARY KEY (ou, qi));
