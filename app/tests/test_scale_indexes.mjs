// Scale guard (28 Oct 2026): every SQL statement written as a plain string in the API is planned against the
// real schema (schema.sql + every migration). A statement that reads a WHOLE big table (SCAN without an index)
// fails the test, because D1 bills every row read and at tens of thousands of students such a query reads the
// full table on every request. Known-bounded exceptions are listed in OK below with the reason.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const CF = join(dirname(fileURLToPath(import.meta.url)), "..", "cloudflare");
const db = new DatabaseSync(":memory:");
db.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) db.exec(st); } catch {} }
const src = readFileSync(join(CF, "functions", "api", "[[route]].js"), "utf8");
const BIG = ["events", "devices", "locks", "roster", "teacher_courses", "quizzes", "bs_quizzes", "teachers", "payments", "submissions", "students", "email_codes", "card_renew", "pay_codes_students", "renew_sent", "assist", "sync_nudges"];
// Bounded or admin-only on purpose (reason after each):
const OK = [
  /DELETE FROM events WHERE id IN \(SELECT id FROM events ORDER BY id LIMIT/,   // purge: walks rowid from the oldest, stops after <= 300 rows
  /FROM teachers t ORDER BY t\.created_at DESC/,                                 // admin list of professors (admin only, rare)
  /FROM quizzes WHERE 1=1 ORDER BY created_at DESC/,                             // admin list of quizzes (admin only, rare)
  /FROM payments p LEFT JOIN pay_codes_students/,                                // admin payments list (admin only)
];
let pass = 0, fail = 0, planned = 0;
const lits = [...src.matchAll(/(["'`])((?:SELECT|UPDATE|DELETE|INSERT|WITH)\b(?:(?!\1)[^\\]|\\.)*)\1/g)]
  .map(m => m[2]).filter(s => !s.includes("${") && !/\b(CREDIT|COUNTS|RL_EV)\b/.test(s));
const seen = new Set();
for (const sql of lits) {
  if (seen.has(sql)) continue; seen.add(sql);
  let plan; try { plan = db.prepare("EXPLAIN QUERY PLAN " + sql).all().map(r => r.detail); } catch { continue; }   // fragment / dynamic
  planned++;
  const bad = plan.filter(d => { const m = d.match(/^SCAN (\w+)(?: AS (\w+))?/); if (!m || /USING (COVERING )?INDEX|VIRTUAL TABLE/.test(d)) return false;
    const tbl = m[1]; const alias = new RegExp("\\b(\\w+)\\s+(?:AS\\s+)?" + tbl + "\\b", "i"); const real = BIG.includes(tbl) ? tbl : (sql.match(new RegExp("\\b(" + BIG.join("|") + ")\\s+(?:AS\\s+)?" + tbl + "\\b")) || [])[1];
    return !!real; });
  if (bad.length && !OK.some(r => r.test(sql))) { fail++; console.log("  FAIL: full scan (" + bad.join(" | ") + "):\n        " + sql.replace(/\s+/g, " ").slice(0, 220)); }
  else pass++;
}
console.log(`  planned ${planned} API statements against the full schema`);
planned > 150 ? pass++ : (fail++, console.log("  FAIL: too few statements planned (" + planned + ") - extraction broke"));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
