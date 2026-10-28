// "NO status shown anywhere may be false" (27 Oct 2026 audit). Real API on an in-memory database, the
// dashboard / extension / agent sources as files. Same harness as test_protected_history.mjs.
//   T1 ready = what /password would admit: live device (not revoked, seen <= 30 days, confirmed email) + fee paid;
//      installed but unpaid is its own state, never ready.
//   T2 'missing' emails + 48 h reminders go to everyone not ready; the unpaid get the pay line, signed.
//   T3 /ext-status counts only exams whose password Brightspace confirmed; the rest are "waiting".
//   T4 T-70 check-in: "open Chrome", students wait until it is open, never "can still open it either way".
//   T5 lq_password:false from Brightspace -> ours 0, unprot_at stamped, dashboard row not "Protected".
//   T6 /verify status says paid; the agents wait for verified + paid before "LOCKqz is ready".
//   T7 dashboard / extension sources: labels only on evidence.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, createHmac, createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url)), APP = join(HERE, ".."), CF = join(APP, "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-truth-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);

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
const env = { DB: d1(sqlite), TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", REQUIRE_GATE: "1", LIVE_CACHE_MS: "0", PAID_CACHE_MS: "0", PAY_SECRET: "x".repeat(24),
  STUDENT_FEE_FROM: "2000-01-01", FEE_EXEMPT: "al@usc.edu", MAIL_SINK: async m => { MAILS.push(m); return true; } };
