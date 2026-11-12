// The database the LOCKqz API talks to, on one SQLite file. Same calls the API makes on Cloudflare D1
// (prepare / bind / first / all / run / batch), so functions/api/[[route]].js runs here unchanged.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const val = x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x;
const num = x => typeof x === "bigint" ? Number(x) : x;

export function openDb(file, { cache = 400 } = {}) {
  const sqlite = new DatabaseSync(file);
  if (file !== ":memory:") sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  sqlite.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=OFF;");
  const stmts = new Map();                      // prepared once per SQL text, least recently used dropped
  const stmt = sql => {
    let s = stmts.get(sql);
    if (s) { stmts.delete(sql); stmts.set(sql, s); return s; }
    s = sqlite.prepare(sql);
    stmts.set(sql, s);
    if (stmts.size > cache) stmts.delete(stmts.keys().next().value);
    return s;
  };
  const stats = { read: 0, written: 0, queries: 0 };
  const meta = r => ({ changes: num(r.changes), last_row_id: num(r.lastInsertRowid), duration: 0 });
  const runNow = (sql, args) => { stats.queries++; const r = stmt(sql).run(...args); stats.written += num(r.changes); return { success: true, results: [], meta: meta(r) }; };
  const allNow = (sql, args) => { stats.queries++; const rows = stmt(sql).all(...args); stats.read += rows.length; return { success: true, results: rows, meta: { changes: 0 } }; };
  // A statement that returns rows (SELECT, or ... RETURNING) is read; anything else is run.
  const reads = sql => /^\s*(select|with|pragma|explain)\b/i.test(sql) || /\breturning\b/i.test(sql);
  const db = {
    prepare(sql) {
      let args = [];
      const o = {
        bind(...a) { args = a.map(val); return o; },
        async first(col) { stats.queries++; const row = stmt(sql).get(...args); if (row === undefined) return null; stats.read++; return col === undefined ? row : row[col] ?? null; },
        async all() { return reads(sql) ? allNow(sql, args) : runNow(sql, args); },
        async run() { return reads(sql) ? allNow(sql, args) : runNow(sql, args); },
        async raw() { return allNow(sql, args).results.map(r => Object.values(r)); },
        _now() { return reads(sql) ? allNow(sql, args) : runNow(sql, args); },
      };
      return o;
    },
    // All or nothing, like D1: one statement failing undoes the whole list.
    async batch(list) {
      if (!list.length) return [];
      sqlite.exec("BEGIN IMMEDIATE");
      try { const out = list.map(s => s._now()); sqlite.exec("COMMIT"); return out; }
      catch (e) { try { sqlite.exec("ROLLBACK"); } catch {} throw e; }
    },
    async exec(sql) { sqlite.exec(sql); return { count: 1, duration: 0 }; },
    stats, sqlite,
    close() { stmts.clear(); sqlite.close(); },
  };
  return db;
}

// One SQL statement per item; a trigger (CREATE TRIGGER ... BEGIN ...; END) stays whole.
export function statements(text) {
  const out = []; let cur = "";
  for (const piece of text.split(";")) {
    cur += (cur ? ";" : "") + piece;
    if (/^\s*create\s+(temp\s+|temporary\s+)?trigger\b/i.test(cur) && !/\bend\s*$/i.test(cur)) continue;
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// schema.sql, then each migrate_*.sql once (recorded in _migrations, as the Cloudflare deploy does).
export function migrate(db, dir) {
  const s = db.sqlite, log = [];
  s.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, at TEXT)");
  const strip = t => t.replace(/^\s*--.*$/gm, "");
  s.exec(strip(readFileSync(join(dir, "schema.sql"), "utf8")));
  const done = new Set(s.prepare("SELECT name FROM _migrations").all().map(r => r.name));
  for (const m of readdirSync(dir).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort()) {
    if (done.has(m)) continue;
    for (const st of statements(strip(readFileSync(join(dir, m), "utf8")))) {
      try { s.exec(st); }
      catch (e) { if (!/duplicate column|already exists/i.test(String(e.message))) throw new Error(m + ": " + e.message); }
    }
    s.prepare("INSERT OR IGNORE INTO _migrations (name, at) VALUES (?, datetime('now'))").run(m);
    log.push(m);
  }
  if (log.length) s.exec("PRAGMA optimize");
  return log;
}

// A consistent copy of the whole database in one file (safe while the server runs).
export function snapshot(db, to) { db.sqlite.prepare("VACUUM INTO ?").run(to); return to; }
