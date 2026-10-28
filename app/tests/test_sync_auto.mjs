// Automatic re-sync (public/sync.js, auto=1) and the "new quiz" email, with NO browser: the REAL sync.js
// runs in a sandbox against a simulated Brightspace and the REAL LOCKqz API (in-memory SQLite).
//   A1 a manual Sync syncs and leaves a 15-min re-check running in the open panel;
//   A2 re-check with nothing changed in Brightspace -> ZERO LOCKqz requests, the same panel stays;
//   A3 a new quiz appears in Brightspace -> the re-check syncs it and puts a LOCKqz password on it;
//   A4 nothing changed but an hour passed -> one sync (dashboard changes reach Brightspace within the hour);
//   A5 the professor is using the panel (click < 2 min ago) -> no re-check; a running gate -> never;
//   A6 Brightspace session expired -> the re-check stops quietly, the panel stays as it was;
//   N1 a student opens a quiz newer than the last Sync -> its professor gets ONE email, once per quiz,
//      at most once per 6 h per course; a synced quiz never emails.
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-syncauto-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
const SYNC_SRC = readFileSync(join(CF, "public", "sync.js"), "utf8");

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

// ---- LOCKqz API on an in-memory database (real time; the PAGE runs on a fake clock) ----
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
const db = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
  const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
    first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
    run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } }; return o; },
  async batch(sts) { for (const s of sts) s._run(); } };
