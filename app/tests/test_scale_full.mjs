// Exam day with a full-size database (app/server/loadtest-full.mjs), small enough to run in every test
// run: the student fee ON, every student paid, on class lists, with a registered computer; professors
// watching live and opening their dashboard, the admin opening the admin lists, while students sit exams.
// Checks that every student gets the password, nothing fails, and that no request reads a whole big table
// (a statement whose cost grows with the number of students at every school, not with the class). The plans
// are taken as the database would make them at 500 times this size (1,000,000 students).
import { run } from "../server/loadtest-full.mjs";

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

// Whole-table reads that are fine: small tables, and reads that stop after a fixed number of rows.
const FINE = [
  /^SELECT lower\(email\) AS e FROM teachers WHERE role='admin'/,                      // professors: a small table
  /^SELECT t\.id,t\.email,t\.name,t\.role,t\.created_at/,                               // admin: the professors list
  /^SELECT quiz_id,title,url,password,created_at,qi,lock_id,teacher_id,ou FROM quizzes WHERE 1=1/,   // admin: every protected exam
  /^SELECT id,device_id,student,quiz_id,event,detail,ts FROM events WHERE ts>\? ORDER BY id DESC LIMIT 500$/,   // admin: newest 500, read newest first
  /^DELETE FROM events WHERE id IN \(SELECT id FROM events ORDER BY id LIMIT/,          // clean-up: oldest 300
  /^SELECT 1 FROM events e JOIN devices d ON d\.device_id=e\.device_id WHERE e\.device_id=\?/,   // by computer and quiz (indexed); the planner's note is about the small professors table
];

try {
  console.log("F1 2,000 students in the database, 300 sitting, 12 professors watching, the admin on the admin pages");
  let sessions = null;
  const out = await run({ students: 2000, sitting: 300, parallel: 60, classes: 40, oldEvents: 6000, professors: 12, liveMs: 150, quiet: true, planAs: 500,
    inspect: async (s) => {
      // The professor's activity list must be exactly what the one-statement form gave: the newest 500 events of their classes.
      const tok = "tok-t0-0123456789abcdef", ous = ["100000", "100001", "100002", "100003"], since = new Date(Date.now() - 30 * 86400000).toISOString();
      const want = s.db.sqlite.prepare(`SELECT device_id,student,quiz_id,event,detail,ts FROM events WHERE (${ous.map(() => "(quiz_id>=? AND quiz_id<?)").join(" OR ")}) AND ts>? ORDER BY id DESC LIMIT 500`).all(...ous.flatMap(o => [o + "-", o + "."]), since);
      const got = await (await fetch("http://127.0.0.1:" + s.port + "/api/sessions", { headers: { "X-LOCKqz-Teacher": tok } })).json();
      const one = await (await fetch("http://127.0.0.1:" + s.port + "/api/sessions?quiz=100000-500000", { headers: { "X-LOCKqz-Teacher": tok } })).json();
      const other = await (await fetch("http://127.0.0.1:" + s.port + "/api/sessions?quiz=100004", { headers: { "X-LOCKqz-Teacher": tok } })).json();
      sessions = { same: JSON.stringify(got.events.map(e => [e.device_id, e.quiz_id, e.event, e.ts])) === JSON.stringify(want.map(e => [e.device_id, e.quiz_id, e.event, e.ts])), n: got.events.length, want: want.length,
        oneOnly: one.events.length > 0 && one.events.every(e => e.quiz_id === "100000-500000"), other: other.events.length };
    } });
  console.log("   ", JSON.stringify({ requests: out.requests, per_second: out.per_second, ms_p95: out.ms_p95, queries_per_request: out.queries_per_request }));
  check("every student sitting got the password, with the fee on", out.passwords === 300, JSON.stringify(out.failed));
  check("no student request failed, no server error", Object.keys(out.failed).length === 0 && out.server_errors === 0, JSON.stringify(out.failed));
  check("no professor or admin request failed", Object.keys(out.professor_failed).length === 0, JSON.stringify(out.professor_failed));
  check("professors and the admin were at work during the exams", (out.professor_routes["/live"]?.calls || 0) > 20 && (out.professor_routes["/sessions"]?.calls || 0) > 5 && (out.professor_routes["/payments (admin)"]?.calls || 0) >= 1);
  const badScans = out.whole_table_reads.filter(x => !FINE.some(re => re.test(x.sql)));
  check("no request read a whole big table", badScans.length === 0, badScans.map(x => x.plan + " <- " + x.sql.slice(0, 110)).join(" ;; "));
  check("a student's exam is a handful of small database statements per request", out.queries_per_request < 9, String(out.queries_per_request));
  check("the professor's activity list is the newest events of their classes, newest first (as before)", sessions?.same && sessions.n > 0, JSON.stringify(sessions));
  check("one exam's activity is that exam's only; another professor's class shows nothing", sessions?.oneOnly && sessions.other === 0, JSON.stringify(sessions));

  console.log("F2 a professor with many classes (more than fit in one statement)");
  await run({ students: 600, sitting: 20, parallel: 10, classes: 120, oldEvents: 0, professors: 0, quiet: true,
    inspect: async (s) => {
      // give professor t0 all 120 classes, each with events
      const d = s.db.sqlite, iso = new Date().toISOString();
      for (let c = 0; c < 120; c++) { d.prepare("INSERT OR REPLACE INTO teacher_courses (teacher_id,ou,name,code,role,synced_at,in_sync) VALUES ('t0',?,?,?,?,?,1)").run(String(100000 + c), "C" + c, "X-" + c, "Instructor", iso);
        d.prepare("INSERT OR REPLACE INTO roster (ou,user_id,name,email,username,org_id,role,synced_at) VALUES (?,?,?,?,?,?,?,?)").run(String(100000 + c), "pt0", "Prof 0", "prof0@usc.edu", "prof", "opt0", "Instructor", iso);
        for (let k = 0; k < 6; k++) d.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)").run("mac-x" + k, "x@usc.edu", (100000 + c) + "-" + (500000 + c), "lock", "{}", iso); }
      const got = await (await fetch("http://127.0.0.1:" + s.port + "/api/sessions", { headers: { "X-LOCKqz-Teacher": "tok-t0-0123456789abcdef" } })).json();
      const ids = d.prepare("SELECT COUNT(*) n FROM events WHERE ts>?").get(new Date(Date.now() - 30 * 86400000).toISOString()).n;
      const classes = new Set(got.events.map(e => e.quiz_id.split("-")[0]));
      check("500 newest events across all 120 classes", got.events.length === Math.min(500, ids) && classes.size > 60, `${got.events.length} of ${ids}, ${classes.size} classes`);
      check("newest first", got.events.every((e, i, a) => i === 0 || a[i - 1].ts >= e.ts));
    } });
} catch (e) { fail++; console.log("  FAIL: crashed:", e && e.stack || e); }
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
