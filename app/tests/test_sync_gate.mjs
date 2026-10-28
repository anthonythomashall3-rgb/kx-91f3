// The professor's Sync tab (public/sync.js) end to end, with NO browser: the REAL sync.js runs in a
// sandbox against a simulated Brightspace and the REAL LOCKqz API (in-memory SQLite). Proves the
// exam-day safety rules (24 Oct 2026):
//   * a protected quiz that is NOT gated: the app hands out exactly the password Brightspace holds;
//   * gate on: only locked students get special access; an accommodation (special access that
//     existed before the gate) is never changed or removed -- not on start, tick, tamper or stop;
//   * grants last until the quiz's end (not 90s) and survive a closed Sync tab;
//   * the password the app hands out always equals the one in Brightspace, even after the tab closes;
//   * tamper -> that student's access is removed; wifi blip ("dark") -> access kept;
//   * no IP lock is written; stop gate restores the quiz and the fixed password;
//   * reopening the Sync tab resumes a running gate with the ORIGINAL accommodation list.
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-syncgate-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
const SYNC_SRC = readFileSync(join(CF, "public", "sync.js"), "utf8");

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

// ---- LOCKqz API on an in-memory database ----
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of ["migrate_012_bs_code.sql", "migrate_013_sa_keep.sql", "migrate_014_lockqz_off.sql", "migrate_016_bs_user.sql"]) { try { sqlite.exec(readFileSync(join(CF, m), "utf8")); } catch (e) { /* already in schema.sql */ } }
const db = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
  const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
    first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
    run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } }; return o; },
  async batch(sts) { for (const s of sts) s._run(); } };
const env = { DB: db, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", LIVE_CACHE_MS: "0" };   // edits the DB between /live calls
const API = "https://lockqz.test/api";
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
const OU = 98765, QI = 12345, END = "2099-01-01T00:00:00.000Z";
const BS = {
  quiz: { QuizId: QI, Name: "Midterm", IsActive: true, StartDate: null, EndDate: END, DueDate: null, Password: null,
          AllowOnlyUsersWithSpecialAccess: false, RestrictIPAddressRange: null, AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 1 },
          Instructions: { Text: { Text: "", Html: "" }, IsDisplayed: false }, Description: { Text: { Text: "", Html: "" }, IsDisplayed: false },
          Header: { Text: { Text: "", Html: "" }, IsDisplayed: false }, Footer: { Text: { Text: "", Html: "" }, IsDisplayed: false } },
  sa: { "4005": { StartDate: null, EndDate: "2099-02-01T00:00:00.000Z", DueDate: null, SubmissionTimeLimit: { IsEnforced: true, TimeLimitValue: 90 } } },
  puts: [],
};
const classlist = [
  { Identifier: "4000", DisplayName: "Prof", Email: "prof@usc.edu", ClasslistRoleDisplayName: "Instructor" },
  { Identifier: "4001", DisplayName: "Al", Email: "al@usc.edu", ClasslistRoleDisplayName: "Student" },
  { Identifier: "4002", DisplayName: "Bo", Email: "bo@usc.edu", ClasslistRoleDisplayName: "Student" },
  { Identifier: "4005", DisplayName: "Dee (extra time)", Email: "dee@usc.edu", ClasslistRoleDisplayName: "Student" },
];
const jr = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
async function brightspace(url, opt = {}) {
  const u = new URL(url, "https://usc.brightspace.com"), p = u.pathname, m = (opt.method || "GET").toUpperCase();
  if (p === "/d2l/api/versions/") return jr([{ ProductCode: "le", LatestVersion: "1.100" }, { ProductCode: "lp", LatestVersion: "1.64" }]);
  if (p.endsWith("/users/whoami")) return jr({ Identifier: "4000", FirstName: "Prof", LastName: "" });
  if (p.includes("/enrollments/myenrollments/")) return jr({ Items: [{ OrgUnit: { Id: OU, Name: "ECON 203", Code: "ECON-203" }, Access: { IsActive: true, ClasslistRoleName: "Instructor" } }], PagingInfo: { HasMoreItems: false } });
  if (p.endsWith(`/${OU}/classlist/`)) return jr(classlist);
  if (p.endsWith(`/${OU}/quizzes/`)) return jr({ Objects: [BS.quiz], Next: null });
  const sa = p.match(/\/quizzes\/(\d+)\/specialaccess\/(\d+)?$/);
  if (sa) {
    if (!sa[2]) return jr({ Objects: Object.entries(BS.sa).map(([UserId, SpecialAccess]) => ({ UserId: Number(UserId), SpecialAccess })), Next: null });
    if (m === "PUT") { BS.sa[sa[2]] = JSON.parse(opt.body); return jr({}); }
    if (m === "DELETE") { delete BS.sa[sa[2]]; return jr({}); }
  }
  if (p.endsWith(`/quizzes/${QI}`)) {
    if (m === "PUT") { const b = JSON.parse(opt.body); BS.puts.push(b); Object.assign(BS.quiz, b); return jr({}); }
    return jr(JSON.parse(JSON.stringify(BS.quiz)));
  }
  return jr({ error: "no mock for " + p }, 404);
}

