// Live access gate + teacher self-verification (23 Oct 2026). Runs the REAL API against an in-memory
// SQLite DB (node:sqlite), no network. Proves:
//   * a teacher signs up with NO invite and is UNVERIFIED -> cannot protect or gate a quiz;
//   * syncing a course where they are staff auto-verifies them (no email, no admin) -> can protect + gate;
//   * a student-type account that never syncs staff stays unverified and can never act as a teacher;
//   * /gate needs the quiz protected first; and the quiz's `gated` flag flips;
//   * /live admits ONLY a device holding a fresh, device-SIGNED lock (eligible=true + user_id), and
//     drops it the moment the lock is unsigned or stale -> this is what the gate grants access on.
// Runs on a fresh schema and on an old schema upgraded by migrate_010. Exits non-zero on any failure.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-gate-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);

let pass = 0, fail = 0;
const ok = m => { pass++; console.log("  ok:", m); };
const bad = m => { fail++; console.log("  FAIL:", m); };
const check = (m, c, i = "") => (c ? ok(m) : bad(m + (i ? `  (${i})` : "")));

const sign = (key, path, ts, body) =>
  createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");

function d1(sqlite) {
  return { prepare(sql) {
    const st = sqlite.prepare(sql); let args = [];
    const s = { bind(...a) { args = a.map(x => (x === undefined ? null : typeof x === "boolean" ? Number(x) : x)); return s; },
                first: async () => st.get(...args) ?? null,
                all: async () => ({ results: st.all(...args) }),
                run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }) };
    return s;
  }, async batch(sts){ for (const _ of sts) {} } };
}
// db.batch runs each prepared statement; our shim's statements already ran on .bind? No: emulate real batch.
function d1real(sqlite) {
  const mk = () => { let args = []; let st = null;
    return { _sql(sql){ st = sqlite.prepare(sql); return this; },
      bind(...a){ args = a.map(x => x===undefined?null:typeof x==="boolean"?Number(x):x); this._run=()=>st.run(...args); return this; },
      first: async()=> st.get(...args) ?? null, all: async()=>({results:st.all(...args)}),
      run: async()=>({meta:{changes:Number(st.run(...args).changes)}}) }; };
  return { prepare(sql){ return mk()._sql(sql); },
           async batch(sts){ for (const s of sts) s._run(); } };
}

const BASE = "https://lockqz.test", ADMIN = "admin-test-key";
const OU = "98765", QI = "12345", LOCK_ID = `${OU}-${QI}`;
const QUIZ_URL = `https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${QI}&ou=${OU}`;

function makeDb(oldSchema) {
  const sqlite = new DatabaseSync(":memory:");
  let schema = readFileSync(join(CF, "schema.sql"), "utf8");
  if (oldSchema) {   // schema before this feature: strip the two new columns, then migrate_010 adds them
    schema = schema.replace(/,\n  gated     INTEGER DEFAULT 0[^\n]*/, "").replace(/,\n  verified  INTEGER DEFAULT 0[^\n]*/, "").replace(/\n  ip        TEXT,[^\n]*/, "");
  }
  sqlite.exec(schema);
  if (oldSchema) { sqlite.exec(readFileSync(join(CF, "migrate_010_gate_verify.sql"), "utf8")); sqlite.exec(readFileSync(join(CF, "migrate_011_lock_ip.sql"), "utf8")); }
  for (const m of ["migrate_012_bs_code.sql", "migrate_013_sa_keep.sql", "migrate_014_lockqz_off.sql", "migrate_016_bs_user.sql"]) { try { sqlite.exec(readFileSync(join(CF, m), "utf8")); } catch (e) { /* already in schema.sql */ } }
  return sqlite;
}

