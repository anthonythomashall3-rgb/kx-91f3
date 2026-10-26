-- LOCKqz D1 schema.  Apply:  wrangler d1 execute lockqz --file=schema.sql --remote
CREATE TABLE IF NOT EXISTS devices (
  device_id   TEXT PRIMARY KEY,
  student     TEXT,
  platform    TEXT,
  version     TEXT,
  installed_at TEXT,
  last_seen   TEXT,
  device_key  TEXT,            -- per-install signing key (set once by /register)
  registered_at TEXT,
  reg_ip      TEXT,
  revoked     INTEGER DEFAULT 0,
  student_verified INTEGER DEFAULT 0   -- 1 = student typed the code emailed to `student`
);
CREATE INDEX IF NOT EXISTS idx_devices_student ON devices(student);   -- /bs: installed devices by email (migrate_022)

-- qi = the Brightspace quiz-id parsed from the pasted link (auto-detect, no title tag).
CREATE TABLE IF NOT EXISTS quizzes (
  quiz_id   TEXT PRIMARY KEY,
  title     TEXT,
  url       TEXT,
  password  TEXT,
  created_at TEXT,
  qi        TEXT,
  teacher_id TEXT,
  lock_id   TEXT,
  ou        TEXT,
  gated     INTEGER DEFAULT 0,  -- quiz hidden to all but LOCKqz-locked students (AllowOnlyUsersWithSpecialAccess)
  bs_code   TEXT,                -- exact password last written into Brightspace for a gated quiz (migrate_012)
  sa_keep   TEXT                 -- JSON: special-access user ids that pre-date the gate (accommodations; migrate_013)
);
-- Quizzes a professor turned LOCKqz OFF for; auto-protect never re-adds them (migrate_014).
CREATE TABLE IF NOT EXISTS lockqz_off (ou TEXT, qi TEXT, teacher_id TEXT, at TEXT, PRIMARY KEY (ou, qi));
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
CREATE INDEX IF NOT EXISTS idx_events_dev_quiz ON events(device_id, quiz_id, event);   -- /password (migrate_022)
CREATE INDEX IF NOT EXISTS idx_events_quiz_ev ON events(quiz_id, event);              -- /live, /sessions (migrate_022)
CREATE INDEX IF NOT EXISTS idx_events_event_ts ON events(event, ts);   -- rate limits (login_fail, code_sent ...) (migrate_021)

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
  signed    INTEGER DEFAULT 0, -- 1 = lock proven by a request signed with the device key
  ip        TEXT,              -- device IP at lock (used by the gate to restrict the quiz to locked IPs)
  locked_at TEXT,              -- when this lock began (migrate_023)
  PRIMARY KEY (device_id, quiz_id)
);
CREATE INDEX IF NOT EXISTS idx_locks_quiz ON locks(quiz_id);   -- live monitor (migrate_021)

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
  active_until TEXT,
  sync_key  TEXT,
  verified  INTEGER DEFAULT 0,  -- proven instructor/TA via their own Brightspace login
  bs_user_id TEXT,              -- their own Brightspace user id, bound from a trusted roster at sync (migrate_016)
  vouched   INTEGER DEFAULT 0,  -- 1 = the admin vouched for the account holder (invite / first account); only these can verify (migrate_020)
  sync_key_kept INTEGER DEFAULT 0  -- 1 = sync_key kept through a password reset only because a gate ran (migrate_025)
);
CREATE INDEX IF NOT EXISTS idx_teachers_token ON teachers(token);
CREATE INDEX IF NOT EXISTS idx_teachers_sync_key ON teachers(sync_key);
CREATE INDEX IF NOT EXISTS idx_teachers_role ON teachers(role);

-- Invite-only teacher sign-up: the admin creates a one-time code; sign-up needs it.
CREATE TABLE IF NOT EXISTS invites (
  code         TEXT PRIMARY KEY,
  email        TEXT,
  active_until TEXT,
  created_at   TEXT,
  used_at      TEXT,
  used_by      TEXT
);

