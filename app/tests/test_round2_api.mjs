// Round-2 API regressions (25 Oct 2026): one block per finding fixed in app/cloudflare/functions/api.
// Runs the REAL API against in-memory SQLite with a D1 shim that enforces the 100-parameter cap, counts
// D1 queries per request (Free plan: 50; target <= 45) and rows written, and logs every statement so a
// check can EXPLAIN its query plan. Prove a check fails on the old code with
//   LQZ_CF=<old app/cloudflare dir> node --no-warnings test_round2_api.mjs     (old route + old schema)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes, pbkdf2Sync } from "node:crypto";

// Controllable clock (the API reads Date): CLOCK.off ms are added to the real time.
const RealDate = Date, CLOCK = { off: 0 };
class FDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + CLOCK.off); } static now() { return RealDate.now() + CLOCK.off; } }
globalThis.Date = FDate;
const setToday = isoLA => { CLOCK.off = 0; CLOCK.off = RealDate.parse(isoLA + "T20:00:00Z") - RealDate.now(); };   // noon in LA

const HERE = dirname(fileURLToPath(import.meta.url));
const CF = process.env.LQZ_CF || join(HERE, "..", "cloudflare");
const ROUTE = join(CF, "functions", "api", "[[route]].js");
const tmp = mkdtempSync(join(tmpdir(), "lqz-r2-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(ROUTE));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

let Q = 0, W = 0, LOG = [];
function d1(sqlite) {
  const mk = sql => { const st = sqlite.prepare(sql); let args = [];
    const s = {
      bind(...a) { if (a.length > 100) throw new Error("too many SQL variables (" + a.length + ")");
        args = a.map(x => { if (x === undefined) throw new Error("D1_TYPE_ERROR: undefined"); if (x !== null && typeof x === "object") throw new Error("D1_TYPE_ERROR: object"); return typeof x === "boolean" ? Number(x) : x; }); return s; },
      first: async () => { Q++; LOG.push([sql, args]); return st.get(...args) ?? null; },
      all: async () => { Q++; LOG.push([sql, args]); return { results: st.all(...args) }; },
      run: async () => { Q++; LOG.push([sql, args]); const c = Number(st.run(...args).changes); W += c; return { meta: { changes: c } }; },
      _run() { LOG.push([sql, args]); W += Number(st.run(...args).changes); } };
    return s; };
  return { prepare: mk, async batch(sts) { Q++; sqlite.exec("BEGIN"); try { for (const s of sts) s._run(); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; } return []; } };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch {} }
const MAILS = [];
const env = { DB: d1(sqlite), TEACHER_KEY: "admin-key-r2", REQUIRE_SIGNED: "1", ADMIN_EMAIL: "admin@usc.edu", ROT_SECRET: "rot-secret-r2",
              STUDENT_FEE: "5", PAY_SECRET: "pay-secret-r2-0123456789", LIVE_CACHE_MS: "0", MAIL_SINK: async m => { MAILS.push(m); return true; } };
const BASE = "https://lockqz.test";
const sign = (key, path, ts, raw) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(raw).digest("hex")}`).digest("hex");
async function call(path, body, { teacher = null, sync = null, dev = null, get = false, ip = "10.0.0.9", hdr = {}, envx = {} } = {}) {
  const raw = JSON.stringify(body ?? {});
  const h = { "Content-Type": "application/json", "CF-Connecting-IP": ip, ...hdr };
  if (teacher) h["X-LOCKqz-Teacher"] = teacher;
  if (sync) h["X-LOCKqz-Sync"] = sync;
  if (dev) { const ts = String(Math.floor(Date.now() / 1000)); h["X-LOCKqz-Device"] = dev.id; h["X-LOCKqz-Time"] = ts; h["X-LOCKqz-Sig"] = sign(dev.key, "/api" + path.replace(/\?.*/, ""), ts, raw); }
  Q = 0; W = 0; LOG = [];
  const res = await onRequest({ request: new Request(BASE + "/api" + path, { method: get ? "GET" : "POST", headers: h, body: get ? undefined : raw }), env: { ...env, ...envx } });
  return { status: res.status, data: await res.json().catch(() => null), q: Q, w: W, log: LOG };
}
// Tolerant of the OLD schema (LQZ_CF runs): a column that does not exist yet reads as "missing".
const one = (sql, ...a) => { try { return sqlite.prepare(sql).get(...a); } catch { return { __missing: true }; } };
const n = (sql, ...a) => { try { return Number(Object.values(sqlite.prepare(sql).get(...a))[0]); } catch { return NaN; } };
const tid = email => one("SELECT id FROM teachers WHERE email=?", email)?.id;
const plans = log => log.map(([sql, args]) => { try { return { sql, plan: sqlite.prepare("EXPLAIN QUERY PLAN " + sql).all(...args).map(r => r.detail).join(" | ") }; } catch (e) { return { sql, plan: "?" + e.message }; } });
const badEventPlans = log => plans(log).filter(p => /\bevents\b/.test(p.sql) && /(SCAN (e|events)\b(?! USING)|USING (COVERING )?INDEX idx_events_event_ts \(event=\?\)$)/m.test(p.plan.split(" | ").filter(x => /\b(e|events)\b/.test(x)).join("\n")));
const quizUrl = (ou, qi, host = "usc.brightspace.com") => `https://${host}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${qi}&ou=${ou}`;
let ipN = 0;
async function device(id, email) {
  const d = { id, key: randomBytes(32).toString("hex") };
  await call("/register", { device_id: id, key: d.key, platform: "mac", version: "0.4.1" }, { ip: "10.8." + (++ipN % 250) + "." + (ipN >> 8) });
  if (email) { const k = MAILS.length; await call("/verify", { op: "send", email }, { dev: d }); const m = MAILS.slice(k).find(x => x.to === email);
    if (m) await call("/verify", { op: "code", email, code: m.code }, { dev: d }); }
  return d;
}
const lock = (d, lid, extra = {}) => call("/report", { event: "lock", quiz_id: lid, ...extra }, { dev: d });
const beat = (d, lid) => call("/report", { event: "heartbeat", quiz_id: lid, source: "helper" }, { dev: d });
const unlock = (d, lid, reason) => call("/report", { event: "unlock", quiz_id: lid, reason }, { dev: d });
const pw = (d, ou, qi, host) => call("/password", { url: quizUrl(ou, qi, host), device_id: d.id }, { dev: d });
const live = (lid, teacher) => call(`/live?quiz=${lid}`, null, { teacher, get: true });
const iso = ms => new Date(Date.now() + ms).toISOString();
async function invited(email, until = "2099-12-31", pinned = true) {
  const code = (await call("/invite", { email: pinned ? email : null, until }, { teacher: ADMIN })).data?.code;
  return (await call("/signup", { email, password: "profpass12", name: "Prof " + email.split("@")[0], invite: code })).data?.token;
}

const ADMIN = (await call("/signup", { email: "admin@usc.edu", password: "adminpass1", name: "Anthony Hall" })).data.token;

// ---------- world: course 500 (admin-seeded), professor P (Brightspace id 8001), students ----------
const roster500 = [{ id: "8001", name: "Pat Prof", email: "p@usc.edu", role: "Instructor" },
  ...Array.from({ length: 6 }, (_, i) => ({ id: String(9100 + i), name: "Stu Dent" + i, email: `s${i}@usc.edu`, role: "Student" }))];
await call("/sync", { courses: [{ ou: "500", name: "ECON 203", classlist: roster500, quizzes: [] }] }, { teacher: ADMIN });
const P = await invited("p@usc.edu");
const quizzes500 = [{ qi: "1", name: "Q1", active: true }, { qi: "2", name: "Q2 later", active: true, start: iso(3 * 3600e3), end: iso(5 * 3600e3) }];
let r = await call("/sync", { whoami: { id: "8001" }, courses: [{ ou: "500", name: "ECON 203", classlist: roster500, quizzes: quizzes500 }] }, { teacher: P });
check("setup: P verified and quizzes 500-1/500-2 auto-protected", (await call("/me", null, { teacher: P, get: true })).data?.verified === true && n("SELECT COUNT(*) FROM quizzes WHERE ou='500'") === 2, JSON.stringify(r.data).slice(0, 200));
const PW1 = one("SELECT password FROM quizzes WHERE ou='500' AND qi='1'")?.password;
const D = []; for (let i = 0; i < 6; i++) D.push(await device("mac-r2-" + i, `s${i}@usc.edu`));

console.log("R1 (I-B1) an invited professor whose course nobody seeded verifies through their own Sync");
{ const T = await invited("newprof@usc.edu");
  const cl = [{ id: "7001", name: "New Prof", email: "newprof@usc.edu", role: "Instructor" }, { id: "7002", name: "Kid", email: "kid@usc.edu", role: "Student" }];
  r = await call("/sync", { whoami: { id: "7001" }, courses: [{ ou: "700", name: "FBE 437", classlist: cl, quizzes: [{ qi: "71", name: "Final", active: true }] }] }, { teacher: T });
  const me = (await call("/me", null, { teacher: T, get: true })).data;
  check("vouched (email-pinned invite) professor is verified by their own first Sync", me?.verified === true, JSON.stringify(me));
  check("... becomes the course's trusted instructor (gets its protected quiz back)", (r.data?.protect || []).some(x => String(x.qi) === "71"), JSON.stringify(r.data));
  const U = (await call("/signup", { email: "fake@usc.edu", password: "fakepass12" })).data.token;
  await call("/sync", { whoami: { id: "7101" }, courses: [{ ou: "710", name: "X", classlist: [{ id: "7101", name: "Fake", email: "fake@usc.edu", role: "Instructor" }], quizzes: [] }] }, { teacher: U });
  check("an UNVOUCHED account with a self-made class list never verifies", (await call("/me", null, { teacher: U, get: true })).data?.verified === false);
  const O = await invited("open@usc.edu", "2099-12-31", false);
  await call("/sync", { whoami: { id: "7201" }, courses: [{ ou: "720", name: "Y", classlist: [{ id: "7201", name: "Open", email: "open@usc.edu", role: "Instructor" }], quizzes: [] }] }, { teacher: O });
  check("an open (no-email) invite does not self-verify (its email was never fixed by the admin)", (await call("/me", null, { teacher: O, get: true })).data?.verified === false);
  const L = await invited("lect@usc.edu");
  await call("/sync", { whoami: { id: "7301" }, courses: [{ ou: "730", name: "Z", lis_roles: ["urn:lti:role:ims/lis/Instructor"], classlist: [{ id: "7301", name: "Lec", email: "lect@usc.edu", role: "Course Coordinator", role_id: 109 }, { id: "7302", name: "Kid", email: "k2@usc.edu", role: "", role_id: 110 }, { id: "7303", name: "Kid3", email: "k3@usc.edu", role: "Student", role_id: 110 }], quizzes: [] }] }, { teacher: L });
  check("C4: LIS Instructor role verifies a professor whose role name is unusual", (await call("/me", null, { teacher: L, get: true })).data?.verified === true);
  check("C4: a user with no role name but the learners' role_id is a learner", one("SELECT role FROM roster WHERE ou='730' AND user_id='7302'")?.role === "Student");
  const TA = await invited("ta@usc.edu");
  await call("/sync", { whoami: { id: "7401" }, courses: [{ ou: "740", name: "W", lis_roles: ["urn:lti:role:ims/lis/Instructor/TeachingAssistant"], classlist: [{ id: "7401", name: "Ta", email: "ta@usc.edu", role: "Teaching Assistant" }], quizzes: [] }] }, { teacher: TA });
  check("C4: a TeachingAssistant LIS role never makes an instructor", (await call("/me", null, { teacher: TA, get: true })).data?.verified === false);
  const LE = await invited("lecturer@usc.edu");
  await call("/sync", { whoami: { id: "7501" }, courses: [{ ou: "750", name: "V", classlist: [{ id: "7501", name: "Le", email: "lecturer@usc.edu", role: "Lecturer" }], quizzes: [] }] }, { teacher: LE });
  check("C4: role name 'Lecturer' counts as instructor", (await call("/me", null, { teacher: LE, get: true })).data?.verified === true);
}

console.log("R2 (H4) an unvouched account stores and reads no class list (FERPA)");
{ const U = (await call("/signup", { email: "seeder@usc.edu", password: "seedpass12" })).data.token;
  await call("/sync", { whoami: { id: "1" }, courses: [{ ou: "800", name: "Seeded", classlist: [{ id: "1", name: "Me", email: "seeder@usc.edu", role: "Student" }, { id: "2", name: "Victim Name", email: "victim@usc.edu", role: "Student" }], quizzes: [] }] }, { teacher: U });
  check("seeding stores no roster rows", n("SELECT COUNT(*) FROM roster WHERE ou='800'") === 0);
  r = await call("/bs", null, { teacher: U, get: true });
  const c = (r.data?.courses || []).find(x => String(x.ou) === "800");
  check("/bs lists the seeded course with no students", !!c && (c.students || []).length === 0 && !JSON.stringify(r.data).includes("victim@usc.edu"), JSON.stringify(c));
}

console.log("R3 (I-B2, H11) /password, /live, /sessions never scan the day's events");
{ const t = new Date().toISOString(), ins = sqlite.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)");
  sqlite.exec("BEGIN"); for (let i = 0; i < 3000; i++) { ins.run("bg" + i, "bg@usc.edu", "999-" + (i % 50), "lock", null, t); ins.run("bg" + i, "bg@usc.edu", "999-" + (i % 50), "password_released", '{"v":"x"}', t); } sqlite.exec("COMMIT");

  await lock(D[0], "500-1");
  r = await pw(D[0], "500", "1");
  check("precondition: password released", r.data?.password === PW1, JSON.stringify(r.data));
  let bad = badEventPlans(r.log);
  check("/password: every events read uses (device_id, quiz_id, event)", !bad.length, bad.map(b => b.plan).join(" || "));
  r = await live("500-1", P);
  bad = badEventPlans(r.log);
  check("/live: events read through (quiz_id, event)", r.status === 200 && !bad.length, bad.map(b => b.plan).join(" || "));
  r = await call("/sessions", null, { teacher: P, get: true });
  bad = plans(r.log).filter(p => /FROM events/.test(p.sql) && /SCAN events\b(?! USING)/.test(p.plan));
  check("/sessions (professor): no full scan of events", r.status === 200 && !bad.length && (r.data?.events || []).some(e => e.quiz_id === "500-1") && !(r.data?.events || []).some(e => String(e.quiz_id).startsWith("999-")), bad.map(b => b.plan).join(" || "));
  r = await call("/bs", null, { teacher: P, get: true });
  bad = plans(r.log).filter(p => /devices/.test(p.sql) && /SCAN d(evices)?\b(?! USING)/.test(p.plan));
  check("/bs: installed devices found by email index, no scan of all devices", r.status === 200 && !bad.length, bad.map(b => b.plan).join(" || "));
  const st = (r.data?.courses || []).find(c => String(c.ou) === "500")?.students || [];
  check("/bs: verified students show as installed", st.filter(s => s.installed).length === 6, JSON.stringify(st.map(s => [s.email, s.installed])));
}

