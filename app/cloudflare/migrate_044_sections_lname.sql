-- 16 Nov 2026: a professor's sections are looked up by name without regard to case (lower(last) = lower(?)), which
-- the (last, first) index cannot serve: every lookup read the whole table (17,000 rows). An index on the
-- lowered names serves it (a few rows per lookup).
CREATE INDEX IF NOT EXISTS idx_usc_sections_lname ON usc_sections(lower(last), lower(first));
