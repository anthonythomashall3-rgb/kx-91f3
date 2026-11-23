// Brightspace's own "turned in" email, the professor's side (22 Nov 2026): the REAL sync.js in a sandbox against a
// simulated Brightspace and the REAL LOCKqz API (in-memory SQLite), MAILIN_ON = "1".
//   S1 a protected quiz's Notification Email gets LOCKqz's address for it, beside the professor's own
//   S2 a second Sync changes nothing (no write)
//   S3 a Brightspace that refuses a list: the password still goes on, the professor's own address stays alone
//   S4 a quiz LOCKqz lets go of: only LOCKqz's address is taken away
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
const env = { DB: db, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", LIVE_CACHE_MS: "0", ROT_SECRET: "rot-ms", MAILIN_ON: "1", MAIL_SINK: m => { MAIL.push(m); return true; } };
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
const BS = { quizzes: [quiz(111, "Quiz 1"), Object.assign(quiz(112, "Quiz 2"), { NotificationEmail: "prof@usc.edu" })], expired: false, refuseList: false, puts: 0 };
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
    if (m === "PUT") { const b = JSON.parse(opt.body); BS.puts++; if (BS.refuseList && /,/.test(b.NotificationEmail || "")) return jr({ title: "JSON Binding Error" }, 400); Object.assign(q, b); return jr({}); }
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
  fetch: (url, opt) => { url = String(url).replace("https://lockqz.com/api", API); if (String(url).startsWith(API)) { lqCalls.push(String(url).slice(API.length).split("?")[0]); return onRequest({ request: new Request(url, opt), env }); } return brightspace(url, opt); },
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


const tok = (ou, qi) => createHmac("sha256", "rot-ms").update(`lqz-quiz-mail:${ou}-${qi}`).digest("hex").slice(0, 12);
const ours = qi => `quiz+${OU}-${qi}-${tok(OU, qi)}@lockqz.com`;
const bq = qi => BS.quizzes.find(q => q.QuizId === qi);
const runSync = async () => { lqCalls = []; if (current) current.remove(); const s = mkEl("script"); s.src = SRC; document.body.appendChild(s); await settle(); if (process.env.DBG) console.log("    calls:", lqCalls.join(",")); };

console.log("S1 a protected quiz's Notification Email gets LOCKqz's address, beside the professor's own");
await runSync();
check("Quiz 1 (no address of its own): LOCKqz's address, and LOCKqz's password", bq(111).NotificationEmail === ours(111) && /^LQ-/.test(pwOf(111) || ""), JSON.stringify([bq(111).NotificationEmail, pwOf(111)]));
check("Quiz 2: the professor's own address first, LOCKqz's after it", bq(112).NotificationEmail === "prof@usc.edu, " + ours(112), bq(112).NotificationEmail);

console.log("S2 a second Sync changes nothing");
const p0 = BS.puts; OFF += 2 * 3600000; await runSync();
check("no write to Brightspace when both are in place", BS.puts === p0, BS.puts - p0);
bq(112).NotificationEmail = bq(112).NotificationEmail.replace(", ", ";").toUpperCase(); bq(111).NotificationEmail = " " + bq(111).NotificationEmail + " ";
const p1 = BS.puts, keep = bq(112).NotificationEmail; OFF += 2 * 3600000; await runSync();
check("Brightspace writes the list its own way (';', spaces, capitals): still no write", BS.puts === p1 && bq(112).NotificationEmail === keep, BS.puts - p1);
bq(112).NotificationEmail = "prof@usc.edu, " + ours(112); bq(111).NotificationEmail = ours(111);

console.log("S3 a Brightspace that refuses a list of addresses");
BS.quizzes.push(Object.assign(quiz(113, "Quiz 3"), { NotificationEmail: "ta@usc.edu" }));
BS.refuseList = true; OFF += 2 * 3600000; await runSync();
check("the password still goes on; the professor's own address is left as it was", /^LQ-/.test(pwOf(113) || "") && bq(113).NotificationEmail === "ta@usc.edu", JSON.stringify([pwOf(113), bq(113).NotificationEmail]));
BS.refuseList = false;

console.log("S4 a quiz LOCKqz lets go of: only LOCKqz's address goes");
await api("/protect", { ou: String(OU), qi: "112", on: false }, { "X-LOCKqz-Teacher": PROF });
OFF += 2 * 3600000; await runSync();
check("Quiz 2 released: its password gone, the professor's own address kept, LOCKqz's gone", !pwOf(112) && bq(112).NotificationEmail === "prof@usc.edu", JSON.stringify([pwOf(112), bq(112).NotificationEmail]));
check("Quiz 1 untouched", bq(111).NotificationEmail === ours(111) && /^LQ-/.test(pwOf(111) || ""));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
