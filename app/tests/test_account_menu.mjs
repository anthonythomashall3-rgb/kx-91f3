// Download page gear icon (Account + Settings) and the pay page's renewal wording, in a REAL browser
// (headless Chromium via Playwright; skipped where Playwright is not installed). Real API (in-memory SQLite),
// email + Stripe mocked. Checks: install steps unchanged, keyboard (Enter / Esc), sign in with the emailed
// code, paid status + Pay link, cancel subscription / turn auto-renew back on with the confirm step, computers (read-only), receipts,
// sign out, storage blocked, phone width (16px gutters, no horizontal scroll).
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
let chromium; try { ({ chromium } = createRequire(import.meta.url)("playwright")); } catch { console.log("RESULT: 0 passed, 0 failed (skipped: no playwright)"); process.exit(0); }
import { payT } from "./pay_t.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare"), PUB = join(CF, "public");
const tmp = mkdtempSync(join(tmpdir(), "lqz-acct-"));
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
const mails = [];
const env = { DB: db, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", MAIL_SINK: async m => { mails.push(m); }, STUDENT_FEE: "180", STUDENT_FEE_FROM: "2026-10-25",
  ZELLE_TO: "(858) 900-4347", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", STUDENT_CARD_PRICE: "200", TAX_RATE: "0.25", TAX_FROM: "2026-10-26T13:00:00Z",
  STUDENT_TOTAL: "240", STUDENT_OTHER_TOTAL: "280", STUDENT_OTHER_PRICE: "200", PAID_CACHE_MS: "0" };
const api = async (path, body) => { const res = await onRequest({ request: new Request("https://lockqz.pages.dev/api" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), env }); return res.json(); };

// cy: paid this term by card (saved card, auto-renew on) and has 2 computers; dee: nothing paid.
const st = await api("/pay/start", { email: "cy@usc.edu", t: payT(env, "cy@usc.edu") });
sqlite.prepare("INSERT INTO payments (txn,code,amount,via,payer,note,term,received_at) VALUES ('stripe:pi_cy',?,280,'stripe-card','','',?,?)").run(st.code, st.term, new Date().toISOString());
sqlite.prepare("INSERT INTO card_renew (email,customer,pm,brand,last4,autorenew,created_at) VALUES ('cy@usc.edu','cus_cy','pm_cy','visa','4242',1,?)").run(new Date().toISOString());
for (const [id, pl] of [["mac-aaa111", "mac"], ["win-bbb222", "windows"]])
  sqlite.prepare("INSERT INTO devices (device_id,student,platform,version,installed_at,last_seen,student_verified) VALUES (?,?,?,?,?,?,1)").run(id, "cy@usc.edu", pl, "0.5.1", new Date().toISOString(), new Date().toISOString());

const FILES = { "/": ["index.html", "text/html"], "/account.js": ["account.js", "application/javascript"], "/lq.js": ["lq.js", "application/javascript"], "/pay": ["pay.html", "text/html"], "/privacy": ["privacy.html", "text/html"] };
const browser = await chromium.launch();
async function ctx(opts = {}, init = null) {
  const c = await browser.newContext(opts);
  if (init) await c.addInitScript(init);
  await c.route("**/*", async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.host === "lockqz.pages.dev" && u.pathname.startsWith("/api/")) {
      const h = { ...req.headers() }; delete h["content-length"];
      const res = await onRequest({ request: new Request(req.url(), { method: req.method(), headers: h, body: ["GET", "HEAD", "OPTIONS"].includes(req.method()) ? undefined : req.postDataBuffer() }), env });
      return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
    }
    if (u.host === "lockqz.pages.dev" && FILES[u.pathname]) return route.fulfill({ status: 200, contentType: FILES[u.pathname][1], body: readFileSync(join(PUB, FILES[u.pathname][0])) });
    if (u.host === "lockqz.pages.dev" && /^\/(install\.(sh|ps1)|download\/)/.test(u.pathname)) return route.fulfill({ status: 200, contentType: "application/octet-stream", body: "x" });
    return route.fulfill({ status: 404, body: "" });
  });
  return c;
}
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await new Promise(r => setTimeout(r, 100)); } return false; };

