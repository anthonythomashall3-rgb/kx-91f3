// Student email verification (25 Oct 2026). Runs the REAL API against an in-memory SQLite DB.
// Proves: the email is bound to a computer only after the student types the 6-digit code emailed
// to it (typo / classmate's email can never bind); an expired code auto-resends (no retyping);
// wrong-code and send rate limits; a verified email can't be overwritten by a report; the quiz gate
// and the professor's Ready list count only confirmed emails; the SMTP client speaks real SMTP.
// No network. Exits non-zero on any failure.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-ev-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
let pass = 0, fail = 0;
const check = (m, c, info = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m, info); } };
const sign = (key, path, ts, body) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");
function d1(sqlite) { return { prepare(sql) { const st = sqlite.prepare(sql); let a = [];
  const s = { bind(...x) { a = x.map(v => v === undefined ? null : typeof v === "boolean" ? Number(v) : v); return s; },
    first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => ({ meta: { changes: Number(st.run(...a).changes) } }) };
  return s; }, async batch(sts) { for (const x of sts) await x.run(); } }; }
const BASE = "https://lockqz.test", ADMIN = "admin-test-key", OU = "98765", QI = "12345", LOCK_ID = `${OU}-${QI}`;
async function call(env, path, body, { key = null, device = null, teacher = null } = {}) {
  const raw = JSON.stringify(body ?? {}), h = { "Content-Type": "application/json" };
  if (key) { const ts = String(Math.floor(Date.now() / 1000)); h["X-LOCKqz-Device"] = device; h["X-LOCKqz-Time"] = ts; h["X-LOCKqz-Sig"] = sign(key, "/api" + path, ts, raw); }
  if (teacher) h["X-LOCKqz-Teacher"] = teacher;
  const res = await onRequest({ request: new Request(BASE + "/api" + path, { method: "POST", headers: h, body: raw }), env });
  let data = null; try { data = await res.json(); } catch {} return { status: res.status, data };
}
async function get(env, path) {
  const res = await onRequest({ request: new Request(BASE + "/api" + path, { headers: { "X-LOCKqz-Teacher": ADMIN } }), env });
  return { status: res.status, data: await res.json() };
}
function makeDb(oldSchema) {
  const sqlite = new DatabaseSync(":memory:");
  let schema = readFileSync(join(CF, "schema.sql"), "utf8");
  if (oldSchema) schema = schema.replace(/,\n  student_verified INTEGER DEFAULT 0[^\n]*/, "").replace(/\n-- One pending email code[^\n]*\nCREATE TABLE IF NOT EXISTS email_codes[^\n]*/, "");
  sqlite.exec(schema);
  for (const m of ["migrate_012_bs_code.sql", "migrate_013_sa_keep.sql", "migrate_015_student_verify.sql", "migrate_016_bs_user.sql"]) { try { sqlite.exec(readFileSync(join(CF, m), "utf8")); } catch (e) { /* already in schema.sql */ } }
  const t = new Date().toISOString();
  for (const [id, name, email, role] of [["4001", "Al Student", "al@usc.edu", "Student"], ["4002", "Bo Student", "bo@usc.edu", "Student"]])
    sqlite.prepare("INSERT INTO roster (ou,user_id,name,email,role,synced_at) VALUES (?,?,?,?,?,?)").run(OU, id, name, email, role, t);
  return sqlite;
}

