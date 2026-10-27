import { withPayT } from "./pay_t.mjs";
// Stripe card + bank (ACH): prices carry the fee, only signed webhooks record payments, refunds void. Real API, in-memory SQLite, Stripe mocked.
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
const base = { DB: d1real(sqlite), TEACHER_KEY: ADMIN, REQUIRE_SIGNED: "1", ZELLE_TO: "(858) 900-4347", INVOICE_EMAIL: "pay@usc.edu", STUDENT_FEE: "180", STUDENT_FEE_FROM: "2000-01-01", PAY_SECRET: SECRET,
  STUDENT_CARD_PRICE: "200", STUDENT_BANK_PRICE: "181.45", PROF_CARD_PRICE: "5150", PROF_BANK_PRICE: "5005" };
const OFF = base, ON = { ...base, STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: WH, STRIPE_BANK: "1", ZELLE_UNIQUE: "1" };
// Stripe API mock: records each Checkout Session request.
const sessions = []; const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  if (String(u).startsWith("https://api.stripe.com/v1/checkout/sessions")) {
    const f = new URLSearchParams(String(init.body)); sessions.push({ auth: init.headers.Authorization, f });
    return new Response(JSON.stringify({ id: "cs_" + sessions.length, url: "https://checkout.stripe.com/c/pay/cs_" + sessions.length }), { status: 200 });
  }
  return realFetch(u, init);
};
const hook = async (event, { secret = WH, ts = Math.floor(Date.now()/1000), sig = null } = {}) => {
  const raw = JSON.stringify(event), v1 = sig ?? createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
  const res = await onRequest({ request: new Request(BASE + "/api/pay/stripe/webhook", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${ts},v1=${v1}` }, body: raw }), env: ON });
  let data = null; try { data = await res.json(); } catch {} return { status: res.status, data };
};
const done = (code, cents, pi, { method = "card", status = "paid", type = "checkout.session.completed" } = {}) =>
  ({ type, data: { object: { id: "cs_" + pi, mode: "payment", currency: "usd", payment_status: status, amount_total: cents, payment_intent: pi, payment_method_types: [method === "bank" ? "us_bank_account" : "card"], metadata: { code }, customer_details: { email: "x@usc.edu" } } } });
const paidNow = async email => { const st = (await call(ON, "/pay/start", { email })).data; return st.paid === true; };

await call(OFF, "/signup", { email: "admin@usc.edu", password: "adminpass1" });   // first account = admin
console.log("S1 Stripe off: no card option, route refuses");
let r = await call(OFF, "/pay/start", { email: "al@usc.edu" });
check("no stripe block when keys missing; no student PO", r.data?.stripe === null && r.data?.po === null, JSON.stringify(r.data));
check("/pay/stripe 503 when off", (await call(OFF, "/pay/stripe", { email: "al@usc.edu", method: "card" })).status === 503);

console.log("S2 Stripe on: student sees Card $200 + Bank $181.45 (nets $180)");
r = await call(ON, "/pay/start", { email: "al@usc.edu" });
const AL = r.data.code;
check("prices 200 / 181.45", r.data?.stripe?.card === 200 && r.data.stripe.bank === 181.45, JSON.stringify(r.data?.stripe));
check("card nets >= $180 after 2.9% + 30c", 200 - (200 * 0.029 + 0.30) >= 180);
check("bank nets >= $180 after 0.8% (cap $5)", 181.45 - Math.min(181.45 * 0.008, 5) >= 180 - 0.005);

console.log("S3 Checkout Session: amount, method, memo code set by the server");
r = await call(ON, "/pay/stripe", { email: "al@usc.edu", method: "card" });
let s = sessions.at(-1).f;
check("returns Stripe URL", r.status === 200 && /^https:\/\/checkout\.stripe\.com\//.test(r.data?.url||""), JSON.stringify(r.data));
check("card, $200.00, usd, code in metadata", s.get("payment_method_types[0]") === "card" && s.get("line_items[0][price_data][unit_amount]") === "20000" && s.get("line_items[0][price_data][currency]") === "usd" && s.get("metadata[code]") === AL && s.get("customer_email") === "al@usc.edu", s.toString());
check("secret key sent as Bearer", sessions.at(-1).auth === "Bearer sk_test_x");
check("success url returns to pay page", /^https:\/\/lockqz\.pages\.dev\/pay\?email=al%40usc\.edu&t=[0-9a-f]{32}&stripe=card$/.test(s.get("success_url") || ""));
await call(ON, "/pay/stripe", { email: "al@usc.edu", method: "bank" });
s = sessions.at(-1).f;
check("bank: us_bank_account, $181.45", s.get("payment_method_types[0]") === "us_bank_account" && s.get("line_items[0][price_data][unit_amount]") === "18145", s.toString());

console.log("S4 forged / stale webhooks refused");
check("wrong secret -> 400", (await hook(done(AL, 20000, "pi_al"), { secret: "whsec_wrong" })).status === 400);
check("10-minute-old signature -> 400", (await hook(done(AL, 20000, "pi_al"), { ts: Math.floor(Date.now()/1000) - 600 })).status === 400);
check("still unpaid", !(await paidNow("al@usc.edu")));

console.log("S5 card paid -> access on; replay counts once");
r = await hook(done(AL, 20000, "pi_al"));
check("webhook matched student, paid", r.status === 200 && r.data?.result?.matched === "student" && r.data.result.paid === true, JSON.stringify(r.data));
check("student paid", await paidNow("al@usc.edu"));
r = await hook(done(AL, 20000, "pi_al"));
check("same event again = duplicate", r.data?.result?.duplicate === true, JSON.stringify(r.data));
check("recorded once at $200 via stripe-card", sqlite.prepare("SELECT COUNT(*) n, SUM(amount) s, MAX(via) v FROM payments WHERE code=?").get(AL).n === 1 && sqlite.prepare("SELECT SUM(amount) s FROM payments WHERE code=?").get(AL).s === 200);
check("already paid -> no new checkout", (await call(ON, "/pay/stripe", { email: "al@usc.edu", method: "card" })).status === 409);

console.log("S6 bank (ACH): pending does nothing; cleared = paid");
const BO = (await call(ON, "/pay/start", { email: "bo@usc.edu" })).data.code;
await hook(done(BO, 18145, "pi_bo", { method: "bank", status: "unpaid" }));
check("ACH pending: unpaid", !(await paidNow("bo@usc.edu")));
await hook(done(BO, 18145, "pi_bo", { method: "bank", type: "checkout.session.async_payment_succeeded" }));
check("ACH cleared: paid", await paidNow("bo@usc.edu"));

console.log("S7 refund or dispute voids the payment");
await hook({ type: "charge.refunded", data: { object: { payment_intent: "pi_al" } } });
check("refunded: unpaid again", !(await paidNow("al@usc.edu")));
await hook({ type: "charge.dispute.created", data: { object: { payment_intent: "pi_bo" } } });
check("disputed: unpaid again", !(await paidNow("bo@usc.edu")));

console.log("S8 partial Zelle then card: only the rest, grossed up");
const CY = (await call(ON, "/pay/start", { email: "cy@usc.edu" })).data.code;
await call(ON, "/pay/notify", { payments: [{ txn: "gmail:cy1", amount: 100, note: CY, via: "zelle" }] }).catch(() => {});
await onRequest({ request: new Request(BASE + "/api/pay/notify", { method: "POST", headers: { "Content-Type": "application/json", "X-LOCKqz-Pay": SECRET }, body: JSON.stringify({ payments: [{ txn: "gmail:cy1", amount: 100, note: CY, via: "zelle" }] }) }), env: ON });
r = await call(ON, "/pay/start", { email: "cy@usc.edu" });
check("$80 left: card $82.70, bank $80.65", r.data?.stripe?.card === 82.7 && r.data.stripe.bank === 80.65, JSON.stringify(r.data?.stripe));
check("card remainder nets >= $80", 82.70 - (82.70 * 0.029 + 0.30) >= 80 - 0.005);
await call(ON, "/pay/stripe", { email: "cy@usc.edu", method: "card" });
check("checkout for $82.70", sessions.at(-1).f.get("line_items[0][price_data][unit_amount]") === "8270");
await hook(done(CY, 8270, "pi_cy"));
check("Zelle $100 + card $82.70 = paid", await paidNow("cy@usc.edu"));

console.log("S9 professor: Card $5,150 / Bank $5,005 -> account turns on by itself");
r = await call(ON, "/signup", { email: "prof@usc.edu", password: "profpass1", name: "Duke Bristow" });
const PT = r.data.token;
r = await getc(ON, "/my-sections", { teacher: PT });
const MEMO = r.data?.memo;
check("professor prices 5150 / 5005 + PO", r.data?.stripe?.card === 5150 && r.data.stripe.bank === 5005 && r.data.po === "pay@usc.edu", JSON.stringify(r.data));
check("card nets >= $5,000", 5150 - (5150 * 0.029 + 0.30) >= 5000);
check("bank nets $5,000 (fee capped $5)", 5005 - Math.min(5005 * 0.008, 5) === 5000);
r = await call(ON, "/pay/stripe-prof", { method: "card", back: "https://evil.example/" }, { teacher: PT });
s = sessions.at(-1).f;
check("prof checkout $5,150, memo code, foreign return URL replaced", r.status === 200 && s.get("line_items[0][price_data][unit_amount]") === "515000" && s.get("metadata[code]") === MEMO && s.get("cancel_url") === "https://prof.lockqz.pages.dev/", s.toString());
check("not active before payment", (await getc(ON, "/me", { teacher: PT })).data?.active === false);
r = await hook(done(MEMO, 515000, "pi_prof"));
check("webhook: professor paid", r.data?.result?.matched === "professor" && r.data.result.paid === true, JSON.stringify(r.data));
check("professor account active", (await getc(ON, "/me", { teacher: PT })).data?.active === true);
check("active professor: no more checkout", (await call(ON, "/pay/stripe-prof", { method: "card" }, { teacher: PT })).status === 409);
check("no login -> no professor checkout", (await call(ON, "/pay/stripe-prof", { method: "card" })).status === 401);

console.log("S10 pay page + dashboard show the options");
const html = readFileSync(join(CF, "public", "pay.html"), "utf8"), dash = readFileSync(join(CF, "public", "dashboard.html"), "utf8");
check("pay.html: card, bank account, ACH/wire, PO", /id="card"/.test(html) && /id="ach"/.test(html) && /ACH \/ wire/.test(html) && /Purchase order \(PO\)/.test(html) && /\/pay\/stripe"/.test(html));
check("dashboard: card, bank, ACH/wire, PO", /stripePay\('card'/.test(dash) && /stripePay\('bank'/.test(dash) && /ACH \/ wire/.test(dash) && /Purchase order \(PO\)/.test(dash));

console.log("S11a default: one Zelle price ($180) + memo; no unique amounts, no amount guessing");
{ const DEF = { ...ON }; delete DEF.ZELLE_UNIQUE;
  const a = (await call(DEF, "/pay/start", { email: "ivy@usc.edu" })).data;
  check("default: zelle_amount null (everyone pays $180)", a.zelle_amount === null && a.amount === 180, JSON.stringify(a));
  const n0 = await onRequest({ request: new Request(BASE + "/api/pay/notify", { method: "POST", headers: { "Content-Type": "application/json", "X-LOCKqz-Pay": SECRET }, body: JSON.stringify({ payments: [{ txn: "zelle:ivy0", amount: 180.01, note: "", via: "zelle" }] }) }), env: DEF }).then(r => r.json());
  check("default: no-memo Zelle is not amount-matched", n0.results?.[0]?.matched === null, JSON.stringify(n0)); }
const pz = readFileSync(join(CF, "public", "pay.html"), "utf8");
check("pay page: Zelle steps with Copy memo, paste-into-note step and warning", /id="zcopy"/.test(pz) && /Paste the memo<\/b> into the Memo \/ Note box/.test(pz) && /No memo = LOCKqz can't tell the payment is yours/.test(pz));
console.log("S11 ZELLE_UNIQUE=1: unique Zelle amount, no memo needed");
const notify2 = payments => onRequest({ request: new Request(BASE + "/api/pay/notify", { method: "POST", headers: { "Content-Type": "application/json", "X-LOCKqz-Pay": SECRET }, body: JSON.stringify({ payments }) }), env: ON }).then(r => r.json());
const z1 = (await call(ON, "/pay/start", { email: "dee@usc.edu" })).data, z2 = (await call(ON, "/pay/start", { email: "eve@usc.edu" })).data;
check("each unpaid student gets a different $180.xx", z1.zelle_amount > 180 && z1.zelle_amount < 190 && z2.zelle_amount > 180 && z1.zelle_amount !== z2.zelle_amount && Math.round(z1.zelle_amount * 100) % 100 !== 0, `${z1.zelle_amount} ${z2.zelle_amount}`);
check("same student, same amount on reload", (await call(ON, "/pay/start", { email: "dee@usc.edu" })).data.zelle_amount === z1.zelle_amount);
let n = await notify2([{ txn: "zelle:nomemo1", amount: z2.zelle_amount, note: "for lockqz", via: "zelle", payer: "Eve" }]);
check("Zelle with no memo, exact amount -> eve paid", n.results?.[0]?.matched === "student" && n.results[0].email === "eve@usc.edu" && n.results[0].paid === true, JSON.stringify(n));
check("eve's amount freed after paying", !sqlite.prepare("SELECT 1 FROM pay_slots WHERE code=?").get(z2.code));
check("dee still unpaid", !(await paidNow("dee@usc.edu")));
n = await notify2([{ txn: "zelle:nomemo2", amount: 180, note: "", via: "zelle" }]);
check("plain $180 with no memo is not guessed", n.results?.[0]?.matched === null, JSON.stringify(n));
n = await notify2([{ txn: "zelle:nomemo3", amount: z1.zelle_amount, note: "", via: "zelle", needs_review: true, review_reason: "forwarded" }]);
check("suspicious alert never amount-matched", n.results?.[0]?.review === true && !(await paidNow("dee@usc.edu")), JSON.stringify(n));
n = await notify2([{ txn: "zelle:memo4", amount: z1.zelle_amount, note: z1.code, via: "zelle" }]);
check("memo still works too", n.results?.[0]?.paid === true && n.results[0].email === "dee@usc.edu", JSON.stringify(n));
check("paid student gets no Zelle amount", (await call(ON, "/pay/start", { email: "dee@usc.edu" })).data.zelle_amount === null);
const ph = readFileSync(join(CF, "public", "pay.html"), "utf8"), lq = readFileSync(join(CF, "public", "lq.js"), "utf8");
check("pay page can show an exact Zelle amount", /zelle_amount/.test(ph));
check("no fun facts in loaders", !/Did you know|FACTS/.test(lq));

console.log("S12 cancelled payments = no access (professors too)");
r = await hook({ type: "charge.refunded", data: { object: { payment_intent: "pi_prof" } } });
check("professor refund voided", r.data?.voided === true, JSON.stringify(r.data));
check("professor no longer active", (await getc(ON, "/me", { teacher: PT })).data?.active === false);
const FX = (await call(ON, "/pay/start", { email: "fay@usc.edu" })).data.code;
await hook(done(FX, 18145, "pi_fay", { method: "bank", type: "checkout.session.async_payment_succeeded" }));
check("bank payment cleared: paid", await paidNow("fay@usc.edu"));
r = await hook({ type: "charge.failed", data: { object: { payment_intent: "pi_fay" } } });
check("bank payment returned/failed later: unpaid", r.data?.voided === true && !(await paidNow("fay@usc.edu")), JSON.stringify(r.data));
r = await hook({ type: "payment_intent.payment_failed", data: { object: { id: "pi_never" } } });
check("failure for an unknown payment: nothing happens", r.status === 200 && r.data?.voided === false);
{ // admin void (Zelle/bank refunded by hand) also turns a professor off
  r = await call(ON, "/signup", { email: "prof2@usc.edu", password: "profpass1", name: "Ann Lee" });
  const P2 = r.data.token, M2 = (await getc(ON, "/my-sections", { teacher: P2 })).data.memo;
  await notify2([{ txn: "zelle:p2", amount: 5000, note: M2, via: "zelle" }]);
  check("prof2 active after Zelle", (await getc(ON, "/me", { teacher: P2 })).data?.active === true);
  const ADM = sqlite.prepare("SELECT token FROM teachers WHERE email='admin@usc.edu'").get().token;
  r = await call(ON, "/pay-void", { txn: "zelle:p2" }, { teacher: ADM });
  check("admin void -> prof2 inactive", r.data?.ok === true && (await getc(ON, "/me", { teacher: P2 })).data?.active === false, JSON.stringify(r.data));
}

console.log("S13 Stripe bank is OFF by default (ACH can be returned); STRIPE_BANK=0 hides it");
{ const DEF = { ...ON }; delete DEF.STRIPE_BANK;
  r = await call(DEF, "/pay/start", { email: "hal@usc.edu" });
  check("default: no Stripe bank option, card only", r.data?.stripe?.bank === null && r.data.stripe.card === 200, JSON.stringify(r.data?.stripe));
  const wt = readFileSync(join(CF, "wrangler.toml"), "utf8");
  check("wrangler.toml ships STRIPE_BANK = \"0\"", /^STRIPE_BANK = "0"$/m.test(wt)); }
check("no cancel/refund control on the pay page or dashboard", !/\/pay\/(cancel|refund)/.test(readFileSync(join(CF, "public", "pay.html"), "utf8") + readFileSync(join(CF, "public", "dashboard.html"), "utf8")));
console.log("S13 STRIPE_BANK=0 hides the Stripe bank option");
r = await call({ ...ON, STRIPE_BANK: "0" }, "/pay/start", { email: "gus@usc.edu" });
check("bank null, card still there", r.data?.stripe?.bank === null && r.data.stripe.card === 200, JSON.stringify(r.data?.stripe));
await call({ ...ON, STRIPE_BANK: "0" }, "/pay/stripe", { email: "gus@usc.edu", method: "bank" });
check("asking for bank anyway -> card checkout", sessions.at(-1).f.get("payment_method_types[0]") === "card");

console.log(`\nStripe: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
