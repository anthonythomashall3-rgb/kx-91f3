-- LOCKqz D1 schema.  Apply:  wrangler d1 execute lockqz --file=schema.sql --remote
CREATE TABLE IF NOT EXISTS devices (
  device_id   TEXT PRIMARY KEY,
  student     TEXT,
  platform    TEXT,
  version     TEXT,
  installed_at TEXT,
  last_seen   TEXT
);

-- qi = the Brightspace quiz-id parsed from the pasted link (auto-detect, no title tag).
CREATE TABLE IF NOT EXISTS quizzes (
  quiz_id   TEXT PRIMARY KEY,
  title     TEXT,
  url       TEXT,
  password  TEXT,
  created_at TEXT,
  qi        TEXT,
  teacher_id TEXT,
  lock_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_quizzes_qi ON quizzes(qi);

-- Protect a whole course once: one password for every quiz in it. ou = course-id.
CREATE TABLE IF NOT EXISTS courses (
  ou        TEXT PRIMARY KEY,
  title     TEXT,
  password  TEXT,
  created_at TEXT,
  teacher_id TEXT
);

-- Every lock / unlock / heartbeat / tamper / auto_unlock / install event.
CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT,
  student   TEXT,
  quiz_id   TEXT,
  event     TEXT,
  detail    TEXT,
  ts        TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_quiz ON events(quiz_id);
CREATE INDEX IF NOT EXISTS idx_events_dev  ON events(device_id);

-- Current live lock per device+quiz. last_lock is refreshed by lock + quiz-time
-- heartbeats; the password is released only while it is fresh, and the live monitor
-- flags "went dark" when it goes stale during an active quiz. helper_seen/ext_seen let
-- the monitor say specifically whether the HELPER was killed vs the browser closed.
CREATE TABLE IF NOT EXISTS locks (
  device_id TEXT,
  quiz_id   TEXT,
  last_lock TEXT,
  helper_seen TEXT,
  ext_seen  TEXT,
  PRIMARY KEY (device_id, quiz_id)
);

-- Teacher accounts (email + password; token = session). TEACHER_KEY stays the admin master key.
CREATE TABLE IF NOT EXISTS teachers (
  id        TEXT PRIMARY KEY,
  email     TEXT UNIQUE,
  name      TEXT,
  pw_hash   TEXT,
  salt      TEXT,
  token     TEXT,
  created_at TEXT,
  role      TEXT,
  active_until TEXT
);
CREATE INDEX IF NOT EXISTS idx_teachers_token ON teachers(token);

-- Invite-only teacher sign-up: the admin creates a one-time code; sign-up needs it.
CREATE TABLE IF NOT EXISTS invites (
  code         TEXT PRIMARY KEY,
  email        TEXT,
  active_until TEXT,
  created_at   TEXT,
  used_at      TEXT,
  used_by      TEXT
);
