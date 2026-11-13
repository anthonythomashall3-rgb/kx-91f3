import { withPayT } from "./pay_t.mjs";
// Sweep 24: access the moment the card is charged. LOCKqz asks Stripe about a checkout it started instead of waiting
// for Stripe's notice; the apps ask again every few seconds while unpaid. Real API, in-memory SQLite, Stripe mocked.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-sweep24-"));
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
  body = withPayT(path, body, env);
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



const SECRET = "test-pay-secret-0123456789", WH = "whsec_test_0123456789abcdef";
const sqlite = makeDb(false);
for (const m of ["migrate_017_sections.sql", "migrate_018_submissions.sql", "migrate_019_student_pay.sql", "migrate_022_renewals.sql", "migrate_027_pay_slots.sql", "migrate_033_card_renew.sql"]) { try { sqlite.exec(readFileSync(join(CF, m), "utf8")); } catch (e) { if (!/duplicate column|already exists/.test(e.message)) throw e; } }
const ON = { DB: d1real(sqlite), TEACHER_KEY: ADMIN, REQUIRE_SIGNED: "1", ZELLE_TO: "(858) 900-4347", STUDENT_FEE: "180", STUDENT_FEE_FROM: "2000-01-01", PAY_SECRET: SECRET,
  STUDENT_CARD_PRICE: "200", PROF_CARD_PRICE: "5150", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: WH, STUDENT_AUTORENEW: "0" };
