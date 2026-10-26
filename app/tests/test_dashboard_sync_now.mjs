// The dashboard's "Sync now" button, end to end in a REAL Chromium: the real dashboard page and the real
// sync.js, served at their real addresses (prof.lockqz.pages.dev, brightspace.usc.edu) by request
// interception, the REAL LOCKqz API on an in-memory database, and a simulated Brightspace API.
//   S1 no Brightspace tab yet -> the button opens Brightspace in a new tab and says to click the bookmark once
//   S2 the bookmark is clicked there -> it syncs and the dashboard fills in by itself
//   S3 the button now syncs through that tab (no bookmark click), and the dashboard says "Synced just now."
//   S4 after the dashboard is reloaded, the button still finds the Brightspace tab and syncs
//   S5 a professor change on the dashboard is sent to Brightspace by the button (quiz password removed)
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
let chromium; try { ({ chromium } = createRequire(import.meta.url)("playwright")); } catch { console.log("RESULT: 0 passed, 0 failed (skipped: no playwright)"); process.exit(0); }

const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-syncnow-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
const DASH_HTML = readFileSync(join(CF, "public", "dashboard.html"));
const SYNC_JS = readFileSync(join(CF, "public", "sync.js"));

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

// ---- LOCKqz API ----
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
const db = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
  const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
    first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
    run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } }; return o; },
  async batch(sts) { for (const s of sts) s._run(); } };
