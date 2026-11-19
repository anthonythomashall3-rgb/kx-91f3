INSERT OR IGNORE INTO invites (code,email,active_until,created_at,used_at,used_by)
  SELECT 'self-bf-' || t.id, t.email, NULL, t.created_at, t.created_at, t.email FROM teachers t
  WHERE t.role <> 'admin' AND t.vouched = 1 AND t.created_at >= '2026-11-09T20:56:00Z' AND t.created_at < '2026-11-12T00:00:00Z'
    AND NOT EXISTS (SELECT 1 FROM invites i WHERE i.used_by = t.email AND i.used_at IS NOT NULL);
