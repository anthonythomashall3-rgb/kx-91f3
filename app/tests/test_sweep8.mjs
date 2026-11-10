import { withPayT, payT } from "./pay_t.mjs";
// Bug sweep 8 (10 Nov 2026), real API on in-memory SQLite (production prices), Stripe and email mocked:
//   S1 a saved card is never billed for the next term sooner than 7 days after it last paid -- the date the
//      account page shows. (A student who paid for Fall by card on Dec 1 was charged for Spring within the hour.)
//   S2 a PARTIAL Stripe refund keeps what LOCKqz still holds (was: the whole payment voided); a full refund voids.
//   S3 a held unlock is answered (hold:true) even when D1's daily writes are used up (finals week, free plan).
//   S4 the download page's account panel tries again when reopened after a failed load (real Chromium).
//   S5 the support / privacy email address is plain text (Cloudflare's email obfuscation skipped).
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const CF = join(HERE, "..", "cloudflare"), PUB = join(CF, "public");
const tmp = mkdtempSync(join(tmpdir(), "lqz-sweep8-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
// The clock: Date.now() and new Date() follow at() while a section moves time; real time otherwise.
const RealDate = Date; let fakeNow = null;
class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fakeNow ?? RealDate.now()); } static now() { return fakeNow ?? RealDate.now(); } }
globalThis.Date = FakeDate;
const at = iso => { fakeNow = iso == null ? null : RealDate.parse(iso); };

let writeCap = false;   // S3: D1's daily row writes used up
function d1(sqlite) {
  const mk = sql => { const st = sqlite.prepare(sql); let args = [];
    const s = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return s; },
      first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
      run: async () => { if (writeCap && !/^\s*SELECT/i.test(sql)) throw new Error("D1_ERROR: Exceeded D1 daily row write limit"); return { meta: { changes: Number(st.run(...args).changes) } }; },
      _run() { st.run(...args); } };
    return s; };
  return { prepare: mk, async batch(sts) { if (writeCap) throw new Error("D1_ERROR: Exceeded D1 daily row write limit");
    sqlite.exec("BEGIN"); try { for (const s of sts) s._run(); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; } return []; } };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch {} }
const one = (sql, ...a) => sqlite.prepare(sql).get(...a);
const MAILS = [], WH = "whsec_s8_0123456789abcdef", SECRET = "pay-secret-s8-0123456789";
// Production's prices and ways (wrangler.toml), fee on.
const env = { DB: d1(sqlite), TEACHER_KEY: "admin-key-s8", REQUIRE_SIGNED: "1", ADMIN_EMAIL: "admin@usc.edu", ROT_SECRET: "rot-s8", LIVE_CACHE_MS: "0", PAID_CACHE_MS: "0",
  PAY_SECRET: SECRET, MAIL_SINK: async m => { MAILS.push(m); return true; },
  STUDENT_FEE: "180", STUDENT_FEE_FROM: "2000-01-01", STUDENT_TOTAL: "200", STUDENT_OTHER_TOTAL: "210", STUDENT_OTHER_PRICE: "210", STUDENT_CARD_PRICE: "210",
  STUDENT_OTHER_TOTAL_PREV: "200", STUDENT_OTHER_FROM: "2026-11-08T20:00:00Z", TAX_RATE: "0.25", TAX_FROM: "2026-10-26T13:00:00Z",
  PROF_TOTAL: "6500", PROF_CARD_TOTAL: "6500", PROF_ZELLE_TOTAL: "6300", PROF_BANK_TOTAL: "6500", ZELLE_TO: "(858) 900-4347", VENMO_HANDLE: "LOCKqz",
  STUDENT_VENMO: "1", STRIPE_SECRET_KEY: "sk_test_s8", STRIPE_WEBHOOK_SECRET: WH, INVOICE_EMAIL: "support@lockqz.com", REQUIRE_GATE: "1" };
const BASE = "https://lockqz.test";
const sign = (key, path, ts, raw) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(raw).digest("hex")}`).digest("hex");
async function call(path, body, { teacher = null, dev = null, get = false, ip = "10.0.8.9" } = {}) {
  body = withPayT(path, body, env);
  const raw = JSON.stringify(body ?? {});
  const h = { "Content-Type": "application/json", "CF-Connecting-IP": ip };
  if (teacher) h["X-LOCKqz-Teacher"] = teacher;
  if (dev) { const ts = String(Math.floor(Date.now() / 1000)); h["X-LOCKqz-Device"] = dev.id; h["X-LOCKqz-Time"] = ts; h["X-LOCKqz-Sig"] = sign(dev.key, "/api" + path.replace(/\?.*/, ""), ts, raw); }
  const res = await onRequest({ request: new Request(BASE + "/api" + path, { method: get ? "GET" : "POST", headers: h, body: get ? undefined : raw }), env });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const tick = () => onRequest({ request: new Request(BASE + "/api/pay/tick", { method: "POST", headers: { "X-LOCKqz-Pay": SECRET } }), env }).then(r => r.json());
const hook = async ev => { const raw = JSON.stringify(ev), ts = Math.floor(Date.now() / 1000), v1 = createHmac("sha256", WH).update(`${ts}.${raw}`).digest("hex");
  const res = await onRequest({ request: new Request(BASE + "/api/pay/stripe/webhook", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${ts},v1=${v1}` }, body: raw }), env });
  return { status: res.status, data: await res.json().catch(() => null) }; };

