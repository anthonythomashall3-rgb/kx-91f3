// The LOCKqz professor extension, end to end in a REAL Chromium with the built extension loaded
// (app/extension-prof/dist/lockqz-prof-chromium.zip, unzipped): real dashboard, real sync.js (the
// extension's own copy), the REAL LOCKqz API on an in-memory database, a simulated Brightspace API.
//   E1 the dashboard sees the extension and hands it the Sync key; the extension syncs by itself in a
//      background tab and closes it; the dashboard fills in (no bookmark, no click)
//   E2 the connect page says "Connected automatically" (no bookmark steps)
//   E3 Sync now goes through the extension ("Synced just now.")
//   E4 browsing Brightspace again within 15 min: no extra sync
//   E5 an exam within the hour: the extension opens its own pinned Brightspace tab and the gate starts there
//   E6 a quiet background panel never gates; exam over -> the extension closes its exam tab
//   E7 the packaged sync.js / lq.js are the site's own (no drift)
// Original header of the test this one is built from:
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
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
const env = { DB: db, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", LIVE_CACHE_MS: "0", REQUIRE_GATE: "1" };
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
let brightspace = function (u, method, body) {
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


// Special access (the gate admits locked students this way): kept per user, like Brightspace.
const SA = {};
const bs0 = brightspace;
brightspace = (u, method, body) => {
  const m = u.pathname.match(/\/quizzes\/(\d+)\/specialaccess\/(\d+)?$/);
  if (m && m[2]) { if (method === "DELETE") { delete SA[m[2]]; return J({}); } if (method === "PUT" || method === "POST") { SA[m[2]] = JSON.parse(body || "{}"); return J(SA[m[2]]); } return SA[m[2]] ? J(SA[m[2]]) : J({}, 404); }
  if (m) return J({ Objects: Object.entries(SA).map(([UserId, v]) => ({ UserId: Number(UserId), SpecialAccess: v })), Next: null });
  return bs0(u, method, body);
};
// The exam starts in 5 days (an undated protected quiz is gated at any time, so the extension would keep
// its exam tab open from the start: that is E5's case, not E1's).
BS.quizzes[0].StartDate = new Date(Date.now() + 5 * 86400e3).toISOString();
// ---- the extension, unzipped ----
const ZIP = join(HERE, "..", "extension-prof", "dist", "lockqz-prof-chromium.zip");
check("E7 the Chromium package exists", existsSync(ZIP));
const EXTDIR = join(tmp, "ext"); execFileSync("unzip", ["-q", ZIP, "-d", EXTDIR]);
check("E7 packaged sync.js is the site's own", readFileSync(join(EXTDIR, "sync.js")).equals(SYNC_JS));
check("E7 packaged lq.js is the site's own", readFileSync(join(EXTDIR, "lq.js")).equals(readFileSync(join(CF, "public", "lq.js"))));
const man = JSON.parse(readFileSync(join(EXTDIR, "manifest.json"), "utf8"));
check("E7 Chromium manifest: service worker only, no Firefox keys", man.background.service_worker === "background.js" && !man.background.scripts && !man.browser_specific_settings);

// ---- the browser ----
// The extension opens its own Brightspace tabs, which request interception can miss, so the real
// addresses are served by a local HTTPS server instead (Chromium resolves both hosts to it).
const { createServer } = await import("node:https");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=lqz", "-days", "1", "-keyout", join(tmp, "k.pem"), "-out", join(tmp, "c.pem")], { stdio: "ignore" });
const LQ_JS = readFileSync(join(CF, "public", "lq.js"));
const server = createServer({ key: readFileSync(join(tmp, "k.pem")), cert: readFileSync(join(tmp, "c.pem")) }, async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks), host = String(req.headers.host || "").split(":")[0], u = new URL("https://" + host + req.url);
  const send = (status, type, b, headers = {}) => { res.writeHead(status, { "Content-Type": type, ...headers }); res.end(b); };
  try {
    if (host === "lockqz.pages.dev" && u.pathname.startsWith("/api/")) {
      lqCalls.push(u.pathname.slice(4));
      const h = { ...req.headers }; delete h["content-length"]; delete h.host;
      const r = await onRequest({ request: new Request(u.href, { method: req.method, headers: h, body: ["GET", "HEAD", "OPTIONS"].includes(req.method) ? undefined : body }), env });
      const hs = Object.fromEntries(r.headers); return send(r.status, hs["content-type"] || "application/json", Buffer.from(await r.arrayBuffer()), hs);
    }
    if (host === "prof.lockqz.pages.dev" && (u.pathname === "/dashboard" || u.pathname === "/")) return send(200, "text/html", DASH_HTML);
    if (host === "prof.lockqz.pages.dev" && u.pathname === "/lq.js") return send(200, "application/javascript", LQ_JS);
    if (host === "brightspace.usc.edu" && (u.pathname.startsWith("/d2l/api/") || u.pathname === "/d2l/lp/auth/xsrf-tokens")) {
      const r = brightspace(u, req.method, body.toString()); return send(r.status, r.contentType, r.body);
    }
    if (host === "brightspace.usc.edu") return send(200, "text/html", "<!doctype html><title>Homepage - USC Brightspace</title><h1>Brightspace</h1>");
    return send(204, "text/plain", "");
  } catch (e) { console.log("server error", u.href, e.message); return send(500, "text/plain", String(e)); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const context = await chromium.launchPersistentContext(join(tmp, "profile"), { channel: "chromium", headless: true, ignoreHTTPSErrors: true,
  args: [`--disable-extensions-except=${EXTDIR}`, `--load-extension=${EXTDIR}`, "--ignore-certificate-errors", "--no-proxy-server",
    `--host-resolver-rules=MAP brightspace.usc.edu 127.0.0.1:${PORT}, MAP prof.lockqz.pages.dev 127.0.0.1:${PORT}, MAP lockqz.pages.dev 127.0.0.1:${PORT}, MAP * ~NOTFOUND`] });
await context.addInitScript(t => { if (location.host === "prof.lockqz.pages.dev") { localStorage.setItem("lockqz_token", t); localStorage.setItem("lockqz_tour_prof@usc.edu", "1"); localStorage.setItem("lockqz_welcome_prof@usc.edu", "1"); } }, PROF);
let sw = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
const syncs = () => lqCalls.filter(c => c === "/sync").length;
const waitFor = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 250)); } return false; };
const bsTabs = () => context.pages().filter(p => { try { return new URL(p.url()).host === "brightspace.usc.edu"; } catch { return false; } });
const store = k => sw.evaluate(k => chrome.storage.local.get(k), k);
// The first install opens the dashboard by itself (that is how the key gets handed over). It opened before
// this test's sign-in was set up, so it shows the sign-in page: close it and open the dashboard signed in.
check("first install opened the LOCKqz dashboard", await waitFor(() => context.pages().some(p => p.url().startsWith("https://prof.lockqz.pages.dev/")), 15000));
for (const p of context.pages()) if (p.url().startsWith("https://prof.lockqz.pages.dev/")) await p.close();
const dash = await context.newPage();
await dash.goto("https://prof.lockqz.pages.dev/dashboard");
const errors = []; dash.on("pageerror", e => errors.push(e.message));
const status = () => dash.evaluate(() => [...document.querySelectorAll(".syncst")].map(e => e.textContent).join(" | "));