async function call(env, path, body, { teacher = null, sync = null, key = null, device = null } = {}) {
  const raw = JSON.stringify(body ?? {});
  const h = { "Content-Type": "application/json" };
  if (teacher) h["X-LOCKqz-Teacher"] = teacher;
  if (sync) h["X-LOCKqz-Sync"] = sync;
  if (key) { const ts = String(Math.floor(Date.now()/1000)); h["X-LOCKqz-Device"]=device; h["X-LOCKqz-Time"]=ts; h["X-LOCKqz-Sig"]=sign(key, `/api${path}`, ts, raw); }
  const res = await onRequest({ request: new Request(BASE+"/api"+path, { method:"POST", headers:h, body:raw }), env });
  let data=null; try{ data=await res.json(); }catch{}
  return { status:res.status, data };
}
async function getc(env, path, { teacher=null, sync=null } = {}) {
  const h = {}; if (teacher) h["X-LOCKqz-Teacher"]=teacher; if (sync) h["X-LOCKqz-Sync"]=sync;
  const res = await onRequest({ request: new Request(BASE+"/api"+path, { method:"GET", headers:h }), env });
  let data=null; try{ data=await res.json(); }catch{}
  return { status:res.status, data };
}

async function suite(label, oldSchema) {
  console.log(`\n== ${label} ==`);
  const sqlite = makeDb(oldSchema);
  const env = { DB: d1real(sqlite), TEACHER_KEY: ADMIN, REQUIRE_SIGNED: "1" };

  // First account becomes admin; make it so the teacher under test is a normal teacher.
  const ADMIN_TOK = (await call(env, "/signup", { email: "admin@usc.edu", password: "adminpass1" })).data.token;

  console.log("T1 open signup, no invite needed, new teacher is UNVERIFIED");
  let r = await call(env, "/signup", { email: "prof@usc.edu", password: "profpass1", name: "Prof" });
  check("signup with no invite code succeeds", r.status === 200 && r.data?.token, JSON.stringify(r.data));
  const TOK = r.data.token;
  r = await getc(env, "/me", { teacher: TOK });
  check("teacher starts unverified", r.status === 200 && r.data?.verified === false, JSON.stringify(r.data));

  console.log("T2 an unverified teacher can get a sync key but cannot protect or gate");
  r = await getc(env, "/synckey", { teacher: TOK });
  check("synckey available before verification (needed to bootstrap)", r.status === 200 && /^lqs_/.test(r.data?.key||""), JSON.stringify(r.data));
  const SYNC = r.data.key;
  r = await call(env, "/protect", { ou: OU, qi: QI, on: true }, { teacher: TOK });
  check("unverified /protect refused (403)", r.status === 403, `got ${r.status}`);
  r = await call(env, "/gate", { ou: OU, qi: QI, on: true }, { teacher: TOK });
  check("unverified /gate refused (403)", r.status === 403, `got ${r.status}`);

  console.log("T3a a forged sync before the course is trusted does NOT verify (browser role claims are not trusted)");
  r = await call(env, "/sync", { courses: [ { ou: "11111", name: "Fake", role: "Instructor", classlist: [ { id: "9", name: "Prof", email: "prof@usc.edu", role: "Instructor" } ], quizzes: [] } ] }, { sync: SYNC });
  check("self-claimed staff role in an untrusted course does not verify", (await getc(env, "/me", { teacher: TOK })).data?.verified === false);
  console.log("T3 once a trusted account (admin) has synced the real course, its listed professor verifies on their own sync");
  await call(env, "/sync", { courses: [ { ou: OU, name: "ECON 203", code: "ECON-203", role: "Teaching Assistant",
      classlist: [ { id: "4000", name: "Prof", email: "prof@usc.edu", role: "Instructor" },
                   { id: "4001", name: "Al Student", email: "al@usc.edu", role: "Student" },
                   { id: "4002", name: "Bo Student", email: "bo@usc.edu", role: "Student" } ],
      quizzes: [] } ] }, { teacher: ADMIN_TOK });
  r = await call(env, "/sync", { whoami: { id: "4000" }, courses: [ { ou: OU, name: "ECON 203", code: "ECON-203", role: "Instructor",
      classlist: [ { id: "4000", name: "Prof", email: "prof@usc.edu", role: "Instructor" },
                   { id: "4001", name: "Al Student", email: "al@usc.edu", role: "Student" },
                   { id: "4002", name: "Bo Student", email: "bo@usc.edu", role: "Student" } ],
      quizzes: [ { qi: QI, name: "Midterm", active: true } ] } ] }, { sync: SYNC });
  check("sync accepted", r.status === 200, JSON.stringify(r.data));
  r = await getc(env, "/me", { teacher: TOK });
  check("teacher is now verified", r.data?.verified === true, JSON.stringify(r.data));

  console.log("T3a PAID ONLY: a verified professor who has not paid gets nothing");
  check("verified but unpaid is not active", r.data?.active === false, JSON.stringify(r.data));
  check("unpaid: sync did NOT auto-protect", !sqlite.prepare("SELECT 1 FROM quizzes WHERE qi=?").get(QI));
  r = await call(env, "/protect", { ou: OU, qi: QI, on: true }, { teacher: TOK });
  check("unpaid /protect refused (402)", r.status === 402, `got ${r.status}`);
  r = await call(env, "/gate", { ou: OU, qi: QI, on: true }, { teacher: TOK });
  check("unpaid /gate refused (402)", r.status === 402, `got ${r.status}`);
  r = await call(env, "/rotating", { ou: OU, qis: [QI] }, { teacher: TOK });
  check("unpaid /rotating refused (402)", r.status === 402, `got ${r.status}`);
  r = await call(env, "/activate", { email: "student-nobody@usc.edu", until: "2099-12-31" }, { teacher: TOK });
  check("a professor cannot activate anyone (admin only)", r.status === 401, `got ${r.status}`);
  r = await call(env, "/activate", { email: "prof@usc.edu", until: "2099-12-31" }, { teacher: ADMIN_TOK });
  check("admin activates after payment", r.status === 200, JSON.stringify(r.data));
  r = await call(env, "/sync", { whoami: { id: "4000" }, courses: [ { ou: OU, name: "ECON 203", code: "ECON-203", role: "Instructor",
      classlist: [ { id: "4000", name: "Prof", email: "prof@usc.edu", role: "Instructor" },
                   { id: "4001", name: "Al Student", email: "al@usc.edu", role: "Student" },
                   { id: "4002", name: "Bo Student", email: "bo@usc.edu", role: "Student" } ],
      quizzes: [ { qi: QI, name: "Midterm", active: true } ] } ] }, { sync: SYNC });
  check("paid re-sync accepted", r.status === 200, JSON.stringify(r.data));

  console.log("T3b protect-by-default: the active synced quiz was auto-protected");
  check("active quiz auto-protected on sync", !!sqlite.prepare("SELECT 1 FROM quizzes WHERE qi=?").get(QI), "no quizzes row");

  console.log("T4 /gate needs the quiz protected first, then flips the gated flag");
  r = await call(env, "/gate", { ou: OU, qi: "77777", on: true }, { teacher: TOK });   // 77777 never synced => unprotected
  check("gate on an unprotected quiz refused", r.status === 400, `got ${r.status} ${JSON.stringify(r.data)}`);
  r = await call(env, "/protect", { ou: OU, qi: QI, on: true }, { teacher: TOK });
  check("protect returns the quiz's LOCKqz password", r.status === 200 && /^LQ-/.test(r.data?.password||""), JSON.stringify(r.data));
  const PW = r.data.password;
  r = await call(env, "/gate", { ou: OU, qi: QI, on: true }, { teacher: TOK });
  check("gate on after protect", r.status === 200 && r.data?.gated === true, JSON.stringify(r.data));
  check("quizzes.gated set in DB", sqlite.prepare("SELECT gated FROM quizzes WHERE qi=?").get(QI)?.gated === 1);

  console.log("T5 a student-type account can never act as a teacher");
  r = await call(env, "/signup", { email: "al@usc.edu", password: "studentpw1" });
  const STOK = r.data.token;
  r = await call(env, "/synckey", { teacher: STOK });   // gets a key, but...
  const SSYNC = r.data.key;
  r = await call(env, "/sync", { courses: [] }, { sync: SSYNC });   // no staff course -> no verify
  r = await getc(env, "/me", { teacher: STOK });
  check("student account stays unverified after an empty sync", r.data?.verified === false, JSON.stringify(r.data));
  r = await call(env, "/protect", { ou: OU, qi: QI, on: true }, { teacher: STOK });
  check("student account cannot protect", r.status === 403, `got ${r.status}`);

  console.log("T6 /live admits ONLY a fresh, device-signed lock");
  const DEV = "mac-aaaa-bbbb-cccc-dddd", K = randomBytes(32).toString("hex");
  await call(env, "/register", { device_id: DEV, key: K, student: "al@usc.edu", platform: "mac-15" });
  r = await getc(env, "/live?quiz=" + LOCK_ID, { teacher: TOK });
  check("before any lock: nobody eligible", (r.data?.rows||[]).every(x => !x.eligible), JSON.stringify(r.data?.rows));
  // signed lock on this quiz
  r = await call(env, "/report", { event: "lock", quiz_id: LOCK_ID, student: "al@usc.edu" }, { key: K, device: DEV });
  check("signed lock accepted", r.status === 200, JSON.stringify(r.data));
  r = await getc(env, "/live?quiz=" + LOCK_ID, { teacher: TOK });
  let row = (r.data?.rows||[]).find(x => x.user_id === "4001");
  check("locked student is eligible, resolved to Brightspace user_id 4001", !!row && row.eligible === true, JSON.stringify(r.data?.rows));
  check("eligible row carries the student name from the roster", row?.student === "Al Student", JSON.stringify(row));
  // age the lock past STALE (420s; helper beats every ~180s) -> no longer eligible
  sqlite.prepare("UPDATE locks SET last_lock=?, helper_seen=? WHERE device_id=?").run(new Date(Date.now()-600000).toISOString(), new Date(Date.now()-600000).toISOString(), DEV);
  r = await getc(env, "/live?quiz=" + LOCK_ID, { teacher: TOK });
  row = (r.data?.rows||[]).find(x => x.user_id === "4001");
  check("a gone-dark lock is NOT eligible (access would be revoked)", !row || row.eligible === false, JSON.stringify(row));
  // an UNSIGNED lock (legacy/forged) is not eligible even while fresh
  const DEV2 = "mac-eeee", legacyEnv = { DB: env.DB, TEACHER_KEY: ADMIN };   // no strict
  await call(legacyEnv, "/report", { device_id: DEV2, event: "lock", quiz_id: LOCK_ID, student: "bo@usc.edu" });
  r = await getc(env, "/live?quiz=" + LOCK_ID, { teacher: TOK });
  row = (r.data?.rows||[]).find(x => x.user_id === "4002");
  check("an unsigned (unverified) lock is never eligible", !row || row.eligible === false, JSON.stringify(row));

  console.log("T7 gate off flips the flag back");
  r = await call(env, "/gate", { ou: OU, qi: QI, on: false }, { teacher: TOK });
  check("gate off", r.status === 200 && r.data?.gated === false);
  check("quizzes.gated cleared", sqlite.prepare("SELECT gated FROM quizzes WHERE qi=?").get(QI)?.gated === 0);

  console.log("T8 protect-by-default: ended quizzes are skipped; a released quiz is not re-protected");
  const yday = new Date(Date.now() - 86400000).toISOString();
  await call(env, "/sync", { courses: [ { ou: OU, name: "ECON 203", role: "Instructor",
      quizzes: [ { qi: "55501", name: "New active", active: true },
                 { qi: "55502", name: "Old ended", active: true, end: yday } ] } ] }, { sync: SYNC });
  check("a new active quiz auto-protects", !!sqlite.prepare("SELECT 1 FROM quizzes WHERE qi=?").get("55501"));
  check("an ended quiz does NOT auto-protect", !sqlite.prepare("SELECT 1 FROM quizzes WHERE qi=?").get("55502"));
  await call(env, "/protect", { ou: OU, qi: "55501", on: false }, { teacher: TOK });   // teacher releases it
  await call(env, "/sync", { courses: [ { ou: OU, name: "ECON 203", role: "Instructor",
      quizzes: [ { qi: "55501", name: "New active", active: true } ] } ] }, { sync: SYNC });
  check("a released quiz stays released after re-sync", !sqlite.prepare("SELECT 1 FROM quizzes WHERE qi=?").get("55501"));

  console.log("T9 rotating password: /password returns a per-minute code, /rotating gives cur+next, /live carries the device IP");
  // re-lock a device fresh (T6 aged it); use a new signed device
  const DEV9 = "mac-9999", K9 = randomBytes(32).toString("hex");
  await call(env, "/register", { device_id: DEV9, key: K9, student: "al@usc.edu", platform: "mac-15" });
  await call(env, "/report", { event: "lock", quiz_id: LOCK_ID, student: "al@usc.edu" }, { key: K9, device: DEV9 });
  const seed = sqlite.prepare("SELECT password FROM quizzes WHERE qi=?").get(QI).password;
  r = await call(env, "/gate", { ou: OU, qi: QI, on: false }, { teacher: TOK });
  r = await call(env, "/password", { url: QUIZ_URL, device_id: DEV9 }, { key: K9, device: DEV9 });
  check("protected, NOT gated -> the fixed password (exactly what Brightspace holds)", r.status === 200 && r.data?.password === seed, JSON.stringify(r.data));
  check("the seed is never sent separately to the device", !("seed" in (r.data || {})), JSON.stringify(r.data));
  r = await call(env, "/gate", { ou: OU, qi: QI, on: true, keep: ["4100"] }, { teacher: TOK });
  check("gate on records the accommodation list", JSON.stringify(r.data?.keep) === JSON.stringify(["4100"]), JSON.stringify(r.data));
  r = await call(env, "/password", { url: QUIZ_URL, device_id: DEV9 }, { key: K9, device: DEV9 });
  check("gated, Sync has not confirmed a code yet -> the fixed password", r.data?.password === seed, JSON.stringify(r.data));
  r = await call(env, "/rotating", { ou: OU, qis: [QI] }, { teacher: TOK });
  const cur9 = r.data?.codes?.[QI]?.cur;
  check("/rotating code differs from next", cur9 && cur9 !== r.data?.codes?.[QI]?.next, JSON.stringify(r.data?.codes?.[QI]));
  r = await call(env, "/rotated", { ou: OU, qi: QI, code: cur9 }, { teacher: TOK });
  check("Sync confirms the code it wrote", r.status === 200, JSON.stringify(r.data));
  r = await call(env, "/password", { url: QUIZ_URL, device_id: DEV9 }, { key: K9, device: DEV9 });
  check("student gets EXACTLY the confirmed code (still right if the Sync tab then closes)", r.data?.password === cur9, JSON.stringify(r.data));
  r = await call(env, "/rotated", { ou: OU, qi: QI, code: "LQ-EVIL" }, { teacher: STOK });
  check("a non-professor cannot set the code", r.status === 403, `got ${r.status}`);
  r = await call(env, "/gate", { ou: OU, qi: QI, on: true, keep: ["999"] }, { teacher: TOK });
  check("restarting the gate (tab reload) keeps the FIRST accommodation list", JSON.stringify(r.data?.keep) === JSON.stringify(["4100"]), JSON.stringify(r.data));
  check("restarting the gate keeps the confirmed code", sqlite.prepare("SELECT bs_code FROM quizzes WHERE qi=?").get(QI).bs_code === cur9);
  r = await getc(env, "/live?quiz=" + LOCK_ID, { teacher: TOK });
  const row9 = (r.data?.rows || []).find(x => x.device_id === DEV9);
  check("/live row carries the locked device's IP field", row9 && ("ip" in row9), JSON.stringify(row9));

  console.log("T11 TAs are locked + tracked like students; the admin (developer mode) is the only exception");
  await call(env, "/sync", { courses: [ { ou: OU, name: "ECON 203", code: "ECON-203", role: "Teaching Assistant",
      classlist: [ { id: "4000", name: "Prof", email: "prof@usc.edu", role: "Instructor" },
                   { id: "4001", name: "Al Student", email: "al@usc.edu", role: "Student" },
                   { id: "4002", name: "Bo Student", email: "bo@usc.edu", role: "Student" },
                   { id: "4003", name: "Tia TA", email: "ta@usc.edu", role: "Teaching Assistant" },
                   { id: "4004", name: "Admin TA", email: "admin@usc.edu", role: "Teaching Assistant" } ],
      quizzes: [ { qi: QI, name: "Midterm", active: true } ] } ] }, { teacher: ADMIN_TOK });
  r = await getc(env, "/bs", { teacher: TOK });
  const st11 = (r.data?.courses || []).find(c => c.ou === OU)?.students || [];
  check("professor's list includes the TA (must install)", st11.some(x => x.email === "ta@usc.edu" && x.ta === true), JSON.stringify(st11));
  check("professor's list still includes learners", st11.some(x => x.email === "al@usc.edu" && x.ta === false));
  check("admin is NOT listed (exempt)", !st11.some(x => x.email === "admin@usc.edu"));
  check("instructor is NOT listed", !st11.some(x => x.email === "prof@usc.edu"));
  const DTA = "mac-ta11", KTA = randomBytes(32).toString("hex");
  await call(env, "/register", { device_id: DTA, key: KTA, student: "ta@usc.edu", platform: "mac-15" });
  await call(env, "/report", { event: "lock", quiz_id: LOCK_ID, student: "ta@usc.edu" }, { key: KTA, device: DTA });
  r = await call(env, "/password", { url: QUIZ_URL, device_id: DTA }, { key: KTA, device: DTA });
  check("locked TA gets the quiz password", r.status === 200 && !!r.data?.password, JSON.stringify(r.data));
  const DAD = "mac-admin11", KAD = randomBytes(32).toString("hex");
  await call(env, "/register", { device_id: DAD, key: KAD, student: "admin@usc.edu", platform: "mac-15" });
  await call(env, "/report", { event: "lock", quiz_id: LOCK_ID, student: "admin@usc.edu", detail: { developer: true } }, { key: KAD, device: DAD });
  r = await call(env, "/password", { url: QUIZ_URL, device_id: DAD }, { key: KAD, device: DAD });
  check("admin in developer mode still gets the quiz password", r.status === 200 && !!r.data?.password, JSON.stringify(r.data));
  const DFK = "mac-fake11", KFK = randomBytes(32).toString("hex");
  await call(env, "/register", { device_id: DFK, key: KFK, student: "bo@usc.edu", platform: "mac-15" });
  await call(env, "/report", { event: "lock", quiz_id: LOCK_ID, student: "bo@usc.edu", detail: { developer: true } }, { key: KFK, device: DFK });
  r = await call(env, "/password", { url: QUIZ_URL, device_id: DFK }, { key: KFK, device: DFK });
  check("a student faking developer mode is refused the password", r.status === 403, JSON.stringify(r.data));
  r = await getc(env, "/live?quiz=" + LOCK_ID, { teacher: TOK });
  const rows11 = r.data?.rows || [], rw = id => rows11.find(x => x.device_id === id);
  check("TA: locked + admitted by the gate", rw(DTA)?.status === "locked" && rw(DTA)?.eligible === true && rw(DTA)?.user_id === "4003", JSON.stringify(rw(DTA)));
  check("admin: shown as developer + admitted", rw(DAD)?.status === "developer" && rw(DAD)?.eligible === true, JSON.stringify(rw(DAD)));
  check("fake developer: tamper + NOT admitted", rw(DFK)?.status === "tamper" && rw(DFK)?.eligible === false, JSON.stringify(rw(DFK)));

  console.log("T10 PAID ONLY: turning a professor off stops LOCKqz for them and frees their quizzes");
  r = await call(env, "/activate", { email: "prof@usc.edu", until: null }, { teacher: ADMIN_TOK });
  check("admin turns professor off", r.status === 200, JSON.stringify(r.data));
  check("their protected quizzes are released", !sqlite.prepare("SELECT 1 FROM quizzes WHERE teacher_id=(SELECT id FROM teachers WHERE email='prof@usc.edu')").get());
  check("passwords queued for removal from Brightspace (students never stranded)", !!sqlite.prepare("SELECT 1 FROM pending_clear WHERE qi=?").get(QI));
  r = await call(env, "/protect", { ou: OU, qi: QI, on: true }, { teacher: TOK });
  check("turned-off professor cannot protect (402)", r.status === 402, `got ${r.status}`);
  r = await call(env, "/activate", { email: "prof@usc.edu", until: "2020-01-01" }, { teacher: ADMIN_TOK });
  r = await getc(env, "/me", { teacher: TOK });
  check("an expired paid date is not active", r.data?.active === false, JSON.stringify(r.data));
}

await suite("fresh schema", false);
await suite("old schema upgraded by migrate_010", true);
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
