// Brightspace's own "turned in" email (22 Nov 2026), real API on in-memory SQLite:
//   M1 each protected quiz's address (MAILIN_ON): quiz+<ou>-<qi>-<tok>@lockqz.com in the Sync's answer, tok an HMAC
//   M2 POST /mailin keeps an email only for a real quiz address, finds the one student it is about, records the
//      submission (the Sync's own row), keeps the text only when nobody was found
//   M3 a computer that holds AI off after leaving the exam gets it back at its next ask
//   M4 a student none of whose computers locked for the quiz: the professor is told once; not for a locked student,
//      one let in, or a quiz LOCKqz does not protect
//   M5 /watch reads what a blip left unread; MAILIN_ON off = nothing changes
//   M6 the address only on an exam that is not over, in a class LOCKqz is on for
//   M7 POST /mailfwd: an email to support@ or the catch-all the mailbox turned away, sent on with the Worker's key
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-mailin-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
function d1(sqlite) {
  const mk = sql => { const st = sqlite.prepare(sql); let args = [];
    const s = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return s; },
      first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
      run: async () => { const r = st.run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }, _run() { st.run(...args); } };
    return s; };
  return { prepare: mk, async batch(sts) { sqlite.exec("BEGIN"); try { for (const s of sts) s._run(); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; } return []; } };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch {} }
const one = (sql, ...a) => sqlite.prepare(sql).get(...a);
const all = (sql, ...a) => sqlite.prepare(sql).all(...a);
const run = (sql, ...a) => sqlite.prepare(sql).run(...a);
const sent = [];
const env = { DB: d1(sqlite), TEACHER_KEY: "admin-key-mi", REQUIRE_SIGNED: "1", ADMIN_EMAIL: "admin@usc.edu", ROT_SECRET: "rot-mi", LIVE_CACHE_MS: "0", PAID_CACHE_MS: "0",
  MAILIN_ON: "1", MAIL_SINK: async m => { sent.push(m); return true; } };
