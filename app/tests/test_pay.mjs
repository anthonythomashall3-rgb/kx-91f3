// Student fee ($5/semester) + automatic Venmo/Zelle matching + professor auto-activation. Real API, in-memory SQLite.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-pay-"));
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

const SECRET = "test-pay-secret-0123456789";
const sqlite = makeDb(false);
for (const m of ["migrate_017_sections.sql", "migrate_018_submissions.sql", "migrate_019_student_pay.sql"]) { try { sqlite.exec(readFileSync(join(CF, m), "utf8")); } catch (e) { if (!/duplicate column|already exists/.test(e.message)) throw e; } }
const base = { DB: d1real(sqlite), TEACHER_KEY: ADMIN, REQUIRE_SIGNED: "1", VENMO_HANDLE: "@Anthony-Hall-417", ZELLE_TO: "(858) 900-4347", PAY_SECRET: SECRET };
const ON = { ...base, STUDENT_FEE_FROM: "2000-01-01" }, OFF = base;
const ADMIN_TOK = (await call(ON, "/signup", { email: "admin@usc.edu", password: "adminpass1" })).data.token;
sqlite.prepare("INSERT INTO quizzes (quiz_id,title,password,created_at,qi,teacher_id,lock_id,ou) VALUES ('q1','Midterm','LQ-SEEDPW01',datetime('now'),?,'x',?,?)").run(QI, LOCK_ID, OU);
const DEV = "mac-pay-1", K = randomBytes(32).toString("hex");
await call(ON, "/register", { device_id: DEV, key: K, student: "al@usc.edu", platform: "mac-15" });
const lock = () => call(ON, "/report", { event: "lock", quiz_id: LOCK_ID, student: "al@usc.edu" }, { key: K, device: DEV });
const pw = env => call(env, "/password", { url: QUIZ_URL, device_id: DEV }, { key: K, device: DEV });
const notify = (payments, secret = SECRET) => onRequest({ request: new Request(BASE + "/api/pay/notify", { method: "POST", headers: { "Content-Type": "application/json", "X-LOCKqz-Pay": secret }, body: JSON.stringify({ payments }) }), env: ON }).then(async r => ({ status: r.status, data: await r.json() }));

console.log("P1 fee switched off: nothing changes");
await lock();
let r = await pw(OFF);
check("fee off: password released", r.status === 200 && r.data?.password === "LQ-SEEDPW01", JSON.stringify(r.data));

console.log("P2 fee on, unpaid: no password, payment info instead");
r = await pw(ON);
check("unpaid: 402", r.status === 402, `got ${r.status}`);
check("pay info: $5, Venmo, Zelle, LQS code, pay page", r.data?.pay?.amount === 5 && r.data.pay.venmo === "Anthony-Hall-417" && r.data.pay.zelle === "(858) 900-4347" && /^LQS[A-Z0-9]{5}$/.test(r.data.pay.code||"") && r.data.pay.url === "https://lockqz.pages.dev/pay?email=al%40usc.edu", JSON.stringify(r.data));
const CODE = r.data.pay.code;
r = await call(ON, "/pay/start", { email: "AL@usc.edu" });
check("pay page gives the same code", r.data?.code === CODE && r.data.paid === false && r.data.required === true, JSON.stringify(r.data));

console.log("P3 only the Gmail script (secret) can report payments");
r = await notify([{ txn: "gmail:x1", amount: 5, note: CODE }], "wrong-secret-wrong-secret");
check("wrong secret refused", r.status === 401);
r = await notify([{ txn: "gmail:x1", amount: 5, note: CODE }], "");
check("no secret refused", r.status === 401);

