// Bug sweep 12 follow-up (11 Nov 2026): requests at the same moment (a database mock whose every call yields).
//   R1 card renewal day, three payment ticks at once: Stripe is asked under ONE idempotency key, one payment
//      row is written, and the student gets ONE "renewed" email.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, readdirSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
const HERE = dirname(fileURLToPath(import.meta.url)); const CF = join(HERE, "..", "cloudflare"); const TMPD = mkdtempSync(join(tmpdir(), "lqz-race12-"));
writeFileSync(join(TMPD, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(TMPD, "route.mjs")).href);
const RealDate = Date; let fakeNow = null;
class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fakeNow ?? RealDate.now()); } static now() { return fakeNow ?? RealDate.now(); } }
globalThis.Date = FakeDate; const at = iso => { fakeNow = RealDate.parse(iso); };
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch {} }
const tick = () => new Promise(r => setTimeout(r, Math.random() * 3));
const db = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
  const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
    first: async () => { await tick(); return st.get(...args) ?? null; }, all: async () => { await tick(); return { results: st.all(...args) }; }, run: async () => { await tick(); return { meta: { changes: Number(st.run(...args).changes) } }; }, _run() { st.run(...args); } }; return o; },
  async batch(sts) { await tick(); sqlite.exec("BEGIN"); try { for (const s of sts) s._run(); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; } return []; } };
const MAILS = [], WH = "whsec_r2";
const env = { DB: db, TEACHER_KEY: "admin-key", ROT_SECRET: "rs", PAY_SECRET: "paysecret-0123456789", MAIL_SINK: async m => { MAILS.push(m); return true; }, ADMIN_EMAIL: "admin@usc.edu",
  STUDENT_FEE: "180", STUDENT_FEE_FROM: "2026-10-25", STUDENT_TOTAL: "200", STUDENT_OTHER_TOTAL: "210", STUDENT_OTHER_PRICE: "210", STUDENT_CARD_PRICE: "210", TAX_RATE: "0.25", TAX_FROM: "2026-10-26T13:00:00Z",
  PROF_TOTAL: "6500", PROF_CARD_TOTAL: "6500", PROF_ZELLE_TOTAL: "6300", PROF_BANK_TOTAL: "6500", PROF_OTHER_PRICE: "5000", PROF_CARD_PRICE: "5150", ZELLE_TO: "x", VENMO_HANDLE: "LOCKqz", STUDENT_VENMO: "1",
  STRIPE_SECRET_KEY: "sk_test", STRIPE_WEBHOOK_SECRET: WH, STUDENT_AUTORENEW: "1" };
const intents = [];
globalThis.fetch = async (u, init = {}) => { u = String(u); await tick();
  if (u.includes("checkout/sessions")) return new Response(JSON.stringify({ id: "cs_x", url: "https://checkout.stripe.com/x" }), { status: 200 });
  if (u.startsWith("https://api.stripe.com/v1/payment_intents/pi_")) return new Response(JSON.stringify({ id: u.split("/").pop().split("?")[0], payment_method: { id: "pm_card1", type: "card", card: { brand: "visa", last4: "4242" } } }), { status: 200 });
  if (u === "https://api.stripe.com/v1/payment_intents") { const f = new URLSearchParams(String(init.body)); const key = (init.headers && (init.headers["Idempotency-Key"] || init.headers["idempotency-key"])) || null; intents.push({ f, key });
    return new Response(JSON.stringify({ id: "pi_renew_" + (key || intents.length), status: "succeeded", amount: Number(f.get("amount")), amount_received: Number(f.get("amount")), metadata: {} }), { status: 200 }); }
  return new Response("{}", { status: 200 }); };