// ---- Stripe mock: Checkout sessions, the saved card's PaymentIntent, off-session renewal charges ----
const intents = [];
globalThis.fetch = async (u, init = {}) => {
  u = String(u);
  if (u.startsWith("https://api.stripe.com/v1/checkout/sessions")) return new Response(JSON.stringify({ id: "cs_" + Math.random().toString(36).slice(2), url: "https://checkout.stripe.com/c/pay/x" }), { status: 200 });
  if (u.startsWith("https://api.stripe.com/v1/payment_intents/pi_"))
    return new Response(JSON.stringify({ id: u.split("/").pop().split("?")[0], payment_method: { id: "pm_card1", type: "card", card: { brand: "visa", last4: "4242" } } }), { status: 200 });
  if (u === "https://api.stripe.com/v1/payment_intents" && init.method === "POST") {
    const f = new URLSearchParams(String(init.body)); intents.push(f);
    const id = "pi_renew" + intents.length, amount = Number(f.get("amount"));
    return new Response(JSON.stringify({ id, status: "succeeded", amount, amount_received: amount, metadata: Object.fromEntries([...f].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])) }), { status: 200 }); }
  if (u.startsWith("https://api.stripe.com/")) return new Response("{}", { status: 200 });
  throw new Error("unexpected fetch " + u);
};
const payStart = em => call("/pay/start", { email: em, t: payT(env, em) });
// A student pays this term by card through Checkout (card saved for auto-renew).
async function cardPay(em, cents) {
  const code = (await payStart(em)).data?.code, pi = "pi_" + randomBytes(5).toString("hex");
  await call("/pay/stripe", { email: em, method: "card", t: payT(env, em) });
  const r = await hook({ type: "checkout.session.completed", data: { object: { id: "cs_" + pi, mode: "payment", currency: "usd", payment_status: "paid", amount_total: cents,
    payment_intent: pi, payment_method_types: ["card"], metadata: { code, kind: "student", save: "1" }, customer: "cus_" + pi.slice(3), customer_details: { email: em } } } });
  return { code, pi, result: r.data?.result };
}
async function account(em) {
  await call("/account", { op: "send", email: em }); const m = MAILS.filter(x => x.to === em).at(-1);
  const t = (await call("/account", { op: "code", email: em, code: m && m.code })).data?.token;
  return (await call("/account", { op: "status", token: t })).data;
}
const chargesFor = em => intents.filter(f => f.get("customer") === one("SELECT customer FROM card_renew WHERE email=?", em)?.customer);

