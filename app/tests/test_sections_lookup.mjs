// A professor's sections are found by name through an index (16 Nov 2026): the three lookups in the API that
// match lower(last) = lower(?) must not read the whole usc_sections table (17,000 rows at USC).
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
const mk = withMigrations => { const db = new DatabaseSync(":memory:"); db.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
  if (withMigrations) for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
    for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) db.exec(st); } catch {} }
  return db; };
const route = readFileSync(join(CF, "functions", "api", "[[route]].js"), "utf8");
const sqls = [...route.matchAll(/"(SELECT [^"]*FROM usc_sections WHERE [^"]*lower\(last\)=lower\(\?\)[^"]*)"/g)].map(m => m[1]);
check("the API has its three name lookups", sqls.length === 3, String(sqls.length));
for (const [name, db] of [["schema + migrations", mk(true)], ["schema alone (a new database)", mk(false)]]) {
  const ins = db.prepare("INSERT INTO usc_sections (term,section,course,title,first,last) VALUES (?,?,?,?,?,?)");
  for (let i = 0; i < 3000; i++) ins.run(i % 2 ? "20263" : "20271", String(10000 + i), "FBE " + (400 + i % 90), "T", "First" + (i % 50), "Last" + (i % 400));
  ins.run("20263", "99999", "FBE 421", "Financial Analysis", "Duke", "Bristow");
  db.exec("ANALYZE");
  for (const q of sqls) {
    const n = (q.match(/\?/g) || []).length, args = q.includes("term IN (?,?)") ? ["20263", "20271", "bristow", n === 4 && q.includes("LIKE") ? "d%" : "duke"] : ["20263", "BRISTOW", "DUKE"];
    const plan = db.prepare("EXPLAIN QUERY PLAN " + q).all(...args).map(r => r.detail).join(" | ");
    check(`${name}: by index, not a scan (${q.slice(0, 60)}...)`, /USING INDEX idx_usc_sections_lname/.test(plan) && !/SCAN usc_sections(?! USING)/.test(plan), plan);
    const rows = db.prepare(q).all(...args);
    check(`${name}: finds the professor whatever the case`, rows.length === 1 && rows[0].course === "FBE 421", JSON.stringify(rows));
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
