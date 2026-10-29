// Professor zero-effort pass (27 Oct 2026). Real API on an in-memory database, the real sync.js in a
// sandbox against a simulated Brightspace, the extension / dashboard / agent sources as files.
//   Z1 default ON: a paid professor's Sync auto-protects every quiz in a class that is not turned off;
//      a class turned off gets no new protection.
//   Z2 a password changed by hand in Brightspace is written back on the next Sync.
//   Z3 emails: welcome on sign-up (HTML, subject); /email/students = a DRAFT for the professor's own mailbox
//      (LOCKqz sends nothing): kind all -> every learner; kind missing -> only students without a device.
//   Z4 cron: reminder 48 h / 3 h before an exam to non-installed students, once each; reminders off ->
//      none; T-70 check-in to the professor when the extension has not checked in, quiet after /ext-seen.
//   Z5 SMTP: multipart/alternative with text + html, Reply-To, RFC 2047 subject, several RCPT TO.
//   Z6 sources: popup wired in the manifest, field lock + first-visit card in content-bs, store config
//      block + setup checklist on the dashboard, the one-time ready notice in both agents.
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url)), APP = join(HERE, ".."), CF = join(APP, "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-zero-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
const SYNC_SRC = readFileSync(join(CF, "public", "sync.js"), "utf8");

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

function d1(sqlite) {
  return { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
    const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
      first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
      run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } }; return o; },
    async batch(sts) { for (const s of sts) s._run(); } };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort()) { try { sqlite.exec(readFileSync(join(CF, m), "utf8")); } catch (e) { if (!/duplicate column|already exists|table .* already/.test(e.message)) throw e; } }
