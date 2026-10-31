-- 31 Oct 2026: students a professor lets into an exam without LOCKqz (no computer that runs it, a broken
-- laptop). The professor's gate gives them Brightspace special access like an accommodation; the professor
-- reads them the current code. One row per exam and student; removed by the professor.
CREATE TABLE IF NOT EXISTS letin (ou TEXT NOT NULL, qi TEXT NOT NULL, email TEXT NOT NULL, user_id TEXT, by_teacher TEXT, at TEXT, PRIMARY KEY (ou, qi, email));
