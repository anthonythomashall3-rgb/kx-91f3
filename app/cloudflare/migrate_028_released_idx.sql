-- /password sharing check: a paid email's computers that got a quiz password in the last 30 days.
-- Partial index: only password_released rows are indexed (no extra write on any other event).
CREATE INDEX IF NOT EXISTS idx_events_released ON events(student, ts) WHERE event='password_released';