console.log("R4 (C1) the helper's signed password request refreshes its own lock (no heartbeat first)");
{ sqlite.prepare("UPDATE locks SET last_lock=?, helper_seen=? WHERE device_id=? AND quiz_id='500-1'").run(iso(-120000), iso(-120000), D[0].id);
  r = await pw(D[0], "500", "1");
  check("signed /password on a 2-minute-old lock -> password", r.status === 200 && r.data?.password === PW1, JSON.stringify(r.data));
  check("... and last_lock/helper_seen are refreshed", Date.now() - Date.parse(one("SELECT last_lock FROM locks WHERE device_id=? AND quiz_id='500-1'", D[0].id).last_lock) < 5000);
  r = await pw(D[0], "500", "1");
  check("a repeat within the minute writes no row", r.w === 0, `w=${r.w}`);
}

console.log("R5 (C2, F4) start check only while gated; accommodations pass; end returned");
{ await lock(D[1], "500-2");
  r = await pw(D[1], "500", "2");
  check("NOT gated + not started -> password (Brightspace enforces its own start)", r.status === 200 && !!r.data?.password, JSON.stringify(r.data));
  check("... with end null when NOT gated (server cannot see special access -> helper keeps its 6 h failsafe)", r.data?.end === null, JSON.stringify(r.data));
  await call("/gate", { ou: "500", qi: "2", on: true, keep: ["9102"] }, { teacher: P });
  r = await pw(D[1], "500", "2");
  check("gated + not started -> 403 {reason:'not started', start}", r.status === 403 && r.data?.reason === "not started" && !!r.data?.start, JSON.stringify(r.data));
  await lock(D[2], "500-2");
  r = await pw(D[2], "500", "2");
  check("gated + accommodated (in the gate's kept special-access list) -> password, end null (6 h cap)", r.status === 200 && !!r.data?.password && r.data?.end === null, JSON.stringify(r.data));
  await call("/gate", { ou: "500", qi: "2", on: false }, { teacher: P });
  await call("/gate", { ou: "500", qi: "2", on: true, keep: [], start: iso(-60000), end: iso(3600e3) }, { teacher: P });
  r = await pw(D[1], "500", "2");
  check("F4: the gate takes Brightspace's current dates from the Sync tab (moved earlier -> started)", r.status === 200 && !!r.data?.password, JSON.stringify(r.data));
  check("gated + not accommodated -> end = the quiz's Brightspace end (cap = end + 15 min)", typeof r.data?.end === "string" && Math.abs(Date.parse(r.data.end) - Date.parse(one("SELECT end_date FROM bs_quizzes WHERE ou='500' AND qi='2'").end_date)) < 1000, JSON.stringify(r.data));
  // round-2 #6: the gate pushes changed Brightspace dates mid-gate; the kept accommodation list survives
  await call("/gate", { ou: "500", qi: "2", on: true, start: iso(3600e3), end: iso(7200e3) }, { teacher: P });
  r = await pw(D[1], "500", "2");
  check("#6 mid-gate date push (start moved later) -> start check uses it", r.status === 403 && r.data?.reason === "not started", JSON.stringify(r.data));
  check("#6 ... and the gate's kept list is unchanged", one("SELECT sa_keep FROM quizzes WHERE ou='500' AND qi='2'").sa_keep === "[]", JSON.stringify(one("SELECT sa_keep FROM quizzes WHERE ou='500' AND qi='2'")));
  await call("/gate", { ou: "500", qi: "2", on: true, start: iso(-60000), end: iso(3600e3) }, { teacher: P });
  await call("/gate", { ou: "500", qi: "2", on: false }, { teacher: P });
}

