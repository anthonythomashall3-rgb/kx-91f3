-- 25 Oct 2026: server-confirmed Brightspace submissions. The professor's Sync tab (a trusted
-- Brightspace session the student cannot forge) reports which students have actually submitted the
-- quiz attempt. Only then is a device's "unlock" counted as a clean "done"; an unlock with no
-- confirmed submission is flagged and the gate revokes access. Closes the "force an unlock to get AI,
-- then show up as a normal submit" hole, since the submit itself must be real.
CREATE TABLE IF NOT EXISTS submissions (ou TEXT, qi TEXT, user_id TEXT, at TEXT, PRIMARY KEY (ou, qi, user_id));
