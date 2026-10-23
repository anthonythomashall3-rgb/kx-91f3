-- Live access gate + teacher self-verification (23 Oct 2026). Apply once; "duplicate column" = already applied.
-- gated: the quiz is hidden to everyone except students LOCKqz is actively locking (AllowOnlyUsersWithSpecialAccess).
-- verified: a teacher who proved, through their OWN Brightspace login (LOCKqz Sync), that they are an instructor/TA.
ALTER TABLE quizzes ADD COLUMN gated INTEGER DEFAULT 0;
ALTER TABLE teachers ADD COLUMN verified INTEGER DEFAULT 0;