const BASE = "https://lockqz.test";
const sign = (key, path, ts, raw) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(raw).digest("hex")}`).digest("hex");
async function call(path, body, { teacher = null, dev = null, get = false, ip = "10.0.47.9" } = {}) {
  const raw = JSON.stringify(body ?? {});
  const h = { "Content-Type": "application/json", "CF-Connecting-IP": ip };
  if (teacher) h["X-LOCKqz-Teacher"] = teacher;
  if (dev) { const ts = String(Math.floor(Date.now() / 1000)); h["X-LOCKqz-Device"] = dev.id; h["X-LOCKqz-Time"] = ts; h["X-LOCKqz-Sig"] = sign(dev.key, "/api" + path.replace(/\?.*/, ""), ts, raw); }
  const res = await onRequest({ request: new Request(BASE + "/api" + path, { method: get ? "GET" : "POST", headers: h, body: get ? undefined : raw }), env, waitUntil: p => p });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const iso = ms => new Date(ms).toISOString();
const H = 3600000;
const tok = (ou, qi) => createHmac("sha256", "rot-mi").update(`lqz-quiz-mail:${ou}-${qi}`).digest("hex").slice(0, 12);
const addr = (ou, qi, t = tok(ou, qi)) => `quiz+${ou}-${qi}-${t}@lockqz.com`;

// One class, one professor, students; quizzes 1 and 2 protected (LOCKqz password), not gated.
const ADMIN = (await call("/signup", { email: "admin@usc.edu", password: "adminpass1", name: "Anthony Hall" })).data?.token;
const roster = [{ id: "8001", name: "Pat Prof", email: "p@usc.edu", username: "pprof", role: "Instructor" },
  { id: "9101", name: "Jane Doe", email: "jdoe@usc.edu", username: "jdoe", org_id: "1234567890", role: "Student" },
  { id: "9102", name: "José Muñoz", email: "jmunoz@usc.edu", username: "jmunoz", role: "Student" },
  { id: "9103", name: "Sam Lee", email: "slee1@usc.edu", username: "slee1", role: "Student" },
  { id: "9104", name: "Sam Lee", email: "slee2@usc.edu", username: "slee2", role: "Student" },
  { id: "9105", name: "Ava Kim", email: "akim@usc.edu", username: "akim", role: "Student" },
  { id: "9106", name: "Noah Park", email: "npark@usc.edu", username: "npark", role: "Student" }];
await call("/sync", { courses: [{ ou: "700", name: "BUAD 306", classlist: roster, quizzes: [] }] }, { teacher: ADMIN });
const code = (await call("/invite", { email: "p@usc.edu", until: "2099-12-31" }, { teacher: ADMIN })).data?.code;
const P = (await call("/signup", { email: "p@usc.edu", password: "profpass12", name: "Pat Prof", invite: code })).data?.token;
const quizzes = [{ qi: "1", name: "Exam 1", active: true, start: iso(Date.now() - 2 * H), end: iso(Date.now() + 48 * H) },
                 { qi: "2", name: "Exam 2", active: true, start: iso(Date.now() - 2 * H), end: iso(Date.now() + 48 * H) }];
const sy = await call("/sync", { whoami: { id: "8001" }, courses: [{ ou: "700", name: "BUAD 306", classlist: roster, quizzes }] }, { teacher: P });
for (const q of ["1", "2"]) if (!one("SELECT 1 FROM quizzes WHERE ou='700' AND qi=? AND password IS NOT NULL", q)) run("INSERT OR REPLACE INTO quizzes (ou, qi, quiz_id, password, gated) VALUES ('700',?,?,'LQ-ABCDEFGHJK',0)", q, "700-" + q);
run("UPDATE quizzes SET gated=0 WHERE ou='700'");
run("UPDATE bs_quizzes SET prot_at=?, unprot_at=NULL, bs_password_is_ours=1, bs_has_password=1 WHERE ou='700'", iso(Date.now() - H));

let n = 0;
const device = async (student) => {
  const d = { id: "mac-mi-" + (++n), key: randomBytes(32).toString("hex") };
  await call("/register", { device_id: d.id, key: d.key, platform: "mac", version: "0.6.40" }, { ip: "10.9.47." + n });
  if (student) run("UPDATE devices SET student=?, student_verified=1 WHERE device_id=?", student, d.id);
  return d;
};
const lock = (d, q = "700-1") => call("/report", { event: "lock", quiz_id: q }, { dev: d });
const gotPw = (d, q = "700-1") => run("INSERT INTO events (device_id, student, quiz_id, event, detail, ts) VALUES (?, NULL, ?, 'password_released', '{}', ?)", d.id, q, iso(Date.now() - 60000));
const ask = (d, reason, extra = {}, q = "700-1") => call("/report", { event: "unlock", quiz_id: q, detail: { reason, local: true, ask: true, before_end: true, held_s: 120, uid: 501, seen: { sub: false, attempt: true }, ...extra } }, { dev: d });
const mail = (to, text, subject = "Quiz Submission Notification") => call("/mailin", { to, from: "noreply@d2l.com", subject, text, date: new Date().toUTCString() });
const sub = (u, q = "1") => one("SELECT at FROM submissions WHERE ou='700' AND qi=? AND user_id=?", q, u);

console.log("M1 each protected quiz's address, in the Sync's answer");
{
  const p1 = (sy.data?.protect || []).find(r => String(r.qi) === "1");
  check("protected quiz: its address is quiz+<ou>-<qi>-<tok>@lockqz.com", p1 && p1.mail === addr("700", "1"), JSON.stringify(p1));
  check("the tok is the quiz's own (another quiz has another)", tok("700", "1") !== tok("700", "2") && /^[0-9a-f]{12}$/.test(tok("700", "1")));
  env.MAILIN_ON = "0";
  const off = await call("/sync", { whoami: { id: "8001" }, courses: [{ ou: "700", name: "BUAD 306", classlist: roster, quizzes }] }, { teacher: P });
  check("MAILIN_ON off: no address (the Sync leaves Notification Email alone)", (off.data?.protect || []).length && (off.data.protect || []).every(r => !("mail" in r)));
  const r = await mail(addr("700", "1"), "Jane Doe has completed Exam 1.");
  check("MAILIN_ON off: an email changes nothing", r.data?.off === true && !one("SELECT 1 FROM mailin") && !sub("9101"));
  env.MAILIN_ON = "1";
}

console.log("M2 an email is kept only for a real quiz address and read at once");
{
  let r = await mail("quiz+700-1-000000000000@lockqz.com", "Jane Doe has completed Exam 1.");
  check("a made-up address: refused, nothing kept", r.status === 404 && !one("SELECT 1 FROM mailin") && !sub("9101"));
  r = await mail(addr("700", "2").replace("-2-", "-1-"), "Jane Doe has completed Exam 1.");
  check("another quiz's tok on this quiz: refused", r.status === 404 && !one("SELECT 1 FROM mailin"));
  r = await mail(addr("700", "1"), "A quiz attempt was submitted.\nUser: Jane Doe\nQuiz: Exam 1\nCourse: BUAD 306");
  const row = one("SELECT * FROM mailin ORDER BY id DESC LIMIT 1");
  check("the student by name: submission recorded (Brightspace's own word, as the Sync would)", r.data?.found === true && !!sub("9101"), JSON.stringify(r.data));
  check("... read once: the email's text is not kept", row && row.state === "done" && row.user_id === "9101" && row.body === null, JSON.stringify(row));
  r = await mail(addr("700", "1"), "Attempt submitted by Muñoz, José (jmunoz) for Exam 1");
  check("'Last, First' with accents and the user name: the right student", r.data?.found === true && !!sub("9102"));
  r = await mail(addr("700", "1"), "Submitted: akim@usc.edu");
  check("the student's email address alone: the right student", !!sub("9105"));
  r = await mail(addr("700", "1"), "Sam Lee has completed Exam 1.");
  const amb = one("SELECT * FROM mailin ORDER BY id DESC LIMIT 1");
  check("two students with the same name and nothing else: nobody (never a wrong student); its text kept to learn from", r.data?.found === false && !sub("9103") && !sub("9104") && amb.state === "unmatched" && amb.body.includes("Sam Lee"));
  r = await mail(addr("700", "1"), "Sam Lee (slee2) has completed Exam 1.");
  check("... the same name with the user name: the right one", !!sub("9104") && !sub("9103"));
  r = await mail(addr("700", "1"), "Pat Prof: a learner submitted Exam 1.");
  check("the professor's own name: never a student", r.data?.found === false);
  r = await mail(addr("700", "1"), "Org Defined ID 1234567890 completed Exam 1");
  check("the student's org id: the right student", (one("SELECT user_id FROM mailin ORDER BY id DESC LIMIT 1") || {}).user_id === "9101");
  r = await mail(addr("700", "1"), "https://brightspace.usc.edu/d2l/lms/quizzing/admin/mark/quiz_mark_attempt.d2l?ou=700&qi=1&ai=55&uid=9106 submitted");
  check("a link with the student's Brightspace id: the right student", !!sub("9106"));
  const before = sub("9101").at;
  run("UPDATE submissions SET at=? WHERE ou='700' AND qi='1' AND user_id='9101'", iso(Date.now() - 10 * H));
  await mail(addr("700", "1"), "User: Jane Doe completed attempt 2");
  check("a later attempt moves the submission time on, never back", Date.parse(sub("9101").at) > Date.now() - 60000 && !!before);
}

console.log("M3 a computer holding AI off gets it back once Brightspace's email arrives");
{
  sent.length = 0;
  run("DELETE FROM submissions WHERE ou='700' AND user_id='9101'");
  const d = await device("jdoe@usc.edu");
  await lock(d); gotPw(d);
  let r = await ask(d, "quiz_left");
  check("left the exam page, no submission yet: held (AI stays off)", r.data?.hold === true, JSON.stringify(r.data));
  await mail(addr("700", "1"), "User: Jane Doe\nQuiz: Exam 1 has been submitted.");
  r = await ask(d, "quiz_left");
  check("... Brightspace's email came: the next ask lets AI back", !r.data?.hold, JSON.stringify(r.data));
  check("... and that student was locked: no 'without LOCKqz' email about them", !sent.some(m => /Jane Doe took/.test(m.subject || "")));
  // an email the Worker handed over while the read failed (a blip): the next ask for that quiz reads it
  run("DELETE FROM submissions WHERE ou='700' AND user_id='9105'");
  const d2 = await device("akim@usc.edu"); await lock(d2); gotPw(d2);
  run("INSERT INTO mailin (ou,qi,at,sender,subject,body,state) VALUES ('700','1',?,?,?,?,'new')", iso(Date.now()), "noreply@d2l.com", "Quiz Submission", "Ava Kim completed Exam 1");
  r = await ask(d2, "quiz_left");
  check("an email left unread: the held computer's next ask reads it and lets AI back", !r.data?.hold && !!sub("9105"), JSON.stringify(r.data));
}

console.log("M4 a student none of whose computers locked for the quiz: the professor is told once");
{
  sent.length = 0;
  await mail(addr("700", "2"), "Noah Park has completed Exam 2.");
  const m = sent.filter(x => /took Exam 2 without LOCKqz/.test(x.subject || ""));
  check("the professor is emailed: who, which exam, red on the LOCKqz page", m.length === 1 && m[0].to === "p@usc.edu" && /Noah Park/.test(m[0].subject) && /not blocked/.test(m[0].text) && /red/.test(m[0].text), JSON.stringify(sent.map(x => [x.to, x.subject])));
  check("... the record keeps it (event no_lqz_submit)", !!one("SELECT 1 FROM events WHERE event='no_lqz_submit' AND quiz_id='700-2' AND student='npark@usc.edu'"));
  await mail(addr("700", "2"), "Noah Park has completed Exam 2 (attempt 2).");
  check("... a second attempt: not emailed again", sent.filter(x => /Noah Park took Exam 2/.test(x.subject || "")).length === 1);
  const d = await device("jmunoz@usc.edu"); await lock(d, "700-2");
  await mail(addr("700", "2"), "José Muñoz has completed Exam 2.");
  check("a student whose computer locked for it: no email", !sent.some(x => /Mu.oz took/.test(x.subject || "")));
  run("INSERT INTO letin (ou,qi,email,user_id,by_teacher,at) VALUES ('700','2','akim@usc.edu','9105','p',?)", iso(Date.now()));
  await mail(addr("700", "2"), "Ava Kim has completed Exam 2.");
  check("a student the professor let in without LOCKqz: no email", !sent.some(x => /Ava Kim took/.test(x.subject || "")));
  run("INSERT OR REPLACE INTO lockqz_off (ou,qi,teacher_id,at) VALUES ('700','2','p',?)", iso(Date.now()));
  run("DELETE FROM quizzes WHERE ou='700' AND qi='2'");
  await mail(addr("700", "2"), "Jane Doe has completed Exam 2.");
  check("a quiz LOCKqz no longer protects: no email", !sent.some(x => /Jane Doe took/.test(x.subject || "")));
}

console.log("M5 /watch reads what a blip left; old rows go");
{
  run("DELETE FROM submissions WHERE ou='700' AND user_id='9103'");
  run("INSERT INTO mailin (ou,qi,at,sender,subject,body,state) VALUES ('700','1',?,?,?,?,'new')", iso(Date.now()), "noreply@d2l.com", "Quiz Submission", "Sam Lee (slee1) completed Exam 1");
  await call("/watch", null, { get: true });
  check("/watch read the unread email", !!sub("9103") && !one("SELECT 1 FROM mailin WHERE state='new'"));
  check("the table is in schema.sql and its own migrate file", /CREATE TABLE IF NOT EXISTS mailin/.test(readFileSync(join(CF, "schema.sql"), "utf8")) && readdirSync(CF).some(f => /^migrate_\d+_mailin\.sql$/.test(f)));
  const route = readFileSync(join(CF, "functions", "api", "[[route]].js"), "utf8");
  check("old rows are removed with the other short-lived rows (14 days)", /DELETE FROM mailin WHERE id IN \(SELECT id FROM mailin WHERE at<\? LIMIT 300\)"\)\.bind\(ago\(14\)\)/.test(route));
}

console.log("M6 the address goes only on an exam that is not over, in a class LOCKqz is on for");
{
  const past = [{ qi: "3", name: "Exam 0", active: true, start: iso(Date.now() - 30 * 24 * H), end: iso(Date.now() - 20 * 24 * H) }];
  run("INSERT OR REPLACE INTO quizzes (ou, qi, quiz_id, password, gated) VALUES ('700','3','700-3','LQ-ABCDEFGHJK',0)");
  const syncAll = () => call("/sync", { whoami: { id: "8001" }, courses: [{ ou: "700", name: "BUAD 306", classlist: roster, quizzes: [...quizzes, ...past] }] }, { teacher: P });
  let r = await syncAll();
  const row = qi => (r.data?.protect || []).find(x => String(x.qi) === qi);
  check("an exam that is not over: its address", row("1") && row("1").mail === addr("700", "1"), JSON.stringify(r.data?.protect));
  check("a past exam LOCKqz still lists: no address (its Brightspace settings are left as they are)", !!row("3") && !("mail" in row("3")), JSON.stringify(row("3")));
  run("INSERT OR REPLACE INTO course_off (ou, teacher_id, at) VALUES ('700', 'p', ?)", iso(Date.now()));
  r = await syncAll();
  check("a class turned off: no address on any of its exams", (r.data?.protect || []).length > 0 && (r.data.protect || []).every(x => !("mail" in x)), JSON.stringify(r.data?.protect));
  run("DELETE FROM course_off WHERE ou='700'");
  r = await syncAll();
  check("... turned on again: the upcoming exam has it again", row("1") && row("1").mail === addr("700", "1"));
}

console.log("M7 an email the mailbox turned away for a while: LOCKqz sends it on, only with the Worker's key");
{
  const KEY = "a".repeat(64);
  const fwdCall = async (b, key) => { const res = await onRequest({ request: new Request(BASE + "/api/mailfwd", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.47.9", ...(key ? { "X-LQZ-Key": key } : {}) }, body: JSON.stringify(b) }), env, waitUntil: p => p });
    return { status: res.status, data: await res.json().catch(() => null) }; };
  const B = { to: "support@lockqz.com", from: "ana@usc.edu", subject: "Can’t install", date: "Mon, 23 Nov 2026 10:00:00 +0000", text: "The installer stops at step 2.", files: ["shot.png"], why: "421 4.7.28 unusual rate" };
  sent.length = 0;
  let r = await fwdCall(B, KEY);
  check("no key set on the server: refused", r.status === 403 && sent.length === 0);
  env.MAILIN_KEY = KEY; env.MAIL_USER = "lockqz.app@gmail.com";
  r = await fwdCall(B, "b".repeat(64));
  check("a wrong key: refused, nothing sent", r.status === 403 && sent.length === 0);
  r = await fwdCall(B);
  check("no key: refused", r.status === 403 && sent.length === 0);
  r = await fwdCall(B, KEY);
  const m = sent[0] || {};
  check("the Worker's key: sent on to the mailbox (lockqz.app@gmail.com), Reply-To its sender", r.status === 200 && sent.length === 1 && m.to === "lockqz.app@gmail.com" && m.replyTo === "ana@usc.edu" && m.subject === "Fwd: Can’t install", JSON.stringify(m));
  check("... who wrote, to which address, when, its words, its attachments named", /From: ana@usc\.edu/.test(m.text) && /To: support@lockqz\.com/.test(m.text) && /Mon, 23 Nov 2026/.test(m.text) && /stops at step 2/.test(m.text) && /Attachments \(not included\): shot\.png/.test(m.text), m.text);
  const ev = one("SELECT detail FROM events WHERE event='mail_fwd' ORDER BY id DESC LIMIT 1");
  check("kept: that one went on (to which address, why), never its sender or words", !!ev && /support@lockqz\.com/.test(ev.detail) && /4\.7\.28/.test(ev.detail) && !/ana@usc/.test(ev.detail) && !/installer/.test(ev.detail), JSON.stringify(ev));
  sent.length = 0;
  r = await fwdCall({ ...B, from: "x@y.com\r\nBcc: z@z.com", subject: "hi\r\nBcc: z@z.com" }, KEY);
  check("a sender or subject with line breaks: kept on one line, no Reply-To made from it", r.status === 200 && !/[\r\n]/.test(sent[0].subject) && sent[0].replyTo === null && !/^Bcc:/m.test(sent[0].text), JSON.stringify(sent[0]));
  sent.length = 0;
  r = await fwdCall({ ...B, from: "bounces+77@em.list.example", author: "Ana Muñoz <ana@usc.edu>", reply: "" }, KEY);
  check("a bounce address as the envelope's sender: Reply-To from its From line, and From shows who wrote it", r.status === 200 && sent[0].replyTo === "ana@usc.edu" && /From: Ana Muñoz <ana@usc\.edu>/.test(sent[0].text), JSON.stringify(sent[0]));
  sent.length = 0;
  r = await fwdCall({ ...B, author: "Ana <ana@usc.edu>", reply: "Help Desk <help@usc.edu>" }, KEY);
  check("a Reply-To line: answers go there", r.status === 200 && sent[0].replyTo === "help@usc.edu");
  sent.length = 0;
  r = await fwdCall({ ...B, author: "undisclosed-recipients:;", reply: "a@b.com, c@d.com" }, KEY);
  check("a From or Reply-To that is not one plain address: no Reply-To made from it (the envelope's sender then)", r.status === 200 && sent[0].replyTo === "ana@usc.edu", JSON.stringify(sent[0].replyTo));
  sent.length = 0;
  r = await fwdCall({ ...B, author: "x <a@b.com>\r\nBcc: z@z.com" }, KEY);
  check("a From line with line breaks: kept on one line", r.status === 200 && !/^Bcc:/m.test(sent[0].text) && sent[0].replyTo === "a@b.com", JSON.stringify(sent[0].replyTo));
  delete env.MAIL_USER; sent.length = 0;
  r = await fwdCall(B, KEY);
  check("LOCKqz's Gmail sender is another account: sent through LOCKqz's mail, Reply-To its sender", r.status === 200 && sent.length === 1 && sent[0].to === "lockqz.app@gmail.com" && sent[0].replyTo === "ana@usc.edu");
  env.MAILFWD_DAY_MAX = "3"; sent.length = 0;
  r = await fwdCall(B, KEY);
  check("at most MAILFWD_DAY_MAX a day: then refused (the sender's server tries again later)", r.status === 429 && sent.length === 0);
  delete env.MAILFWD_DAY_MAX;
  env.MAILIN_KEY = "short"; r = await fwdCall(B, "short");
  check("a key shorter than 32 characters is never accepted", r.status === 403);
  delete env.MAILIN_KEY;
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
