-- 24 Oct 2026 (API audit #4, #5). Safe to re-run (every statement is idempotent).
-- #5: one quizzes row per Brightspace quiz (ou, qi). Older /quiz calls could add a second row (and a
-- second password) for the same quiz. Keep ONE per (ou, qi): the gated one if any, else the oldest;
-- the next Sync writes the kept password into Brightspace. Rows without ou/qi (legacy) are untouched.
DELETE FROM quizzes WHERE ou IS NOT NULL AND qi IS NOT NULL AND EXISTS (
  SELECT 1 FROM quizzes q2 WHERE q2.ou = quizzes.ou AND q2.qi = quizzes.qi AND (
    COALESCE(q2.gated, 0) > COALESCE(quizzes.gated, 0) OR
    (COALESCE(q2.gated, 0) = COALESCE(quizzes.gated, 0) AND q2.rowid < quizzes.rowid)));
CREATE UNIQUE INDEX IF NOT EXISTS idx_quizzes_ou_qi ON quizzes(ou, qi);
-- #4: rate-limit counts (login_fail, reset_request, code_sent, pay_code_new) read events by (event, ts);
-- the live monitor reads locks by quiz_id.
CREATE INDEX IF NOT EXISTS idx_events_event_ts ON events(event, ts);
CREATE INDEX IF NOT EXISTS idx_locks_quiz ON locks(quiz_id);
