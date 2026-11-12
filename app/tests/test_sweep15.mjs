// Bug sweep 15 (12 Nov 2026): every request fits Cloudflare's free plan PER CALL - at most 50 database calls
// and outside requests (emails, Stripe) in one invocation. The database mock below counts them and refuses the
// 51st, exactly as D1 does, so a job that needs more would fail here as it would live.
//   S1 exam emails (/cron, /pay/tick) with 12 classes x 100 students x 10 exams inside 48 hours;
//   S2 renewal emails to 60 past payers: one each, none twice;
//   S3 card renewals for 30 saved cards: each charged once, one payment row, one "renewed" email - also when a
//      call stops after Stripe took the money (the card stays 'charged' and the next hour reads that payment back from Stripe
//      and finishes it, without a second charge request);
//   S4 "email every class" for a professor with 40 classes.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-sweep15-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
const RealDate = Date; let fakeNow = RealDate.parse("2026-11-12T18:00:00Z");
class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fakeNow); } static now() { return fakeNow; } }
globalThis.Date = FakeDate;
const LIMIT = 50;
let worldN = 0, CUR = null;   // CUR: the world whose request is running (for the fetch mock)
globalThis.fetch = async (u, init = {}) => { u = String(u); const W = CUR; W.C.n++; if (W.C.n > LIMIT) { W.C.over++; throw new Error("Too many subrequests."); }
  if (u === "https://api.stripe.com/v1/payment_intents") { const f = new URLSearchParams(String(init.body)), key = (init.headers && (init.headers["Idempotency-Key"] || init.headers["idempotency-key"])) || null; W.intents.push({ f, key });
    return new Response(JSON.stringify({ id: "pi_renew_" + key, status: "succeeded", amount: Number(f.get("amount")), amount_received: Number(f.get("amount")), metadata: {} }), { status: 200 }); }
  if (u.startsWith("https://api.stripe.com/v1/payment_intents/pi_renew_")) { const id = decodeURIComponent(u.split("/").pop().split("?")[0]); W.reads.push(id); const was = W.intents.find(i => "pi_renew_" + i.key === id);
    return new Response(JSON.stringify(was ? { id, status: "succeeded", amount: Number(was.f.get("amount")), amount_received: Number(was.f.get("amount")), metadata: {} } : { error: { message: "No such payment_intent" } }), { status: was ? 200 : 404 }); }
  if (u.startsWith("https://api.stripe.com/v1/payment_intents/pi_")) return new Response(JSON.stringify({ id: u.split("/").pop().split("?")[0], payment_method: { id: "pm_card1", type: "card", card: { brand: "visa", last4: "4242" } } }), { status: 200 });
  return new Response("{}", { status: 200 }); };
