-- 26 Oct 2026: keep locks.student / platform / sv (migrate_029) in step with the device row. Separate
-- file so it always runs after 029 added the columns (a trigger naming a missing column breaks every
-- devices update). Fires only when one of the three values really changes: never on a heartbeat.
CREATE TRIGGER IF NOT EXISTS trg_devices_locks_upd AFTER UPDATE OF student, platform, student_verified ON devices
  WHEN NEW.student IS NOT OLD.student OR NEW.platform IS NOT OLD.platform OR COALESCE(NEW.student_verified,0) IS NOT COALESCE(OLD.student_verified,0)
  BEGIN UPDATE locks SET student=NEW.student, platform=NEW.platform, sv=COALESCE(NEW.student_verified,0) WHERE device_id=NEW.device_id; END;
CREATE TRIGGER IF NOT EXISTS trg_devices_locks_ins AFTER INSERT ON devices
  BEGIN UPDATE locks SET student=NEW.student, platform=NEW.platform, sv=COALESCE(NEW.student_verified,0) WHERE device_id=NEW.device_id; END;
-- bsq_hash / roster_snap (migrate_029): any write a Sync did not make deletes the course's hash / snapshot.
CREATE TABLE IF NOT EXISTS roster_snap (ou TEXT PRIMARY KEY, hash TEXT, rows TEXT, at TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS bsq_hash (ou TEXT PRIMARY KEY, hash TEXT, own TEXT) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS trg_bsq_hash_upd AFTER UPDATE OF ou, qi, name, active, start_date, end_date, due_date, bs_has_password, bs_password_is_ours, over_min ON bs_quizzes
  WHEN NEW.synced_at IS OLD.synced_at
  BEGIN DELETE FROM bsq_hash WHERE ou IN (OLD.ou, NEW.ou); END;
CREATE TRIGGER IF NOT EXISTS trg_bsq_hash_ins AFTER INSERT ON bs_quizzes BEGIN DELETE FROM bsq_hash WHERE ou=NEW.ou; END;
CREATE TRIGGER IF NOT EXISTS trg_bsq_hash_del AFTER DELETE ON bs_quizzes BEGIN DELETE FROM bsq_hash WHERE ou=OLD.ou; END;
-- roster_snap: any class-list row written outside a Sync (a Sync's own writes always set synced_at, and
-- write the new snapshot in the same transaction) deletes the course's snapshot.
CREATE TRIGGER IF NOT EXISTS trg_roster_snap_ins AFTER INSERT ON roster BEGIN DELETE FROM roster_snap WHERE ou=NEW.ou; END;
CREATE TRIGGER IF NOT EXISTS trg_roster_snap_upd AFTER UPDATE ON roster WHEN NEW.synced_at IS OLD.synced_at OR NEW.ou IS NOT OLD.ou
  BEGIN DELETE FROM roster_snap WHERE ou IN (OLD.ou, NEW.ou); END;
CREATE TRIGGER IF NOT EXISTS trg_roster_snap_del AFTER DELETE ON roster BEGIN DELETE FROM roster_snap WHERE ou=OLD.ou; END;