console.log("R6 (C9) the server tells the helper to unlock: submitted (after this lock) or quiz ended");
{ await lock(D[3], "500-1");
  r = await beat(D[3], "500-1");
  check("locked, nothing submitted -> no unlock", r.status === 200 && !r.data?.unlock, JSON.stringify(r.data));
  await call("/submitted", { ou: "500", qi: "1", users: [{ id: "9103", completed: iso(-24 * 3600e3) }] }, { teacher: P });
  r = await beat(D[3], "500-1");
  check("a submission from BEFORE this lock (earlier attempt) -> no unlock", !r.data?.unlock, JSON.stringify(r.data));
  await call("/submitted", { ou: "500", qi: "1", users: [{ id: "9103", completed: iso(1000) }] }, { teacher: P });
  r = await beat(D[3], "500-1");
  check("submitted after this lock -> {unlock:true, reason:'quiz_submitted'}", r.data?.unlock === true && r.data?.reason === "quiz_submitted", JSON.stringify(r.data));
  // round-2 #1: "quiz_ended" only for a GATED quiz, a student not in the gate's kept list, and a lock that
  // began before the end. Non-gated quizzes (special access the server cannot see) never get it.
  await lock(D[4], "500-1");
  sqlite.prepare("UPDATE bs_quizzes SET end_date=? WHERE ou='500' AND qi='1'").run(iso(-20 * 60000));
  sqlite.prepare("UPDATE locks SET locked_at=? WHERE device_id=? AND quiz_id='500-1'").run(iso(-60 * 60000), D[4].id);
  r = await beat(D[4], "500-1");
  check("#1 NOT gated, end passed 20 min ago -> no unlock (makeup / extended end possible)", !r.data?.unlock, JSON.stringify(r.data));
  await call("/gate", { ou: "500", qi: "1", on: true, keep: ["9103"] }, { teacher: P });
  r = await beat(D[4], "500-1");
  check("#1 gated, not kept, locked before the end, end + 15 passed -> {unlock:true, reason:'quiz_ended'}", r.data?.unlock === true && r.data?.reason === "quiz_ended", JSON.stringify(r.data));
  await lock(D[3], "500-1");
  sqlite.prepare("DELETE FROM submissions WHERE ou='500' AND qi='1'").run();
  r = await beat(D[3], "500-1");
  check("#1 gated, student in the kept (accommodation) list -> no unlock", !r.data?.unlock, JSON.stringify(r.data));
  sqlite.prepare("UPDATE locks SET locked_at=? WHERE device_id=? AND quiz_id='500-1'").run(iso(-60000), D[4].id);
  r = await beat(D[4], "500-1");
  check("#1 gated, lock began AFTER the end (makeup through special access) -> no unlock", !r.data?.unlock, JSON.stringify(r.data));
  sqlite.prepare("UPDATE locks SET locked_at=? WHERE device_id=? AND quiz_id='500-1'").run(iso(-60 * 60000), D[4].id);
  await call("/gate", { ou: "500", qi: "1", on: false }, { teacher: P });   // e.g. the Sync tab's auto-stop at end + 15 min
  r = await beat(D[3], "500-1");
  check("#1 gate stopped (auto-stop) -> kept student never gets quiz_ended", !r.data?.unlock, JSON.stringify(r.data));
  r = await beat(D[4], "500-1");
  check("#1 gate stopped -> no quiz_ended for anyone (gated=0)", !r.data?.unlock, JSON.stringify(r.data));
  sqlite.prepare("UPDATE bs_quizzes SET end_date=NULL WHERE ou='500' AND qi='1'").run();
  await unlock(D[3], "500-1", "quiz_submitted"); await unlock(D[4], "500-1", "quiz_left");
}