console.log("E1 the extension takes the key and syncs by itself");
check("the dashboard knows the extension is installed", await waitFor(() => dash.evaluate(() => !!document.documentElement.dataset.lqzExt)));
check("the extension stored the professor's Sync key", await waitFor(async () => /^lqs_[0-9a-f]{40}$/.test((await store("key")).key || "")));
check("a sync ran with no bookmark and no click", await waitFor(() => syncs() >= 1), lqCalls.join(","));
check("the quiz got its LOCKqz password in Brightspace", await waitFor(() => /^LQ-/.test(BS.quizzes[0].Password || "")), BS.quizzes[0].Password);
check("the background Brightspace tab closed itself", await waitFor(() => bsTabs().length === 0), bsTabs().length);
check("the dashboard filled in by itself", await waitFor(async () => /ECON 203/.test(await dash.textContent("body"))));

console.log("E2 connect page");
await dash.evaluate(() => { location.hash = "connect"; });
check("'Connected.', the exam-day rule, no bookmark steps", await waitFor(async () => { const t = await dash.innerText("body"); return /Connected\./.test(t) && /On exam day, keep Chrome open and signed in to Brightspace until the exam ends\./.test(t) && !/bookmark/i.test(t); }));

console.log("E3 Sync now through the extension");
const b3 = syncs();
await dash.click("button:has-text('Sync now')");
check("a sync ran", await waitFor(() => syncs() === b3 + 1), lqCalls.join(","));
check("'Synced just now.'", await waitFor(async () => /Synced just now\./.test(await status())), await status());
check("no Brightspace tab left open", await waitFor(() => bsTabs().length === 0), bsTabs().length);

