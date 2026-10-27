// Per-class scope (Anthony 27 Oct): LOCKqz only locks and charges in a class whose own professor signed up
// (active + synced + on). Any other Brightspace quiz -> reason "not_protected" (the app restores AI, no
// charge, no report). Plus: the "not connected" reconnect email fires once per episode, never hourly.
// Real API, in-memory SQLite.
import { withPayT } from "./pay_t.mjs";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-scope-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);

let pass = 0, fail = 0;
const ok = m => { pass++; console.log("  ok:", m); };
const bad = (m, i) => { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); };
const check = (m, c, i = "") => (c ? ok(m) : bad(m, i));
const sign = (key, path, ts, body) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");

function d1real(sqlite) {
  const mk = () => { let args = [], st = null;
    return { _sql(sql){ st = sqlite.prepare(sql); return this; },
      bind(...a){ args = a.map(x => x===undefined?null:typeof x==="boolean"?Number(x):x); this._run=()=>st.run(...args); return this; },
      first: async()=> st.get(...args) ?? null, all: async()=>({results:st.all(...args)}),
      run: async()=>({meta:{changes:Number(st.run(...args).changes)}}) }; };
  return { prepare(sql){ return mk()._sql(sql); }, async batch(sts){ for (const s of sts) s._run(); } };
}

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
import { readdirSync } from "node:fs";
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort()) { try { sqlite.exec(readFileSync(join(CF, m), "utf8")); } catch (e) { if (!/duplicate column|already exists|table .* already/.test(e.message)) throw e; } }
const BASE = "https://lockqz.test", ADMIN = "admin-test-key";
const MAILS = [];
const env = { DB: d1real(sqlite), TEACHER_KEY: ADMIN, REQUIRE_SIGNED: "1", STUDENT_FEE: "5", STUDENT_FEE_FROM: "2000-01-01", PAY_SECRET: "x".repeat(24), FEE_EXEMPT: "free@usc.edu", MAIL_SINK: async m => { MAILS.push(m); return true; } };

async function call(path, body, { key=null, device=null, teacher=null } = {}) {
  body = withPayT(path, body, env);
  const raw = JSON.stringify(body ?? {});
  const h = { "Content-Type": "application/json" };
  if (teacher) h["X-LOCKqz-Teacher"] = teacher;
  if (key) { const ts = String(Math.floor(Date.now()/1000)); h["X-LOCKqz-Device"]=device; h["X-LOCKqz-Time"]=ts; h["X-LOCKqz-Sig"]=sign(key,`/api${path}`,ts,raw); }
  const res = await onRequest({ request: new Request(BASE+"/api"+path, { method:"POST", headers:h, body:raw }), env });
  let data=null; try{ data=await res.json(); }catch{}
  return { status:res.status, data };
}
const qurl = (ou, qi) => `https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${qi}&ou=${ou}`;
// Register a verified, PAID student device bound to `email`, return its key.
async function student(dev, email) {
  const k = randomBytes(32).toString("hex");
  await call("/register", { device_id: dev, key: k, student: email, platform: "mac-15" }, {});
  sqlite.prepare("UPDATE devices SET student_verified=1 WHERE device_id=?").run(dev);
  return k;
}
const paySecret = env.PAY_SECRET;
const payStudent = async (email) => onRequest({ request: new Request(BASE + "/api/pay/notify", { method: "POST", headers: { "Content-Type": "application/json", "X-LOCKqz-Pay": paySecret }, body: JSON.stringify({ payments: [{ txn: "z:" + email, amount: 5, note: email, via: "zelle" }] }) }), env });
async function pw(dev, k, ou, qi) {
  await call("/report", { event: "lock", quiz_id: `${ou}-${qi}`, student: null }, { key: k, device: dev });
  return call("/password", { url: qurl(ou, qi) }, { key: k, device: dev });
}
const addTeacher = (id, email, { verified=1, vouched=1, active_until=null, role=null } = {}) =>
  sqlite.prepare("INSERT INTO teachers (id,email,name,verified,vouched,active_until,role,created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))").run(id, email, email.split("@")[0], verified, vouched, active_until, role);
const synced = (tid, ou) => sqlite.prepare("INSERT INTO teacher_courses (teacher_id,ou,name,code,role,synced_at,in_sync) VALUES (?,?,?,?,?,datetime('now'),1)").run(tid, ou, "Course "+ou, "C"+ou, "Instructor");
const protect = (ou, qi) => sqlite.prepare("INSERT INTO quizzes (quiz_id,title,password,created_at,qi,teacher_id,lock_id,ou,gated) VALUES (?,?,?,datetime('now'),?,?,?,?,0)").run("q"+ou+qi, "Quiz", "LQ-"+ou+qi.padStart(4,"0"), qi, "x", `${ou}-${qi}`, ou);
const future = new Date(Date.now()+365*864e5).toISOString().slice(0,10);

console.log("C1 covered via a protected quiz -> fee path, not 'not_protected'");
protect("1001", "11");
const kA = await student("dev-al01", "al@usc.edu");
let r = await pw("dev-al01", kA, "1001", "11");
check("unpaid student in a protected class -> unpaid (the pay page), NOT not_protected", r.status === 402 && r.data?.reason === "unpaid", JSON.stringify(r.data));
await payStudent("al@usc.edu");
r = await pw("dev-al01", kA, "1001", "11");
check("paid student -> the quiz password", r.data?.password === "LQ-100100" + "11".slice(0,0) || /^LQ-/.test(r.data?.password||""), JSON.stringify(r.data));

