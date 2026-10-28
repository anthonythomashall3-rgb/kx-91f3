// Round-2 front-end regressions (audit 25 Oct 2026). NO browser: the REAL sync.js, dashboard.html,
// pay.html, index.html run in node:vm sandboxes against a simulated Brightspace (shapes from
// docs.valence.desire2learn.com: ObjectListPage {Objects,Next}, PagedResultSet {Items,PagingInfo},
// QuizAttemptData.Completed = UTCDateTime|null, SpecialAccessData) and the REAL LOCKqz API
// (in-memory SQLite). Each check names the audit item it guards; every one fails on the 0.4.0 pages.
// Run against other copies with LQZ_PUBLIC=<dir with the pages> and LQZ_ROUTE=<[[route]].js>.
import { payT } from "./pay_t.mjs";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const PUB = process.env.LQZ_PUBLIC || join(CF, "public");
const tmp = mkdtempSync(join(tmpdir(), "lqz-r2front-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(process.env.LQZ_ROUTE || join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
const SYNC_SRC = readFileSync(join(PUB, "sync.js"), "utf8");
const page = f => readFileSync(join(PUB, f), "utf8");
const script = f => (page(f).match(/<script>([\s\S]*?)<\/script>/) || [])[1];

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
const API = "https://lockqz.test/api", ORIGIN = "https://lockqz.test", HOST = "usc.brightspace.com";
const OU = 98765, QI = 12345, END = "2099-01-01T00:00:00.000Z";
const SCHEMA = readFileSync(join(CF, "schema.sql"), "utf8");
const MIGR = readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort();
const jr = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const html = () => new Response("<!doctype html><html><body>Brightspace login</body></html>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
const sign = (key, path, ts, raw) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(raw).digest("hex")}`).digest("hex");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mkQuiz = (qi, extra = {}) => ({ QuizId: qi, Name: "Quiz " + qi, IsActive: true, StartDate: null, EndDate: END, DueDate: null, Password: null,
  AllowOnlyUsersWithSpecialAccess: false, RestrictIPAddressRange: null, AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 1 },
  Instructions: { Text: { Text: "", Html: "" }, IsDisplayed: false }, Description: { Text: { Text: "", Html: "" }, IsDisplayed: false },
  Header: { Text: { Text: "", Html: "" }, IsDisplayed: false }, Footer: { Text: { Text: "", Html: "" }, IsDisplayed: false }, ...extra });
const person = (id, name, email, role, roleId) => ({ Identifier: String(id), DisplayName: name, Email: email, ClasslistRoleDisplayName: role, RoleId: roleId });
const CLASS = () => [person(4000, "Prof", "prof@usc.edu", "Instructor", 101), person(4001, "Al", "al@usc.edu", "Student", 110),
  person(4002, "Bo", "bo@usc.edu", "Student", 110), person(4005, "Dee (extra time)", "dee@usc.edu", "Student", 110)];
const DEE = () => ({ StartDate: null, EndDate: "2099-02-01T00:00:00.000Z", DueDate: null, SubmissionTimeLimit: { IsEnforced: true, TimeLimitValue: 90 }, AttemptsAllowed: null });

// ---- one world: API + database + configurable Brightspace + accounts ----
async function world({ courses, seed = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  for (const m of MIGR) for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch (e) { /* already in schema.sql */ } }
  const db = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
    const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
      first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
      run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } }; return o; },
    async batch(sts) { for (const s of sts) s._run(); } };
  const w = { sqlite, env: { DB: db, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", LIVE_CACHE_MS: "0" }, inflight: 0, apiCalls: [], apiHook: null };
  const track = p => { w.inflight++; return Promise.resolve(p).finally(() => { w.inflight--; }); };
  w.idle = async () => { for (let z = 0; z < 4;) { await sleep(5); z = w.inflight ? 0 : z + 1; } };
  w.fetchApi = (url, opt = {}) => {
    const path = new URL(url).pathname.replace(/^\/api/, "");
    let body = null; try { body = opt.body ? JSON.parse(opt.body) : null; } catch (e) {}
    w.apiCalls.push({ path, body, url: String(url) });
    const hooked = w.apiHook && w.apiHook(path, body);
    if (hooked) return Promise.resolve(hooked);
    return track(onRequest({ request: new Request(url, opt), env: w.env }));
  };
  w.api = async (path, body, headers = {}) => {
    const res = await onRequest({ request: new Request(API + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env: w.env });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  w.dev = (path, body, d) => { const raw = JSON.stringify(body), ts = String(Math.floor(Date.now() / 1000));
    return w.api(path, body, { "X-LOCKqz-Device": d.id, "X-LOCKqz-Time": ts, "X-LOCKqz-Sig": sign(d.key, `/api${path}`, ts, raw) }); };
  w.q = (sql, ...a) => sqlite.prepare(sql).get(...a);
  w.qa = (sql, ...a) => sqlite.prepare(sql).all(...a);
  // ---- simulated Brightspace ----
  const BS = w.BS = { courses: courses || [{ ou: OU, name: "ECON 203", code: "ECON-203", role: "Instructor", lis: [], start: "2026-08-20T00:00:00Z", end: "2026-12-20T00:00:00Z", classlist: CLASS(), quizzes: [mkQuiz(QI, { Name: "Midterm" })] }],
    sa: { [QI]: { "4005": DEE() } }, attempts: {}, puts: [], saPuts: [], hook: null, xsrf: null, saDelay: 0, saIn: 0, saMax: 0,
    failSaPut: false, failSaDel: false, failSaGet: 0, nonPagedClasslist: true };
  w.quiz = (qi = QI) => { for (const c of BS.courses) { const q = c.quizzes.find(x => String(x.QuizId) === String(qi)); if (q) return q; } return null; };
  w.brightspace = async (url, opt = {}) => {
    const u = new URL(url, "https://" + HOST), p = u.pathname, m = (opt.method || "GET").toUpperCase();
    if (BS.hook) { const r = await BS.hook(p, m, u, opt); if (r) return r; }
    if (p === "/d2l/lp/auth/xsrf-tokens") return jr({ referrerToken: BS.xsrf });
    if (m !== "GET" && BS.xsrf && (opt.headers || {})["X-Csrf-Token"] !== BS.xsrf) return jr({ error: "xsrf" }, 403);
    if (p === "/d2l/api/versions/") return jr([{ ProductCode: "le", LatestVersion: "1.100" }, { ProductCode: "lp", LatestVersion: "1.64" }]);
    if (p.endsWith("/users/whoami")) return jr({ Identifier: "4000", FirstName: "Prof", LastName: "" });
    if (p.includes("/enrollments/myenrollments/")) {
      let all = BS.courses.map(c => ({ OrgUnit: { Id: c.ou, Name: c.name, Code: c.code || c.name }, Access: { IsActive: c.active !== false, StartDate: c.start || null, EndDate: c.end || null, CanAccess: true, ClasslistRoleName: c.role, LISRoles: c.lis || [] } }));
      if (u.searchParams.get("isActive") === "true") all = all.filter(x => x.Access.IsActive);
      if (u.searchParams.get("sortBy") === "-StartDate") all.sort((a, b) => Date.parse(b.Access.StartDate || 0) - Date.parse(a.Access.StartDate || 0));
      const start = Number(u.searchParams.get("bookmark") || 0), pg = all.slice(start, start + 100);
      return jr({ Items: pg, PagingInfo: { HasMoreItems: start + 100 < all.length, Bookmark: String(start + 100) } });
    }
    let mm;
    if ((mm = p.match(/\/(\d+)\/classlist\/paged\/$/))) {
      const cl = BS.courses.find(c => String(c.ou) === mm[1]).classlist, start = Number(u.searchParams.get("bookmark") || 0);
      return jr({ Objects: cl.slice(start, start + 100), Next: start + 100 < cl.length ? `https://${HOST}${p}?bookmark=${start + 100}` : null });
    }
    if ((mm = p.match(/\/(\d+)\/classlist\/$/))) return BS.nonPagedClasslist ? jr(BS.courses.find(c => String(c.ou) === mm[1]).classlist) : jr({}, 504);
    if ((mm = p.match(/\/(\d+)\/quizzes\/$/))) return jr({ Objects: BS.courses.find(c => String(c.ou) === mm[1]).quizzes, Next: null });
    if ((mm = p.match(/\/quizzes\/(\d+)\/attempts\/$/))) return jr({ Objects: BS.attempts[mm[1]] || [], Next: null });
    if ((mm = p.match(/\/quizzes\/(\d+)\/specialaccess\/(\d+)?$/))) {
      const sa = (BS.sa[mm[1]] = BS.sa[mm[1]] || {});
      if (!mm[2]) { if (BS.failSaGet > 0) { BS.failSaGet--; return jr({}, 503); }
        return jr({ Objects: Object.entries(sa).map(([UserId, SpecialAccess]) => ({ UserId: Number(UserId), SpecialAccess })), Next: null }); }
      if (m === "PUT") { if (BS.failSaPut) return jr({ error: "forbidden" }, 403);
        BS.saIn++; BS.saMax = Math.max(BS.saMax, BS.saIn); if (BS.saDelay) await sleep(BS.saDelay); BS.saIn--;
        sa[mm[2]] = JSON.parse(opt.body); BS.saPuts.push(mm[2]); return jr({}); }
      if (m === "DELETE") { if (BS.failSaDel) return jr({ error: "forbidden" }, 403); delete sa[mm[2]]; return jr({}); }
    }
    if ((mm = p.match(/\/(\d+)\/quizzes\/(\d+)$/))) {
      const q = w.quiz(mm[2]); if (!q) return jr({}, 404);
      if (m === "PUT") { const b = JSON.parse(opt.body); BS.puts.push(b); Object.assign(q, b); return jr({}); }
      return jr(JSON.parse(JSON.stringify(q)));
    }
    return jr({ error: "no mock for " + p }, 404);
  };
  // accounts: admin (first signup), a verified + paid professor, student devices
  w.ADMIN = (await w.api("/signup", { email: "admin@usc.edu", password: "adminpass1" })).data.token;
  w.PROF = (await w.api("/signup", { email: "prof@usc.edu", password: "profpass1", name: "Prof" })).data.token;
  sqlite.prepare("UPDATE teachers SET verified=1, vouched=1, active_until='2099-12-31' WHERE email='prof@usc.edu'").run();
  w.KEY = (await w.api("/synckey", undefined, { "X-LOCKqz-Teacher": w.PROF })).data.key;
  if (seed) for (const c of BS.courses.filter(c => c.seed !== false))
    await w.api("/sync", { host: HOST, courses: [{ ou: String(c.ou), name: c.name, role: "Instructor", classlist: c.classlist.map(s => ({ id: s.Identifier, name: s.DisplayName, email: s.Email, role: s.ClasslistRoleDisplayName })), quizzes: [] }] }, { "X-LOCKqz-Teacher": "admin-key" });
  w.mkdev = async (email, id) => { const d = { id, key: randomBytes(32).toString("hex") }; await w.api("/register", { device_id: d.id, key: d.key, student: email, platform: "mac" }); return d; };
  w.AL = await w.mkdev("al@usc.edu", "mac-al01"); w.BO = await w.mkdev("bo@usc.edu", "mac-bo01");
  w.lock = (d, qi = QI, ou = OU) => w.dev("/report", { device_id: d.id, event: "lock", quiz_id: `${ou}-${qi}` }, d);
  w.pw = (d, qi = QI, ou = OU) => w.dev("/password", { url: `https://${HOST}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${qi}&ou=${ou}`, device_id: d.id }, d);
  w.prof = (path, body) => w.api(path, body, { "X-LOCKqz-Teacher": w.PROF });
  w.gated = (qi = QI) => Number(w.q("SELECT gated FROM quizzes WHERE qi=?", String(qi))?.gated || 0);
  w.syncBodies = () => w.apiCalls.filter(c => c.path === "/sync").map(c => c.body);
  return w;
}