const API = "https://lockqz.pages.dev/api";
const sign = (key, path, ts, body) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");
async function api(path, body, headers = {}, e = env, dev = null) {
  const raw = body === undefined ? undefined : JSON.stringify(body), h = { "Content-Type": "application/json", ...headers };
  if (dev) { const ts = String(Math.floor(Date.now() / 1000)); h["X-LOCKqz-Device"] = dev.id; h["X-LOCKqz-Time"] = ts; h["X-LOCKqz-Sig"] = sign(dev.key, "/api" + path, ts, raw); }
  const res = await onRequest({ request: new Request(API + path, { method: body === undefined ? "GET" : "POST", headers: h, body: raw }), env: e });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const rcpts = m => (Array.isArray(m.to) ? m.to : [m.to]);

await api("/signup", { email: "admin@usc.edu", password: "adminpass1" });
const PROF = (await api("/signup", { email: "prof@usc.edu", password: "profpass1", name: "Duke Bristow" })).data.token;
sqlite.prepare("UPDATE teachers SET verified=1, active_until='2099-12-31', bs_user_id='4000' WHERE email='prof@usc.edu'").run();
const KEY = (await api("/synckey", undefined, { "X-LOCKqz-Teacher": PROF })).data.key;
const T = { "X-LOCKqz-Teacher": PROF }, S = { "X-LOCKqz-Sync": KEY };
const OU = 55501, inH = h => new Date(Date.now() + h * 3600e3).toISOString();
const names = ["al", "bo", "cy", "di", "ed", "fy"];
const classlist = [{ id: "4000", name: "Duke Bristow", email: "prof@usc.edu", role: "Instructor" }, ...names.map((n, i) => ({ id: String(4001 + i), name: n.toUpperCase(), email: n + "@usc.edu", role: "Student" }))];
const doSync = q => api("/sync", { host: "brightspace.usc.edu", whoami: { id: "4000", name: "Duke Bristow" }, courses: [{ ou: String(OU), name: "20263_FBE-437 Ent Fin", code: "FBE-437", role: "Instructor", classlist, quizzes: q }] }, S);
const Q = (over = {}) => ({ qi: 501, name: "Exam One", active: true, start: inH(240), end: inH(242), has_password: false, lq_password: false, ...over });
await doSync([Q()]);

console.log("T1 ready = /password would admit (live, confirmed device + fee paid)");
const ago = d => new Date(Date.now() - d * 864e5).toISOString();
const dev = (id, who, { ver = 1, rev = 0, seen = ago(0) } = {}) => sqlite.prepare("INSERT INTO devices (device_id,student,platform,student_verified,revoked,installed_at,last_seen) VALUES (?,?,?,?,?,?,?)").run(id, who, "mac-15", ver, rev, ago(60), seen);
dev("d-al", "al@usc.edu");                    // fresh, confirmed, fee exempt -> ready
dev("d-bo", "bo@usc.edu", { rev: 1 });         // revoked
dev("d-cy", "cy@usc.edu", { seen: ago(40) });  // not seen for 40 days
dev("d-di", "di@usc.edu", { ver: 0 });         // email never confirmed
dev("d-ed", "ed@usc.edu");                    // fresh, confirmed, fee NOT paid
let bs = (await api("/bs", undefined, T)).data, st = Object.fromEntries(bs.courses[0].students.map(s => [s.email, s]));
check("al: ready", st["al@usc.edu"].ready === true && st["al@usc.edu"].installed === true, JSON.stringify(st["al@usc.edu"]));
check("bo (revoked device): not installed, not ready", st["bo@usc.edu"].installed === false && st["bo@usc.edu"].ready === false);
check("cy (last seen 40 days ago): not installed, not ready", st["cy@usc.edu"].installed === false && st["cy@usc.edu"].ready === false);
check("di (unconfirmed email): not installed, not ready", st["di@usc.edu"].installed === false && st["di@usc.edu"].ready === false);
check("ed (installed, fee unpaid): installed, paid false, NOT ready", st["ed@usc.edu"].installed === true && st["ed@usc.edu"].paid === false && st["ed@usc.edu"].ready === false, JSON.stringify(st["ed@usc.edu"]));
check("fy (no device): not ready", st["fy@usc.edu"].ready === false);

console.log("T2 'missing' email + reminders: everyone not ready; the unpaid get the pay line");
const PAYLINE = "LOCKqz is installed but your semester fee is not paid — pay at https://lockqz.pages.dev before the exam.";
MAILS.length = 0;
let r = await api("/email/students", { ou: String(OU), kind: "missing" }, T);
// The professor sends it from their own mail app: a draft to bo, cy, di, ed, fy (everyone not ready, never al).
const toAll = (r.data && r.data.to || []).slice().sort().join();
check("kind missing -> a draft to bo, cy, di, ed, fy (never al); LOCKqz sends nothing itself", toAll === "bo@usc.edu,cy@usc.edu,di@usc.edu,ed@usc.edu,fy@usc.edu" && MAILS.length === 0, JSON.stringify(r.data) + " " + toAll);
const dt = (r.data && r.data.text) || "";
check("mixed class: the draft says 'not ready' (not 'not installed') and carries the pay line for the installed-but-unpaid", /not ready on your computer/.test(dt) && !/not installed on your computer/.test(dt) && /Already installed LOCKqz\? Then your semester fee is not paid/.test(dt), dt);
check("draft signed 'Respectfully,' + the professor", /Respectfully,\nProfessor Duke Bristow/.test(dt), dt);
check("the first exam named is a protected exam of this covered class", r.data && /Exam One/.test(r.data.subject), r.data && r.data.subject);
sqlite.prepare("UPDATE bs_quizzes SET start_date=?, end_date=? WHERE ou=? AND qi='501'").run(inH(40), inH(42), String(OU));
MAILS.length = 0;
r = await api("/cron", {}, { "X-LOCKqz-Pay": env.PAY_SECRET });
check("48 h reminder: 5 students, ed's copy has the pay line", r.data.exams.reminders === 5 && MAILS.some(m => rcpts(m).join() === "ed@usc.edu" && m.text.includes(PAYLINE)) && MAILS.flatMap(rcpts).length === 5, JSON.stringify(r.data) + JSON.stringify(MAILS.map(m => m.to)));
// An uncovered class (course turned off) gets no reminder even with a protected quiz row.
await api("/class", { ou: String(OU), on: false }, T);
sqlite.prepare("DELETE FROM mail_sent").run(); MAILS.length = 0;
r = await api("/cron", {}, { "X-LOCKqz-Pay": env.PAY_SECRET });
check("class turned off -> no reminder", MAILS.length === 0, JSON.stringify(MAILS.map(m => m.to)));
await api("/class", { ou: String(OU), on: true }, T);

console.log("T3 /ext-status: protected = confirmed in Brightspace; the rest waiting");
r = await api("/ext-status", undefined, S);
check("auto-protected but not yet set in Brightspace -> 0 protected, 1 waiting", r.data.exams === 0 && r.data.waiting === 1, JSON.stringify(r.data));
check("next exam: 1 of 6 ready, 1 installed but unpaid", r.data.next && r.data.next.total === 6 && r.data.next.ready === 1 && r.data.next.unpaid === 1, JSON.stringify(r.data.next));
await api("/sync-result", { results: [{ ou: String(OU), qi: "501", status: "set" }] }, S);
r = await api("/ext-status", undefined, S);
check("after Brightspace confirmed it -> 1 protected, 0 waiting", r.data.exams === 1 && r.data.waiting === 0, JSON.stringify(r.data));

console.log("T4 T-70 check-in with REQUIRE_GATE=1");
sqlite.prepare("UPDATE teachers SET ext_seen=? WHERE email='prof@usc.edu'").run(ago(7 / 24));
sqlite.prepare("UPDATE bs_quizzes SET start_date=?, end_date=? WHERE ou=? AND qi='501'").run(inH(1), inH(3), String(OU));
MAILS.length = 0; await api("/cron", {}, { "X-LOCKqz-Pay": env.PAY_SECRET });
const ck = MAILS.find(m => rcpts(m).includes("prof@usc.edu"));
check("subject: Exam One starts in about an hour — open Chrome", ck && ck.subject === "Exam One starts in about an hour — open Chrome", ck && ck.subject);
check("body: students wait until Chrome is open (never 'can still open it either way'); Respectfully, The LOCKqz Team", ck && /students wait at the start of the exam until you open it/.test(ck.text) && !/either way/.test(ck.text) && /Respectfully,\nThe LOCKqz Team/.test(ck.text), ck && JSON.stringify(ck.text));
check("no 'can still open the exam either way' under the gate", ck && !/either way/.test(ck.text + ck.html));

console.log("T5 lq_password:false is believed (not sticky)");
sqlite.prepare("UPDATE bs_quizzes SET start_date=?, end_date=? WHERE ou=? AND qi='501'").run(inH(240), inH(242), String(OU));
const row = () => sqlite.prepare("SELECT bs_password_is_ours AS ours, prot_at, unprot_at FROM bs_quizzes WHERE ou=? AND qi='501'").get(String(OU));
check("before: ours 1, prot_at set", Number(row().ours) === 1 && !!row().prot_at, JSON.stringify(row()));
await doSync([Q({ start: inH(240), end: inH(242), has_password: true, lq_password: false })]);   // someone typed their own password
check("Brightspace shows a password that is not LOCKqz's -> ours 0, unprot_at stamped", Number(row().ours) === 0 && !!row().unprot_at, JSON.stringify(row()));
await doSync([Q({ start: inH(240), end: inH(242), has_password: true })]);   // an old Sync tab (no lq_password): previous value kept
check("no lq_password field -> the stored value is kept", Number(row().ours) === 0, JSON.stringify(row()));
bs = (await api("/bs", undefined, T)).data;
const q501 = bs.courses[0].quizzes.find(q => String(q.qi) === "501");
const DASH = readFileSync(join(CF, "public", "dashboard.html"), "utf8");
const pend = q => q.password ? !q.bs_password_is_ours : !!q.bs_password_is_ours;
const rowLabel = q => { const on = !!q.password, p = pend(q); return on ? (p ? "Waiting for Brightspace" : "Protected") : (p ? "Off · 1 click left" : "Not protected"); };
check("dashboard row for it is not 'Protected'", q501 && !!q501.password && Number(q501.bs_password_is_ours) === 0 && !/^Protected/.test(rowLabel(q501)), JSON.stringify(q501));
check("dashboard row labels in the source match", DASH.includes(`\${on?(p?"Waiting for Brightspace":"Protected"):(p?"Off · 1 click left":"Not protected")}`));
await doSync([Q({ start: inH(240), end: inH(242), has_password: true, lq_password: true })]);
check("LOCKqz's password back -> ours 1, new prot_at, unprot_at cleared", Number(row().ours) === 1 && !!row().prot_at && !row().unprot_at, JSON.stringify(row()));
const SYNC = readFileSync(join(CF, "public", "sync.js"), "utf8");
check("sync.js fingerprint keeps lq_password (a changed password triggers a sync), drops has_password", /k === "has_password" \? undefined : v/.test(SYNC) && !/k === "lq_password"/.test(SYNC));

console.log("T6 /verify status: paid; the agents wait for verified + paid");
const reg = async id => { const key = randomBytes(32).toString("hex"); await api("/register", { device_id: id, key, platform: "mac-15" }); return { id, key }; };
const dA = await reg("mac-truth-a");
r = await api("/verify", { op: "status", device_id: dA.id }, {}, env, dA);
check("unconfirmed device -> verified false, paid false", r.status === 200 && r.data.verified === false && r.data.paid === false, JSON.stringify(r.data));
sqlite.prepare("UPDATE devices SET student='ed@usc.edu', student_verified=1 WHERE device_id=?").run(dA.id);
r = await api("/verify", { op: "status", device_id: dA.id }, {}, env, dA);
check("confirmed but unpaid -> verified true, paid false", r.data.verified === true && r.data.paid === false, JSON.stringify(r.data));
sqlite.prepare("UPDATE devices SET student='al@usc.edu' WHERE device_id=?").run(dA.id);
r = await api("/verify", { op: "status", device_id: dA.id }, {}, env, dA);
check("confirmed + paid (exempt) -> paid true", r.data.verified === true && r.data.paid === true, JSON.stringify(r.data));
sqlite.prepare("UPDATE devices SET revoked=1 WHERE device_id=?").run(dA.id);
r = await api("/verify", { op: "status", device_id: dA.id }, {}, env, dA);
check("revoked device -> refused (no status to call it ready)", r.status !== 200, r.status);
const mac = readFileSync(join(APP, "mac", "lockqz-agent.py"), "utf8"), win = readFileSync(join(APP, "windows", "lockqz-agent.ps1"), "utf8");
const macFn = mac.slice(mac.indexOf("def ready_notice"), mac.indexOf("def tick("));
check("Mac: 'ready' + flag only when status 200 + verified + paid; else 'Finish setup', no flag", /st\.get\("verified"\) is True and st\.get\("paid"\) is True/.test(macFn) && /if ok:[\s\S]*READY_FLAG/.test(macFn) && /SETUP_TEXT/.test(macFn) && /Finish setup before your exam: open https:\/\/lockqz\.pages\.dev/.test(mac));
check("Windows: Check-Ready asks /verify status; flag only in the ok branch", /function Check-Ready/.test(win) && /\$st\.verified -eq \$true\) -and \(\$st\.paid -eq \$true\)/.test(win) && /if \(\$ok\) \{\s*\$script:ReadyTold = \$true\s*try \{ Set-Content \$ReadyFile/.test(win) && /\{ Check-Ready \}/.test(win) && !/\{ Show-Ready \}/.test(win));

console.log("T7 dashboard / extension: labels only on evidence");
check("live: 'Submitted · unlocked' only with r.submitted; else 'Unlocked · no submission on record'", /r\.status==="done" && r\.submitted \? \["","Submitted · unlocked"\]/.test(DASH) && /done:\["","Unlocked · no submission on record"\]/.test(DASH));
check("live: unpaid / unverified locks are 'not admitted', not 'working'", DASH.includes('"Locked · not admitted (unpaid)"') && DASH.includes('"Locked · not admitted (unverified)"'));
check("live: 'No LOCKqz lock seen' replaces 'Has not opened the exam'", DASH.includes("No LOCKqz lock seen") && !DASH.includes("Has not opened the exam") && !DASH.includes("have not opened the exam"));
check("students: 'Installed · not paid' state, counted not ready", DASH.includes('"Installed · not paid"') && /missing: c\.students\.filter\(s=>!isReady\(s\)\)/.test(DASH));
check("headline counts exams confirmed in Brightspace + 'waiting to be set in Brightspace'", /setN===exams \?/.test(DASH) && /waiting to be set in Brightspace/.test(DASH));
check("'Synced X ago' uses the OLDEST class sync", /const synced = oldestSync\(\);/.test(DASH) && /sort\(\)\[0\]/.test(DASH));
const oldest = new Function("BS", DASH.slice(DASH.indexOf("const oldestSync"), DASH.indexOf("\n", DASH.indexOf("const oldestSync"))) + "; return oldestSync();");
check("oldestSync picks the oldest", oldest({ courses: [{ synced_at: "2026-10-27T10:00:00Z" }, { synced_at: "2026-10-20T10:00:00Z" }] }) === "2026-10-20T10:00:00Z");
check("class row: 'Emailed {date}' after emailing, remind button kept", /Emailed \$\{esc\(when\(c\.mailed_at\)\)\}/.test(DASH) && /Remind the \$\{s\.missing\.length\} who aren't ready/.test(DASH));
check("no absolute 'nothing to keep open' / 'opens the exam for installed students'", !/Nothing to click or keep open/.test(DASH) && !/opens the exam for installed students/.test(DASH));
const EXT = join(APP, "extension-prof"), cb = readFileSync(join(EXT, "content-bs.js"), "utf8"), bg = readFileSync(join(EXT, "background.js"), "utf8"), pop = readFileSync(join(EXT, "popup.js"), "utf8");
check("content-bs: the Brightspace notice claims nothing about who gets in beyond what LOCKqz admits", /LOCKqz protects this exam\./.test(cb) && /only to students LOCKqz lets in/.test(cb) && !/open this exam automatically/.test(cb) && !/to students who have LOCKqz/.test(cb));
check("content-bs: ok:false -> 'Synced. N exams could not be updated in Brightspace — open the LOCKqz dashboard.'", /d\.ok === false/.test(cb) && /could not be updated in Brightspace — <a[^>]*>open the LOCKqz dashboard<\/a>\./.test(cb));
check("background: unchanged skip sets lastCheck, not lastSync; ok:false keeps the badge", /m\.unchanged \? \{ lastCheck: now/.test(bg) && /badge\(m\.ok === false \? "!" : ""\)/.test(bg));
check("popup: 'Last synced' from lastSync only; waiting shown; 'students ready'", /"Last synced " \+ ago\(st\.lastSync\)/.test(pop) && /waiting to be set in Brightspace/.test(pop) && /students ready/.test(pop));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
