// Sweep 35 (24 Nov 2026), real API on in-memory SQLite: an exam taken more than once (attempts allowed).
//   A  the live view matches each unlock with the attempt of the lock it ended: a student who takes the exam twice
//      with LOCKqz is not red; an unlock before its own attempt was completed still is; an unlock from before this
//      change (no lock start kept) follows the old rule
//   B  every attempt's completion time is kept (submissions.ats): from the Sync (users[].all), from successive Sync
//      reports, from Brightspace's own emails; `at` stays the latest
//   C  each signed unlock keeps when its lock began (cap, the server's word, an ask)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const CF = join(HERE, "..", "cloudflare"), PUB = join(CF, "public");
const tmp = mkdtempSync(join(tmpdir(), "lqz-sweep35-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
function d1(sqlite) {
  const mk = sql => { const st = sqlite.prepare(sql); let args = [];
    const s = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return s; },
      first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
      run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } };
    return s; };
  return { prepare: mk, async batch(sts) { sqlite.exec("BEGIN"); try { for (const s of sts) s._run(); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; } return []; } };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch {} }
const one = (sql, ...a) => sqlite.prepare(sql).get(...a);
const run = (sql, ...a) => sqlite.prepare(sql).run(...a);
const env = { DB: d1(sqlite), TEACHER_KEY: "admin-key-s35", REQUIRE_SIGNED: "1", ADMIN_EMAIL: "admin@usc.edu", ROT_SECRET: "rot-s35", LIVE_CACHE_MS: "0", PAID_CACHE_MS: "0",
  MAIL_SINK: async () => true };