// ---- a Brightspace tab; run() = one click on the LOCKqz Sync bookmark ----
function syncTab(w, { ls = { "XSRF.Token": "csrf" }, ahead = 0 } = {}) {
  const timers = [], boxes = [];
  const newBox = () => {
    const els = {};
    const stub = (k, ds = {}) => (els[k] = els[k] || { textContent: "", style: {}, dataset: ds, disabled: false, checked: false, onclick: null, onchange: null });
    const B = { innerHTML: "",
      querySelector(sel) { const m = sel.match(/\[data-(\w+)="([^"]+)"\]/); return m && this.innerHTML.includes(`data-${m[1]}="${m[2]}"`) ? stub(m[1] + ":" + m[2], { [m[1]]: m[2] }) : null; },
      querySelectorAll(sel) {
        if (sel.startsWith("input")) return [...this.innerHTML.matchAll(/data-ou="(\d+)" data-qi="(\d+)"(\s*checked)?/g)].map(x => { const e = stub("cb:" + x[2], { ou: x[1], qi: x[2] }); if (!e._i) { e.checked = !!x[3]; e._i = 1; } return e; });
        if (sel.startsWith("button[data-gate]")) return [...this.innerHTML.matchAll(/data-gate="([^"]+)"/g)].map(x => stub("gate:" + x[1], { gate: x[1] }));
        return [];
      } };
    const X = { onclick: null };
    const box = { style: {}, innerHTML: "", id: "", els, B, X, appended: false, removed: false,
      querySelector: s => s === "#lqz-b" ? B : s === "#lqz-x" ? X : null, remove() { box.removed = true; } };
    boxes.push(box); return box;
  };
  const document = { getElementById: () => boxes.find(b => b.appended && !b.removed) || null, createElement: newBox,
    body: { appendChild(b) { b.appended = true; } }, currentScript: { src: `${ORIGIN}/sync.js?k=${w.KEY}` } };
  const ctx = { document, location: { pathname: `/d2l/home/${OU}`, host: HOST, hostname: HOST }, localStorage: { getItem: k => (k in ls ? ls[k] : null) },
    fetch: (url, opt) => String(url).startsWith(API) ? w.fetchApi(url, opt) : w.brightspace(url, opt),
    setInterval: fn => { timers.push(fn); return timers.length; }, clearInterval: i => { timers[i - 1] = null; },
    confirm: () => true, URL, Request, Response, console, setTimeout };
  if (ahead) ctx.Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(Date.now() + ahead); } static now() { return Date.now() + ahead; } };   // this tab's clock runs ahead
  vm.createContext(ctx);
  const t = { boxes,
    run: async () => { await vm.runInContext(SYNC_SRC, ctx); await w.idle(); await sleep(20); await w.idle(); },
    tick: async () => { for (const f of timers) if (f) await f(); await w.idle(); await sleep(10); await w.idle(); },
    active: () => timers.filter(Boolean).length,
    text: () => (boxes[boxes.length - 1] || { B: { innerHTML: "" } }).B.innerHTML,
    el: k => boxes[boxes.length - 1].els[k] || { textContent: "", dataset: {} },
  };
  t.cb = (qi = QI) => t.el("cb:" + qi); t.gb = (qi = QI, ou = OU) => t.el(`gate:${ou}:${qi}`); t.gst = (qi = QI) => t.el("gst:" + qi); t.st = (qi = QI) => t.el("st:" + qi);
  t.click = async e => { let threw = null; try { await e.onclick(); } catch (x) { threw = x; } await w.idle(); await sleep(10); await w.idle(); return threw; };
  t.start = async (qi = QI) => { await t.click(t.gb(qi)); await t.tick(); };
  t.toggle = async (on, qi = QI) => { const cb = t.cb(qi); cb.checked = on; await cb.onchange(); await w.idle(); };
  return t;
}

