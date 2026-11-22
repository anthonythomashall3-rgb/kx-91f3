// Sweep 28 (22 Nov 2026), real API on in-memory SQLite:
//   H  an exam attempt ends only when Brightspace or the student's own computer says so, gated or not
//      (LOCAL_HOLD): leaving the exam page keeps AI off; the agent's "submitted" (and, from 0.6.38, what it saw)
//      ends it; a computer that never got the password ends it at once; Brightspace's submission or the quiz
//      end release a held lock; LOCAL_HOLD = "0" is the old rule.
//   L  the live view: an exam opened again after its computer reported it submitted is red ("reopened");
//      a student Brightspace shows completing the exam while LOCKqz's password was on it, with no LOCKqz
//      lock and not let in, is red ("no_lqz").
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const CF = join(HERE, "..", "cloudflare"), PUB = join(CF, "public");
const tmp = mkdtempSync(join(tmpdir(), "lqz-sweep28-"));
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
const env = { DB: d1(sqlite), TEACHER_KEY: "admin-key-s28", REQUIRE_SIGNED: "1", ADMIN_EMAIL: "admin@usc.edu", ROT_SECRET: "rot-s28", LIVE_CACHE_MS: "0", PAID_CACHE_MS: "0",
  MAIL_SINK: async () => true };
