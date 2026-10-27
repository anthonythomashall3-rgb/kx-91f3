// Student card auto-renew (27 Oct 2026) + the download page's account API (/account).
// Real API, in-memory SQLite (schema.sql + every migration), Stripe and email mocked, clock moved by hand.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac } from "node:crypto";
import { payT } from "./pay_t.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-renew-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(process.env.LQZ_ROUTE || join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch (e) { /* already in schema.sql */ } }
const DB = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
  const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
    first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
    run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } }; return o; },
  async batch(sts) { for (const s of sts) s._run(); } };
const q = (sql, ...a) => sqlite.prepare(sql).get(...a);
const mails = [];
const WH = "whsec_test_0123456789abcdef", SECRET = "test-pay-secret-0123456789";
const env = { DB, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", PAY_SECRET: SECRET, MAIL_SINK: async m => { mails.push(m); },
  STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: WH, STUDENT_FEE: "180", STUDENT_FEE_FROM: "2026-10-25", ZELLE_TO: "(858) 900-4347",
  STUDENT_CARD_PRICE: "200", TAX_RATE: "0.25", TAX_FROM: "2026-10-26T13:00:00Z", STUDENT_TOTAL: "240", STUDENT_OTHER_TOTAL: "280", STUDENT_OTHER_PRICE: "200", PAID_CACHE_MS: "0" };
