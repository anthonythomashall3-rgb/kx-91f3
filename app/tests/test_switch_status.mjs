// An exam's switch on the dashboard never just waits (27 Nov 2026). Real API on in-memory SQLite (schema.sql + every
// migration), the dashboard's own row logic, sync.js's order:
//   K1 bs_quizzes.sync_err exists (schema.sql and migrate_050)
//   K2 /sync-state (the Sync's quick first step, Sync key): only what Brightspace does not have yet (an exam switched
//      on whose LOCKqz password is not confirmed there; a password waiting to come off), never another class's
//   K3 Brightspace refuses (/sync-result "error"): kept on the exam, shown by /bs; taken -> forgotten; a new switch
//      change -> forgotten; "cleared" -> forgotten
//   K4 the row's words: Protected / Not protected / Saving… / Brightspace refused (why) / 1 click left
//   K5 sync.js: asked for, it puts the changes in before reading Brightspace; reports only what Brightspace took
//   K6 dashboard: a switch says Saving… at once; a sync that ends redraws; a hidden tab reads again when shown; the
//      extension here sends a waiting change by itself, once; one re-sync for a change a Sync was already past
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-switch-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

const sqlite = new DatabaseSync(":memory:");
const SCHEMA = readFileSync(join(CF, "schema.sql"), "utf8");
sqlite.exec(SCHEMA);
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch {} }
const db = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
  const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
    first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }), run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } }; return o; },
  async batch(sts) { for (const s of sts) s._run(); } };
