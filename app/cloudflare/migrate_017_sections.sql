-- Per-section billing. usc_sections = USC's public Schedule of Classes (who teaches which section),
-- refreshed by .github/workflows/usc-sections.yml. paid_sections = sections a professor has paid for.
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
