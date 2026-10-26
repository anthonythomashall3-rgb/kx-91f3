// USC OSAS accommodations + every quiz-timing case (26 Oct 2026). The REAL sync.js runs against a
// simulated Brightspace and the REAL LOCKqz API (in-memory SQLite). Proves:
//   * extended time: the helper's failsafe end and the server's quiz_ended release use end + time limit
//     x worst-case accommodation (Brightspace lets an attempt begun before the end run past it), never
//     the bare end; untimed / unbounded timing -> end + 6 h;
//   * special access the professor / OSAS adds WHILE a gate runs becomes an accommodation (own window:
//     no start check, no end-based release) and is never changed or removed;
//   * REQUIRE_GATE never holds the password before a gate can run (OSAS early sitting) or after the end;
//   * a professor-set assistive-tool allowance per student reaches only that student's /password;
//   * quiz dates across the 1 Nov 2026 DST change / midnight UTC are pure UTC arithmetic.
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
    if (m === "DELETE") { (BS.log = BS.log || []).push("del:" + sa[2]); delete BS.sa[sa[2]]; return jr({}); }
  }
  if (p.endsWith(`/quizzes/${QI}`)) {
    if (m === "PUT") { const b = JSON.parse(opt.body); BS.puts.push(b); (BS.log = BS.log || []).push("quiz:hidden=" + b.AllowOnlyUsersWithSpecialAccess); Object.assign(BS.quiz, b); return jr({}); }
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

// ---- accounts: a verified + paid professor; Al, Bo, Dee (OSAS) devices ----
await api("/signup", { email: "admin@usc.edu", password: "adminpass1" });
const PROF = (await api("/signup", { email: "prof@usc.edu", password: "profpass1", name: "Prof" })).data.token;
sqlite.prepare("UPDATE teachers SET verified=1, active_until='2099-12-31' WHERE email='prof@usc.edu'").run();
const KEY = (await api("/synckey", undefined, { "X-LOCKqz-Teacher": PROF })).data.key;
await api("/sync", { courses: [{ ou: String(OU), name: "ECON 203", role: "Instructor", classlist: classlist.map(c => ({ id: c.Identifier, name: c.DisplayName, email: c.Email, role: c.ClasslistRoleDisplayName })), quizzes: [] }] }, { "X-LOCKqz-Teacher": "admin-key" });
const SRC = `https://lockqz.test/sync.js?k=${KEY}`;
const QURL = `https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${QI}&ou=${OU}`;
const mk = () => ({ id: "mac-" + randomBytes(4).toString("hex"), key: randomBytes(32).toString("hex") });
const AL = mk(), BO = mk(), DEE = mk();
for (const [d, e] of [[AL, "al@usc.edu"], [BO, "bo@usc.edu"], [DEE, "dee@usc.edu"]]) await api("/register", { device_id: d.id, key: d.key, student: e, platform: "mac" });
const lock = d => dev("/report", { device_id: d.id, event: "lock", quiz_id: `${OU}-${QI}` }, d.id, d.key);
const beat = d => dev("/report", { device_id: d.id, event: "heartbeat", source: "helper", quiz_id: `${OU}-${QI}` }, d.id, d.key);
const pw = d => dev("/password", { url: QURL, device_id: d.id }, d.id, d.key);
const iso = ms => new Date(Date.now() + ms).toISOString();
const row = () => sqlite.prepare("SELECT * FROM bs_quizzes WHERE ou=? AND qi=?").get(String(OU), String(QI));
const MIN = 60000;

// A 60-minute timed quiz (auto-submit at the limit, 5 min grace), open now for 50 more minutes.
// Dee (OSAS) already sat it yesterday at the testing center (her own special-access window).
Object.assign(BS.quiz, { StartDate: iso(-10 * MIN), EndDate: iso(50 * MIN), SubmissionGracePeriod: 5,
  SubmissionTimeLimit: { IsEnforced: true, ShowClock: true, TimeLimitValue: 60 }, LateSubmissionInfo: { LateSubmissionOption: 0, LateLimitMinutes: null } });
BS.sa = { "4005": { StartDate: iso(-26 * 3600e3), EndDate: iso(-23 * 3600e3), DueDate: null, SubmissionTimeLimit: { IsEnforced: true, ShowClock: true, TimeLimitValue: 90 }, AttemptsAllowed: null } };
const deeSA = JSON.stringify(BS.sa["4005"]);

console.log("O1 Sync reads the quiz's timing: how long an attempt may run past the end");
let page = makePage(SRC); await page.done; await settle();
check("'allow normal submission' after the limit (unbounded) -> over_min NULL (6 h assumed)", row()?.over_min === null, JSON.stringify(row()));
BS.quiz.LateSubmissionInfo = { LateSubmissionOption: 2, LateLimitMinutes: null };
page = makePage(SRC); await page.done; await settle();
check("auto-submit, 60 min limit, 5 min grace -> over_min = 60 x 3 (worst-case accommodation) + 5 = 185", row()?.over_min === 185, JSON.stringify(row()));

console.log("O2 gated: the helper's end = quiz end + 185 min (a 2x/3x student who starts late is never released mid-attempt)");
await lock(AL);
let r = await pw(AL);
check("not gated -> end null (helper keeps its 6 h failsafe)", r.status === 200 && r.data?.end === null, JSON.stringify(r.data));
const gb = page.B.querySelectorAll("button[data-gate]")[0];
await gb.onclick(); await settle(); await page.tick();
check("gate on: quiz hidden, Al admitted", BS.quiz.AllowOnlyUsersWithSpecialAccess === true && !!BS.sa["4001"]);
check("Dee's OSAS special access (yesterday's sitting) untouched", JSON.stringify(BS.sa["4005"]) === deeSA);
r = await pw(AL);
const endMs = Date.parse(BS.quiz.EndDate);
check("gated, not accommodated -> end = Brightspace end + 185 min", Math.abs(Date.parse(r.data?.end) - (endMs + 185 * MIN)) < 1000, JSON.stringify(r.data));

console.log("O3 accommodation added WHILE the gate runs (OSAS sends a late letter): kept, never touched");
BS.sa["4002"] = { StartDate: iso(-10 * MIN), EndDate: iso(3 * 3600e3), DueDate: null, SubmissionTimeLimit: { IsEnforced: true, ShowClock: true, TimeLimitValue: 120 }, AttemptsAllowed: null };
const boSA = JSON.stringify(BS.sa["4002"]);
await page.tick();
const keep = () => JSON.parse(sqlite.prepare("SELECT sa_keep FROM quizzes WHERE qi=?").get(String(QI)).sa_keep || "[]");
check("server's accommodation list now has Bo (and still Dee)", keep().includes("4002") && keep().includes("4005"), JSON.stringify(keep()));
check("Al's LOCKqz grant is NOT turned into an accommodation", !keep().includes("4001"), JSON.stringify(keep()));
await lock(BO);
r = await pw(BO);
check("Bo (accommodated) -> password, end null (his own later end is never cut short)", r.status === 200 && !!r.data?.password && r.data?.end === null, JSON.stringify(r.data));
await dev("/report", { device_id: BO.id, event: "tamper", quiz_id: `${OU}-${QI}` }, BO.id, BO.key);
await page.tick();
check("even after a tamper flag, Bo's OSAS special access is unchanged", JSON.stringify(BS.sa["4002"]) === boSA, JSON.stringify(BS.sa["4002"]));
const nKeep = keep().length; await page.tick();
check("the accommodation is sent once (no write every round)", keep().length === nKeep);

console.log("O4 start check while gated: an OSAS student with an earlier window passes, others wait");
sqlite.prepare("UPDATE bs_quizzes SET start_date=? WHERE ou=? AND qi=?").run(iso(60 * MIN), String(OU), String(QI));
await lock(DEE);
r = await pw(DEE);
check("Dee (kept special access) -> password before the class start", r.status === 200 && !!r.data?.password, JSON.stringify(r.data));
r = await pw(AL);
check("Al -> 'not started' until the class start", r.status === 403 && r.data?.reason === "not started", JSON.stringify(r.data));
sqlite.prepare("UPDATE bs_quizzes SET start_date=? WHERE ou=? AND qi=?").run(iso(-10 * MIN), String(OU), String(QI));

console.log("O5 the server's quiz_ended release waits for the latest possible end");
sqlite.prepare("UPDATE bs_quizzes SET end_date=? WHERE ou=? AND qi=?").run(iso(-30 * MIN), String(OU), String(QI));
sqlite.prepare("UPDATE locks SET locked_at=? WHERE device_id=?").run(iso(-70 * MIN), AL.id);
r = await beat(AL);
check("end + 15 passed but a 3x attempt may still run -> NO unlock (was: released 15 min after the end)", r.status === 200 && !r.data?.unlock, JSON.stringify(r.data));
sqlite.prepare("UPDATE bs_quizzes SET over_min=10 WHERE ou=? AND qi=?").run(String(OU), String(QI));
r = await beat(AL);
check("end + over (10) + 15 passed -> quiz_ended", r.data?.unlock === true && r.data?.reason === "quiz_ended", JSON.stringify(r.data));
r = await beat(BO);
check("Bo (accommodated) never gets quiz_ended", !r.data?.unlock, JSON.stringify(r.data));

console.log("O6 DST (1 Nov 2026, 2:00 PDT -> 1:00 PST) and midnight UTC: pure UTC arithmetic");
sqlite.prepare("UPDATE bs_quizzes SET start_date=NULL, end_date=?, over_min=185 WHERE ou=? AND qi=?").run("2026-11-01T09:30:00.000Z", String(OU), String(QI));
await lock(AL);
r = await pw(AL);
check("end 1:30 PST (09:30Z, after the clocks went back) + 185 min = 12:35Z exactly", r.data?.end === "2026-11-01T12:35:00.000Z", JSON.stringify(r.data));
sqlite.prepare("UPDATE bs_quizzes SET end_date=?, over_min=NULL WHERE ou=? AND qi=?").run("2026-11-01T23:50:00.000Z", String(OU), String(QI));
r = await pw(AL);
check("end 23:50Z (crosses midnight UTC), timing unknown -> +6 h = next day 05:50Z", r.data?.end === "2026-11-02T05:50:00.000Z", JSON.stringify(r.data));
sqlite.prepare("UPDATE bs_quizzes SET end_date=?, start_date=? WHERE ou=? AND qi=?").run(BS.quiz.EndDate, BS.quiz.StartDate, String(OU), String(QI));

console.log("O7 add_keep only for a running gate (it can never switch a gate on)");
sqlite.prepare("UPDATE quizzes SET gated=0 WHERE qi=?").run(String(QI));
r = await api("/gate", { ou: String(OU), qi: String(QI), on: true, add_keep: ["4001"] }, { "X-LOCKqz-Sync": KEY });
check("add_keep on a stopped gate -> 409, quiz stays ungated", r.status === 409 && sqlite.prepare("SELECT gated FROM quizzes WHERE qi=?").get(String(QI)).gated === 0, JSON.stringify(r));
sqlite.prepare("UPDATE quizzes SET gated=1 WHERE qi=?").run(String(QI));
r = await api("/gate", { ou: String(OU), qi: String(QI), on: true, add_keep: ["4001"] }, { "X-LOCKqz-Teacher": "nobody" });
check("not the professor -> refused", r.status === 401 || r.status === 403, JSON.stringify(r));
sqlite.prepare("UPDATE quizzes SET gated=0, sa_keep=NULL WHERE qi=?").run(String(QI));

console.log("O8 REQUIRE_GATE: no password held before a gate can run (OSAS early sitting / makeup) or after the end");
env.REQUIRE_GATE = "1";
sqlite.prepare("UPDATE bs_quizzes SET start_date=?, end_date=? WHERE ou=? AND qi=?").run(iso(3 * 3600e3), iso(5 * 3600e3), String(OU), String(QI));
await lock(DEE);
r = await pw(DEE);
check("3 h before the class start, ungated -> password (Brightspace keeps everyone without special access out)", r.status === 200 && !!r.data?.password, JSON.stringify(r.data));
sqlite.prepare("UPDATE bs_quizzes SET start_date=? WHERE ou=? AND qi=?").run(iso(30 * MIN), String(OU), String(QI));
r = await pw(DEE);
check("30 min before the start (the gate should be on) -> gate_off, password held", r.status === 402 && r.data?.reason === "gate_off", JSON.stringify(r.data));
sqlite.prepare("UPDATE bs_quizzes SET start_date=?, end_date=? WHERE ou=? AND qi=?").run(iso(-26 * 3600e3), iso(-24 * 3600e3), String(OU), String(QI));
r = await pw(DEE);
check("makeup the day after the end -> password", r.status === 200 && !!r.data?.password, JSON.stringify(r.data));
delete env.REQUIRE_GATE;

console.log("O9 assistive tools: the professor allows Read&Write for Al only");
const T = { "X-LOCKqz-Teacher": PROF };
r = await api("/assist", { ou: String(OU), email: "AL@usc.edu", tools: ["readwrite", "bogus", "readwrite"] }, T);
check("saved, unknown tools dropped", r.status === 200 && JSON.stringify(r.data?.tools) === '["readwrite"]', JSON.stringify(r.data));
r = await api("/assist", { ou: String(OU), email: "stranger@usc.edu", tools: ["readwrite"] }, T);
check("a student not on this class list -> 404", r.status === 404, JSON.stringify(r));
r = await api("/assist", { ou: String(OU), email: "bo@usc.edu", tools: ["readwrite"] }, { "X-LOCKqz-Sync": KEY });
check("the Sync bookmark key cannot set allowances (needs the professor's login)", r.status === 403, JSON.stringify(r));
r = await api("/assist", { ou: String(OU), email: "bo@usc.edu", tools: ["readwrite"] });
check("no login -> 401", r.status === 401, JSON.stringify(r));
r = await api(`/assist?ou=${OU}`, undefined, T);
check("GET lists the class's allowances + the tool catalog", r.data?.students?.length === 1 && r.data.students[0].email === "al@usc.edu" && !!r.data?.tools?.readwrite, JSON.stringify(r.data));
await lock(AL);
r = await pw(AL);
check("Al's /password carries assist:['readwrite']", JSON.stringify(r.data?.assist) === '["readwrite"]', JSON.stringify(r.data));
await lock(BO);
r = await pw(BO);
check("Bo's does not", r.status === 200 && !("assist" in (r.data || {})), JSON.stringify(r.data));
r = await api("/bs", undefined, T);
const st = r.data?.courses?.[0]?.students || [];
check("dashboard sees Al's tools, Bo none", JSON.stringify(st.find(s => s.email === "al@usc.edu")?.assist) === '["readwrite"]' && (st.find(s => s.email === "bo@usc.edu")?.assist || []).length === 0, JSON.stringify(st));
r = await api("/assist", { ou: String(OU), email: "al@usc.edu", tools: [] }, T);
r = await pw(AL);
check("removed -> no assist", !("assist" in (r.data || {})), JSON.stringify(r.data));

console.log("O10 accessibility: what LOCKqz closes never includes assistive technology");
const MAC = join(HERE, "..", "mac"), WINP = join(HERE, "..", "windows");
const killSrc = readFileSync(join(MAC, "lockqz.sh"), "utf8") + readFileSync(join(MAC, "extra-block.sh"), "utf8") + readFileSync(join(WINP, "lockqz.ps1"), "utf8");
const AT = /voiceover|nvda|jaws|narrator|magnif|dictation|voice ?control|voice ?access|read&write|readwrite|texthelp|kurzweil|zoomtext|(?<!VMware )fusion|dragon|speechify|naturalreader|spoken|livecaption|osk|switch control|textedit/i;
const killed = [...killSrc.matchAll(/^(?:AI_APPS|VM_APPS|REMOTE_APPS|OVERLAY_APPS|LOCAL_MODEL_PROCS|VPN_APPS|APPLE_AI_APPS)=\(([^)]*)\)|^\$(?:AiApps|VmApps|RemoteApps|OverlayApps|ModelProcs|VpnApps)\s*=\s*@\(([^)]*)\)/gms)].map(m => m[1] || m[2]).join(" ");
check("no screen reader / dictation / magnifier / Read&Write / Kurzweil in any kill list", !AT.test(killed), (killed.match(AT) || [""])[0]);
const bl = readFileSync(join(MAC, "blocklist.txt"), "utf8") + readFileSync(join(WINP, "blocklist.txt"), "utf8");
check("no assistive-technology domain blocked (texthelp, kurzweiledu, freedomscientific, nvaccess, speech.platform.bing)", !/texthelp|kurzweil|freedomscientific|nvaccess|speech\.platform|everway|donjohnston|equatio/i.test(bl));
const mp = readFileSync(join(MAC, "browser-policy.py"), "utf8"), wp = readFileSync(join(WINP, "browser-policy.ps1"), "utf8");
for (const id of ["eimadpbcbfnmbkopoojfekhnkhdbieeh", "djcfdncoelnlbldjfhinnjlhdjlikmph", "cdnapgfjopgaggbmfgbiinmmbdcglnam"])
  check(`display aid ${id} always allowed on Mac and Windows`, mp.includes(id) && wp.includes(id));
