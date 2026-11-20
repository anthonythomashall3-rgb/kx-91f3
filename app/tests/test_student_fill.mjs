// The extension on a student's computer, in a REAL Chromium with the built package loaded
// (app/extension-prof/dist/lockqz-prof-chromium.zip): the exam password handed over in the address is
// entered into the exam page's password box, the address is cleaned at once, and the answer is left there.
//   F1 #lqz=<password> on the exam's start page -> the password box holds it; the address says #lqz-in
//   F2 nothing but the password box is touched; a box that arrives later on the page is filled too
//   F3 a box inside a page component (shadow root), and a plain box labelled Password
//   F4 a later page of the same exam is filled with no hand-over; another exam's page is not
//   F5 inside the attempt: never
//   F6 a page with no password box: the address says #lqz-got (LOCKqz then shows the password itself)
//   F7 no Sync key on this computer: nothing is synced, no LOCKqz request is made
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
let chromium;
try { ({ chromium } = require("playwright")); } catch { try { ({ chromium } = require("playwright-core")); } catch { console.log("skipped: playwright is not installed here (set NODE_PATH)"); process.exit(0); } }
let pass = 0, fail = 0;
const check = (name, ok, got) => { if (ok) { pass++; console.log("  ok: " + name); } else { fail++; console.log("  FAIL: " + name + (got !== undefined ? "  -> " + String(got).slice(0, 300) : "")); } };
const tmp = mkdtempSync(join(tmpdir(), "lqz-sfill-"));
const ZIP = join(HERE, "..", "extension-prof", "dist", "lockqz-prof-chromium.zip");
if (!existsSync(ZIP)) { console.log("  FAIL: the Chromium package is not built"); process.exit(1); }
const EXTDIR = join(tmp, "ext"); execFileSync("unzip", ["-q", ZIP, "-d", EXTDIR]);
const man = JSON.parse(readFileSync(join(EXTDIR, "manifest.json"), "utf8"));
check("package: the exam-page script is in it, for the exam's own pages only", existsSync(join(EXTDIR, "content-quiz.js")) && man.content_scripts.some(c => c.js.includes("content-quiz.js") && c.matches.every(m => /\/d2l\/lms\/quizzing\/user\/\*$/.test(m))));

const { createServer } = await import("node:https");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=lqz", "-days", "1", "-keyout", join(tmp, "k.pem"), "-out", join(tmp, "c.pem")], { stdio: "ignore" });
const calls = [];
const PAGE = kind => "<!doctype html><title>Quiz - Brightspace</title><h1>Test Quiz</h1><form onsubmit='return false'>" +
  (kind === "none" ? "" : kind === "text" ? "<label for=p>Quiz Password</label> <input id=p type=text name=qp>" : kind === "shadow" ? "<x-box></x-box>" : kind === "late" ? "<span id=slot></span>" : "<label for=p>Password</label> <input id=p type=password name=p>") +
  " <label for=n>Notes</label> <input id=n type=text name=notes> <input id=s type=search name=q> <button>Start Quiz!</button></form>" +
  "<script>window.seen=[];document.addEventListener('input',function(e){seen.push((e.composedPath()[0]||e.target).id||'?')},true);" +
  (kind === "shadow" ? "customElements.define('x-box',class extends HTMLElement{connectedCallback(){this.setAttribute('label','Password');var r=this.attachShadow({mode:'open'});r.innerHTML='<input id=p type=text>'}});" : "") +
  (kind === "late" ? "setTimeout(function(){document.getElementById('slot').innerHTML='<input id=p type=password name=p>'},2500);" : "") + "</script>";
