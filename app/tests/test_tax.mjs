import { withPayT } from "./pay_t.mjs";
// Income tax on top (25%): every price = base / 0.75, shown as its own line; payments credited by how they came. Real API, in-memory SQLite.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-stripe-"));
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
for (const m of ["migrate_017_sections.sql", "migrate_018_submissions.sql", "migrate_019_student_pay.sql", "migrate_022_renewals.sql", "migrate_027_pay_slots.sql"]) { try { sqlite.exec(readFileSync(join(CF, m), "utf8")); } catch (e) { if (!/duplicate column|already exists/.test(e.message)) throw e; } }
const mails = [];
const ON = { DB: d1real(sqlite), TEACHER_KEY: ADMIN, REQUIRE_SIGNED: "1", ZELLE_TO: "(858) 900-4347", INVOICE_EMAIL: "lockqz.app@gmail.com", ADMIN_EMAIL: "admin@usc.edu",
  STUDENT_FEE: "180", STUDENT_FEE_FROM: "2000-01-01", PAY_SECRET: SECRET, STUDENT_VENMO: "1", VENMO_HANDLE: "LOCKqz",
  STUDENT_CARD_PRICE: "200", STUDENT_BANK_PRICE: "181.45", PROF_CARD_PRICE: "5150", PROF_BANK_PRICE: "5005", STRIPE_BANK: "0",
  STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: WH, TAX_RATE: "0.25", STUDENT_TOTAL: "240", STUDENT_OTHER_TOTAL: "270", PROF_TOTAL: "6500", PROF_CARD_TOTAL: "6700", TAX_FROM: "2000-01-02T00:00:00Z", STUDENT_OTHER_PRICE: "200", PROF_OTHER_PRICE: "5000",
  BANK_DETAILS: "Bank: Test Bank\nRouting: 000000000\nAccount: 1234", MAIL_SINK: m => { mails.push(m); return true; } };
