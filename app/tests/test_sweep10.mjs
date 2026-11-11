// Bug sweep 10 (11 Nov 2026), real API on in-memory SQLite whose every call yields first (like the hop to D1),
// so requests sent at the same moment really interleave:
//   R1 two sign-ups for one email at the same moment (a double click): one account; the others are told the
//      account exists (409) -- was a 500 "UNIQUE constraint failed".
//   R2 the same things done several times at once keep one row each: a student's memo code, a professor's memo,
//      one Zelle payment reported 6 times, one card payment's 5 webhooks.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac } from "node:crypto";
import { payT } from "./pay_t.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-sweep10-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch {} }
const hop = () => new Promise(r => setTimeout(r, Math.random() * 3));
const db = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
  const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
    first: async () => { await hop(); return st.get(...args) ?? null; }, all: async () => { await hop(); return { results: st.all(...args) }; },
    run: async () => { await hop(); return { meta: { changes: Number(st.run(...args).changes) } }; }, _run() { st.run(...args); } }; return o; },
  async batch(sts) { await hop(); sqlite.exec("BEGIN"); try { for (const s of sts) s._run(); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; } return []; } };
const WH = "whsec_s10", SECRET = "pay-secret-s10-0123456789";
const env = { DB: db, TEACHER_KEY: "admin-key-s10", ADMIN_EMAIL: "admin@usc.edu", ROT_SECRET: "rot-s10", PAID_CACHE_MS: "0", PAY_SECRET: SECRET, MAIL_SINK: async () => true,
  STUDENT_FEE: "180", STUDENT_FEE_FROM: "2000-01-01", STUDENT_TOTAL: "200", STUDENT_OTHER_TOTAL: "210", STUDENT_OTHER_PRICE: "210", STUDENT_CARD_PRICE: "210", TAX_RATE: "0.25", TAX_FROM: "2026-10-26T13:00:00Z",
  PROF_TOTAL: "6500", PROF_CARD_TOTAL: "6500", PROF_ZELLE_TOTAL: "6300", PROF_BANK_TOTAL: "6500", PROF_OTHER_PRICE: "5000", ZELLE_TO: "(858) 900-4347", VENMO_HANDLE: "LOCKqz", STUDENT_VENMO: "1",
  STRIPE_SECRET_KEY: "sk_test", STRIPE_WEBHOOK_SECRET: WH };
