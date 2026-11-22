// Automatic email to students (owner, 22 Nov 2026): none unless LOCKqz is on for their class (STUDENT_MAIL_ON), and
// none to the classes of a professor on MAIL_HOLD until that professor emails the class himself (Email students).
//   M1 /cron exam reminders: a class that is on gets them; a class turned off and a held class do not.
//   M2 the admin's own Email students releases nothing.  M3 the professor's own Email students (one class, and the
//   set-up step's draft for every class) releases that class.  M4 the pay reminder, M5 card renewals (no charge
//   and so no email), M6 renewal emails: only for a student of a class that is on.  M7 settings off: as before.
//   M8 the admin's clock note is judged as of its reading.  M9 the production lines in wrangler.toml.
// Real API, in-memory SQLite (schema.sql + every migration), email and Stripe mocked, clock moved by hand.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-mailon-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch { /* already in schema.sql */ } }
const DB = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
  const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
    first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
    run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { return st.run(...args); } }; return o; },
  async batch(sts) { const out = []; for (const s of sts) out.push({ meta: { changes: Number(s._run().changes) } }); return out; } };
const mails = [], SECRET = "pay-secret-mailon-0123456789";
const env0 = { DB, TEACHER_KEY: "tk-mo", REQUIRE_SIGNED: "1", ROT_SECRET: "rs-mo", PW_PEPPER: "pep-mo", LIVE_CACHE_MS: "0", PAID_CACHE_MS: "0",
  PAY_SECRET: SECRET, MAIL_SINK: async m => { mails.push(m); return true; }, ADMIN_EMAIL: "admin@usc.edu", REQUIRE_GATE: "0", EXAM_REMIND_3H: "0",
  STUDENT_FEE: "180", STUDENT_FEE_FROM: "2026-10-25", STUDENT_TOTAL: "200", STUDENT_OTHER_TOTAL: "210", STUDENT_OTHER_PRICE: "210", STUDENT_CARD_PRICE: "210",
  ZELLE_TO: "(858) 900-4347", STRIPE_SECRET_KEY: "sk_test_mailon", STRIPE_WEBHOOK_SECRET: "whsec_mailon", PAY_NUDGE_HOURS: "2" };
const env = { ...env0, STUDENT_MAIL_ON: "1", MAIL_HOLD: "held@usc.edu, Held@Marshall.usc.edu" };

// The clock: Date.now() AND new Date() follow at() / later() (the API stamps rows with new Date()).
const RealDate = Date; let fakeNow = RealDate.parse("2026-11-23T18:00:00Z");
class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fakeNow); } static now() { return fakeNow; } }
globalThis.Date = FakeDate;
const at = iso => { fakeNow = RealDate.parse(iso); }, later = min => { fakeNow += min * 60000; };
// Stripe: every off-session charge succeeds.
const intents = [];
globalThis.fetch = async (u, init = {}) => { u = String(u);
  if (u === "https://api.stripe.com/v1/payment_intents" && init.method === "POST") {
    const f = new URLSearchParams(String(init.body)), id = "pi_mo" + (intents.length + 1); intents.push({ customer: f.get("customer") });
    return new Response(JSON.stringify({ id, status: "succeeded", amount: Number(f.get("amount")), amount_received: Number(f.get("amount")),
      metadata: Object.fromEntries([...f].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])) }), { status: 200 }); }
  if (u.startsWith("https://api.stripe.com/")) return new Response("{}", { status: 200 });
  throw new Error("unexpected fetch " + u); };

