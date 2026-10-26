// Front-end regressions (audit 24 Oct 2026). NO browser: the REAL sync.js, dashboard.html and pay.html
// scripts run in node:vm sandboxes against a simulated Brightspace and the REAL LOCKqz API
// (in-memory SQLite). Each check names the audit item it guards.
//   sync.js   1 release clears a gate code + un-hides; unchecking stops the gate
//             2 X hides (not kills) a running gate; the bookmark re-shows it, never a 2nd copy
//             3 reopening Sync never writes the fixed password over a running gate's code
//             4 Start gate works right after ticking the box; start/stop errors are shown, state kept
//            15 refused special-access writes are counted and shown
//   dashboard 5 change password, 6 no data in onclick, 7 60 s refresh keeps what you type,
//             8 semEnd in LA, 9 errors shown + re-draw + why it's off, 10 pending "off" quizzes,
//            11 errors / 401 / no network, 13 LA "today", 14 live "updated", 16 pay card,
//            17 lockout message, 18 Watch live, low: Activate date guard, Copy emails
//   pay.html 12 fee off -> "No payment needed yet"; amount from the server
// Run against other copies of the pages with LQZ_PUBLIC=<dir with sync.js, dashboard.html, pay.html>,
// and against another API file with LQZ_ROUTE=<path to [[route]].js>.
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const PUB = process.env.LQZ_PUBLIC || join(CF, "public");
const tmp = mkdtempSync(join(tmpdir(), "lqz-front-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(process.env.LQZ_ROUTE || join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
const SYNC_SRC = readFileSync(join(PUB, "sync.js"), "utf8");
const script = f => (readFileSync(join(PUB, f), "utf8").match(/<script>([\s\S]*?)<\/script>/) || [])[1];
const DASH_SRC = script("dashboard.html"), PAY_SRC = script("pay.html");

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
const decode = s => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const API = "https://lockqz.test/api", ORIGIN = "https://lockqz.test";
const OU = 98765, QI = 12345, END = "2099-01-01T00:00:00.000Z";
const SCHEMA = readFileSync(join(CF, "schema.sql"), "utf8");
const MIGR = readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort();   // each is a no-op if already in schema.sql
const classlist = [
  { Identifier: "4000", DisplayName: "Prof", Email: "prof@usc.edu", ClasslistRoleDisplayName: "Instructor" },
  { Identifier: "4001", DisplayName: "Al", Email: "al@usc.edu", ClasslistRoleDisplayName: "Student" },
  { Identifier: "4002", DisplayName: "Bo", Email: "bo@usc.edu", ClasslistRoleDisplayName: "Student" },
  { Identifier: "4005", DisplayName: "Dee (extra time)", Email: "dee@usc.edu", ClasslistRoleDisplayName: "Student" },
];
const jr = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const sign = (key, path, ts, raw) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(raw).digest("hex")}`).digest("hex");

// ---- one fresh world: API + database + Brightspace + accounts ----
async function world() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  for (const m of MIGR) for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch (e) { /* already in schema.sql */ } }
  const db = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
    const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
      first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
      run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } }; return o; },
    async batch(sts) { for (const s of sts) s._run(); } };
  const w = { sqlite, env: { DB: db, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", LIVE_CACHE_MS: "0" }, calls: [], confirms: [], inflight: 0, netDown: false };
  const track = p => { w.inflight++; return Promise.resolve(p).finally(() => { w.inflight--; }); };
  w.idle = async () => { for (let z = 0; z < 4;) { await new Promise(r => setTimeout(r, 5)); z = w.inflight ? 0 : z + 1; } };
  w.fetchApi = (url, opt) => w.netDown ? Promise.reject(new TypeError("Failed to fetch")) : track(onRequest({ request: new Request(url, opt), env: w.env }));
  w.api = async (path, body, headers = {}) => {
    const res = await onRequest({ request: new Request(API + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env: w.env });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  w.dev = (path, body, d) => { const raw = JSON.stringify(body), ts = String(Math.floor(Date.now() / 1000));
    return w.api(path, body, { "X-LOCKqz-Device": d.id, "X-LOCKqz-Time": ts, "X-LOCKqz-Sig": sign(d.key, `/api${path}`, ts, raw) }); };
  w.q = (sql, ...a) => sqlite.prepare(sql).get(...a);
  // simulated Brightspace (fail* flags make a write refuse)
  const BS = w.BS = {
    quiz: { QuizId: QI, Name: "Midterm", IsActive: true, StartDate: null, EndDate: END, DueDate: null, Password: null,
            AllowOnlyUsersWithSpecialAccess: false, RestrictIPAddressRange: null, AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 1 },
            Instructions: { Text: { Text: "", Html: "" }, IsDisplayed: false }, Description: { Text: { Text: "", Html: "" }, IsDisplayed: false },
            Header: { Text: { Text: "", Html: "" }, IsDisplayed: false }, Footer: { Text: { Text: "", Html: "" }, IsDisplayed: false } },
    sa: { "4005": { StartDate: null, EndDate: "2099-02-01T00:00:00.000Z", DueDate: null, SubmissionTimeLimit: { IsEnforced: true, TimeLimitValue: 90 } } },
    puts: [], failQuizPut: false, failSaPut: false, failSaDel: false };
  w.brightspace = async (url, opt = {}) => {
    const u = new URL(url, "https://usc.brightspace.com"), p = u.pathname, m = (opt.method || "GET").toUpperCase();
    if (p === "/d2l/api/versions/") return jr([{ ProductCode: "le", LatestVersion: "1.100" }, { ProductCode: "lp", LatestVersion: "1.64" }]);
    if (p.endsWith("/users/whoami")) return jr({ Identifier: "4000", FirstName: "Prof", LastName: "" });
    if (p.includes("/enrollments/myenrollments/")) return jr({ Items: [{ OrgUnit: { Id: OU, Name: "ECON 203", Code: "ECON-203" }, Access: { IsActive: true, ClasslistRoleName: "Instructor" } }], PagingInfo: { HasMoreItems: false } });
    if (p.endsWith(`/${OU}/classlist/`)) return jr(classlist);
    if (p.endsWith(`/${OU}/quizzes/`)) return jr({ Objects: [BS.quiz], Next: null });
    const sa = p.match(/\/quizzes\/(\d+)\/specialaccess\/(\d+)?$/);
    if (sa) {
      if (!sa[2]) return jr({ Objects: Object.entries(BS.sa).map(([UserId, SpecialAccess]) => ({ UserId: Number(UserId), SpecialAccess })), Next: null });
      if (m === "PUT") { if (BS.failSaPut) return jr({ error: "forbidden" }, 403); BS.sa[sa[2]] = JSON.parse(opt.body); return jr({}); }
      if (m === "DELETE") { if (BS.failSaDel) return jr({ error: "forbidden" }, 403); delete BS.sa[sa[2]]; return jr({}); }
    }
    if (p.endsWith(`/quizzes/${QI}`)) {
      if (m === "PUT") { if (BS.failQuizPut) return new Response("server busy", { status: 500 }); const b = JSON.parse(opt.body); BS.puts.push(b); Object.assign(BS.quiz, b); return jr({}); }
      return jr(JSON.parse(JSON.stringify(BS.quiz)));
    }
    return jr({ error: "no mock for " + p }, 404);
  };
  // accounts: admin (first signup), a verified + paid professor, two student devices
  w.ADMIN = (await w.api("/signup", { email: "admin@usc.edu", password: "adminpass1" })).data.token;
  w.PROF = (await w.api("/signup", { email: "prof@usc.edu", password: "profpass1", name: "Prof" })).data.token;
  sqlite.prepare("UPDATE teachers SET verified=1, active_until='2099-12-31' WHERE email='prof@usc.edu'").run();
  w.KEY = (await w.api("/synckey", undefined, { "X-LOCKqz-Teacher": w.PROF })).data.key;
  await w.api("/sync", { courses: [{ ou: String(OU), name: "ECON 203", role: "Instructor", classlist: classlist.map(c => ({ id: c.Identifier, name: c.DisplayName, email: c.Email, role: c.ClasslistRoleDisplayName })), quizzes: [] }] }, { "X-LOCKqz-Teacher": "admin-key" });
  w.AL = { id: "mac-al01", key: randomBytes(32).toString("hex") }; w.BO = { id: "mac-bo01", key: randomBytes(32).toString("hex") };
  for (const [d, e] of [[w.AL, "al@usc.edu"], [w.BO, "bo@usc.edu"]]) await w.api("/register", { device_id: d.id, key: d.key, student: e, platform: "mac" });
  w.lock = d => w.dev("/report", { device_id: d.id, event: "lock", quiz_id: `${OU}-${QI}` }, d);
  w.pw = d => w.dev("/password", { url: `https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${QI}&ou=${OU}`, device_id: d.id }, d);
  w.prof = (path, body) => w.api(path, body, { "X-LOCKqz-Teacher": w.PROF });
  w.gated = () => Number(w.q("SELECT gated FROM quizzes WHERE ou=? AND qi=?", String(OU), String(QI))?.gated || 0);
  return w;
}

// ---- a Brightspace browser tab; run() = one click on the LOCKqz Sync bookmark ----
function syncTab(w) {
  const timers = [], boxes = [];
  const newBox = () => {
    const els = {};
    const stub = (k, ds = {}) => (els[k] = els[k] || { textContent: "", style: {}, dataset: ds, disabled: false, checked: false, onclick: null, onchange: null });
    const B = { innerHTML: "",
      querySelector(sel) { const m = sel.match(/\[data-(\w+)="([^"]+)"\]/); return m && this.innerHTML.includes(`data-${m[1]}="${m[2]}"`) ? stub(m[1] + ":" + m[2], { [m[1]]: m[2] }) : null; },
      querySelectorAll(sel) {
        if (sel.startsWith("input")) return [...this.innerHTML.matchAll(/data-ou="(\d+)" data-qi="(\d+)"(\s*checked)?/g)].map(x => { const e = stub("cb:" + x[2], { ou: x[1], qi: x[2] }); e.checked = !!x[3]; return e; });
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
  const ctx = { document, location: { pathname: `/d2l/home/${OU}`, host: "usc.brightspace.com" }, localStorage: { getItem: () => "csrf" },
    fetch: (url, opt) => { w.calls.push(String(url)); return w.netDown ? Promise.reject(new TypeError("Failed to fetch")) : String(url).startsWith(API) ? w.fetchApi(url, opt) : w.brightspace(url, opt); },
    setInterval: fn => { timers.push(fn); return timers.length; }, clearInterval: i => { timers[i - 1] = null; },
    confirm: m => { w.confirms.push(m); return true; }, URL, Request, Response, console, setTimeout };
  vm.createContext(ctx);
  const t = { boxes,
    run: async () => { await vm.runInContext(SYNC_SRC, ctx); await w.idle(); },
    tick: async () => { for (const f of timers) if (f) await f(); await w.idle(); },
    active: () => timers.filter(Boolean).length,
    box: () => boxes[boxes.length - 1],
    el: k => t.box().els[k] || { textContent: "", dataset: {} },
  };
  t.cb = () => t.el("cb:" + QI); t.gb = () => t.el(`gate:${OU}:${QI}`); t.gst = () => t.el("gst:" + QI);
  t.click = async e => { let threw = null; try { await e.onclick(); } catch (x) { threw = x; } await w.idle(); return threw; };
  t.startGate = async () => { const threw = await t.click(t.gb()); await t.tick(); return threw; };
  return t;
}

// ---- dashboard page (fake DOM, real API) ----
const fakeDate = iso => { const T = Date.parse(iso); return class extends Date { constructor(...a) { if (a.length) super(...a); else super(T); } static now() { return T; } }; };
function dashTab(w, { token = "", hash = "", now = null } = {}) {
  const tab = { els: {}, alerts: [], prompts: [], reloads: 0, intervals: [], openDetails: false };
  const ls = tab.ls = new Map(token ? [["lockqz_token", token]] : []);
  const mk = id => ({ id, innerHTML: "", textContent: "", value: "", readOnly: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, addEventListener() {}, removeAttribute() {}, contains() { return false; },
    querySelector: sel => (sel === "details[open]" && tab.openDetails ? {} : null), querySelectorAll: () => [],
    insertAdjacentHTML(pos, h) { this.innerHTML = pos === "afterbegin" ? h + this.innerHTML : this.innerHTML + h; } });
  const el = tab.el = id => (tab.els[id] = tab.els[id] || mk(id));
  tab.loc = { hash, search: "", pathname: "/", origin: ORIGIN, reload() { tab.reloads++; } };
  const ctx = { document: { getElementById: el, querySelector: s => el("qs:" + s), querySelectorAll: () => [], addEventListener() {}, activeElement: null },
    window: { addEventListener() {} }, location: tab.loc, history: { replaceState() {} },
    localStorage: { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) },
    fetch: (u, o) => w.fetchApi(ORIGIN + u, o), alert: m => tab.alerts.push(String(m)), prompt: () => (tab.prompts.length ? tab.prompts.shift() : null), confirm: () => true,
    navigator: { clipboard: { writeText: async s => { tab.clip = s; } } },
    setInterval: (fn, ms) => { tab.intervals.push({ fn, ms }); return tab.intervals.length; }, clearInterval() {},
    URLSearchParams, console, setTimeout };
  if (now) ctx.Date = fakeDate(now);
  vm.createContext(ctx); vm.runInContext(DASH_SRC, ctx);
  tab.run = code => vm.runInContext(code, ctx);
  tab.app = () => el("app").innerHTML;
  tab.go = async h => { tab.loc.hash = h; await tab.run("route()"); await w.idle(); };
  return tab;
}
// ---- pay.html (fake DOM, real API) ----
function payTab(w, email) {
  const els = {}, el = id => (els[id] = els[id] || { textContent: "", value: "", href: "", addEventListener() {} });
  const ctx = { document: { getElementById: el, addEventListener() {}, visibilityState: "visible" }, location: { search: "?email=" + encodeURIComponent(email) }, history: { replaceState() {} },
    fetch: (u, o) => w.fetchApi(ORIGIN + u, o), setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, URLSearchParams, console };
  vm.createContext(ctx); vm.runInContext(PAY_SRC, ctx);
  return { el };
}

let w, t, t2, d, threw;

console.log("1 unticking a gated quiz stops the gate and really clears Brightspace");
w = await world(); t = syncTab(w); await t.run(); await w.lock(w.AL); await t.startGate();
check("precondition: gate on, Al admitted", w.BS.quiz.AllowOnlyUsersWithSpecialAccess === true && !!w.BS.sa["4001"]);
t.cb().checked = false; await t.cb().onchange(); await w.idle();
check("1 Brightspace password removed", w.BS.quiz.Password == null, w.BS.quiz.Password);
check("1 quiz visible again", w.BS.quiz.AllowOnlyUsersWithSpecialAccess === false);
check("1 gate loop stopped", t.active() === 0, t.active() + " running");
check("1 LOCKqz grant removed, accommodation kept", !w.BS.sa["4001"] && !!w.BS.sa["4005"]);
check("1 button back to 'Start gate', disabled while unticked", t.gb().textContent === "Start gate" && t.gb().disabled === true, `${t.gb().textContent} disabled=${t.gb().disabled}`);

console.log("1 dashboard turns a gated quiz off; the next Sync clears the gate code and un-hides it");
w = await world(); t = syncTab(w); await t.run(); await w.lock(w.AL); await t.startGate();
check("precondition: Brightspace holds a gate code", /^LQ-[0-9A-F]{10}$/.test(w.BS.quiz.Password || ""), w.BS.quiz.Password);
await w.prof("/protect", { ou: String(OU), qi: String(QI), on: false });
t2 = syncTab(w); await t2.run();
check("1 gate code removed from Brightspace", w.BS.quiz.Password == null, w.BS.quiz.Password);
check("1 quiz visible again", w.BS.quiz.AllowOnlyUsersWithSpecialAccess === false);
check("1 nothing left waiting to clear", !w.q("SELECT 1 AS x FROM pending_clear WHERE qi=?", String(QI)));

console.log("2 X with a gate on hides the panel; the bookmark shows it again (no second copy)");
w = await world(); t = syncTab(w); await t.run(); await w.lock(w.AL); await t.startGate();
const box = t.box(), syncs = () => w.calls.filter(u => u.endsWith("/api/sync")).length, s0 = syncs();
box.X.onclick();
check("2 X asks first while a gate is on", w.confirms.length === 1);
check("2 panel hidden, not destroyed; gate still running", box.style.display === "none" && !box.removed && t.active() === 1, `display=${box.style.display} removed=${box.removed} timers=${t.active()}`);
await t.run();
check("2 bookmark again shows the same panel", box.style.display === "" && t.boxes.length === 1, `boxes=${t.boxes.length}`);
check("2 no second Sync and no second gate", syncs() === s0 && t.active() === 1, `syncs ${s0}->${syncs()} timers=${t.active()}`);
await t.click(t.gb()); box.X.onclick();
check("2 X with no gate closes the panel", box.removed && w.confirms.length === 1);

console.log("3 reopening Sync while the gate runs never writes the fixed password over the gate code");
w = await world(); t = syncTab(w); await t.run();
const SEED = w.BS.quiz.Password;
await w.lock(w.AL); await t.startGate();
const n0 = w.BS.puts.length;
t2 = syncTab(w); await t2.run();
check("3 no write of the fixed password during reopen", w.BS.puts.slice(n0).every(b => b.Password !== SEED), JSON.stringify(w.BS.puts.slice(n0).map(b => b.Password)));
await w.lock(w.AL);
check("3 app password === Brightspace password", (await w.pw(w.AL)).data?.password === w.BS.quiz.Password);

console.log("4 tick the box, then Start gate: works (password kept in the panel)");
w = await world(); await syncTab(w).run(); await w.prof("/protect", { ou: String(OU), qi: String(QI), on: false });
t = syncTab(w); await t.run();
check("precondition: quiz not protected", !t.cb().checked && !w.BS.quiz.Password);
t.cb().checked = true; await t.cb().onchange(); await w.idle();
check("4 ticking protects the quiz in Brightspace", /^LQ-/.test(w.BS.quiz.Password || ""));
await w.lock(w.AL); threw = await t.startGate();
check("4 Start gate starts", !threw && /^LIVE/.test(t.gst().textContent), threw ? threw.message : t.gst().textContent);
check("4 quiz hidden, Al admitted", w.BS.quiz.AllowOnlyUsersWithSpecialAccess === true && !!w.BS.sa["4001"]);

console.log("4 a failed start is shown and LOCKqz is not left gated");
w = await world(); t = syncTab(w); await t.run(); w.BS.failQuizPut = true;
threw = await t.click(t.gb());
check("4 error shown (not stuck on 'starting...')", !threw && /start failed/i.test(t.gst().textContent), threw ? threw.message : t.gst().textContent);
check("4 server not gated", w.gated() === 0);
check("4 button usable again", t.gb().disabled === false && t.gb().textContent === "Start gate", `${t.gb().textContent} disabled=${t.gb().disabled}`);

console.log("4 a failed stop is shown; the gate stays on and consistent");
w = await world(); t = syncTab(w); await t.run(); await w.lock(w.AL); await t.startGate();
w.BS.failQuizPut = true; threw = await t.click(t.gb());
check("4 stop error shown (not 'off')", !threw && /stop failed/i.test(t.gst().textContent), threw ? threw.message : t.gst().textContent);
check("4 LOCKqz still gated, loop running", w.gated() === 1 && t.active() === 1 && t.gb().textContent === "Stop gate", `gated=${w.gated()} timers=${t.active()} btn=${t.gb().textContent}`);
w.BS.failQuizPut = false; await t.tick(); await w.lock(w.AL);
check("4 then: quiz hidden and app password === Brightspace's", w.BS.quiz.AllowOnlyUsersWithSpecialAccess === true && (await w.pw(w.AL)).data?.password === w.BS.quiz.Password);

console.log("15 refused special-access writes are counted, not reported as admitted");
w = await world(); t = syncTab(w); await t.run(); await t.click(t.gb()); w.BS.failSaPut = true; await w.lock(w.AL); await t.tick();   // refused AFTER the start check (round 2: a refused test grant never hides the quiz)
check("15 grant refused -> shown", /not admitted/i.test(t.gst().textContent) && /LIVE — 0 locked in/.test(t.gst().textContent), t.gst().textContent);
w.BS.failSaPut = false; await t.tick();
check("15 grant works next tick", /LIVE — 1 locked in/.test(t.gst().textContent) && !!w.BS.sa["4001"], t.gst().textContent);
w.BS.failSaDel = true; await w.lock(w.AL); await w.dev("/report", { device_id: w.AL.id, event: "tamper", quiz_id: `${OU}-${QI}` }, w.AL); await t.tick();
check("15 removal refused -> shown", /not removed/i.test(t.gst().textContent), t.gst().textContent);

console.log("5 change password: asks the current one, keeps you signed in, new Sync bookmark");
w = await world(); d = dashTab(w, { token: w.PROF }); await w.idle();
d.prompts = ["profpass1", "newpass123"]; await d.run("changePw()"); await w.idle();
const tok = d.ls.get("lockqz_token");
check("5 no error", !d.alerts.some(a => /wrong|unauthor/i.test(a)), d.alerts.join(" | "));
check("5 new session token stored and valid", !!tok && tok !== w.PROF && (await w.api("/me", undefined, { "X-LOCKqz-Teacher": tok })).status === 200);
check("5 new password signs in", (await w.api("/login", { email: "prof@usc.edu", password: "newpass123" })).status === 200);
const sk = w.q("SELECT sync_key FROM teachers WHERE email='prof@usc.edu'").sync_key;
check("5 dashboard holds the new Sync key", !!sk && sk !== w.KEY && d.run("SYNCKEY") === sk);
check("5 told to drag the new bookmark", d.alerts.some(a => /bookmark/i.test(a)), d.alerts.join(" | "));

console.log("6 data never runs as code in onclick");
w = await world(); const EVIL = "x');alert(1);//@a.b";
check("precondition: crafted email accepted by sign-up", (await w.api("/signup", { email: EVIL, password: "evilpass1" })).status === 200);
d = dashTab(w, { token: w.ADMIN, hash: "#admin" }); await w.idle();
const thtml = d.el("qs:#teachers tbody").innerHTML;
const handlers = [...thtml.matchAll(/onclick="([^"]*)"/g)].map(m => decode(m[1]));
check("6 professors table rendered", handlers.length > 0 && thtml.includes("alert(1)"));
check("6 no onclick contains the email", handlers.every(h => !h.includes("alert(1)")), handlers.find(h => h.includes("alert(1)")));
check("6 the button still carries the exact email", [...thtml.matchAll(/data-email="([^"]*)"/g)].map(m => decode(m[1])).includes(EVIL));

console.log("7 the home refresh never re-draws over open or typed things");
d = dashTab(w, { token: w.ADMIN, hash: "#admin" }); await w.idle();
const auto = d.intervals.find(i => i.ms === 300000);   // round 2: every 5 min while visible
d.el("app").innerHTML = "MARK"; await auto.fn(); await w.idle();
check("7 Admin page not re-drawn", d.app() === "MARK");
d.loc.hash = ""; d.openDetails = true; d.el("app").innerHTML = "MARK"; await auto.fn(); await w.idle();
check("7 home with an open section not re-drawn", d.app() === "MARK");
d.openDetails = false; await auto.fn(); await w.idle();
check("7 home with nothing open is refreshed", d.app() !== "MARK");

console.log("8 semester end = the server's dates, in Los Angeles");
for (const [iso, want] of [["2026-08-01T05:00:00Z", "2026-08-15"], ["2026-06-15T19:00:00Z", "2026-08-15"], ["2027-01-01T03:00:00Z", "2026-12-31"], ["2026-05-31T23:30:00Z", "2026-05-31"], ["2026-10-24T12:00:00Z", "2026-12-31"]]) {
  const got = dashTab(w, { now: iso }).run("semEnd()");
  check(`8 ${iso} -> ${want}`, got === want, got);
}

console.log("9 errors shown, page re-drawn, and why LOCKqz is off");
w = await world(); t = syncTab(w); await t.run();
await w.prof("/protect", { ou: String(OU), qi: String(QI), on: false });
w.sqlite.prepare("UPDATE teachers SET active_until=NULL WHERE email='prof@usc.edu'").run();
d = dashTab(w, { token: w.PROF }); await w.idle();
d.el("app").innerHTML = "STALE"; await d.run(`setQuiz("${OU}","${QI}",true)`); await w.idle();
check("9 switch error shown", d.alerts.some(a => /Not active/.test(a)), d.alerts.join(" | "));
check("9 page re-drawn after the error", d.app() !== "STALE");
d.alerts.length = 0; await d.run("setAll(true)"); await w.idle();
check("9 'all on' error shown", d.alerts.some(a => /Not active/.test(a)), d.alerts.join(" | "));
d.alerts.length = 0; await d.run(`setClass("${OU}",true)`); await w.idle();
check("9 'class on' error shown", d.alerts.some(a => /Not active/.test(a)), d.alerts.join(" | "));
const ta = (await w.api("/signup", { email: "newprof@usc.edu", password: "newprof12", name: "New Prof" })).data.token;
w.sqlite.prepare("INSERT INTO teacher_courses (teacher_id,ou,name,code,role,synced_at) SELECT id,?,?,?,?,? FROM teachers WHERE email='newprof@usc.edu'").run(String(OU), "ECON 203", "ECON-203", "Instructor", new Date().toISOString());
d = dashTab(w, { token: ta }); await w.idle();
await w.idle(); check("9 unpaid professor sees only the payment screen", /^<div id="pay">/.test(d.app()) && /Activate LOCKqz/.test(d.el("pay").innerHTML) && /Processing your payment/.test(d.el("pay").innerHTML), d.el("pay").innerHTML.slice(0, 300));
w.sqlite.prepare("UPDATE teachers SET active_until='2099-12-31' WHERE email='newprof@usc.edu'").run();
d = dashTab(w, { token: ta }); await w.idle();
check("9 unverified professor told why exams can't be protected", /until Brightspace shows you as the instructor/.test(d.app()));

console.log("10 'off but Brightspace still has our password' counts as one more click");
w = await world(); t = syncTab(w); await t.run();
await w.prof("/protect", { ou: String(OU), qi: String(QI), on: false });
d = dashTab(w, { token: w.PROF }); await w.idle();
check("10 home asks for one more Sync click", d.app().includes("One more click"));
await d.go(`#class/${OU}`);
check("10 exam row says '1 click left'", d.app().includes("Off · 1 click left"));

console.log("18 / 14 / 11 Watch live, live 'updated' time, live errors");
w = await world(); t = syncTab(w); await t.run();
d = dashTab(w, { token: w.PROF, hash: `#class/${OU}` }); await w.idle();
check("18 protected exam (no start date) has Watch live", d.app().includes(`href="#live/${OU}-${QI}"`));
await d.go(`#live/${OU}-${QI}`);
check("14 'updated' shows in the live view", /updated/.test(d.el("livesub").textContent), d.el("livesub").textContent);
check("14 sign-in text untouched", !/updated/.test(d.el("lsub").textContent), d.el("lsub").textContent);
await d.go("#live/999-1");
check("11 live error shown, no false all-clear", /not your course/.test(d.el("lrows").innerHTML) && !/nothing unusual/.test(d.el("lcounts").innerHTML), d.el("lrows").innerHTML.slice(0, 80));

console.log("11 no network / dead session");
await d.go(`#class/${OU}`);
w.netDown = true; threw = null; await d.run(`setQuiz("${OU}","${QI}",false)`).catch(e => { threw = e; }); w.netDown = false; await w.idle();
check("11 no connection: message, no crash", !threw && d.alerts.some(a => /connection/i.test(a)), threw ? threw.message : d.alerts.join(" | "));
w.sqlite.prepare("UPDATE teachers SET token=NULL WHERE email='prof@usc.edu'").run();
await d.run(`setQuiz("${OU}","${QI}",false)`); await w.idle();
check("11 expired session -> back to sign-in", d.reloads >= 1 && !d.ls.has("lockqz_token"), `reloads=${d.reloads}`);

console.log("13 Professors table 'active' uses the Los Angeles date");
w = await world(); w.sqlite.prepare("UPDATE teachers SET active_until='2026-10-24' WHERE email='prof@usc.edu'").run();
d = dashTab(w, { token: w.ADMIN, hash: "#admin", now: "2026-10-25T03:00:00Z" }); await w.idle();
const prow = d.el("qs:#teachers tbody").innerHTML.split("</tr>").find(r => r.includes("prof@usc.edu")) || "";
check("13 active through the end of 24 Oct in LA", prow.includes(">2026-10-24<") && !prow.includes(">off</b>"), prow.slice(0, 160));

console.log("16 payment card");
w = await world();
const la = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date()), mo = +la.slice(5, 7), TERM = String(+la.slice(0, 4) * 10 + (mo <= 5 ? 1 : mo <= 7 ? 2 : 3));
w.sqlite.prepare("UPDATE teachers SET active_until=NULL, name='Prof Smith' WHERE email='prof@usc.edu'").run();
w.sqlite.prepare("INSERT INTO usc_sections (term,section,course,title,first,last,seats,registered) VALUES (?,?,?,?,?,?,?,?)").run(TERM, "31000", "ECON-203", "Econ", "Prof", "Smith", 30, 25);
w.sqlite.prepare("INSERT INTO paid_sections (teacher_id,term,section,course,first,last,until,paid_at,via) SELECT id,?,?,?,?,?,?,?,? FROM teachers WHERE email='prof@usc.edu'").run(TERM, "31000", "ECON-203", "Prof", "Smith", "2099-12-31", new Date().toISOString(), "admin");
d = dashTab(w, { token: w.PROF }); await w.idle();
check("16 every section paid -> no payment card", d.el("pay").innerHTML === "", d.el("pay").innerHTML.slice(0, 80));
await d.run('loadPay("Prof")'); await w.idle();
check("16 one-word name -> asks for first and last name", /first and last name/.test(d.el("pay").innerHTML) && !/undefined/.test(d.el("pay").innerHTML));
await d.run('loadPay("Nobody Here")'); await w.idle();
check("16 unknown name -> 'No sections found'", /No sections found for Nobody Here/.test(d.el("pay").innerHTML));