let ip = 0;
async function api(path, body, h = {}) { try { const res = await onRequest({ request: new Request("https://lockqz.pages.dev/api" + path, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.3." + ((++ip >> 8) & 255) + "." + (ip & 255), ...h }, body: JSON.stringify(body) }), env, waitUntil: () => {} });
  return { status: res.status, data: await res.json().catch(() => null) }; } catch (e) { return { status: 599, data: { error: String(e.message).slice(0, 200) } }; } }
const tok = em => createHmac("sha256", "rs").update("lqz-pay-status:" + em).digest("hex").slice(0, 32);
const start = em => api("/pay/start", { email: em, t: tok(em) });
const PAY = { "X-LOCKqz-Pay": env.PAY_SECRET };
const hook = async ev => { const raw = JSON.stringify(ev), ts = Math.floor(Date.now() / 1000), v1 = createHmac("sha256", WH).update(`${ts}.${raw}`).digest("hex");
  try { const res = await onRequest({ request: new Request("https://lockqz.pages.dev/api/pay/stripe/webhook", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${ts},v1=${v1}` }, body: raw }), env }); return { status: res.status, data: await res.json().catch(() => null) }; } catch (e) { return { status: 599, data: { error: String(e.message).slice(0, 200) } }; } };
let pass = 0, fail = 0;
const out = (label, ok, info = "") => { if (ok) { pass++; console.log("  ok: " + label); } else { fail++; console.log("  FAIL: " + label + (info ? "  (" + info + ")" : "")); } };
const cnt = (sql, ...a) => Number(sqlite.prepare(sql).get(...a).c);
at("2026-10-28T20:00:00Z");
const card = "card@usc.edu"; let s = (await start(card)).data;
const done = { type: "checkout.session.completed", data: { object: { id: "cs_1", mode: "payment", currency: "usd", payment_status: "paid", amount_total: 21000, payment_intent: "pi_first1", payment_method_types: ["card"], metadata: { code: s.code, kind: "student", save: "1" }, customer: "cus_1", customer_details: { email: card } } } };
const pi = { type: "payment_intent.succeeded", data: { object: { id: "pi_first1", amount: 21000, amount_received: 21000, currency: "usd", status: "succeeded", metadata: { code: s.code, kind: "student" }, customer: "cus_1", payment_method_types: ["card"] } } };
let r = await Promise.all([hook(done), hook(done), hook(pi), hook(done), hook(pi)]);
const sum = sqlite.prepare("SELECT COUNT(*) c, COALESCE(SUM(amount),0) a FROM payments WHERE code=?").get(s.code);
out("card payment: 3 checkout + 2 intent webhooks at once -> one payment row, $210", Number(sum.c) === 1 && Number(sum.a) === 210 && !r.some(x => x.status >= 500), `rows ${sum.c} sum ${sum.a} statuses ${r.map(x => x.status).join(",")} ${r.find(x => x.status >= 500)?.data?.error || ""}`);
out("one saved card", cnt("SELECT COUNT(*) c FROM card_renew") === 1, String(cnt("SELECT COUNT(*) c FROM card_renew")));
at("2026-11-30T20:00:00Z");
r = await Promise.all([api("/pay/tick", {}, PAY), api("/pay/tick", {}, PAY), api("/pay/tick", {}, PAY)]);
const keys = new Set(intents.map(i => i.key));
const sp = sqlite.prepare("SELECT COUNT(*) c, COALESCE(SUM(amount),0) a FROM payments WHERE code=? AND term='20271'").get(s.code);
out("renewal day, 3 ticks at once: Stripe asked with ONE idempotency key, one Spring payment row", keys.size === 1 && !keys.has(null) && Number(sp.c) === 1 && !r.some(x => x.status >= 500), `intents ${intents.length} keys ${[...keys].join(",")} rows ${sp.c} sum ${sp.a} statuses ${r.map(x => x.status).join(",")} ${r.find(x => x.status >= 500)?.data?.error || ""}`);
const rm = MAILS.filter(m => m.to === card && /renew/i.test(m.subject));
out("one 'renewed' email", rm.length === 1, rm.length + " " + rm.map(m => m.subject).join(" | "));
globalThis.Date = RealDate;
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