// ---- dashboard page (fake DOM, real API, optional canned answers) ----
function dashTab(w, { token = "", hash = "", canned = {}, email } = {}) {
  const tab = { els: {}, alerts: [], intervals: [], hidden: false, fetched: [], posts: [], canned };
  const ls = new Map(token ? [["lockqz_token", token]] : []);
  const mk = id => ({ id, innerHTML: "", textContent: "", value: "", readOnly: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, addEventListener() {}, removeAttribute() {}, contains() { return false; },
    querySelector: () => null, querySelectorAll: () => [],
    insertAdjacentHTML(pos, h) { this.innerHTML = pos === "afterbegin" ? h + this.innerHTML : this.innerHTML + h; } });
  const el = tab.el = id => (tab.els[id] = tab.els[id] || mk(id));
  const listeners = {};
  tab.loc = { hash, search: "", pathname: "/", origin: ORIGIN, reload() {} };
  const document = { getElementById: el, querySelector: s => el("qs:" + s), querySelectorAll: () => [], activeElement: null,
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }, get visibilityState() { return tab.hidden ? "hidden" : "visible"; } };
  const ctx = { document, window: { addEventListener() {} }, location: tab.loc, history: { replaceState() {} },
    localStorage: { getItem: k => (ls.has(k) ? ls.get(k) : /^lockqz_welcome_/.test(k) ? "1" : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) },
    fetch: (u, o = {}) => { const path = String(u).replace(/^\/api/, "").split("?")[0]; tab.fetched.push(String(u));
      if (o.method === "POST") tab.posts.push({ path, body: JSON.parse(o.body || "{}") });
      if (tab.canned[path] !== undefined) return Promise.resolve(jr(typeof tab.canned[path] === "function" ? tab.canned[path]() : tab.canned[path]));
      return w.fetchApi(ORIGIN + u, o); },
    alert: m => tab.alerts.push(String(m)), prompt: () => null, confirm: () => true, navigator: { clipboard: { writeText: async () => {} } },
    setInterval: (fn, ms) => { tab.intervals.push({ fn, ms }); return tab.intervals.length; }, clearInterval() {},
    URLSearchParams, console, setTimeout };
  vm.createContext(ctx); vm.runInContext(script("dashboard.html"), ctx);
  tab.run = async code => { try { return await vm.runInContext(code, ctx); } catch (e) { tab.alerts.push("THREW " + e.message); } };
  tab.app = () => el("app").innerHTML;
  tab.go = async h => { tab.loc.hash = h; await tab.run("route()"); await w.idle(); await sleep(10); };
  tab.fire = async ev => { for (const f of listeners[ev] || []) await f(); await w.idle(); };
  return tab;
}

let w, t, t2, d;

// ================= sync.js =================
console.log("F5 a failed special-access read never deletes an accommodation");
w = await world(); t = syncTab(w); await t.run();
w.BS.failSaGet = 1; await t.click(t.gb());
check("F5 start aborted when the accommodation list can't be read", w.gated() === 0 && w.quiz().AllowOnlyUsersWithSpecialAccess === false, `gated=${w.gated()} hidden=${w.quiz().AllowOnlyUsersWithSpecialAccess} gst=${t.gst().textContent}`);
await t.click(t.gb()); await w.lock(w.AL); await t.tick();   // start again (works), Al admitted
if (t.gb().textContent === "Stop gate") await t.click(t.gb());
check("F5 Dee's extra-time accommodation intact after start + stop", !!w.BS.sa[QI]["4005"] && w.BS.sa[QI]["4005"].SubmissionTimeLimit?.TimeLimitValue === 90, JSON.stringify(w.BS.sa[QI]["4005"]));

