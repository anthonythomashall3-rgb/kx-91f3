// Sweep 24, the pay page in a REAL browser (headless Chromium via Playwright; skipped where it is not installed).
// Real API (in-memory SQLite), Stripe mocked: back from the card checkout the page says "paid" at once, with no
// notice from Stripe; a second click on Pay lands on the paid page; a typed email's card button says it renews.
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
let chromium; try { ({ chromium } = createRequire(import.meta.url)("playwright")); } catch { console.log("RESULT: 0 passed, 0 failed (skipped: no playwright)"); process.exit(0); }
import { payT } from "./pay_t.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare"), PUB = join(CF, "public");
const tmp = mkdtempSync(join(tmpdir(), "lqz-s24p-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch (e) {} }
const db = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
  const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
    first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
    run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } }; return o; },
  async batch(sts) { for (const s of sts) s._run(); } };
const env = { DB: db, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", STUDENT_FEE: "180", STUDENT_FEE_FROM: "2026-10-25", ZELLE_TO: "(858) 900-4347", VENMO_HANDLE: "LOCKqz", STUDENT_VENMO: "1",
  STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", STUDENT_CARD_PRICE: "210", TAX_RATE: "0.25", TAX_FROM: "2026-10-26T13:00:00Z", STUDENT_TOTAL: "200", STUDENT_OTHER_TOTAL: "210", STUDENT_OTHER_PRICE: "210" };
// Stripe: sessions LOCKqz made, in the state the test gives them. The checkout page itself is a stand-in.
const made = new Map(); let n = 0; const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init = {}) => {
  u = String(u);
  if (u === "https://api.stripe.com/v1/checkout/sessions" && init.method === "POST") {
    const f = new URLSearchParams(String(init.body)), id = "cs_" + (++n);
    made.set(id, { id, url: "https://checkout.stripe.com/c/pay/" + id, success_url: f.get("success_url"), status: "open", payment_status: "unpaid", mode: "payment", currency: "usd", amount_total: Number(f.get("line_items[0][price_data][unit_amount]")),
      payment_intent: "pi_" + n, payment_method_types: ["card"], metadata: { code: f.get("metadata[code]") }, customer_details: { email: f.get("customer_email") } });
    return new Response(JSON.stringify(made.get(id)), { status: 200 });
  }
  const m = /^https:\/\/api\.stripe\.com\/v1\/checkout\/sessions\/(cs_\d+)(\/expire)?$/.exec(u);
  if (m) { const s = made.get(m[1]); if (m[2] && s.status === "open") s.status = "expired"; return new Response(JSON.stringify(s), { status: 200 }); }
  if (u.startsWith("https://api.stripe.com/")) return new Response(JSON.stringify({ error: { message: "not mocked" } }), { status: 400 });
  return realFetch(u, init);
};
const FILES = { "/lq.js": ["lq.js", "application/javascript"], "/pay": ["pay.html", "text/html"], "/icon128.png": ["icon128.png", "image/png"] };
const browser = await chromium.launch();
const calls = [];
async function page() {
  const c = await browser.newContext();
  await c.route("**/*", async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.host === "lockqz.com" && u.pathname.startsWith("/api/")) {
      calls.push(u.pathname.slice(4));
      const h = { ...req.headers() }; delete h["content-length"];
      const res = await onRequest({ request: new Request(req.url().replace("://lockqz.com/", "://lockqz.pages.dev/"), { method: req.method(), headers: h, body: ["GET", "HEAD", "OPTIONS"].includes(req.method()) ? undefined : req.postDataBuffer() }), env });
      return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
    }
    if (u.host === "lockqz.com" && FILES[u.pathname]) return route.fulfill({ status: 200, contentType: FILES[u.pathname][1], body: readFileSync(join(PUB, FILES[u.pathname][0])) });
    // The card checkout stand-in: a page that only knows where to send the payer back.
    if (u.host === "checkout.stripe.com") return route.fulfill({ status: 200, contentType: "text/html", body: "<title>checkout</title>" });
    return route.fulfill({ status: 404, body: "" });
  });
  const p = await c.newPage(); const errs = []; p.on("pageerror", e => errs.push(String(e)));
  return { p, errs, c };
}
const shown = (p, id) => p.evaluate(i => { const e = document.getElementById(i); return !!e && !e.hidden && e.offsetParent !== null; }, id);
const until = async (f, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return Date.now() - t; await new Promise(r => setTimeout(r, 50)); } return -1; };
const link = e => `https://lockqz.com/pay?email=${encodeURIComponent(e)}&t=${payT(env, e)}`;

