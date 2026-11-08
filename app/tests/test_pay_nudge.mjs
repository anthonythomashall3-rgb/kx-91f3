// One reminder email to pay (8 Nov 2026): a student whose LOCKqz is installed (school email confirmed) and who
// has not paid 2 hours later gets ONE email with their pay link, sent by the hourly /pay/tick.
// Real API, in-memory SQLite (schema.sql + every migration), email mocked, clock moved by hand.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-nudge-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch (e) { /* already in schema.sql */ } }
const DB = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
  const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
    first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
    run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } }; return o; },
  async batch(sts) { for (const s of sts) s._run(); } };
const mails = [];
const SECRET = "test-pay-secret-0123456789";
// Prices as in wrangler.toml (8 Nov): $200 Zelle, $210 card / Venmo.
const env = { DB, TEACHER_KEY: "admin-key", PAY_SECRET: SECRET, MAIL_SINK: async m => { mails.push(m); },
  STUDENT_FEE: "180", STUDENT_FEE_FROM: "2026-10-25", STUDENT_OTHER_PRICE: "210", STUDENT_TOTAL: "200", STUDENT_OTHER_TOTAL: "210", PAID_CACHE_MS: "0" };
const RealDate = Date; let fakeNow = RealDate.now();
class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fakeNow); } static now() { return fakeNow; } }
globalThis.Date = FakeDate;
const at = iso => { fakeNow = RealDate.parse(iso); };
const tick = (e = env) => onRequest({ request: new Request("https://lockqz.test/api/pay/tick", { method: "POST", headers: { "X-LOCKqz-Pay": SECRET } }), env: e }).then(r => r.json());
const dev = (id, email, installed, verified = 1, revoked = 0) => sqlite.prepare("INSERT INTO devices (device_id,student,platform,installed_at,student_verified,revoked) VALUES (?,?,?,?,?,?)").run(id, email, "windows", installed, verified, revoked);
const to = m => [].concat(m.to || []).join(",");
const sentTo = e => mails.filter(m => to(m).includes(e));

try {
  at("2026-11-09T20:00:00Z");
  dev("d-new", "new@usc.edu", "2026-11-09T19:00:00Z");              // installed 1 h ago
  dev("d-due", "due@usc.edu", "2026-11-09T17:30:00Z");              // 2.5 h ago, unpaid
  dev("d-unv", "typo@usc.edu", "2026-11-09T17:00:00Z", 0);          // email never confirmed
  dev("d-old", "old@usc.edu", "2026-10-20T17:00:00Z");              // installed weeks ago
  dev("d-rev", "rev@usc.edu", "2026-11-09T17:00:00Z", 1, 1);        // revoked device
  dev("d-paid", "paid@usc.edu", "2026-11-09T16:00:00Z");            // already paid
  sqlite.prepare("INSERT INTO pay_codes_students (email,code) VALUES (?,?)").run("paid@usc.edu", "LQSPAID1");
  sqlite.prepare("INSERT INTO payments (txn,code,amount,via,term,received_at) VALUES (?,?,?,?,?,?)").run("t1", "LQSPAID1", 200, "zelle", "20263", "2026-11-09T16:30:00Z");

  console.log("N1 the hourly tick emails only installed, confirmed, unpaid students 2 h after install");
  let r = await tick();
  check("tick answers with the reminder count", r.nudge && r.nudge.sent === 1, JSON.stringify(r.nudge));
  check("due@ (2.5 h, unpaid) gets the reminder", sentTo("due@usc.edu").length === 1);
  check("new@ (1 h) does not get it yet", sentTo("new@usc.edu").length === 0);
  check("unconfirmed, weeks-old and revoked installs get nothing", !sentTo("typo@usc.edu").length && !sentTo("old@usc.edu").length && !sentTo("rev@usc.edu").length);
  check("paid@ gets nothing (and is never checked again)", !sentTo("paid@usc.edu").length && sqlite.prepare("SELECT sent FROM pay_nudge WHERE email='paid@usc.edu'").get()?.sent === 0);

  console.log("N2 the email");
  const m = sentTo("due@usc.edu")[0], body = String(m.text || "");
  check("subject", m.subject === "One step left: pay for LOCKqz", m.subject);
  check("carries the student's own pay link", /\/pay\?email=due%40usc\.edu&t=[0-9a-f]{32}/.test(body), body);
  check("says the prices: $200 Zelle, $210 card or Venmo", body.includes("$200 by Zelle") && body.includes("$210 by card or Venmo"), body);
  check("branded HTML version", /<html|<table|<div/i.test(String(m.html || "")));

  console.log("N3 once per student, ever");
  at("2026-11-09T21:05:00Z");
  r = await tick();
  check("next hour: new@ (now 2 h) gets it, due@ not again", sentTo("new@usc.edu").length === 1 && sentTo("due@usc.edu").length === 1, JSON.stringify(r.nudge));
  dev("d-due2", "due@usc.edu", "2026-11-09T18:00:00Z");   // a second computer, same student
  at("2026-11-10T03:00:00Z"); await tick();
  check("a second install by the same student: still one email", sentTo("due@usc.edu").length === 1);

  console.log("N4 switches");
  dev("d-x", "x@usc.edu", "2026-11-10T00:00:00Z");
  const n0 = mails.length;
  r = await tick({ ...env, PAY_NUDGE_HOURS: "0" });
  check("PAY_NUDGE_HOURS=0 turns it off", mails.length === n0 && r.nudge?.why === "off", JSON.stringify(r.nudge));
  r = await tick({ ...env, STUDENT_FEE_FROM: "" });
  check("no student fee -> no reminders", mails.length === n0 && r.nudge?.why === "fee off", JSON.stringify(r.nudge));
  const { MAIL_SINK, ...noMail } = env;
  r = await tick(noMail);
  check("email off -> nothing recorded, sent later", r.nudge?.why === "mail off" && !sqlite.prepare("SELECT 1 FROM pay_nudge WHERE email='x@usc.edu'").get());
  r = await tick();
  check("then sent once email works", sentTo("x@usc.edu").length === 1);
  const bad = await onRequest({ request: new Request("https://lockqz.test/api/pay/tick", { method: "POST", headers: { "X-LOCKqz-Pay": "wrong" } }), env }).then(x => x.status);
  check("/pay/tick still needs the script's key", bad === 401);
} catch (e) { fail++; console.log("  FAIL: threw", e && e.stack || e); }

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