const keysOf = src => [...src.matchAll(/["']?(readwrite|equatio|cowriter|snapread|readaloud)["']?\s*[:=]/g)].map(m => m[1]).sort().join(",");
check("server, Mac and Windows share the same assistive-tool keys", keysOf(readFileSync(join(CF, "functions", "api", "[[route]].js"), "utf8").match(/const ASSIST_TOOLS = \{[^}]*\}/)[0]) === "cowriter,equatio,readaloud,readwrite,snapread" && keysOf(mp) === keysOf(wp.match(/\$AssistExtensions = @\{[\s\S]*?\}\s*\n/)[0]) && keysOf(mp).includes("readwrite"), keysOf(mp));

console.log("O11 gate stop: the quiz is shown again BEFORE LOCKqz's grants go (a student past the end is never shut out)");
sqlite.prepare("UPDATE quizzes SET gated=1 WHERE qi=?").run(String(QI));
check("Al still holds LOCKqz's grant before the stop", !!BS.sa["4001"]);
BS.log = [];
await gb.onclick(); await settle();
const iShow = BS.log.indexOf("quiz:hidden=false"), iDel = BS.log.indexOf("del:4001");
check("unhide first, then remove the grant", iShow >= 0 && iDel > iShow, JSON.stringify(BS.log));
check("OSAS special access (Dee, Bo) survives the stop", JSON.stringify(BS.sa["4005"]) === deeSA && JSON.stringify(BS.sa["4002"]) === boSA);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
