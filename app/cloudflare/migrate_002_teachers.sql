-- One-time migration for databases created before teacher accounts (22 Oct 2026).
ALTER TABLE quizzes ADD COLUMN teacher_id TEXT;
ALTER TABLE quizzes ADD COLUMN lock_id TEXT;
ALTER TABLE courses ADD COLUMN teacher_id TEXT;