console.log("R7 (I-H1, C5) a submission never erases an earlier mid-quiz unlock");
{ const L = "500-1";
  await lock(D[5], L);
  await unlock(D[5], L, "quiz_tab_closed");          // AI back on mid-quiz
  await lock(D[5], L);                               // back in the quiz
  await call("/submitted", { ou: "500", qi: "1", users: [{ id: "9105", completed: iso(5000) }] }, { teacher: P });
  r = await live(L, P);
  const row = (r.data?.rows || []).find(x => x.device_id === D[5].id);
  check("unlock before Brightspace's completion time stays red after submitting", row?.status === "left_early" && row?.submitted === true && row?.reason === "quiz_tab_closed", JSON.stringify(row));
  check("flagged student stays admitted while locked (documented choice)", row?.eligible === true, JSON.stringify(row));
  const e = await device("mac-r2-e", "s0@usc.edu");   // same student, another computer
  await lock(e, "500-1"); await call("/submitted", { ou: "500", qi: "1", users: [{ id: "9100", completed: iso(-1000) }] }, { teacher: P });
  await unlock(e, "500-1", "quiz_tab_closed");       // after completing: clean
  r = await live(L, P);
  const r2 = (r.data?.rows || []).find(x => x.device_id === e.id);
  check("an unlock AFTER completion is clean", r2 && r2.status === "done" && r2.submitted === true, JSON.stringify(r2));
  r = await call("/submitted", { ou: "500", qi: "1", user_ids: ["9104"] }, { teacher: P });
  check("old {user_ids:[...]} shape still accepted", r.status === 200 && !!one("SELECT 1 FROM submissions WHERE ou='500' AND qi='1' AND user_id='9104'"));
}

console.log("R8 (I-H2, I-M9, double click) turning protection off and on");
{ r = await call("/protect", { ou: "500", qi: "1", on: false }, { teacher: P });
  check("off -> the password waits to be removed from Brightspace", r.data?.clear === PW1 && !!one("SELECT 1 FROM pending_clear WHERE ou='500' AND qi='1'"));
  await lock(D[0], "500-1");
  r = await pw(D[0], "500", "1");
  check("I-M9: a locked student still gets the password Brightspace still holds", r.data?.password === PW1, JSON.stringify(r.data));
  const [a, b] = await Promise.all([call("/protect", { ou: "500", qi: "1", on: true }, { teacher: P }), call("/protect", { ou: "500", qi: "1", on: true }, { teacher: P })]);
  check("double click 'on' -> both 200, one row", a.status === 200 && b.status === 200 && n("SELECT COUNT(*) FROM quizzes WHERE ou='500' AND qi='1'") === 1, `${a.status} ${b.status} ${JSON.stringify(b.data)}`);
  check("I-H2: on again before a Sync -> the SAME password Brightspace holds", a.data?.password === PW1 && b.data?.password === PW1 && one("SELECT password FROM quizzes WHERE ou='500' AND qi='1'").password === PW1, `${a.data?.password} ${b.data?.password}`);
}

