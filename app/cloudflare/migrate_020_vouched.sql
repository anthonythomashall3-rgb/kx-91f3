-- 24 Oct 2026 (API audit #2): only an account the admin vouched for (made from an invite, or the
-- first/admin account) can become a verified professor. A self-made account proves nothing about
-- owning its email, so it could otherwise sign up as a professor's email before their roster is seeded
-- and later verify as them. Existing admins, verified professors and invited accounts are grandfathered.
-- Run once: the ALTER fails with "duplicate column" on a re-run (deploy.sh then records it as applied).
ALTER TABLE teachers ADD COLUMN vouched INTEGER DEFAULT 0;
UPDATE teachers SET vouched=1 WHERE role='admin' OR verified=1 OR active_until IS NOT NULL
  OR id IN (SELECT teacher_id FROM paid_sections)
  OR lower(email) IN (SELECT lower(used_by) FROM invites WHERE used_at IS NOT NULL AND used_by IS NOT NULL);