globalThis.fetch = async u => new Response(JSON.stringify(String(u).includes("/payment_intents/") ? { id: "pi_1", payment_method: { id: "pm_1", type: "card", card: { brand: "visa", last4: "4242" } } } : { id: "cs_1", url: "https://checkout.stripe.com/x" }), { status: 200 });
let ipN = 0;
async function call(path, body, { teacher = null, pay = false, get = false } = {}) {
  const h = { "Content-Type": "application/json", "CF-Connecting-IP": "10.10." + ((++ipN >> 8) & 255) + "." + (ipN & 255) };
  if (teacher) h["X-LOCKqz-Teacher"] = teacher; if (pay) h["X-LOCKqz-Pay"] = SECRET;
  try { const res = await onRequest({ request: new Request("https://lockqz.test/api" + path, { method: get ? "GET" : "POST", headers: h, body: get ? undefined : JSON.stringify(body ?? {}) }), env, waitUntil: () => {} });
    return { status: res.status, data: await res.json().catch(() => null) }; }
  catch (e) { return { status: 599, data: { error: "THROWN " + String(e && e.message || e).slice(0, 120) } }; }
}
const hook = async ev => { const raw = JSON.stringify(ev), ts = Math.floor(Date.now() / 1000), v1 = createHmac("sha256", WH).update(`${ts}.${raw}`).digest("hex");
  try { const res = await onRequest({ request: new Request("https://lockqz.test/api/pay/stripe/webhook", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${ts},v1=${v1}` }, body: raw }), env }); return { status: res.status }; }
  catch (e) { return { status: 599, error: String(e && e.message || e) }; } };
const many = (n, f) => Promise.all(Array.from({ length: n }, (_, i) => f(i)));
const cnt = (sql, ...a) => Number(sqlite.prepare(sql).get(...a).c);
const sts = r => r.map(x => x.status).sort().join(",");

try {
  console.log("R1 sign-ups for one email at the same moment");
  let r = await many(5, () => call("/signup", { email: "admin@usc.edu", password: "adminpass1", name: "Anthony Hall" }));
  check("5 at once (first account): one 200, four 409 'already has an account', no 5xx (was 500 x4)", sts(r) === "200,409,409,409,409" && r.filter(x => x.status === 409).every(x => /already has an account/.test(x.data?.error || "")) && cnt("SELECT COUNT(*) c FROM teachers") === 1, sts(r) + " " + (r.find(x => x.status >= 500)?.data?.error || ""));
  const inv = (await call("/invite", { email: "p10@usc.edu" }, { teacher: env.TEACHER_KEY })).data?.code;
  r = await many(5, () => call("/signup", { email: "p10@usc.edu", password: "profpass12", name: "Pat Prof", invite: inv }));
  const win = r.filter(x => x.status === 200);
  check("5 at once with one invite: one account, no 5xx", win.length >= 1 && !r.some(x => x.status >= 500) && cnt("SELECT COUNT(*) c FROM teachers WHERE email='p10@usc.edu'") === 1, sts(r) + " " + (r.find(x => x.status >= 500)?.data?.error || ""));
  const P = win[win.length - 1]?.data?.token, me = await call("/me", null, { teacher: P, get: true });
  check("the account works (its token signs in)", me.status === 200 && me.data?.email === "p10@usc.edu", JSON.stringify(me.data));

  console.log("R2 the same thing several times at once keeps one row");
  const em = "s10@usc.edu";
  r = await many(8, () => call("/pay/start", { email: em, t: payT(env, em) }));
  check("8 pay-page loads at once: one memo code", new Set(r.map(x => x.data?.code)).size === 1 && !!r[0].data?.code && cnt("SELECT COUNT(*) c FROM pay_codes_students WHERE email=?", em) === 1, [...new Set(r.map(x => x.status + ":" + x.data?.code))].join(","));
  const code = r[0].data.code;
  r = await many(6, () => call("/pay/notify", { payments: [{ txn: "s10-z1", amount: 200, payer: "P", note: code, via: "zelle" }] }, { pay: true }));
  const st = (await call("/pay/start", { email: em, t: payT(env, em) })).data;
  check("one Zelle payment reported 6 times at once: one row, counted once, student paid", sts(r) === "200,200,200,200,200,200" && cnt("SELECT COUNT(*) c FROM payments WHERE code=?", code) === 1 && st?.paid === true && Number(st.received) === 180, sts(r) + " rows " + cnt("SELECT COUNT(*) c FROM payments WHERE code=?", code) + " received " + st?.received);
  r = await many(6, () => call("/my-sections", null, { teacher: P, get: true }));
  check("6 dashboard loads at once: one professor memo", new Set(r.map(x => x.data?.memo)).size === 1 && !!r[0].data?.memo && cnt("SELECT COUNT(*) c FROM pay_codes") === 1, [...new Set(r.map(x => x.status + ":" + x.data?.memo))].join(","));
  const em2 = "c10@usc.edu", c2 = (await call("/pay/start", { email: em2, t: payT(env, em2) })).data?.code;
  const done = { type: "checkout.session.completed", data: { object: { id: "cs_1", mode: "payment", currency: "usd", payment_status: "paid", amount_total: 21000, payment_intent: "pi_1", payment_method_types: ["card"], metadata: { code: c2, kind: "student", save: "1" }, customer: "cus_1", customer_details: { email: em2 } } } };
  const pi = { type: "payment_intent.succeeded", data: { object: { id: "pi_1", amount: 21000, amount_received: 21000, currency: "usd", status: "succeeded", metadata: { code: c2, kind: "student" }, customer: "cus_1", payment_method_types: ["card"] } } };
  r = await Promise.all([hook(done), hook(done), hook(pi), hook(done), hook(pi)]);
  const sum = sqlite.prepare("SELECT COUNT(*) c, COALESCE(SUM(amount),0) a FROM payments WHERE code=?").get(c2);
  check("one card payment's 5 webhooks at once: one $210 row, one saved card, no 5xx", Number(sum.c) === 1 && Number(sum.a) === 210 && cnt("SELECT COUNT(*) c FROM card_renew WHERE email=?", em2) === 1 && !r.some(x => x.status >= 500), `rows ${sum.c} sum ${sum.a} ${sts(r)}`);
} catch (e) { fail++; console.log("  FAIL: threw", e && e.stack || e); }
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
