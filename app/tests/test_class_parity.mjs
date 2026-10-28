// Sync panel <-> dashboard parity (27 Oct 2026). NO browser: the REAL sync.js (Brightspace tab) and the
// REAL dashboard.html run against the REAL LOCKqz API (in-memory SQLite) and a simulated Brightspace with
// several classes. Both screens must always show:
//   P1 the same classes (an ended / dropped class leaves both), in the same order, with the same names;
//   P2 a LOCKqz class switch AND a Send email button on EVERY class (no exams, no students, all installed);
//   P3 the same on/off for every class and the same exams with switches (hidden ones too; ended = "past");
//   P4 a class turned off on the dashboard is off on the panel after the next Sync (password removed);
//   P5 a class turned off on the panel is off on the dashboard, and its NEW quizzes stay unprotected;
//   P6 turned back on from the panel: on in both, its quizzes protected; the panel tells the dashboard.
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare"), PUB = join(CF, "public");
const tmp = mkdtempSync(join(tmpdir(), "lqz-parity-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
const SYNC_SRC = readFileSync(join(PUB, "sync.js"), "utf8");
const DASH_SRC = (readFileSync(join(PUB, "dashboard.html"), "utf8").match(/<script>([\s\S]*?)<\/script>/) || [])[1];

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
const decode = s => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const API = "https://lockqz.test/api", ORIGIN = "https://lockqz.test";
const FUT = "2099-01-01T00:00:00.000Z", PAST = new Date(Date.now() - 3 * 86400000).toISOString();

// ---- API + database (schema + every migration) ----
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch (e) {} }
const db = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
  const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
    first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
    run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } }; return o; },
  async batch(sts) { for (const s of sts) s._run(); } };
