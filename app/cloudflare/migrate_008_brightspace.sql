-- Brightspace connector (23 Oct 2026): courses a teacher synced, class lists, quizzes,
-- and LOCKqz passwords waiting to be removed from Brightspace. Safe to re-run.
CREATE TABLE IF NOT EXISTS teacher_courses (teacher_id TEXT, ou TEXT, name TEXT, code TEXT, role TEXT, synced_at TEXT, PRIMARY KEY (teacher_id, ou));
CREATE TABLE IF NOT EXISTS roster (ou TEXT, user_id TEXT, name TEXT, email TEXT, username TEXT, org_id TEXT, role TEXT, synced_at TEXT, PRIMARY KEY (ou, user_id));
CREATE INDEX IF NOT EXISTS idx_roster_email ON roster(email);
CREATE TABLE IF NOT EXISTS bs_quizzes (ou TEXT, qi TEXT, name TEXT, active INTEGER, start_date TEXT, end_date TEXT, due_date TEXT, bs_has_password INTEGER, bs_password_is_ours INTEGER, synced_at TEXT, PRIMARY KEY (ou, qi));
CREATE TABLE IF NOT EXISTS pending_clear (ou TEXT, qi TEXT, password TEXT, PRIMARY KEY (ou, qi));
