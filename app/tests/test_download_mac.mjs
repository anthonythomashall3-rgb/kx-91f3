// Download page on a Mac, in a REAL browser (headless Chromium via Playwright; skipped where Playwright is not
// installed). download/mac.json {"signed": true} (an Apple-signed + notarized installer is live) -> the download
// is the one way shown, the command one click away. Not signed / no status / installer missing -> as before.
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
let chromium; try { ({ chromium } = createRequire(import.meta.url)("playwright")); } catch { console.log("RESULT: 0 passed, 0 failed (skipped: no playwright)"); process.exit(0); }

const HERE = dirname(fileURLToPath(import.meta.url)), PUB = join(HERE, "..", "cloudflare", "public");
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".css": "text/css", ".svg": "image/svg+xml" };

let browser;
try { browser = await chromium.launch(); } catch (e) { console.log("RESULT: 0 passed, 0 failed (skipped: no Chromium: " + String(e.message).split("\n")[0] + ")"); process.exit(0); }

// macJson: object | null (missing -> the site's HTML fallback, as Pages answers); pkg: is the installer served?
async function open(ua, macJson, pkg = true) {
  const ctx = await browser.newContext({ userAgent: ua, viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage(), asked = [];
  const html = readFileSync(join(PUB, "index.html"), "utf8");
  await page.route("**/*", async route => {
    const u = new URL(route.request().url()), p = u.pathname; asked.push(p);
    if (u.host !== "lockqz.test") return route.fulfill({ status: 204, body: "" });
    if (p === "/download/mac.json") return macJson ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(macJson) }) : route.fulfill({ status: 200, contentType: "text/html", body: html });
    if (p === "/download/lockqz-mac.pkg" || p === "/download/lockqz-win.exe") return pkg ? route.fulfill({ status: 200, contentType: "application/octet-stream", body: "xar!" }) : route.fulfill({ status: 200, contentType: "text/html", body: html });
    if (p === "/install.sh" || p === "/install.ps1") return route.fulfill({ status: 200, contentType: "text/plain", body: "#!" });
    if (p === "/api/store") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: null }) });
    if (p.startsWith("/api/")) return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    const f = join(PUB, p === "/" ? "index.html" : p.slice(1));
    if (existsSync(f)) return route.fulfill({ status: 200, contentType: TYPES[extname(f)] || "application/octet-stream", body: readFileSync(f) });
    return route.fulfill({ status: 200, contentType: "text/html", body: html });
  });
  await page.goto("https://lockqz.test/");
  await page.waitForTimeout(400);
  const vis = sel => page.locator(sel).first().isVisible().catch(() => false);
  return { ctx, page, asked, vis, cmdBox: () => vis("#lead"), or: () => vis("#orline"), dl: () => vis("#dl"), alt: () => vis("#macalt"), steps: () => page.locator("#dlol").innerText() };
}

console.log("D1 Apple-signed installer live");
let v = await open(MAC, { signed: true, version: "0.7.0" });
check("asks download/mac.json", v.asked.includes("/download/mac.json"));
check("Download for Mac shown", await v.dl() && (await v.page.locator("#dl").innerText()) === "Download for Mac");
check("command box + OR hidden", !(await v.cmdBox()) && !(await v.or()));
const s1 = await v.steps();
check("3 steps: open, Continue + Install + password, OK or Allow", /Open lockqz-mac\.pkg from Downloads\./.test(s1) && /Click Continue, then Install\. Enter your Mac password\./.test(s1) && /Click OK or Allow on every prompt\. Done\./.test(s1), s1);
check("no Open Anyway detour, no Terminal", !/Open Anyway/.test(s1) && !/Terminal/.test(await v.page.locator("#install").innerText()));
check("'Other ways to install' one click away", await v.alt());
await v.page.click("#macalt"); await v.page.waitForTimeout(100);
check("clicked -> command box + OR shown, link gone", await v.cmdBox() && await v.or() && !(await v.alt()) && /install\.sh \| sudo bash/.test(await v.page.locator("#cmd").innerText()));
check("download still there", await v.dl());
await v.ctx.close();

console.log("D2 not Apple-signed (today) / no status yet");
for (const [label, mj] of [["signed false", { signed: false, version: "0.6.11" }], ["no mac.json (site fallback page)", null], ["signed is not true", { signed: "yes" }]]) {
  v = await open(MAC, mj);
  const s = await v.steps();
  check(label + ": command + OR + installer, Open Anyway step, no link", await v.cmdBox() && await v.or() && await v.dl() && /Open Anyway/.test(s) && !(await v.alt()), s);
  await v.ctx.close();
}

console.log("D3 signed, but the installer is not served");
v = await open(MAC, { signed: true }, false);
check("command shown (never an empty page), download hidden", await v.cmdBox() && !(await v.dl()));
await v.ctx.close();

console.log("D4 Windows unchanged");
v = await open(WIN, { signed: true });
check("Windows never asks mac.json; command + installer (Store not current here)", !v.asked.includes("/download/mac.json") && await v.cmdBox() && (await v.page.locator("#dl").innerText()) === "Download for Windows" && !(await v.alt()));
await v.ctx.close();

await browser.close();
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
