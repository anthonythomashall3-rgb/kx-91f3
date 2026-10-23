-- Invite-only teacher sign-up (23 Oct 2026). Safe to re-run.
CREATE TABLE IF NOT EXISTS invites (
  code         TEXT PRIMARY KEY,
  email        TEXT,
  active_until TEXT,
  created_at   TEXT,
  used_at      TEXT,
  used_by      TEXT
);