console.log("R9 (C3, F6, F10) professor's own settings saved once; auto-protect skips their own password; drafts covered");
{ const qs = [...quizzes500, { qi: "3", name: "Own pw", active: true, has_password: true }, { qi: "4", name: "Draft", active: false, end: iso(86400e3) }, { qi: "5", name: "Over", active: true, end: iso(-86400e3) }];
  r = await call("/sync", { whoami: { id: "8001" }, courses: [{ ou: "500", name: "ECON 203", classlist: roster500, quizzes: qs }] }, { teacher: P });
  check("auto-protect skips a quiz with the professor's own password", !one("SELECT 1 FROM quizzes WHERE ou='500' AND qi='3'"));
  check("F10: an inactive (draft) quiz that has not ended is protected", !!one("SELECT 1 FROM quizzes WHERE ou='500' AND qi='4'"));
  check("an ended quiz is not", !one("SELECT 1 FROM quizzes WHERE ou='500' AND qi='5'"));
  let bs = (await call("/bs", null, { teacher: P, get: true })).data;
  let q3 = (bs.courses.find(c => String(c.ou) === "500").quizzes || []).find(q => String(q.qi) === "3");
  check("/bs marks it has_own_password", q3?.has_own_password === true, JSON.stringify(q3));
  await call("/sync-result", { results: [{ ou: "500", qi: "3", status: "set", orig_password: "prof-own-1", orig_hidden: false }] }, { teacher: P });
  await call("/sync-result", { results: [{ ou: "500", qi: "3", status: "set", orig_password: "LQ-OURS", orig_hidden: true }] }, { teacher: P });
  bs = (await call("/bs", null, { teacher: P, get: true })).data;
  q3 = (bs.courses.find(c => String(c.ou) === "500").quizzes || []).find(q => String(q.qi) === "3");
  check("orig_password/orig_hidden saved once, never overwritten", q3?.orig_password === "prof-own-1" && q3?.orig_hidden === false && q3?.orig_password_saved === true, JSON.stringify(q3));
  r = await call("/sync", { whoami: { id: "8001" }, courses: [{ ou: "500", name: "ECON 203", classlist: roster500, quizzes: qs }] }, { teacher: P });
  await call("/sync-result", { results: [{ ou: "500", qi: "4", status: "set", orig_password: null }] }, { teacher: P });
  r = await call("/sync", { whoami: { id: "8001" }, courses: [{ ou: "500", name: "ECON 203", classlist: roster500, quizzes: qs }] }, { teacher: P });
  const p4 = (r.data?.protect || []).find(x => String(x.qi) === "4");
  check("/sync protect rows carry orig_* too (null saved = 'had no password')", p4 && p4.orig_password === null && p4.orig_password_saved === true, JSON.stringify(p4));
  await call("/sync-result", { results: [{ ou: "500", qi: "3", status: "cleared" }] }, { teacher: P });
  check("released ('cleared') -> saved settings dropped", one("SELECT orig FROM bs_quizzes WHERE ou='500' AND qi='3'")?.orig == null);
}

console.log("R10 (I-M2, I-M6) password change during a gate keeps the Sync key until the gate stops");
{ const K = (await call("/synckey", null, { teacher: P, get: true })).data.key;
  await call("/gate", { ou: "500", qi: "1", on: true, keep: [] }, { teacher: P });
  r = await call("/changepw", { old_password: "profpass12", password: "profpass34" }, { teacher: P });
  const P2 = r.data?.token;
  check("/changepw during a gate keeps the Sync key working", r.status === 200 && (await call("/me", null, { sync: K, get: true })).status === 200, JSON.stringify(r.data));
  await call("/gate", { ou: "500", qi: "1", on: false }, { sync: K });
  check("the kept key dies when the last gate stops", (await call("/me", null, { sync: K, get: true })).status === 401 && one("SELECT sync_key FROM teachers WHERE email='p@usc.edu'").sync_key === null);
  globalThis.P2 = P2;
}
const PT = globalThis.P2;

console.log("R11 (I-M8) an unpaid co-instructor never releases a course a paid one teaches");
{ const cl = [{ id: "6001", name: "Co A", email: "coa@usc.edu", role: "Instructor" }, { id: "6002", name: "Co B", email: "cob@usc.edu", role: "Instructor" }, { id: "6003", name: "K", email: "kk@usc.edu", role: "Student" }];
  await call("/sync", { courses: [{ ou: "600", name: "Co", classlist: cl, quizzes: [] }] }, { teacher: ADMIN });
  const A = await invited("coa@usc.edu"), B = await invited("cob@usc.edu");
  await call("/sync", { whoami: { id: "6001" }, courses: [{ ou: "600", name: "Co", classlist: cl, quizzes: [{ qi: "61", name: "Q", active: true }] }] }, { teacher: A });
  await call("/sync", { whoami: { id: "6002" }, courses: [{ ou: "600", name: "Co", classlist: cl, quizzes: [{ qi: "61", name: "Q", active: true }] }] }, { teacher: B });
  check("precondition: quiz 600-61 protected (by A)", one("SELECT teacher_id FROM quizzes WHERE ou='600' AND qi='61'")?.teacher_id === tid("coa@usc.edu"));
  await call("/activate", { email: "coa@usc.edu", until: null }, { teacher: ADMIN });
  check("A turned off, B still active -> the shared course stays protected", !!one("SELECT 1 FROM quizzes WHERE ou='600' AND qi='61'") && !one("SELECT 1 FROM pending_clear WHERE ou='600' AND qi='61'"));
}

console.log("R12 section-billed professor: /sync cost does not grow per course");
{ const cs = Array.from({ length: 21 }, (_, i) => ({ ou: String(4000 + i), name: `20263_ECON${100 + i} Section ${30000 + i}`, code: `ECON-${100 + i}`, role: "Instructor",
    classlist: [{ id: "5555", name: "Sec Prof", email: "sec@usc.edu", role: "Instructor" }], quizzes: [{ qi: String(40000 + i), name: "Q", active: true }] }));
  await call("/sync", { courses: cs.map(c => ({ ...c, quizzes: [] })) }, { teacher: ADMIN });
  const S = await invited("sec@usc.edu", null);
  sqlite.exec("BEGIN"); for (let i = 0; i < 21; i++) { sqlite.prepare("INSERT OR REPLACE INTO usc_sections (term,section,course,title,first,last) VALUES ('20263',?,?,?,?,?)").run(String(30000 + i), `ECON ${100 + i}`, "T", "Sec", "Prof"); sqlite.prepare("INSERT INTO paid_sections (teacher_id,term,section,course,first,last,until) VALUES (?,?,?,?,?,?,?)").run(tid("sec@usc.edu"), "20263", String(30000 + i), `ECON ${100 + i}`, "Sec", "Prof", "2099-12-31"); } sqlite.exec("COMMIT");
  r = await call("/sync", { whoami: { id: "5555" }, courses: cs }, { teacher: S });
  check(`21 paid-by-section courses: /sync <= 30 queries and every quiz protected`, r.status === 200 && r.q <= 30 && n("SELECT COUNT(*) FROM quizzes WHERE teacher_id=?", tid("sec@usc.edu")) === 21, `q=${r.q} quizzes=${n("SELECT COUNT(*) FROM quizzes WHERE teacher_id=?", tid("sec@usc.edu"))}`);
}

console.log("R13 small fixes: code re-submit, /pay-sections date, /version, C10 other schools");
{ const k = MAILS.length;
  r = await call("/verify", { op: "code", email: "s0@usc.edu", code: "000000" }, { dev: D[0] });
  check("re-submitting a code after success is a no-op (no new email)", r.data?.verified === true && MAILS.length === k, JSON.stringify(r.data));
  r = await call("/pay-sections", { email: "p@usc.edu", term: "20263", sections: ["12345"], until: "2026-02-31" }, { teacher: ADMIN });
  check("/pay-sections refuses an impossible date", r.status === 400, `got ${r.status}`);
  r = await call("/version", null, { get: true });
  check("C7 GET /version -> {version, api, codes_on, strict, fee_on}", r.status === 200 && "version" in r.data && "api" in r.data && r.data.codes_on === true && r.data.strict === true && r.data.fee_on === false, JSON.stringify(r.data));
  await lock(D[0], "500-1");
  r = await pw(D[0], "500", "1", "learn.otherschool.edu");
  check("C10: a quiz on another school's Brightspace -> 403 other_school", r.status === 403 && r.data?.reason === "other_school", JSON.stringify(r.data));
  r = await call("/sync", { host: "d2l.otherschool.edu", courses: [] }, { teacher: PT });
  check("C10: Sync from another school's Brightspace refused", r.status === 403 && r.data?.reason === "other_school", JSON.stringify(r.data));
  r = await call("/sync", { host: "usc.brightspace.com", courses: [] }, { teacher: PT });
  check("C10: Sync from USC's Brightspace accepted", r.status === 200, JSON.stringify(r.data));
}

