#!/usr/bin/env node
// Exam day with a full-size database: the student fee ON, every student on a class list, paid, with a
// confirmed email and a registered computer; many classes, each with its own protected exam. Reports the
// rate and the database statements that cost the most time.
//   node loadtest-full.mjs [students in the database=100000] [students sitting=20000] [parallel=200] [classes=1000]
//                          [earlier events=0] [professors watching=0] [ms between their live questions=2000]
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHmac, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { start } from "./server.mjs";

const sign = (key, path, ts, body) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");
const keyOf = i => createHash("sha256").update("k" + i).digest("hex");
const devOf = i => "mac-" + String(i).padStart(8, "0") + "-0000-0000-0000-000000000000";

export function seed(db, { students, classes, oldEvents = 0 }) {
  const s = db.sqlite, now = new Date(), iso = now.toISOString(), y = now.getUTCFullYear();
  const soon = new Date(now.getTime() - 600e3).toISOString(), later = new Date(now.getTime() + 3 * 3600e3).toISOString(), far = `${y + 1}-12-31`;
  s.exec("BEGIN");
  const T = s.prepare("INSERT INTO teachers (id,email,name,created_at,role,active_until,verified,vouched,token,sync_key,bs_user_id) VALUES (?,?,?,?,?,?,1,1,?,?,?)");
  const TC = s.prepare("INSERT INTO teacher_courses (teacher_id,ou,name,code,role,synced_at,in_sync) VALUES (?,?,?,?,?,?,1)");
  const Q = s.prepare("INSERT INTO quizzes (quiz_id,title,password,created_at,qi,teacher_id,lock_id,ou) VALUES (?,?,?,?,?,?,?,?)");
  const BQ = s.prepare("INSERT INTO bs_quizzes (ou,qi,name,active,start_date,end_date,bs_has_password,bs_password_is_ours,synced_at) VALUES (?,?,?,1,?,?,1,1,?)");
  const RI = s.prepare("INSERT OR IGNORE INTO roster (ou,user_id,name,email,username,org_id,role,synced_at) VALUES (?,?,?,?,?,?,?,?)");
  for (let c = 0; c < classes; c++) {
    const ou = String(100000 + c), qi = String(500000 + c), t = "t" + Math.floor(c / 4);
    if (c % 4 === 0) T.run(t, `prof${c / 4}@usc.edu`, `Prof ${c / 4}`, iso, "teacher", far, "tok-" + t + "-0123456789abcdef", "syn-" + t + "-0123456789abcdef", "p" + t);
    TC.run(t, ou, "Class " + c, "BUAD-" + c, "Instructor", iso);
    RI.run(ou, "p" + t, `Prof ${Math.floor(c / 4)}`, `prof${Math.floor(c / 4)}@usc.edu`, "prof", "op" + t, "Instructor", iso);
    Q.run("q" + c, "Final " + c, "LQ-PW-" + c, iso, qi, t, ou + "-" + qi, ou);
    BQ.run(ou, qi, "Final " + c, soon, later, iso);
  }
  const D = s.prepare("INSERT INTO devices (device_id,student,platform,version,installed_at,last_seen,device_key,registered_at,reg_ip,student_verified) VALUES (?,?,?,?,?,?,?,?,?,1)");
  const R = s.prepare("INSERT OR IGNORE INTO roster (ou,user_id,name,email,username,org_id,role,synced_at) VALUES (?,?,?,?,?,?,?,?)");
  const PC = s.prepare("INSERT INTO pay_codes_students (email,code) VALUES (?,?)");
  const P = s.prepare("INSERT INTO payments (txn,code,amount,via,payer,note,term,received_at) VALUES (?,?,?,?,?,?,?,?)");
  const terms = [`${y}1`, `${y}2`, `${y}3`, `${y + 1}1`];
  for (let i = 0; i < students; i++) {
    const em = `s${i}@usc.edu`, code = "LQS" + i.toString(36).toUpperCase().padStart(5, "0");
    D.run(devOf(i), em, i % 3 ? "mac-15" : "windows-11", "0.6.18", iso, iso, keyOf(i), iso, `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
    for (const c of [i % classes, (i * 7 + 3) % classes, (i * 13 + 5) % classes]) R.run(String(100000 + c), "u" + i, `Student ${i}`, em, "s" + i, "o" + i, "Student", iso);
    PC.run(em, code);
    for (const t of terms) P.run("zelle:" + t + ":" + i, code, 200, "zelle", `Student ${i}`, code, t, iso);
  }
  // A semester of earlier activity: what the events table looks like late in a term.
  const E = s.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)");
  for (let n = 0; n < oldEvents; n++) { const i = n % students; E.run(devOf(i), `s${i}@usc.edu`, "9" + (n % 5000) + "-1", ["lock", "password_released", "unlock", "install"][n % 4], "{}", new Date(now.getTime() - (1 + n % 60) * 86400e3).toISOString()); }
  s.exec("COMMIT"); s.exec("ANALYZE");
}

export async function run({ students = 100000, sitting = 20000, parallel = 200, classes = 1000, beats = 6, oldEvents = 0, quiet = false, top = 12, professors = 0, liveMs = 2000, inspect = null, planAs = 1 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lqz-full-"));
  const s = await start({ port: 0, dataDir: dir, envFile: null, inheritEnv: false, profile: true,
    env: { TEACHER_KEY: "load-key-0123456789", REQUIRE_SIGNED: "1", REQUIRE_GATE: "0", MAIL_SINK: async () => {}, BEAT_S: "600", FEE_EXEMPT: "" } });
  const t0s = Date.now(); seed(s.db, { students, classes, oldEvents }); const seedSecs = (Date.now() - t0s) / 1000;
  s.db.profile.clear();
  const agent = new http.Agent({ keepAlive: true, maxSockets: parallel });
  const times = [], bad = {}; let sent = 0, got = 0;
  const post = (path, body, i) => new Promise(done => {
    const raw = JSON.stringify(body), ts = String(Math.floor(Date.now() / 1000)), dev = devOf(i);
    const h = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw), "CF-Connecting-IP": `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`,
      "X-LOCKqz-Device": dev, "X-LOCKqz-Time": ts, "X-LOCKqz-Sig": sign(keyOf(i), "/api" + path, ts, raw) };
    const t0 = process.hrtime.bigint(); sent++;
    const rq = http.request({ host: "127.0.0.1", port: s.port, path: "/api" + path, method: "POST", headers: h, agent }, rs => {
      const ch = []; rs.on("data", c => ch.push(c)); rs.on("end", () => { times.push(Number(process.hrtime.bigint() - t0) / 1e6); let j = null; try { j = JSON.parse(Buffer.concat(ch)); } catch {} done({ status: rs.statusCode, data: j }); });
    });
    rq.on("error", () => done({ status: 0, data: null })); rq.end(raw);
  });
  const want = (r, what, ok = r.status === 200) => { if (!ok) { const k = what + " " + r.status + " " + (r.data?.reason || r.data?.error || ""); bad[k] = (bad[k] || 0) + 1; } return ok; };
  async function sit(i) {
    const c = i % classes, ou = String(100000 + c), qi = String(500000 + c), lockId = ou + "-" + qi, dev = devOf(i), who = `s${i}@usc.edu`;
    const url = `https://brightspace.usc.edu/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${qi}&ou=${ou}`;
    const cv = await post("/covered", { url, device_id: dev }, i); want(cv, "/covered", cv.status === 200 && cv.data?.covered !== false);
    want(await post("/report", { device_id: dev, event: "lock", quiz_id: lockId, student: who }, i), "/report lock");
    const p = await post("/password", { url, device_id: dev }, i);
    if (want(p, "/password", p.status === 200 && p.data?.password === "LQ-PW-" + c)) got++;
    for (let b = 0; b < beats; b++) want(await post("/report", { device_id: dev, event: "heartbeat", quiz_id: lockId, student: who }, i), "/report heartbeat");
    want(await post("/report", { device_id: dev, event: "unlock", quiz_id: lockId, student: who, detail: { reason: "quiz_submitted" } }, i), "/report unlock");
  }
  // Professors at work while the exams run: each watches one of their exams live (the Sync tab asks every
  // 10 seconds; here every liveMs) and opens the dashboard's pages every 20th round; the admin opens the admin lists.
  const routes = {}, pbad = {}; let running = true;
  const get = (path, token) => new Promise(done => {
    const t0 = process.hrtime.bigint();
    const rq = http.request({ host: "127.0.0.1", port: s.port, path: "/api" + path, method: "GET", headers: { "X-LOCKqz-Teacher": token }, agent }, rs => {
      let n = 0; rs.on("data", c => { n += c.length; }); rs.on("end", () => { const ms = Number(process.hrtime.bigint() - t0) / 1e6, k = path.split("?")[0] + (token === "load-key-0123456789" ? " (admin)" : "");
        const e = routes[k] || (routes[k] = { calls: 0, ms: 0, max_ms: 0, bytes: 0 }); e.calls++; e.ms += ms; if (ms > e.max_ms) e.max_ms = ms; if (n > e.bytes) e.bytes = n;
        if (rs.statusCode !== 200) pbad[k + " " + rs.statusCode] = (pbad[k + " " + rs.statusCode] || 0) + 1; done(); });
    });
    rq.on("error", () => { pbad[path + " error"] = (pbad[path + " error"] || 0) + 1; done(); }); rq.end();
  });
  const profWork = Array.from({ length: Math.min(professors, Math.ceil(classes / 4)) }, async (_, n) => {
    const tok = "tok-t" + n + "-0123456789abcdef", c = n * 4, quiz = (100000 + c) + "-" + (500000 + c);
    for (let round = 0; running; round++) {
      await get("/live?quiz=" + quiz, tok);
      if (round % 20 === 0) for (const r of ["/me", "/bs", "/quizzes", "/sessions", "/sessions?quiz=" + quiz, "/sessions?quiz=" + (100000 + c), "/live?quiz=" + (100000 + c), "/my-sections", "/synckey", "/letin?quiz=" + quiz, "/courses"]) await get(r, tok);
      await new Promise(r => setTimeout(r, liveMs));
    }
  });
  const adminWork = professors ? (async () => { while (running) { for (const r of ["/me", "/teachers", "/payments", "/sessions", "/reset-requests", "/invites", "/bs", "/quizzes", "/courses", "/live?quiz=100000"]) await get(r, "load-key-0123456789"); await new Promise(r => setTimeout(r, 2000)); } })() : null;
  // Students spread over the whole database (not the first N), so every class has some sitting.
  const step = Math.max(1, Math.floor(students / sitting)); let next = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: Math.min(parallel, sitting) }, async () => { while (next < sitting) await sit((next++) * step); }));
  const secs = (Date.now() - t0) / 1000;
  running = false; await Promise.all(profWork); if (adminWork) await adminWork;
  times.sort((a, b) => a - b);
  const pct = q => times[Math.min(times.length - 1, Math.floor(times.length * q))];
  const sql = [...s.db.profile.entries()].map(([q, e]) => ({ calls: e.n, total_ms: Math.round(e.ms), avg_ms: +(e.ms / e.n).toFixed(3), max_ms: +e.max.toFixed(1), sql: q.replace(/\s+/g, " ").slice(0, 150) })).sort((a, b) => b.total_ms - a.total_ms);
  // Statements that walk a whole big table (their cost grows with the size of the database).
  const BIG = ["events", "devices", "roster", "payments", "locks", "pay_codes_students", "bs_quizzes", "quizzes", "teachers", "teacher_courses", "submissions"];
  const scans = [];
  // Plan as the database would at planAs times this size (the planner goes by the table sizes it has on record).
  if (planAs > 1) { s.db.sqlite.exec("ANALYZE"); s.db.sqlite.prepare("UPDATE sqlite_stat1 SET stat = CAST(CAST(substr(stat, 1, instr(stat || ' ', ' ') - 1) AS INTEGER) * ? AS TEXT) || substr(stat, instr(stat || ' ', ' '))").run(planAs); s.db.sqlite.exec("ANALYZE sqlite_schema"); }
  for (const [q, e] of s.db.profile.entries()) {
    let plan = []; try { plan = s.db.sqlite.prepare("EXPLAIN QUERY PLAN " + q).all(...Array(q.split("?").length - 1).fill(null)).map(r => r.detail); } catch { continue; }
    const hit = plan.filter(d => { const m = /^SCAN (\w+)$/.exec(d); if (!m) return false;
      return BIG.includes(m[1]) || BIG.some(t => new RegExp("\\b" + t + "\\s+(AS\\s+)?" + m[1] + "\\b", "i").test(q)); });
    if (hit.length) scans.push({ calls: e.n, avg_ms: +(e.ms / e.n).toFixed(2), plan: hit.join(" | "), sql: q.replace(/\s+/g, " ").slice(0, 170) });
  }
  scans.sort((a, b) => b.avg_ms - a.avg_ms);
  const out = { in_database: { students, classes, payments: students * 4, class_list_rows: students * 3, old_events: oldEvents, seed_seconds: +seedSecs.toFixed(1) },
    sitting, passwords: got, requests: sent, seconds: +secs.toFixed(2), per_second: Math.round(sent / secs), sittings_per_hour: Math.round(sitting / secs * 3600),
    ms_p50: +pct(0.5).toFixed(1), ms_p95: +pct(0.95).toFixed(1), ms_p99: +pct(0.99).toFixed(1), failed: bad, server_errors: s.counters.errors,
    queries: s.db.stats.queries, queries_per_request: +(s.db.stats.queries / sent).toFixed(2), sql_ms_total: sql.reduce((a, x) => a + x.total_ms, 0),
    ...(professors ? { professor_failed: pbad, professor_routes: Object.fromEntries(Object.entries(routes).map(([k, e]) => [k, { calls: e.calls, avg_ms: +(e.ms / e.calls).toFixed(1), max_ms: +e.max_ms.toFixed(1), bytes: e.bytes }]).sort((a, b) => b[1].max_ms - a[1].max_ms)) } : {}),
    whole_table_reads: scans, slowest: sql.slice(0, top) };
  if (inspect) await inspect(s, out);
  agent.destroy(); await s.close(); rmSync(dir, { recursive: true, force: true });
  if (!quiet) console.log(JSON.stringify(out, null, 1));
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [a, b, c, d, e, f, g] = process.argv.slice(2).map(Number);
  await run({ students: a || 100000, sitting: b || 20000, parallel: c || 200, classes: d || 1000, oldEvents: e || 0, professors: f || 0, liveMs: g || 2000 });
}