const MAILS = [];
const env = { DB: d1(sqlite), TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", LIVE_CACHE_MS: "0", PAY_SECRET: "x".repeat(24), MAIL_SINK: async m => { MAILS.push(m); return true; } };
const API = "https://lockqz.pages.dev/api";
let lqCalls = [];
async function api(path, body, headers = {}, e = env) {
  const res = await onRequest({ request: new Request(API + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env: e });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const ADMIN = { "X-LOCKqz-Teacher": "admin-key" };
const mailsTo = who => MAILS.filter(m => (Array.isArray(m.to) ? m.to : [m.to]).includes(who));
const rcpts = m => (Array.isArray(m.to) ? m.to : [m.to]);

// ---- accounts: admin + a verified, paid professor; two classes on a trusted roster ----
await api("/signup", { email: "admin@usc.edu", password: "adminpass1" });
MAILS.length = 0;
const PROF = (await api("/signup", { email: "prof@usc.edu", password: "profpass1", name: "Duke Bristow" })).data.token;
console.log("Z3a welcome email on sign-up");
const w = mailsTo("prof@usc.edu")[0];
check("one welcome email to the professor", mailsTo("prof@usc.edu").length === 1);
check("subject: Welcome to LOCKqz — 2 steps and you're done", w && w.subject === "Welcome to LOCKqz — 2 steps and you're done", w && w.subject);
check("HTML: logo, cardinal header, Add to Chrome + Open Brightspace buttons, 560px", w && /icon128\.png/.test(w.html) && /#990000/.test(w.html) && /Add LOCKqz to Chrome/.test(w.html) && /Open Brightspace/.test(w.html) && /max-width:560px/.test(w.html));
check("text: Hi Professor Bristow, the two steps, Respectfully", w && /^Hi Professor Bristow,/.test(w.text) && /1\. Add LOCKqz to Chrome/.test(w.text) && /2\. Open Brightspace/.test(w.text) && /Respectfully,\nThe LOCKqz Team/.test(w.text));
check("store link + Proceed with caution -> Continue to install (text + HTML)", w && /chromewebstore\.google\.com\/detail\/bidlfpkdggdpmfbfkpjcnbjhfkfligkk/.test(w.text) && /Continue to install/.test(w.text) && /Continue to install/.test(w.html));
sqlite.prepare("UPDATE teachers SET verified=1, active_until='2099-12-31', bs_user_id='4000' WHERE email='prof@usc.edu'").run();
const KEY = (await api("/synckey", undefined, { "X-LOCKqz-Teacher": PROF })).data.key;
const OU = 98765, OU2 = 98766;
const classlist = [
  { id: "4000", name: "Duke Bristow", email: "prof@usc.edu", role: "Instructor" },
  { id: "4001", name: "Al", email: "al@usc.edu", role: "Student" },
  { id: "4002", name: "Bo", email: "bo@usc.edu", role: "Student" },
  { id: "4003", name: "Cy", email: "cy@usc.edu", role: "Teaching Assistant" },
];
const inDays = d => new Date(Date.now() + d * 86400e3).toISOString();
const course = (ou, name, code, quizzes) => ({ ou: String(ou), name, code, role: "Instructor", classlist, quizzes });
await api("/sync", { host: "brightspace.usc.edu", whoami: { id: "4000", name: "Duke Bristow" }, courses: [
  course(OU, "20263_FBE-437 Recession Economics", "FBE-437", [{ qi: 111, name: "Midterm", active: true, start: inDays(10), end: inDays(10.2) }, { qi: 112, name: "Final", active: true, start: inDays(40), end: inDays(40.2) }]),
  course(OU2, "20263_FBE-529 Financial Analysis", "FBE-529", [{ qi: 221, name: "Quiz A", active: true, start: inDays(5), end: inDays(5.2) }]),
] }, { "X-LOCKqz-Sync": KEY });

console.log("Z1 default ON: every quiz in an ON class is protected by itself; an OFF class is left alone");
let bs = (await api("/bs", undefined, { "X-LOCKqz-Teacher": PROF })).data;
const c1 = bs.courses.find(c => c.ou === String(OU)), c2 = bs.courses.find(c => c.ou === String(OU2));
check("both classes on the dashboard", !!c1 && !!c2, JSON.stringify(bs).slice(0, 200));
check("FBE 437: both quizzes got a LOCKqz password without a click", c1 && c1.quizzes.length === 2 && c1.quizzes.every(q => /^LQ-/.test(q.password || "")), JSON.stringify(c1 && c1.quizzes.map(q => q.password)));
check("FBE 529: its quiz too", c2 && c2.quizzes.every(q => /^LQ-/.test(q.password || "")));
check("/bs carries mail_on, mailed_at (none yet) and reminders (on) per class", bs.mail_on === true && c1.mailed_at === null && c1.reminders === true, JSON.stringify({ mail_on: bs.mail_on, mailed_at: c1.mailed_at, reminders: c1.reminders }));
await api("/class", { ou: String(OU2), on: false }, { "X-LOCKqz-Teacher": PROF });
await api("/protect", { ou: String(OU2), qi: "221", on: false }, { "X-LOCKqz-Teacher": PROF });
await api("/sync", { host: "brightspace.usc.edu", whoami: { id: "4000", name: "Duke Bristow" }, courses: [
  course(OU, "20263_FBE-437 Recession Economics", "FBE-437", [{ qi: 111, name: "Midterm", active: true, start: inDays(10), end: inDays(10.2) }, { qi: 112, name: "Final", active: true, start: inDays(40), end: inDays(40.2) }, { qi: 113, name: "Pop quiz", active: true, start: null, end: null }]),
  course(OU2, "20263_FBE-529 Financial Analysis", "FBE-529", [{ qi: 221, name: "Quiz A", active: true, start: inDays(5), end: inDays(5.2) }, { qi: 222, name: "Quiz B", active: true, start: inDays(6), end: inDays(6.2) }]),
] }, { "X-LOCKqz-Sync": KEY });
bs = (await api("/bs", undefined, { "X-LOCKqz-Teacher": PROF })).data;
const n1 = bs.courses.find(c => c.ou === String(OU)), n2 = bs.courses.find(c => c.ou === String(OU2));
check("a new quiz in the ON class is protected by itself", n1.quizzes.find(q => q.qi === "113") && /^LQ-/.test(n1.quizzes.find(q => q.qi === "113").password || ""), JSON.stringify(n1.quizzes.map(q => [q.qi, q.password])));
check("the OFF class: no quiz protected (old or new)", n2.off === true && n2.quizzes.every(q => !q.password), JSON.stringify(n2.quizzes.map(q => [q.qi, q.password])));
await api("/class", { ou: String(OU2), on: true }, { "X-LOCKqz-Teacher": PROF });

console.log("Z2 a password changed by hand in Brightspace comes back on the next Sync (real sync.js)");
{
  const quiz = (qi, name) => ({ QuizId: qi, Name: name, IsActive: true, StartDate: inDays(10), EndDate: inDays(10.2), DueDate: null, Password: null,
    AllowOnlyUsersWithSpecialAccess: false, RestrictIPAddressRange: null, AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 1 },
    Instructions: { Text: { Text: "", Html: "" }, IsDisplayed: false }, Description: { Text: { Text: "", Html: "" }, IsDisplayed: false },
    Header: { Text: { Text: "", Html: "" }, IsDisplayed: false }, Footer: { Text: { Text: "", Html: "" }, IsDisplayed: false } });
  const BSQ = [quiz(111, "Midterm"), quiz(112, "Final"), quiz(113, "Pop quiz")];
  const jr = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
  const cl = classlist.map(c => ({ Identifier: c.id, DisplayName: c.name, Email: c.email, ClasslistRoleDisplayName: c.role }));
  async function brightspace(url, opt = {}) {
    const u = new URL(url, "https://brightspace.usc.edu"), p = u.pathname, m = (opt.method || "GET").toUpperCase();
    if (p === "/d2l/api/versions/") return jr([{ ProductCode: "le", LatestVersion: "1.100" }, { ProductCode: "lp", LatestVersion: "1.64" }]);
    if (p.endsWith("/users/whoami")) return jr({ Identifier: "4000", FirstName: "Duke", LastName: "Bristow" });
    if (p.includes("/enrollments/myenrollments/")) return jr({ Items: [{ OrgUnit: { Id: OU, Name: "20263_FBE-437 Recession Economics", Code: "FBE-437" }, Access: { IsActive: true, ClasslistRoleName: "Instructor" } }], PagingInfo: { HasMoreItems: false } });
    if (p.endsWith(`/${OU}/classlist/paged/`)) return jr({ Objects: cl, Next: null });
    if (p.endsWith(`/${OU}/quizzes/`)) return jr({ Objects: BSQ, Next: null });
    const one = p.match(/\/quizzes\/(\d+)$/);
    if (one) { const q = BSQ.find(x => String(x.QuizId) === one[1]); if (!q) return jr({}, 404); if (m === "PUT") { Object.assign(q, JSON.parse(opt.body)); return jr({}); } return jr(JSON.parse(JSON.stringify(q))); }
    if (/\/specialaccess\/$/.test(p)) return jr({ Objects: [], Next: null });
    return jr({ error: "no mock for " + p }, 404);
  }
  const attached = new Set(), runs = []; let current = null;
  const mkEl = tag => { const B = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] }; const el = { tag, id: "", style: {}, dataset: {}, innerHTML: "", src: "", B,
    querySelector: s => s === "#lqz-b" ? B : { onclick: null, textContent: "" }, addEventListener() {}, remove() { attached.delete(el); if (current === el) current = null; } }; return el; };
  const document = { get currentScript() { return runs.length ? runs[runs.length - 1] : null; }, getElementById: id => (id === "lqz-sync" && current && attached.has(current) ? current : null),
    createElement: mkEl, body: { contains: el => attached.has(el), appendChild(el) { attached.add(el); if (el.id === "lqz-sync") current = el; if (el.tag === "script") inject(el); } }, head: null };
  const store = new Map();
  const ctx = { window: { opener: null, addEventListener() {}, open: () => null }, document, location: { pathname: "/d2l/home/98765", host: "brightspace.usc.edu" },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    fetch: (url, opt) => { if (String(url).startsWith(API)) { lqCalls.push(String(url).slice(API.length).split("?")[0]); return onRequest({ request: new Request(url, opt), env }); } return brightspace(url, opt); },
    setInterval: () => 1, clearInterval() {}, URL, JSON, Promise, Object, Array, String, Number, Math, RegExp, Error, Date, encodeURIComponent, console, setTimeout, confirm: () => true };
  vm.createContext(ctx);
  let pending = [];
  const inject = script => { runs.push(script); pending.push(vm.runInContext(SYNC_SRC, ctx)); runs.pop(); };
  const settle = async () => { while (pending.length) { const p = pending; pending = []; await Promise.all(p); } await new Promise(r => setTimeout(r, 30)); };
  const SRC = `https://prof.lockqz.pages.dev/sync.js?k=${KEY}`;
  const run = async () => { if (current) current.remove(); const s = mkEl("script"); s.src = SRC; document.body.appendChild(s); await settle(); };
  await run();
  const pw1 = BSQ[0].Password;
  check("Sync put the LOCKqz password on the Midterm", /^LQ-/.test(pw1 || ""), pw1);
  BSQ[0].Password = "mysecret99";   // the professor typed their own password over it in Brightspace
  await run();
  check("changed by hand -> the next Sync writes LOCKqz's password back", BSQ[0].Password === pw1, BSQ[0].Password);
  check("the professor's hand-typed password is saved as their own setting (restored if LOCKqz is turned off)", JSON.stringify(sqlite.prepare("SELECT orig FROM bs_quizzes WHERE ou=? AND qi='111'").get(String(OU))).includes("mysecret99"), JSON.stringify(sqlite.prepare("SELECT orig FROM bs_quizzes WHERE ou=? AND qi='111'").get(String(OU))));
  check("the panel ticks the Midterm as protected (default on)", /data-qi="111" checked/.test(current.B.innerHTML), current.B.innerHTML.slice(0, 300));
}

console.log("Z3 /email/students: a draft the professor sends from their own mailbox (LOCKqz's Gmail sends nothing)");
// Al has a verified LOCKqz device; Bo and Cy (a TA) do not.
sqlite.prepare("INSERT INTO devices (device_id,student,platform,device_key,student_verified,installed_at) VALUES ('dev-al','al@usc.edu','mac-15','k',1,datetime('now'))").run();
const budget = () => sqlite.prepare("SELECT COALESCE(SUM(n),0) AS n FROM mail_sent WHERE ou='_all'").get().n;
MAILS.length = 0; const b0 = budget();
let r = await api("/email/students", { ou: String(OU), kind: "all" }, { "X-LOCKqz-Teacher": PROF });
check("kind all -> the 3 students (Al, Bo, TA Cy), never the professor", r.data && Array.isArray(r.data.to) && r.data.to.slice().sort().join() === "al@usc.edu,bo@usc.edu,cy@usc.edu", JSON.stringify(r.data && r.data.to));
check("LOCKqz sent NOTHING (no email, no Gmail budget used)", MAILS.length === 0 && budget() === b0, MAILS.length + " / " + budget());
check("subject: FBE-437: install LOCKqz before your first exam", r.data.subject === "FBE-437: install LOCKqz before your first exam", r.data.subject);
check("text: the 3 steps, signed Professor Duke Bristow / course, first exam named, no 'sent by LOCKqz on behalf' footer", /1\. Download LOCKqz/.test(r.data.text) && /the exam will not open/.test(r.data.text) && /Respectfully,\nProfessor Duke Bristow\nFBE-437 – Recession Economics/.test(r.data.text) && /First exam: Midterm, /.test(r.data.text) && !/on behalf of/.test(r.data.text), r.data.text.slice(-200));
bs = (await api("/bs", undefined, { "X-LOCKqz-Teacher": PROF })).data;
check("/bs now shows mailed_at for that class (Set-up step 3 done, Remind button next)", !!bs.courses.find(c => c.ou === String(OU)).mailed_at);
r = await api("/email/students", { ou: String(OU), kind: "missing" }, { "X-LOCKqz-Teacher": PROF });
check("kind missing -> only Bo and Cy (Al has LOCKqz)", r.data && r.data.to.slice().sort().join() === "bo@usc.edu,cy@usc.edu", JSON.stringify(r.data && r.data.to));
check("reminder subject names the exam; says when", /^Reminder: install LOCKqz before Midterm on /.test(r.data.subject) && /Midterm for FBE-437 – Recession Economics is in 10 days/.test(r.data.text), r.data.subject);
r = await api("/email/students", { ou: String(OU2), kind: "all" }, { "X-LOCKqz-Teacher": "bogus-token" });
check("a stranger cannot get a class's addresses", r.status === 401 || r.status === 403, r.status);
const offEnv = { ...env, MAIL_SINK: undefined };
r = await api("/email/students", { ou: String(OU), kind: "all" }, { "X-LOCKqz-Teacher": PROF }, offEnv);
check("works with LOCKqz email not set up at all (the professor's mailbox sends it)", r.status === 200 && r.data.to.length === 3, JSON.stringify(r.data && r.data.error));

console.log("Z4 cron: automatic reminders + the T-70 check-in");
const CRON = { "X-LOCKqz-Pay": env.PAY_SECRET };
// Both classes back in sync (Z2's Brightspace listed only the first), every quiz protected by default.
await api("/sync", { host: "brightspace.usc.edu", whoami: { id: "4000", name: "Duke Bristow" }, courses: [
  course(OU, "20263_FBE-437 Recession Economics", "FBE-437", [{ qi: 111, name: "Midterm", active: true, start: inDays(10), end: inDays(10.2) }, { qi: 112, name: "Final", active: true, start: inDays(40), end: inDays(40.2) }, { qi: 113, name: "Pop quiz", active: true, start: null, end: null }]),
  course(OU2, "20263_FBE-529 Financial Analysis", "FBE-529", [{ qi: 221, name: "Quiz A", active: true, start: inDays(5), end: inDays(5.2) }, { qi: 222, name: "Quiz B", active: true, start: inDays(6), end: inDays(6.2) }]),
] }, { "X-LOCKqz-Sync": KEY });
check("after the class was turned back on, its new quiz is protected by default; the one the professor switched off by hand stays off", sqlite.prepare("SELECT COUNT(*) AS n FROM quizzes WHERE ou=? AND qi='222'").get(String(OU2)).n === 1 && sqlite.prepare("SELECT COUNT(*) AS n FROM quizzes WHERE ou=? AND qi='221'").get(String(OU2)).n === 0);
const setStart = (qi, hoursAhead) => sqlite.prepare("UPDATE bs_quizzes SET start_date=?, end_date=? WHERE qi=?").run(new Date(Date.now() + hoursAhead * 3600e3).toISOString(), new Date(Date.now() + (hoursAhead + 2) * 3600e3).toISOString(), String(qi));
setStart(111, 40); setStart(112, 400); setStart(113, 400); setStart(221, 400); setStart(222, 400);
MAILS.length = 0;
r = await api("/cron", {}, CRON);
check("/cron needs the secret", (await api("/cron", {}, { "X-LOCKqz-Pay": "nope" })).status === 401);
check("40 h before the Midterm: ONE reminder to the students without LOCKqz (Bo, Cy)", r.data && r.data.exams && r.data.exams.reminders === 2 && MAILS.length === 1 && rcpts(MAILS[0]).sort().join() === "bo@usc.edu,cy@usc.edu", JSON.stringify(r.data) + JSON.stringify(MAILS.map(m => m.to)));
check("'in 2 days', Reply-To the professor", /is in 2 days/.test(MAILS[0].text) && MAILS[0].replyTo === "prof@usc.edu", MAILS[0].text.slice(0, 160));
MAILS.length = 0;
r = await api("/cron", {}, CRON);
check("the next tick sends nothing again (once per exam)", MAILS.length === 0 && r.data.exams.reminders === 0, JSON.stringify(r.data));
setStart(111, 2.5); MAILS.length = 0;
await api("/cron", {}, CRON);
const stu = () => MAILS.filter(m => Array.isArray(m.to) || m.to !== "prof@usc.edu");
check("2.5 h before: the 3-hour reminder to the students, once", stu().length === 1 && /is in 3 hours|is in 2 hours/.test(stu()[0].text), JSON.stringify(MAILS.map(m => [m.to, m.subject])));
const ix = mailsTo("prof@usc.edu");
check("…and the professor, who never added the extension, gets ONE 'add LOCKqz to Chrome' email (exam within a day)", ix.length === 1 && /add LOCKqz to Chrome$/.test(ix[0].subject), JSON.stringify(ix.map(m => m.subject)));
check("it says keep Chrome open until the exam ends, and that students wait without it", ix[0] && /keep Chrome open until the exam ends/.test(ix[0].text) && /students wait at the start/.test(ix[0].text) && /Respectfully,\nThe LOCKqz Team/.test(ix[0].text), ix[0] && ix[0].text);
MAILS.length = 0; await api("/cron", {}, CRON);
check("…and not again", MAILS.length === 0);
// Reminders off for a class: nothing.
setStart(222, 30);
await api("/class-mail", { ou: String(OU2), reminders: false }, { "X-LOCKqz-Teacher": PROF });
bs = (await api("/bs", undefined, { "X-LOCKqz-Teacher": PROF })).data;
check("/bs shows reminders off for that class", bs.courses.find(c => c.ou === String(OU2)).reminders === false);
MAILS.length = 0; await api("/cron", {}, CRON);
check("reminders off -> no reminder for that class", MAILS.length === 0, JSON.stringify(MAILS.map(m => [m.to, m.subject])));
await api("/class-mail", { ou: String(OU2), reminders: true }, { "X-LOCKqz-Teacher": PROF });
MAILS.length = 0; await api("/cron", {}, CRON);
check("reminders back on -> the 48 h reminder goes out", MAILS.length === 1 && /Quiz B/.test(MAILS[0].subject), JSON.stringify(MAILS.map(m => [m.to, m.subject])));
// Never added the extension: the 'add LOCKqz to Chrome' email went once today already (above); no T-70 check-in.
setStart(112, 1); MAILS.length = 0;
r = await api("/cron", {}, CRON);
check("another exam in 60 min the same day -> no second 'add LOCKqz' email, no check-in (it never checked in)", mailsTo("prof@usc.edu").length === 0 && r.data.exams.checkins === 0, JSON.stringify(MAILS.map(m => [m.to, m.subject])));
// The extension checked in once, 7 h ago: stale -> ONE check-in email.
r = await api("/ext-seen", {}, { "X-LOCKqz-Sync": KEY });
check("/ext-seen through the Sync key: ok, ext_seen set", r.data && r.data.ok && !!sqlite.prepare("SELECT ext_seen FROM teachers WHERE email='prof@usc.edu'").get().ext_seen);
sqlite.prepare("UPDATE teachers SET ext_seen=? WHERE email='prof@usc.edu'").run(new Date(Date.now() - 7 * 3600e3).toISOString());
MAILS.length = 0; r = await api("/cron", {}, CRON);
const ck = mailsTo("prof@usc.edu");
check("checked in 7 h ago, exam in 60 min -> ONE email to the professor", ck.length === 1 && r.data.exams.checkins === 1, JSON.stringify(MAILS.map(m => [m.to, m.subject])));
check("subject: Final starts in about an hour — open Chrome", ck[0] && ck[0].subject === "Final starts in about an hour — open Chrome", ck[0] && ck[0].subject);
check("body: open Chrome, sign in to Brightspace, keep it open; students wait without it (the truth); Respectfully", ck[0] && /Open Chrome on a computer that's on, sign in to Brightspace, and keep it open until the exam ends\./.test(ck[0].text) && /students wait at the start of the exam/.test(ck[0].text) && !/either way/.test(ck[0].text) && /Respectfully,\nThe LOCKqz Team/.test(ck[0].text), ck[0] && ck[0].text);
MAILS.length = 0; await api("/cron", {}, CRON);
check("not again for the same exam", mailsTo("prof@usc.edu").length === 0);
// Fresh check-in: no email for the next exam.
await api("/ext-seen", {}, { "X-LOCKqz-Sync": KEY });
sqlite.prepare("UPDATE teachers SET ext_seen=? WHERE email='prof@usc.edu'").run(new Date().toISOString());
setStart(113, 0.9); MAILS.length = 0; await api("/cron", {}, CRON);
check("extension checked in within 6 h -> no check-in email", mailsTo("prof@usc.edu").length === 0, JSON.stringify(MAILS.map(m => [m.to, m.subject])));
r = await api("/ext-status", undefined, { "X-LOCKqz-Sync": KEY });
check("/ext-status (popup): name, counts, next exam with installed/total, no student data", r.data && r.data.name === "Duke Bristow" && r.data.classes === 2 && r.data.exams + r.data.waiting >= 3 && r.data.next && r.data.next.total === 3 && r.data.next.ready === 1 && !JSON.stringify(r.data).includes("al@usc.edu"), JSON.stringify(r.data));
check("/pay/tick runs the same exam tick", (await api("/pay/tick", {}, CRON)).data.exams !== undefined);

console.log("Z5 SMTP: multipart/alternative, Reply-To, RFC 2047 subject, several recipients");
{
  const said = [];
  const fakeSmtp = codes => async () => { const replies = [...codes]; let ctl;
    const readable = new ReadableStream({ start(c) { ctl = c; c.enqueue(new TextEncoder().encode(replies.shift())); } });
    let data = false, msg = "";
    const writable = new WritableStream({ write(chunk) { const t = new TextDecoder().decode(chunk);
      if (data) { msg += t; if (msg.endsWith("\r\n.\r\n")) { data = false; said.push("MSG:" + msg); ctl.enqueue(new TextEncoder().encode(replies.shift())); } return; }
      said.push(t.trim()); if (t.startsWith("QUIT")) return; if (t.startsWith("DATA")) data = true;
      const rep = replies.shift(); if (rep) ctl.enqueue(new TextEncoder().encode(rep)); } });
    return { readable, writable, close: async () => {} }; };
  const OK = ["220 smtp.gmail.com ESMTP\r\n", "250-smtp.gmail.com\r\n250 SMTPUTF8\r\n", "235 2.7.0 Accepted\r\n", "250 OK\r\n", "250 OK\r\n", "250 OK\r\n", "354 Go\r\n", "250 2.0.0 queued\r\n"];
  const smtpEnv = { ...env, MAIL_SINK: undefined, MAIL_USER: "lockqz.app@gmail.com", MAIL_APP_PASSWORD: "abcd efgh ijkl mnop", MAIL_OPEN: fakeSmtp(OK) };
  sqlite.prepare("DELETE FROM mail_sent").run();
  [112, 113, 221, 222].forEach(q => setStart(q, 400));
  setStart(111, 30);   // only the Midterm in the window (30 h away): its 48 h reminder goes to Bo and Cy through the fake Gmail
  r = await api("/cron", {}, CRON, smtpEnv);
  check("sent through the fake Gmail", r.data && r.data.exams && r.data.exams.reminders === 2, JSON.stringify(r.data) + " " + JSON.stringify(said.slice(0, 6)));
  check("one session, two RCPT TO", said.filter(x => x.startsWith("RCPT TO:")).length === 2, JSON.stringify(said.filter(x => x.startsWith("RCPT"))));
  const body = said.find(x => x.startsWith("MSG:")) || "";
  check("From: LOCKqz, Reply-To the professor, recipients not listed in To:", /From: LOCKqz <lockqz\.app@gmail\.com>/.test(body) && /Reply-To: <prof@usc\.edu>/.test(body) && !/To: <bo@usc\.edu>/.test(body), body.slice(0, 300));
  check("multipart/alternative with a text part and an HTML part", /Content-Type: multipart\/alternative; boundary="lqz[0-9a-f]+"/.test(body) && /Content-Type: text\/plain; charset=utf-8/.test(body) && /Content-Type: text\/html; charset=utf-8/.test(body) && /<!doctype html>/.test(body));
  check("an ASCII subject goes as is", /Subject: Reminder: install LOCKqz before [\x20-\x7e]+\r\n/.test(body), (body.match(/Subject: [^\r]*/) || [])[0]);
  said.length = 0;
  await api("/signup", { email: "new@usc.edu", password: "newpass123", name: "Ada Lovelace" }, {}, { ...smtpEnv, MAIL_OPEN: fakeSmtp(OK.slice(0, 5).concat(OK.slice(6))) });
  await new Promise(r => setTimeout(r, 50));
  const wb = said.find(x => x.startsWith("MSG:")) || "";
  check("a subject with an em dash (the welcome) is RFC 2047 encoded", /Subject: =\?utf-8\?B\?[A-Za-z0-9+\/=]+\?=\r\n/.test(wb) && Buffer.from((wb.match(/Subject: =\?utf-8\?B\?([A-Za-z0-9+\/=]+)\?=/) || [])[1] || "", "base64").toString() === "Welcome to LOCKqz \u2014 2 steps and you're done", (wb.match(/Subject: [^\r]*/) || [])[0]);
}

console.log("Z6 sources");
const EXT = join(APP, "extension-prof");
const man = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
check("manifest: the toolbar icon opens popup.html", man.action && man.action.default_popup === "popup.html");
check("popup.html + popup.js exist; the popup shows status, last synced, counts, next exam, the two buttons", existsSync(join(EXT, "popup.html")) && /Open dashboard/.test(readFileSync(join(EXT, "popup.html"), "utf8")) && /Sync now/.test(readFileSync(join(EXT, "popup.html"), "utf8")) && /ext-status/.test(readFileSync(join(EXT, "popup.js"), "utf8")) && /Last synced/.test(readFileSync(join(EXT, "popup.js"), "utf8")));
const bg = readFileSync(join(EXT, "background.js"), "utf8");
check("background: no action.onClicked (the popup replaced it); checks in with /ext-seen; first-visit flag once", !/action\.onClicked/.test(bg) && /\/ext-seen/.test(bg) && /welcomed/.test(bg));
const cb = readFileSync(join(EXT, "content-bs.js"), "utf8");
check("content-bs: protected exam's quiz settings -> one notice, NOTHING disabled (special access / extra time keep working)", /LOCKqz protects this exam/.test(cb) && /Special access and extra time work as usual/.test(cb) && cb.includes("quizzing\\/admin") && !/\.disabled\s*=\s*true/.test(cb) && !/setAttribute\("disabled"/.test(cb) && !/pointerEvents/.test(cb));
check("content-bs: the one-time first-visit card (Syncing your classes… -> Done — N classes synced)", /Syncing your classes/.test(cb) && /Open dashboard/.test(cb) && /12000/.test(cb));
check("build.sh packages the popup", /popup\.html popup\.js/.test(readFileSync(join(EXT, "build.sh"), "utf8")));
const dash = readFileSync(join(CF, "public", "dashboard.html"), "utf8");
check("dashboard: Chrome + Edge buttons go to the Chrome Web Store listing; Firefox keeps the zip fallback + load-unpacked line", dash.includes('const EXT_STORE = { CHROME: "https://chromewebstore.google.com/detail/bidlfpkdggdpmfbfkpjcnbjhfkfligkk", EDGE: "https://chromewebstore.google.com/detail/bidlfpkdggdpmfbfkpjcnbjhfkfligkk", FIREFOX: "" }') && /lockqz-prof-chromium\.zip/.test(dash) && /Load unpacked/.test(dash));
check("dashboard: Set up — N of 3 done, the three steps with their exact buttons", /Set up — \$\{done\} of 3 done/.test(dash) && /Add LOCKqz to \$\{BROWSER_NAME\}/.test(dash) && />Open Brightspace</.test(dash) && /Email students/.test(dash) && /Remind the \$\{s\.missing\.length\} who aren't ready/.test(dash) && /Emailed \$\{esc\(when\(c\.mailed_at\)\)\}/.test(dash));
check("dashboard: Email students opens the professor's own mail app (mailto Bcc, copy-to-Bcc for big classes), per-exam 'Nothing to do' line, reminders switch", /location\.href = full/.test(dash) && /mailto:\?bcc=/.test(dash) && /Paste them into Bcc/.test(dash) && /Nothing to do\. LOCKqz sets the password and, while your browser is open, lets in students who have LOCKqz\./.test(dash) && !/opens the exam for installed students/.test(dash) && /setReminders/.test(dash));
check("dashboard: no bookmark anywhere a professor can see (no drag button, no bookmarks-bar steps)", !/class="bmk"/.test(dash) && !/bookmarks bar/i.test(dash) && !/Drag this button/.test(dash));
check("dashboard: welcome page (3 steps, exam-day rule, how it works) shown first, and from the menu", /Welcome to LOCKqz/.test(dash) && /What you do — once/.test(dash) && /On exam day: keep \$\{BROWSER_NAME\} open and signed in to Brightspace until the exam ends\./.test(dash) && /How it works/.test(dash) && /v==="" && !welcomed\(\)/.test(dash) && /How LOCKqz works/.test(dash));
check("dashboard: exam-day banner (protected exam within 24 h) says keep the browser open", /examday/.test(dash) && /Keep \$\{BROWSER_NAME\} open and signed in to Brightspace until it ends\./.test(dash));
check("dashboard: Safari gets 'works in Chrome, Edge or Firefox'", /LOCKqz works in Chrome, Edge or Firefox/.test(dash));
check("extension popup: the exam-day line", /On exam day:<\/b> keep this browser open and signed in to Brightspace until the exam ends/.test(readFileSync(join(EXT, "popup.html"), "utf8")));
check("the logo is served at lockqz.pages.dev/icon128.png (emails)", existsSync(join(CF, "public", "icon128.png")));
const mac = readFileSync(join(APP, "mac", "lockqz-agent.py"), "utf8"), win = readFileSync(join(APP, "windows", "lockqz-agent.ps1"), "utf8");
check("Mac agent: the one-time ready notice (display notification, flag file)", /display notification/.test(mac) && /LOCKqz is ready\. Nothing to do until your exam/.test(mac) && /ready-shown/.test(mac) && /verify_call\("status"\)/.test(mac) && /Finish setup before your exam/.test(mac));
check("Windows agent: the one-time ready toast (flag file)", /ToastNotification/.test(win) && /LOCKqz is ready\. Nothing to do until your exam/.test(win) && /ready-shown/.test(win) && /op = "status"/.test(win) && /Finish setup before your exam/.test(win));
check("Gmail script calls /cron every ~10 min; wrangler.toml explains (Pages has no cron trigger)", /\/cron/.test(readFileSync(join(APP, "payments", "LOCKqz-payments.gs"), "utf8")) && /\/api\/cron/.test(readFileSync(join(CF, "wrangler.toml"), "utf8")));

console.log("Z7 one Gmail budget: automatic mail stops at 250 / 24 h, sign-in codes always have room (up to 480)");
{
  const hour = () => new Date().toISOString().slice(0, 13);
  const setUsed = k => { sqlite.prepare("DELETE FROM mail_sent WHERE ou='_all'").run(); if (k) sqlite.prepare("INSERT INTO mail_sent (ou,kind,day,n,at) VALUES ('_all','total',?,?,datetime('now'))").run(hour(), k); };
  const used = () => sqlite.prepare("SELECT COALESCE(SUM(n),0) AS n FROM mail_sent WHERE ou='_all'").get().n;
  const code = async em => api("/account", { op: "send", email: em }, {});
  // every send is counted: one sign-in code = +1
  setUsed(0); MAILS.length = 0;
  r = await code("al@usc.edu");
  check("a sign-in code is counted in the one budget (+1)", r.data && r.data.sent === true && used() === 1, JSON.stringify(r.data) + " used=" + used());
  // automatic budget spent: a reminder is held (not marked sent), the professor's T-70 too, but codes still go
  sqlite.prepare("DELETE FROM mail_sent WHERE kind LIKE 'r48:%' OR kind LIKE 'r3:%' OR kind LIKE 'ck:%' OR kind LIKE 'ix:%'").run();
  sqlite.prepare("DELETE FROM events WHERE event='code_sent'").run();
  [112, 113, 221, 222].forEach(q => setStart(q, 400));
  setStart(111, 30); setUsed(249); MAILS.length = 0;
  r = await api("/cron", {}, CRON);
  check("249 used: the 2-student reminder does not fit under 250 -> held, nothing sent", MAILS.length === 0 && r.data.exams.reminders === 0 && r.data.exams.skipped >= 1, JSON.stringify(r.data) + JSON.stringify(MAILS.map(m => m.subject)));
  check("…and NOT marked sent (a later tick sends it once there is room)", !sqlite.prepare("SELECT 1 AS x FROM mail_sent WHERE kind LIKE 'r48:111'").get());
  r = await code("bo@usc.edu");
  check("249 used: a student's sign-in code STILL goes (codes are essential, up to 480)", r.data && r.data.sent === true && MAILS.length === 1, JSON.stringify(r.data));
  setUsed(400); MAILS.length = 0;
  sqlite.prepare("DELETE FROM events WHERE event='code_sent'").run();
  r = await code("cy@usc.edu");
  check("400 used: a code for a student on a class list still goes", r.data && r.data.sent === true, JSON.stringify(r.data));
  sqlite.prepare("DELETE FROM events WHERE event='code_sent'").run();
  r = await code("stranger@usc.edu");
  check("400 used: an email on no class list is refused (the second half is kept for real students)", r.status === 503 && r.data.error === "mail_busy", JSON.stringify(r.data));
  setUsed(480); sqlite.prepare("DELETE FROM events WHERE event='code_sent'").run();
  r = await code("al@usc.edu");
  check("480 used: nothing more today (Gmail's 500 is never crossed)", r.status === 503 && r.data.error === "mail_busy", JSON.stringify(r.data));
  // rolling 24 h: what was sent 26 h ago no longer counts
  sqlite.prepare("DELETE FROM mail_sent WHERE ou='_all'").run();
  sqlite.prepare("INSERT INTO mail_sent (ou,kind,day,n,at) VALUES ('_all','total',?,480,datetime('now'))").run(new Date(Date.now() - 26 * 3600e3).toISOString().slice(0, 13));
  sqlite.prepare("DELETE FROM events WHERE event='code_sent'").run();
  r = await code("al@usc.edu");
  check("rolling 24 h: 480 sent 26 hours ago does not block today", r.data && r.data.sent === true, JSON.stringify(r.data));
  // room again -> the held reminder goes on the next tick, once
  setUsed(0); MAILS.length = 0;
  r = await api("/cron", {}, CRON);
  check("room again -> the held reminder goes on the next tick (2 students), counted +2", r.data.exams.reminders === 2 && used() === 2, JSON.stringify(r.data) + " used=" + used());
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