console.log("17 sign-in shows the server's lockout message");
w = await world();
for (let i = 0; i < 5; i++) await w.api("/login", { email: "prof@usc.edu", password: "wrong-one" });
d = dashTab(w); d.el("email").value = "prof@usc.edu"; d.el("pw").value = "profpass1"; await d.run("go()"); await w.idle();
check("17 lockout text shown", /too many attempts/.test(d.el("lerr").textContent), d.el("lerr").textContent);
d = dashTab(w); d.el("email").value = "admin@usc.edu"; d.el("pw").value = "nope-nope"; await d.run("go()"); await w.idle();
check("17 wrong password still says 'Incorrect email or password.'", d.el("lerr").textContent === "Incorrect email or password.", d.el("lerr").textContent);

console.log("low: Activate needs a date; a big class gets Copy emails");
w = await world(); d = dashTab(w, { token: w.ADMIN, hash: "#admin" }); await w.idle();
const tid = w.q("SELECT id FROM teachers WHERE email='prof@usc.edu'").id;
d.el("d_" + tid).value = ""; await d.run(`activate("prof@usc.edu","${tid}")`); await w.idle();
check("low Activate with no date does not turn the professor off", w.q("SELECT active_until FROM teachers WHERE id=?", tid).active_until === "2099-12-31");
d.run(`ME={name:"P",email:"p@usc.edu",verified:true,active:true}; BS={courses:[{ou:"1",name:"BIG 101",code:"",synced_at:null,
  students:Array.from({length:120},(_,i)=>({name:"S"+i,email:"student.number"+i+"@usc.edu",installed:false})),
  quizzes:[{qi:"9",name:"Final",active:1,password:"LQ-X",bs_password_is_ours:1,start_date:"2099-01-01T00:00:00Z"}]}]}`);
