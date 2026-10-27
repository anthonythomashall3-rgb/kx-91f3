import { withPayT } from "./pay_t.mjs";
// API audit regressions (24 Oct 2026) + D1 Free-plan budgets. Runs the REAL API against in-memory
// SQLite with a D1 shim that (a) enforces the 100-bound-parameter cap, (b) counts D1 queries per request
// (first/all/run = 1, db.batch = 1; Free plan limit is 50) and (c) counts rows written.
// Run against another API file with LQZ_ROUTE=<path> (used to prove each check fails on the old code).
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const ROUTE = process.env.LQZ_ROUTE || join(CF, "functions", "api", "[[route]].js");
const tmp = mkdtempSync(join(tmpdir(), "lqz-audit-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(ROUTE));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
const SRC = readFileSync(ROUTE, "utf8");

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (/queries|rows/.test(m)) i = i || `q=${last.q} w=${last.w}`; if (process.env.LQZ_VERBOSE && /queries|rows/.test(m)) console.log(`    [${m.slice(0, 40)}] q=${last.q} w=${last.w}`); if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

const MAXQ = 45;
let Q = 0, W = 0;
function d1(sqlite) {
  const mk = sql => { const st = sqlite.prepare(sql); let args = [];
    const s = {
      bind(...a) { if (a.length > 100) throw new Error("too many SQL variables (" + a.length + ")");
        args = a.map(x => { if (x === undefined) throw new Error("D1_TYPE_ERROR: undefined"); if (x !== null && typeof x === "object") throw new Error("D1_TYPE_ERROR: object"); return typeof x === "boolean" ? Number(x) : x; }); return s; },
      first: async () => { Q++; return st.get(...args) ?? null; },
      all: async () => { Q++; return { results: st.all(...args) }; },
      run: async () => { Q++; const c = Number(st.run(...args).changes); W += c; return { meta: { changes: c } }; },
      _run() { W += Number(st.run(...args).changes); } };
    return s; };
  return { prepare: mk, async batch(sts) { Q++; sqlite.exec("BEGIN"); try { for (const s of sts) s._run(); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; } return []; } };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
const MAILS = [];
const env = { DB: d1(sqlite), TEACHER_KEY: "admin-key-audit", REQUIRE_SIGNED: "1", ADMIN_EMAIL: "admin@usc.edu", ROT_SECRET: "rot-secret-audit", LIVE_CACHE_MS: "0",
              MAIL_SINK: async m => { MAILS.push(m); return true; } };
const BASE = "https://lockqz.test";
const sign = (key, path, ts, raw) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(raw).digest("hex")}`).digest("hex");
let last = { q: 0, w: 0 };
async function call(path, body, { teacher = null, sync = null, key = null, device = null, get = false, ip = null, hdr = {} } = {}) {
  body = withPayT(path, body, env);
  const raw = JSON.stringify(body ?? {});
  const h = { "Content-Type": "application/json", ...hdr };
  if (teacher) h["X-LOCKqz-Teacher"] = teacher;
  if (sync) h["X-LOCKqz-Sync"] = sync;
  if (ip) h["CF-Connecting-IP"] = ip;
  if (key) { const ts = String(Math.floor(Date.now() / 1000)); h["X-LOCKqz-Device"] = device; h["X-LOCKqz-Time"] = ts; h["X-LOCKqz-Sig"] = sign(key, "/api" + path.replace(/\?.*/, ""), ts, raw); }
  Q = 0; W = 0;
  const res = await onRequest({ request: new Request(BASE + "/api" + path, { method: get ? "GET" : "POST", headers: h, body: get ? undefined : raw }), env });
  last = { q: Q, w: W };
  return { status: res.status, data: await res.json().catch(() => null), q: Q, w: W };
}
const one = (sql, ...a) => sqlite.prepare(sql).get(...a);
const n = (sql, ...a) => Number(Object.values(sqlite.prepare(sql).get(...a))[0]);
const tid = email => one("SELECT id FROM teachers WHERE email=?", email)?.id;
async function invitedProf(email, pw = "profpass12") {
  const code = (await call("/invite", { email }, { teacher: ADMIN })).data?.code;
  return (await call("/signup", { email, password: pw, name: "Prof " + email.split("@")[0], invite: code })).data?.token;
}
async function device(id, student) {
  const key = randomBytes(32).toString("hex");
  await call("/register", { device_id: id, key, student, platform: "mac", version: "0.4.0" }, { ip: "10.9." + (id.length % 250) + "." + (id.charCodeAt(id.length - 1) % 250) });
  return { id, key };
}
const quizUrl = (ou, qi) => `https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${qi}&ou=${ou}`;

// ---------- accounts ----------
const ADMIN = (await call("/signup", { email: "admin@usc.edu", password: "adminpass1" })).data.token;   // first account = admin

console.log("Q1 D1 budget: 6 courses x 15 quizzes x 200 students (<= " + MAXQ + " queries per request)");
const NC = 6, NQ = 15, NS = 200, PID = "9001";
const bigCourses = withQuizzes => Array.from({ length: NC }, (_, c) => ({ ou: String(70000 + c), name: "COURSE " + c, code: "C" + c, role: "Instructor",
  classlist: [{ id: PID, name: "Big Prof", email: "big@usc.edu", role: "Instructor" },
    ...Array.from({ length: NS }, (_, i) => ({ id: String(100000 + c * 1000 + i), name: `Stu ${c}-${i}`, email: `s${c}_${i}@usc.edu`, role: "Student" }))],
  quizzes: withQuizzes ? Array.from({ length: NQ }, (_, i) => ({ qi: String(800000 + c * 100 + i), name: "Quiz " + i, active: true })) : [] }));
let r = await call("/sync", { courses: bigCourses(false) }, { teacher: ADMIN });
check(`admin first sync (seeds 6 rosters x 201) <= ${MAXQ} queries`, r.status === 200 && r.q <= MAXQ, `status ${r.status} q=${r.q}`);
const BIG = await invitedProf("big@usc.edu");
await call("/activate", { email: "big@usc.edu", until: "2099-12-31" }, { teacher: ADMIN });
r = await call("/sync", { whoami: { id: PID }, courses: bigCourses(true) }, { teacher: BIG });
check(`professor's first sync (90 quizzes auto-protected) <= ${MAXQ} queries`, r.status === 200 && r.q <= MAXQ, `status ${r.status} q=${r.q} ${JSON.stringify(r.data).slice(0, 120)}`);
check("first sync protected all 90 quizzes", (r.data?.protect || []).length === NC * NQ, `protect=${(r.data?.protect || []).length}`);
r = await call("/sync", { whoami: { id: PID }, courses: bigCourses(true) }, { teacher: BIG });
check(`repeat sync <= ${MAXQ} queries`, r.status === 200 && r.q <= MAXQ, `q=${r.q}`);
check("repeat sync with nothing changed writes ~0 rows", r.w <= 1, `rows written=${r.w}`);
const c2 = bigCourses(true); c2[0].classlist[5].name = "Renamed Student"; c2[1].classlist.pop(); c2[2].quizzes[0].name = "Renamed quiz";
r = await call("/sync", { whoami: { id: PID }, courses: c2 }, { teacher: BIG });
// + one bookkeeping row per changed course: its roster_snap / bsq_hash row (migrate_029: 2 class lists + 1 quiz list).
check("a sync with 3 small changes writes only those rows", r.status === 200 && r.w <= 4 + 3, `rows written=${r.w}`);
check("removed student is gone from the roster", !one("SELECT 1 FROM roster WHERE ou='70001' AND user_id=?", String(100000 + 1000 + NS - 1)));
check("renamed student updated", one("SELECT name FROM roster WHERE ou='70000' AND user_id=?", c2[0].classlist[5].id)?.name === "Renamed Student");
r = await call("/submitted", { ou: "70000", qi: "800000", user_ids: Array.from({ length: 300 }, (_, i) => String(500000 + i)) }, { teacher: BIG });
check(`/submitted with 300 ids <= ${MAXQ} queries`, r.status === 200 && r.q <= MAXQ, `status ${r.status} q=${r.q}`);
check("all 300 submissions stored", n("SELECT COUNT(*) FROM submissions WHERE ou='70000' AND qi='800000'") === 300);
const results = []; for (let c = 0; c < NC; c++) for (let i = 0; i < NQ; i++) results.push({ ou: String(70000 + c), qi: String(800000 + c * 100 + i), status: "set" });
r = await call("/sync-result", { results }, { teacher: BIG });
check(`/sync-result with 90 results <= ${MAXQ} queries`, r.status === 200 && r.q <= MAXQ, `status ${r.status} q=${r.q}`);
check("results applied", n("SELECT COUNT(*) FROM bs_quizzes WHERE bs_password_is_ours=1") === NC * NQ);
r = await call("/sync-result", { results }, { teacher: BIG });
check("repeating the same results writes nothing", r.w === 0, `rows written=${r.w}`);
// 200 locked students on one quiz (rows inserted directly; /register is rate-limited per IP)
{ const t = new Date().toISOString();
  for (let i = 0; i < NS; i++) {
    sqlite.prepare("INSERT INTO devices (device_id,student,platform,device_key,student_verified) VALUES (?,?,?,?,1)").run("bigdev" + i, `s0_${i}@usc.edu`, "mac", "00".repeat(32));
    sqlite.prepare("INSERT INTO locks (device_id,quiz_id,last_lock,helper_seen,signed) VALUES (?,?,?,?,1)").run("bigdev" + i, "70000-800001", t, t);
    if (i % 4 === 0) sqlite.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)").run("bigdev" + i, `s0_${i}@usc.edu`, "70000-800001", "lock", null, t);
  } }
r = await call("/live?quiz=70000-800001", null, { teacher: BIG, get: true });
check(`/live with 200 locked students <= ${MAXQ} queries`, r.status === 200 && r.q <= MAXQ && (r.data?.rows || []).length === NS, `status ${r.status} q=${r.q} rows=${(r.data?.rows || []).length}`);
r = await call("/bs", null, { teacher: BIG, get: true });
check(`/bs <= ${MAXQ} queries`, r.status === 200 && r.q <= MAXQ, `q=${r.q}`);

// ---------- the course world for the logic checks ----------
// Course A (ou 100) and B (ou 200): admin-seeded rosters, professor P instructs both (Brightspace id 501).
const rosterA = [{ id: "501", name: "Prof P", email: "p@usc.edu", role: "Instructor" }, { id: "900", name: "Stu S", email: "s@usc.edu", role: "Student" }, { id: "901", name: "Al", email: "al@usc.edu", role: "Student" }];
await call("/sync", { courses: [{ ou: "100", name: "A", classlist: rosterA, quizzes: [] }] }, { teacher: ADMIN });
const P = await invitedProf("p@usc.edu");
await call("/activate", { email: "p@usc.edu", until: "2099-12-31" }, { teacher: ADMIN });
r = await call("/sync", { whoami: { id: "501" }, courses: [{ ou: "100", name: "A", classlist: rosterA, quizzes: [{ qi: "11", name: "A quiz", active: true }] }] }, { teacher: P });
check("setup: P verified via course A", (await call("/me", null, { teacher: P, get: true })).data?.verified === true);

console.log("A1 a seed account loses a course the moment its trusted instructor syncs it (#1)");
const S = (await call("/signup", { email: "s@usc.edu", password: "studentpw1" })).data.token;
const rosterB = [{ id: "501", name: "Prof P", email: "p@usc.edu", role: "Instructor" }, { id: "900", name: "Stu S", email: "s@usc.edu", role: "Student" }];
await call("/sync", { whoami: { id: "900" }, courses: [{ ou: "200", name: "B", classlist: rosterB, quizzes: [] }] }, { teacher: S });
check("precondition: student S seeded course B", !!one("SELECT 1 FROM teacher_courses WHERE ou='200' AND teacher_id=?", tid("s@usc.edu")));
r = await call("/sync", { whoami: { id: "501" }, courses: [{ ou: "100", name: "A", classlist: rosterA, quizzes: [{ qi: "11", name: "A quiz", active: true }] }, { ou: "200", name: "B", classlist: rosterB, quizzes: [{ qi: "77", name: "Midterm", active: true }] }] }, { teacher: P });
check("P's sync of B protects its quiz", (r.data?.protect || []).some(x => String(x.qi) === "77"), JSON.stringify(r.data?.protect));
check("S's seed row on B is evicted by P's FIRST sync of B", !one("SELECT 1 FROM teacher_courses WHERE ou='200' AND teacher_id=?", tid("s@usc.edu")));
// Even with a seed row put back (any path), a non-instructor gets no passwords, monitor or results.
sqlite.prepare("INSERT OR REPLACE INTO teacher_courses (teacher_id,ou,name,role,synced_at) VALUES (?,?,?,?,?)").run(tid("s@usc.edu"), "200", "B", "Student", new Date().toISOString());
r = await call("/bs", null, { teacher: S, get: true });
const leak = (r.data?.courses || []).flatMap(c => c.quizzes || []).filter(q => q.password);
check("/bs never shows a seed account the quiz passwords", r.status === 200 && leak.length === 0, JSON.stringify(leak));
r = await call("/live?quiz=200-77", null, { teacher: S, get: true });
check("/live refused for a seed account (403)", r.status === 403, `got ${r.status}`);
sqlite.prepare("UPDATE bs_quizzes SET bs_password_is_ours=0 WHERE ou='200' AND qi='77'").run();
await call("/sync-result", { results: [{ ou: "200", qi: "77", status: "set" }] }, { teacher: S });
check("/sync-result ignored for a seed account", Number(one("SELECT bs_password_is_ours AS v FROM bs_quizzes WHERE ou='200' AND qi='77'")?.v) === 0);
sqlite.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES ('x','x','200-77','lock',NULL,?)").run(new Date().toISOString());
r = await call("/sessions", null, { teacher: S, get: true });
check("/sessions shows a seed account nothing from B", !(r.data?.events || []).some(e => String(e.quiz_id).startsWith("200-")), JSON.stringify((r.data?.events || []).slice(0, 2)));
sqlite.prepare("DELETE FROM teacher_courses WHERE ou='200' AND teacher_id=?").run(tid("s@usc.edu"));
// An unverified account cannot overwrite a course a verified (non-instructor) professor synced.
const rosterX = [{ id: "777", name: "Real X", email: "x@usc.edu", role: "Instructor" }, { id: "501", name: "Prof P", email: "p@usc.edu", role: "Student" }];
await call("/sync", { whoami: { id: "501" }, courses: [{ ou: "300", name: "X", classlist: rosterX, quizzes: [] }] }, { teacher: P });
await call("/sync", { whoami: { id: "900" }, courses: [{ ou: "300", name: "X", classlist: [{ id: "900", name: "S", email: "s@usc.edu", role: "Instructor" }], quizzes: [] }] }, { teacher: S });
check("seed cannot rewrite the roster of a course a verified account synced", one("SELECT role FROM roster WHERE ou='300' AND user_id='900'") == null && !!one("SELECT 1 FROM roster WHERE ou='300' AND user_id='777'"));

console.log("A2 an uninvited account holding a professor's email can never verify as them (#2)");
const IMP = (await call("/signup", { email: "bristow@usc.edu", password: "imposter9" })).data.token;
check("precondition: uninvited sign-up still works (the site only offers it by invite)", !!IMP);
await call("/sync", { whoami: { id: "4242" }, courses: [{ ou: "600", name: "seed", classlist: [{ id: "4242", name: "Me", email: "bristow@usc.edu", role: "Instructor" }], quizzes: [] }] }, { teacher: IMP });
await call("/sync", { courses: [{ ou: "601", name: "FBE 437", classlist: [{ id: "4242", name: "Duke Bristow", email: "bristow@usc.edu", role: "Instructor" }], quizzes: [{ qi: "5", name: "Final", active: true }] }] }, { teacher: ADMIN });
await call("/sync", { whoami: { id: "4242" }, courses: [{ ou: "601" }] }, { teacher: IMP });
r = await call("/me", null, { teacher: IMP, get: true });
check("impostor who sent the professor's real Brightspace id is NOT verified", r.data?.verified === false, JSON.stringify(r.data));
r = await call("/protect", { ou: "601", qi: "5", on: true }, { teacher: IMP });
check("impostor cannot protect the professor's quiz", r.status === 403 || r.status === 402, `got ${r.status}`);
r = await call("/invite", { email: "bristow@usc.edu" }, { teacher: ADMIN });
check("admin can still invite the real professor (squatted, never-vouched email)", r.status === 200 && !!r.data?.code, JSON.stringify(r.data));
const REAL = (await call("/signup", { email: "bristow@usc.edu", password: "realprof12", name: "Duke Bristow", invite: r.data?.code })).data?.token;
check("the invite reclaims the account for the real professor", !!REAL);
check("the impostor's session is dead", (await call("/me", null, { teacher: IMP, get: true })).status === 401);
await call("/sync", { whoami: { id: "4242" }, courses: [{ ou: "601", name: "FBE 437", classlist: [{ id: "4242", name: "Duke Bristow", email: "bristow@usc.edu", role: "Instructor" }], quizzes: [] }] }, { teacher: REAL });
check("the real (invited) professor verifies", (await call("/me", null, { teacher: REAL, get: true })).data?.verified === true);
r = await call("/invite", { email: "p@usc.edu" }, { teacher: ADMIN });
check("an invited/verified account's email cannot be re-invited (409)", r.status === 409, `got ${r.status}`);

console.log("A3 /quiz never makes a second row or password for the same quiz (#5)");
const qa = await call("/quiz", { url: quizUrl(100, 12), title: "Q12" }, { teacher: P });
const qb = await call("/quiz", { url: quizUrl(100, 12), title: "Q12", quiz_id: qa.data?.quiz_id }, { teacher: P });
check("adding the same quiz twice returns the same quiz and password", qa.status === 200 && qb.status === 200 && qb.data?.quiz_id === qa.data?.quiz_id && qb.data?.password === qa.data?.password, `${qa.status}/${qb.status} ${JSON.stringify(qb.data)}`);
check("one row for (ou,qi)", n("SELECT COUNT(*) FROM quizzes WHERE ou='100' AND qi='12'") === 1);
const victim = one("SELECT quiz_id FROM quizzes WHERE ou='100' AND qi='11'")?.quiz_id;
r = await call("/quiz", { url: quizUrl(100, 13), quiz_id: victim }, { teacher: P });
check("a caller-chosen quiz_id is ignored (no collision, no 500)", r.status === 200 && r.data?.quiz_id !== victim, `${r.status} ${JSON.stringify(r.data)}`);
check("schema: UNIQUE index on quizzes(ou,qi)", !!one("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_quizzes_ou_qi'"));

console.log("A4 a professor pay code that starts with LQS is still a professor payment (#6)");
sqlite.prepare("INSERT OR REPLACE INTO pay_codes (teacher_id, code) VALUES (?, 'LQSABCD')").run(tid("bristow@usc.edu"));
const payKey = (await call("/payments", null, { teacher: ADMIN, get: true })).data?.script_key;
r = await call("/pay/notify", { payments: [{ txn: "t-prof-1", amount: 5000, note: "LQSABCD" }] }, { hdr: { "X-LOCKqz-Pay": payKey } });
check("LQSABCD settles as the professor's payment", r.data?.results?.[0]?.matched === "professor", JSON.stringify(r.data));
check("...and turns the professor on", !!one("SELECT active_until FROM teachers WHERE email='bristow@usc.edu'")?.active_until);
r = await call("/pay/notify", { payments: [{ txn: "t-x", amount: 5, note: "x" }] }, { hdr: { "X-LOCKqz-Pay": payKey + "0" } });
check("wrong payment-script key refused", r.status === 401);
check("payment-script key compared in constant time (sameHex)", !/got !== secret/.test(SRC) && /sameHex\(got, secret\)/.test(SRC));
let codes = new Set(); for (let i = 0; i < 40; i++) { sqlite.prepare("DELETE FROM pay_codes WHERE teacher_id=?").run(tid("p@usc.edu")); codes.add((await call("/my-sections", null, { teacher: P, get: true })).data?.memo); }
check("new professor codes never start with LQS", [...codes].every(c => /^LQ[A-Z0-9]{5}$/.test(c) && !c.startsWith("LQS")), [...codes].filter(c => c.startsWith("LQS")).join(","));

console.log("A5 dates, deletes, rotated, reset, logout, bad input (#8-#11, #14)");
r = await call("/activate", { email: "p@usc.edu", until: "12/31/2026" }, { teacher: ADMIN });
check("/activate refuses a non-date (400)", r.status === 400, `got ${r.status}`);
r = await call("/activate", { email: "p@usc.edu", until: "2026-02-31" }, { teacher: ADMIN });
check("/activate refuses an impossible date (400)", r.status === 400, `got ${r.status}`);
r = await call("/invite", { email: "zz@usc.edu", until: "soon" }, { teacher: ADMIN });
check("/invite refuses a non-date (400)", r.status === 400, `got ${r.status}`);
check("a good date still works", (await call("/activate", { email: "p@usc.edu", until: "2099-12-31" }, { teacher: ADMIN })).status === 200);
r = await call("/delete", { quiz_id: "NOPE0000" }, { teacher: P });
check("/delete of nothing is not 'ok'", r.status === 404 && !r.data?.ok, `got ${r.status} ${JSON.stringify(r.data)}`);
await call("/protect", { ou: "100", qi: "14", on: true }, { teacher: P });
const del = one("SELECT quiz_id FROM quizzes WHERE ou='100' AND qi='14'")?.quiz_id;
r = await call("/delete", { quiz_id: del }, { teacher: P });
check("/delete of a real quiz works", !!del && r.status === 200 && r.data?.ok === true, `${del} ${r.status}`);
const syncA = () => call("/sync", { whoami: { id: "501" }, courses: [{ ou: "100", name: "A", classlist: rosterA, quizzes: [{ qi: "14", name: "Q14", active: true }] }] }, { teacher: P });
r = await syncA();
await call("/sync-result", { results: (r.data?.clear || []).map(x => ({ ou: x.ou, qi: x.qi, status: "cleared" })) }, { teacher: P });
await syncA();
check("a deleted quiz is not re-protected by later Syncs", !one("SELECT 1 FROM quizzes WHERE ou='100' AND qi='14'"));
r = await call("/rotated", { ou: "100", qi: "12", code: "LQ-ABCDEF" }, { teacher: P });
check("/rotated on an ungated quiz is refused (409)", r.status === 409, `got ${r.status} ${JSON.stringify(r.data)}`);
const SK = (await call("/synckey", null, { teacher: P, get: true })).data?.key;
check("precondition: sync key works", (await call("/me", null, { sync: SK, get: true })).status === 200);
r = await call("/reset", { email: "p@usc.edu", password: "newpassword9" }, { teacher: ADMIN });
check("/reset kills the old Sync bookmark key", (await call("/me", null, { sync: SK, get: true })).status === 401);
const P2 = (await call("/login", { email: "p@usc.edu", password: "newpassword9" })).data?.token;
await call("/logout", {}, { teacher: ADMIN });
check("logout ends an admin account's session too", (await call("/me", null, { teacher: ADMIN, get: true })).status === 401);
const ADM = (await call("/login", { email: "admin@usc.edu", password: "adminpass1" })).data?.token;
{ const res = await onRequest({ request: new Request(BASE + "/api/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platform: "mac" }) }), env: { ...env, REQUIRE_SIGNED: "" } });
  check("/install (legacy, unsigned) without a device id -> 400 (not 500)", res.status === 400, `got ${res.status}`); }
const dj = await device("dev-junk-1", "al@usc.edu");
r = await call("/report", { event: "lock", quiz_id: "100-12", student: { evil: 1 } }, { key: dj.key, device: dj.id });
check("/report with a non-string student -> 200 (not 500)", r.status === 200, `got ${r.status} ${JSON.stringify(r.data)}`);

console.log("A6 write volume (#4)");
// (independent of earlier steps, so this also runs meaningfully against the old API)
sqlite.prepare("UPDATE teachers SET active_until='2099-12-31' WHERE email='p@usc.edu'").run();
if (!one("SELECT 1 FROM quizzes WHERE ou='100' AND qi='12'")) sqlite.prepare("INSERT INTO quizzes (quiz_id,title,password,created_at,qi,teacher_id,lock_id,ou) VALUES ('Q12FIXED','Q12','LQ-FIXED12',?,'12',?,'100-12','100')").run(new Date().toISOString(), tid("p@usc.edu"));
const dA = await device("dev-al-1", "al@usc.edu");
sqlite.prepare("UPDATE devices SET student='al@usc.edu', student_verified=1 WHERE device_id=?").run(dA.id);
await call("/report", { event: "lock", quiz_id: "100-12", student: "al@usc.edu" }, { key: dA.key, device: dA.id });
for (let i = 0; i < 5; i++) r = await call("/password", { url: quizUrl(100, 12) }, { key: dA.key, device: dA.id });
check("precondition: password released", !!r.data?.password, JSON.stringify(r.data));
check("5 password requests log ONE password_released", n("SELECT COUNT(*) FROM events WHERE device_id=? AND event='password_released'", dA.id) === 1);
let st = []; for (let i = 0; i < 40; i++) st.push((await call("/login", { email: `rand${i}@x.edu`, password: "nope" }, { ip: "6.6.6.6" })).status);
check("one IP spraying random emails is cut off (429)", st.slice(-5).every(s => s === 429), st.join(","));
check("...and stops writing rows", n("SELECT COUNT(*) FROM events WHERE event='login_fail' AND detail LIKE '%6.6.6.6'") <= 30);
for (let i = 0; i < 5; i++) await call("/forgot", { email: "p@usc.edu" }, { ip: "7.7.7.7" });
check("5 /forgot for one email write one row", n("SELECT COUNT(*) FROM events WHERE event='reset_request' AND detail='p@usc.edu'") === 1);
st = []; for (let i = 0; i < 25; i++) st.push((await call("/pay/start", { email: `new${i}@usc.edu` }, { ip: "8.8.4.4" })).status);
check("/pay/start: one IP cannot mint unlimited new pay codes", st.slice(-3).every(s => s === 429) && n("SELECT COUNT(*) FROM pay_codes_students WHERE email LIKE 'new%'") <= 20, st.join(","));
check("/pay/start for an email that already has a code still works", (await call("/pay/start", { email: "new0@usc.edu" }, { ip: "8.8.4.4" })).status === 200);
check("schema: events(event,ts) index", !!one("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_events_event_ts'"));
check("/live reads events by exact quiz id (no LIKE scan)", !/quiz_id LIKE \?\)\s*AND event='tamper'/.test(SRC) && !/\(e\.quiz_id=\? OR e\.quiz_id LIKE \?\)/.test(SRC));

console.log("A7 student fee cannot be skipped with an unconfirmed email (#7)");
{ const env2 = { ...env, STUDENT_FEE_FROM: "2020-01-01" };
  const dF = await device("dev-fee-1", "x@usc.edu");
  await call("/report", { event: "lock", quiz_id: "100-12", student: "p@usc.edu" }, { key: dF.key, device: dF.id });   // claims the professor's (fee-exempt) email
  const raw = JSON.stringify({ url: quizUrl(100, 12) }), ts = String(Math.floor(Date.now() / 1000));
  const res = await onRequest({ request: new Request(BASE + "/api/password", { method: "POST", headers: { "Content-Type": "application/json", "X-LOCKqz-Device": dF.id, "X-LOCKqz-Time": ts, "X-LOCKqz-Sig": sign(dF.key, "/api/password", ts, raw) }, body: raw }), env: env2 });
  const d = await res.json();
  check("unconfirmed device claiming a fee-exempt email gets no password (402)", res.status === 402 && !d.password, `${res.status} ${JSON.stringify(d)}`); }

console.log("A8 laToday is DST-correct (#13)");
{ const RealDate = Date, FIX = RealDate.parse("2026-12-01T07:30:00Z");   // = 23:30 on Nov 30 in Los Angeles (PST, UTC-8)
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [FIX])); } static now() { return FIX; } }
  sqlite.prepare("UPDATE teachers SET active_until='2026-11-30' WHERE email='p@usc.edu'").run();
  globalThis.Date = FakeDate;
  let me2; try { me2 = await call("/me", null, { teacher: P2, get: true }); } finally { globalThis.Date = RealDate; }
  check("paid through Nov 30 is still active at 11:30pm Pacific on Nov 30 (winter)", me2.data?.active === true, JSON.stringify(me2.data));
  sqlite.prepare("UPDATE teachers SET active_until='2099-12-31' WHERE email='p@usc.edu'").run(); }