const env = { DB: db, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", LIVE_CACHE_MS: "0", PAID_CACHE_MS: "0" };
const API = "https://lockqz.pages.dev/api";
let ip = 0;
async function api(path, body, headers = {}) {
  const res = await onRequest({ request: new Request(API + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.9.0." + (++ip % 250), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
  return { status: res.status, data: await res.json().catch(() => null) };
}

console.log("K1 the column");
const cols = sqlite.prepare("PRAGMA table_info(bs_quizzes)").all().map(c => c.name);
check("bs_quizzes.sync_err after the migrations", cols.includes("sync_err"), cols.join(","));
const fresh = new DatabaseSync(":memory:"); fresh.exec(SCHEMA);
check("schema.sql alone has it too", fresh.prepare("PRAGMA table_info(bs_quizzes)").all().some(c => c.name === "sync_err"));
check("migrate_050 adds it", /ALTER TABLE bs_quizzes ADD COLUMN sync_err TEXT/.test(readFileSync(join(CF, "migrate_050_sync_err.sql"), "utf8")));

// ---- a verified, paid professor; their class on a trusted (admin-synced) roster; another professor's class ----
const OU = "55501", OU2 = "55502";
const cl = [{ id: "7000", name: "Prof", email: "prof@usc.edu", role: "Instructor" }, { id: "7001", name: "Al", email: "al@usc.edu", role: "Student" }];
const cl2 = [{ id: "7100", name: "Other", email: "other@usc.edu", role: "Instructor" }];
await api("/signup", { email: "admin@usc.edu", password: "adminpass1" });
const PROF = (await api("/signup", { email: "prof@usc.edu", password: "profpass1", name: "Prof" })).data.token;
sqlite.prepare("UPDATE teachers SET verified=1, active_until='2099-12-31' WHERE email='prof@usc.edu'").run();
await api("/sync", { courses: [{ ou: OU, name: "ECON 203", role: "Instructor", classlist: cl, quizzes: [] }, { ou: OU2, name: "FIN 101", role: "Instructor", classlist: cl2, quizzes: [] }] }, { "X-LOCKqz-Teacher": "admin-key" });
const KEY = (await api("/synckey", undefined, { "X-LOCKqz-Teacher": PROF })).data.key;
const SK = { "X-LOCKqz-Sync": KEY };
const Q = (qi, extra = {}) => ({ qi, name: "Exam " + qi, active: true, start: "2099-01-01T10:00:00Z", end: "2099-01-01T12:00:00Z", due: null, has_password: false, lq_password: false, ...extra });
// The professor's own Sync: four exams (auto-protect turns them on)
let r = await api("/sync", { host: "brightspace.usc.edu", whoami: { id: "7000", name: "Prof" }, courses: [{ ou: OU, name: "ECON 203", role: "Instructor", classlist: cl, quizzes: [Q("1"), Q("2"), Q("3"), Q("4")] }] }, SK);
check("the professor's Sync answers with 4 exams to protect", r.status === 200 && (r.data.protect || []).length === 4, JSON.stringify(r.data).slice(0, 300));
await api("/sync-result", { results: ["1", "2", "3", "4"].map(qi => ({ ou: OU, qi, status: "set" })) }, SK);
// Exam 2: LOCKqz's password not confirmed in Brightspace (someone changed it); exam 3 switched off (its password must come off)
sqlite.prepare("UPDATE bs_quizzes SET bs_password_is_ours=0 WHERE ou=? AND qi='2'").run(OU);
r = await api("/protect", { ou: OU, qi: "3", on: false }, { "X-LOCKqz-Teacher": PROF });
check("exam 3 switched off", r.status === 200 && r.data.on === false, JSON.stringify(r.data));
// Another professor's class with a protected exam (the admin's)
sqlite.prepare("INSERT INTO quizzes (quiz_id,title,password,created_at,qi,teacher_id,lock_id,ou) VALUES ('zz','X','LQ-OTHER234','2026-11-27',?, 'admin', ?, ?)").run("9", OU2 + "-9", OU2);
sqlite.prepare("INSERT INTO bs_quizzes (ou,qi,name,bs_has_password,bs_password_is_ours) VALUES (?,?,?,1,0)").run(OU2, "9", "X");

console.log("K2 /sync-state: only what Brightspace does not have yet");
r = await api("/sync-state", { host: "brightspace.usc.edu" }, SK);
const pq = (r.data.protect || []).map(x => String(x.qi)), cq = (r.data.clear || []).map(x => String(x.qi));
check("answers with the Sync key (quick: true)", r.status === 200 && r.data.quick === true, JSON.stringify(r.data).slice(0, 200));
check("exam 2 (on, not confirmed in Brightspace) is to protect, with its password", JSON.stringify(pq) === '["2"]' && /^LQ-/.test(r.data.protect[0].password || ""), JSON.stringify(r.data.protect));
check("exams 1 and 4 (Brightspace has them) are not sent", !pq.includes("1") && !pq.includes("4"));
check("exam 3's password is to come off", JSON.stringify(cq) === '["3"]', JSON.stringify(r.data.clear));
check("another professor's class is never sent", !pq.includes("9") && !JSON.stringify(r.data).includes("LQ-OTHER234"));
r = await api("/sync-state", { host: "other.brightspace.com" }, SK);
check("another school's Brightspace: refused like /sync", r.status === 403 && r.data.reason === "other_school", JSON.stringify(r.data));
r = await api("/sync-state", {}, {});
check("no key: refused", r.status === 401 || r.status === 403, r.status);

console.log("K3 Brightspace refuses: kept, shown, forgotten when it takes the change");
const errOf = qi => sqlite.prepare("SELECT sync_err FROM bs_quizzes WHERE ou=? AND qi=?").get(OU, qi).sync_err;
await api("/sync-result", { results: [{ ou: OU, qi: "2", status: "error", msg: "Brightspace 403: Not Authorized" }] }, SK);
check("kept on the exam", errOf("2") === "Brightspace 403: Not Authorized", errOf("2"));
check("and in the Activity log as before", Number(sqlite.prepare("SELECT COUNT(*) n FROM events WHERE event='brightspace_sync_error' AND quiz_id=?").get(OU + "-2").n) === 1);
let bs = (await api("/bs", undefined, { "X-LOCKqz-Teacher": PROF })).data;
const q2 = () => bs.courses.find(c => String(c.ou) === OU).quizzes.find(q => String(q.qi) === "2");
check("/bs shows it", q2() && q2().sync_err === "Brightspace 403: Not Authorized", JSON.stringify(q2()));
const writes = () => Number(sqlite.prepare("SELECT total_changes() AS n").get().n);
let w0 = writes(); await api("/sync-result", { results: [{ ou: OU, qi: "2", status: "error", msg: "Brightspace 403: Not Authorized" }] }, SK);
check("the same answer again: the exam row is not rewritten (only the log line)", writes() - w0 <= 1, writes() - w0);
await api("/sync-result", { results: [{ ou: OU, qi: "2", status: "set" }] }, SK);
check("Brightspace takes it: forgotten (and confirmed)", errOf("2") == null && Number(sqlite.prepare("SELECT bs_password_is_ours o FROM bs_quizzes WHERE ou=? AND qi='2'").get(OU).o) === 1, String(errOf("2")));
await api("/sync-result", { results: [{ ou: OU, qi: "2", status: "error", msg: "password did not stick" }] }, SK);
await api("/sync-result", { results: [{ ou: OU, qi: "2", status: "already" }] }, SK);
check("'already' (it was there): forgotten too", errOf("2") == null, String(errOf("2")));
await api("/sync-result", { results: [{ ou: OU, qi: "2", status: "error", msg: "Brightspace 500: x" }] }, SK);
r = await api("/protect", { ou: OU, qi: "2", on: false }, { "X-LOCKqz-Teacher": PROF });
check("a new switch change: forgotten", r.status === 200 && errOf("2") == null, String(errOf("2")));
await api("/sync-result", { results: [{ ou: OU, qi: "3", status: "error", msg: "Brightspace 403: no" }] }, SK);
await api("/sync-result", { results: [{ ou: OU, qi: "3", status: "cleared" }] }, SK);
check("'cleared': forgotten, and nothing left to take off", errOf("3") == null && !sqlite.prepare("SELECT 1 FROM pending_clear WHERE ou=? AND qi='3'").get(OU), String(errOf("3")));
w0 = writes(); await api("/sync-result", { results: [{ ou: OU, qi: "1", status: "already" }] }, SK);
check("an exam already confirmed: no write at all", writes() === w0, writes() - w0);
r = await api("/sync-result", { results: [{ ou: OU2, qi: "9", status: "error", msg: "x" }] }, SK);
check("another professor's exam: not touched", r.status === 200 && sqlite.prepare("SELECT sync_err FROM bs_quizzes WHERE ou=? AND qi='9'").get(OU2).sync_err == null);

console.log("K4 the row's words");
const DASH = readFileSync(join(CF, "public", "dashboard.html"), "utf8");
const grab = (from, to) => DASH.slice(DASH.indexOf(from), DASH.indexOf(to, DASH.indexOf(from)));
const pend = q => q.password ? !q.bs_password_is_ours : !!q.bs_password_is_ours;
let SY = false;
const mk = new Function("pend", "syncing", grab("function refusedWhy(", "\nfunction rowSt(") + grab("function rowSt(", "\nconst stHtml") + "; return [rowSt, refusedWhy];");
const [rowSt, refusedWhy] = mk(pend, () => SY);
const W = q => rowSt(q)[1];
check("on and in Brightspace: Protected", W({ password: "LQ-A", bs_password_is_ours: 1 }) === "Protected");
check("off and not in Brightspace: Not protected", W({ password: null, bs_password_is_ours: 0 }) === "Not protected");
SY = true;
check("a change on its way: Saving… (on or off)", W({ password: "LQ-A", bs_password_is_ours: 0 }) === "Saving…" && W({ password: null, bs_password_is_ours: 1 }) === "Saving…" && rowSt({ password: "LQ-A", bs_password_is_ours: 0 })[0] === "");
check("Saving… even with an earlier refusal (it is being tried again)", W({ password: "LQ-A", bs_password_is_ours: 0, sync_err: "Brightspace 403: x" }) === "Saving…");
check("Protected stays Protected while a sync runs", W({ password: "LQ-A", bs_password_is_ours: 1 }) === "Protected");
SY = false;
const ref = rowSt({ password: "LQ-A", bs_password_is_ours: 0, sync_err: "Brightspace 403: Not Authorized" });
check("refused: 'Brightspace refused', warn, why on hover", ref[1] === "Brightspace refused" && ref[0] === "warn" && /did not let your account change this exam/.test(ref[2]), JSON.stringify(ref));
check("why: did not stick / 404 / other", /did not keep LOCKqz's password/.test(refusedWhy("password did not stick")) && /could not find this exam/.test(refusedWhy("Brightspace answered 404 for /x")) && /did not take the change: Brightspace 500/.test(refusedWhy("Brightspace 500: x")));
check("no sync from here: '… · 1 click left'", W({ password: "LQ-A", bs_password_is_ours: 0 }) === "On · 1 click left" && W({ password: null, bs_password_is_ours: 1 }) === "Off · 1 click left");
check("no 'Waiting for Brightspace' anywhere on the dashboard", !DASH.includes("Waiting for Brightspace"));

console.log("K5 sync.js: the quick first step");
const SYNC = readFileSync(join(CF, "public", "sync.js"), "utf8");
const at = s => SYNC.indexOf(s);
check("only when asked for, right after Brightspace's versions, before the course read", at("if (ASKED) {") > at('var LE = ver("le")') && at("if (ASKED) {") < at('"/enrollments/myenrollments/'), [at("if (ASKED) {"), at('var LE = ver("le")')].join(" "));
check("asks /sync-state with this Brightspace's host", /lqres\("\/sync-state", \{ host: location\.host \}\)/.test(SYNC));
check("the password helpers are defined before it", at("async function protect(") < at("if (ASKED) {") && at("async function release(") < at("if (ASKED) {") && at("var origOf = function") < at("if (ASKED) {") && at("var PW = {};") < at("if (ASKED) {"));
const quick = SYNC.slice(at("if (ASKED) {"), at('var me = await get("/d2l/api/lp/"'));
check("reports only what Brightspace took (an error is left to the full Sync), stops on a lost Brightspace session", /catch \(e\) \{ if \(e\.expired\) throw e; \}/.test(quick) && !/status: "error"/.test(quick));
check("a gated exam is left to its gate", /Number\(x\.gated\) !== 1/.test(quick));
check("tells the dashboard at once ('changed'), never 'synced' (that closes the extension's Sync tab)", /tell\(\{ lqz: "changed", quick: true \}\)/.test(quick) && !/lqz: "synced"/.test(quick));
check("step 3 still fills the passwords from /sync's answer", /\/\/ ---- 3\. passwords into \/ out of Brightspace ----\n\s+\(state\.protect \|\| \[\]\)\.forEach\(function \(p\) \{ PW\[String\(p\.qi\)\] = p\.password; \}\);/.test(SYNC));
check("one PW and one origOf (none declared twice)", SYNC.split("var PW = {}").length === 2 && SYNC.split("var origOf = function").length === 2);
check("sync.js parses", (() => { try { new Function(SYNC); return true; } catch { return false; } })());

console.log("K6 dashboard: when it says Saving…, when it redraws");
check("a switch: Saving… before the first redraw (pushSync before route)", /async function after\(results\)\{ await refresh\(\); pushSync\(\); route\(\);/.test(DASH));
check("Saving… only when a sync can run from here (the extension, or an open Sync tab)", /PUSHWAIT = canSync\(\);/.test(DASH) && /const canSync = \(\) => \(BSWIN && !BSWIN\.closed\) \|\| EXT\(\);/.test(DASH));
check("every end of a sync redraws: synced, failed, busy, no answer", (DASH.match(/syncMsg\("Brightspace didn't answer[^)]*\); repaint\(\);/g) || []).length === 2 && /Sync failed: " \+ String\(m\.error \|\| ""\)\.slice\(0, 160\)\);\n\s+repaint\(\);/.test(DASH));
check("a sync that ended while the tab was hidden: read again when shown", /else if \(ME\) STALE = true;/.test(DASH) && /if\(STALE \|\| Date\.now\(\)-LAST > 900000\) \{ STALE = false; autoRefresh\(\); \}/.test(DASH));
check("the extension here: a change still waiting goes in by itself, once (first screen and when the extension says hello)", /applyAll\(R\); route\(\); autoPush\(\);/.test(DASH) && /route\(\); autoPush\(\); return; \}/.test(DASH) && /if \(AUTOPUSHED \|\|/.test(DASH));
check("one re-sync by itself for a change a Sync was already past (never for a refused exam)", /if \(asked && RESYNC < 1 && canSync\(\) && waitingAny\(\)\) \{ RESYNC\+\+; syncNow\(\);/.test(DASH));
const wa = new Function("pend", "BS", grab("const pendingSync = ", "\n// The exam switch's words") + "; return [pendingSync, waitingAny];");
const hid = { courses: [{ roster_hidden: true, quizzes: [{ password: null, bs_password_is_ours: 1 }] }] };
check("a class someone else instructs is never waiting on this account (no note, no sync by itself)", !wa(pend, hid)[0]() && !wa(pend, hid)[1]());
const mine = { courses: [{ quizzes: [{ password: "LQ-A", bs_password_is_ours: 0, sync_err: "Brightspace 403: x" }] }] };
check("a refused exam: the note stays (Sync now to retry), no sync by itself", wa(pend, mine)[0]() && !wa(pend, mine)[1]());
check("'One more click' hidden while a sync runs; on the class page too, with its sync line", /pendnote\$\{syncing\(\) \? " hide" : ""\}/.test(DASH) && /c\.quizzes\.some\(pend\) \? PENDNOTE\(true, ou\)/.test(DASH));
check("the home headline counts an exam being saved as on", /setN = mine\.reduce\(\(n,s\)=>n\+s\.set\.length\+\(sy\?s\.waiting:0\),0\), waitN = sy \? 0 :/.test(DASH));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