const env = { DB: db, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", LIVE_CACHE_MS: "0" };
const API = "https://lockqz.pages.dev/api";
const lqCalls = [];
async function api(path, body, headers = {}) {
  const res = await onRequest({ request: new Request(API + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// ---- simulated Brightspace ----
const OU = 98765;
const quiz = (qi, name) => ({ QuizId: qi, Name: name, IsActive: true, StartDate: null, EndDate: "2099-01-01T00:00:00.000Z", DueDate: null, Password: null,
  AllowOnlyUsersWithSpecialAccess: false, RestrictIPAddressRange: null, AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 1 },
  Instructions: { Text: { Text: "", Html: "" }, IsDisplayed: false }, Description: { Text: { Text: "", Html: "" }, IsDisplayed: false },
  Header: { Text: { Text: "", Html: "" }, IsDisplayed: false }, Footer: { Text: { Text: "", Html: "" }, IsDisplayed: false } });
const BS = { quizzes: [quiz(111, "Midterm")] };
const classlist = [
  { Identifier: "4000", DisplayName: "Prof", Email: "prof@usc.edu", ClasslistRoleDisplayName: "Instructor" },
  { Identifier: "4001", DisplayName: "Al", Email: "al@usc.edu", ClasslistRoleDisplayName: "Student" },
];
const J = (o, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(o) });
function brightspace(u, method, body) {
  const p = u.pathname;
  if (p === "/d2l/api/versions/") return J([{ ProductCode: "le", LatestVersion: "1.100" }, { ProductCode: "lp", LatestVersion: "1.64" }]);
  if (p.endsWith("/users/whoami")) return J({ Identifier: "4000", FirstName: "Prof", LastName: "" });
  if (p.includes("/enrollments/myenrollments/")) return J({ Items: [{ OrgUnit: { Id: OU, Name: "ECON 203", Code: "ECON-203" }, Access: { IsActive: true, ClasslistRoleName: "Instructor" } }], PagingInfo: { HasMoreItems: false } });
  if (p.endsWith(`/${OU}/classlist/paged/`)) return J({ Objects: classlist, Next: null });
  if (p.endsWith(`/${OU}/quizzes/`)) return J({ Objects: BS.quizzes, Next: null });
  if (p === "/d2l/lp/auth/xsrf-tokens") return J({ referrerToken: "x" });
  const one = p.match(/\/quizzes\/(\d+)$/);
  if (one) {
    const q = BS.quizzes.find(x => String(x.QuizId) === one[1]); if (!q) return J({}, 404);
    if (method === "PUT") { Object.assign(q, JSON.parse(body)); return J({}); }
    return J(q);
  }
  if (/\/specialaccess\/$/.test(p)) return J({ Objects: [], Next: null });
  return J({ error: "no mock for " + p }, 404);
}

// ---- accounts: admin + a verified, paid professor; the course is on a trusted (admin-synced) roster ----
await api("/signup", { email: "admin@usc.edu", password: "adminpass1" });
const PROF = (await api("/signup", { email: "prof@usc.edu", password: "profpass1", name: "Prof" })).data.token;
sqlite.prepare("UPDATE teachers SET verified=1, active_until='2099-12-31' WHERE email='prof@usc.edu'").run();
await api("/sync", { courses: [{ ou: String(OU), name: "ECON 203", role: "Instructor", classlist: classlist.map(c => ({ id: c.Identifier, name: c.DisplayName, email: c.Email, role: c.ClasslistRoleDisplayName })), quizzes: [] }] }, { "X-LOCKqz-Teacher": "admin-key" });

// ---- the browser ----
const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript(t => { if (location.host === "prof.lockqz.pages.dev") localStorage.setItem("lockqz_token", t); }, PROF);
await context.route("**/*", async route => {
  const req = route.request(), u = new URL(req.url());
  try {
    if (u.host === "lockqz.pages.dev" && u.pathname.startsWith("/api/")) {
      lqCalls.push(u.pathname.slice(4));
      const h = { ...req.headers() }; delete h["content-length"];
      const res = await onRequest({ request: new Request(req.url(), { method: req.method(), headers: h, body: ["GET", "HEAD", "OPTIONS"].includes(req.method()) ? undefined : req.postDataBuffer() }), env });
      return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
    }
    if (u.host === "prof.lockqz.pages.dev" && u.pathname === "/dashboard") return route.fulfill({ status: 200, contentType: "text/html", body: DASH_HTML });
    if (u.host === "prof.lockqz.pages.dev" && u.pathname === "/sync.js") return route.fulfill({ status: 200, contentType: "application/javascript", body: SYNC_JS });
    if (u.host === "brightspace.usc.edu" && u.pathname.startsWith("/d2l/api/")) return route.fulfill(brightspace(u, req.method(), req.postData()));
    if (u.host === "brightspace.usc.edu" && u.pathname === "/d2l/lp/auth/xsrf-tokens") return route.fulfill(brightspace(u, req.method()));
    if (u.host === "brightspace.usc.edu") return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Homepage - USC Brightspace</title><h1>Brightspace</h1>" });
  } catch (e) { console.log("route error", u.href, e.message); return route.fulfill({ status: 500, body: String(e) }); }
  return route.fulfill({ status: 204, body: "" });   // fonts etc.
});
const dash = await context.newPage();
const errors = []; dash.on("pageerror", e => errors.push(e.message));
const syncs = () => lqCalls.filter(c => c === "/sync").length;
const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
const status = () => dash.evaluate(() => [...document.querySelectorAll(".syncst")].map(e => e.textContent).join(" | "));

await dash.goto("https://prof.lockqz.pages.dev/dashboard");
await dash.waitForSelector("button:has-text('Sync now')", { timeout: 15000 });

console.log("S1 no Brightspace tab yet: the button opens Brightspace for one bookmark click");
const popP = context.waitForEvent("page");
await dash.click("button:has-text('Sync now')");
const bs = await popP;
await bs.waitForLoadState();
check("Brightspace opened in a new tab", new URL(bs.url()).host === "brightspace.usc.edu", bs.url());
check("the dashboard shows the 3 setup steps (bookmarks bar, drag, click)", /Brightspace opened in a new tab[\s\S]*bookmarks bar[\s\S]*(⌘|Ctrl) Shift B[\s\S]*Drag[\s\S]*click LOCKqz Sync/.test(await status()), await status());
check("the draggable LOCKqz Sync bookmark is right there", await dash.evaluate(() => [...document.querySelectorAll(".syncst a.bmk")].some(a => a.getAttribute("href").startsWith("javascript:") && /sync\.js\?k=/.test(a.getAttribute("href")))));
check("nothing synced yet", syncs() === 0);

console.log("S2 the bookmark is clicked in that tab: it syncs and the dashboard fills in by itself");
const bmk = await dash.evaluate(() => document.querySelector("a.bmk").getAttribute("href"));
check("the dashboard shows a working bookmark", /^javascript:/.test(bmk) && /sync\.js\?k=/.test(bmk));
await bs.evaluate(code => { (0, eval)(code); }, decodeURIComponent(bmk.slice("javascript:".length)));
check("Sync ran in Brightspace", await waitFor(() => syncs() === 1), lqCalls.join(","));
check("the quiz got its LOCKqz password in Brightspace", await waitFor(() => /^LQ-/.test(BS.quizzes[0].Password || "")), BS.quizzes[0].Password);
check("the dashboard filled in by itself (class shown)", await waitFor(async () => /ECON 203/.test(await dash.textContent("body"))));

console.log("S3 the button now syncs through that tab: no bookmark click");
const before = syncs();
await dash.click("button:has-text('Sync now')");
check("the dashboard says it is syncing", /Syncing/.test(await status()) || /Synced just now/.test(await status()), await status());
check("a sync ran", await waitFor(() => syncs() === before + 1), lqCalls.join(","));
check("the dashboard says 'Synced just now.'", await waitFor(async () => /Synced just now\./.test(await status())), await status());
check("no new tab opened", context.pages().length === 2, context.pages().length);

console.log("S4 after a dashboard reload the button still finds the Brightspace tab");
await dash.reload(); await dash.waitForSelector("button:has-text('Sync now')", { timeout: 15000 });
const b4 = syncs();
await dash.click("button:has-text('Sync now')");
check("a sync ran", await waitFor(() => syncs() === b4 + 1), lqCalls.join(","));
check("'Synced just now.'", await waitFor(async () => /Synced just now\./.test(await status())), await status());
check("still only the two tabs", context.pages().length === 2, context.pages().length);
check("Brightspace was not reloaded (the Sync panel is still there)", await bs.evaluate(() => !!document.getElementById("lqz-sync")));

console.log("S5 a change made on the dashboard goes to Brightspace with the button");
const off = await api("/protect", { ou: String(OU), qi: "111", on: false }, { "X-LOCKqz-Teacher": PROF });
check("LOCKqz turned off for the quiz on the dashboard side", off.status === 200, JSON.stringify(off.data));
check("Brightspace still has the password until a sync", /^LQ-/.test(BS.quizzes[0].Password || ""));
await dash.reload(); await dash.waitForSelector("button:has-text('Sync now')", { timeout: 15000 });
check("the dashboard shows the change is waiting, with a Sync now button", /One more click to send these changes to Brightspace/.test(await dash.textContent("body")));
await dash.click(".note.warn button:has-text('Sync now')");
check("the password was removed from Brightspace", await waitFor(() => !BS.quizzes[0].Password), BS.quizzes[0].Password);
check("'Synced just now.'", await waitFor(async () => /Synced just now\./.test(await status())), await status());
check("no page errors on the dashboard", errors.length === 0, errors.join(" | "));

console.log("S6 a dashboard opened from the Sync panel's link syncs through that Brightspace tab");
const d2P = context.waitForEvent("page");
await bs.evaluate(() => { const p = document.getElementById("lqz-sync"); p.style.display = ""; document.getElementById("lqz-dash").click(); });
const dash2 = await d2P; await dash2.waitForSelector("button:has-text('Sync now')", { timeout: 15000 });
check("the dashboard opened from the panel", new URL(dash2.url()).host === "prof.lockqz.pages.dev");
await dash2.waitForTimeout(500);
const b6 = syncs(), tabs6 = context.pages().length;
await dash2.click("button:has-text('Sync now')");
check("a sync ran", await waitFor(() => syncs() === b6 + 1), lqCalls.join(","));
check("'Synced just now.' there too", await waitFor(async () => /Synced just now\./.test(await dash2.evaluate(() => [...document.querySelectorAll(".syncst")].map(e => e.textContent).join(" ")))));
check("no extra Brightspace tab", context.pages().length === tabs6, context.pages().length);

await browser.close();
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