-- Brightspace connector (23 Oct 2026): courses a teacher synced, class lists, quizzes,
-- and LOCKqz passwords waiting to be removed from Brightspace. Safe to re-run.
CREATE TABLE IF NOT EXISTS teacher_courses (teacher_id TEXT, ou TEXT, name TEXT, code TEXT, role TEXT, synced_at TEXT, PRIMARY KEY (teacher_id, ou));
CREATE TABLE IF NOT EXISTS roster (ou TEXT, user_id TEXT, name TEXT, email TEXT, username TEXT, org_id TEXT, role TEXT, synced_at TEXT, PRIMARY KEY (ou, user_id));
CREATE INDEX IF NOT EXISTS idx_roster_email ON roster(email);
-- orig = the professor's own settings before LOCKqz changed the quiz: JSON {"pw":..., "hidden":...} (migrate_024)
CREATE TABLE IF NOT EXISTS bs_quizzes (ou TEXT, qi TEXT, name TEXT, active INTEGER, start_date TEXT, end_date TEXT, due_date TEXT, bs_has_password INTEGER, bs_password_is_ours INTEGER, synced_at TEXT, orig TEXT, PRIMARY KEY (ou, qi));
CREATE TABLE IF NOT EXISTS pending_clear (ou TEXT, qi TEXT, password TEXT, PRIMARY KEY (ou, qi));

-- One pending email code per device (hash only; 15 min; 5 tries). See migrate_014.
CREATE TABLE IF NOT EXISTS email_codes (device_id TEXT PRIMARY KEY, email TEXT, code_hash TEXT, expires INTEGER, tries INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS usc_sections (
  term TEXT NOT NULL, section TEXT NOT NULL, course TEXT, title TEXT,
  first TEXT, last TEXT, seats INTEGER, registered INTEGER,
  PRIMARY KEY (term, section, last, first)
);
CREATE INDEX IF NOT EXISTS usc_sections_name ON usc_sections (last, first);
CREATE TABLE IF NOT EXISTS paid_sections (
  teacher_id TEXT NOT NULL, term TEXT NOT NULL, section TEXT NOT NULL, course TEXT,
  first TEXT, last TEXT, until TEXT, paid_at TEXT, via TEXT,
  PRIMARY KEY (teacher_id, term, section)
);
CREATE TABLE IF NOT EXISTS pay_codes (teacher_id TEXT PRIMARY KEY, code TEXT UNIQUE);

-- Server-confirmed Brightspace submissions (migrate_017): a trusted Sync session reports who
-- actually submitted, so a forced client unlock cannot masquerade as a clean submit.
-- at = Brightspace's completion time when the Sync tab sends it (C5), else when it was reported.
CREATE TABLE IF NOT EXISTS submissions (ou TEXT, qi TEXT, user_id TEXT, at TEXT, PRIMARY KEY (ou, qi, user_id));
CREATE TABLE IF NOT EXISTS pay_codes_students (email TEXT PRIMARY KEY, code TEXT UNIQUE);
-- Students deleted on request (admin /forget): the Sync never imports their class-list rows again (migrate_022).
CREATE TABLE IF NOT EXISTS forgotten (email TEXT PRIMARY KEY, at TEXT);
-- matched: NULL = counts; 'review' = alert the script could not read (admin assigns it); 'void' = voided.
CREATE TABLE IF NOT EXISTS payments (
  txn TEXT PRIMARY KEY, code TEXT, amount REAL, via TEXT, payer TEXT, note TEXT, term TEXT, received_at TEXT, matched TEXT
);
CREATE INDEX IF NOT EXISTS payments_code ON payments (code, term);

-- One row (one password) per Brightspace quiz. Kept LAST: on an existing database with duplicate rows
-- this statement fails until migrate_021 removes the duplicates (deploy.sh runs it right after).
CREATE UNIQUE INDEX IF NOT EXISTS idx_quizzes_ou_qi ON quizzes(ou, qi);
CREATE TABLE IF NOT EXISTS renew_optout (email TEXT PRIMARY KEY, at TEXT);
CREATE TABLE IF NOT EXISTS renew_sent (email TEXT NOT NULL, term TEXT NOT NULL, at TEXT, PRIMARY KEY (email, term));
-- professor emailed once when a student opens a quiz newer than their last Sync
CREATE TABLE IF NOT EXISTS sync_nudges (ou TEXT, qi TEXT, at TEXT, PRIMARY KEY (ou, qi));
