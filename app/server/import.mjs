#!/usr/bin/env node
// Bring the live database over: turn a SQL export of the Cloudflare D1 database into the server's file.
//   npx wrangler d1 export lockqz --remote --output lockqz-export.sql     (a read; writes nothing to D1)
//   node import.mjs lockqz-export.sql data/lockqz.db
// Refuses to write over an existing database file. Ends by applying any database step the export lacks.
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, migrate } from "./d1.mjs";

export function importDump(sqlFile, dbFile, cloudflareDir = join(dirname(fileURLToPath(import.meta.url)), "..", "cloudflare")) {
  if (existsSync(dbFile)) throw new Error(dbFile + " already exists - move it away first");
  mkdirSync(dirname(resolve(dbFile)), { recursive: true });
  const db = openDb(dbFile);
  try {
    db.sqlite.exec("BEGIN");
    // Cloudflare's own bookkeeping tables and SQLite's internal ones are not LOCKqz's data.
    const sql = readFileSync(sqlFile, "utf8").split("\n").filter(l => !/^\s*(CREATE TABLE|INSERT INTO|DELETE FROM)\s+(IF NOT EXISTS\s+)?["`]?(sqlite_|_cf_)/i.test(l)).join("\n");
    db.sqlite.exec(sql);
    db.sqlite.exec("COMMIT");
  } catch (e) { try { db.sqlite.exec("ROLLBACK"); } catch {} db.close(); throw e; }
  const applied = migrate(db, cloudflareDir);
  const tables = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()
    .map(t => ({ table: t.name, rows: db.sqlite.prepare(`SELECT COUNT(*) n FROM "${t.name}"`).get().n }));
  const check = db.sqlite.prepare("PRAGMA integrity_check").get().integrity_check;
  db.close();
  return { tables, applied, integrity: check };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sqlFile, dbFile] = process.argv.slice(2);
  if (!sqlFile || !dbFile) { console.error("usage: node import.mjs <export.sql> <database file>"); process.exit(2); }
  const r = importDump(sqlFile, dbFile);
  for (const t of r.tables) if (t.rows) console.log(String(t.rows).padStart(9), t.table);
  console.log("integrity:", r.integrity, "| database steps applied after import:", r.applied.length);
}