console.log("E4 browsing Brightspace within 15 min");
const bsPage = await context.newPage(); await bsPage.goto("https://brightspace.usc.edu/d2l/home");
await bsPage.waitForTimeout(3000);
check("no extra sync (15-min rule)", syncs() === b3 + 1, lqCalls.join(","));
await sw.evaluate(() => chrome.storage.local.set({ lastRun: 0 }));
const b4 = syncs(); await bsPage.reload(); await bsPage.waitForTimeout(3000);
check("after 15 min: a quiet re-check with an unchanged Brightspace sends LOCKqz nothing", syncs() === b4, lqCalls.join(","));
check("its panel is hidden", await bsPage.evaluate(() => { const b = document.getElementById("lqz-sync"); return !b || b.style.display === "none"; }));
await bsPage.close();

console.log("E5 an exam within the hour");
BS.quizzes[0].StartDate = new Date(Date.now() + 30 * 60000).toISOString();
BS.quizzes[0].EndDate = new Date(Date.now() + 90 * 60000).toISOString();
const b5 = syncs();
await dash.click("button:has-text('Sync now')");
check("synced the new dates", await waitFor(() => syncs() >= b5 + 1));
if (syncs() < b5 + 1) console.log("DBG5", syncs(), b5, lqCalls.slice(-8).join(","), await status(), JSON.stringify(await store(null)), context.pages().map(p => p.url()));
check("the extension knows the exam's time", await waitFor(async () => ((await store("schedule")).schedule || []).some(q => q.qi === "111" && q.start)));
await sw.evaluate(() => serial(tick));
check("its own pinned Brightspace tab opened", await waitFor(async () => { const g = (await store("gateTab")).gateTab; return g != null && bsTabs().length === 1; }));
const gatedRow = () => sqlite.prepare("SELECT gated FROM quizzes WHERE qi='111'").get();
check("the gate started in that tab", await waitFor(() => Number(gatedRow()?.gated) === 1, 30000), JSON.stringify(gatedRow()));
if (Number(gatedRow()?.gated) !== 1) for (const p of bsTabs()) console.log("GATETAB", p.url(), await p.evaluate(() => { const b = document.getElementById("lqz-sync"); return b ? [b.style.display, [...b.querySelectorAll("[data-gst],[data-gate]")].map(x => x.outerHTML).join(" ")] : "no panel"; }), JSON.stringify(await store(["schedule","autoGate","gateTab"])));
check("the exam tab reports its gate", await waitFor(async () => Number((await store("gates")).gates) > 0, 40000));

console.log("E6 exam over: the extension closes its exam tab once the gate has stopped");
await sw.evaluate(() => chrome.storage.local.set({ schedule: [], gates: 0, gateSeen: 0 }));
await sw.evaluate(() => serial(tick));
check("exam tab closed", await waitFor(() => bsTabs().length === 0), bsTabs().length);
check("no page errors on the dashboard", errors.length === 0, errors.join(" | "));

await context.close(); server.close();
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