const env = { DB: db, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", LIVE_CACHE_MS: "0" };
let inflight = 0;
const idle = async () => { for (let z = 0; z < 4;) { await new Promise(r => setTimeout(r, 5)); z = inflight ? 0 : z + 1; } };
const fetchApi = (url, opt) => { inflight++; return Promise.resolve(onRequest({ request: new Request(url, opt), env })).finally(() => { inflight--; }); };
const api = async (path, body, headers = {}) => { const r = await onRequest({ request: new Request(API + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env }); return { status: r.status, data: await r.json().catch(() => null) }; };

// ---- simulated Brightspace: 4 classes ----
const quiz = (qi, name, o = {}) => ({ QuizId: qi, Name: name, IsActive: true, StartDate: null, EndDate: FUT, DueDate: null, Password: null,
  AllowOnlyUsersWithSpecialAccess: false, RestrictIPAddressRange: null, AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 1 },
  Instructions: { Text: { Text: "", Html: "" }, IsDisplayed: false }, Description: { Text: { Text: "", Html: "" }, IsDisplayed: false },
  Header: { Text: { Text: "", Html: "" }, IsDisplayed: false }, Footer: { Text: { Text: "", Html: "" }, IsDisplayed: false }, ...o });
const prof = { Identifier: "4000", DisplayName: "Prof", Email: "prof@usc.edu", ClasslistRoleDisplayName: "Instructor" };
const stu = (id, n) => ({ Identifier: id, DisplayName: n, Email: n.toLowerCase() + "@usc.edu", ClasslistRoleDisplayName: "Student" });
const C = {
  1001: { name: "20263_FBE_437 Recession Economics", code: "FBE-437", end: null, cl: [prof, stu("4001", "Al"), stu("4002", "Bo")],
          qs: [quiz(11, "Midterm"), quiz(12, "Hidden quiz", { IsActive: false }), quiz(13, "Old quiz", { EndDate: PAST })] },
  1002: { name: "20263_BUAD_104 Intro to Business", code: "BUAD-104", end: null, cl: [prof, stu("4003", "Cy")], qs: [] },
  1003: { name: "20263_ECON_203 Micro", code: "ECON-203", end: null, cl: [prof, stu("4004", "Di")], qs: [quiz(31, "Final")] },
  1004: { name: "20261_ACCT_410 Last Spring", code: "ACCT-410", end: null, cl: [prof, stu("4005", "Ed")], qs: [quiz(41, "Exam 1")] },
};
const jr = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
async function brightspace(url, opt = {}) {
  const u = new URL(url, "https://usc.brightspace.com"), p = u.pathname, m = (opt.method || "GET").toUpperCase();
  if (p === "/d2l/api/versions/") return jr([{ ProductCode: "le", LatestVersion: "1.100" }, { ProductCode: "lp", LatestVersion: "1.64" }]);
  if (p.endsWith("/users/whoami")) return jr({ Identifier: "4000", FirstName: "Prof", LastName: "" });
  if (p.includes("/enrollments/myenrollments/")) return jr({ Items: Object.entries(C).map(([ou, c]) => ({ OrgUnit: { Id: Number(ou), Name: c.name, Code: c.code },
    Access: { IsActive: true, ClasslistRoleName: "Instructor", EndDate: c.end } })), PagingInfo: { HasMoreItems: false } });
  let x = p.match(/\/(\d+)\/classlist\/(paged\/)?$/); if (x) return x[2] ? jr({ Objects: C[x[1]].cl, Next: null }) : jr(C[x[1]].cl);
  x = p.match(/\/(\d+)\/quizzes\/$/); if (x) return jr({ Objects: C[x[1]].qs, Next: null });
  if (/\/specialaccess\/(\d+)?$/.test(p)) return jr({ Objects: [], Next: null });
  x = p.match(/\/(\d+)\/quizzes\/(\d+)$/);
  if (x) { const q = C[x[1]].qs.find(z => String(z.QuizId) === x[2]); if (!q) return jr({}, 404);
    if (m === "PUT") { Object.assign(q, JSON.parse(opt.body)); return jr({}); } return jr(JSON.parse(JSON.stringify(q))); }
  return jr({ error: "no mock for " + p }, 404);
}
const pwOf = (ou, qi) => C[ou].qs.find(q => q.QuizId === qi)?.Password || null;

// ---- accounts: admin + verified, paid professor; every class on an admin-synced (trusted) roster ----
await api("/signup", { email: "admin@usc.edu", password: "adminpass1" });
const PROF = (await api("/signup", { email: "prof@usc.edu", password: "profpass1", name: "Prof" })).data.token;
sqlite.prepare("UPDATE teachers SET verified=1, vouched=1, active_until='2099-12-31' WHERE email='prof@usc.edu'").run();
const KEY = (await api("/synckey", undefined, { "X-LOCKqz-Teacher": PROF })).data.key;
await api("/sync", { courses: Object.entries(C).map(([ou, c]) => ({ ou, name: c.name, role: "Instructor", classlist: c.cl.map(s => ({ id: s.Identifier, name: s.DisplayName, email: s.Email, role: s.ClasslistRoleDisplayName })), quizzes: [] })) }, { "X-LOCKqz-Teacher": "admin-key" });
// Al has LOCKqz installed (FBE 437 then has 1 student missing; ECON 203 none installed).
await api("/register", { device_id: "mac-al01", key: "a".repeat(64), student: "al@usc.edu", platform: "mac" });

// ---- Brightspace tab running the real sync.js (a DOM that understands the panel's markup) ----
const OPENER = { closed: false, msgs: [], postMessage(m) { this.msgs.push(m); } };
function syncTab() {
  const boxes = [];
  const newBox = () => {
    const els = {};
    const stub = (k, ds = {}) => (els[k] = els[k] || { textContent: "", style: {}, dataset: ds, disabled: false, checked: false, onclick: null, onchange: null });
    const quizEls = h => [...h.matchAll(/data-ou="(\d+)" data-qi="(\d+)"(\s*checked)?/g)].map(x => { const k = "cb:" + x[2], fresh = !els[k], e = stub(k, { ou: x[1], qi: x[2] }); if (fresh) e.checked = !!x[3]; return e; });
    const B = { innerHTML: "",
      querySelector(sel) { const m = sel.match(/\[data-(\w+)="([^"]+)"\]/); if (!m || !this.innerHTML.includes(`data-${m[1]}="${m[2]}"`)) return null;
        return m[1] === "cls" ? stub("cls:" + m[2], { cls: m[2] }) : stub(m[1] + ":" + m[2], { [m[1]]: m[2] }); },
      querySelectorAll(sel) {
        let m = sel.match(/^input\[data-ou="(\d+)"\]\[data-qi\]$/); if (m) return quizEls(this.innerHTML).filter(e => e.dataset.ou === m[1]);
        if (sel === "input[data-cls]") return [...this.innerHTML.matchAll(/data-cls="(\d+)"/g)].map(x => stub("cls:" + x[1], { cls: x[1] }));
        if (sel.startsWith("input")) return quizEls(this.innerHTML);
        if (sel.startsWith("button[data-gate]")) return [...this.innerHTML.matchAll(/data-gate="([^"]+)"/g)].map(x => stub("gate:" + x[1], { gate: x[1] }));
        return [];
      } };
    const box = { style: {}, innerHTML: "", id: "", dataset: {}, els, B, appended: false, removed: false,
      querySelector: s => s === "#lqz-b" ? B : s === "#lqz-x" ? { onclick: null } : null, remove() { box.removed = true; }, addEventListener() {} };
    boxes.push(box); return box;
  };
  const document = { getElementById: () => boxes.find(b => b.appended && !b.removed) || null, createElement: newBox,
    body: { appendChild(b) { b.appended = true; }, contains: b => b.appended && !b.removed }, currentScript: { src: `${ORIGIN}/sync.js?k=${KEY}` } };
  const window = { opener: OPENER, addEventListener() {}, open: () => null };
  const ctx = { window, document, location: { pathname: "/d2l/home/1001", host: "usc.brightspace.com" }, localStorage: { getItem: () => null, setItem() {} },
    fetch: (url, opt) => String(url).startsWith(API) ? fetchApi(url, opt) : brightspace(url, opt),
    setInterval: () => 1, clearInterval() {}, confirm: () => true, alert: m => { t.alerts.push(m); }, URL, Request, Response, console, setTimeout };
  vm.createContext(ctx);
  const t = { alerts: [],
    run: async () => { const b = boxes.find(x => x.appended && !x.removed); if (b) b.removed = true;   // a fresh Sync (bookmark click)
      await vm.runInContext(SYNC_SRC, ctx); await idle(); },
    box: () => boxes[boxes.length - 1], html: () => decode(t.box().B.innerHTML),
    el: k => t.box().els[k],
    flip: async (k, v) => { const e = t.el(k); e.checked = v; await e.onchange(); await idle(); },
  };
  return t;
}
// Panel view: classes in order, each with its switch state, mail link, quiz switches.
function panelView(t) {
  const h = t.html(), out = [];
  const parts = h.split(/<div style="display:flex;align-items:center;gap:12px;margin:16px 0 6px">/).slice(1);
  for (const p of parts) {
    const name = (p.match(/^<span[^>]*font-weight:700">([^<]*)<\/span>/) || [])[1];
    const ou = (p.match(/data-cls="(\d+)"/) || [])[1];
    out.push({ ou, name, mail: /class="lqmail"[^>]*>Send email<\/a>/.test(p), mailHref: (p.match(/class="lqmail" data-ou="\d+" href="([^"]+)"/) || [])[1] || "",
      on: !!(t.el("cls:" + ou) || {}).checked, quizzes: [...p.matchAll(/data-ou="\d+" data-qi="(\d+)"/g)].map(x => x[1]),
      qon: Object.fromEntries([...p.matchAll(/data-ou="\d+" data-qi="(\d+)"/g)].map(x => [x[1], !!(t.el("cb:" + x[1]) || {}).checked])), past: /<summary>(\d+) past<\/summary>/.test(p) ? Number(p.match(/<summary>(\d+) past/)[1]) : 0 });
  }
  return out;
}

// ---- the dashboard (fake DOM, real API) ----
function dashTab() {
  const els = {};
  const mk = id => ({ id, innerHTML: "", textContent: "", value: "", style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeAttribute() {}, contains() { return false; }, querySelector: () => null, querySelectorAll: () => [],
    insertAdjacentHTML(pos, h) { this.innerHTML = pos === "afterbegin" ? h + this.innerHTML : this.innerHTML + h; } });
  const el = id => (els[id] = els[id] || mk(id));
  const loc = { hash: "", search: "", pathname: "/", origin: ORIGIN, reload() {} };
  const ls = new Map([["lockqz_token", PROF]]);
  const ctx = { document: { getElementById: el, querySelector: s => el("qs:" + s), querySelectorAll: () => [], addEventListener() {}, activeElement: null, visibilityState: "visible" },
    window: { addEventListener() {} }, location: loc, history: { replaceState() {} },
    localStorage: { getItem: k => (ls.has(k) ? ls.get(k) : /^lockqz_welcome_/.test(k) ? "1" : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) },
    fetch: (u, o) => fetchApi(ORIGIN + u, o), alert: () => {}, prompt: () => null, confirm: () => true, navigator: { clipboard: { writeText: async () => {} } },
    setInterval: () => 1, clearInterval() {}, URLSearchParams, console, setTimeout };
  vm.createContext(ctx); vm.runInContext(DASH_SRC, ctx);
  const d = { run: c => vm.runInContext(c, ctx), app: () => decode(el("app").innerHTML),
    go: async h => { loc.hash = h; await d.run("route()"); await idle(); },
    reload: async () => { await d.run("refresh().then(route)"); await idle(); } };
  return d;
}
const dashView = d => d.run(`BS.courses.map(c => { const s = classStats(c); return { ou: c.ou, name: cname(c), on: s.on, quizzes: s.cur.map(q => String(q.qi)), qon: Object.fromEntries(s.cur.map(q => [String(q.qi), !!q.password])), past: c.quizzes.length - s.cur.length }; })`);
const homeCards = d => d.app().split('<article class="card cls').slice(1);

function same(label, t, d) {
  const P = panelView(t), D = JSON.parse(JSON.stringify(dashView(d)));
  check(`${label}: same classes in the same order`, JSON.stringify(P.map(x => [x.ou, x.name])) === JSON.stringify(D.map(x => [x.ou, x.name])), JSON.stringify({ panel: P.map(x => x.name), dash: D.map(x => x.name) }));
  check(`${label}: same on/off for every class`, JSON.stringify(P.map(x => x.on)) === JSON.stringify(D.map(x => x.on)), JSON.stringify({ panel: P.map(x => [x.ou, x.on]), dash: D.map(x => [x.ou, x.on]) }));
  check(`${label}: same exams with switches, same on/off, same past count`, JSON.stringify(P.map(x => [x.quizzes.slice().sort(), x.qon, x.past])) === JSON.stringify(D.map(x => [x.quizzes.slice().sort(), x.qon, x.past])),
    JSON.stringify({ panel: P.map(x => [x.quizzes, x.qon, x.past]), dash: D.map(x => [x.quizzes, x.qon, x.past]) }));
  return { P, D };
}

console.log("P1 first Sync: 4 classes in Brightspace, every exam protected");
const T = syncTab(); await T.run();
let D = dashTab(); await idle();
let r = same("after the first Sync", T, D);
check("4 classes listed", r.P.length === 4 && r.D.length === 4, r.P.length + "/" + r.D.length);
check("names cut the same way (term prefix gone)", !r.P.some(x => /^\d+_/.test(x.name)) && r.P.some(x => x.name === "Recession Economics"), r.P.map(x => x.name).join(" | "));

console.log("P1b a class ends in Brightspace -> it leaves BOTH screens");
C[1004].end = new Date(Date.now() - 30 * 86400000).toISOString();
await T.run(); await D.reload();
r = same("after the class ended", T, D);
check("ACCT 410 gone from the panel", !r.P.some(x => x.ou === "1004"));
check("ACCT 410 gone from the dashboard", !r.D.some(x => x.ou === "1004"), JSON.stringify(r.D.map(x => x.ou)));

console.log("P2 a class switch and a Send email button on EVERY class, on both screens");
check("panel: a class switch on every class", r.P.every(x => x.ou), JSON.stringify(r.P));
check("panel: Send email on every class", r.P.every(x => x.mail), JSON.stringify(r.P.map(x => [x.name, x.mail])));
check("panel email carries the class's students and the install link", /bcc=.*al%40usc\.edu/.test(r.P.find(x => x.ou === "1001").mailHref) && /lockqz\.pages\.dev/.test(decodeURIComponent(r.P.find(x => x.ou === "1001").mailHref)));
check("panel email never includes the professor", !/prof%40usc\.edu/.test(r.P.map(x => x.mailHref).join("")));
let cards = homeCards(D);
check("dashboard home: one card per class", cards.length === 3, cards.length);
check("dashboard home: a class switch on every card (also the class with no exams)", cards.every(c => /aria-label="LOCKqz on for this class"/.test(c)), cards.map(c => /aria-label="LOCKqz on for this class"/.test(c)).join());
check("dashboard home: an email button on every card (missing students or not)", cards.every(c => /class="btn[^"]*mailbtn"[^>]*onclick="emailClass\(/.test(c)), cards.map(c => /mailbtn/.test(c)).join());
const fbe = cards.find(c => /Recession Economics/.test(c));
check("FBE 437: the email goes to the students who still need LOCKqz (kind missing), not the whole class", /data-kind="missing"/.test(fbe), fbe.match(/<button[^>]*mailbtn[^>]*>/)?.[0]);
for (const ou of ["1001", "1002", "1003"]) { await D.go("#class/" + ou); const a = D.app();
  check(`dashboard class page ${ou}: class switch + email button`, /aria-label="LOCKqz on for this class"/.test(a) && /mailbtn/.test(a)); }
await D.go("");

console.log("P3 exams: hidden quiz has a switch on both; ended quiz is 'past' on both");
const pf = r.P.find(x => x.ou === "1001"), df = r.D.find(x => x.ou === "1001");
check("panel lists Midterm + Hidden quiz with switches, Old quiz as past", JSON.stringify(pf.quizzes.slice().sort()) === '["11","12"]' && pf.past === 1, JSON.stringify(pf));
check("dashboard the same", JSON.stringify(df.quizzes.slice().sort()) === '["11","12"]' && df.past === 1, JSON.stringify(df));
check("every class on, in both", r.P.every(x => x.on) && r.D.every(x => x.on));

console.log("P4 dashboard turns ECON 203 off -> panel shows it off after the next Sync, password removed");
await D.run('setClass("1003", false)'); await idle();
check("dashboard: ECON 203 off", D.run('classStats(BS.courses.find(c=>c.ou==="1003")).on') === false);
await T.run(); await D.reload();
r = same("after the dashboard switch", T, D);
check("panel: ECON 203 class switch off", r.P.find(x => x.ou === "1003").on === false);
check("panel: its Final switch off", r.P.find(x => x.ou === "1003").qon["31"] === false);
check("Brightspace: LOCKqz's password removed from Final", !pwOf(1003, 31), pwOf(1003, 31));
check("other classes untouched (still on in both)", r.P.filter(x => x.ou !== "1003").every(x => x.on) && r.D.filter(x => x.ou !== "1003").every(x => x.on));

console.log("P5 panel turns BUAD 104 (no exams) off -> off on the dashboard; a new quiz there stays unprotected");
OPENER.msgs.length = 0;
await T.flip("cls:1002", false);
check("panel told the dashboard to redraw", OPENER.msgs.some(m => m.lqz === "changed"), JSON.stringify(OPENER.msgs));
await D.reload();
check("dashboard: BUAD 104 off", JSON.parse(JSON.stringify(dashView(D))).find(x => x.ou === "1002").on === false);
C[1002].qs.push(quiz(21, "Quiz 1"));
await T.run(); await D.reload();
r = same("after a new quiz in a class turned off", T, D);
check("new quiz NOT protected (class is off)", !pwOf(1002, 21) && r.D.find(x => x.ou === "1002").qon["21"] === false, pwOf(1002, 21));
check("BUAD 104 still off on both", r.P.find(x => x.ou === "1002").on === false && r.D.find(x => x.ou === "1002").on === false);

console.log("P6 panel turns BUAD 104 back on -> on in both, quiz protected in Brightspace");
OPENER.msgs.length = 0;
await T.flip("cls:1002", true);
await D.reload();
check("Quiz 1 now has a LOCKqz password", /^LQ-/.test(pwOf(1002, 21) || ""), pwOf(1002, 21));
check("panel told the dashboard", OPENER.msgs.some(m => m.lqz === "changed"));
await T.run();
r = same("after turning it back on", T, D);
check("BUAD 104 on in both", r.P.find(x => x.ou === "1002").on && r.D.find(x => x.ou === "1002").on);

console.log("P7 one exam off on the panel -> its class shows off on both (same rule)");
await T.flip("cb:11", false); await D.reload();
check("dashboard: FBE 437 off (an exam is unprotected)", JSON.parse(JSON.stringify(dashView(D))).find(x => x.ou === "1001").on === false);
check("panel: FBE 437 switch off", T.el("cls:1001").checked === false);
await T.run(); same("after one exam off", T, D);
await D.run('setAll(true)'); await idle(); await T.run(); await D.reload();
r = same("after All on (dashboard)", T, D);
check("All on: every class on in both", r.P.every(x => x.on) && r.D.every(x => x.on), JSON.stringify(r.P.map(x => x.on)));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