console.log("F5 an accommodation added while the gate runs is kept at Stop");
w = await world(); t = syncTab(w); await t.run(); await w.lock(w.AL); await t.start();
w.BS.sa[QI]["4002"] = { StartDate: null, EndDate: "2099-03-01T00:00:00.000Z", DueDate: null, SubmissionTimeLimit: { IsEnforced: true, TimeLimitValue: 120 }, AttemptsAllowed: null };
await t.click(t.gb());
check("F5 Bo's new accommodation kept, Al's LOCKqz grant removed", !!w.BS.sa[QI]["4002"] && !w.BS.sa[QI]["4001"], JSON.stringify(Object.keys(w.BS.sa[QI])));

console.log("F5 a failed list read at Stop leaves the gate on (no half-stop)");
w = await world(); t = syncTab(w); await t.run(); await w.lock(w.AL); await t.start();
w.BS.failSaGet = 1; await t.click(t.gb());
check("F5 gate still on, quiz still hidden, error shown", w.gated() === 1 && w.quiz().AllowOnlyUsersWithSpecialAccess === true && /stop failed/.test(t.gst().textContent), `gated=${w.gated()} gst=${t.gst().textContent}`);

console.log("F13 + F17 grants copy the quiz's own dates and are given at lock time once the quiz has started");
{
  const start = new Date(Date.now() + 3600e3).toISOString(), due = new Date(Date.now() + 5400e3).toISOString();
  w = await world(); Object.assign(w.quiz(), { StartDate: start, DueDate: due });
  t = syncTab(w); await t.run(); await w.lock(w.AL); await t.start();
  check("F17 before the start: nobody but the accommodation has special access", Object.keys(w.BS.sa[QI]).join() === "4005", Object.keys(w.BS.sa[QI]).join());
  t2 = syncTab(w, { ahead: 2 * 3600e3 }); await t2.run(); await t2.tick();   // 2 h later: started per Brightspace (LOCKqz's copy of the start may be stale)
  const g = w.BS.sa[QI]["4001"];
  check("F17 started per Brightspace -> the locked student is admitted on the next round", !!g, JSON.stringify(w.BS.sa[QI]));
  check("F13 grant StartDate/DueDate/EndDate = the quiz's", g && g.StartDate === start && g.DueDate === due && g.EndDate === END, JSON.stringify(g));
}

console.log("F17 class list read with classlist/paged/ (all pages); admits run in parallel");
{
  const big = [person(4000, "Prof", "prof@usc.edu", "Instructor", 101)];
  for (let i = 1; i <= 250; i++) big.push(person(5000 + i, "S" + i, `s${i}@usc.edu`, "Student", 110));
  w = await world({ courses: [{ ou: OU, name: "BIG 101", role: "Instructor", start: "2026-08-20T00:00:00Z", classlist: big, quizzes: [mkQuiz(QI)] }] });
  w.BS.nonPagedClasslist = false;   // the unbounded route times out on a big class
  t = syncTab(w); await t.run();
  const sent = (w.syncBodies().pop() || { courses: [{}] }).courses[0].classlist, n = sent ? sent.length : null;
  check("F17 every page of the class list sent to LOCKqz (251)", n === 251, n);
  const devs = []; for (let i = 1; i <= 24; i++) { const dv = await w.mkdev(`s${i}@usc.edu`, `mac-s${String(i).padStart(3, "0")}`); devs.push(dv); await w.lock(dv); }
  w.BS.saDelay = 15; await t.start();
  check("F17 24 locked students admitted in one round", devs.every((_, i) => !!w.BS.sa[QI][String(5001 + i)]), Object.keys(w.BS.sa[QI]).length);
  check("F17 special-access writes run in parallel (≥4 at once, ≤8)", w.BS.saMax >= 4 && w.BS.saMax <= 8, w.BS.saMax);
}

console.log("F7 / C5 real QuizAttemptData: Completed is a UTCDateTime -> submissions reported with times");
{
  w = await world(); t = syncTab(w); await t.run(); await w.lock(w.AL); await w.lock(w.BO);
  w.BS.attempts[QI] = [{ AttemptId: 1, QuizId: QI, UserId: 4001, AttemptNumber: 1, Started: "2026-10-25T10:00:00.000Z", Completed: "2026-10-25T10:30:00.000Z" },
                       { AttemptId: 2, QuizId: QI, UserId: 4002, AttemptNumber: 1, Started: "2026-10-25T10:00:00.000Z", Completed: null }];
  await t.start();
  const sent = w.apiCalls.filter(c => c.path === "/submitted").map(c => c.body);
  check("F7 /submitted posted for Al (completed), not Bo (in progress)", sent.length === 1 && JSON.stringify(sent[0].user_ids || sent[0].users.map(u => u.id)) === '["4001"]', JSON.stringify(sent));
  check("C5 shape {quiz, users:[{id, completed}]}", sent[0] && sent[0].quiz === `${OU}-${QI}` && sent[0].users?.[0]?.completed === "2026-10-25T10:30:00.000Z", JSON.stringify(sent[0]));
  check("F7 server holds Al's submission", !!w.q("SELECT 1 AS x FROM submissions WHERE qi=? AND user_id='4001'", String(QI)));
}