const MAIL = [];
const env = { DB: db, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", LIVE_CACHE_MS: "0", MAIL_SINK: m => { MAIL.push(m); return true; } };
const API = "https://lockqz.test/api";
let lqCalls = [];
async function api(path, body, headers = {}) {
  const raw = JSON.stringify(body ?? {});
  const res = await onRequest({ request: new Request(API + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : raw }), env });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const sign = (key, path, ts, raw) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(raw).digest("hex")}`).digest("hex");
async function dev(path, body, id, key) {
  const raw = JSON.stringify(body), ts = String(Math.floor(Date.now() / 1000));
  return api(path, body, { "X-LOCKqz-Device": id, "X-LOCKqz-Time": ts, "X-LOCKqz-Sig": sign(key, `/api${path}`, ts, raw) });
}

// ---- simulated Brightspace ----
const OU = 98765;
const quiz = (qi, name) => ({ QuizId: qi, Name: name, IsActive: true, StartDate: null, EndDate: "2099-01-01T00:00:00.000Z", DueDate: null, Password: null,
  AllowOnlyUsersWithSpecialAccess: false, RestrictIPAddressRange: null, AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 1 },
  Instructions: { Text: { Text: "", Html: "" }, IsDisplayed: false }, Description: { Text: { Text: "", Html: "" }, IsDisplayed: false },
  Header: { Text: { Text: "", Html: "" }, IsDisplayed: false }, Footer: { Text: { Text: "", Html: "" }, IsDisplayed: false } });
const BS = { quizzes: [quiz(111, "Quiz 1")], expired: false };
const classlist = [
  { Identifier: "4000", DisplayName: "Prof", Email: "prof@usc.edu", ClasslistRoleDisplayName: "Instructor" },
  { Identifier: "4001", DisplayName: "Al", Email: "al@usc.edu", ClasslistRoleDisplayName: "Student" },
];
const jr = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
async function brightspace(url, opt = {}) {
  if (BS.expired) return new Response("", { status: 401 });
  const u = new URL(url, "https://brightspace.usc.edu"), p = u.pathname, m = (opt.method || "GET").toUpperCase();
  if (p === "/d2l/api/versions/") return jr([{ ProductCode: "le", LatestVersion: "1.100" }, { ProductCode: "lp", LatestVersion: "1.64" }]);
  if (p.endsWith("/users/whoami")) return jr({ Identifier: "4000", FirstName: "Prof", LastName: "" });
  if (p.includes("/enrollments/myenrollments/")) return jr({ Items: [{ OrgUnit: { Id: OU, Name: "ECON 203", Code: "ECON-203" }, Access: { IsActive: true, ClasslistRoleName: "Instructor" } }], PagingInfo: { HasMoreItems: false } });
  if (p.endsWith(`/${OU}/classlist/paged/`)) return jr({ Objects: classlist, Next: null });
  if (p.endsWith(`/${OU}/quizzes/`)) return jr({ Objects: BS.quizzes, Next: null });
  const one = p.match(/\/quizzes\/(\d+)$/);
  if (one) {
    const q = BS.quizzes.find(x => String(x.QuizId) === one[1]); if (!q) return jr({}, 404);
    if (m === "PUT") { Object.assign(q, JSON.parse(opt.body)); return jr({}); }
    return jr(JSON.parse(JSON.stringify(q)));
  }
  if (/\/specialaccess\/$/.test(p)) return jr({ Objects: [], Next: null });
  return jr({ error: "no mock for " + p }, 404);
}

// ---- a small DOM: one Brightspace tab, scripts injected into it run the real sync.js ----
let OFF = 0;   // the page's clock runs ahead by OFF ms (timers are fired by hand)
class FDate extends Date { constructor(...a) { if (a.length) super(...a); else super(Date.now() + OFF); } static now() { return Date.now() + OFF; } }
const store = new Map(), attached = new Set(), timers = [], runs = [];
let current = null;   // the element with id lqz-sync, if any
function mkEl(tag) {
  const listeners = {}, B = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
  const autoLine = { textContent: "" };
  const el = { tag, id: "", style: {}, dataset: {}, innerHTML: "", src: "", B, autoLine, listeners,
    querySelector: s => s === "#lqz-b" ? B : s === "#lqz-auto" ? autoLine : { onclick: null },
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    remove() { attached.delete(el); if (current === el) current = null; } };
  return el;
}
const document = {
  get currentScript() { return runs.length ? runs[runs.length - 1] : null; },
  getElementById: id => (id === "lqz-sync" && current && attached.has(current) ? current : null),
  createElement: tag => mkEl(tag),
  body: { contains: el => attached.has(el),
    appendChild(el) { attached.add(el); if (el.id === "lqz-sync") current = el; if (el.tag === "script") inject(el); } },
};
// The LOCKqz dashboard tab that opened this Brightspace tab (window.opener), and this tab's window.
const DASHMSG = [], LISTEN = [];
const DASHWIN = { closed: false, postMessage: (m, origin) => DASHMSG.push({ m, origin }) };
const EVIL = { closed: false, postMessage: () => {} };
const window = { opener: DASHWIN, addEventListener: (t, f) => { if (t === "message") LISTEN.push(f); }, open: () => null };
const dashSays = (data, origin = "https://lockqz.test", source = DASHWIN) => LISTEN.forEach(f => f({ origin, data, source }));
const ctx = { window, document, location: { pathname: "/d2l/home/98765", host: "brightspace.usc.edu" },
  localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
  fetch: (url, opt) => { if (String(url).startsWith(API)) { lqCalls.push(String(url).slice(API.length).split("?")[0]); return onRequest({ request: new Request(url, opt), env }); } return brightspace(url, opt); },
  setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval: i => { if (timers[i - 1]) timers[i - 1].fn = null; },
  URL, Date: FDate, JSON, Promise, Object, Array, String, Number, Math, RegExp, Error, encodeURIComponent, console, setTimeout, confirm: () => true };
vm.createContext(ctx);
let pending = [];
function inject(script) { runs.push(script); pending.push(vm.runInContext(SYNC_SRC, ctx)); runs.pop(); }
const settle = async () => { while (pending.length) { const p = pending; pending = []; await Promise.all(p); } await new Promise(r => setTimeout(r, 30)); };
// Fire every 15-minute timer (the re-check); gate timers are 10 s and are not fired here.
const recheck = async () => { for (const t of timers.slice()) if (t.fn && t.ms === 15 * 60000) await t.fn(); await settle(); };

// ---- accounts: admin, a verified + paid professor whose course is on a trusted roster ----
await api("/signup", { email: "admin@usc.edu", password: "adminpass1" });
const PROF = (await api("/signup", { email: "prof@usc.edu", password: "profpass1", name: "Prof" })).data.token;
sqlite.prepare("UPDATE teachers SET verified=1, active_until='2099-12-31' WHERE email='prof@usc.edu'").run();
const KEY = (await api("/synckey", undefined, { "X-LOCKqz-Teacher": PROF })).data.key;
await api("/sync", { courses: [{ ou: String(OU), name: "ECON 203", role: "Instructor", classlist: classlist.map(c => ({ id: c.Identifier, name: c.DisplayName, email: c.Email, role: c.ClasslistRoleDisplayName })), quizzes: [] }] }, { "X-LOCKqz-Teacher": "admin-key" });
const SRC = `https://lockqz.test/sync.js?k=${KEY}`;
const pwOf = qi => BS.quizzes.find(q => q.QuizId === qi)?.Password || null;
const syncs = () => lqCalls.filter(c => c === "/sync").length;