const BASE = "https://lockqz.test";
const sign = (key, path, ts, raw) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(raw).digest("hex")}`).digest("hex");
async function call(path, body, { teacher = null, dev = null, get = false, ip = "10.0.28.9" } = {}) {
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
  const d = { id: "mac-s28-" + (++n), key: randomBytes(32).toString("hex") };
  await call("/register", { device_id: d.id, key: d.key, platform: "mac", version: "0.6.36" }, { ip: "10.9.28." + n });
  if (student) run("UPDATE devices SET student=?, student_verified=1 WHERE device_id=?", student, d.id);
  return d;
};
const lock = (d, q = "700-1") => call("/report", { event: "lock", quiz_id: q }, { dev: d });
const gotPw = (d, q = "700-1") => run("INSERT INTO events (device_id, student, quiz_id, event, detail, ts) VALUES (?, NULL, ?, 'password_released', '{}', ?)", d.id, q, iso(Date.now() - 60000));
const ask = (d, reason, extra = {}, q = "700-1") => call("/report", { event: "unlock", quiz_id: q, detail: { reason, local: true, ask: true, before_end: true, held_s: 120, uid: 501, ...extra } }, { dev: d });
const locked = (d, q = "700-1") => !!one("SELECT 1 FROM locks WHERE device_id=? AND quiz_id=?", d.id, q);

console.log("H an attempt ends only when Brightspace or the student's own computer says so (not gated)");
{
  check("set-up: the exam is protected and not gated", !!one("SELECT 1 FROM quizzes WHERE ou='700' AND qi='1' AND password IS NOT NULL AND COALESCE(gated,0)=0"));
  const a = await device("s1@usc.edu"); await lock(a); gotPw(a);
  let r = await ask(a, "quiz_left");
  check("exam page left mid-attempt (quiz list): AI stays off (hold)", r.status === 200 && r.data?.hold === true, JSON.stringify(r));
  check("... the lock row stays", locked(a));
  check("... logged as unlock_held", !!one("SELECT 1 FROM events WHERE device_id=? AND event='unlock_held'", a.id));
  r = await ask(a, "quiz_tab_closed");
  check("exam tab closed mid-attempt: hold", r.data?.hold === true, JSON.stringify(r.data));
  r = await ask(a, "local_request");
  check("an unlock asked by hand (curl with the token): hold", r.data?.hold === true, JSON.stringify(r.data));
  r = await ask(a, "quiz_submitted", { seen: { sub: false, attempt: true } });
  check("'submitted' from a 0.6.38 agent that did not see the submitted page replace the attempt: hold", r.data?.hold === true, JSON.stringify(r.data));
  r = await ask(a, "quiz_left", { seen: { sub: false, attempt: true } });
  check("left after an attempt page was seen: hold", r.data?.hold === true, JSON.stringify(r.data));
  const hb = await call("/report", { event: "heartbeat", quiz_id: "700-1", source: "helper" }, { dev: a });
  check("a held lock's heartbeat does not release it (no submission, exam still open)", hb.status === 200 && !hb.data?.unlock, JSON.stringify(hb.data));
  r = await ask(a, "quiz_submitted", { seen: { sub: true, attempt: true } });
  check("the agent saw the submitted page replace the attempt: AI back (stands)", r.status === 200 && !r.data?.hold && r.data?.ok === true, JSON.stringify(r.data));
  check("... the lock row is gone", !locked(a));
  const ev = one("SELECT detail FROM events WHERE device_id=? AND event='unlock' ORDER BY id DESC LIMIT 1", a.id);
  check("... recorded as ended by the agent's submit, unexpected (no Brightspace submission yet)", /"ended":"agent_submit"/.test(ev?.detail || "") && /"unexpected":true/.test(ev?.detail || ""), ev?.detail);

  const b = await device("s2@usc.edu"); await lock(b); gotPw(b);
  r = await ask(b, "quiz_submitted");
  check("an older agent's 'submitted' (no seen) still ends it (unchanged for installed copies)", r.status === 200 && !r.data?.hold, JSON.stringify(r.data));
  await lock(b); r = await ask(b, "quiz_left", { seen: { sub: false, attempt: false } });
  check("no attempt page of this exam was seen during the lock: AI back at once", !r.data?.hold && r.data?.ok === true, JSON.stringify(r.data));

  const c = await device("s3@usc.edu"); await lock(c);
  r = await ask(c, "quiz_tab_closed");
  check("never given the exam's LOCKqz password (could not start it): AI back at once", !r.data?.hold && r.data?.ok === true, JSON.stringify(r.data));
  check("... recorded as no_password", /"ended":"no_password"/.test(one("SELECT detail FROM events WHERE device_id=? AND event='unlock' ORDER BY id DESC LIMIT 1", c.id)?.detail || ""));

  // Released while held: Brightspace's submission (professor's Sync), or the exam's end.
  const d = await device("s4@usc.edu"); await lock(d); gotPw(d);
  r = await ask(d, "quiz_tab_closed");
  check("set-up: held", r.data?.hold === true);
  await call("/submitted", { ou: "700", qi: "1", users: [{ id: "9104", completed: iso(Date.now()) }] }, { teacher: P });
  r = await ask(d, "quiz_tab_closed");
  check("Brightspace shows the submission (Sync): the held ask now stands", !r.data?.hold && r.data?.ok === true, JSON.stringify(r.data));
  const e = await device("s5@usc.edu"); await lock(e); gotPw(e);
  check("set-up: held", (await ask(e, "quiz_left")).data?.hold === true);
  run("UPDATE bs_quizzes SET end_date=? WHERE ou='700' AND qi='1'", iso(Date.now() - 60000));
  r = await ask(e, "quiz_left");
  check("the exam's end passed: the held ask stands", !r.data?.hold && r.data?.ok === true, JSON.stringify(r.data));
  run("UPDATE bs_quizzes SET end_date=? WHERE ou='700' AND qi='1'", iso(Date.now() + 48 * H));

  // Gated: unchanged.
  const g = await device("s6@usc.edu"); run("UPDATE quizzes SET gated=1 WHERE ou='700' AND qi='1'"); await lock(g); gotPw(g);
  r = await ask(g, "quiz_submitted", { seen: { sub: true, attempt: true } });
  check("a gated exam keeps its own rule: held until Brightspace says so (even with the agent's submit)", r.data?.hold === true, JSON.stringify(r.data));
  run("UPDATE quizzes SET gated=0 WHERE ou='700' AND qi='1'");

  // LOCAL_HOLD = "0": the old rule.
  env.LOCAL_HOLD = "0";
  const f = await device("s1@usc.edu"); await lock(f, "700-2"); gotPw(f, "700-2");
  run("INSERT OR IGNORE INTO quizzes (ou, qi, quiz_id, password, gated) VALUES ('700','2','700-2','LQ-BCDEFGHJKL',0)");
  r = await ask(f, "quiz_left", {}, "700-2");
  check("LOCAL_HOLD = \"0\": a local unlock of a non-gated exam stands, as before", !r.data?.hold && r.data?.ok === true, JSON.stringify(r.data));
  delete env.LOCAL_HOLD;
}

console.log("L live view: reopened after a reported submit; completed without LOCKqz");
{
  run("DELETE FROM submissions WHERE ou='700'");
  // s1 reported "submitted" (a fresh device for s1); opening the exam again re-locks it -> red "reopened".
  const re = await device("s1@usc.edu");
  await lock(re); gotPw(re);
  check("set-up", !!(await ask(re, "quiz_submitted", { seen: { sub: true, attempt: true } })).data?.ok);
  run("UPDATE events SET ts=? WHERE device_id=? AND event='unlock'", iso(Date.now() - 5 * 60000), re.id);
  await lock(re);
  let live = await call("/live?quiz=700-1", null, { teacher: P, get: true });
  let row = (live.data?.rows || []).find(r => r.device_id === re.id);
  check("opened again after its computer reported it submitted: red left_early / reopened", row?.status === "left_early" && row?.reason === "reopened", JSON.stringify(row));
  // Brightspace shows a completion at (or before) the report: a real submission, a new attempt -> not "reopened".
  await call("/submitted", { ou: "700", qi: "1", users: [{ id: "9101", completed: iso(Date.now() - 6 * 60000) }] }, { teacher: P });
  live = await call("/live?quiz=700-1", null, { teacher: P, get: true });
  row = (live.data?.rows || []).find(r => r.device_id === re.id);
  check("... not 'reopened' once Brightspace shows that submission (a new attempt)", row && row.reason !== "reopened", JSON.stringify(row));

  // s3 completed the exam while LOCKqz's password was on it, s3's device only locked + got nothing -> has rows.
  // s6 completed it with no LOCKqz record at all -> red no_lqz. s5 was let in -> not red. A completion before
  // LOCKqz protected the exam -> not red.
  run("DELETE FROM locks WHERE quiz_id='700-1'"); run("DELETE FROM events WHERE quiz_id='700-1' AND device_id IN (SELECT device_id FROM devices WHERE student='s6@usc.edu')");
  run("INSERT INTO letin (ou, qi, email, user_id, by_teacher, at) VALUES ('700','1','s5@usc.edu','9105','p',?)", iso(Date.now()));
  run("DELETE FROM events WHERE quiz_id='700-1' AND device_id IN (SELECT device_id FROM devices WHERE student='s5@usc.edu')");
  await call("/submitted", { ou: "700", qi: "1", users: [{ id: "9106", completed: iso(Date.now() - 20 * 60000) }, { id: "9105", completed: iso(Date.now() - 20 * 60000) }, { id: "9107", completed: iso(Date.now() - 3 * H) }] }, { teacher: P });
  live = await call("/live?quiz=700-1", null, { teacher: P, get: true });
  const rows = live.data?.rows || [];
  const s6 = rows.find(r => r.email === "s6@usc.edu" && r.status === "no_lqz");
  check("completed in Brightspace while LOCKqz's password was on, never locked: red no_lqz", !!s6 && s6.submitted === true && !!s6.flagged_at, JSON.stringify(rows.filter(r => r.status === "no_lqz")));
  check("... a student the professor let in is not red", !rows.some(r => r.status === "no_lqz" && r.email === "s5@usc.edu"));
  check("... a completion from before LOCKqz protected the exam is not red", !rows.some(r => r.status === "no_lqz" && r.email === "s7@usc.edu"));
  check("... a student with a LOCKqz record for it is not red no_lqz", !rows.some(r => r.status === "no_lqz" && r.email === "s1@usc.edu"));
  const dash = readFileSync(join(PUB, "dashboard.html"), "utf8");
  check("dashboard: no_lqz is a red label", /no_lqz:\["red","Took the exam without LOCKqz"\]/.test(dash));
  check("dashboard: the reopened reason has words", /reopened:"opened the exam again after it was reported submitted"/.test(dash));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