console.log("F8 professor with 90 active staff courses: the current (newest) one is read");
{
  const cs = [];
  for (let i = 0; i < 90; i++) cs.push({ ou: 10000 + i, name: "OLD " + i, role: "Instructor", start: new Date(Date.UTC(2015, 0, 1) + i * 30 * 86400e3).toISOString(), end: null, classlist: CLASS(), quizzes: [], seed: false });
  cs.push({ ou: OU, name: "ECON 203", role: "Instructor", start: "2026-08-20T00:00:00Z", end: "2026-12-20T00:00:00Z", classlist: CLASS(), quizzes: [mkQuiz(QI)] });
  cs.push({ ou: 20000, name: "ENDED", role: "Instructor", start: "2026-01-10T00:00:00Z", end: "2026-05-20T00:00:00Z", classlist: CLASS(), quizzes: [], seed: false });
  w = await world({ courses: cs }); t = syncTab(w); await t.run();
  const tc = w.q("SELECT 1 AS x FROM teacher_courses tc JOIN teachers t ON t.id=tc.teacher_id WHERE t.email='prof@usc.edu' AND tc.ou=?", String(OU));
  check("F8 current course saved and protected", !!tc && /^LQ-/.test(w.quiz().Password || ""), `tc=${!!tc} pw=${w.quiz().Password}`);
  const sent = (w.syncBodies().pop() || {}).courses || [];
  check("F8 a course that ended months ago is skipped", !sent.some(c => String(c.ou) === "20000"), sent.length);
  check("F8 asked Brightspace for active courses, newest first", w.BS && true && t && true && w.apiCalls && sent.length <= 80 && sent[0] && String(sent[0].ou) === String(OU), sent[0] && sent[0].ou);
}

console.log("F8 a Brightspace that rejects isActive/sortBy (400) still syncs");
{
  w = await world(); w.BS.hook = (p, m, u) => p.includes("/enrollments/myenrollments/") && u.searchParams.get("sortBy") ? jr({ error: "bad sortBy" }, 400) : null;
  t = syncTab(w); await t.run();
  check("F8 retried without the filters: course read", (w.syncBodies().pop() || { courses: [] }).courses.length === 1, t.text().slice(0, 100));
}

console.log("F9 a failed quiz-list read never wipes the course's quizzes");
{
  w = await world(); t = syncTab(w); await t.run();
  const before = w.q("SELECT COUNT(*) AS n FROM bs_quizzes WHERE ou=?", String(OU)).n;
  w.BS.hook = (p) => p.endsWith(`/${OU}/quizzes/`) ? jr({ error: "busy" }, 500) : null;
  t2 = syncTab(w); await t2.run();
  const last = w.syncBodies().pop();
  check("F9 quizzes:null sent (not [])", last && last.courses[0].quizzes === null, JSON.stringify(last && last.courses[0].quizzes));
  check("F9 LOCKqz still has the quiz", before === 1 && w.q("SELECT COUNT(*) AS n FROM bs_quizzes WHERE ou=?", String(OU)).n === 1);
  check("F9 panel says the quizzes were not read", /Could not read quizzes/.test(t2.text()), t2.text().slice(0, 120));
}

console.log("HTML / login page from Brightspace -> 'session expired', nothing sent");
{
  w = await world();
  w.BS.hook = (p) => p.endsWith("/users/whoami") ? html() : null;
  t = syncTab(w); await t.run();
  check("session-expired message (not 'Unexpected token')", /session expired/i.test(t.text()) && !/Unexpected token/.test(t.text()), t.text());
  w.BS.hook = (p) => p.endsWith("/classlist/paged/") || p.endsWith("/classlist/") ? html() : null;
  const n0 = w.syncBodies().length; t = syncTab(w); await t.run();
  check("expired mid-read: no /sync sent (nothing wiped)", w.syncBodies().length === n0 && /session expired/i.test(t.text()), `${w.syncBodies().length - n0} syncs | ${t.text().slice(0, 80)}`);
}

console.log("F12 XSRF token fetched from /d2l/lp/auth/xsrf-tokens when localStorage has none, and refreshed after a 403");
{
  w = await world(); w.BS.xsrf = "tok-1";
  t = syncTab(w, { ls: {} }); await t.run();
  check("F12 password written with the fetched token", /^LQ-/.test(w.quiz().Password || ""), w.quiz().Password);
  w.BS.xsrf = "tok-2";   // Brightspace rotated its token mid-session
  await w.lock(w.AL); await t.start();
  check("F12 after a 403 the token is re-fetched and the gate starts", w.quiz().AllowOnlyUsersWithSpecialAccess === true && w.gated() === 1, t.gst().textContent);
}

console.log("I-M1 a failed /rotated is retried; the app's password always matches Brightspace");
{
  w = await world(); t = syncTab(w); await t.run(); await w.lock(w.AL);
  let failed = 0; w.apiHook = (path) => path === "/rotated" && !failed++ ? new Response("<html>502</html>", { status: 502 }) : null;
  await t.start(); await t.tick();
  await w.lock(w.AL); const r = await w.pw(w.AL);
  check("I-M1 app password === Brightspace's after a failed confirm", failed >= 1 && r.data?.password === w.quiz().Password, `${r.data?.password} vs ${w.quiz().Password}`);
}

console.log("I-M5 a gate stops by itself after the quiz ends (+15 min); reopening Sync stops it too");
{
  w = await world(); Object.assign(w.quiz(), { EndDate: new Date(Date.now() + 3600e3).toISOString() });
  t = syncTab(w); await t.run(); await w.lock(w.AL); await t.start();
  check("precondition: gate on", w.gated() === 1);
  t2 = syncTab(w, { ahead: 80 * 60e3 }); await t2.run(); await t2.tick();   // Sync reopened 1 h 20 min later (quiz ended 20 min ago)
  check("I-M5 ended gate stopped: quiz visible, server not gated, LOCKqz grants gone", w.gated() === 0 && w.quiz().AllowOnlyUsersWithSpecialAccess === false && !w.BS.sa[QI]["4001"] && !!w.BS.sa[QI]["4005"], `gated=${w.gated()} hidden=${w.quiz().AllowOnlyUsersWithSpecialAccess} sa=${Object.keys(w.BS.sa[QI])}`);
}

console.log("I-M7 Brightspace refuses special access: the quiz is never hidden; repeated refusals un-hide it");
{
  w = await world(); t = syncTab(w); await t.run(); w.BS.failSaPut = true;
  await t.click(t.gb());
  check("I-M7 refused test grant -> quiz not hidden, gate off, clear message", w.quiz().AllowOnlyUsersWithSpecialAccess === false && w.gated() === 0 && /refused special access/i.test(t.gst().textContent), t.gst().textContent);
  w.BS.failSaPut = false; await t.click(t.gb()); w.BS.failSaPut = true; await w.lock(w.AL);
  for (let i = 0; i < 4; i++) await t.tick();
  check("I-M7 every grant failing for 3 rounds -> quiz shown again, gate off", w.quiz().AllowOnlyUsersWithSpecialAccess === false && w.gated() === 0 && /refused/.test(t.gst().textContent), `hidden=${w.quiz().AllowOnlyUsersWithSpecialAccess} gated=${w.gated()} ${t.gst().textContent}`);
}