console.log("A1 manual Sync: syncs, protects, leaves a 15-min re-check running");
const s0 = mkEl("script"); s0.src = SRC; document.body.appendChild(s0); await settle();
const panel1 = current;
check("panel open", !!panel1 && attached.has(panel1));
check("one /sync", syncs() === 1, lqCalls.join(","));
check("Quiz 1 got a LOCKqz password", /^LQ-/.test(pwOf(111) || ""), pwOf(111));
check("panel says it re-syncs by itself", /Re-syncs by itself every 15 min/.test(panel1.B.innerHTML));
check("a 15-min re-check timer is running", timers.some(t => t.fn && t.ms === 15 * 60000));
check("only a fingerprint is stored in Brightspace's storage", [...store.keys()].length === 1 && !/LQ-|al@usc|Al/.test([...store.values()].join("")), JSON.stringify([...store]));

console.log("A2 nothing changed -> zero LOCKqz requests, same panel");
lqCalls = []; OFF += 16 * 60000;
await recheck();
check("no LOCKqz request at all", lqCalls.length === 0, lqCalls.join(","));
check("same panel still open", current === panel1 && attached.has(panel1));
check("its 'checked' line was updated", /checked/.test(panel1.autoLine.textContent), panel1.autoLine.textContent);

console.log("A3 a new quiz in Brightspace -> the re-check syncs and protects it");
BS.quizzes.push(quiz(222, "Quiz 2"));
lqCalls = []; OFF += 16 * 60000;
await recheck();
check("exactly one /sync", syncs() === 1, lqCalls.join(","));
check("Quiz 2 got a LOCKqz password in Brightspace", /^LQ-/.test(pwOf(222) || ""), pwOf(222));
check("Quiz 1 kept its password", /^LQ-/.test(pwOf(111) || ""));
check("old panel replaced by the new one", current && current !== panel1 && !attached.has(panel1));
await recheck();   // the old panel's timer fires once more and stops itself (the new one waits: just made)
check("old panel's re-check stopped; one re-check left", timers.filter(t => t.fn && t.ms === 15 * 60000).length === 1, timers.filter(t => t.fn && t.ms === 15 * 60000).length);

console.log("A4 nothing changed for an hour -> one sync");
lqCalls = []; OFF += 16 * 60000; await recheck();
check("16 min later: still nothing sent", lqCalls.length === 0, lqCalls.join(","));
lqCalls = []; OFF += 50 * 60000; await recheck();
check("past the hour: one /sync", syncs() === 1, lqCalls.join(","));

console.log("A5 professor using the panel -> no re-check; a running gate -> never");
lqCalls = []; OFF += 61 * 60000;
(current.listeners.pointerdown || []).forEach(f => f());
OFF += 60000; await recheck();
check("clicked 1 min ago: nothing re-read or sent", lqCalls.length === 0, lqCalls.join(","));
current.dataset.gates = "1";
const gatePanel = current;
// Simulate a gate running in that panel instance (the instance re-marks it on its own timer from GATES;
// here we stub the timer so the mark stays).
const realTimers = timers.filter(t => t.fn && t.ms === 15 * 60000); realTimers.forEach(t => { t.saved = t.fn; t.fn = null; });
const s1 = mkEl("script"); s1.src = SRC + "&auto=1"; document.body.appendChild(s1); await settle();
check("an auto run with a gate on: no request, panel untouched", lqCalls.length === 0 && current === gatePanel, lqCalls.join(","));
realTimers.forEach(t => { t.fn = t.saved; }); current.dataset.gates = "";

console.log("A6 Brightspace session expired -> quiet stop, panel unchanged");
BS.expired = true; lqCalls = []; OFF += 61 * 60000;
const before = current;
await recheck();
check("no LOCKqz request", lqCalls.length === 0, lqCalls.join(","));
check("panel unchanged (no error popped over it)", current === before && attached.has(before));
BS.expired = false;

