-- 28 Oct 2026 scale pass: indexes for queries that read the WHOLE table on hot paths (D1 bills every row read;
-- at tens of thousands of students each of these would read the full table per request).
CREATE INDEX IF NOT EXISTS idx_devices_regip ON devices(reg_ip, registered_at);          -- /register per-IP limit
CREATE INDEX IF NOT EXISTS idx_devices_student_lc ON devices(lower(student));            -- class lists: who has LOCKqz
CREATE INDEX IF NOT EXISTS idx_tc_ou ON teacher_courses(ou);                             -- /password: is the class covered
CREATE INDEX IF NOT EXISTS idx_quizzes_teacher ON quizzes(teacher_id);                   -- dashboard / sync
CREATE INDEX IF NOT EXISTS idx_teachers_email_lc ON teachers(lower(email));              -- sign-in, pay, bank
CREATE INDEX IF NOT EXISTS idx_teachers_verified ON teachers(verified);                  -- trusted rosters
CREATE INDEX IF NOT EXISTS idx_events_support ON events(ts) WHERE event='support';      -- support form limits
CREATE INDEX IF NOT EXISTS idx_email_codes_expires ON email_codes(expires);              -- expired-code cleanup
CREATE INDEX IF NOT EXISTS idx_pay_slots_code ON pay_slots(code);                        -- freeing a Zelle slot
CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email);                  -- re-sending a student's code
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen);                  -- admin device list (newest 5,000)