console.log("L1 an unlock before submitting stays flagged in /live, even after a re-lock");
const live = async (q, who = P2) => (await call(`/live?quiz=${q}`, null, { teacher: who, get: true })).data?.rows || [];
const rowOf = async (q, id) => (await live(q)).find(x => x.device_id === id);
const dL = await device("dev-al-2", "al@usc.edu");
sqlite.prepare("UPDATE devices SET student='al@usc.edu', student_verified=1 WHERE device_id=?").run(dL.id);
const rep = (d, body) => call("/report", { quiz_id: "100-12", student: "al@usc.edu", ...body }, { key: d.key, device: d.id });
await rep(dL, { event: "lock" });
let row = await rowOf("100-12", dL.id);
check("locked student shows 'locked' and is admitted", row?.status === "locked" && row.eligible === true, JSON.stringify(row));
await rep(dL, { event: "unlock", reason: "quiz_tab_closed" });
row = await rowOf("100-12", dL.id);
check("unlock without a submit -> 'left_early' (red)", row?.status === "left_early" && row.reason === "quiz_tab_closed", JSON.stringify(row));
await rep(dL, { event: "lock" });
row = await rowOf("100-12", dL.id);
check("a later re-lock does NOT hide it (still 'left_early')", row?.status === "left_early" && row.reason === "quiz_tab_closed", JSON.stringify(row));
check("...while the re-locked student keeps quiz access (eligible)", row?.eligible === true, JSON.stringify(row));
// helper went dark mid-quiz and came back
const dD = await device("dev-bo-1", "bo@usc.edu");
await rep(dD, { event: "lock", student: "bo@usc.edu" });
sqlite.prepare("UPDATE locks SET last_lock=?, helper_seen=? WHERE device_id=?").run(new Date(Date.now() - 720000).toISOString(), new Date(Date.now() - 720000).toISOString(), dD.id);
await call("/report", { event: "heartbeat", quiz_id: "100-12", source: "helper" }, { key: dD.key, device: dD.id });
row = await rowOf("100-12", dD.id);
check("helper dark for 12 min, then back -> flagged 'left_early' (went_dark)", row?.status === "left_early" && row.reason === "went_dark", JSON.stringify(row));
// a 0.3.9 client times heartbeats by loop cycles and may drift past STALE: never flag it for that
const dO = await device("dev-old-1", "ol@usc.edu");
sqlite.prepare("UPDATE devices SET version='0.3.9' WHERE device_id=?").run(dO.id);
await rep(dO, { event: "lock", student: "ol@usc.edu" });
sqlite.prepare("UPDATE locks SET last_lock=?, helper_seen=? WHERE device_id=?").run(new Date(Date.now() - 720000).toISOString(), new Date(Date.now() - 720000).toISOString(), dO.id);
await call("/report", { event: "heartbeat", quiz_id: "100-12", source: "helper" }, { key: dO.key, device: dO.id });
row = await rowOf("100-12", dO.id);
check("old 0.3.9 client with a long heartbeat gap is NOT flagged", row?.status === "locked", JSON.stringify(row));
// the 3-hour cap is not a clean finish
const dC = await device("dev-cy-1", "cy@usc.edu");
await rep(dC, { event: "lock", student: "cy@usc.edu" });
await rep(dC, { event: "unlock", reason: "cap", student: "cy@usc.edu" });
row = await rowOf("100-12", dC.id);
check("helper auto-unlock at the cap ('cap') -> 'left_early'", row?.status === "left_early" && row.reason === "cap", JSON.stringify(row));
// clean finishes
const dE = await device("dev-di-1", "di@usc.edu");
await rep(dE, { event: "lock", student: "di@usc.edu" });
await rep(dE, { event: "unlock", reason: "quiz_submitted", student: "di@usc.edu" });
row = await rowOf("100-12", dE.id);
check("agent's 'quiz_submitted' unlock (no Sync-tab submissions yet) -> clean 'done'", row?.status === "done", JSON.stringify(row));
await call("/submitted", { ou: "100", qi: "12", user_ids: ["901"] }, { teacher: P2 });   // Al (901) really submitted
row = await rowOf("100-12", dL.id);
check("a confirmed submission clears the flag", row && row.status !== "left_early", JSON.stringify(row));
const LBL = (readFileSync(join(CF, "public", "dashboard.html"), "utf8").match(/const LBL = \{([^\n]*)\};/) || [])[1] || "";
const statuses = new Set((await live("100-12")).map(x => x.status));
check("every /live status is one the dashboard labels", [...statuses].every(s => LBL.includes(s + ":")), [...statuses].join(","));
// after the quiz window: an unlock is not flagged
sqlite.prepare("INSERT OR REPLACE INTO bs_quizzes (ou,qi,name,active,start_date,end_date) VALUES ('100','12','Q12',1,?,?)").run(new Date(Date.now() - 7200000).toISOString(), new Date(Date.now() - 60000).toISOString());
const dG = await device("dev-ed-1", "ed@usc.edu");
await rep(dG, { event: "unlock", reason: "quiz_left", student: "ed@usc.edu" });
row = await rowOf("100-12", dG.id);
check("an unlock after the quiz closed is a plain 'done'", row?.status === "done", JSON.stringify(row));