console.log("P4 a $3 + $2 payment adds up; duplicates ignored");
r = await notify([{ txn: "gmail:a1", amount: 3, note: "lockqz " + CODE.toLowerCase(), via: "venmo", payer: "Al" }]);
check("first $3 matched, not yet paid", r.data?.results?.[0]?.matched === "student" && r.data.results[0].paid === false, JSON.stringify(r.data));
r = await notify([{ txn: "gmail:a1", amount: 3, note: CODE }]);
check("same alert again ignored", r.data?.results?.[0]?.duplicate === true);
check("still unpaid after duplicate", (await pw(ON)).status === 402);
r = await notify([{ txn: "gmail:a2", amount: 2, note: "", subject: "Al paid you $2.00 " + CODE, via: "venmo" }]);
check("second $2 (code in subject) completes $5", r.data?.results?.[0]?.paid === true, JSON.stringify(r.data));
await lock();
r = await pw(ON);
check("paid: password released", r.status === 200 && r.data?.password === "LQ-SEEDPW01", JSON.stringify(r.data));
check("pay status says paid", (await getc(ON, "/pay/status?email=al%40usc.edu")).data?.paid === true);

console.log("P5 a payment with the school email in the memo also matches");
r = await notify([{ txn: "gmail:b1", amount: 5, note: "for bo@usc.edu thanks", via: "zelle" }]);
check("email memo matched", r.data?.results?.[0]?.matched === "student" && r.data.results[0].email === "bo@usc.edu" && r.data.results[0].paid === true, JSON.stringify(r.data));

console.log("P6 unmatched payment -> admin list -> assign");
r = await notify([{ txn: "gmail:c1", amount: 5, note: "lockqz", payer: "Cy Student", via: "zelle" }]);
check("no code: unmatched", r.data?.results?.[0]?.matched === null, JSON.stringify(r.data));
r = await getc(ON, "/payments", { teacher: ADMIN_TOK });
check("admin sees unmatched payment", (r.data?.payments||[]).some(x => x.txn === "gmail:c1" && !x.code), JSON.stringify(r.data));
r = await call(ON, "/pay-assign", { txn: "gmail:c1", code: "cy@usc.edu" }, { teacher: ADMIN_TOK });
check("admin assigns it to cy@usc.edu", r.data?.paid === true && r.data.email === "cy@usc.edu", JSON.stringify(r.data));
r = await getc(ON, "/payments");
check("payments list is admin-only", r.status === 403);

console.log("P7 professor pays $5,000 (two Zelle payments) -> account turns on by itself");
r = await call(ON, "/signup", { email: "prof@usc.edu", password: "profpass1", name: "Duke Bristow" });
const PT = r.data.token;
const memo = (await getc(ON, "/my-sections", { teacher: PT })).data?.memo;
check("professor memo code", /^LQ[A-Z0-9]{5}$/.test(memo||""), memo);
await notify([{ txn: "gmail:p1", amount: 2500, note: memo, via: "zelle" }]);
check("half paid: not active", (await getc(ON, "/me", { teacher: PT })).data?.active === false);
r = await notify([{ txn: "gmail:p2", amount: 2500, note: memo, via: "zelle" }]);
check("full $5,000: matched as professor + paid", r.data?.results?.[0]?.matched === "professor" && r.data.results[0].paid === true, JSON.stringify(r.data));
check("professor account active", (await getc(ON, "/me", { teacher: PT })).data?.active === true);

console.log("P8 junk is refused");
r = await notify([{ txn: "", amount: 5, note: CODE }, { txn: "gmail:z", amount: -5, note: CODE }, { txn: "gmail:z2", amount: "abc", note: CODE }]);
check("bad payments rejected", (r.data?.results||[]).every(x => x.ok === false), JSON.stringify(r.data));

console.log("P9 no PAY_SECRET set: the admin page shows a derived script key that works");
{ const env2 = { ...ON, PAY_SECRET: undefined, ROT_SECRET: "rot-secret-for-test-1234567890" };
  const k = (await getc(env2, "/payments", { teacher: ADMIN_TOK })).data?.script_key;
  check("derived key shown to admin", /^lqp_[0-9a-f]{40}$/.test(k||""), k);
  const rr = await onRequest({ request: new Request(BASE + "/api/pay/notify", { method: "POST", headers: { "Content-Type": "application/json", "X-LOCKqz-Pay": k }, body: JSON.stringify({ payments: [{ txn: "gmail:k1", amount: 5, note: "dd@usc.edu" }] }) }), env: env2 });
  check("derived key accepted by /pay/notify", rr.status === 200); }
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
