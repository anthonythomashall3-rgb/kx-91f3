// A professor's sections are found by name through an index (16 Nov 2026): the three lookups in the API that
// match lower(last) = lower(?) must not read the whole usc_sections table (17,000 rows at USC).
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

// The daily section index builder (app/usc/build_sections.py), USC's API stubbed and D1 played by SQLite:
// a term USC has not published yet is skipped (the run goes on), a big new term loads 3,000 changes a run
// with the current term first, and sections are removed only for a term read completely, in a normal number.
console.log("builder (app/usc/build_sections.py)");
const out = JSON.parse(execFileSync("python3", ["-c", String.raw`
import importlib.util, json, sys, os, io, sqlite3, tempfile, datetime, contextlib, urllib.error
spec = importlib.util.spec_from_file_location("bs", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
cf = sys.argv[2]; R = {}
def fake(sizes, broken=(), badlist=()):
    def g(path):
        if path.startswith("/Programs/TermCode"):
            t = int(path.split("=")[1])
            if t in badlist: raise RuntimeError("timed out")
            if t not in sizes: raise m.NotPublished(path)
            return [{"prefix": "P%d" % i, "schools": [{"prefix": "S"}]} for i in range(4)]
        t = int(path.split("termCode=")[1].split("&")[0]); prog = path.split("program=")[1]
        if (t, prog) in broken: raise RuntimeError("500")
        i = int(prog[1:])
        secs = [{"sisSectionId": str(10000 + k), "instructors": [{"firstName": "F%d" % k, "lastName": "L%d" % (k % 97)}]} for k in range(i, sizes[t], 4)]
        return {"courses": [{"fullCourseName": "FBE %d" % (400 + i), "name": "T", "sections": secs}]}
    return g
def newdb():
    db = sqlite3.connect(":memory:"); db.executescript(open(os.path.join(cf, "schema.sql")).read()); return db
def dump(db, path):
    rows = [dict(zip(("term","section","course","title","first","last"), r)) for r in db.execute("SELECT term,section,course,title,first,last FROM usc_sections")]
    json.dump([{"results": rows}], open(path, "w"))
def run(db, g, day):
    d = tempfile.mkdtemp(); cur, sql = os.path.join(d, "c.json"), os.path.join(d, "o.sql"); dump(db, cur); err = io.StringIO()
    with contextlib.redirect_stderr(err): m.main(sql, cur, getter=g, today=day)
    lines = [l.strip() for l in open(sql) if l.strip()]
    for l in lines: db.execute(l)
    return lines, err.getvalue()
day = datetime.date(2026, 11, 22)
R["terms"] = [m.terms_now(datetime.date(2026, 11, 22)), m.terms_now(datetime.date(2027, 1, 5)), m.terms_now(datetime.date(2027, 6, 1)), m.terms_now(datetime.date(2027, 12, 31))]
# 1. Fall in D1 already, Spring 2027 new and big, Summer 2027 not published: loads over several runs.
db = newdb(); g = fake({20263: 2000, 20271: 9000})
first, _ = run(newdb(), fake({20263: 2000}), day)       # (warm-up: a full fall term on its own)
for l in first: db.execute(l)
db.execute("DELETE FROM usc_sections WHERE term='20263' AND section IN ('10000','10001','10002')")    # 3 missing
db.execute("INSERT INTO usc_sections (term,section,course,title,first,last) VALUES ('20263','99991','FBE 1','T','A','Gone')")
runs = []
for i in range(8):
    lines, err = run(db, g, day); runs.append(len(lines))
    if i == 0: R["first"] = lines[:5]; R["notice"] = "rest in the next runs" in err; R["skipped"] = "20272: not published yet" in err
    if not lines: break
R["runs"] = runs; R["total"] = db.execute("SELECT term, COUNT(*) FROM usc_sections GROUP BY term ORDER BY term").fetchall()
# 2. one program unreadable: nothing removed from that term; 3. half a term gone at once: held; 4. a few gone: removed.
db2 = newdb()
for l in run(newdb(), fake({20263: 2000}), day)[0]: db2.execute(l)
lines, err = run(db2, fake({20263: 2000}, broken={(20263, "P1")}), day); R["broken"] = [len(lines), "unreadable" in err]
lines, err = run(db2, fake({20263: 1000}), day); R["held"] = [len(lines), "::warning::" in err]
lines, err = run(db2, fake({20263: 1880}), day); R["few"] = [sum(l.startswith("DELETE") for l in lines), db2.execute("SELECT COUNT(*) FROM usc_sections").fetchone()[0]]
# 5. next term's program list unreadable: that term left as it is, the run goes on; 6. nothing readable: refused.
lines, err = run(db2, fake({20263: 1880, 20271: 1200}, badlist={20271}), day); R["badlist"] = [len(lines), "left as it is" in err]
try: run(db2, fake({}), day); R["refused"] = False
except SystemExit: R["refused"] = True
# 7. USC's real answer for an unpublished term (HTTP 500 "Configuration does not exist") is not retried.
calls = []
def uo(*a, **k):
    calls.append(1); raise urllib.error.HTTPError("u", 500, "x", {}, io.BytesIO(b'{"detail":"Problem: Configuration does not exist for 20272"}'))
m.urllib.request.urlopen, m.time.sleep = uo, lambda s: None
try: m.get("/Programs/TermCode?termCode=20272"); R["np"] = "no error"
except m.NotPublished: R["np"] = len(calls)
calls.clear()
def uo2(*a, **k):
    calls.append(1); raise urllib.error.HTTPError("u", 503, "x", {}, io.BytesIO(b"busy"))
m.urllib.request.urlopen = uo2
try: m.get("/x"); R["retry"] = "no error"
except urllib.error.HTTPError: R["retry"] = len(calls)
print(json.dumps(R))`, join(HERE, "..", "usc", "build_sections.py"), CF]).toString());
check("terms: current + the next two (Nov, Jan, Jun, Dec)", JSON.stringify(out.terms) === JSON.stringify([[20263, 20271, 20272], [20271, 20272, 20273], [20272, 20273, 20281], [20273, 20281, 20282]]), JSON.stringify(out.terms));
check("a term USC has not published yet is skipped, the run goes on", out.skipped === true);
check("current term first: its 3 missing sections, then the one gone, before the new term", out.first.slice(0, 3).every(l => /^INSERT .*'20263','1000[012]'/.test(l)) && /^DELETE .*'20263'.*'99991'/.test(out.first[3]) && /'20271'/.test(out.first[4]), JSON.stringify(out.first));
check("a big new term loads 3,000 changes a run, then stops (nothing left)", JSON.stringify(out.runs) === JSON.stringify([3000, 3000, 3000, 4, 0]) && out.notice === true, JSON.stringify(out.runs));
check("after the runs D1 holds both terms exactly", JSON.stringify(out.total) === JSON.stringify([["20263", 2000], ["20271", 9000]]), JSON.stringify(out.total));
check("one program unreadable: nothing removed from that term", out.broken[0] === 0 && out.broken[1] === true, JSON.stringify(out.broken));
check("half a term gone at once: removals held, warned", out.held[0] === 0 && out.held[1] === true, JSON.stringify(out.held));
check("a normal number gone (120): removed", out.few[0] === 120 && out.few[1] === 1880, JSON.stringify(out.few));
check("next term's program list unreadable: left as it is, run goes on", out.badlist[0] === 0 && out.badlist[1] === true, JSON.stringify(out.badlist));
check("nothing readable at all: refused (no writes)", out.refused === true);
check("USC's 'Configuration does not exist' (HTTP 500) = not published, asked once", out.np === 1, String(out.np));
check("any other error is retried (4 tries) before failing", out.retry === 4, String(out.retry));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