// Stripe mock: sessions made by LOCKqz, each with the state the test gives it; every GET is counted.
const made = new Map(); let gets = 0, n = 0; const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init = {}) => {
  u = String(u);
  if (u === "https://api.stripe.com/v1/checkout/sessions" && init.method === "POST") {
    const f = new URLSearchParams(String(init.body)), id = "cs_" + (++n);
    made.set(id, { id, url: "https://checkout.stripe.com/c/pay/" + id, status: "open", payment_status: "unpaid", mode: "payment", currency: "usd", amount_total: Number(f.get("line_items[0][price_data][unit_amount]")),
      payment_intent: "pi_" + n, payment_method_types: ["card"], metadata: { code: f.get("metadata[code]") }, customer_details: { email: f.get("customer_email") } });
    return new Response(JSON.stringify(made.get(id)), { status: 200 });
  }
  const m = /^https:\/\/api\.stripe\.com\/v1\/checkout\/sessions\/(cs_\d+)(\/expire)?$/.exec(u);
  if (m) { const s = made.get(m[1]); if (!s) return new Response(JSON.stringify({ error: { code: "resource_missing" } }), { status: 404 });
    if (m[2]) { if (s.status === "open") s.status = "expired"; } else gets++;
    return new Response(JSON.stringify(s), { status: 200 }); }
  return realFetch(u, init);
};
const pay = id => Object.assign(made.get(id), { status: "complete", payment_status: "paid" });
const hook = async event => { const ts = Math.floor(Date.now() / 1000), raw = JSON.stringify(event), v1 = createHmac("sha256", WH).update(`${ts}.${raw}`).digest("hex");
  const res = await onRequest({ request: new Request(BASE + "/api/pay/stripe/webhook", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${ts},v1=${v1}` }, body: raw }), env: ON });
  let data = null; try { data = await res.json(); } catch {} return { status: res.status, data }; };
const rows = code => sqlite.prepare("SELECT COUNT(*) AS n FROM payments WHERE code=? AND COALESCE(matched,'')<>'void'").get(code).n;
const wait = ms => new Promise(r => setTimeout(r, ms));
const status = (email, code) => getc(ON, "/pay/status?email=" + encodeURIComponent(email) + "&code=" + code);

await call(ON, "/signup", { email: "admin@usc.edu", password: "adminpass1" });   // first account = admin
sqlite.prepare("INSERT INTO quizzes (quiz_id,title,password,created_at,qi,teacher_id,lock_id,ou) VALUES ('q1','Midterm','LQ-SEEDPW01',datetime('now'),?,'x',?,?)").run(QI, LOCK_ID, OU);

console.log("W1 no card checkout started: Stripe is never asked");
let r = await call(ON, "/pay/start", { email: "al@usc.edu" }); const AL = r.data.code;
r = await status("al@usc.edu", AL);
check("unpaid, and no call to Stripe", r.data?.paid === false && gets === 0, JSON.stringify(r.data) + " gets=" + gets);

console.log("W2 the card is charged, Stripe's notice has not arrived: the pay page shows paid at once");
r = await call(ON, "/pay/stripe", { email: "al@usc.edu", method: "card" });
check("checkout made", r.status === 200 && /cs_1$/.test(r.data?.url || ""), JSON.stringify(r.data));
await wait(2100); gets = 0;
r = await status("al@usc.edu", AL);
check("checkout still open: unpaid, Stripe asked once", r.data?.paid === false && gets === 1, JSON.stringify(r.data) + " gets=" + gets);
r = await status("al@usc.edu", AL);
check("asked again within 2 s: Stripe is not asked a second time", r.data?.paid === false && gets === 1, "gets=" + gets);
pay("cs_1"); await wait(2100);
r = await status("al@usc.edu", AL);
check("paid at Stripe -> /pay/status says paid with no notice from Stripe", r.data?.paid === true, JSON.stringify(r.data));
check("one payment row, $200 by card, txn = the PaymentIntent", rows(AL) === 1 && sqlite.prepare("SELECT amount, via, txn FROM payments WHERE code=?").get(AL).txn === "stripe:pi_1");
gets = 0; r = await call(ON, "/pay/start", { email: "al@usc.edu" });
check("already paid: Stripe is not asked again", r.data?.paid === true && gets === 0, "gets=" + gets);

console.log("W3 Stripe's notice arriving afterwards counts once");
r = await hook({ type: "checkout.session.completed", data: { object: made.get("cs_1") } });
check("notice = duplicate, still one row", r.data?.result?.duplicate === true && rows(AL) === 1, JSON.stringify(r.data));

console.log("W4 back on the pay page (/pay/start) right after paying: paid in the first answer");
r = await call(ON, "/pay/start", { email: "bo@usc.edu", t: null }); const BO = r.data.code;
await call(ON, "/pay/stripe", { email: "bo@usc.edu", method: "card", t: null });
pay("cs_2");
r = await call(ON, "/pay/start", { email: "bo@usc.edu", t: null });
check("typed email, no link: paid at once", r.data?.paid === true && rows(BO) === 1, JSON.stringify(r.data));

console.log("W5 a second click on Pay after the card was charged never opens a second checkout");
r = await call(ON, "/pay/start", { email: "cy@usc.edu" }); const CY = r.data.code;
await call(ON, "/pay/stripe", { email: "cy@usc.edu", method: "card" });
pay("cs_3"); await wait(2100);
r = await call(ON, "/pay/stripe", { email: "cy@usc.edu", method: "card" });
check("409 already paid (paid: true), no new checkout", r.status === 409 && r.data?.paid === true && n === 3, JSON.stringify(r.data) + " n=" + n);

console.log("W6 never credited: another code's checkout, a refunded payment, an old checkout, an unpaid one");
r = await call(ON, "/pay/start", { email: "di@usc.edu" }); const DI = r.data.code;
await call(ON, "/pay/stripe", { email: "di@usc.edu", method: "card" });
pay("cs_4"); made.get("cs_4").metadata.code = AL;
r = await status("di@usc.edu", DI);
check("checkout that names another code: not credited to either", r.data?.paid === false && rows(DI) === 0 && rows(AL) === 1, JSON.stringify(r.data));
made.get("cs_4").metadata.code = DI; made.get("cs_4").payment_status = "unpaid"; await wait(2100);
r = await status("di@usc.edu", DI);
check("complete but not paid: unpaid", r.data?.paid === false && rows(DI) === 0);
made.get("cs_4").payment_status = "paid";
await hook({ type: "charge.refunded", data: { object: { payment_intent: "pi_4", refunded: true, amount: 20000, amount_refunded: 20000 } } });
await wait(2100);
r = await status("di@usc.edu", DI);
check("refunded before LOCKqz saw it: never gives access", r.data?.paid === false && rows(DI) === 0, JSON.stringify(r.data));
r = await call(ON, "/pay/start", { email: "ed@usc.edu" }); const ED = r.data.code;
await call(ON, "/pay/stripe", { email: "ed@usc.edu", method: "card" });
pay("cs_5"); sqlite.prepare("UPDATE events SET ts=? WHERE device_id=? AND event='stripe_sess'").run(new Date(Date.now() - 4 * 3600000).toISOString(), "code:" + ED);
gets = 0; r = await status("ed@usc.edu", ED);
check("a checkout from 4 hours ago: Stripe is not asked", r.data?.paid === false && gets === 0, "gets=" + gets);

console.log("W7 at the exam: unpaid answer paces the app (3 s), and the password follows the card payment with no notice");
const DEV = "mac-s24", K = randomBytes(32).toString("hex");
await call(ON, "/register", { device_id: DEV, key: K, student: "fay@usc.edu", platform: "mac-15", version: "0.6.23" });
sqlite.prepare("UPDATE devices SET student_verified=1 WHERE device_id=?").run(DEV);
await call(ON, "/report", { event: "lock", quiz_id: LOCK_ID, student: "fay@usc.edu" }, { key: K, device: DEV });
const pw = env => call(env, "/password", { url: QUIZ_URL, device_id: DEV }, { key: K, device: DEV });
r = await pw(ON);
check("unpaid: 402, pay block, recheck 3", r.status === 402 && r.data?.reason === "unpaid" && r.data.recheck === 3 && !!r.data.pay?.url, JSON.stringify(r.data));
check("PAY_RECHECK_S sets the pace (clamped 2..60)", (await pw({ ...ON, PAY_RECHECK_S: "5" })).data?.recheck === 5 && (await pw({ ...ON, PAY_RECHECK_S: "0.5" })).data?.recheck === 2 && (await pw({ ...ON, PAY_RECHECK_S: "900" })).data?.recheck === 60);
await call(ON, "/pay/stripe", { email: "fay@usc.edu", method: "card" });
pay("cs_6"); await wait(2100);
r = await pw(ON);
check("card charged -> the next ask gets the quiz password", r.status === 200 && r.data?.password === "LQ-SEEDPW01", JSON.stringify(r.data));
{ const D2 = "mac-s24b", K2 = randomBytes(32).toString("hex");
  await call(ON, "/register", { device_id: D2, key: K2, student: "gil@usc.edu", platform: "mac-15", version: "0.6.23" });
  sqlite.prepare("UPDATE devices SET student_verified=1 WHERE device_id=?").run(D2);
  const vs = () => call(ON, "/verify", { op: "status", device_id: D2 }, { key: K2, device: D2 });
  r = await vs(); check("setup status: unpaid, pay page link", r.data?.paid === false && /\/pay\?email=gil/.test(r.data?.pay_url || ""), JSON.stringify(r.data));
  await call(ON, "/pay/stripe", { email: "gil@usc.edu", method: "card" }); pay("cs_7"); await wait(2100);
  r = await vs(); check("setup status after the card payment: paid, no pay link", r.data?.paid === true && !r.data.pay_url, JSON.stringify(r.data)); }

console.log("W8 professor back from the card checkout: active in the first /me");
r = await call(ON, "/signup", { email: "prof@usc.edu", password: "profpass1", name: "Duke Bristow" }); const PT = r.data.token;
gets = 0; check("not active, Stripe not asked (no checkout)", (await getc(ON, "/me", { teacher: PT })).data?.active === false && gets === 0);
r = await call(ON, "/pay/stripe-prof", { method: "card" }, { teacher: PT });
check("professor checkout made", r.status === 200, JSON.stringify(r.data));
const PS = "cs_" + n; pay(PS); await wait(2100);
r = await getc(ON, "/me", { teacher: PT });
check("active with no notice from Stripe", r.data?.active === true && !!r.data.active_until, JSON.stringify(r.data));
gets = 0; await getc(ON, "/me", { teacher: PT });
check("active professor: Stripe is not asked again", gets === 0);

console.log("W9 Stripe down or slow never breaks a page");
{ r = await call(ON, "/pay/start", { email: "hal@usc.edu" }); const HAL = r.data.code;
  await call(ON, "/pay/stripe", { email: "hal@usc.edu", method: "card" });
  const keep = globalThis.fetch; globalThis.fetch = async () => { throw new Error("network"); }; await wait(2100);
  r = await status("hal@usc.edu", HAL); globalThis.fetch = keep;
  check("Stripe unreachable: the answer is just 'unpaid'", r.status === 200 && r.data?.paid === false, JSON.stringify(r.data)); }

console.log("W12 paid by card, refunded in full, pays again the same day: a new checkout (was: 'already being processed' for a day)");
{ r = await call(ON, "/pay/start", { email: "jo@usc.edu" }); const JO = r.data.code;
  r = await call(ON, "/pay/stripe", { email: "jo@usc.edu", method: "card" }); const first = r.data.url.split("/").pop();
  pay(first); await hook({ type: "checkout.session.completed", data: { object: made.get(first) } });
  check("paid", (await call(ON, "/pay/start", { email: "jo@usc.edu" })).data?.paid === true);
  await hook({ type: "charge.refunded", data: { object: { payment_intent: made.get(first).payment_intent, refunded: true, amount: 20000, amount_refunded: 20000 } } });
  check("refunded: unpaid again", (await call(ON, "/pay/start", { email: "jo@usc.edu" })).data?.paid === false);
  await wait(2100); const before = n;
  r = await call(ON, "/pay/stripe", { email: "jo@usc.edu", method: "card" });
  check("Pay again -> a new checkout, not 'already being processed'", r.status === 200 && n === before + 1 && !r.data.reused, JSON.stringify(r.data));
  gets = 0; await status("jo@usc.edu", JO); await wait(2100); await status("jo@usc.edu", JO);
  check("the refunded checkout is not asked about over and over", gets <= 1, "gets=" + gets);
  r = await call(ON, "/pay/start", { email: "kim@usc.edu" });
  r = await call(ON, "/pay/stripe", { email: "kim@usc.edu", method: "card" }); pay(r.data.url.split("/").pop());
  // paid at Stripe, not recorded yet, and the settle step just asked (2 s rule): the old answer still protects from a double payment
  const b2 = n; r = await call(ON, "/pay/stripe", { email: "kim@usc.edu", method: "card" });
  check("charged a moment ago: never a second checkout", n === b2 && r.status === 409 && (r.data?.paid === true || r.data?.processing === true), JSON.stringify(r.data)); }

console.log("W11 a typed email (no link): the card button says the card renews, because it does");
{ const RN = { ...ON, STUDENT_AUTORENEW: "1" };
  r = await call(RN, "/pay/start", { email: "ivy@usc.edu", t: null });
  check("limited pay page carries the renewal amount", r.data?.limited === true && r.data.card_renew === 200 && !r.data.token, JSON.stringify(r.data));
  let form = null; const keep = globalThis.fetch;
  globalThis.fetch = async (u, init = {}) => { if (String(u) === "https://api.stripe.com/v1/checkout/sessions" && init.method === "POST") form = new URLSearchParams(String(init.body)); return keep(u, init); };
  await call(RN, "/pay/stripe", { email: "ivy@usc.edu", method: "card", t: null }); globalThis.fetch = keep;
  check("its checkout saves the card for renewal", form?.get("metadata[save]") === "1" && form.get("payment_intent_data[setup_future_usage]") === "off_session", String(form));
  const page = readFileSync(join(CF, "public", "pay.html"), "utf8");
  check("the pay page puts 'renews each semester' on the card button whenever the renewal amount is there", /RENEW = d\.card_renew \|\| null/.test(page) && /\(RENEW \? " · renews each semester" : ""\)/.test(page)); }

console.log("W10 the pay page checks fast after the card checkout");
{ const page = readFileSync(join(CF, "public", "pay.html"), "utf8");
  check("back from Stripe: 1.5 s checks for the first 20 s; paying by Zelle / Venmo: 8 s for 10 minutes", /FAST && age < 20000 \? 1500 : PAYING && age < 600000 \? 8000 :/.test(page) && /if \(qs\.get\("stripe"\)\) PAYING = FAST = true/.test(page));
  check("'already paid' from the Pay button -> the paid page", /if \(d\.paid \|\| d\.processing\)/.test(page) && /if \(d\.paid\) return check\(\); schedule\(\);/.test(page)); }

console.log(`\nSweep 24: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
