-- 22 Nov 2026: Brightspace's own quiz-submission emails. Each protected quiz's Notification Email carries LOCKqz's
-- address for it (sync.js); LOCKqz's Email Worker (app/mailin) hands each email to POST /mailin, and mailinRun reads
-- it into submissions. The text stays only when no student was found in it, 14 days at most (purgeStmts).
CREATE TABLE IF NOT EXISTS mailin (id INTEGER PRIMARY KEY AUTOINCREMENT, ou TEXT, qi TEXT, at TEXT NOT NULL, sender TEXT, subject TEXT, body TEXT, state TEXT NOT NULL DEFAULT 'new', user_id TEXT);
CREATE INDEX IF NOT EXISTS idx_mailin_new ON mailin(state, ou, qi) WHERE state='new';