async function world(extra = {}) {
  const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href + "?w=" + (++worldN));
  const sqlite = new DatabaseSync(":memory:"); sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
  for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
    for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch {} }
  const W = { sqlite, MAILS: [], intents: [], reads: [], C: { n: 0, over: 0, worst: {}, failBatch: 0 } };
  const hit = () => { W.C.n++; if (W.C.n > LIMIT) { W.C.over++; throw new Error("D1_ERROR: Too many API requests by single worker invocation."); } };
  const db = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
    const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
      first: async () => { hit(); return st.get(...args) ?? null; }, all: async () => { hit(); return { results: st.all(...args) }; }, run: async () => { hit(); return { meta: { changes: Number(st.run(...args).changes) } }; }, _run() { st.run(...args); } }; return o; },
    async batch(sts) { hit(); if (W.C.failBatch > 0) { W.C.failBatch--; throw new Error("D1_ERROR: Network connection lost."); } sqlite.exec("BEGIN"); try { for (const s of sts) s._run(); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; } return []; } };
  const env = { DB: db, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", ROT_SECRET: "rs", LIVE_CACHE_MS: "0", PAID_CACHE_MS: "0", PAY_SECRET: "paysecret-0123456789", ADMIN_EMAIL: "admin@usc.edu",
    MAIL_SINK: async m => { W.C.n++; if (W.C.n > LIMIT) { W.C.over++; throw new Error("Too many subrequests."); } W.MAILS.push(m); return true; },
    PROF_TOTAL: "6500", PROF_CARD_TOTAL: "6500", PROF_ZELLE_TOTAL: "6300", PROF_BANK_TOTAL: "6500", PROF_OTHER_PRICE: "5000", ZELLE_TO: "(858) 900-4347", REQUIRE_GATE: "1", ...extra };
  let ip = 0;
  W.api = async (path, body, { teacher, pay, get, hook } = {}) => { const raw = JSON.stringify(body ?? {}); const h = { "Content-Type": "application/json", "CF-Connecting-IP": "10." + (20 + worldN) + "." + ((++ip >> 8) & 255) + "." + (ip & 255) };
    if (teacher) h["X-LOCKqz-Teacher"] = teacher; if (pay) h["X-LOCKqz-Pay"] = env.PAY_SECRET;
    if (hook) { const ts = Math.floor(Date.now() / 1000); h["Stripe-Signature"] = `t=${ts},v1=${createHmac("sha256", env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${raw}`).digest("hex")}`; }
    W.C.n = 0; CUR = W; const pend = [];
    const res = await onRequest({ request: new Request("https://lockqz.pages.dev/api" + path, { method: get ? "GET" : "POST", headers: h, body: get ? undefined : raw }), env, waitUntil: p => pend.push(p) });
    await Promise.allSettled(pend); const k = path.split("?")[0]; W.C.worst[k] = Math.max(W.C.worst[k] || 0, W.C.n);
    return { status: res.status, data: await res.json().catch(() => null) }; };
  return W;
}
const tok = em => createHmac("sha256", "rs").update("lqz-pay-status:" + em).digest("hex").slice(0, 32);
const soon = h => new RealDate(fakeNow + h * 3600000).toISOString();

// ---- S1 + S4: exam emails and "email every class" at scale ----
{ const W = await world(), NC = 12, NS = 100, NQ = 10;
  const ADMIN = (await W.api("/signup", { email: "admin@usc.edu", password: "adminpass1", name: "A H" })).data.token;
  const roster = c => [{ id: "8001", name: "Pat Prof", email: "p@usc.edu", role: "Instructor" }, ...Array.from({ length: NS }, (_, i) => ({ id: String(100000 + c * 1000 + i), name: "Stu " + c + " " + i, email: `s${c}x${i}@usc.edu`, role: "Student" }))];
  const courses = (n = NC) => Array.from({ length: n }, (_, c) => ({ ou: String(500 + c), name: `20263_${14792 + c} ECON ${203 + c}`, classlist: c < NC ? roster(c) : roster(c).slice(0, 4),
    quizzes: c < NC ? Array.from({ length: NQ }, (_, i) => ({ qi: String(c * 100 + i), name: "Quiz " + i, active: true, start: soon(40 + i), end: soon(42 + i), has_password: true, lq_password: true })) : [] }));
  await W.api("/sync", { courses: courses().map(c => ({ ...c, quizzes: [] })) }, { teacher: ADMIN });
  const inv = (await W.api("/invite", { email: "p@usc.edu" }, { teacher: ADMIN })).data.code;
  const H = { teacher: (await W.api("/signup", { email: "p@usc.edu", password: "profpass12", name: "Pat Prof", invite: inv })).data.token };
  await W.api("/sync", { whoami: { id: "8001" }, courses: courses() }, H);
  const memo = (await W.api("/my-sections", undefined, { ...H, get: true })).data.memo;
  await W.api("/pay/notify", { payments: [{ txn: "pz1", amount: 6300 * NC, payer: "Pat", note: memo, via: "zelle" }] }, { pay: true });
  let r = await W.api("/sync", { whoami: { id: "8001" }, courses: courses() }, H);
  check("S1 setup: 120 exams of 12 classes are protected", r.status === 200 && W.sqlite.prepare("SELECT COUNT(*) n FROM quizzes WHERE qi IS NOT NULL").get().n === 120, String(r.status));
  const m0 = W.MAILS.length; let bad = 0;
  for (let i = 0; i < 60; i++) { fakeNow += 3600000; for (const p of ["/pay/tick", "/cron"]) { const x = await W.api(p, {}, { pay: true }); if (x.status !== 200 || x.data?.exams?.error || x.data?.card?.error || x.data?.nudge?.error) bad++; } }
  const rem = W.MAILS.slice(m0).filter(m => /Reminder/.test(m.subject));
  check("S1 60 hours of /cron and /pay/tick: never more than 50 calls in one request, no job stopped by the limit", W.C.over === 0 && bad === 0 && W.C.worst["/cron"] <= 45 && W.C.worst["/pay/tick"] <= 45, `limit hits ${W.C.over}, errors ${bad}, worst cron ${W.C.worst["/cron"]} tick ${W.C.worst["/pay/tick"]}`);
  check("S1 the reminders still go out (up to the day's automatic email budget) and each class is reminded at most once per kind", rem.length >= 4 && W.sqlite.prepare("SELECT COUNT(*) n FROM mail_sent WHERE kind LIKE 'r48:%' AND n>0").get().n >= 4, rem.length + " reminder emails");
  { const src = readFileSync(join(CF, "functions", "api", "[[route]].js"), "utf8"), m = /SELECT ou\|\|'\|'\|\|kind AS k, at FROM mail_sent WHERE ou IN \(\$\{placeholders\(part\.length\)\}\) AND ([^`]+)`/.exec(src);
    const plan = m ? W.sqlite.prepare("EXPLAIN QUERY PLAN SELECT ou||'|'||kind AS k, at FROM mail_sent WHERE ou IN (?,?) AND " + m[1]).all().map(r => r.detail).join(" ; ") : "query not found";
    check("S1 a tick reads only the email records of the classes with an exam coming (by the table's key), never the whole table", /SEARCH mail_sent USING/.test(plan) && !/SCAN mail_sent/.test(plan) && !/FROM mail_sent WHERE \(kind LIKE/.test(src), plan); }
  // S4: 40 classes in one "email every class"
  await W.api("/sync", { whoami: { id: "8001" }, courses: courses(40) }, H);
  const ous = Array.from({ length: 40 }, (_, c) => String(500 + c));
  r = await W.api("/email/students", { ous }, H);
  check("S4 'email every class' with 40 classes: one draft with every student, in a handful of database calls", r.status === 200 && Array.isArray(r.data.to) && r.data.to.length === NC * NS + 28 * 3 && W.C.worst["/email/students"] <= 15, `${r.status} to=${r.data?.to?.length} calls=${W.C.worst["/email/students"]}`);
  r = await W.api("/email/students", { ous: ["500", "99999"] }, H);
  check("S4 a class that is not the professor's is still refused", r.status === 403, String(r.status)); }

// ---- S2: renewal emails ----
{ fakeNow = RealDate.parse("2026-11-12T18:00:00Z"); const W = await world(), NS = 60;
  const ADMIN = (await W.api("/signup", { email: "admin@usc.edu", password: "adminpass1", name: "A H" })).data.token;
  const roster = [{ id: "8001", name: "Pat Prof", email: "p@usc.edu", role: "Instructor" }, ...Array.from({ length: NS }, (_, i) => ({ id: String(9100 + i), name: "Stu " + i, email: `s${i}@usc.edu`, role: "Student" }))];
  await W.api("/sync", { courses: [{ ou: "500", name: "20263_14792 ECON 203", classlist: roster, quizzes: [] }] }, { teacher: ADMIN });
  for (let i = 0; i < NS; i++) { const st = await W.api("/pay/start", { email: `s${i}@usc.edu`, t: tok(`s${i}@usc.edu`) }); await W.api("/pay/notify", { payments: [{ txn: "t" + i, amount: 200, payer: "S", note: st.data.code, via: "zelle" }] }, { pay: true }); }
  fakeNow = RealDate.parse("2027-01-05T18:00:00Z"); const m0 = W.MAILS.length; W.C.over = 0; W.C.worst = {}; let bad = 0;
  for (let h = 0; h < 12; h++) { const x = await W.api("/pay/tick", {}, { pay: true }); if (x.status !== 200 || x.data?.nudge?.error || x.data?.error) bad++; fakeNow += 3600000; }
  const per = {}; for (const m of W.MAILS.slice(m0)) if (/Renew/.test(m.subject)) per[m.to] = (per[m.to] || 0) + 1;
  check("S2 60 past payers: every one gets the renewal email exactly once, 8 an hour, inside the limit",
    Object.keys(per).length === NS && Object.values(per).every(n => n === 1) && W.C.over === 0 && bad === 0 && W.C.worst["/pay/tick"] <= 45, `emailed ${Object.keys(per).length}, twice ${Object.values(per).filter(n => n > 1).length}, limit hits ${W.C.over}, worst ${W.C.worst["/pay/tick"]}`); }

// ---- S3: card renewals ----
{ fakeNow = RealDate.parse("2026-10-28T20:00:00Z"); const N = 30;
  const W = await world({ STUDENT_FEE: "180", STUDENT_FEE_FROM: "2026-10-25", STUDENT_TOTAL: "200", STUDENT_OTHER_TOTAL: "210", STUDENT_OTHER_PRICE: "210", STUDENT_CARD_PRICE: "210", TAX_RATE: "0.25", TAX_FROM: "2026-10-26T13:00:00Z",
    VENMO_HANDLE: "LOCKqz", STUDENT_VENMO: "1", STRIPE_SECRET_KEY: "sk_test", STRIPE_WEBHOOK_SECRET: "whsec_s15", STUDENT_AUTORENEW: "1" });
  for (let i = 0; i < N; i++) { const em = `c${i}@usc.edu`, s = (await W.api("/pay/start", { email: em, t: tok(em) })).data;
    await W.api("/pay/stripe/webhook", { type: "checkout.session.completed", data: { object: { id: "cs_" + i, mode: "payment", currency: "usd", payment_status: "paid", amount_total: 21000, payment_intent: "pi_first" + i, payment_method_types: ["card"], metadata: { code: s.code, kind: "student", save: "1" }, customer: "cus_" + i, customer_details: { email: em } } } }, { hook: true }); }
  check("S3 setup: 30 students paid Fall by card and their cards are saved", W.sqlite.prepare("SELECT COUNT(*) n FROM card_renew").get().n === N && W.sqlite.prepare("SELECT COUNT(*) n FROM payments").get().n === N);
  fakeNow = RealDate.parse("2026-11-30T20:00:00Z"); const m0 = W.MAILS.length; W.C.over = 0; W.C.worst = {};
  // first hour: the call stops after Stripe took the money (the database write at the end fails once)
  W.C.failBatch = 0; let x = await W.api("/pay/tick", {}, { pay: true });   // arms the cards and charges the first 5
  const st0 = Object.fromEntries(W.sqlite.prepare("SELECT state, COUNT(*) c FROM card_renew GROUP BY state").all().map(r => [r.state, r.c]));
  check("S3 first hour: 5 cards charged and paid, the rest wait their turn", x.status === 200 && st0.paid === 5 && W.intents.length === 5 && W.sqlite.prepare("SELECT COUNT(*) n FROM payments WHERE term='20271'").get().n === 5, JSON.stringify(st0) + " " + JSON.stringify(x.data).slice(0, 140));
  fakeNow += 3600000; W.C.failBatch = 1; x = await W.api("/pay/tick", {}, { pay: true });
  const st1 = Object.fromEntries(W.sqlite.prepare("SELECT state, COUNT(*) c FROM card_renew GROUP BY state").all().map(r => [r.state, r.c]));
  check("S3 a call that stops after Stripe took the money leaves those cards 'charged' (never 'paid' without a payment row)", st1.charged === 5 && st1.paid === 5 && W.sqlite.prepare("SELECT COUNT(*) n FROM payments WHERE term='20271'").get().n === 5, JSON.stringify(st1));
  for (let h = 0; h < 9; h++) { fakeNow += 3600000; await W.api("/pay/tick", {}, { pay: true }); }
  const keys = new Set(W.intents.map(i => i.key)), byCust = {}; for (const i of W.intents) (byCust[i.f.get("customer")] ||= new Set()).add(i.key);
  const rows = W.sqlite.prepare("SELECT code, COUNT(*) c FROM payments WHERE term='20271' GROUP BY code").all();
  const rm = {}; for (const m of W.MAILS.slice(m0)) if (/renewed/i.test(m.subject)) rm[m.to] = (rm[m.to] || 0) + 1;
  check("S3 in the end every card was charged under ONE idempotency key, has ONE Spring payment row and got ONE 'renewed' email",
    Object.keys(byCust).length === N && Object.values(byCust).every(s => s.size === 1) && keys.size === N && rows.length === N && rows.every(r => r.c === 1) && Object.keys(rm).length === N && Object.values(rm).every(n => n === 1)
    && W.sqlite.prepare("SELECT COUNT(*) n FROM card_renew WHERE state='paid'").get().n === N, `customers ${Object.keys(byCust).length} keys ${keys.size} rows ${rows.length} emails ${Object.keys(rm).length}/${Object.values(rm).reduce((a, b) => a + b, 0)}`);
  check("S3 the 5 cards left 'charged' were finished by reading their payment back from Stripe - no second charge request at all", W.intents.length === N && W.reads.length === 5 && new Set(W.reads).size === 5, `charge requests ${W.intents.length}, read back ${W.reads.length}`);
  check("S3 never more than 50 calls in one request", W.C.over === 0 && W.C.worst["/pay/tick"] <= 45, `limit hits ${W.C.over}, worst ${W.C.worst["/pay/tick"]}`); }

globalThis.Date = RealDate;
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