console.log("R14 (H5, H10) email codes: per-recipient limits; no full name or pay status for strangers");
{ const victim = "nobody1@usc.edu", k = MAILS.length;
  for (let i = 0; i < 4; i++) { const d = await device("mac-flood-" + i); await call("/verify", { op: "send", email: victim }, { dev: d, ip: "10.77.0." + i }); }
  check("4 computers asking codes for ONE address within an hour -> only 3 emails", MAILS.slice(k).filter(m => m.to === victim).length === 3, String(MAILS.slice(k).filter(m => m.to === victim).length));
  const d = await device("mac-check-1");
  r = await call("/verify", { op: "check", email: "s2@usc.edu" }, { dev: d });
  check("/verify check shows only a masked name", r.data?.found === true && r.data?.name === "S*** D***", JSON.stringify(r.data));
  r = await call("/pay/status?email=s2%40usc.edu", null, { get: true });
  check("/pay/status without the code/token from /pay/start -> 403", r.status === 403, `got ${r.status}`);
}

console.log("R15 (H1-H3, H9) /pay/notify: batched, de-duplicated, review rows, typed codes");
{ const codes = [];
  for (let i = 0; i < 60; i++) codes.push((await call("/pay/start", { email: `payer${i}@usc.edu` }, { ip: "10.60." + (i >> 4) + "." + i })).data?.code);
  check("precondition: 60 student codes", codes.filter(Boolean).length === 60, codes.slice(0, 3).join(","));
  const list = codes.map((c, i) => ({ txn: "venmo:T" + i, msg: "m" + i, amount: 5, note: i % 2 ? c.toLowerCase().replace("lqs", "lqs-") : c, via: "venmo", payer: "P" + i }));
  r = await call("/pay/notify", { payments: list }, { hdr: { "X-LOCKqz-Pay": env.PAY_SECRET } });
  check(`60 alerts in one call <= 45 queries`, r.status === 200 && r.q <= 45, `q=${r.q}`);
  check("every alert matched (codes typed 'lqs-xxxxx' too)", (r.data?.results || []).filter(x => x.matched === "student" && x.paid).length === 60, JSON.stringify((r.data?.results || []).slice(0, 2)));
  r = await call("/pay/notify", { payments: [{ txn: "venmo:T1", msg: "other-copy", amount: 5, note: codes[1] }] }, { hdr: { "X-LOCKqz-Pay": env.PAY_SECRET } });
  check("the same payment again (same provider transaction id, another Gmail copy) is a duplicate", (r.data?.results || []).every(x => x.duplicate), JSON.stringify(r.data));
  await call("/pay/notify", { payments: [{ txn: "gmail:old-1", amount: 5, note: codes[2] }] }, { hdr: { "X-LOCKqz-Pay": env.PAY_SECRET } });   // the old script's id
  r = await call("/pay/notify", { payments: [{ txn: "venmo:NEW1", msg: "old-1", amount: 5, note: codes[2] }] }, { hdr: { "X-LOCKqz-Pay": env.PAY_SECRET } });
  check("an alert the old script already sent (by Gmail id) is a duplicate for the new script", (r.data?.results || []).every(x => x.duplicate), JSON.stringify(r.data));
  r = await call("/pay/notify", { payments: [{ txn: "gmail:rv1", amount: 0, note: "LQSZZZZZ", needs_review: true, review_reason: "To: is not this mailbox" }] }, { hdr: { "X-LOCKqz-Pay": env.PAY_SECRET } });
  const pays = (await call("/payments", null, { teacher: ADMIN, get: true })).data?.payments || [];
  check("an unparsed/unsure alert is stored for review (visible to admin), counts for nobody", r.data?.results?.[0]?.review === true && pays.some(p => p.txn === "gmail:rv1" && p.review === true), JSON.stringify(r.data));
}

