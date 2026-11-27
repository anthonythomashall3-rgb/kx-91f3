-- 27 Nov 2026: exam rules - what students may use in an exam beside Brightspace, set by its professor. qi '*' is the
-- class's rule (every exam without its own); rules = JSON {p, b: blocked row keys, allow: sites, block: sites or programs}.
CREATE TABLE IF NOT EXISTS quiz_rules (ou TEXT NOT NULL, qi TEXT NOT NULL, rules TEXT NOT NULL, by_teacher TEXT, at TEXT, PRIMARY KEY (ou, qi));