const server = createServer({ key: readFileSync(join(tmp, "k.pem")), cert: readFileSync(join(tmp, "c.pem")) }, (req, res) => {
  const host = String(req.headers.host || "").split(":")[0], u = new URL("https://" + host + req.url);
  if (host !== "brightspace.usc.edu") { calls.push(host + u.pathname); res.writeHead(204); return res.end(); }
  res.writeHead(200, { "Content-Type": "text/html" }); res.end(PAGE(u.searchParams.get("kind") || ""));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const context = await chromium.launchPersistentContext(join(tmp, "profile"), { channel: "chromium", headless: true, ignoreHTTPSErrors: true,
  args: [`--disable-extensions-except=${EXTDIR}`, `--load-extension=${EXTDIR}`, "--ignore-certificate-errors", "--no-proxy-server",
    `--host-resolver-rules=MAP brightspace.usc.edu 127.0.0.1:${PORT}, MAP professor.lockqz.com 127.0.0.1:${PORT}, MAP lockqz.com 127.0.0.1:${PORT}`] });
const waitFor = async (fn, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await new Promise(r => setTimeout(r, 200)); } return false; };
const START = "https://brightspace.usc.edu/d2l/lms/quizzing/user/quiz_summary.d2l?qi=77&ou=123";
const PW = "LQ-AB12CD34";
const val = (page, deep) => page.evaluate(deep => { const h = document.querySelector("x-box"); const el = deep && h ? h.shadowRoot.querySelector("input") : document.getElementById("p"); return el ? el.value : null; }, deep);
const hash = page => page.evaluate(() => location.hash);
const hand = (page, pw) => page.evaluate(pw => { location.hash = "#lqz=" + encodeURIComponent(pw); }, pw);   // what the LOCKqz app does to the tab's address

console.log("F1 the hand-over on the exam's start page");
const page = await context.newPage(); await page.goto(START);
await page.waitForTimeout(800);
check("before the hand-over nothing is entered", (await val(page)) === "" && (await hash(page)) === "");
await hand(page, PW);
check("the password box holds the password", await waitFor(async () => (await val(page)) === PW), await val(page));
check("the address no longer shows it and says #lqz-in", await waitFor(async () => (await hash(page)) === "#lqz-in"), await hash(page));
console.log("F2 nothing else is touched");
check("the other boxes on the page are empty", await page.evaluate(() => document.getElementById("n").value === "" && document.getElementById("s").value === ""));
check("only the password box got an input event", await page.evaluate(() => window.seen.length > 0 && window.seen.every(x => x === "p")), await page.evaluate(() => window.seen.join(",")));
await page.goto(START + "&kind=late"); await page.waitForTimeout(500);
check("a box that arrives later is filled when it arrives (no new hand-over)", await waitFor(async () => (await val(page)) === PW, 10000), await val(page));
check("... and the address then says #lqz-in", await waitFor(async () => (await hash(page)) === "#lqz-in"), await hash(page));

console.log("F3 other kinds of password box");
await page.goto(START + "&kind=shadow");
check("a box inside a page component is filled", await waitFor(async () => (await val(page, true)) === PW), await val(page, true));
await page.goto(START + "&kind=text");
check("a plain box labelled Password is filled, the Notes box is not", await waitFor(async () => (await val(page)) === PW) && await page.evaluate(() => document.getElementById("n").value === ""), await val(page));

console.log("F4 later pages of the exam; another exam");
await page.goto("https://brightspace.usc.edu/d2l/lms/quizzing/user/quiz_start_frame_auto.d2l?ou=123&qi=77");
check("the exam's next page is filled with no hand-over", await waitFor(async () => (await val(page)) === PW), await val(page));
await page.goto("https://brightspace.usc.edu/d2l/lms/quizzing/user/quiz_summary.d2l?qi=78&ou=123"); await page.waitForTimeout(2500);
check("another exam's page is left alone", (await val(page)) === "" && (await hash(page)) === "", (await val(page)) + " " + (await hash(page)));
await hand(page, "LQ-ZZ99YY88");
check("... until LOCKqz hands over that exam's own password", await waitFor(async () => (await val(page)) === "LQ-ZZ99YY88"), await val(page));

console.log("F5 inside the attempt");
await page.goto("https://brightspace.usc.edu/d2l/lms/quizzing/user/attempt/quiz_start_frame_auto.d2l?ou=123&qi=78"); await page.waitForTimeout(2500);
check("nothing is ever entered inside the attempt", (await val(page)) === "" && (await hash(page)) === "", (await val(page)) + " " + (await hash(page)));
await hand(page, "LQ-ZZ99YY88"); await page.waitForTimeout(1500);
check("... even when handed a password there", (await val(page)) === "", await val(page));

console.log("F6 a page with no password box");
await page.goto(START + "&kind=none"); await hand(page, PW);
check("the address says #lqz-got", await waitFor(async () => (await hash(page)) === "#lqz-got"), await hash(page));
check("no box was touched", await page.evaluate(() => window.seen.length === 0));

console.log("F7 no professor on this computer");
const other = await context.newPage(); await other.goto("https://brightspace.usc.edu/d2l/home"); await other.waitForTimeout(2500);
const sw = context.serviceWorkers()[0];
const st = sw ? await sw.evaluate(() => chrome.storage.local.get(null)) : {};
check("no Sync key, no sync, no LOCKqz request from the exam pages", !st.key && !calls.some(c => /^lockqz\.com\/api\//.test(c)), JSON.stringify(calls));
check("the password is not written to the extension's disk storage", !JSON.stringify(st).includes("LQ-"));
check("an ordinary Brightspace page gets nothing", (await other.evaluate(() => location.hash)) === "");

await context.close(); server.close();
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