const BASE = "https://lockqz.test";
async function call(path, body, { e = env, ip = "1.2.3.4" } = {}) {
  const res = await onRequest({ request: new Request(BASE + "/api" + path, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify(body || {}) }), env: e });
  let data = null; try { data = await res.json(); } catch {} return { status: res.status, data };
}
const tick = () => onRequest({ request: new Request(BASE + "/api/pay/tick", { method: "POST", headers: { "X-LOCKqz-Pay": SECRET } }), env }).then(r => r.json());
const hook = async ev => { const raw = JSON.stringify(ev), ts = Math.floor(Date.now() / 1000), v1 = createHmac("sha256", WH).update(`${ts}.${raw}`).digest("hex");
  const res = await onRequest({ request: new Request(BASE + "/api/pay/stripe/webhook", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${ts},v1=${v1}` }, body: raw }), env });
  return { status: res.status, data: await res.json().catch(() => null) }; };
// The clock: Date.now() AND new Date() follow at() (the API stamps rows with new Date()).
const RealDate = Date; let fakeNow = RealDate.now();
class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fakeNow); } static now() { return fakeNow; } }
globalThis.Date = FakeDate;
const at = iso => { fakeNow = RealDate.parse(iso); };

// ---- Stripe mock ----
const sessions = [], intents = [];
let piMode = "ok";   // ok | decline | auth | down | processing
globalThis.fetch = async (u, init = {}) => {
  u = String(u);
  if (u.startsWith("https://api.stripe.com/v1/checkout/sessions")) { const f = new URLSearchParams(String(init.body || "")); sessions.push(f);
    return new Response(JSON.stringify({ id: "cs_" + sessions.length, url: "https://checkout.stripe.com/c/pay/cs_" + sessions.length }), { status: 200 }); }
  if (u.startsWith("https://api.stripe.com/v1/payment_intents/pi_")) {
    return new Response(JSON.stringify({ id: u.split("/").pop().split("?")[0], payment_method: { id: "pm_card1", type: "card", card: { brand: "visa", last4: "4242" } } }), { status: 200 }); }
  if (u === "https://api.stripe.com/v1/payment_intents" && init.method === "POST") {
    const f = new URLSearchParams(String(init.body)), key = init.headers["Idempotency-Key"];
    intents.push({ f, key });
    if (piMode === "down") throw new Error("network");
    const prior = intents.find(x => x.key === key && x.res); if (prior) return new Response(JSON.stringify(prior.res.body), { status: prior.res.status });
    const id = "pi_renew" + intents.length;
    const r = piMode === "ok" ? { status: 200, body: { id, status: "succeeded", amount: Number(f.get("amount")), amount_received: Number(f.get("amount")), metadata: Object.fromEntries([...f].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])) } }
      : piMode === "processing" ? { status: 200, body: { id, status: "processing", amount: Number(f.get("amount")) } }
      : piMode === "auth" ? { status: 402, body: { error: { type: "card_error", code: "authentication_required", message: "This payment requires authentication.", payment_intent: { id } } } }
      : { status: 402, body: { error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds.", payment_intent: { id } } } };
    intents.at(-1).res = r;
    return new Response(JSON.stringify(r.body), { status: r.status }); }
  throw new Error("unexpected fetch " + u);
};
const paidEv = (code, cents, pi, extra = {}) => ({ type: "checkout.session.completed", data: { object: { id: "cs_" + pi, mode: "payment", currency: "usd", payment_status: "paid",
  amount_total: cents, payment_intent: pi, payment_method_types: ["card"], metadata: { code, kind: "student", save: "1" }, customer: "cus_al", customer_details: { email: "al@usc.edu" }, ...extra } } });
const payStart = em => call("/pay/start", { email: em, t: payT(env, em) });

try {
  at("2026-10-27T20:00:00Z");
  console.log("A1 pay page data: the card renewal amount is the real card total");
  let r = await payStart("al@usc.edu");
  const AL = r.data?.code;
  check("/pay/start: card_renew = $280 (card total), ways.card = $280", r.data?.card_renew === 280 && r.data?.ways?.card?.total === 280, JSON.stringify({ c: r.data?.card_renew, w: r.data?.ways?.card }));

  console.log("A2 Checkout (payment mode) saves the card: Customer + setup_future_usage=off_session");
  r = await call("/pay/stripe", { email: "al@usc.edu", method: "card", t: payT(env, "al@usc.edu") });
  let s = sessions.at(-1);
  check("payment mode, $280, off_session, customer_creation=always, save mark, email kept", r.status === 200 && s.get("mode") === "payment" && s.get("line_items[0][price_data][unit_amount]") === "28000"
    && s.get("payment_intent_data[setup_future_usage]") === "off_session" && s.get("customer_creation") === "always" && s.get("metadata[save]") === "1" && s.get("customer_email") === "al@usc.edu" && !s.has("subscription_data[items][0][price]"), s.toString());

  console.log("A3 webhook: payment credited, card saved, confirmation email (renews each semester, amount, how to cancel)");
  r = await hook(paidEv(AL, 28000, "pi_first"));
  let row = q("SELECT * FROM card_renew WHERE email='al@usc.edu'");
  check("paid for Fall 2026", r.data?.result?.paid === true && r.data.result.term === "20263", JSON.stringify(r.data));
  check("card saved: cus + pm + visa 4242, autorenew on", row?.customer === "cus_al" && row.pm === "pm_card1" && row.brand === "visa" && row.last4 === "4242" && row.autorenew === 1, JSON.stringify(row));
  let m = mails.filter(x => x.to === "al@usc.edu" && /renews each semester/.test(x.subject));
  check("one confirmation email: renews each semester at $280, next renewal Nov 30 for Spring 2027, gear icon -> Account -> Cancel auto-renew",
    m.length === 1 && /renews automatically each semester at \$280/.test(m[0].text) && /November 30, 2026, for Spring 2027/.test(m[0].text) && /gear icon \(top right\) → Account → Cancel auto-renew/.test(m[0].text), m.map(x => x.text).join("|"));
  await hook(paidEv(AL, 28000, "pi_first"));   // Stripe retries the event
  check("retried event: no second confirmation, paid once", mails.filter(x => /renews each semester/.test(x.subject)).length === 1 && q("SELECT COUNT(*) AS n FROM payments WHERE code=?", AL).n === 1);

  console.log("A4 second Checkout for the same email reuses the Customer");
  await call("/pay/stripe", { email: "bo@usc.edu", method: "card", t: payT(env, "bo@usc.edu") });
  sqlite.prepare("INSERT INTO card_renew (email,customer,pm,brand,last4,autorenew) VALUES ('bo@usc.edu','cus_bo','pm_bo','mastercard','1111',0)").run();
  sessions.length = 0;
  sqlite.prepare("DELETE FROM events WHERE event='stripe_sess'").run();
  r = await call("/pay/stripe", { email: "bo@usc.edu", method: "card", t: payT(env, "bo@usc.edu") });
  s = sessions.at(-1);
  check("customer=cus_bo, no customer_email/customer_creation", s?.get("customer") === "cus_bo" && !s.has("customer_email") && !s.has("customer_creation"), s?.toString());

  console.log("A5 outside the renewal window the tick does nothing");
  mails.length = 0;
  let t = await tick();
  check("Oct 27: not renewal time, no charge, no email", t.card?.why === "not renewal time" && intents.length === 0 && mails.length === 0, JSON.stringify(t));

  console.log("A6 reminder 7 days before (Nov 23 for the Nov 30 charge), once");
  at("2026-11-23T18:00:00Z");
  t = await tick();
  m = mails.filter(x => x.to === "al@usc.edu");
  row = q("SELECT * FROM card_renew WHERE email='al@usc.edu'");
  check("reminder: amount $280, date Nov 30, visa 4242, how to cancel", m.length === 1 && /\$280/.test(m[0].text) && /November 30, 2026/.test(m[0].text) && /Visa •••• 4242/.test(m[0].text) && /Cancel auto-renew/.test(m[0].text) && /keep access until December 16, 2026/.test(m[0].text), m.map(x => x.subject + " " + x.text).join("|"));
  check("row: reminded for Spring 2027, charge_on 2026-11-30", row.rterm === "20271" && row.state === "reminded" && row.charge_on === "2026-11-30", JSON.stringify(row));
  check("bo (auto-renew off) gets nothing", !mails.some(x => x.to === "bo@usc.edu"));
  await tick();
  check("next tick: no second reminder, no charge before the date", mails.filter(x => x.to === "al@usc.edu").length === 1 && intents.length === 0);

  console.log("A7 the charge on Nov 30: off-session PaymentIntent, idempotency key, metadata like Checkout's");
  at("2026-11-30T17:00:00Z");
  t = await tick();
  let pi = intents.at(-1);
  check("one charge: $280, cus/pm, off_session+confirm, metadata code/kind/term/renew", intents.length === 1 && pi.f.get("amount") === "28000" && pi.f.get("customer") === "cus_al" && pi.f.get("payment_method") === "pm_card1"
    && pi.f.get("off_session") === "true" && pi.f.get("confirm") === "true" && pi.f.get("metadata[code]") === AL && pi.f.get("metadata[term]") === "20271" && pi.f.get("metadata[renew]") === "1" && pi.f.get("metadata[kind]") === "student", pi.f.toString());
  check("idempotency key per email + term", /^lqz-renew:al@usc\.edu:20271:/.test(pi.key || ""), pi.key);
  let pay = q("SELECT * FROM payments WHERE txn=?", "stripe:" + pi.res.body.id);
  check("credited to Spring 2027 (via stripe-card, $280)", pay?.term === "20271" && pay.code === AL && pay.amount === 280 && pay.via === "stripe-card", JSON.stringify(pay));
  check("row paid", q("SELECT state FROM card_renew WHERE email='al@usc.edu'").state === "paid");
  await tick(); await tick();
  check("more ticks: never charged again", intents.length === 1);
  r = await hook({ type: "payment_intent.succeeded", data: { object: { id: pi.res.body.id, currency: "usd", amount: 28000, amount_received: 28000, metadata: { code: AL, kind: "student", term: "20271", renew: "1" } } } });
  check("webhook for the same renewal: duplicate, still one payment", r.data?.result?.duplicate === true && q("SELECT COUNT(*) AS n FROM payments WHERE code=? AND term='20271'", AL).n === 1, JSON.stringify(r.data));
  at("2027-01-11T18:00:00Z");
  check("Spring 2027 day one: paid", (await payStart("al@usc.edu")).data?.paid === true);

  console.log("A8 refund / dispute of a renewal: voided (no access) and auto-renew turned off");
  r = await hook({ type: "charge.dispute.created", data: { object: { payment_intent: pi.res.body.id } } });
  check("dispute voids the renewal payment", r.data?.voided === true && q("SELECT matched FROM payments WHERE txn=?", "stripe:" + pi.res.body.id).matched === "void");
  check("no access for Spring after the dispute", (await payStart("al@usc.edu")).data?.paid === false);
  check("auto-renew off after money pulled back", q("SELECT autorenew FROM card_renew WHERE email='al@usc.edu'").autorenew === 0);

  console.log("A9 failed renewal: marked, student emailed the pay link once, retried at most once a day, max 3 tries");
  at("2026-10-28T18:00:00Z");
  r = await payStart("cy@usc.edu"); const CY = r.data.code;
  await hook(paidEv(CY, 28000, "pi_cy", { customer: "cus_cy" }));
  check("cy card saved", q("SELECT pm FROM card_renew WHERE email='cy@usc.edu'")?.pm === "pm_card1");
  at("2026-11-24T18:00:00Z"); mails.length = 0; await tick();
  check("cy reminded (charge Dec 1)", q("SELECT charge_on FROM card_renew WHERE email='cy@usc.edu'").charge_on === "2026-12-01");
  piMode = "decline"; intents.length = 0;
  at("2026-12-01T17:00:00Z"); await tick();
  row = q("SELECT * FROM card_renew WHERE email='cy@usc.edu'");
  m = mails.filter(x => x.to === "cy@usc.edu" && /did not go through/.test(x.subject));
  check("declined: state failed, tries 1, fail_day today", row.state === "failed" && row.tries === 1 && row.fail_day === "2026-12-01", JSON.stringify(row));
  check("email with the signed pay link + insufficient funds", m.length === 1 && m[0].text.includes("/pay?email=cy%40usc.edu&t=" + payT(env, "cy@usc.edu")) && /insufficient funds/.test(m[0].text), m.map(x => x.text).join("|"));
  check("not paid (today's unpaid behaviour: still Fall access)", (await payStart("cy@usc.edu")).data?.paid === true && !q("SELECT 1 AS x FROM payments WHERE code=? AND term='20271' AND COALESCE(matched,'')<>'void'", CY));
  at("2026-12-01T23:00:00Z"); await tick();
  check("same day: no retry", intents.length === 1);
  at("2026-12-02T17:00:00Z"); await tick();
  check("next day: one retry with a new key, no second email", intents.length === 2 && intents[1].key !== intents[0].key && mails.filter(x => x.to === "cy@usc.edu" && /did not go through/.test(x.subject)).length === 1);
  at("2026-12-03T17:00:00Z"); await tick();
  at("2026-12-04T17:00:00Z"); await tick();
  at("2026-12-05T17:00:00Z"); await tick();
  check("stops after 3 tries", intents.length === 3 && q("SELECT tries FROM card_renew WHERE email='cy@usc.edu'").tries === 3, intents.length);

  console.log("A10 bank wants authentication: never retried");
  at("2026-10-28T18:00:00Z");
  r = await payStart("di@usc.edu"); const DI = r.data.code;
  await hook(paidEv(DI, 28000, "pi_di", { customer: "cus_di" }));
  at("2026-11-25T18:00:00Z"); piMode = "ok"; await tick();
  piMode = "auth"; intents.length = 0;
  at("2026-12-02T17:00:00Z"); await tick();
  at("2026-12-03T17:00:00Z"); await tick();
  check("authentication_required: one attempt, marked final, email says confirm", intents.length === 1 && q("SELECT tries FROM card_renew WHERE email='di@usc.edu'").tries === 3 && mails.some(x => x.to === "di@usc.edu" && /confirm this payment/.test(x.text)));

  console.log("A11 Stripe unreachable: unknown outcome is retried next hour with the SAME key (cannot double-charge)");
  at("2026-10-28T18:00:00Z");
  r = await payStart("ed@usc.edu"); const ED = r.data.code;
  await hook(paidEv(ED, 28000, "pi_ed", { customer: "cus_ed" }));
  at("2026-11-25T18:00:00Z"); piMode = "ok"; await tick();
  piMode = "down"; intents.length = 0;
  at("2026-12-02T17:00:00Z"); await tick();
  piMode = "ok";
  at("2026-12-02T18:00:00Z"); await tick();
  check("same key on the retry, paid once", intents.length === 2 && intents[0].key === intents[1].key && q("SELECT COUNT(*) AS n FROM payments WHERE code=? AND term='20271'", ED).n === 1, intents.map(x => x.key).join(","));

  console.log("A12 paid by Zelle before the charge: not charged");
  at("2026-10-28T18:00:00Z");
  r = await payStart("fi@usc.edu"); const FI = r.data.code;
  await hook(paidEv(FI, 28000, "pi_fi", { customer: "cus_fi" }));
  at("2026-11-25T18:00:00Z"); await tick();
  await onRequest({ request: new Request(BASE + "/api/pay/notify", { method: "POST", headers: { "X-LOCKqz-Pay": SECRET, "Content-Type": "application/json" }, body: JSON.stringify({ payments: [{ txn: "z-fi", amount: 240, note: FI, via: "zelle", want_term: "20272" }] }) }), env });
  check("Zelle counted for Spring (the Gmail script cannot pick a term)", q("SELECT term FROM payments WHERE txn='z-fi'").term === "20271");
  intents.length = 0; at("2026-12-02T17:00:00Z"); await tick();
  check("no card charge for fi", !intents.some(x => x.f.get("metadata[code]") === FI) && q("SELECT state FROM card_renew WHERE email='fi@usc.edu'").state === "paid");

  console.log("A13 /account: sign in with an emailed code (same limits as the app), then status / cancel / turn on");
  at("2026-11-26T18:00:00Z"); mails.length = 0;
  r = await call("/account", { op: "status" });
  check("no token: 401", r.status === 401);
  r = await call("/account", { op: "status", token: "YWxAdXNjLmVkdQ.9999999999.0000000000000000000000000000000000000000" });
  check("forged token: 401", r.status === 401);
  r = await call("/account", { op: "send", email: "gus@usc.edu" });
  const code = mails.at(-1)?.code;
  check("code emailed (sign-in wording)", r.data?.sent === true && /^\d{6}$/.test(code || "") && /lockqz\.pages\.dev/.test(mails.at(-1).text), JSON.stringify(r.data));
  r = await call("/account", { op: "code", email: "gus@usc.edu", code: code === "000000" ? "111111" : "000000" });
  check("wrong code refused, tries left", r.status === 400 && r.data?.error === "wrong_code" && r.data.tries_left === 4, JSON.stringify(r.data));
  for (let i = 0; i < 4; i++) r = await call("/account", { op: "code", email: "gus@usc.edu", code: code === "000000" ? "111111" : "000000" });
  check("5th wrong try kills the code", r.data?.error === "too_many_tries" && (await call("/account", { op: "code", email: "gus@usc.edu", code })).data?.error === "expired");
  await call("/account", { op: "send", email: "gus@usc.edu" }); await call("/account", { op: "send", email: "gus@usc.edu" });
  r = await call("/account", { op: "send", email: "gus@usc.edu" });
  check("per-recipient limit: 4th code in an hour refused", r.status === 429 && r.data?.error === "too_many_codes", JSON.stringify(r.data));
  mails.length = 0;
  await call("/account", { op: "send", email: "cy@usc.edu" });
  r = await call("/account", { op: "code", email: "cy@usc.edu", code: mails.at(-1).code });
  const TOK = r.data?.token;
  check("signed in: token", r.data?.ok === true && /^[A-Za-z0-9_-]+\.\d+\.[0-9a-f]{40}$/.test(TOK || ""), JSON.stringify(r.data));
  r = await call("/account", { op: "status", token: TOK });
  check("status: email, paid Fall 2026 until Dec 16, card visa 4242, renewal failed shown", r.data?.email === "cy@usc.edu" && r.data.paid === true && r.data.until === "2026-12-16" && r.data.renew?.on === true && r.data.renew.last4 === "4242" && !!r.data.renew.failed, JSON.stringify(r.data));
  const tamper = TOK.replace(/^[^.]+/, Buffer.from("al@usc.edu").toString("base64url"));
  check("token for another email (tampered) refused", (await call("/account", { op: "status", token: tamper })).status === 401);
  r = await call("/account", { op: "renew", token: TOK, on: false });
  check("cancel auto-renew -> autorenew 0", r.data?.on === false && q("SELECT autorenew FROM card_renew WHERE email='cy@usc.edu'").autorenew === 0);
  check("status shows off; access unchanged", (await call("/account", { op: "status", token: TOK })).data?.renew?.on === false && (await call("/account", { op: "status", token: TOK })).data?.paid === true);
  r = await call("/account", { op: "renew", token: TOK, on: true });
  row = q("SELECT * FROM card_renew WHERE email='cy@usc.edu'");
  check("turn back on: fresh start (reminder again before any charge)", r.data?.on === true && row.autorenew === 1 && row.rterm === null && row.tries === 0, JSON.stringify(row));
  at("2026-12-27T19:00:00Z");
  check("token expires after 30 days", (await call("/account", { op: "status", token: TOK })).status === 401);
  at("2026-11-26T19:00:00Z");
  sqlite.prepare("DELETE FROM card_renew WHERE email='gus@usc.edu'").run();

  console.log("A14 /account: your computers, remove (2 per semester), receipts (once per 10 min)");
  for (const [id, pl, seen] of [["mac-1", "mac", "2026-11-25T00:00:00Z"], ["win-2", "windows", "2026-11-20T00:00:00Z"], ["mac-3", "mac", "2026-11-01T00:00:00Z"], ["mac-x", "mac", "2026-11-01T00:00:00Z"]])
    sqlite.prepare("INSERT INTO devices (device_id,student,platform,version,installed_at,last_seen,student_verified) VALUES (?,?,?,?,?,?,1)").run(id, id === "mac-x" ? "al@usc.edu" : "cy@usc.edu", pl, "0.5.1", seen, seen);
  r = await call("/account", { op: "status", token: TOK });
  check("3 computers listed (newest first), not someone else's", r.data?.devices?.length === 3 && r.data.devices[0].id === "mac-1" && r.data.devices[1].os === "Windows" && r.data.removals_left === 2, JSON.stringify(r.data?.devices));
  check("cannot remove another student's computer", (await call("/account", { op: "remove", token: TOK, device_id: "mac-x" })).status === 404 && q("SELECT revoked FROM devices WHERE device_id='mac-x'").revoked === 0);
  r = await call("/account", { op: "remove", token: TOK, device_id: "mac-3" });
  check("remove -> revoked", r.data?.ok === true && r.data.removals_left === 1 && q("SELECT revoked FROM devices WHERE device_id='mac-3'").revoked === 1);
  await call("/account", { op: "remove", token: TOK, device_id: "win-2" });
  r = await call("/account", { op: "remove", token: TOK, device_id: "mac-1" });
  check("3rd removal this semester refused", r.status === 429 && q("SELECT revoked FROM devices WHERE device_id='mac-1'").revoked === 0, JSON.stringify(r.data));
  mails.length = 0;
  r = await call("/account", { op: "receipts", token: TOK });
  check("receipts emailed: card payment listed", r.data?.sent === true && mails.length === 1 && mails[0].to === "cy@usc.edu" && /\$280\s+Card\s+Fall 2026/.test(mails[0].text), mails[0]?.text);
  r = await call("/account", { op: "receipts", token: TOK });
  check("again within 10 min: no second email", r.data?.again === true && mails.length === 1);
  check("receipts need sign-in", (await call("/account", { op: "receipts" })).status === 401);

  console.log("A16 Spring card -> renews for Fall (summer skipped), charged in July, counts for Fall");
  at("2027-02-01T18:00:00Z"); mails.length = 0; piMode = "ok";
  r = await payStart("jo@usc.edu"); const JO = r.data.code;
  await hook(paidEv(JO, 28000, "pi_jo", { customer: "cus_jo" }));
  check("confirmation: next renewal July 11, 2027 for Fall 2027", mails.some(x => x.to === "jo@usc.edu" && /July 11, 2027, for Fall 2027/.test(x.text)), mails.map(x => x.text).join("|"));
  at("2027-05-20T18:00:00Z"); intents.length = 0; await tick();
  check("summer start: nothing charged for summer", !intents.some(x => x.f.get("metadata[code]") === JO));
  at("2027-07-04T18:00:00Z"); await tick();
  check("reminder July 4 for July 11", q("SELECT charge_on FROM card_renew WHERE email='jo@usc.edu'").charge_on === "2027-07-11" && mails.some(x => x.to === "jo@usc.edu" && /July 11, 2027/.test(x.subject)));
  at("2027-07-11T18:00:00Z"); await tick();
  check("charged July 11 for Fall 2027", intents.filter(x => x.f.get("metadata[code]") === JO).length === 1 && q("SELECT term FROM payments WHERE code=? AND via='stripe-card' ORDER BY received_at DESC LIMIT 1", JO).term === "20273");
  check("access in July (summer) and ready for Fall day one", (await payStart("jo@usc.edu")).data?.paid === true);

  console.log("A15 off switch + professors untouched");
  const off = { ...env, STUDENT_AUTORENEW: "0" };
  sessions.length = 0; sqlite.prepare("DELETE FROM events WHERE event='stripe_sess'").run();
  r = await call("/pay/stripe", { email: "hal@usc.edu", method: "card", t: payT(env, "hal@usc.edu") }, { e: off });
  check("STUDENT_AUTORENEW=0: plain one-time Checkout", r.status === 200 && !sessions.at(-1).has("payment_intent_data[setup_future_usage]") && (await call("/pay/start", { email: "hal@usc.edu", t: payT(env, "hal@usc.edu") }, { e: off })).data?.card_renew === null);
} finally { globalThis.Date = RealDate; }
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