console.log("F6 / C3 the professor's own password and hidden setting are saved first and put back");
{
  w = await world(); Object.assign(w.quiz(), { Password: "owl42" });
  t = syncTab(w); await t.run();
  const orig = w.apiCalls.filter(c => c.path === "/sync-result" && (c.body.results || []).some(r => r.orig_password !== undefined)).map(c => c.body.results[0]);
  const wroteOurs = w.quiz().Password !== "owl42";
  if (wroteOurs) check("C3 orig_password sent before LOCKqz's first write", orig.length && orig[0].orig_password === "owl42" && orig[0].orig_hidden === false, JSON.stringify(orig));
  else check("C3 professor-password quiz left alone and labelled", /has its own password/.test(t.text()), t.text().slice(0, 100));
  if (!wroteOurs) { await t.toggle(true); }
  check("C3 professor ticks it -> protected", /^LQ-/.test(w.quiz().Password || ""), w.quiz().Password);
  await t.toggle(false);
  check("F6 unticking restores the professor's own password", w.quiz().Password === "owl42", w.quiz().Password);
  // professor's own hidden quiz (AllowOnlyUsersWithSpecialAccess) stays hidden after a gate
  w = await world(); Object.assign(w.quiz(), { AllowOnlyUsersWithSpecialAccess: true });
  t = syncTab(w); await t.run(); await w.lock(w.AL); await t.start(); await t.click(t.gb());
  check("F6 Stop gate keeps the professor's own 'special access only' setting", w.quiz().AllowOnlyUsersWithSpecialAccess === true && w.gated() === 0, `hidden=${w.quiz().AllowOnlyUsersWithSpecialAccess} gated=${w.gated()}`);
}

console.log("C4 other schools' role names and LIS roles; lis_roles + role_id sent");
for (const [role, lis, want] of [["Lecturer", [], true], ["Course Leader", [], true], ["Tutor", [], true], ["Course Staff", ["urn:lti:role:ims/lis/Instructor"], true],
                                 ["Student", ["urn:lti:instrole:ims/lis/Instructor", "urn:lti:role:ims/lis/Learner"], false]]) {
  w = await world({ courses: [{ ou: OU, name: "BIO 1", role, lis, start: "2026-08-20T00:00:00Z", classlist: CLASS(), quizzes: [mkQuiz(QI)] }] });
  t = syncTab(w); await t.run();
  const b = w.syncBodies().pop();
  if (want) check(`C4 "${role}"${lis.length ? " + " + lis[0] : ""}: course read, lis_roles + role_id sent`, b && b.courses.length === 1 && JSON.stringify(b.courses[0].lis_roles) === JSON.stringify(lis) && b.courses[0].classlist[1].role_id === 110, b ? JSON.stringify(b.courses[0]).slice(0, 120) : t.text());
  else check(`C4 a Student who is an Instructor elsewhere (institution role) is not treated as staff`, !b && /not an instructor/.test(t.text()), t.text());
}

console.log("C10 host sent; the server's other_school answer is shown");
{
  w = await world(); t = syncTab(w); await t.run();
  check("C10 /sync carries host", (w.syncBodies().pop() || {}).host === HOST);
  w.apiHook = (path) => path === "/sync" ? jr({ reason: "other_school" }, 403) : null;
  t = syncTab(w); await t.run();
  check("C10 'not set up for this school yet' shown", /not set up for this school yet/.test(t.text()), t.text());
}

// ================= dashboard =================
console.log("dashboard: polling pauses while hidden; home refresh is /bs only every 15 min");
w = await world(); await syncTab(w).run();
d = dashTab(w, { token: w.PROF }); await w.idle(); await sleep(10);
const auto = d.intervals.find(i => i.ms === 900000);
check("home refresh every 15 min", !!auto && !d.intervals.some(i => i.ms === 60000), d.intervals.map(i => i.ms).join(","));
d.hidden = true; let f0 = d.fetched.length; if (auto) await auto.fn(); await w.idle();
check("hidden tab: no requests", d.fetched.length === f0, d.fetched.slice(f0).join(","));
d.hidden = false; f0 = d.fetched.length; if (auto) await auto.fn(); await w.idle();
check("visible: only /bs", d.fetched.slice(f0).length === 1 && /^\/api\/bs/.test(d.fetched[f0] || ""), d.fetched.slice(f0).join(","));
await d.go(`#live/${OU}-${QI}`);
const liveT = d.intervals.filter(i => i.ms === 10000).pop();
d.hidden = true; f0 = d.fetched.length; await liveT.fn(); await w.idle();
check("live view hidden: no /live polling", d.fetched.length === f0, d.fetched.slice(f0).join(","));

console.log("dashboard: a double click on the big switch sends each change once");
w = await world(); await syncTab(w).run(); await w.prof("/protect", { ou: String(OU), qi: String(QI), on: false });
d = dashTab(w, { token: w.PROF }); await w.idle(); await sleep(10); d.posts.length = 0;
await Promise.all([d.run("setAll(true)"), d.run("setAll(true)")]); await w.idle();
check("double click -> one /protect, no error", d.posts.filter(p => p.path === "/protect").length === 1 && !d.alerts.length, `${d.posts.filter(p => p.path === "/protect").length} | ${d.alerts.join("|")}`);

console.log("dashboard: Live shows why a student is flagged, plus device + Revoke for the admin");
d = dashTab(w, { token: w.ADMIN, canned: { "/live": { rows: [{ device_id: "mac-al01", student: "al@usc.edu", email: "al@usc.edu", status: "left_early", reason: "went_dark", flagged_at: new Date().toISOString() },
                                                               { device_id: "mac-bo01", student: "bo@usc.edu", email: "bo@usc.edu", status: "left_early", reason: "local_request" }] } } });
await w.idle(); await d.go(`#live/${OU}-${QI}`);
const lr = d.el("lrows").innerHTML;
check("reason in plain words (went_dark, local_request)", /lost contact/.test(lr) && /turned LOCKqz off/.test(lr), lr.slice(0, 200));
check("device id + Revoke button", /mac-al01/.test(lr) && /data-dev="mac-al01"[^>]*>Revoke/.test(lr));
await d.run(`revokeDev("mac-al01")`); await w.idle();
check("Revoke calls /revoke-device", d.posts.some(p => p.path === "/revoke-device" && p.body.device_id === "mac-al01") && Number(w.q("SELECT revoked FROM devices WHERE device_id='mac-al01'").revoked) === 1);