console.log("B1 own pay link: Pay by card -> checkout -> back on the page, paid at once (no notice from Stripe)");
{ const { p, errs, c } = await page();
  await p.goto(link("al@usc.edu")); await until(() => shown(p, "card"));
  await p.click("#card"); await until(() => shown(p, "cgo"));
  check("card button: $210, renews each semester", /Pay \$210 by card · renews each semester/.test(await p.textContent("#cgo")), await p.textContent("#cgo"));
  await p.click("#cgo"); await p.waitForURL(/checkout\.stripe\.com/);
  const s = made.get("cs_1"); Object.assign(s, { status: "complete", payment_status: "paid" });   // the card is charged
  const t0 = Date.now(); await p.goto(s.success_url);
  const ms = await until(() => shown(p, "done"));
  check("'you're paid' on the first answer (under 1.5 s), pay options gone", ms >= 0 && Date.now() - t0 < 1500 && !(await shown(p, "pay")), "ms=" + ms);
  check("access-until date and keep-installed line shown", await shown(p, "untilp") && await shown(p, "keep"));
  check("one payment recorded", sqlite.prepare("SELECT COUNT(*) AS n FROM payments WHERE txn='stripe:pi_1'").get().n === 1);
  check("no page errors", errs.length === 0, errs.join(" | ")); await c.close(); }

console.log("B2 the charge lands a moment after the page is back: the fast checks catch it within seconds");
{ const { p, errs, c } = await page();
  await p.goto(link("bo@usc.edu")); await until(() => shown(p, "card")); await p.click("#card"); await p.click("#cgo"); await p.waitForURL(/checkout\.stripe\.com/);
  const s = made.get("cs_2");
  await p.goto(s.success_url); await until(() => shown(p, "pay"));
  check("not paid yet: 'Processing your payment' shows", /Processing your payment/.test(await p.textContent("#wait")), await p.textContent("#wait"));
  await new Promise(r => setTimeout(r, 2200)); Object.assign(s, { status: "complete", payment_status: "paid" });
  const ms = await until(() => shown(p, "done"), 8000);
  check("paid within 4 s of the charge (1.5 s checks)", ms >= 0 && ms < 4000, "ms=" + ms);
  check("no page errors", errs.length === 0, errs.join(" | ")); await c.close(); }

console.log("B3 typed email (no link): renews wording on the card button; back from checkout = paid at once");
{ const { p, errs, c } = await page();
  await p.goto("https://lockqz.com/pay"); await p.fill("#em", "cy@usc.edu"); await p.click("#f button"); await until(() => shown(p, "card"));
  await p.click("#card");
  check("card button says it renews", /renews each semester/.test(await p.textContent("#cgo")), await p.textContent("#cgo"));
  await p.click("#cgo"); await p.waitForURL(/checkout\.stripe\.com/);
  const s = made.get("cs_3"); Object.assign(s, { status: "complete", payment_status: "paid" });
  check("return address carries no owner key", !/[?&]t=/.test(s.success_url) && /stripe=card$/.test(s.success_url), s.success_url);
  await p.goto(s.success_url);
  check("paid at once", (await until(() => shown(p, "done"))) >= 0);
  check("no page errors", errs.length === 0, errs.join(" | ")); await c.close(); }

console.log("B4 the page was left open on the pay options; the card was charged in another tab; Pay is clicked again");
{ const { p, errs, c } = await page();
  await p.goto(link("di@usc.edu")); await until(() => shown(p, "card")); await p.click("#card");
  const r = await (await onRequest({ request: new Request("https://lockqz.pages.dev/api/pay/stripe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "di@usc.edu", method: "card", t: payT(env, "di@usc.edu") }) }), env })).json();
  Object.assign(made.get(r.url.split("/").pop()), { status: "complete", payment_status: "paid" });
  await new Promise(r => setTimeout(r, 2100));
  const before = n; await p.click("#cgo");
  check("no second checkout; the page turns to 'you're paid'", (await until(() => shown(p, "done"))) >= 0 && n === before && /lockqz\.com\/pay/.test(p.url()), p.url() + " n=" + n);
  check("no page errors", errs.length === 0, errs.join(" | ")); await c.close(); }

console.log("B5 paying by Zelle: after the memo is copied the page checks every 8 s");
{ const { p, errs, c } = await page();
  await p.goto(link("ed@usc.edu")); await until(() => shown(p, "zelle")); await p.click("#zelle");
  calls.length = 0; await p.click("#zcopy");
  const code = await p.textContent("#code");
  await new Promise(r => setTimeout(r, 1000));
  sqlite.prepare("INSERT INTO payments (txn,code,amount,via,payer,note,term,received_at) VALUES ('zelle:x1',?,200,'zelle','','',(SELECT '20263'),?)").run(code, new Date().toISOString());
  const ms = await until(() => shown(p, "done"), 10000);
  check("Zelle matched -> paid shown within 9 s", ms >= 0 && ms < 9000, "ms=" + ms + " calls=" + calls.join(","));
  check("no page errors", errs.length === 0, errs.join(" | ")); await c.close(); }

await browser.close();
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