console.log("C2 a class with no LOCKqz professor at all -> not_protected (AI restored, nobody charged)");
const kB = await student("dev-bo01", "bo@usc.edu");
r = await pw("dev-bo01", kB, "2002", "22");
check("unpaid student, unknown class -> reason not_protected, no pay page", r.status === 200 && r.data?.reason === "not_protected" && !r.data?.password && !r.data?.pay, JSON.stringify(r.data));
await payStudent("bo@usc.edu");
r = await pw("dev-bo01", kB, "2002", "22");
check("even a PAID student in an unknown class -> not_protected (never locked)", r.data?.reason === "not_protected" && !r.data?.password, JSON.stringify(r.data));

console.log("C3 covered via an ACTIVE synced professor, brand-new quiz (no quizzes row yet) -> fee path, not not_protected");
addTeacher("t3", "prof3@usc.edu", { active_until: future }); synced("t3", "3003");
r = await pw("dev-al01", kA, "3003", "33");   // al is paid
check("active prof's new quiz -> not not_protected (proceeds; nudges/holds)", r.data?.reason !== "not_protected", JSON.stringify(r.data));

console.log("C4 a professor who signed up but is NOT active (never paid) -> not_protected");
addTeacher("t4", "prof4@usc.edu", { active_until: null }); synced("t4", "4004");   // no active_until, not exempt
r = await pw("dev-al01", kA, "4004", "44");
check("unpaid professor's class -> not_protected (students never locked)", r.data?.reason === "not_protected", JSON.stringify(r.data));

console.log("C5 an exempt (trial) professor -> covered");
addTeacher("t5", "free@usc.edu", { active_until: null }); synced("t5", "5005");
r = await pw("dev-al01", kA, "5005", "55");
check("exempt professor's class -> covered (not not_protected)", r.data?.reason !== "not_protected", JSON.stringify(r.data));

console.log("C6 a covered class turned OFF -> not_protected");
protect("6006", "66"); addTeacher("t6", "prof6@usc.edu", { active_until: future }); synced("t6", "6006");
r = await pw("dev-al01", kA, "6006", "66");
check("before turning off: covered", r.data?.reason !== "not_protected", JSON.stringify(r.data));
sqlite.prepare("INSERT INTO course_off (ou,teacher_id,at) VALUES (?,?,datetime('now'))").run("6006", "t6");
r = await pw("dev-al01", kA, "6006", "66");
check("class turned off -> not_protected", r.data?.reason === "not_protected", JSON.stringify(r.data));

console.log("A1 reconnect email: once per episode (not hourly), re-emails only after the gate runs");
// Protected but ungated quiz in a covered class, with REQUIRE_GATE on and a real professor to email.
const envG = { ...env, REQUIRE_GATE: "1" };
const onG = (path, body, hdr) => onRequest({ request: new Request(BASE+"/api"+path, { method:"POST", headers:{ "Content-Type":"application/json", ...hdr }, body: JSON.stringify(body) }), env: envG });
protect("7007", "77"); addTeacher("t7", "prof7@usc.edu", { active_until: future }); synced("t7", "7007");
sqlite.prepare("INSERT INTO bs_quizzes (ou,qi,name,active,start_date,end_date) VALUES (?,?,?,1,?,?)").run("7007","77","Quiz", new Date(Date.now()-3600e3).toISOString(), new Date(Date.now()+3600e3).toISOString());
const kG = await student("dev-gg01", "gg@usc.edu"); await payStudent("gg@usc.edu");
const pwG = async () => { const ts=String(Math.floor(Date.now()/1000)); const raw=JSON.stringify(withPayT("/report",{event:"lock",quiz_id:"7007-77"},envG));
  await onRequest({ request:new Request(BASE+"/api/report",{method:"POST",headers:{"Content-Type":"application/json","X-LOCKqz-Device":"dev-gg01","X-LOCKqz-Time":ts,"X-LOCKqz-Sig":sign(kG,"/api/report",ts,raw)},body:raw}), env:envG });
  const raw2=JSON.stringify(withPayT("/password",{url:qurl("7007","77")},envG)); const ts2=String(Math.floor(Date.now()/1000));
  const res=await onRequest({ request:new Request(BASE+"/api/password",{method:"POST",headers:{"Content-Type":"application/json","X-LOCKqz-Device":"dev-gg01","X-LOCKqz-Time":ts2,"X-LOCKqz-Sig":sign(kG,"/api/password",ts2,raw2)},body:raw2}), env:envG });
  return res.json(); };
MAILS.length = 0;
let g = await pwG();
check("gate off -> no password, reason gate_off", g.reason === "gate_off" && !g.password, JSON.stringify(g));
check("professor emailed once to reconnect", MAILS.filter(m => m.to === "prof7@usc.edu").length === 1, JSON.stringify(MAILS.map(m=>m.to)));
await pwG(); await pwG();
check("more students waiting / more polls -> still only ONE email (not hourly, not per-student)", MAILS.filter(m => m.to === "prof7@usc.edu").length === 1);
// The gate starts (sync.js would mark it gated and /gate clears the nudge): simulate by clearing the nudge row.
sqlite.prepare("DELETE FROM sync_nudges WHERE ou=? AND qi=?").run("7007", "gate:77");
await pwG();
check("after the gate ran and stopped again (a new episode) -> one more email", MAILS.filter(m => m.to === "prof7@usc.edu").length === 2);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