// ---- tiny DOM: just what sync.js touches ----
function makePage(src) {
  const els = {}, timers = [];
  const stub = (k, ds = {}) => (els[k] = els[k] || { textContent: "", style: {}, dataset: ds, disabled: false, checked: false, onclick: null, onchange: null, innerHTML: "" });
  const B = { innerHTML: "",
    querySelector(sel) { const m = sel.match(/\[data-(\w+)="([^"]+)"\]/); return m && this.innerHTML.includes(`data-${m[1]}="${m[2]}"`) ? stub(m[1] + ":" + m[2], { [m[1]]: m[2] }) : null; },
    querySelectorAll(sel) {
      if (sel.startsWith("input")) return [...this.innerHTML.matchAll(/data-ou="(\d+)" data-qi="(\d+)"(\s*checked)?/g)].map(x => { const e = stub("cb:" + x[2], { ou: x[1], qi: x[2] }); e.checked = !!x[3]; return e; });
      if (sel.startsWith("button[data-gate]")) return [...this.innerHTML.matchAll(/data-gate="([^"]+)"/g)].map(x => stub("gate:" + x[1], { gate: x[1] }));
      return [];
    } };
  const box = { style: {}, innerHTML: "", id: "", querySelector: s => s === "#lqz-b" ? B : { onclick: null }, remove() {} };
  let open = false;
  const document = { getElementById: () => (open ? box : null), createElement: () => box, body: { appendChild() { open = true; } },
                     currentScript: { src } };
  const ctx = { document, location: { pathname: "/d2l/home/98765" }, localStorage: { getItem: () => "csrf" },
    fetch: (url, opt) => String(url).startsWith(API) ? onRequest({ request: new Request(url, opt), env }) : brightspace(url, opt),
    setInterval: (fn) => { timers.push(fn); return timers.length; }, clearInterval: (i) => { timers[i - 1] = null; },
    URL, Date, JSON, Promise, Object, Array, String, Number, Math, RegExp, Error, encodeURIComponent, console, setTimeout };
  vm.createContext(ctx);
  const done = vm.runInContext(SYNC_SRC, ctx);
  return { done, B, els, tick: async () => { for (const t of timers) if (t) await t(); await new Promise(r => setTimeout(r, 20)); } };
}
const settle = () => new Promise(r => setTimeout(r, 50));

// ---- accounts: admin, a verified + paid professor, two student devices ----
await api("/signup", { email: "admin@usc.edu", password: "adminpass1" });
const PROF = (await api("/signup", { email: "prof@usc.edu", password: "profpass1", name: "Prof" })).data.token;
sqlite.prepare("UPDATE teachers SET verified=1, active_until='2099-12-31' WHERE email='prof@usc.edu'").run();
const KEY = (await api("/synckey", undefined, { "X-LOCKqz-Teacher": PROF })).data.key;
// the professor owns the course on a trusted roster (admin-synced) so they are its instructor
await api("/sync", { courses: [{ ou: String(OU), name: "ECON 203", role: "Instructor", classlist: classlist.map(c => ({ id: c.Identifier, name: c.DisplayName, email: c.Email, role: c.ClasslistRoleDisplayName })), quizzes: [] }] }, { "X-LOCKqz-Teacher": "admin-key" });
const SRC = `https://lockqz.test/sync.js?k=${KEY}`;
const QURL = `https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${QI}&ou=${OU}`;
const AL = { id: "mac-al01", key: randomBytes(32).toString("hex") }, BO = { id: "mac-bo01", key: randomBytes(32).toString("hex") };
for (const [d, e] of [[AL, "al@usc.edu"], [BO, "bo@usc.edu"]]) await api("/register", { device_id: d.id, key: d.key, student: e, platform: "mac" });
const lock = d => dev("/report", { device_id: d.id, event: "lock", quiz_id: `${OU}-${QI}` }, d.id, d.key);
const pw = d => dev("/password", { url: QURL, device_id: d.id }, d.id, d.key);

console.log("S1 Sync auto-protects the quiz; with no gate the app gives exactly Brightspace's password");
let page = makePage(SRC); await page.done; await settle();
check("Sync put a LOCKqz password on the quiz", /^LQ-/.test(BS.quiz.Password || ""), BS.quiz.Password);
await lock(AL);
let r = await pw(AL);
check("app's password === Brightspace's password (not gated)", r.data?.password === BS.quiz.Password, `${r.data?.password} vs ${BS.quiz.Password}`);
const SEED = BS.quiz.Password;

console.log("S2 Start gate: quiz hidden; accommodation untouched; only the locked student admitted");
const before4005 = JSON.stringify(BS.sa["4005"]);
const gb = page.B.querySelectorAll("button[data-gate]")[0];
check("Start gate button is there", !!gb);
await gb.onclick(); await settle(); await page.tick();
check("quiz hidden to everyone without special access", BS.quiz.AllowOnlyUsersWithSpecialAccess === true);
check("locked student Al granted special access", !!BS.sa["4001"]);
check("Al's grant lasts until the quiz's own end (not 90s)", BS.sa["4001"]?.EndDate === END, BS.sa["4001"]?.EndDate);
check("Bo (not locked) NOT granted", !BS.sa["4002"]);
check("accommodation (Dee, extra time) unchanged", JSON.stringify(BS.sa["4005"]) === before4005, JSON.stringify(BS.sa["4005"]));
check("no IP lock written", BS.puts.every(b => !b.RestrictIPAddressRange || !b.RestrictIPAddressRange.length));
r = await pw(AL);
check("app's password === Brightspace's password (gated, rotating)", r.data?.password === BS.quiz.Password && BS.quiz.Password !== SEED, `${r.data?.password} vs ${BS.quiz.Password}`);

console.log("S3 Sync tab closes: nothing breaks for students already in or arriving");
const pwBefore = BS.quiz.Password; // no more ticks from now on (tab "closed")
r = await pw(AL);
check("password still matches Brightspace with the tab closed", r.data?.password === pwBefore);
check("Al keeps access (no 90s expiry)", BS.sa["4001"]?.EndDate === END);

console.log("S4 wifi blip keeps access; tamper removes it; accommodation never touched");
sqlite.prepare("UPDATE locks SET last_lock=?, helper_seen=?, ext_seen=? WHERE device_id=?").run(new Date(Date.now() - 900000).toISOString(), new Date(Date.now() - 900000).toISOString(), new Date(Date.now() - 900000).toISOString(), AL.id);
await page.tick();
check("Al 'dark' (no contact) -> access kept", !!BS.sa["4001"]);
sqlite.prepare("UPDATE locks SET ext_seen=? WHERE device_id=?").run(new Date().toISOString(), AL.id);   // agent alive, helper silent
let lv = await api(`/live?quiz=${OU}-${QI}`, undefined, { "X-LOCKqz-Teacher": PROF });
check("helper silent while the agent still reports -> 'helper_killed'", lv.data?.rows?.find(x => x.device_id === AL.id)?.status === "helper_killed", JSON.stringify(lv.data?.rows));
await lock(AL); await dev("/report", { device_id: AL.id, event: "tamper", quiz_id: `${OU}-${QI}` }, AL.id, AL.key);
await page.tick();
check("Al tampered -> access removed", !BS.sa["4001"]);
check("accommodation still unchanged", JSON.stringify(BS.sa["4005"]) === before4005);

console.log("S5 reopening the Sync tab resumes the gate with the ORIGINAL accommodation list");
await lock(BO);
page = makePage(SRC); await page.done; await settle(); await page.tick();
check("gate resumed: locked Bo admitted", !!BS.sa["4002"]);
check("resume did not re-hide/reset the password", BS.quiz.AllowOnlyUsersWithSpecialAccess === true);
check("accommodation still unchanged after resume", JSON.stringify(BS.sa["4005"]) === before4005);
const keepRow = sqlite.prepare("SELECT sa_keep FROM quizzes WHERE qi=?").get(String(QI));
check("server kept the first accommodation list (not Bo's grant)", keepRow.sa_keep === JSON.stringify(["4005"]), keepRow.sa_keep);

console.log("S6 Stop gate: only LOCKqz's grants removed; quiz visible again with the fixed password");
const gb2 = page.B.querySelectorAll("button[data-gate]")[0];
await gb2.onclick(); await settle();
check("Bo's LOCKqz grant removed", !BS.sa["4002"]);
check("accommodation kept", JSON.stringify(BS.sa["4005"]) === before4005);
check("quiz visible again", BS.quiz.AllowOnlyUsersWithSpecialAccess === false);
check("fixed password restored in Brightspace", BS.quiz.Password === SEED);
r = await pw(BO);
check("app's password === Brightspace's again", r.data?.password === BS.quiz.Password);

console.log("S7 REQUIRE_GATE: an ungated protected quiz gives NO password (professor emailed); the Sync tab gates it by itself");
env.REQUIRE_GATE = "1"; const MAILS = []; env.MAIL_SINK = async m => { MAILS.push(m); return true; };
sqlite.prepare("UPDATE devices SET student_verified=1").run();   // email codes are on in this env (MAIL_SINK)
await lock(BO);
r = await pw(BO);
check("gate off -> no password, reason gate_off", r.status === 402 && r.data?.reason === "gate_off" && !r.data?.password, JSON.stringify(r.data));
check("professor emailed: open Chrome, sign in to Brightspace, keep it open", MAILS.some(m => m.to === "prof@usc.edu" && /Open Chrome/.test(m.text) && /keep it open until the quiz ends/.test(m.text)), JSON.stringify(MAILS.map(m => m.to)));
const nMail = MAILS.length; await pw(BO);
check("no second email within the hour", MAILS.length === nMail);
page = makePage(SRC); await page.done; await settle(); await page.tick(); await settle(); await page.tick();
check("Sync tab started the gate by itself: quiz hidden", BS.quiz.AllowOnlyUsersWithSpecialAccess === true);
check("server knows the quiz is gated", sqlite.prepare("SELECT gated FROM quizzes WHERE qi=?").get(String(QI)).gated === 1);
check("locked Bo admitted by the automatic gate", !!BS.sa["4002"]);
check("Al (tampered, not locked) not admitted", !BS.sa["4001"]);
check("accommodation still unchanged", JSON.stringify(BS.sa["4005"]) === before4005);
r = await pw(BO);
check("gated -> password released and equal to Brightspace's", r.data?.password && r.data.password === BS.quiz.Password, `${r.data?.password} vs ${BS.quiz.Password}`);
sqlite.prepare("UPDATE quizzes SET gated=0 WHERE qi=?").run(String(QI));
sqlite.prepare("UPDATE bs_quizzes SET end_date=? WHERE qi=?").run(new Date(Date.now() - 60000).toISOString(), String(QI));
r = await pw(BO);
check("after the quiz end: password given again (late accommodations)", !!r.data?.password, JSON.stringify(r.data));
delete env.REQUIRE_GATE; delete env.MAIL_SINK;
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
