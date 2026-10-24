-- 25 Oct 2026: quizzes a professor turned LOCKqz OFF for. Auto-protect never re-protects them.
CREATE TABLE IF NOT EXISTS lockqz_off (ou TEXT, qi TEXT, teacher_id TEXT, at TEXT, PRIMARY KEY (ou, qi));