console.log("M1 migrations 020 + 021 on a pre-audit database (as deploy.sh runs them: comment lines stripped, once)");
{ const old = new DatabaseSync(":memory:");
  const schema = readFileSync(join(CF, "schema.sql"), "utf8").replace(/bs_user_id TEXT,[^\n]*\n\s*vouched[^\n]*/, "bs_user_id TEXT").split("\n").filter(l => !/idx_events_event_ts|idx_locks_quiz|idx_quizzes_ou_qi/.test(l)).join("\n");
  old.exec(schema);
  const t = new Date().toISOString();
  old.exec(`INSERT INTO teachers (id,email,role,verified) VALUES ('A1','a@x.edu','admin',0),('V1','v@x.edu','teacher',1),('I1','i@x.edu','teacher',0),('N1','n@x.edu','teacher',0)`);
  old.exec(`INSERT INTO invites (code,email,used_at,used_by) VALUES ('C1','i@x.edu','${t}','i@x.edu')`);
  old.exec(`INSERT INTO quizzes (quiz_id,password,qi,ou,gated) VALUES ('d1','P1','5','9',0),('d2','P2','5','9',1),('d3','P3','5','9',0),('k1','K1','6','9',0),('l1','L1',NULL,NULL,0),('l2','L2',NULL,NULL,0)`);
  const run = f => old.exec(readFileSync(join(CF, f), "utf8").split("\n").filter(l => !/^\s*--/.test(l)).join("\n"));
  run("migrate_020_vouched.sql"); run("migrate_021_indexes.sql");
  const v = Object.fromEntries(old.prepare("SELECT id, vouched FROM teachers").all().map(r => [r.id, Number(r.vouched)]));
  check("admin, verified and invited accounts grandfathered as vouched; others not", v.A1 === 1 && v.V1 === 1 && v.I1 === 1 && v.N1 === 0, JSON.stringify(v));
  const dq = old.prepare("SELECT quiz_id FROM quizzes WHERE ou='9' AND qi='5'").all().map(r => r.quiz_id);
  check("duplicate (ou,qi) rows deduped to one (the gated one kept)", dq.length === 1 && dq[0] === "d2", JSON.stringify(dq));
  check("other quizzes and legacy rows without ou/qi untouched", Number(old.prepare("SELECT COUNT(*) AS n FROM quizzes").get().n) === 4);
  check("unique index now in place", !!old.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_quizzes_ou_qi'").get());
  let threw = false; try { run("migrate_021_indexes.sql"); } catch { threw = true; }
  check("021 is safe to run again", !threw);
  threw = false; try { run("migrate_020_vouched.sql"); } catch (e) { threw = /duplicate column/.test(String(e)); }
  check("020 re-run fails only with 'duplicate column' (deploy.sh records it as applied)", threw);
  let ok2 = true; try { old.exec(readFileSync(join(CF, "schema.sql"), "utf8").split("\n").filter(l => !/^\s*--/.test(l)).join("\n")); } catch { ok2 = false; }
  check("schema.sql re-applies cleanly after the migrations", ok2); }

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