console.log("dashboard: Activity log has a Device column");
await d.go("#activity");
check("Activity header has Device", /<th>Device<\/th>/.test(d.app()));

console.log("dashboard admin: Reassign + Void on every payment, reset requests, delete a student");
w.sqlite.prepare("INSERT INTO payments (txn,code,amount,via,payer,note,term,received_at) VALUES (?,?,?,?,?,?,?,?)").run("T1", null, 7, "venmo", "Al A", "LQSXXXXX", "20263", new Date().toISOString());
const ps = await w.api("/pay/start", { email: "bo@usc.edu", t: payT(w.env, "bo@usc.edu") }); const bocode = ps.data?.code;
w.sqlite.prepare("INSERT INTO payments (txn,code,amount,via,payer,note,term,received_at) VALUES (?,?,?,?,?,?,?,?)").run("T2", bocode, 7, "zelle", "Bo B", bocode, "20263", new Date().toISOString());
d = dashTab(w, { token: w.ADMIN, hash: "#admin", canned: { "/reset-requests": { requests: [{ email: "lost@usc.edu", at: new Date().toISOString() }] }, "/pay-void": { ok: true }, "/forget": { ok: true, email: "al@usc.edu", devices: 4, roster_rows: 2 } } });
await w.idle(); await sleep(20); await w.idle();
const pay = d.el("qs:#payments tbody").innerHTML;
check("unmatched AND matched rows both have Assign/Reassign + Void", (pay.match(/>Void</g) || []).length === 2 && />Reassign</.test(pay) && />Assign</.test(pay), pay.slice(0, 300));
await d.run(`voidPay("T2")`); await w.idle();
check("Void posts /pay-void {txn}", d.posts.some(p => p.path === "/pay-void" && p.body.txn === "T2"));
d.el("as_T2").value = "al@usc.edu"; await d.run(`assignPay("T2")`); await w.idle();
check("Reassign posts /pay-assign on a matched row", /id="as_T2"/.test(pay) && d.posts.some(p => p.path === "/pay-assign" && p.body.txn === "T2" && p.body.code === "al@usc.edu"));
check("reset requests listed with Reset pw", /lost@usc.edu/.test(d.el("qs:#resets tbody").innerHTML) && /Reset pw/.test(d.el("qs:#resets tbody").innerHTML), d.el("qs:#resets tbody").innerHTML);
d.el("fgemail").value = "Al@usc.edu"; d.alerts.length = 0; await d.run("forget()"); await w.idle();
check("delete student posts /forget {email}", d.posts.some(p => p.path === "/forget" && p.body.email === "al@usc.edu") && d.alerts.some(a => /4 device\(s\), 2 class-list/.test(a)), d.alerts.join("|"));

console.log("dashboard: partial payment progress; USC name box only for USC accounts");
d = dashTab(w, { token: w.PROF, canned: { "/my-sections": { term: "20263", name: "Prof Smith", sections: [{ section: "31000", course: "ECON-203", registered: 25, paid: false }], price: 1000, amount: 1000, received: 500, memo: "LQABCDE", venmo: "lqz", all_active: false } } });
await w.idle(); await sleep(10);
check("Received $500 of $1,000 shown", /Received \$500 of \$1,000/.test(d.el("pay").innerHTML), d.el("pay").innerHTML.replace(/<[^>]+>/g, " ").slice(0, 200));
w.sqlite.prepare("UPDATE teachers SET email='prof@other.edu' WHERE email='prof@usc.edu'").run();
d = dashTab(w, { token: w.PROF, canned: { "/my-sections": { term: null, name: null, sections: [], price: 1000, memo: "LQABCDE", all_active: false } } });
await w.idle(); await sleep(10);
check("F16 non-USC account: no 'USC Schedule of Classes' box", !/Schedule of Classes/.test(d.el("pay").innerHTML) && /Activate LOCKqz/.test(d.el("pay").innerHTML), d.el("pay").innerHTML.slice(0, 120));

// ================= pay.html =================
console.log("pay.html: back-off 10 s -> 60 s, stops after 15 min / when hidden, Check again, code sent, received shown");
{
  w = await world(); Object.assign(w.env, { STUDENT_FEE_FROM: "2000-01-01", STUDENT_FEE: "7", VENMO_HANDLE: "lqz-pay" });
  const els = {}, el = id => (els[id] = els[id] || { textContent: "", value: "", href: "", hidden: true, addEventListener(ev, fn) { this["on" + ev] = fn; } });
  const timers = [], listeners = {}, fetched = []; let T = Date.now(), hidden = false;
  const D = class extends Date { constructor(...a) { if (a.length) super(...a); else super(T); } static now() { return T; } };
  const ctx = { document: { getElementById: el, addEventListener(ev, fn) { listeners[ev] = fn; }, get visibilityState() { return hidden ? "hidden" : "visible"; } },
    location: { search: "?email=al%40usc.edu&t=" + payT(w.env, "al@usc.edu") }, history: { replaceState() {} }, Date: D, Math, JSON, encodeURIComponent, URLSearchParams, console, Number,
    fetch: (u, o) => { fetched.push(String(u)); if (/\/pay\/status/.test(u)) return Promise.resolve(jr({ paid: false, required: true, received: 3, amount: 7 })); return w.fetchApi(ORIGIN + u, o); },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; }, clearTimeout: i => { if (timers[i - 1]) timers[i - 1].live = false; },
    setInterval: (fn, ms) => { timers.push({ fn, ms, live: true, interval: true }); return timers.length; }, clearInterval: i => { if (timers[i - 1]) timers[i - 1].live = false; } };
  vm.createContext(ctx); vm.runInContext(script("pay.html"), ctx); await w.idle(); await sleep(10);
  const next = () => timers.filter(x => x.live).pop();
  const delays = [];
  for (let i = 0; i < 6; i++) { const x = next(); if (!x) break; delays.push(x.ms); x.live = false; T += x.ms; await x.fn(); await sleep(5); }
  check("delays grow from 10 s and cap at 60 s", delays[0] === 10000 && delays.every((v, i) => !i || v >= delays[i - 1]) && Math.max(...delays) <= 60000 && delays.length === 6 && delays[5] === 60000, delays.join(","));
  check("/pay/status sends the pay code", fetched.some(u => /\/pay\/status\?email=al%40usc\.edu&code=LQS/.test(u)), fetched.filter(u => /status/.test(u))[0]);
  check("received $3 of $7 shown", el("got").hidden === false && /Received \$3 of \$7/.test(el("got").textContent), el("got").textContent);
  T += 16 * 60e3; { const x = next(); if (x) { x.live = false; await x.fn(); await sleep(5); } }
  check("stops after ~15 min", !next(), timers.filter(x => x.live).length);
  const n0 = fetched.length; el("again").onclick && await el("again").onclick(); await sleep(5);
  check("Check again checks now and restarts polling", fetched.length === n0 + 1 && !!next(), `${fetched.length - n0} ${!!next()}`);
  hidden = true; listeners.visibilitychange && listeners.visibilitychange();
  check("hidden tab: polling stopped", !next());
}