try {
  console.log("S1 a saved card is never billed for the next term sooner than 7 days after it last paid (the account page's date)");
  for (const [label, paidAt, early, due] of [
    ["paid for Fall by card on Dec 1", "2026-12-01T20:00:00Z", ["2026-12-01T21:00:00Z", "2026-12-07T21:00:00Z"], "2026-12-08"],
    ["paid for Fall by card on Nov 30", "2026-11-30T20:00:00Z", ["2026-11-30T21:00:00Z", "2026-12-06T21:00:00Z"], "2026-12-07"],
    ["paid for Fall by card on Nov 25 (armed before the renewal day)", "2026-11-25T20:00:00Z", ["2026-11-25T21:00:00Z", "2026-11-30T21:00:00Z", "2026-12-01T21:00:00Z"], "2026-12-02"]]) {
    const em = "s8-" + randomBytes(3).toString("hex") + "@usc.edu";
    at(paidAt); const p = await cardPay(em, 21000);
    check(`${label}: counted for Fall 2026, card saved`, p.result?.paid === true && p.result.term === "20263" && !!one("SELECT 1 FROM card_renew WHERE email=? AND autorenew=1", em), JSON.stringify(p.result));
    const a = await account(em);
    check(`${label}: the account page says the Spring charge comes on ${due}`, a?.renew?.next_day === due && a.renew.next_term === "Spring 2027", JSON.stringify(a?.renew));
    for (const t of early) { at(t); await tick(); }
    check(`${label}: no second charge before ${due} (was: charged again ${label.includes("Nov 25") ? "on Nov 30" : "within the hour"})`, chargesFor(em).length === 0, chargesFor(em).map(f => f.get("amount")).join(","));
    at(due + "T21:00:00Z"); await tick();
    const ch = chargesFor(em);
    check(`${label}: charged once on ${due}: $210 for Spring 2027`, ch.length === 1 && ch[0].get("amount") === "21000" && ch[0].get("metadata[term]") === "20271", ch.map(f => f.get("amount") + " " + f.get("metadata[term]")).join(","));
    at(due + "T23:00:00Z"); await tick();
    check(`${label}: never twice`, chargesFor(em).length === 1);
  }
  {
    const em = "s8-old@usc.edu";
    at("2026-10-20T20:00:00Z"); await cardPay(em, 21000);
    at("2026-11-30T21:00:00Z"); await tick();
    check("a card that paid in October renews on the renewal day itself (Nov 30), unchanged", chargesFor(em).length === 1 && chargesFor(em)[0].get("metadata[term]") === "20271", String(chargesFor(em).length));
  }
  at(null);

  console.log("S2 a partial Stripe refund keeps what LOCKqz still holds; a full refund voids");
  {
    const em = "s8-part@usc.edu", p = await cardPay(em, 21000);
    let r = await hook({ type: "charge.refunded", data: { object: { id: "ch_1", payment_intent: p.pi, amount: 21000, amount_refunded: 1000, refunded: false } } });
    const row = one("SELECT amount, matched FROM payments WHERE txn=?", "stripe:" + p.pi);
    check("$10 of $210 refunded: the payment now counts $200, not voided (was: the whole $210 voided)", r.status === 200 && row?.amount === 200 && row.matched !== "void", JSON.stringify({ r: r.data, row }));
    const st = (await payStart(em)).data;
    check("... the pay page shows what is left to pay (no longer paid in full)", st?.paid === false && st.received > 0 && st.received < 180, JSON.stringify({ paid: st?.paid, received: st?.received }));
    check("... auto-renew stays on (only money pulled back in full turns it off)", one("SELECT autorenew FROM card_renew WHERE email=?", em)?.autorenew === 1);
    r = await hook({ type: "charge.refunded", data: { object: { id: "ch_1", payment_intent: p.pi, amount: 21000, amount_refunded: 21000, refunded: true } } });
    check("the rest refunded too: voided, auto-renew off", one("SELECT matched FROM payments WHERE txn=?", "stripe:" + p.pi)?.matched === "void" && one("SELECT autorenew FROM card_renew WHERE email=?", em)?.autorenew === 0, JSON.stringify(r.data));
    const em2 = "s8-full@usc.edu", p2 = await cardPay(em2, 21000);
    await hook({ type: "charge.refunded", data: { object: { id: "ch_2", payment_intent: p2.pi, amount: 21000, amount_refunded: 21000, refunded: true } } });
    check("a full refund voids at once (unchanged)", one("SELECT matched FROM payments WHERE txn=?", "stripe:" + p2.pi)?.matched === "void");
    const em3 = "s8-disp@usc.edu", p3 = await cardPay(em3, 21000);
    await hook({ type: "charge.dispute.created", data: { object: { id: "dp_1", payment_intent: p3.pi, amount: 21000 } } });
    check("a dispute voids (unchanged)", one("SELECT matched FROM payments WHERE txn=?", "stripe:" + p3.pi)?.matched === "void");
  }

  console.log("S3 a held unlock is answered even when D1's daily writes are used up (finals week, free plan)");
  {
    const ADMIN = (await call("/signup", { email: "admin@usc.edu", password: "adminpass1", name: "Anthony Hall" })).data?.token;
    const roster = [{ id: "8001", name: "Pat Prof", email: "p@usc.edu", role: "Instructor" }, { id: "9100", name: "Stu Zero", email: "z0@usc.edu", role: "Student" }];
    await call("/sync", { courses: [{ ou: "500", name: "ECON 203", classlist: roster, quizzes: [] }] }, { teacher: ADMIN });
    const code = (await call("/invite", { email: "p@usc.edu", until: "2099-12-31" }, { teacher: ADMIN })).data?.code;
    const P = (await call("/signup", { email: "p@usc.edu", password: "profpass12", name: "Pat Prof", invite: code })).data?.token;
    await call("/sync", { whoami: { id: "8001" }, courses: [{ ou: "500", name: "ECON 203", classlist: roster, quizzes: [{ qi: "1", name: "Q1", active: true }] }] }, { teacher: P });
    sqlite.prepare("UPDATE quizzes SET gated=1 WHERE ou='500' AND qi='1'").run();
    const d = { id: "mac-s8-hold", key: randomBytes(32).toString("hex") };
    await call("/register", { device_id: d.id, key: d.key, platform: "mac", version: "0.6.14" }, { ip: "10.9.8.1" });
    await call("/report", { event: "lock", quiz_id: "500-1" }, { dev: d });
    check("set-up: gated quiz, device locked", !!one("SELECT 1 FROM locks WHERE device_id=? AND quiz_id='500-1'", d.id));
    const ask = () => call("/report", { event: "unlock", quiz_id: "500-1", detail: { reason: "quiz_left", local: true, ask: true, before_end: true } }, { dev: d });
    let h = await ask();
    check("normal day: the ask is held", h.status === 200 && h.data?.hold === true, JSON.stringify(h));
    writeCap = true; h = await ask(); writeCap = false;
    check("D1 writes used up: still answered hold:true (not server_busy)", h.status === 200 && h.data?.hold === true, `${h.status} ${JSON.stringify(h.data)}`);
    check("... and the lock row is kept", !!one("SELECT 1 FROM locks WHERE device_id=? AND quiz_id='500-1'", d.id));
    writeCap = true; const hb = await call("/report", { event: "quiz_left", quiz_id: "500-1" }, { dev: d }); writeCap = false;
    check("other reports with D1 writes used up still answer server_busy (unchanged)", hb.status === 503, String(hb.status));
  }

  console.log("S5 the support / privacy email address is plain text (Cloudflare email obfuscation skipped)");
  {
    const sup = readFileSync(join(PUB, "support.html"), "utf8"), pri = readFileSync(join(PUB, "privacy.html"), "utf8");
    check("support.html: the address shown + copied is wrapped in email_off", /<!--email_off--><b id="addr">support@lockqz\.com<\/b><!--\/email_off-->/.test(sup));
    check("privacy.html: the contact link is wrapped in email_off", /<!--email_off--><a href="mailto:support@lockqz\.com">support@lockqz\.com<\/a><!--\/email_off-->/.test(pri));
  }

  console.log("S4 the account panel tries again when reopened after a failed load (real Chromium)");
  let chromium = null; try { ({ chromium } = createRequire(import.meta.url)("playwright")); } catch {}
  if (!chromium) console.log("  skipped: no playwright");
  else {
    const browser = await chromium.launch();
    try {
      const c = await browser.newContext({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" });
      await c.addInitScript(() => { try { localStorage.setItem("lqz_acct", JSON.stringify({ token: "tok", email: "cy@usc.edu", exp: Date.now() + 864e5 })); } catch {} });
      let down = true, statusCalls = 0;
      await c.route("**/*", async route => {
        const u = new URL(route.request().url());
        if (u.pathname === "/api/account") { statusCalls++; if (down) return route.abort("internetdisconnected");
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ email: "cy@usc.edu", required: true, paid: true, term: "Fall 2026", until: "2026-12-16", renew: null, devices: [] }) }); }
        if (u.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(join(PUB, "index.html")) });
        if (u.pathname === "/account.js") return route.fulfill({ status: 200, contentType: "application/javascript", body: readFileSync(join(PUB, "account.js")) });
        if (u.pathname === "/lq.js") return route.fulfill({ status: 200, contentType: "application/javascript", body: readFileSync(join(PUB, "lq.js")) });
        return route.fulfill({ status: 404, body: "" });
      });
      const pg = await c.newPage(); const errs = []; pg.on("pageerror", e => errs.push(e.message));
      await pg.goto("https://lockqz.com/"); await pg.waitForSelector("#lqgearbtn");
      await pg.click("#lqgearbtn"); await pg.waitForFunction(() => /No connection/.test(document.querySelector("#lqm-acc")?.textContent || ""), null, { timeout: 8000 }).catch(() => {});
      check("set-up: no connection -> the panel says so", /No connection/.test(await pg.textContent("#lqm-acc")), await pg.textContent("#lqm-acc"));
      await pg.click("#lqgearbtn");   // close
      down = false; await pg.click("#lqgearbtn");   // reopen with the connection back
      await pg.waitForFunction(() => /Paid/.test(document.querySelector("#lqm-acc")?.textContent || ""), null, { timeout: 8000 }).catch(() => {});
      check("reopened with the connection back: loads again and shows Paid (was stuck on 'No connection. Try again.')", /Paid/.test(await pg.textContent("#lqm-acc")) && statusCalls >= 2, `${await pg.textContent("#lqm-acc")} calls=${statusCalls}`);
      check("no script errors", errs.length === 0, errs.join(" | "));
    } finally { await browser.close(); }
  }
} finally { globalThis.Date = RealDate; }

console.log("");
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
