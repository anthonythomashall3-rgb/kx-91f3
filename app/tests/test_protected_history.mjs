// "was protected" only on proof (27 Oct 2026). Professor zero-effort harness. Real API on an in-memory database, the real sync.js in a
// sandbox against a simulated Brightspace, the extension / dashboard / agent sources as files.
//   Z1 default ON: a paid professor's Sync auto-protects every quiz in a class that is not turned off;
//      a class turned off gets no new protection.
//   Z2 a password changed by hand in Brightspace is written back on the next Sync.
//   Z3 emails: welcome on sign-up (HTML, subject); /email/students kind all -> every learner, Reply-To the
//      professor, signed; kind missing -> only students without a (verified) device; daily cap -> "limit".
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
const tmp = mkdtempSync(join(tmpdir(), "lqz-prot-"));
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


// ---- P1: the past-exam label (dashboard protPast), pure function ----
console.log("P1 past exam: 'was protected' only with proof from Brightspace");
const DASH = readFileSync(join(CF, "public", "dashboard.html"), "utf8");
const fsrc = DASH.slice(DASH.indexOf("function protPast(q){"), DASH.indexOf("\n}", DASH.indexOf("function protPast(q){")) + 2);
const protPast = new Function("when", fsrc + "; return protPast;")(t => "W(" + t + ")");
const T = h => new Date(Date.UTC(2026, 9, 23, 0, 0) + h * 3600e3).toISOString();   // hours from Oct 23 00:00Z
const ex = { start_date: T(10), end_date: T(24) };
check("the reported bug: LOCKqz password row but no Brightspace proof -> no claim", protPast({ ...ex, password: "LQ-x", bs_password_is_ours: 1 }) === "");
check("password on before it opened, never removed -> was protected", /was protected/.test(protPast({ ...ex, prot_at: T(2) })));
check("password on exactly at opening -> was protected", /was protected/.test(protPast({ ...ex, prot_at: T(10) })));
check("password went on after the exam closed -> no claim", protPast({ ...ex, prot_at: T(30) }) === "");
check("password went on while it was open -> partly protected · from", /partly protected · from W\(/.test(protPast({ ...ex, prot_at: T(12) })) && !/was protected/.test(protPast({ ...ex, prot_at: T(12) })));
check("password removed before it opened -> no claim", protPast({ ...ex, prot_at: T(1), unprot_at: T(5) }) === "");
check("password removed while it was open -> partly protected · until", /partly protected · until W\(/.test(protPast({ ...ex, prot_at: T(1), unprot_at: T(15) })));
check("password removed after it closed -> was protected", /was protected/.test(protPast({ ...ex, prot_at: T(1), unprot_at: T(30) })));
check("no start date (open since created) -> never 'was protected'", !/was protected/.test(protPast({ end_date: T(24), prot_at: T(1) })));
check("only a due date counts as the end", /was protected/.test(protPast({ start_date: T(10), due_date: T(24), prot_at: T(2) })));
check("no end or due date -> no claim", protPast({ start_date: T(10), prot_at: T(2) }) === "");
check("dashboard past list uses protPast, not the password row", /\$\{protPast\(q\)\}/.test(DASH) && !/q\.password\?"was protected"/.test(DASH));
check("Sync panel past list makes no protection claim", !/was protected/.test(readFileSync(join(CF, "public", "sync.js"), "utf8")));

// ---- P2: the server records when Brightspace showed our password go on / come off ----
console.log("P2 server: prot_at / unprot_at from the Sync tab's Brightspace results");
await api("/signup", { email: "admin@usc.edu", password: "adminpass1" });
const PROF = (await api("/signup", { email: "prof@usc.edu", password: "profpass1", name: "Duke Bristow" })).data.token;
sqlite.prepare("UPDATE teachers SET verified=1, active_until='2099-12-31', bs_user_id='4000' WHERE email='prof@usc.edu'").run();
const KEY = (await api("/synckey", undefined, { "X-LOCKqz-Teacher": PROF })).data.key;
const OU = 98765, inDays = d => new Date(Date.now() + d * 86400e3).toISOString();
const classlist = [{ id: "4000", name: "Duke Bristow", email: "prof@usc.edu", role: "Instructor" }, { id: "4001", name: "Al", email: "al@usc.edu", role: "Student" }];
const doSync = q => api("/sync", { host: "brightspace.usc.edu", whoami: { id: "4000", name: "Duke Bristow" }, courses: [{ ou: String(OU), name: "20263_FBE-437 Ent Fin", code: "FBE-437", role: "Instructor", classlist, quizzes: q }] }, { "X-LOCKqz-Sync": KEY });
await doSync([{ qi: 301, name: "Ent Fin Exam #1", active: true, start: inDays(2), end: inDays(2.2), has_password: false }]);
const row = () => sqlite.prepare("SELECT prot_at, unprot_at, bs_password_is_ours FROM bs_quizzes WHERE ou=? AND qi=?").get(String(OU), "301");
check("LOCKqz holds a password row (auto-protect) but Brightspace has not confirmed it -> prot_at empty", !!sqlite.prepare("SELECT 1 FROM quizzes WHERE ou=? AND qi='301'").get(String(OU)) && !row().prot_at, JSON.stringify(row()));
let bsq = (await api("/bs", undefined, { "X-LOCKqz-Teacher": PROF })).data.courses[0].quizzes.find(q => String(q.qi) === "301");
check("/bs: an unconfirmed exam carries no prot_at", "prot_at" in bsq && !bsq.prot_at, JSON.stringify(bsq));
await api("/sync-result", { results: [{ ou: String(OU), qi: "301", status: "set" }] }, { "X-LOCKqz-Sync": KEY });
const on1 = row().prot_at;
check("Brightspace confirmed (status set) -> prot_at stamped, ours=1", !!on1 && Number(row().bs_password_is_ours) === 1 && !row().unprot_at, JSON.stringify(row()));
await api("/sync-result", { results: [{ ou: String(OU), qi: "301", status: "already" }] }, { "X-LOCKqz-Sync": KEY });
check("a later 'already' keeps the first prot_at", row().prot_at === on1);
bsq = (await api("/bs", undefined, { "X-LOCKqz-Teacher": PROF })).data.courses[0].quizzes.find(q => String(q.qi) === "301");
check("/bs returns prot_at", bsq.prot_at === on1);
await api("/sync-result", { results: [{ ou: String(OU), qi: "301", status: "cleared" }] }, { "X-LOCKqz-Sync": KEY });
check("our password removed (cleared) -> unprot_at stamped", !!row().unprot_at && Number(row().bs_password_is_ours) === 0, JSON.stringify(row()));
await new Promise(r => setTimeout(r, 5));
await api("/sync-result", { results: [{ ou: String(OU), qi: "301", status: "set" }] }, { "X-LOCKqz-Sync": KEY });
check("protected again -> new prot_at, unprot_at cleared", row().prot_at && row().prot_at !== on1 && !row().unprot_at, JSON.stringify(row()));
// A Sync that reports Brightspace no longer has a password on the quiz -> unprot_at.
await doSync([{ qi: 301, name: "Ent Fin Exam #1", active: true, start: inDays(2), end: inDays(2.3), has_password: false }]);
check("Sync sees the password gone from Brightspace -> ours=0, unprot_at stamped", Number(row().bs_password_is_ours) === 0 && !!row().unprot_at, JSON.stringify(row()));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
