// Security regressions from the 25-Oct deep audit. Runs the REAL API against in-memory SQLite with a
// D1 shim that enforces the 100-bound-parameter limit (so param-count bugs show up as they would live).
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-sec-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

// D1 shim: throws above 100 bound params, like real D1.
function d1(sqlite) {
  const mk = () => { let args = [], st = null;
    return { _sql(q){ st = sqlite.prepare(q); return this; },
      bind(...a){ if (a.length > 100) throw new Error("too many SQL variables (" + a.length + ")");
                  args = a.map(x => x===undefined?null:typeof x==="boolean"?Number(x):x); this._run=()=>st.run(...args); return this; },
      first: async()=> st.get(...args) ?? null, all: async()=>({results:st.all(...args)}),
      run: async()=>({meta:{changes:Number(st.run(...args).changes)}}) }; };
  return { prepare(q){ return mk()._sql(q); }, async batch(sts){ for (const s of sts) s._run(); } };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of ["migrate_012_bs_code.sql","migrate_013_sa_keep.sql","migrate_014_lockqz_off.sql","migrate_016_bs_user.sql"]) { try { sqlite.exec(readFileSync(join(CF, m), "utf8")); } catch (e) { /* already in schema.sql */ } }
const env = { DB: d1(sqlite), TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", ADMIN_EMAIL: "admin@usc.edu", ROT_SECRET: "test-rot-secret", LIVE_CACHE_MS: "0" };   // /live right after each event (sharing is tested in test_round2_api)
const BASE = "https://lockqz.test";
const sign = (key, path, ts, raw) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(raw).digest("hex")}`).digest("hex");
async function call(path, body, { teacher=null, sync=null, key=null, device=null, get=false } = {}) {
  const raw = JSON.stringify(body ?? {});
  const h = { "Content-Type":"application/json" };
  if (teacher) h["X-LOCKqz-Teacher"]=teacher;
  if (sync) h["X-LOCKqz-Sync"]=sync;
  if (key) { const ts=String(Math.floor(Date.now()/1000)); h["X-LOCKqz-Device"]=device; h["X-LOCKqz-Time"]=ts; h["X-LOCKqz-Sig"]=sign(key, path.replace(/\?.*/,"").replace(/^/,"/api"), ts, raw); }
  const res = await onRequest({ request: new Request(BASE+"/api"+path, { method:get?"GET":"POST", headers:h, body:get?undefined:raw }), env });
  return { status: res.status, data: await res.json().catch(()=>null) };
}

// --- set up: admin, two real professors on two courses, students ---
// First signup becomes role=admin (a real teachers row, as in production where Anthony logs in).
const ADMIN = (await call("/signup", { email:"admin@usc.edu", password:"adminpass1" })).data.token;
const A = (await call("/signup", { email:"profa@usc.edu", password:"passworda1" })).data.token;   // course 100
const B = (await call("/signup", { email:"profb@usc.edu", password:"passwordb1" })).data.token;   // course 200
// admin seeds both rosters so both verify as instructors
for (const [ou, email] of [["100","profa@usc.edu"],["200","profb@usc.edu"]])
  await call("/sync", { courses:[{ ou, name:"C"+ou, role:"Instructor", classlist:[
    { id:"1"+ou, name:"Prof", email, role:"Instructor" },
    { id:"2"+ou, name:"Stu", email:"stu"+ou+"@usc.edu", role:"Student" } ], quizzes:[] }] }, { teacher: ADMIN });
await call("/activate", { email:"profa@usc.edu", until:"2099-12-31" }, { teacher: ADMIN });
await call("/activate", { email:"profb@usc.edu", until:"2099-12-31" }, { teacher: ADMIN });
const SA = (await call("/synckey", {}, { teacher: A })).data.key;
const SB = (await call("/synckey", {}, { teacher: B })).data.key;
// each professor syncs their own course with a quiz
await call("/sync", { whoami:{id:"1100"}, courses:[{ ou:"100", name:"C100", role:"Instructor", classlist:[
  { id:"1100", name:"Prof", email:"profa@usc.edu", role:"Instructor" }, { id:"2100", name:"Stu", email:"stu100@usc.edu", role:"Student" } ],
  quizzes:[{ qi:"5100", name:"A Mid", active:true }] }] }, { sync: SA });
await call("/sync", { whoami:{id:"1200"}, courses:[{ ou:"200", name:"C200", role:"Instructor", classlist:[
  { id:"1200", name:"Prof", email:"profb@usc.edu", role:"Instructor" }, { id:"2200", name:"Stu", email:"stu200@usc.edu", role:"Student" } ],
  quizzes:[{ qi:"5200", name:"B Mid", active:true }] }] }, { sync: SB });

console.log("SEC1 cross-course takeover: professor A cannot touch course B's quiz");
let r = await call("/protect", { ou:"100", qi:"5200", on:true }, { teacher: A });   // A's ou, B's qi
check("protect with my ou + another course's qi does NOT return B's password", !(r.data && r.data.password && r.data.password === sqlite.prepare("SELECT password FROM quizzes WHERE qi='5200'").get()?.password), JSON.stringify(r.data));
check("B's quiz row still belongs to B", sqlite.prepare("SELECT teacher_id FROM quizzes WHERE qi='5200'").get()?.teacher_id === sqlite.prepare("SELECT id FROM teachers WHERE email='profb@usc.edu'").get().id);
r = await call("/protect", { ou:"100", qi:"5200", on:false }, { teacher: A });
check("protect-off on another course's qi does NOT delete B's quiz", !!sqlite.prepare("SELECT 1 FROM quizzes WHERE qi='5200'").get());
r = await call("/rotated", { ou:"100", qi:"5200", code:"LQ-EVIL123" }, { teacher: A });
check("rotated on another course's qi does not change B's bs_code", sqlite.prepare("SELECT bs_code FROM quizzes WHERE qi='5200'").get()?.bs_code !== "LQ-EVIL123");

console.log("SEC2 /sync never returns another course's password (bsState leak)");
r = await call("/sync", { courses:[{ ou:"200" }] }, { sync: SA });   // A asks about B's course
check("A's sync for B's ou returns no protect rows", !(r.data?.protect || []).length, JSON.stringify(r.data?.protect));

console.log("SEC3 /rotating is scoped to a course the caller instructs");
r = await call("/rotating", { ou:"200", qis:["5200"] }, { teacher: A });
check("A cannot fetch B's rotating codes (403)", r.status === 403, `got ${r.status}`);
r = await call("/rotating", { ou:"100", qis:["5100"] }, { teacher: A });
check("A gets A's own codes, with no seed prefix", /^LQ-[0-9A-F]{10}$/.test(r.data?.codes?.["5100"]?.cur||""), JSON.stringify(r.data?.codes));

console.log("SEC4 scope() survives many quizzes (D1 100-param limit) — /live, /sessions, /roster");
for (let i = 0; i < 70; i++) sqlite.prepare("INSERT INTO quizzes (quiz_id,title,password,created_at,qi,teacher_id,lock_id,ou) VALUES (?,?,?,?,?,?,?,?)")
  .run("q"+i, "x", "LQ-x", new Date().toISOString(), "9"+i, sqlite.prepare("SELECT id FROM teachers WHERE email='profa@usc.edu'").get().id, "100-9"+i, "100");
r = await call("/live?quiz=100-5100", {}, { teacher: A, get:true });
check("/live works with 70+ owned quizzes (no 500)", r.status === 200, `got ${r.status} ${JSON.stringify(r.data)}`);
r = await call("/sessions?quiz=100-5100", {}, { teacher: A, get:true });
check("/sessions works at scale", r.status === 200, `got ${r.status}`);
r = await call("/roster", {}, { teacher: A, get:true });
check("/roster works at scale", r.status === 200, `got ${r.status}`);

console.log("SEC5 /live survives 100+ locked students on one quiz");
for (let i = 0; i < 110; i++) {
  const id = "dev"+i, k = randomBytes(32).toString("hex");
  await call("/register", { device_id:id, key:k, student:"s"+i+"@usc.edu", platform:"mac" });
  await call("/report", { event:"lock", quiz_id:"100-5100", student:"s"+i+"@usc.edu" }, { key:k, device:id });
}
r = await call("/live?quiz=100-5100", {}, { teacher: A, get:true });
check("/live works with 110 locked students (no 500)", r.status === 200, `got ${r.status} ${JSON.stringify(r.data).slice(0,80)}`);

console.log("SEC6 seeded-course access does not survive the real owner syncing");
// a fresh account 'sneaky' seeds an unowned course 300, then the real prof (admin-seeded) syncs it
const SNEAK = (await call("/signup", { email:"sneaky@usc.edu", password:"sneaky123" })).data.token;
const SS = (await call("/synckey", {}, { teacher: SNEAK })).data.key;
await call("/sync", { whoami:{id:"sneak1"}, courses:[{ ou:"300", name:"grab", role:"Instructor", classlist:[{ id:"1", name:"Me", email:"sneaky@usc.edu", role:"Instructor" }], quizzes:[] }] }, { sync: SS });
check("sneaky seeded course 300", !!sqlite.prepare("SELECT 1 FROM teacher_courses WHERE ou='300' AND teacher_id=(SELECT id FROM teachers WHERE email='sneaky@usc.edu')").get());
await call("/sync", { courses:[{ ou:"300", name:"ECON", role:"Instructor", classlist:[
  { id:"1300", name:"RealProf", email:"realprof@usc.edu", role:"Instructor" } ], quizzes:[] }] }, { teacher: ADMIN });
check("sneaky's seed row for 300 is purged once the admin owns it", !sqlite.prepare("SELECT 1 FROM teacher_courses WHERE ou='300' AND teacher_id=(SELECT id FROM teachers WHERE email='sneaky@usc.edu')").get());
r = await call("/quizzes", {}, { teacher: SNEAK, get:true });
check("sneaky's /quizzes shows nothing for 300", !(r.data?.quizzes||[]).some(q => q.ou === "300"));

console.log("SEC7 signup cannot pre-claim a professor already on a trusted roster");
r = await call("/signup", { email:"realprof@usc.edu", password:"imposter1" });
check("signup as a rostered instructor is refused (409)", r.status === 409, `got ${r.status} ${JSON.stringify(r.data)}`);

console.log("SEC7b identity binding: an email pre-claimed before the admin seeds cannot verify as that professor");
// 'imposter' signs up as realprof2@usc.edu BEFORE any roster has that email, then syncs with ITS OWN
// Brightspace id. Later the admin seeds course 400 with realprof2 as Instructor (a different id).
const IMP = (await call("/signup", { email:"realprof2@usc.edu", password:"imposter9" })).data.token;
const SI = (await call("/synckey", {}, { teacher: IMP })).data.key;
await call("/sync", { whoami:{id:"impostor-id"}, courses:[{ ou:"400", name:"seed", role:"Instructor", classlist:[{ id:"impostor-id", name:"Me", email:"realprof2@usc.edu", role:"Instructor" }], quizzes:[] }] }, { sync: SI });
await call("/sync", { courses:[{ ou:"400", name:"REAL", role:"Instructor", classlist:[{ id:"real-400-id", name:"Real", email:"realprof2@usc.edu", role:"Instructor" }], quizzes:[{ qi:"5400", name:"Final", active:true }] }] }, { teacher: ADMIN });
let ri = await call("/sync", { whoami:{id:"impostor-id"}, courses:[{ ou:"400" }] }, { sync: SI });
ri = await call("/me", {}, { teacher: IMP, get:true });
check("pre-claim account stays UNVERIFIED after the admin seeds the real roster (id mismatch)", ri.data?.verified === false, JSON.stringify(ri.data));
ri = await call("/protect", { ou:"400", qi:"5400", on:true }, { teacher: IMP });
check("pre-claim account cannot protect the real course's quiz", ri.status === 403, `got ${ri.status}`);

console.log("SEC8 /changepw needs the current password and rotates the token");
r = await call("/changepw", { password:"newpass12" }, { teacher: B });
check("changepw without old password refused (403)", r.status === 403, `got ${r.status}`);
r = await call("/changepw", { old_password:"passwordb1", password:"newpass12" }, { teacher: B });
check("changepw with old password works and returns a new token", r.status === 200 && r.data?.token && r.data.token !== B, JSON.stringify(r.data).slice(0,60));
r = await call("/me", {}, { teacher: B, get:true });
check("the old token no longer works", r.status === 401, `got ${r.status}`);

console.log("SEC9 the sync key cannot change the password or other account actions");
r = await call("/changepw", { old_password:"passworda1", password:"viasynckey" }, { sync: SA });
check("changepw via sync key refused (403)", r.status === 403, `got ${r.status}`);

console.log("SEC10 /login locks out after repeated failures");
let last;
for (let i = 0; i < 7; i++) last = await call("/login", { email:"profa@usc.edu", password:"wrong"+i });
check("login is rate-limited after 5 failures (429)", last.status === 429, `got ${last.status}`);

console.log("SEC11 /report rejects a junk quiz_id and oversized detail");
const idj = "devjunk", kj = randomBytes(32).toString("hex");
await call("/register", { device_id:idj, key:kj, student:"j@usc.edu", platform:"mac" });
r = await call("/report", { event:"lock", quiz_id:"not-a-real-id; DROP", student:"j@usc.edu" }, { key:kj, device:idj });
check("a malformed quiz_id makes no lock row", !sqlite.prepare("SELECT 1 FROM locks WHERE device_id='devjunk'").get());
await call("/report", { event:"tamper", quiz_id:"100-5100", detail:{ big:"x".repeat(50000) } }, { key:kj, device:idj });
const det = sqlite.prepare("SELECT length(detail) AS n FROM events WHERE device_id='devjunk' AND event='tamper'").get();
check("event detail is capped (<=2000 chars)", det && det.n <= 2000, JSON.stringify(det));

console.log("SEC12 a forced unlock is NOT a clean done until the server confirms the Brightspace submit");
// profa's course 100 quiz 5100: a student locks, gets admitted, then the student force-unlocks
// (as a token-holder would). Until the professor's Sync session confirms a real submission, the
// student shows red "left_early" and is NOT eligible (gate revokes). After /submitted, it is "done".
const DS = "dev-sub1", KS = randomBytes(32).toString("hex");
await call("/register", { device_id:DS, key:KS, student:"stu100@usc.edu", platform:"mac" });
await call("/report", { event:"lock", quiz_id:"100-5100", student:"stu100@usc.edu" }, { key:KS, device:DS });
let lv = await call("/live?quiz=100-5100", {}, { teacher: A, get:true });
let row = (lv.data?.rows||[]).find(x => x.device_id === DS);
check("locked student is eligible", row && row.status === "locked" && row.eligible === true, JSON.stringify(row));
await call("/report", { event:"unlock", quiz_id:"100-5100", student:"stu100@usc.edu" }, { key:KS, device:DS });
lv = await call("/live?quiz=100-5100", {}, { teacher: A, get:true });
row = (lv.data?.rows||[]).find(x => x.device_id === DS);
check("after a forced unlock with no confirmed submit -> 'left_early', not 'done'", row && row.status === "left_early" && row.eligible !== true, JSON.stringify(row));
// resolve the student's Brightspace user_id (roster id 2100 for stu100) and confirm the submission
r = await call("/submitted", { ou:"100", qi:"5100", user_ids:["2100"] }, { teacher: A });
check("professor (trusted session) can confirm a submission", r.status === 200, JSON.stringify(r.data));
lv = await call("/live?quiz=100-5100", {}, { teacher: A, get:true });
row = (lv.data?.rows||[]).find(x => x.device_id === DS);
check("once Brightspace confirms the submit -> clean 'done'", row && row.status === "done" && row.submitted === true, JSON.stringify(row));
r = await call("/submitted", { ou:"100", qi:"5100", user_ids:["2100"] }, { teacher: IMP });
check("a professor cannot confirm submissions for a course they do not instruct", r.status === 403, `got ${r.status}`);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