async function call(path, body, { token = null, e = env, hdr = {} } = {}) {
  const h = { "Content-Type": "application/json", "CF-Connecting-IP": "10.9.0.1", ...hdr };
  if (token) h["X-LOCKqz-Teacher"] = token;
  const res = await onRequest({ request: new Request("https://lockqz.test/api" + path, body === undefined ? { method: "GET", headers: h } : { method: "POST", headers: h, body: JSON.stringify(body) }), env: e, waitUntil: () => {} });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const cron = (e = env) => call("/cron", {}, { e, hdr: { "X-LOCKqz-Pay": SECRET } });
const tick = (e = env) => call("/pay/tick", {}, { e, hdr: { "X-LOCKqz-Pay": SECRET } });
const rc = m => [].concat(m.to || []).map(String);
const got = e => mails.filter(m => rc(m).includes(e));
const iso = () => new Date().toISOString();

try {
  // The admin (synced the held professor's classes as their TA, as with Professor Bristow's), a professor who is on,
  // and the held professor (signed up, never synced).
  const ADMIN = (await call("/signup", { email: "admin@usc.edu", password: "adminpass1", name: "Anthony Hall" })).data?.token;
  const PROF = (await call("/signup", { email: "prof@usc.edu", password: "profpass12", name: "Pat Professor" })).data?.token;
  const HELD = (await call("/signup", { email: "held@usc.edu", password: "heldpass12", name: "Held Professor" })).data?.token;
  check("three accounts", !!(ADMIN && PROF && HELD));
  sqlite.prepare("UPDATE teachers SET verified=1, vouched=1, bs_user_id='4000', active_until='2099-12-31' WHERE email='prof@usc.edu'").run();
  sqlite.prepare("UPDATE teachers SET verified=1, vouched=1, bs_user_id='7000', active_until='2099-12-31' WHERE email='held@usc.edu'").run();
  const id = e => sqlite.prepare("SELECT id FROM teachers WHERE email=?").get(e).id, PID = id("prof@usc.edu"), AID = id("admin@usc.edu");
  const A = "91001", B = "91002", C = "91003", C2 = "91005";
  const tc = sqlite.prepare("INSERT INTO teacher_courses (teacher_id,ou,name,code,role,synced_at,in_sync) VALUES (?,?,?,?,?,?,1)");
  tc.run(PID, A, "20263_10001 FIN-101: Class A", "20263_10001", "Instructor", iso());
  tc.run(PID, B, "20263_10002 FIN-102: Class B", "20263_10002", "Instructor", iso());
  tc.run(AID, C, "20263_10003 FBE-437: Held C", "20263_10003", "TA", iso());
  tc.run(AID, C2, "20263_10005 FBE-527: Held C2", "20263_10005", "TA", iso());
  const ros = sqlite.prepare("INSERT INTO roster (ou,user_id,name,email,username,org_id,role,synced_at) VALUES (?,?,?,?,?,?,?,?)");
  for (const ou of [A, B]) ros.run(ou, "4000", "Professor, Pat", "prof@usc.edu", "pat", "1", "Instructor", iso());
  for (const ou of [C, C2]) ros.run(ou, "7000", "Professor, Held", "held@usc.edu", "held", "1", "Instructor", iso());
  let uid = 5000; const stu = (ou, e) => ros.run(ou, String(uid++), e.split("@")[0], e, e.split("@")[0], "1", "Student", iso());
  for (const e of ["s1@usc.edu", "s2@usc.edu", "r1@usc.edu", "c1@usc.edu"]) stu(A, e);
  for (const e of ["s3@usc.edu", "r3@usc.edu", "c3@usc.edu"]) stu(B, e);
  stu(C, "s4@usc.edu"); stu(C2, "s5@usc.edu");
  sqlite.prepare("INSERT INTO course_off (ou,teacher_id,at) VALUES (?,?,?)").run(B, PID, iso());   // class B: LOCKqz off
  // One protected exam per class, 30 hours away.
  const qz = sqlite.prepare("INSERT INTO quizzes (quiz_id,title,password,created_at,qi,teacher_id,ou) VALUES (?,?,?,?,?,?,?)");
  const bq = sqlite.prepare("INSERT INTO bs_quizzes (ou,qi,name,active,start_date,end_date,synced_at) VALUES (?,?,?,?,?,?,?)");
  for (const [ou, qi] of [[A, "801"], [B, "802"], [C, "803"], [C2, "805"]]) {
    qz.run(`bs-${ou}-${qi}`, "Midterm", "pw" + qi, iso(), qi, ou === A || ou === B ? PID : AID, ou);
    bq.run(ou, qi, "Midterm", 1, "2026-11-25T00:00:00.000Z", "2026-11-25T02:00:00.000Z", iso());
  }

  console.log("M1 /cron: exam reminders only for a class LOCKqz is on for, never for a held professor's class");
  let r = await cron();
  check("class A (on): its 4 students get the reminder", ["s1@usc.edu", "s2@usc.edu", "r1@usc.edu", "c1@usc.edu"].every(e => got(e).length === 1), JSON.stringify(r.data));
  check("class B (turned off): nothing", !got("s3@usc.edu").length);
  check("held classes C and C2: nothing", !got("s4@usc.edu").length && !got("s5@usc.edu").length, JSON.stringify(mails.map(m => [rc(m), m.subject])));

  console.log("M2 the admin's own Email students releases nothing");
  r = await call("/email/students", { ou: C, kind: "all" }, { token: ADMIN });
  check("the admin gets the draft", r.status === 200 && (r.data?.to || []).includes("s4@usc.edu"), JSON.stringify(r.data).slice(0, 200));
  check("no release mark for the admin's draft", !sqlite.prepare("SELECT 1 FROM mail_sent WHERE ou=? AND kind='prof'").get(C));
  later(15); await cron();
  check("C's student still gets nothing", !got("s4@usc.edu").length);

  console.log("M3 the professor emails his class himself: that class's automatic emails start");
  r = await call("/email/students", { ou: C, kind: "all" }, { token: HELD });
  check("the held professor gets his draft", r.status === 200 && (r.data?.to || []).includes("s4@usc.edu"), JSON.stringify(r.data).slice(0, 200));
  later(15); await cron();
  check("C's student gets the reminder after that", got("s4@usc.edu").length === 1, JSON.stringify(mails.slice(-3).map(m => [rc(m), m.subject])));
  check("C2, not emailed yet: still nothing", !got("s5@usc.edu").length);
  r = await call("/email/students", { ous: [C2], kind: "all" }, { token: HELD });
  check("set-up step: one draft for his classes", r.status === 200 && (r.data?.to || []).includes("s5@usc.edu"), JSON.stringify(r.data).slice(0, 200));
  later(15); await cron();
  check("C2's student gets the reminder after the set-up email", got("s5@usc.edu").length === 1);
  check("class A is not reminded twice", got("s1@usc.edu").length === 1);

  console.log("M4 the pay reminder: only to a student of a class LOCKqz is on for");
  const dev = (d, e) => sqlite.prepare("INSERT INTO devices (device_id,student,platform,installed_at,student_verified,revoked) VALUES (?,?,?,?,1,0)").run(d, e, "windows", "2026-11-23T16:00:00Z");
  dev("d-s2", "s2@usc.edu"); dev("d-s3", "s3@usc.edu");
  r = await tick();
  check("s2 (class A) gets 'One step left'", got("s2@usc.edu").some(m => m.subject === "One step left: pay for LOCKqz"), JSON.stringify(r.data));
  check("s3 (only in a class that is off) gets nothing", !got("s3@usc.edu").length, JSON.stringify(r.data));

  console.log("M5 card renewals: no charge, and so no email, for a student LOCKqz is not on for");
  at("2027-01-05T20:00:00Z");
  const pc = sqlite.prepare("INSERT INTO pay_codes_students (email,code) VALUES (?,?)");
  const cr = sqlite.prepare("INSERT INTO card_renew (email,customer,pm,brand,last4,autorenew,created_at,updated_at,rterm,state,charge_on,amount,tries) VALUES (?,?,?,'visa',?,1,?,?,'20271','reminded','2026-11-30',21000,0)");
  pc.run("c1@usc.edu", "LQSC1"); cr.run("c1@usc.edu", "cus_c1", "pm_c1", "4242", iso(), iso());
  pc.run("c3@usc.edu", "LQSC3"); cr.run("c3@usc.edu", "cus_c3", "pm_c3", "4343", iso(), iso());
  r = await tick();
  check("c1 (class A) is charged and told", intents.some(x => x.customer === "cus_c1") && got("c1@usc.edu").some(m => /^LOCKqz renewed for Spring 2027/.test(m.subject)), JSON.stringify(r.data));
  check("c3 (only in a class that is off): no charge, no email", !intents.some(x => x.customer === "cus_c3") && !got("c3@usc.edu").length, JSON.stringify(r.data));
  sqlite.prepare("DELETE FROM course_off WHERE ou=?").run(B);
  r = await tick();
  check("class B turned on: c3's renewal goes through", intents.some(x => x.customer === "cus_c3") && got("c3@usc.edu").some(m => /^LOCKqz renewed/.test(m.subject)), JSON.stringify(r.data));
  sqlite.prepare("INSERT INTO course_off (ou,teacher_id,at) VALUES (?,?,?)").run(B, PID, iso());

  console.log("M6 renewal emails: only to a student of a class LOCKqz is on for");
  const pay = sqlite.prepare("INSERT INTO payments (txn,code,amount,via,term,received_at) VALUES (?,?,?,?,?,?)");
  for (const [e, code] of [["r1@usc.edu", "LQSR1"], ["r3@usc.edu", "LQSR3"], ["r9@usc.edu", "LQSR9"]]) { pc.run(e, code); pay.run("t-" + code, code, 200, "zelle", "20263", "2026-11-01T18:00:00Z"); }
  r = await tick();
  check("r1 (class A) gets 'Renew LOCKqz'", got("r1@usc.edu").some(m => m.subject === "Renew LOCKqz"), JSON.stringify(r.data));
  check("r3 (only in a class that is off) and r9 (on no class list) get nothing", !got("r3@usc.edu").length && !got("r9@usc.edu").length, JSON.stringify(r.data));

  console.log("M7 both settings off: as before");
  r = await tick(env0);
  check("r3 and r9 get their renewal email", got("r3@usc.edu").length === 1 && got("r9@usc.edu").length === 1, JSON.stringify(r.data));

  console.log("M8 the admin's clock note is judged as of its reading");
  const me = (await call("/me", undefined, { token: ADMIN })).data;
  check("/me (admin) carries the server's time with the clock", me?.clock?.now === new Date().toISOString() && !!me?.clock?.cron, JSON.stringify(me?.clock));
  const dash = readFileSync(join(CF, "public", "dashboard.html"), "utf8");
  const CLOCK = new Function(dash.slice(dash.indexOf("const CLOCK = c =>"), dash.indexOf("const CLOCK_FIX")) + "; return CLOCK;")();
  const t = m => new RealDate(m).toISOString(), readAt = RealDate.now() - 3 * 3600000;
  check("read 3 h ago, 2 min after the clock ran: not stopped", !CLOCK({ cron: t(readAt - 120000), tick: t(readAt - 600000), now: t(readAt) }).stale);
  check("read when the clock had not run for 40 min: stopped", CLOCK({ cron: t(readAt - 40 * 60000), tick: t(readAt - 600000), now: t(readAt) }).stale);
  check("the 15-minute refresh reads /me again for the admin", /get\("\/bs"\), ME\.verified && !ME\.admin \? \{\} : get\("\/me"\)/.test(dash));

  console.log("M9 production (wrangler.toml)");
  const toml = readFileSync(join(CF, "wrangler.toml"), "utf8"), hold = ((toml.match(/^MAIL_HOLD = "([^"]*)"$/m) || [])[1] || "").split(",").map(x => x.trim());
  check('STUDENT_MAIL_ON = "1"', /^STUDENT_MAIL_ON = "1"$/m.test(toml));
  check("MAIL_HOLD holds Professor Bristow's two addresses", hold.includes("dbristow@usc.edu") && hold.includes("dbristow@marshall.usc.edu"), hold.join());
} catch (e) { fail++; console.log("  FAIL: threw", e && e.stack || e); }
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