console.log("R16 (H7, H14, H12, H13) terms, partial payments, void/reassign, reset requests");
{ const before = CLOCK.off;
  const tok = async email => (await call("/pay/start", { email }, { ip: "10.61.0.1" })).data;
  setToday("2026-12-22");                               // fall classes are over
  let s = await tok("gap@usc.edu");
  await call("/pay/notify", { payments: [{ txn: "venmo:G1", amount: 5, note: s.code }] }, { hdr: { "X-LOCKqz-Pay": env.PAY_SECRET } });
  check("paid in the December gap -> credited to spring", one("SELECT term FROM payments WHERE txn='venmo:G1'")?.term === "20271", one("SELECT term FROM payments WHERE txn='venmo:G1'")?.term);
  setToday("2027-01-12");
  r = await call(`/pay/status?email=gap%40usc.edu&token=${s.token}`, null, { get: true, envx: { STUDENT_FEE_FROM: "2026-01-01" } });
  check("... and counts in January", r.data?.paid === true, JSON.stringify(r.data));
  setToday("2026-11-25");
  s = await tok("early@usc.edu");
  await call("/pay/notify", { payments: [{ txn: "venmo:E1", amount: 5, note: s.code }] }, { hdr: { "X-LOCKqz-Pay": env.PAY_SECRET } });
  check("late Nov, fall not yet paid -> credited to fall (finals still ahead)", one("SELECT term FROM payments WHERE txn='venmo:E1'")?.term === "20263");
  setToday("2027-07-30");                               // 11 days of summer classes left (ends Aug 10), fall starts soon
  const sj = await tok("jul@usc.edu");
  await call("/pay/notify", { payments: [{ txn: "venmo:J1", amount: 5, note: sj.code }] }, { hdr: { "X-LOCKqz-Pay": env.PAY_SECRET } });
  check("late July, summer not paid -> credited to fall (summer nearly over)", one("SELECT term FROM payments WHERE txn='venmo:J1'")?.term === "20273", one("SELECT term FROM payments WHERE txn='venmo:J1'")?.term);
  r = await call(`/pay/status?email=jul%40usc.edu&token=${sj.token}`, null, { get: true, envx: { STUDENT_FEE_FROM: "2026-01-01" } });
  check("... and still counts for the rest of summer", r.data?.paid === true, JSON.stringify(r.data));
  setToday("2027-08-25");
  r = await call(`/pay/status?email=jul%40usc.edu&token=${sj.token}`, null, { get: true, envx: { STUDENT_FEE_FROM: "2026-01-01" } });
  check("... and in fall", r.data?.paid === true, JSON.stringify(r.data));
  setToday("2026-12-01");                               // 41 days before spring (Jan 11) for the next checks
  await call("/pay/notify", { payments: [{ txn: "venmo:E2", amount: 5, note: s.code }] }, { hdr: { "X-LOCKqz-Pay": env.PAY_SECRET } });
  check("late Nov, fall already paid -> the next payment is for spring", one("SELECT term FROM payments WHERE txn='venmo:E2'")?.term === "20271");
  s = await tok("part@usc.edu");
  await call("/pay/notify", { payments: [{ txn: "venmo:H1", amount: 2, note: s.code }] }, { hdr: { "X-LOCKqz-Pay": env.PAY_SECRET } });
  r = await call("/pay/start", { email: "part@usc.edu" }, { ip: "10.61.0.2" });
  check("H14: /pay/start shows the $2 received of $5", r.data?.received === 2 && r.data?.amount === 5, JSON.stringify(r.data));
  check("H14: /my-sections shows a professor's received total", "received" in ((await call("/my-sections", null, { teacher: PT, get: true })).data || {}));
  r = await call("/pay-void", { txn: "venmo:H1" }, { teacher: ADMIN });
  check("H12: /pay-void stops the payment counting", r.status === 200 && (await call("/pay/start", { email: "part@usc.edu" }, { ip: "10.61.0.3" })).data?.received === 0, JSON.stringify(r.data));
  r = await call("/pay-assign", { txn: "gmail:rv1", code: s.code, amount: 5 }, { teacher: ADMIN });
  check("H12: /pay-assign works on a review row (with the amount) and settles it", r.status === 200 && r.data?.paid === true, JSON.stringify(r.data));
  CLOCK.off = before;
  await call("/forgot", { email: "p@usc.edu" }, { ip: "10.62.0.1" });
  r = await call("/reset-requests", null, { teacher: ADMIN, get: true });
  check("H13: /reset-requests lists the request", (r.data?.requests || []).some(x => x.email === "p@usc.edu"), JSON.stringify(r.data));
}

console.log("R17 (H15) /forget deletes a student and the next Sync does not bring them back");
{ r = await call("/forget", { email: "s4@usc.edu" }, { teacher: ADMIN });
  check("/forget removes devices, events, roster rows", r.status === 200 && !one("SELECT 1 FROM devices WHERE student='s4@usc.edu'") && !one("SELECT 1 FROM roster WHERE email='s4@usc.edu'") && !one("SELECT 1 FROM events WHERE student='s4@usc.edu'"), JSON.stringify(r.data));
  await call("/sync", { whoami: { id: "8001" }, courses: [{ ou: "500", name: "ECON 203", classlist: roster500, quizzes: quizzes500 }] }, { teacher: PT });
  check("the next Sync does not re-import them", !one("SELECT 1 FROM roster WHERE email='s4@usc.edu'"));
}

console.log("R18 retention: old events and expired codes are cleaned up by a Sync");
{ sqlite.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES ('old','o@usc.edu','1-1','lock',NULL,?)").run(iso(-200 * 86400e3));
  sqlite.prepare("UPDATE events SET id=-5 WHERE device_id='old'").run();
  sqlite.prepare("INSERT OR REPLACE INTO email_codes (device_id,email,code_hash,expires,tries,created_at) VALUES ('oldc','x@usc.edu','h',?,0,?)").run(Date.now() - 3 * 86400e3, iso(-3 * 86400e3));
  await call("/sync", { whoami: { id: "8001" }, courses: [] }, { teacher: PT });
  check("events older than the retention period are deleted", !one("SELECT 1 FROM events WHERE device_id='old'"));
  check("expired email codes are deleted", !one("SELECT 1 FROM email_codes WHERE device_id='oldc'"));
}

console.log("R19 Workers Free CPU: cheaper password hashing, old hashes still log in (and are upgraded)");
{ r = await call("/signup", { email: "cpu@usc.edu", password: "cpupass123" });
  check("new hashes use 20k rounds (p2$20000$...)", /^p2\$20000\$[01]\$[0-9a-f]{64}$/.test(one("SELECT pw_hash FROM teachers WHERE email='cpu@usc.edu'").pw_hash));
  const salt = "SALTSALTSALTSALT", old = pbkdf2Sync("legacypass1", salt, 100000, 32, "sha256").toString("hex");
  sqlite.prepare("UPDATE teachers SET pw_hash=?, salt=? WHERE email='cpu@usc.edu'").run(old, salt);
  r = await call("/login", { email: "cpu@usc.edu", password: "legacypass1" }, { ip: "10.63.0.1" });
  check("an old 100k-round hash still logs in", r.status === 200 && !!r.data?.token, JSON.stringify(r.data));
  check("... and is re-hashed to the new setting", /^p2\$20000\$/.test(one("SELECT pw_hash FROM teachers WHERE email='cpu@usc.edu'").pw_hash));
  r = await call("/login", { email: "cpu@usc.edu", password: "legacypass1" }, { ip: "10.63.0.1" });
  check("... and logs in again with the new hash", r.status === 200);
  let t0 = performance.now(); for (let i = 0; i < 5; i++) await call("/login", { email: "cpu@usc.edu", password: "legacypass1" }, { ip: "10.63.0.2" });
  const ms = (performance.now() - t0) / 5;
  t0 = performance.now(); for (let i = 0; i < 5; i++) pbkdf2Sync("legacypass1", salt, 100000, 32, "sha256"); const ref = (performance.now() - t0) / 5;
  check(`/login costs well under the old 100k-round hash (login ${ms.toFixed(1)} ms vs 100k rounds ${ref.toFixed(1)} ms; Workers Free CPU = 10 ms)`, ms < ref * 0.5);
}