console.log("D1 the dashboard's Sync now button (messages between the two tabs, no extra LOCKqz requests)");
check("the Sync tab said hello to the dashboard that opened it", DASHMSG.some(x => x.m.lqz === "hello" && x.origin === "https://lockqz.test"), JSON.stringify(DASHMSG.slice(0, 3)));
check("one message listener for the whole page (not one per re-sync)", LISTEN.length === 1, LISTEN.length);
DASHMSG.length = 0; dashSays({ lqz: "ping" });
check("ping -> hello, to the dashboard's own origin only", DASHMSG.length === 1 && DASHMSG[0].m.lqz === "hello" && DASHMSG[0].origin === "https://lockqz.test", JSON.stringify(DASHMSG));
lqCalls = []; DASHMSG.length = 0; const pBefore = current;
dashSays({ lqz: "sync" }); await settle();
check("Sync now syncs even though nothing changed in Brightspace", syncs() === 1, lqCalls.join(","));
check("... and tells the dashboard it is done", DASHMSG.some(x => x.m.lqz === "synced" && x.m.ok === true), JSON.stringify(DASHMSG));
check("... with no class data in the message", DASHMSG.every(x => !/al@usc|LQ-|Al\b/.test(JSON.stringify(x.m))), JSON.stringify(DASHMSG));
check("the panel was refreshed in place (one panel)", current && current !== pBefore && !attached.has(pBefore));
lqCalls = []; DASHMSG.length = 0;
dashSays({ lqz: "sync" }, "https://evil.example", EVIL); await settle();
check("another site cannot trigger a sync", lqCalls.length === 0 && DASHMSG.length === 0, lqCalls.join(","));
dashSays({ lqz: "steal" }); dashSays("sync"); await settle();
check("anything but ping/sync is ignored", lqCalls.length === 0, lqCalls.join(","));
current.dataset.gates = "1";
dashSays({ lqz: "sync" }); await settle();
check("a gate running: no sync, the dashboard is told why", lqCalls.length === 0 && DASHMSG.some(x => x.m.lqz === "busy"), JSON.stringify(DASHMSG));
current.dataset.gates = "";
current.remove(); lqCalls = []; DASHMSG.length = 0;
dashSays({ lqz: "sync" }); await settle();
check("panel closed: Sync now runs a normal Sync and opens the panel again", syncs() === 1 && current && attached.has(current), lqCalls.join(","));
BS.expired = true; lqCalls = []; DASHMSG.length = 0;
dashSays({ lqz: "sync" }); await settle();
check("Brightspace session expired: the dashboard is told it failed", DASHMSG.some(x => x.m.lqz === "failed" && /expired/i.test(x.m.error)), JSON.stringify(DASHMSG));
BS.expired = false;

console.log("N1 a student opens a quiz newer than the last Sync -> one email to the professor");
const AL = { id: "mac-al01", key: randomBytes(32).toString("hex") };
await api("/register", { device_id: AL.id, key: AL.key, student: "al@usc.edu", platform: "mac" });
const open = async qi => { await dev("/report", { device_id: AL.id, event: "lock", quiz_id: `${OU}-${qi}` }, AL.id, AL.key);
  return dev("/password", { url: `https://brightspace.usc.edu/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${qi}&ou=${OU}`, device_id: AL.id }, AL.id, AL.key); };
MAIL.length = 0;
let r = await open(111);
check("a synced quiz: password given, no email", /^LQ-/.test(r.data?.password || "") && MAIL.length === 0, JSON.stringify(r.data) + " " + MAIL.length);
r = await open(333);
check("unknown quiz: no password (nothing to give)", r.status === 200 && r.data?.password === null, JSON.stringify(r.data));
check("its professor got one email", MAIL.length === 1 && MAIL[0].to === "prof@usc.edu", JSON.stringify(MAIL));
check("email names the course and says what to do (open Brightspace in Chrome)", /ECON 203/.test(MAIL[0]?.text || "") && /Open Brightspace in Chrome/.test(MAIL[0]?.text || ""), MAIL[0]?.text);
await open(333); await open(333);
check("asking again: no second email", MAIL.length === 1, MAIL.length);
await open(444);
check("another new quiz within 6 h: no email (one per course per 6 h)", MAIL.length === 1, MAIL.length);
sqlite.prepare("UPDATE sync_nudges SET at=?").run(new Date(Date.now() - 7 * 3600000).toISOString());
await open(444);
check("after 6 h: the other new quiz emails once", MAIL.length === 2, MAIL.length);
await open(444);
check("and only once", MAIL.length === 2, MAIL.length);
check("each email wrote one row only", sqlite.prepare("SELECT COUNT(*) AS n FROM sync_nudges").get().n === 2);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
