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
    schema = schema.replace(/,\n  gated     INTEGER DEFAULT 0[^\n]*/, "").replace(/,\n  verified  INTEGER DEFAULT 0[^\n]*/, "");
  }
  sqlite.exec(schema);
  if (oldSchema) sqlite.exec(readFileSync(join(CF, "migrate_010_gate_verify.sql"), "utf8"));
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
  await call(env, "/signup", { email: "admin@usc.edu", password: "adminpass1" });

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

  console.log("T3 syncing a staff course auto-verifies (no email, no admin step)");
  r = await call(env, "/sync", { courses: [ { ou: OU, name: "ECON 203", code: "ECON-203", role: "Instructor",
      classlist: [ { id: "4001", name: "Al Student", email: "al@usc.edu", role: "Student" },
                   { id: "4002", name: "Bo Student", email: "bo@usc.edu", role: "Student" } ],
      quizzes: [ { qi: QI, name: "Midterm", active: true } ] } ] }, { sync: SYNC });
  check("sync accepted", r.status === 200, JSON.stringify(r.data));
  r = await getc(env, "/me", { teacher: TOK });
  check("teacher is now verified", r.data?.verified === true, JSON.stringify(r.data));

  console.log("T4 /gate needs the quiz protected first, then flips the gated flag");
  r = await call(env, "/gate", { ou: OU, qi: QI, on: true }, { teacher: TOK });
  check("gate before protect refused", r.status === 400, `got ${r.status} ${JSON.stringify(r.data)}`);
  r = await call(env, "/protect", { ou: OU, qi: QI, on: true }, { teacher: TOK });
  check("verified teacher can protect", r.status === 200 && /^LQ-/.test(r.data?.password||""), JSON.stringify(r.data));
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
  // age the lock past STALE (90s) -> no longer eligible
  sqlite.prepare("UPDATE locks SET last_lock=?, helper_seen=? WHERE device_id=?").run(new Date(Date.now()-120000).toISOString(), new Date(Date.now()-120000).toISOString(), DEV);
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
}

await suite("fresh schema", false);
await suite("old schema upgraded by migrate_010", true);
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