try {
  console.log("B1 desktop: install steps unchanged, gear top right, keyboard open/close");
  let c = await ctx({ userAgent: MAC, viewport: { width: 1280, height: 800 } });
  let pg = await c.newPage(); const errs = []; pg.on("pageerror", e => errs.push(e.message));
  await pg.goto("https://lockqz.pages.dev/");
  await pg.waitForSelector("#lqgearbtn");
  check("install command still shown (curl ... install.sh | sudo bash)", /curl -fsSL https:\/\/lockqz\.pages\.dev\/install\.sh \| sudo bash/.test(await pg.textContent("#cmd")), await pg.textContent("#cmd"));
  const gb = await pg.locator("#lqgearbtn").boundingBox();
  check("gear in the top-right corner", gb && gb.x + gb.width >= 1280 - 16 - 1 && gb.x + gb.width <= 1280 - 15 && gb.y <= 16, JSON.stringify(gb));
  check("menu closed at first", await pg.locator("#lqmenu").isHidden());
  await pg.keyboard.press("Tab");
  check("Tab reaches the gear first", await pg.evaluate(() => document.activeElement.id) === "lqgearbtn");
  await pg.keyboard.press("Enter");
  check("Enter opens it: Account + Settings, aria-expanded", await pg.locator("#lqmenu").isVisible() && await pg.getAttribute("#lqgearbtn", "aria-expanded") === "true" && /Account[\s\S]*Settings/.test(await pg.textContent("#lqmenu")));
  check("focus moves into the menu (Sign in)", await pg.evaluate(() => document.activeElement.textContent) === "Sign in");
  check("Settings: receipts, privacy /privacy, support mailto", await pg.getAttribute("a.lqm-set >> text=Privacy policy", "href") === "/privacy" && await pg.getAttribute("a.lqm-set >> text=Contact support", "href") === "mailto:lockqz.app@gmail.com" && await pg.isVisible("text=Email me my receipts"));
  await pg.keyboard.press("Escape");
  check("Esc closes and returns focus to the gear", await pg.locator("#lqmenu").isHidden() && await pg.evaluate(() => document.activeElement.id) === "lqgearbtn");

  console.log("B2 receipts before sign-in asks to sign in");
  await pg.click("#lqgearbtn"); await pg.click("#lqm-rcpt");
  check("'Sign in first' + the email box opens", /Sign in first/.test(await pg.textContent("#lqm-rcpt-msg")) && await pg.isVisible("#lqm-em"));

  console.log("B3 sign in with the emailed code (keyboard only)");
  await pg.fill("#lqm-em", "cy@usc.edu"); await pg.keyboard.press("Enter");
  check("code emailed, code box shown", await waitFor(() => pg.isVisible("#lqm-code")) && mails.at(-1)?.to === "cy@usc.edu" && /sign-in code/.test(mails.at(-1).text));
  await pg.fill("#lqm-code", "999999".replace(/./g, (d, i) => String((Number(mails.at(-1).code[i]) + 1) % 10)));
  await pg.keyboard.press("Enter");
  check("wrong code: message, still signed out", await waitFor(async () => /Wrong code/.test(await pg.textContent("#lqm-acc"))));
  await pg.fill("#lqm-code", mails.at(-1).code); await pg.keyboard.press("Enter");
  check("signed in: email + Paid ✓ until <date>", await waitFor(async () => /cy@usc\.edu[\s\S]*Paid ✓[\s\S]*until \w+ \d+, \d{4}/.test(await pg.textContent("#lqm-acc"))), await pg.textContent("#lqm-acc"));
  const ls = await pg.evaluate(() => JSON.parse(localStorage.getItem("lqz_acct") || "null"));
  check("token saved in this browser for 30 days", ls && ls.email === "cy@usc.edu" && Math.abs(ls.exp - Date.now() - 30 * 86400000) < 120000, JSON.stringify(ls));
  check("auto-renew On · Visa •••• 4242 + red Cancel subscription", /Auto-renew:?\s*On\s*· Visa •••• 4242/.test(await pg.textContent("#lqm-acc")) && await pg.isVisible("button.lqm-red >> text=Cancel subscription"), await pg.textContent("#lqm-acc"));
  check("red button is red", /rgb\(198, 40, 40\)/.test(await pg.$eval("button.lqm-red", b => getComputedStyle(b).color)));

  console.log("B4 cancel subscription: confirm step (stops auto-renew only, keeps the term), then turn it back on");
  await pg.click("button.lqm-red >> text=Cancel subscription");
  const cq = await pg.textContent(".lqm-confirm");
  check("confirm says it stops auto-renew only, keeps the semester, and points to the bank for a refund", /stops auto-renew only/.test(cq) && /rest of this semester/.test(cq) && /does not refund the current semester[\s\S]*contact your bank/.test(cq), cq);
  check("still on before confirming", sqlite.prepare("SELECT autorenew FROM card_renew WHERE email='cy@usc.edu'").get().autorenew === 1);
  await pg.click("text=Yes, cancel subscription");
  check("off in the database and on the page; 'Turn auto-renew on' shown", await waitFor(() => pg.isVisible("text=Turn auto-renew on")) && sqlite.prepare("SELECT autorenew FROM card_renew WHERE email='cy@usc.edu'").get().autorenew === 0);
  check("access unchanged after cancelling (still Paid ✓)", /Paid ✓/.test(await pg.textContent("#lqm-acc")));
  await pg.click("text=Turn auto-renew on");
  check("back on", await waitFor(() => pg.isVisible("text=Cancel subscription")) && sqlite.prepare("SELECT autorenew FROM card_renew WHERE email='cy@usc.edu'").get().autorenew === 1);

  console.log("B5 your computers: listed read-only (no remove anywhere)");
  check("2 computers listed (Mac, Windows) with last seen", await pg.locator(".lqm-devs li").count() === 2 && /Mac[\s\S]*last seen[\s\S]*Windows/.test(await pg.textContent(".lqm-devs")));
  check("no Remove control anywhere in the menu", !(await pg.isVisible("text=Remove")), await pg.textContent("#lqm-acc"));
  check("tells the student to email support to free a computer", /email lockqz\.app@gmail\.com/.test(await pg.textContent("#lqm-acc")));
  check("nothing revoked", sqlite.prepare("SELECT COUNT(*) AS n FROM devices WHERE COALESCE(revoked,0)=1").get().n === 0);

  console.log("B6 receipts");
  mails.length = 0; await pg.click("#lqm-rcpt");
  check("'Sent to cy@usc.edu' + email with the card payment", await waitFor(async () => /Sent to cy@usc\.edu/.test(await pg.textContent("#lqm-rcpt-msg"))) && /\$280\s+Card/.test(mails.at(-1)?.text || ""), mails.at(-1)?.text);

  console.log("B7 reload keeps the sign-in; sign out forgets it");
  await pg.reload(); await pg.click("#lqgearbtn");
  check("still signed in after reload", await waitFor(async () => /cy@usc\.edu[\s\S]*Paid ✓/.test(await pg.textContent("#lqm-acc"))));
  await pg.click("#lqm-acc >> text=Sign out");
  check("signed out: Sign in shown, storage cleared", await pg.isVisible("#lqm-acc >> text=Sign in") && await pg.evaluate(() => localStorage.getItem("lqz_acct")) === null);
  check("no page errors", errs.length === 0, errs.join(" | "));
  await c.close();

  console.log("B8 not paid: Pay link is the signed pay link; storage blocked still works for the tab");
  c = await ctx({ userAgent: MAC, viewport: { width: 1280, height: 800 } }, () => { Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } }); });
  pg = await c.newPage(); const errs2 = []; pg.on("pageerror", e => errs2.push(e.message));
  await pg.goto("https://lockqz.pages.dev/");
  check("storage blocked: install steps still shown", /install\.sh/.test(await pg.textContent("#cmd")));
  await pg.click("#lqgearbtn"); await pg.click("#lqm-acc >> text=Sign in");
  await pg.fill("#lqm-em", "dee@usc.edu"); await pg.click("text=Email me a code");
  await waitFor(() => pg.isVisible("#lqm-code"));
  await pg.fill("#lqm-code", mails.at(-1).code); await pg.click("#lqm-acc button[type=submit]");
  check("Not paid + Pay link to /pay?email=…&t=<token>", await waitFor(async () => /Not paid/.test(await pg.textContent("#lqm-acc"))) && (await pg.getAttribute("a.lqm-pay", "href")) === `https://lockqz.pages.dev/pay?email=dee%40usc.edu&t=${payT(env, "dee@usc.edu")}`, await pg.getAttribute("a.lqm-pay", "href").catch(() => ""));
  check("no saved card: Auto-renew Off, no cancel button", /Auto-renew:?\s*Off/.test(await pg.textContent("#lqm-acc")) && !(await pg.isVisible("text=Cancel subscription")));
  check("no page errors with storage blocked", errs2.length === 0, errs2.join(" | "));

  console.log("B9 pay page: the card renewal said plainly on the button and next to the price");
  await pg.click("a.lqm-pay"); await pg.waitForSelector("#card:not([hidden])");
  await pg.click("#card");
  const btxt = await pg.textContent("#cgo"), line = await pg.textContent("#crenew");
  check("button: 'Pay $280 by card · renews each semester'", btxt === "Pay $280 by card · renews each semester", btxt);
  check("line: 'Renews automatically each semester at $280. Cancel anytime: gear icon → Account.'", line === "Renews automatically each semester at $280. Cancel anytime: gear icon → Account.", line);
  const sty = await pg.$eval("#crenew", e => { const s = getComputedStyle(e); return { fs: parseFloat(s.fontSize), c: s.color, v: e.offsetParent !== null }; });
  check("line is normal body text (16px, near-black), visible", sty.v && sty.fs >= 16 && sty.c === "rgb(17, 17, 17)", JSON.stringify(sty));
  await c.close();

  console.log("B10 phone width: 16px gutters, no horizontal scroll, menu inside the screen");
  c = await ctx({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", viewport: { width: 360, height: 700 }, hasTouch: true, isMobile: true });
  pg = await c.newPage();
  await pg.goto("https://lockqz.pages.dev/"); await pg.click("#lqgearbtn");
  await pg.click("#lqm-acc >> text=Sign in");
  const mb = await pg.locator("#lqmenu").boundingBox(), sw = await pg.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  check("menu between 16px gutters", mb && mb.x >= 15.5 && mb.x + mb.width <= 360 - 15.5, JSON.stringify(mb));
  check("no horizontal scroll", sw[0] <= sw[1], JSON.stringify(sw));
  check("phone: email field usable (>= 44px tall)", ((await pg.locator("#lqm-em").boundingBox()) || {}).height >= 44);
  await c.close();
} finally { await browser.close(); }
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