const big = d.run("viewHome()"), mails = [...big.matchAll(/href="(mailto:[^"]*)"/g)].map(m => m[1]);
check("low big class has Copy emails", big.includes("Copy emails"));
check("low install mailto stays under 2000 characters", mails.length > 0 && mails.every(h => h.length < 2000), mails.map(h => h.length).join(","));

console.log("12 student pay page");
w = await world(); let p = payTab(w, "al@usc.edu"); await w.idle();
check("12 fee off -> 'No payment needed yet', not 'Paid'", p.el("free").hidden === false && p.el("done").hidden !== false);
Object.assign(w.env, { STUDENT_FEE_FROM: "2000-01-01", STUDENT_FEE: "7", VENMO_HANDLE: "lqz-pay", ZELLE_TO: "pay@lqz.test", INVOICE_EMAIL: "bill@lqz.test" });
p = payTab(w, "al@usc.edu"); await w.idle();
check("12 amount comes from the server; Zelle + bank transfer, no Venmo", p.el("amt").textContent === "$7" && p.el("venmo").hidden !== false && p.el("zamt").textContent === "Zelle $7" && p.el("bank").hidden === false && /bill@lqz.test/.test(p.el("bto").textContent) && /LQS/.test(decodeURIComponent(p.el("bank").href)), `${p.el("amt").textContent} | ${p.el("venmo").hidden} | ${p.el("zamt").textContent} | ${p.el("bank").hidden}`);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