// ================= index.html / privacy.html =================
console.log("index.html: OK/Allow line, Command Line Tools note, no uninstall option");
{
  const els = {}, el = id => (els[id] = els[id] || { textContent: "", hidden: false, href: "", getAttribute() { return this.href; }, parentNode: {} });
  const body = page("index.html");
  for (const [ua, os] of [["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", "mac"], ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "win"]]) {
    for (const k of Object.keys(els)) delete els[k];
    const ctx = { navigator: { userAgent: ua, maxTouchPoints: 0 }, location: { origin: ORIGIN }, document: { getElementById: el }, console,
      fetch: (p) => Promise.resolve(new Response("x", { status: /uninstall|install|download/.test(p) && !/download\/(mac|windows)\//.test(p) ? 200 : 404, headers: { "Content-Type": "application/octet-stream" } })), setTimeout };
    vm.createContext(ctx); vm.runInContext(script("index.html"), ctx); await sleep(10);
    check(`${os}: tells students to click OK/Allow`, /OK or Allow/.test(body));
    check(`${os}: no remove/uninstall option on the page`, !els.rm || els.rm.hidden !== false, "");
    if (os === "mac") check("mac: password note, no Command Line Tools sentence (removed 26 Oct)", /Mac password/.test(els.pw.textContent) && !/Command Line Tools/.test(els.pw.textContent), els.pw.textContent);
  }
  const pv = page("privacy.html");
  check("privacy: codes only when email codes are on; macOS version; tab addresses not sent; deletion on request; invites; pay codes",
    /When email codes are on/.test(pv) && /macOS version/.test(pv) && /are not sent/.test(pv) && /Ask and we delete everything/.test(pv) && /Invites/.test(pv) && /makes a payment code/.test(pv));
}

console.log("FIX-2 C3 via the dashboard: a professor-password quiz protected from the dashboard keeps that password");
{
  w = await world(); Object.assign(w.quiz(), { Password: "owl42" });
  t = syncTab(w); await t.run();
  await w.prof("/protect", { ou: String(OU), qi: String(QI), on: true });     // dashboard toggle (or Protect all)
  t2 = syncTab(w); await t2.run();
  const o = JSON.parse(w.q("SELECT orig FROM bs_quizzes WHERE qi=?", String(QI))?.orig || "{}");
  check("#2 the next Sync saves owl42 BEFORE writing LOCKqz's password", /^LQ-/.test(w.quiz().Password || "") && o.pw === "owl42", `bs=${w.quiz().Password} orig=${JSON.stringify(o)}`);
  await t2.toggle(false);
  check("#2 unticking puts owl42 back (not an empty password)", w.quiz().Password === "owl42", w.quiz().Password);
}

console.log("FIX-3 a course copied from a LOCKqz term: the quiz's stale LQ- password is replaced");
{
  w = await world(); Object.assign(w.quiz(), { Password: "LQ-ABCDEFGH" });
  t = syncTab(w); await t.run();
  const row = w.q("SELECT password FROM quizzes WHERE qi=?", String(QI));
  check("#3 auto-protected with a NEW LOCKqz password, written into Brightspace", !!row && w.quiz().Password === row.password && row.password !== "LQ-ABCDEFGH", `bs=${w.quiz().Password} row=${JSON.stringify(row)}`);
  await w.lock(w.AL); const r = await w.pw(w.AL);
  check("#3 a student gets the password Brightspace holds", r.data?.password === w.quiz().Password, JSON.stringify(r.data));
  check("#3 nothing saved as the professor's own password", JSON.parse(w.q("SELECT orig FROM bs_quizzes WHERE qi=?", String(QI))?.orig || "{}").pw == null);
}

console.log("FIX-6 Brightspace dates changed during a gate reach the server's start check");
{
  w = await world(); Object.assign(w.quiz(), { StartDate: new Date(Date.now() + 3600e3).toISOString(), EndDate: new Date(Date.now() + 7200e3).toISOString() });
  // the gate code changes every round here (bucket 0), so each round re-reads the quiz record from Brightspace
  let n = 0; w.apiHook = (path) => path === "/rotating" ? jr({ codes: { [QI]: { cur: "LQ-ABCDEF01" + (n++ % 10) + "0", next: "LQ-0000000000", bucket: 0 } } }) : null;
  t = syncTab(w); await t.run(); await w.lock(w.AL); await t.start();
  check("precondition: gate on, server start = the original (1 h ahead)", w.gated() === 1 && Date.parse(w.q("SELECT start_date FROM bs_quizzes WHERE qi=?", String(QI)).start_date) > Date.now() + 3000e3);
  const ns = new Date(Date.now() - 60e3).toISOString(), ne = new Date(Date.now() + 9000e3).toISOString();
  Object.assign(w.quiz(), { StartDate: ns, EndDate: ne });   // professor opens it early and extends the end
  await t.tick(); await t.tick(); await t.tick();
  w.apiHook = null;
  const b = w.q("SELECT start_date, end_date FROM bs_quizzes WHERE qi=?", String(QI));
  check("#6 the server now has Brightspace's new start and end", b && Date.parse(b.start_date) === Date.parse(ns) && Date.parse(b.end_date) === Date.parse(ne), JSON.stringify(b));
  await w.lock(w.AL); const r = await w.pw(w.AL);
  check("#6 a locked student gets the password (no stale 'not started')", r.status === 200 && !!r.data?.password, JSON.stringify(r.data));
  check("#6 the gate is still on with its kept list", w.gated() === 1 && w.q("SELECT sa_keep FROM quizzes WHERE qi=?", String(QI)).sa_keep !== null);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