console.log("R20 (C6, I-B3) repeat install reports write nothing; /live is shared between pollers");
{ await call("/install", { device_id: D[0].id, platform: "mac", version: "0.4.1" }, { dev: D[0] });
  r = await call("/install", { device_id: D[0].id, platform: "mac", version: "0.4.1" }, { dev: D[0] });
  check("/install with the same version again writes 0 rows", r.w === 0, `w=${r.w}`);
  await call("/report", { event: "install", platform: "mac-15", version: "0.4.1" }, { dev: D[0] });
  r = await call("/report", { event: "install", platform: "mac-15", version: "0.4.1" }, { dev: D[0] });
  check("a repeat 'install' report logs no event", r.w <= 1, `w=${r.w}`);
  r = await call("/report", { event: "install", platform: "mac-15", version: "0.4.2" }, { dev: D[0] });
  check("a new version is logged and stored", one("SELECT version FROM devices WHERE device_id=?", D[0].id)?.version === "0.4.2");
  const envc = { LIVE_CACHE_MS: "8000" };
  await call("/live?quiz=500-1", null, { teacher: PT, get: true, envx: envc });
  r = await call("/live?quiz=500-1", null, { teacher: PT, get: true, envx: envc });
  check("a second /live within 8 s is served from the shared answer (<= 2 queries: who is asking, is it their course)", r.status === 200 && r.q <= 2, `q=${r.q}`);
  const nd = await device("mac-r2-new", "s5@usc.edu");
  await lock(nd, "500-1");
  r = await call("/live?quiz=500-1", null, { teacher: PT, get: true, envx: envc });
  check("a student's lock does not recompute it (still shared)", r.q <= 2, `q=${r.q}`);
  const before = CLOCK.off; CLOCK.off += 9000;
  r = await call("/live?quiz=500-1", null, { teacher: PT, get: true, envx: envc });
  check("... and shows within 8 s (next computation)", (r.data?.rows || []).some(x => x.device_id === nd.id), `q=${r.q}`);
  await call("/gate", { ou: "500", qi: "1", on: true, keep: [] }, { teacher: PT });
  r = await call("/live?quiz=500-1", null, { teacher: PT, get: true, envx: envc });
  check("starting a gate clears the shared answer at once", r.q > 2, `q=${r.q}`);
  await call("/gate", { ou: "500", qi: "1", on: false }, { teacher: PT });
  CLOCK.off = before;
}

console.log("R-fix3 a quiz copied from a LOCKqz term (old LQ- password) is ours: auto-protected, not 'own password'");
{ const qs = [...quizzes500, { qi: "61", name: "Copied quiz", active: true, has_password: true, lq_password: true }, { qi: "62", name: "Prof pw", active: true, has_password: true, lq_password: false }];
  r = await call("/sync", { whoami: { id: "8001" }, courses: [{ ou: "500", name: "ECON 203", classlist: roster500, quizzes: qs }] }, { teacher: PT });
  check("#3 LQ-format password -> auto-protected (a new LOCKqz password replaces the stale one)", (r.data?.protect || []).some(x => String(x.qi) === "61"), JSON.stringify(r.data?.protect?.map(x => x.qi)));
  check("#3 professor's own password -> still left alone", !(r.data?.protect || []).some(x => String(x.qi) === "62"));
  r = await call("/bs", null, { teacher: PT, get: true });
  const qz = ((r.data?.courses || []).find(c => String(c.ou) === "500")?.quizzes || []);
  check("#3 /bs: copied quiz is not 'has its own password'; the professor's is", qz.find(q => String(q.qi) === "61")?.has_own_password === false && qz.find(q => String(q.qi) === "62")?.has_own_password === true, JSON.stringify(qz.map(q => [q.qi, q.has_own_password])));
}

console.log("R-fix8 retention runs without any Sync: 1 in PURGE_EVERY device reports carries the bounded purge");
{ const lowId = n("SELECT MIN(id) FROM events") - 1;
  sqlite.prepare("INSERT INTO events (id,device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?,?)").run(lowId, "old-dev", "old@usc.edu", "500-1", "lock", null, iso(-200 * 86400e3));
  sqlite.prepare("INSERT INTO events (id,device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?,?)").run(lowId - 1, "ip:1.2.3.4", null, null, "login_fail", "x", iso(-3 * 86400e3));
  r = await call("/report", { event: "heartbeat", quiz_id: "500-1", source: "helper" }, { dev: D[0], envx: { PURGE_EVERY: "1000000000" } });
  check("#8 a normal report does not purge (no extra work)", n("SELECT COUNT(*) FROM events WHERE id=?", lowId) === 1);
  const q0 = r.q;
  r = await call("/report", { event: "heartbeat", quiz_id: "500-1", source: "helper" }, { dev: D[0], envx: { PURGE_EVERY: "1" } });
  check("#8 the purge report deletes events older than 120 days and 2-day-old rate-limit rows", n("SELECT COUNT(*) FROM events WHERE id IN (?,?)", lowId, lowId - 1) === 0);
  check("#8 ... in the same batch (no extra D1 query)", r.q === q0, `q=${r.q} vs ${q0}`);
  const priv = readFileSync(join(CF, "public", "privacy.html"), "utf8");
  check("#8 privacy.html states the 120-day retention the API applies", /120 days/.test(priv) && /EVENT_DAYS = 120/.test(readFileSync(ROUTE, "utf8")));
}

console.log("PROXY other *.pages.dev addresses forward the API to the main site (one set of secrets)");
{ const realFetch = globalThis.fetch, seen = [];
  globalThis.fetch = async (u, init) => { seen.push({ u: String(u), m: init?.method, b: init?.body ? new TextDecoder().decode(init.body) : null, h: init?.headers }); return new Response(JSON.stringify({ ok: true, via: "main" }), { headers: { "Content-Type": "application/json" } }); };
  try {
    const e2 = { ...env };
    let r = await onRequest({ request: new Request("https://prof.lockqz.pages.dev/api/password?x=1", { method: "POST", headers: { "Content-Type": "application/json", "X-LOCKqz-Device": "d1" }, body: JSON.stringify({ url: "u" }) }), env: e2 });
    let d = await r.json();
    check("prof.lockqz.pages.dev POST is forwarded to lockqz.pages.dev with path, query, body and headers", d.via === "main" && seen[0]?.u === "https://lockqz.pages.dev/api/password?x=1" && seen[0].m === "POST" && seen[0].b === JSON.stringify({ url: "u" }) && seen[0].h.get("X-LOCKqz-Device") === "d1", JSON.stringify(seen[0] || null));
    r = await onRequest({ request: new Request("https://lockdownqz.pages.dev/api/version"), env: e2 });
    check("old address lockdownqz.pages.dev GET is forwarded too", seen[1]?.u === "https://lockqz.pages.dev/api/version" && seen[1].m === "GET", JSON.stringify(seen[1] || null));
    const n = seen.length;
    r = await onRequest({ request: new Request("https://lockqz.pages.dev/api/version"), env: e2 });
    check("the main site answers itself (no loop)", seen.length === n && r.status === 200, String(r.status));
    globalThis.fetch = async () => { throw new TypeError("network"); };
    r = await onRequest({ request: new Request("https://prof.lockqz.pages.dev/api/version"), env: e2 });
    check("main site unreachable -> clear 502, not a crash", r.status === 502, String(r.status));
  } finally { globalThis.fetch = realFetch; } }

console.log("");
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