const BASE = "https://lockqz.test";
const sign = (key, path, ts, raw) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(raw).digest("hex")}`).digest("hex");
async function call(path, body, { teacher = null, dev = null, get = false, ip = "10.0.35.9" } = {}) {
  const raw = JSON.stringify(body ?? {});
  const h = { "Content-Type": "application/json", "CF-Connecting-IP": ip };
  if (teacher) h["X-LOCKqz-Teacher"] = teacher;
  if (dev) { const ts = String(Math.floor(Date.now() / 1000)); h["X-LOCKqz-Device"] = dev.id; h["X-LOCKqz-Time"] = ts; h["X-LOCKqz-Sig"] = sign(dev.key, "/api" + path.replace(/\?.*/, ""), ts, raw); }
  const res = await onRequest({ request: new Request(BASE + "/api" + path, { method: get ? "GET" : "POST", headers: h, body: get ? undefined : raw }), env });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const iso = ms => new Date(ms).toISOString();
const H = 3600000;

// One class, one professor, five students; quiz 1 protected (LOCKqz password), not gated.
const ADMIN = (await call("/signup", { email: "admin@usc.edu", password: "adminpass1", name: "Anthony Hall" })).data?.token;
const roster = [{ id: "8001", name: "Pat Prof", email: "p@usc.edu", role: "Instructor" },
  ...[1, 2, 3, 4, 5, 6, 7].map(i => ({ id: String(9100 + i), name: "Stu " + i, email: `s${i}@usc.edu`, role: "Student" }))];
await call("/sync", { courses: [{ ou: "700", name: "BUAD 306", classlist: roster, quizzes: [] }] }, { teacher: ADMIN });
const code = (await call("/invite", { email: "p@usc.edu", until: "2099-12-31" }, { teacher: ADMIN })).data?.code;
const P = (await call("/signup", { email: "p@usc.edu", password: "profpass12", name: "Pat Prof", invite: code })).data?.token;
const quizzes = [{ qi: "1", name: "Exam 1", active: true, start: iso(Date.now() - 2 * H), end: iso(Date.now() + 48 * H) },
                 { qi: "2", name: "Exam 2", active: true, start: iso(Date.now() - 2 * H), end: iso(Date.now() + 48 * H) }];
await call("/sync", { whoami: { id: "8001" }, courses: [{ ou: "700", name: "BUAD 306", classlist: roster, quizzes }] }, { teacher: P });
if (!one("SELECT 1 FROM quizzes WHERE ou='700' AND qi='1' AND password IS NOT NULL")) run("INSERT OR REPLACE INTO quizzes (ou, qi, quiz_id, password, gated) VALUES ('700','1','700-1','LQ-ABCDEFGHJK',0)");
run("UPDATE quizzes SET gated=0 WHERE ou='700'");
run("UPDATE bs_quizzes SET prot_at=?, unprot_at=NULL, bs_password_is_ours=1, bs_has_password=1 WHERE ou='700'", iso(Date.now() - H));

let n = 0;
const device = async (student) => {
  const d = { id: "mac-s35-" + (++n), key: randomBytes(32).toString("hex") };
  await call("/register", { device_id: d.id, key: d.key, platform: "mac", version: "0.6.43" }, { ip: "10.9.35." + n });
  if (student) run("UPDATE devices SET student=?, student_verified=1 WHERE device_id=?", student, d.id);
  return d;
};
const lock = (d, q = "700-1") => call("/report", { event: "lock", quiz_id: q }, { dev: d });
const gotPw = (d, q = "700-1") => run("INSERT INTO events (device_id, student, quiz_id, event, detail, ts) VALUES (?, NULL, ?, 'password_released', '{}', ?)", d.id, q, iso(Date.now() - 60000));
const ask = (d, reason, extra = {}, q = "700-1") => call("/report", { event: "unlock", quiz_id: q, detail: { reason, local: true, ask: true, before_end: true, held_s: 120, uid: 501, ...extra } }, { dev: d });
const locked = (d, q = "700-1") => !!one("SELECT 1 FROM locks WHERE device_id=? AND quiz_id=?", d.id, q);

const M = 60000;
const T0 = Date.now();
const rowOf = async d => ((await call("/live?quiz=700-1", null, { teacher: P, get: true })).data?.rows || []).find(r => r.device_id === d.id);
const evs = d => sqlite.prepare("SELECT id, event, ts, detail FROM events WHERE device_id=? AND event IN ('lock','unlock') ORDER BY id").all(d.id);
const lastUnlock = d => evs(d).filter(e => e.event === "unlock").pop();
// One attempt with LOCKqz: locked `from` minutes ago, unlocked with `reason` `to` minutes ago (times as they happened).
async function attempt(d, from, to, reason = "quiz_submitted", extra = { seen: { sub: true, attempt: true } }) {
  await lock(d);
  run("UPDATE locks SET locked_at=?, last_lock=? WHERE device_id=? AND quiz_id='700-1'", iso(T0 - from * M), iso(T0 - from * M), d.id);
  run("UPDATE events SET ts=? WHERE id=(SELECT MAX(id) FROM events WHERE device_id=? AND event='lock')", iso(T0 - from * M), d.id);
  const r = await ask(d, reason, extra);
  const u = lastUnlock(d); if (u) run("UPDATE events SET ts=? WHERE id=?", iso(T0 - to * M), u.id);
  return r;
}
const subRow = u => one("SELECT at, ats FROM submissions WHERE ou='700' AND qi='1' AND user_id=?", u);

console.log("C each signed unlock keeps when its lock began");
{
  const d = await device("s4@usc.edu"); gotPw(d);
  await attempt(d, 40, 35);
  const det = JSON.parse(lastUnlock(d).detail || "{}");
  check("an ask that ends a lock: its event keeps the lock's start", det.began === iso(T0 - 40 * M), JSON.stringify(det));
  await lock(d); run("UPDATE locks SET locked_at=? WHERE device_id=? AND quiz_id='700-1'", iso(T0 - 30 * M), d.id);
  await call("/report", { event: "unlock", quiz_id: "700-1", detail: { reason: "cap", end_known: false } }, { dev: d });
  check("the helper's cap: its event keeps the lock's start too", JSON.parse(lastUnlock(d).detail || "{}").began === iso(T0 - 30 * M), lastUnlock(d).detail);
  await lock(d); run("UPDATE locks SET locked_at=? WHERE device_id=? AND quiz_id='700-1'", iso(T0 - 20 * M), d.id);
  await call("/report", { event: "unlock", quiz_id: "700-1", detail: { reason: "quiz_submitted_server" } }, { dev: d });
  check("an unlock on the server's word: the same", JSON.parse(lastUnlock(d).detail || "{}").began === iso(T0 - 20 * M), lastUnlock(d).detail);
  run("DELETE FROM events WHERE device_id=?", d.id);
}

console.log("A/B an exam taken twice with LOCKqz (the Sync reports every attempt)");
{
  const d = await device("s2@usc.edu"); gotPw(d);
  await attempt(d, 30, 20);                          // attempt 1: 30 -> 20 min ago
  await call("/submitted", { ou: "700", qi: "1", users: [{ id: "9102", completed: iso(T0 - 20 * M - 10000), all: [iso(T0 - 20 * M - 10000)] }] }, { teacher: P });
  check("after attempt 1: done, not red", (await rowOf(d))?.status === "done", JSON.stringify(await rowOf(d)));
  await attempt(d, 15, 5);                           // attempt 2: 15 -> 5 min ago
  await call("/submitted", { ou: "700", qi: "1", users: [{ id: "9102", completed: iso(T0 - 5 * M - 10000), all: [iso(T0 - 20 * M - 10000), iso(T0 - 5 * M - 10000)] }] }, { teacher: P });
  const row = await rowOf(d);
  check("after attempt 2: still done, not red (attempt 1's unlock came after attempt 1's completion)", row?.status === "done" && !row.flagged_at, JSON.stringify(row));
  const s = subRow("9102");
  check("both completion times kept, the latest as `at`", s && s.at === iso(T0 - 5 * M - 10000) && JSON.parse(s.ats || "[]").length === 2, JSON.stringify(s));
}

console.log("A/B a Sync that only says the latest: the times it said before stay");
{
  const d = await device("s3@usc.edu"); gotPw(d);
  await attempt(d, 30, 20);
  await call("/submitted", { ou: "700", qi: "1", users: [{ id: "9103", completed: iso(T0 - 20 * M - 10000) }] }, { teacher: P });   // an older Sync: no all
  await attempt(d, 15, 5);
  await call("/submitted", { ou: "700", qi: "1", users: [{ id: "9103", completed: iso(T0 - 5 * M - 10000) }] }, { teacher: P });
  const s = subRow("9103");
  check("the earlier report's time is kept in the list", JSON.parse(s.ats || "[]").length === 2 && s.at === iso(T0 - 5 * M - 10000), JSON.stringify(s));
  check("... and the student is not red", (await rowOf(d))?.status === "done", JSON.stringify(await rowOf(d)));
}

console.log("A an unlock before its own attempt was completed is still red");
{
  const d = await device("s5@usc.edu"); gotPw(d);
  await attempt(d, 30, 20);                          // attempt 1: clean
  await attempt(d, 15, 10);                          // attempt 2: "submitted" 10 min ago ...
  await call("/submitted", { ou: "700", qi: "1", users: [{ id: "9105", completed: iso(T0 - 2 * M), all: [iso(T0 - 20 * M - 10000), iso(T0 - 2 * M)] }] }, { teacher: P });   // ... Brightspace: completed 2 min ago
  const row = await rowOf(d);
  check("attempt 2 unlocked 8 minutes before Brightspace's completion: red left_early", row?.status === "left_early" && row.flagged_at === iso(T0 - 10 * M), JSON.stringify(row));
}

console.log("A a second attempt begun within a minute of the first one's completion, then unlocked early: still red");
{
  const d = await device("s1@usc.edu"); gotPw(d);
  await attempt(d, 30, 20);                          // attempt 1: completed 20 min 10 s ago, unlocked 20 min ago
  await attempt(d, 19.5, 15);                        // attempt 2 begun 30 s after it, "submitted" 15 min ago (12 min before its completion)
  await call("/submitted", { ou: "700", qi: "1", users: [{ id: "9101", completed: iso(T0 - 3 * M), all: [iso(T0 - 20 * M - 10000), iso(T0 - 3 * M)] }] }, { teacher: P });
  const row = await rowOf(d);
  check("attempt 1's completion is matched with attempt 1 only: attempt 2's early unlock is red", row?.status === "left_early" && row.flagged_at === iso(T0 - 15 * M), JSON.stringify(row));
}

console.log("A an unlock kept from before this change (no lock start): the old rule");
{
  const d = await device("s6@usc.edu"); gotPw(d);
  await attempt(d, 30, 20);
  const u = lastUnlock(d); const det = JSON.parse(u.detail); delete det.began; run("UPDATE events SET detail=? WHERE id=?", JSON.stringify(det), u.id);
  await call("/submitted", { ou: "700", qi: "1", users: [{ id: "9106", completed: iso(T0 - 5 * M), all: [iso(T0 - 20 * M - 10000), iso(T0 - 5 * M)] }] }, { teacher: P });
  check("compared with the latest completion, as before (red)", (await rowOf(d))?.status === "left_early", JSON.stringify(await rowOf(d)));
}

console.log("B Brightspace's own emails: each attempt's time kept");
{
  env.MAILIN_ON = "1";
  const tok = createHmac("sha256", "rot-s35").update("lqz-quiz-mail:700-1").digest("hex").slice(0, 12);
  const mail = (text, ms) => call("/mailin", { to: `quiz+700-1-${tok}@lockqz.com`, from: "noreply@d2l.com", subject: "Quiz Submission Notification", text, date: new Date(ms).toUTCString() });
  const d = await device("s7@usc.edu"); gotPw(d);
  await attempt(d, 30, 20); await mail("Submitted by s7@usc.edu: Exam 1", T0 - 20 * M - 10000);
  await attempt(d, 15, 5);  await mail("Submitted by s7@usc.edu: Exam 1", T0 - 5 * M - 10000);
  const s = subRow("9107");
  check("two emails, two times; the latest as `at`", s && JSON.parse(s.ats || "[]").length === 2 && Date.parse(s.at) >= T0 - 5 * M - 11000, JSON.stringify(s));
  check("... and the student is not red", (await rowOf(d))?.status === "done", JSON.stringify(await rowOf(d)));
  delete env.MAILIN_ON;
}

check("the column is in schema.sql and in its own migrate file", /submissions \(ou TEXT, qi TEXT, user_id TEXT, at TEXT, ats TEXT/.test(readFileSync(join(CF, "schema.sql"), "utf8")) && readdirSync(CF).some(f => /^migrate_\d+_sub_ats\.sql$/.test(f)));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