async function suite(label, oldSchema) {
  console.log(`\n== ${label} ==`);
  const sqlite = makeDb(oldSchema), mail = [];
  const off = { DB: d1(sqlite), TEACHER_KEY: ADMIN, REQUIRE_SIGNED: "1" };
  const on = { ...off, MAIL_SINK: m => { mail.push(m); return true; } };
  const reg = async (env, dev) => { const k = randomBytes(32).toString("hex"); await call(env, "/register", { device_id: dev, key: k, platform: "mac-15" }); return k; };
  const DEV = "mac-1111-2222-3333", K = await reg(on, DEV), S = { key: K, device: DEV };

  console.log("V1 only the signed device may use /verify");
  let r = await call(on, "/verify", { op: "status", device_id: DEV });
  check("unsigned /verify refused (401)", r.status === 401, r.status);
  r = await call(on, "/verify", { op: "status" }, S);
  check("new device: no email, not verified, codes on", r.data?.student === null && r.data?.verified === false && r.data?.codes === true, JSON.stringify(r.data));

  console.log("V2 roster check (\"Is this you?\")");
  r = await call(on, "/verify", { op: "check", email: " AL@usc.edu " }, S);
  // H10: before the code is typed only a masked name is shown (no classmate's full name).
  check("roster email returns the MASKED Brightspace name", r.data?.name === "A*** S***" && r.data?.found === true && r.data?.email === "al@usc.edu", JSON.stringify(r.data));
  r = await call(on, "/verify", { op: "check", email: "al@usc.eud" }, S);
  check("typo email: not on any roster (name null)", r.status === 200 && r.data?.name === null, JSON.stringify(r.data));
  r = await call(on, "/verify", { op: "check", email: "not an email" }, S);
  check("non-email refused (400)", r.status === 400, r.status);

  console.log("V3 code flow: wrong code, then right code binds the email");
  r = await call(on, "/verify", { op: "send", email: "al@usc.edu" }, S);
  check("code sent", r.data?.sent === true && mail.length === 1 && mail[0].to === "al@usc.edu" && /^\d{6}$/.test(mail[0].code), JSON.stringify(r.data));
  const row = sqlite.prepare("SELECT * FROM email_codes WHERE device_id=?").get(DEV);
  check("only a hash of the code is stored", row && !String(row.code_hash).includes(mail[0].code) && row.code_hash.length === 64);
  check("not bound before the code", sqlite.prepare("SELECT student FROM devices WHERE device_id=?").get(DEV).student === null);
  const wrong = mail[0].code === "000000" ? "111111" : "000000";
  r = await call(on, "/verify", { op: "code", email: "al@usc.edu", code: wrong }, S);
  check("wrong code: 4 tries left", r.data?.error === "wrong_code" && r.data?.tries_left === 4, JSON.stringify(r.data));
  r = await call(on, "/verify", { op: "code", email: "al@usc.edu", code: mail[0].code }, S);
  check("right code: verified + name", r.data?.verified === true && r.data?.name === "Al Student", JSON.stringify(r.data));
  r = await call(on, "/verify", { op: "status" }, S);
  check("status now verified al@usc.edu", r.data?.verified === true && r.data?.student === "al@usc.edu", JSON.stringify(r.data));
  check("code row deleted after use", !sqlite.prepare("SELECT 1 FROM email_codes WHERE device_id=?").get(DEV));

  console.log("V4 a verified email can't be overwritten by a report (no switching to a classmate)");
  await call(on, "/report", { event: "install", student: "bo@usc.edu" }, S);
  check("student stays al@usc.edu", sqlite.prepare("SELECT student FROM devices WHERE device_id=?").get(DEV).student === "al@usc.edu");

  console.log("V5 expired code: a new one is sent automatically (no retyping the email)");
  const D2 = "win-aaaa-bbbb-cccc", K2 = await reg(on, D2), S2 = { key: K2, device: D2 };
  await call(on, "/verify", { op: "send", email: "bo@usc.edu" }, S2);
  const first = mail.at(-1).code;
  sqlite.prepare("UPDATE email_codes SET expires=? WHERE device_id=?").run(Date.now() - 1000, D2);
  const n = mail.length;
  r = await call(on, "/verify", { op: "code", email: "bo@usc.edu", code: first }, S2);
  check("expired -> error expired + resent", r.data?.error === "expired" && r.data?.resent === true && mail.length === n + 1, JSON.stringify(r.data));
  r = await call(on, "/verify", { op: "code", email: "bo@usc.edu", code: first }, S2);
  check("the old code no longer works", r.data?.error === "wrong_code", JSON.stringify(r.data));
  r = await call(on, "/verify", { op: "code", email: "bo@usc.edu", code: mail.at(-1).code }, S2);
  check("the new code works", r.data?.verified === true, JSON.stringify(r.data));

  console.log("V6 five wrong tries -> fresh code sent; changed email -> code goes to the new address");
  const D3 = "mac-9999-8888-7777", K3 = await reg(on, D3), S3 = { key: K3, device: D3 };
  await call(on, "/verify", { op: "send", email: "typo@usc.edu" }, S3);
  r = await call(on, "/verify", { op: "code", email: "al2@usc.edu", code: "123456" }, S3);
  check("code for a different email than requested -> new code to that email", r.data?.error === "no_code" && mail.at(-1).to === "al2@usc.edu", JSON.stringify(r.data));
  const good = mail.at(-1).code, bad = good === "000000" ? "111111" : "000000";
  for (let i = 0; i < 4; i++) await call(on, "/verify", { op: "code", email: "al2@usc.edu", code: bad }, S3);
  const m5 = mail.length;
  r = await call(on, "/verify", { op: "code", email: "al2@usc.edu", code: bad }, S3);
  check("5th wrong try -> too_many_tries + resent", r.data?.error === "too_many_tries" && r.data?.resent === true && mail.length === m5 + 1, JSON.stringify(r.data));
  r = await call(on, "/verify", { op: "code", email: "al2@usc.edu", code: good }, S3);
  check("the burned code is dead", r.data?.error === "wrong_code", JSON.stringify(r.data));

  console.log("V7 send rate limit: 5 codes per hour per computer");
  r = await call(on, "/verify", { op: "send", email: "al2@usc.edu" }, S3);   // 4th send this hour on D3
  r = await call(on, "/verify", { op: "send", email: "al2@usc.edu" }, S3);   // 5th
  r = await call(on, "/verify", { op: "send", email: "al2@usc.edu" }, S3);   // 6th -> refused
  check("6th code in an hour refused (429)", r.status === 429 && r.data?.error === "too_many_codes", `${r.status} ${JSON.stringify(r.data)}`);

  console.log("V8 quiz gate + Ready list count ONLY confirmed emails once codes are on");
  const D4 = "mac-4444-5555-6666", K4 = await reg(off, D4), S4 = { key: K4, device: D4 };
  await call(off, "/verify", { op: "send", email: "bo@usc.edu" }, S4);           // codes OFF: bound unconfirmed
  check("codes off: email bound after roster check (old behaviour)", sqlite.prepare("SELECT student, student_verified AS v FROM devices WHERE device_id=?").get(D4)?.student === "bo@usc.edu");
  await call(on, "/report", { event: "lock", quiz_id: LOCK_ID }, S4);
  await call(on, "/report", { event: "lock", quiz_id: LOCK_ID }, S);
  r = await get(on, "/live?quiz=" + LOCK_ID);
  const rows = r.data?.rows || [];
  const al = rows.find(x => x.device_id === DEV), bo = rows.find(x => x.device_id === D4);
  check("confirmed al: eligible with Brightspace user_id 4001", al?.eligible === true && al?.user_id === "4001", JSON.stringify(al));
  check("unconfirmed device: no user_id -> gate never admits it", bo && !bo.user_id, JSON.stringify(bo));
  r = await get(off, "/live?quiz=" + LOCK_ID);
  check("codes off: unconfirmed device still admitted (no regression before mail is set up)", (r.data?.rows || []).find(x => x.device_id === D4)?.user_id === "4002");

  console.log("V9 codes off: /verify send binds without a code; a verified email is never replaced");
  r = await call(off, "/verify", { op: "send", email: "bo@usc.edu" }, S);
  check("verified device keeps al@usc.edu", sqlite.prepare("SELECT student FROM devices WHERE device_id=?").get(DEV).student === "al@usc.edu");

  console.log("V11 write budget: a heartbeat touches devices.last_seen at most every 10 minutes");
  sqlite.prepare("UPDATE devices SET last_seen=? WHERE device_id=?").run(new Date(Date.now() - 60000).toISOString(), DEV);
  const ls1 = sqlite.prepare("SELECT last_seen FROM devices WHERE device_id=?").get(DEV).last_seen;
  await call(on, "/report", { event: "heartbeat", quiz_id: LOCK_ID, source: "helper" }, S);
  check("recent last_seen: heartbeat writes no devices row", sqlite.prepare("SELECT last_seen FROM devices WHERE device_id=?").get(DEV).last_seen === ls1);
  sqlite.prepare("UPDATE devices SET last_seen=? WHERE device_id=?").run(new Date(Date.now() - 700000).toISOString(), DEV);
  await call(on, "/report", { event: "heartbeat", quiz_id: LOCK_ID, source: "helper" }, S);
  check("stale last_seen (>10 min): heartbeat refreshes it", Date.now() - Date.parse(sqlite.prepare("SELECT last_seen FROM devices WHERE device_id=?").get(DEV).last_seen) < 5000);

  console.log("V12 write budget: re-syncing an unchanged class writes nothing; changes write only the change");
  const course = (list, quizzes = []) => ({ courses: [{ ou: "55555", name: "FBE 101", code: "FBE-101", role: "Instructor", classlist: list, quizzes }] });
  const cl = [{ id: "7001", name: "Cy Student", email: "CY@usc.edu", role: "Student" }, { id: "7002", name: "Di Student", email: "di@usc.edu", role: "Student" }];
  const qz = [{ qi: "880", name: "Quiz A", active: true }];
  await call(on, "/sync", course(cl, qz), { teacher: ADMIN });
  const stamp = () => sqlite.prepare("SELECT user_id, synced_at FROM roster WHERE ou='55555' ORDER BY user_id").all().map(r => r.user_id + "@" + r.synced_at).join(",");
  const qstamp = () => sqlite.prepare("SELECT synced_at FROM bs_quizzes WHERE ou='55555' AND qi='880'").get()?.synced_at;
  const s1 = stamp(), q1 = qstamp();
  check("first sync stores the class (email lowercased)", sqlite.prepare("SELECT email FROM roster WHERE ou='55555' AND user_id='7001'").get()?.email === "cy@usc.edu" && !!q1);
  await new Promise(r => setTimeout(r, 15));
  await call(on, "/sync", course(cl, qz), { teacher: ADMIN });
  check("identical re-sync rewrites no roster or quiz row", stamp() === s1 && qstamp() === q1, stamp() + " vs " + s1);
  await call(on, "/sync", course([cl[0]], qz), { teacher: ADMIN });
  check("a dropped student is removed, the other row untouched", sqlite.prepare("SELECT COUNT(*) AS n FROM roster WHERE ou='55555'").get().n === 1 && stamp() === s1.split(",")[0]);

  console.log("V13 /live quiz match: exact id and course prefix both use the range (no LIKE)");
  r = await get(on, "/live?quiz=" + OU);
  check("course-level /live still finds the quiz's locks", (r.data?.rows || []).some(x => x.device_id === DEV), JSON.stringify(r.data).slice(0, 200));

  console.log("V10 SMTP client: real conversation with a fake Gmail server");
  const said = [];
  const fakeSmtp = (codes) => async () => {
    const replies = [...codes]; let ctl;
    const readable = new ReadableStream({ start(c) { ctl = c; c.enqueue(new TextEncoder().encode(replies.shift())); } });
    let data = false, msg = "";
    const writable = new WritableStream({ write(chunk) {
      const t = new TextDecoder().decode(chunk);
      if (data) { msg += t; if (msg.endsWith("\r\n.\r\n")) { data = false; said.push("MSG:" + msg); ctl.enqueue(new TextEncoder().encode(replies.shift())); } return; }
      said.push(t.trim());
      if (t.startsWith("QUIT")) return;
      if (t.startsWith("DATA")) data = true;
      const rep = replies.shift(); if (rep) ctl.enqueue(new TextEncoder().encode(rep));
    } });
    return { readable, writable, close: async () => {} };
  };
  const OK = ["220 smtp.gmail.com ESMTP\r\n", "250-smtp.gmail.com\r\n250-AUTH PLAIN\r\n250 SMTPUTF8\r\n", "235 2.7.0 Accepted\r\n", "250 OK\r\n", "250 OK\r\n", "354 Go\r\n", "250 2.0.0 queued\r\n"];
  const smtpEnv = { DB: d1(sqlite), TEACHER_KEY: ADMIN, REQUIRE_SIGNED: "1", MAIL_USER: "lockqz@gmail.com", MAIL_APP_PASSWORD: "abcd efgh ijkl mnop", MAIL_OPEN: fakeSmtp(OK) };
  const D5 = "mac-5555-0000-1111", K5 = await reg(smtpEnv, D5);
  r = await call(smtpEnv, "/verify", { op: "send", email: "al@usc.edu" }, { key: K5, device: D5 });
  check("send through SMTP succeeds", r.data?.sent === true, JSON.stringify(r.data));
  check("EHLO, AUTH PLAIN with the app password (spaces removed), MAIL/RCPT", said[0].startsWith("EHLO") && said[1] === "AUTH PLAIN " + Buffer.from("\0lockqz@gmail.com\0abcdefghijklmnop").toString("base64") && said[2] === "MAIL FROM:<lockqz@gmail.com>" && said[3] === "RCPT TO:<al@usc.edu>", JSON.stringify(said.slice(0, 4)));
  const body = said.find(x => x.startsWith("MSG:")) || "";
  check("message carries From/To/Subject and the code", /From: LOCKqz <lockqz@gmail.com>/.test(body) && /To: <al@usc.edu>/.test(body) && /Subject: Your LOCKqz code: \d{6}/.test(body), body.slice(0, 200));
  const badEnv = { ...smtpEnv, MAIL_OPEN: fakeSmtp(["220 hi\r\n", "250 ok\r\n", "535 5.7.8 Username and Password not accepted\r\n"]) };
  const D6 = "mac-6666-0000-1111", K6 = await reg(badEnv, D6);
  r = await call(badEnv, "/verify", { op: "send", email: "al@usc.edu" }, { key: K6, device: D6 });
  check("bad app password -> send_failed (502), logged, no code stored", r.status === 502 && r.data?.error === "send_failed" && !sqlite.prepare("SELECT 1 FROM email_codes WHERE device_id=?").get(D6) && !!sqlite.prepare("SELECT 1 FROM events WHERE device_id=? AND event='code_send_failed'").get(D6), JSON.stringify(r.data));
}

await suite("fresh schema", false);
await suite("old schema + migrate_014", true);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