const sessions = []; const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  if (String(u).startsWith("https://api.stripe.com/v1/checkout/sessions")) { const f = new URLSearchParams(String(init.body)); sessions.push(f);
    return new Response(JSON.stringify({ id: "cs_" + sessions.length, url: "https://checkout.stripe.com/c/pay/cs_" + sessions.length }), { status: 200 }); }
  return realFetch(u, init);
};
const hook = async event => { const ts = Math.floor(Date.now()/1000), raw = JSON.stringify(event), v1 = createHmac("sha256", WH).update(`${ts}.${raw}`).digest("hex");
  const res = await onRequest({ request: new Request(BASE + "/api/pay/stripe/webhook", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${ts},v1=${v1}` }, body: raw }), env: ON }); return res.json(); };
const notify = payments => onRequest({ request: new Request(BASE + "/api/pay/notify", { method: "POST", headers: { "Content-Type": "application/json", "X-LOCKqz-Pay": SECRET }, body: JSON.stringify({ payments }) }), env: ON }).then(r => r.json());
const start = async email => (await call(ON, "/pay/start", { email })).data;

await call(ON, "/signup", { email: "admin@usc.edu", password: "adminpass1" });

console.log("T1 student prices: Zelle/bank $180 + 25% income tax = $240; Venmo/card/PO $200 + tax = $266.67");
let d = await start("al@usc.edu");
check("base shown first is $180", d.amount === 180, d.amount);
check("tax block: Tax & fees 25%", d.tax?.rate === 0.25 && d.tax.label === "Tax & fees", JSON.stringify(d.tax));
check("Zelle $240 = 180 + 60 tax & fees", d.ways.zelle.base === 180 && d.ways.zelle.tax === 60 && d.ways.zelle.total === 240, JSON.stringify(d.ways.zelle));
check("bank transfer = Zelle price", d.ways.bank.total === 240, JSON.stringify(d.ways.bank));
check("Venmo $270", d.ways.venmo.base === 202.5 && d.ways.venmo.tax === 67.5 && d.ways.venmo.total === 270, JSON.stringify(d.ways.venmo));
check("PO and card $270", d.ways.po.total === 270 && d.ways.card.total === 270 && d.stripe.card === 270, JSON.stringify([d.ways.po, d.ways.card, d.stripe]));
check("Venmo on for students", d.venmo === "LOCKqz");
check("you keep the base after 25%: 240*0.75=180, 266.67*0.75>=200", 240 * 0.75 === 180 && 270 * 0.75 >= 200);

console.log("T2 a Zelle of $180 (old price) is not enough any more; $240 is");
let r = await notify([{ txn: "zelle:al1", amount: 180, note: d.code, via: "zelle" }]);
check("$180 Zelle -> not paid yet", r.results[0].matched === "student" && r.results[0].paid === false, JSON.stringify(r));
d = await start("al@usc.edu");
check("$60 left by Zelle, $67.50 by Venmo", d.paid === false && d.ways.zelle.total === 60 && d.ways.venmo.total === 67.5, JSON.stringify(d.ways));
check("money received shown as $180", d.money === 180, d.money);
r = await notify([{ txn: "zelle:al2", amount: 60, note: d.code, via: "zelle" }]);
check("+$60 -> paid", r.results[0].paid === true && (await start("al@usc.edu")).paid === true, JSON.stringify(r));

console.log("T3 Venmo $266.67 pays; Venmo $240 does not");
let b = await start("bo@usc.edu");
r = await notify([{ txn: "venmo:bo1", amount: 240, note: b.code, via: "venmo" }]);
check("Venmo $240 -> not paid", r.results[0].paid === false, JSON.stringify(r));
let c = await start("cy@usc.edu");
r = await notify([{ txn: "venmo:cy1", amount: 270, note: c.code, via: "venmo" }]);
check("Venmo $266.67 -> paid", r.results[0].paid === true && (await start("cy@usc.edu")).paid === true, JSON.stringify(r));

console.log("T4 bank transfer deposit with memo counts like Zelle ($240)");
let e = await start("ed@usc.edu");
r = await notify([{ txn: "gmail:ed1", amount: 240, note: e.code, via: "bank" }]);
check("bank $240 -> paid", r.results[0].paid === true, JSON.stringify(r));

console.log("T5 card: Stripe charges $266.67; the webhook's $266.67 pays");
let f = await start("fi@usc.edu");
r = await call(ON, "/pay/stripe", { email: "fi@usc.edu", method: "card" });
check("Checkout amount 26667 cents", sessions.at(-1).get("line_items[0][price_data][unit_amount]") === "27000", sessions.at(-1).toString());
r = await hook({ type: "checkout.session.completed", data: { object: { id: "cs_fi", mode: "payment", currency: "usd", payment_status: "paid", amount_total: 27000, payment_intent: "pi_fi", payment_method_types: ["card"], metadata: { code: f.code } } } });
check("card paid", r.result?.paid === true && (await start("fi@usc.edu")).paid === true, JSON.stringify(r));

console.log("T6 payments made before TAX_FROM keep counting 1:1");
let g = await start("gu@usc.edu");
sqlite.prepare("INSERT INTO payments (txn,code,amount,via,payer,note,term,received_at,matched) VALUES (?,?,?,?,?,?,?,?,NULL)").run("zelle:old", g.code, 180, "zelle", "", g.code, g.term, "2000-01-01T12:00:00Z");
check("old $180 Zelle still = paid", (await start("gu@usc.edu")).paid === true);

console.log("T7 bank details emailed automatically (pay page button / Gmail script)");
mails.length = 0;
r = await call(ON, "/pay/bank", { email: "hu@usc.edu" });
check("sent", r.status === 200 && r.data.sent === true && r.data.amount === 240, JSON.stringify(r.data));
const m0 = mails.find(m => m.to === "hu@usc.edu");
check("email: amount with tax line, memo, bank details", m0 && /Amount: \$240\.00/.test(m0.text) && /tax & fees 25% \$60\.00/.test(m0.text) && /Memo \/ reference: LQS/.test(m0.text) && /Routing: 000000000/.test(m0.text), m0 && m0.text);
r = await call(ON, "/pay/bank", { email: "hu@usc.edu" });
check("second ask within 10 min: no second email", r.data.again === true && mails.filter(m => m.to === "hu@usc.edu").length === 1);
r = await onRequest({ request: new Request(BASE + "/api/pay/bank", { method: "POST", headers: { "Content-Type": "application/json", "X-LOCKqz-Pay": SECRET }, body: JSON.stringify({ email: "iv@gmail.com" }) }), env: ON }).then(x => x.json());
check("Gmail script asks for a sender: sent", r.sent === true && mails.some(m => m.to === "iv@gmail.com"), JSON.stringify(r));
r = await call(ON, "/pay/bank", { email: "al@usc.edu" });
check("already paid: no email", r.data.paid === true && !mails.some(m => m.to === "al@usc.edu"), JSON.stringify(r.data));
{ const NOB = { ...ON }; delete NOB.BANK_DETAILS; mails.length = 0;
  r = await call(NOB, "/pay/bank", { email: "jo@usc.edu" });
  check("no BANK_DETAILS: payer told details follow + admin emailed", r.data.sent === true && /follow in a separate email/.test(mails.find(m => m.to === "jo@usc.edu")?.text || "") && mails.some(m => m.to === "admin@usc.edu" && /jo@usc\.edu/.test(m.subject)), JSON.stringify(mails.map(m => m.to))); }

console.log("T8 professors: $5,000 + tax = $6,666.67 by Zelle/bank");
r = await call(ON, "/signup", { email: "prof@usc.edu", password: "profpass1", name: "Pat Doe" });
const PT = r.data.token;
let ms = (await getc(ON, "/my-sections", { teacher: PT })).data;
check("professor $6,500", ms.ways?.zelle.total === 6500 && ms.ways.zelle.base === 4875 && ms.ways.zelle.tax === 1625, JSON.stringify(ms.ways?.zelle));
check("professor card $6,700", ms.ways.card.total === 6700 && ms.stripe.card === 6700, JSON.stringify([ms.ways.card, ms.stripe]));
check("professor Venmo $6,500 (Venmo offered)", ms.ways.venmo.total === 6500, JSON.stringify(ms.ways.venmo));
{ const r2 = await call(ON, "/signup", { email: "prof2@usc.edu", password: "profpass2", name: "Sam Roe" }); const T2 = r2.data.token;
  const m2 = (await getc(ON, "/my-sections", { teacher: T2 })).data;
  const rv = await notify([{ txn: "venmo:p2", amount: 6500, note: m2.memo, via: "venmo" }]);
  check("$6,500 by Venmo -> professor active (pays exactly $6,500)", rv.results[0].paid === true && (await getc(ON, "/me", { teacher: T2 })).data.active === true, JSON.stringify(rv)); }
r = await notify([{ txn: "zelle:p1", amount: 5000, note: ms.memo, via: "zelle" }]);
check("$5,000 Zelle -> not active yet", r.results[0].paid === false && (await getc(ON, "/me", { teacher: PT })).data.active === false, JSON.stringify(r));
r = await notify([{ txn: "zelle:p2", amount: 1500, note: ms.memo, via: "zelle" }]);
check("+$1,500 -> active", r.results[0].paid === true && (await getc(ON, "/me", { teacher: PT })).data.active === true, JSON.stringify(r));

console.log("T9 pages");
const ph = readFileSync(join(CF, "public", "pay.html"), "utf8"), dh = readFileSync(join(CF, "public", "dashboard.html"), "utf8");
check("pay page: Card, then Venmo, then Zelle (owner 29 Oct), bank + PO after", ph.indexOf('id="card"') > 0 && ph.indexOf('id="card"') < ph.indexOf('id="venmo"') && ph.indexOf('id="venmo"') < ph.indexOf('id="zelle"') && ["id=\"bank\"", "id=\"po\""].every(x => ph.indexOf(x) > ph.indexOf('id="zelle"')));
check("pay page: tax line shown when a way is picked", /taxline/.test(ph) && /\/pay\/bank/.test(ph));
check("dashboard: tax breakdown + bank details button + tour", /PT\.label/.test(dh) && /\/pay\/bank/.test(dh) && /lqTour|startTour/.test(dh));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
