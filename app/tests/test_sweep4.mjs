// Bug sweep round 4 (10 Nov 2026): what students and professors read in LOCKqz's emails.
//   E1 the install email a professor sends his class (Email students) and the reminders: one install step
//      (lockqz.com shows the steps for the computer it is opened on), and while the semester fee is on, the fee
//      with every way to pay at its own price ("$200 by Zelle, or $210 by card or Venmo"), "Install it and pay";
//      never "Nothing else to do, ever." while students still have to pay.
//   E2 the renewal email at the start of a semester: each way to pay at its own price (students: no bank
//      transfer, which they cannot use), the end date in words, the memo only for Zelle / Venmo.
// Real API, in-memory SQLite, mail captured.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-sweep4-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
function d1real(sqlite) {
  const mk = () => { let args = [], st = null;
    return { _sql(sql){ st = sqlite.prepare(sql); return this; },
      bind(...a){ args = a.map(x => x===undefined?null:typeof x==="boolean"?Number(x):x); this._run=()=>st.run(...args); return this; },
      first: async()=> st.get(...args) ?? null, all: async()=>({results:st.all(...args)}),
      run: async()=>({meta:{changes:Number(st.run(...args).changes)}}) }; };
  return { prepare(sql){ return mk()._sql(sql); }, async batch(sts){ const out = []; for (const s of sts) out.push({ meta: { changes: Number(s._run().changes) } }); return out; } };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort()) { try { sqlite.exec(readFileSync(join(CF, m), "utf8")); } catch (e) { if (!/duplicate column|already exists|table .* already/.test(e.message)) throw e; } }
const mail = [], SECRET = "pay-secret-sweep4-0123456789";
// Production's ways to pay (wrangler.toml): Zelle, Venmo for students, Stripe card, bank transfer for professors.
const PROD = { STUDENT_FEE: "180", STUDENT_TOTAL: "200", STUDENT_OTHER_TOTAL: "210", STUDENT_OTHER_PRICE: "210", STUDENT_CARD_PRICE: "210",
  PROF_TOTAL: "6500", PROF_CARD_TOTAL: "6500", PROF_ZELLE_TOTAL: "6300", PROF_BANK_TOTAL: "6500", ZELLE_TO: "(858) 900-4347", VENMO_HANDLE: "LOCKqz",
  STUDENT_VENMO: "1", STRIPE_SECRET_KEY: "sk_test_sweep4", STRIPE_WEBHOOK_SECRET: "whsec_sweep4", INVOICE_EMAIL: "support@lockqz.com" };
const env = { DB: d1real(sqlite), TEACHER_KEY: "tk-s4", REQUIRE_SIGNED: "1", ROT_SECRET: "rs-s4", PW_PEPPER: "pep-s4", LIVE_CACHE_MS: "0", PAID_CACHE_MS: "0",
  PAY_SECRET: SECRET, MAIL_SINK: async m => { mail.push(m); return true; }, FEE_EXEMPT: "prof@usc.edu", ADMIN_EMAIL: "admin@usc.edu", ...PROD };
async function call(path, body, { token = null, get = false, hdr = {}, envx = {} } = {}) {
  const h = { "Content-Type": "application/json", "CF-Connecting-IP": "10.5.0.1", ...hdr };
  if (token) h["X-LOCKqz-Teacher"] = token;
  const res = await onRequest({ request: new Request("https://lockqz.test/api" + path, get ? { method: "GET", headers: h } : { method: "POST", headers: h, body: JSON.stringify(body ?? {}) }), env: { ...env, ...envx }, waitUntil: () => {} });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const now = () => new Date().toISOString();

// Admin, and a verified professor who teaches one class with 2 students and an exam in 10 days.
const ADMIN = (await call("/signup", { email: "admin@usc.edu", password: "adminpass1", name: "Anthony Hall" })).data.token;
const PROF = (await call("/signup", { email: "prof@usc.edu", password: "profpass12", name: "Duke Bristow" })).data.token;
sqlite.prepare("UPDATE teachers SET verified=1, vouched=1, bs_user_id='4000', active_until='2099-12-31' WHERE email='prof@usc.edu'").run();
const PID = sqlite.prepare("SELECT id FROM teachers WHERE email='prof@usc.edu'").get().id;
const OU = "98001", soon = new Date(Date.now() + 10 * 864e5).toISOString();
sqlite.prepare("INSERT INTO teacher_courses (teacher_id,ou,name,code,role,synced_at,in_sync) VALUES (?,?,?,?,?,?,1)").run(PID, OU, "20263_14792 BUAD-306: Business Finance", "20263_14792", "Instructor", now());
const ros = sqlite.prepare("INSERT INTO roster (ou,user_id,name,email,username,org_id,role,synced_at) VALUES (?,?,?,?,?,?,?,?)");
ros.run(OU, "4000", "Bristow, Duke", "prof@usc.edu", "dbristow", "1", "Instructor", now());
ros.run(OU, "5001", "Al Able", "al@usc.edu", "al", "2", "Student", now());
ros.run(OU, "5002", "Bo Baker", "bo@usc.edu", "bo", "3", "Student", now());
sqlite.prepare("INSERT INTO bs_quizzes (ou,qi,name,active,start_date,end_date,synced_at) VALUES (?,?,?,?,?,?,?)").run(OU, "601", "Midterm", 1, soon, soon, now());

console.log("E1 the install email and the reminder");
const feeOn = { STUDENT_FEE_FROM: "2026-10-25" }, feeOff = { STUDENT_FEE_FROM: "" };
let r = await call("/email/students", { ou: OU, kind: "all" }, { token: PROF, envx: feeOn });
const t1 = r.data?.text || "";
check("fee on: 'Install it and pay before the exam. Without both, the exam will not open.'", /Install it and pay before the exam\. Without both, the exam will not open\./.test(t1), t1.slice(0, 400));
check("fee on: 1 install step for any computer, 2 the fee with every way at its price, 3 Brightspace",
  /1\. Install LOCKqz on your computer: https:\/\/lockqz\.(com|pages\.dev) — follow the steps there \(about one minute\)\.\n2\. Pay for this semester when LOCKqz asks: \$200 by Zelle, or \$210 by card or Venmo\.\n3\. Open Brightspace once/.test(t1), t1);
check("fee on: 'Nothing else to do this semester.' (never 'ever'); no 'choose Mac or Windows' / 'Open the downloaded file'",
  /Nothing else to do this semester\./.test(t1) && !/ever\.|choose Mac or Windows|downloaded file/.test(t1));
check("subject and class name as students know them: 'BUAD-306: install LOCKqz ...', 'BUAD-306: Business Finance uses LOCKqz' (never the Brightspace code 20263_14792)",
  r.data?.subject === "BUAD-306: install LOCKqz before your first exam" && /^Hi,\n\nBUAD-306: Business Finance uses LOCKqz for exams\./.test(t1) && !/20263_14792/.test(t1 + r.data?.subject), (r.data?.subject || "") + " | " + t1.slice(0, 120));
check("...and signed with it ('Professor Duke Bristow' / 'BUAD-306: Business Finance')", /Respectfully,\nProfessor Duke Bristow\nBUAD-306: Business Finance/.test(t1), t1.slice(-300));
r = await call("/email/students", { ou: OU, kind: "all" }, { token: PROF, envx: feeOff });
const t2 = r.data?.text || "";
check("fee off: 2 steps, no fee, 'Install it before the exam.', 'Nothing else to do, ever.'",
  /1\. Install LOCKqz on your computer[^\n]*\n2\. Open Brightspace once/.test(t2) && !/Pay for this semester|\$200/.test(t2) && /Install it before the exam\./.test(t2) && /Nothing else to do, ever\./.test(t2), t2.slice(0, 500));
r = await call("/email/students", { ou: OU, kind: "missing" }, { token: PROF, envx: feeOn });
const t3 = r.data?.text || "";
check("reminder (not installed), fee on: the same 3 steps with the fee, the class as students know it", /^Reminder: install LOCKqz before /.test(r.data?.subject || "") && /2\. Pay for this semester when LOCKqz asks: \$200 by Zelle, or \$210 by card or Venmo\./.test(t3) && /for BUAD-306: Business Finance is/.test(t3) && !/20263_14792/.test(t3), (r.data?.subject || "") + " | " + t3.slice(0, 300));
sqlite.prepare("INSERT INTO devices (device_id, device_key, student, student_verified, installed_at, last_seen, platform) VALUES ('dev-al','k','al@usc.edu',1,?,?,'mac-15')").run(now(), now());
r = await call("/email/students", { ou: OU, kind: "missing" }, { token: PROF, envx: feeOn });
check("mixed class (one installed but unpaid): the pay line links the pay page (lockqz.com/pay), not the download page",
  /Already installed LOCKqz\? Then your semester fee is not paid — pay at https:\/\/lockqz\.com\/pay before the exam\./.test(r.data?.text || ""), (r.data?.text || "").slice(0, 600));
// Set-up step 3: ONE email for every class; two sections of FBE-437 are one course to a student.
for (const [ou, sec] of [["98002", "15351"], ["98003", "15353"]]) {
  sqlite.prepare("INSERT INTO teacher_courses (teacher_id,ou,name,code,role,synced_at,in_sync) VALUES (?,?,?,?,?,?,1)").run(PID, ou, `20263_${sec} FBE-437: Entrepreneurial Finance`, `20263_${sec}`, "Instructor", now());
  ros.run(ou, "4000", "Bristow, Duke", "prof@usc.edu", "dbristow", "1", "Instructor", now()); ros.run(ou, "6" + sec, "Cy " + sec, `cy${sec}@usc.edu`, "cy" + sec, "4", "Student", now()); }
r = await call("/email/students", { ous: [OU, "98002", "98003"] }, { token: PROF, envx: feeOn });
check("one email for all his classes: 'BUAD-306 and FBE-437 use LOCKqz for exams.' (no section codes, FBE-437 once)",
  /^Hi,\n\nBUAD-306 and FBE-437 use LOCKqz for exams\./.test(r.data?.text || "") && !/20263_/.test(r.data?.text || "") && (r.data?.to || []).length === 4, (r.data?.text || "").slice(0, 160) + " | " + JSON.stringify(r.data?.to));

console.log("E2 the renewal email when a new semester starts");
sqlite.prepare("INSERT INTO pay_codes_students (email, code) VALUES ('stu@usc.edu','LQSREN01')").run();
sqlite.prepare("INSERT INTO payments (txn,code,amount,via,payer,note,term,received_at,matched) VALUES ('ren-s','LQSREN01',200,'zelle','Stu','LQSREN01','20263',?,'student')").run(now());
const PAYP = (await call("/signup", { email: "payer@usc.edu", password: "payerpass1", name: "Pat Payer" })).data.token;
const PPID = sqlite.prepare("SELECT id FROM teachers WHERE email='payer@usc.edu'").get().id;
sqlite.prepare("INSERT INTO pay_codes (teacher_id, code) VALUES (?, 'LQPREN01')").run(PPID);
sqlite.prepare("INSERT INTO payments (txn,code,amount,via,payer,note,term,received_at,matched) VALUES ('ren-p','LQPREN01',6300,'zelle','Pat','LQPREN01','20263',?,'professor')").run(now());
const RealDate = Date, FIX = RealDate.parse("2027-01-06T20:00:00Z");
class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [FIX])); } static now() { return FIX; } }
globalThis.Date = FakeDate;
try { r = await call("/pay/tick", {}, { hdr: { "X-LOCKqz-Pay": SECRET }, envx: feeOn }); } finally { globalThis.Date = RealDate; }
const rs = mail.find(m => m.to === "stu@usc.edu" && m.subject === "Renew LOCKqz"), rp = mail.find(m => m.to === "payer@usc.edu" && m.subject === "Renew LOCKqz");
check("both renewal emails sent (student, professor)", !!rs && !!rp, JSON.stringify(r.data).slice(0, 200) + " | " + mail.map(m => m.to + ":" + m.subject).join(", "));
check("student: 'LOCKqz renews for Spring 2027.', pay link, '$200 by Zelle, or $210 by card or Venmo. Memo for Zelle or Venmo: LQSREN01.'",
  /^LOCKqz renews for Spring 2027\.\n\nPay here: https:\/\/lockqz\.(com|pages\.dev)\/pay\?/.test(rs?.text || "") && /\$200 by Zelle, or \$210 by card or Venmo\. Memo for Zelle or Venmo: LQSREN01\./.test(rs?.text || ""), rs?.text);
check("student: no bank transfer (students cannot pay that way)", !/[Bb]ank transfer/.test(rs?.text || ""));
check("student: the end date in words ('lasts until May 12, 2027'), not 2027-05-12", /lasts until May 1\d, 2027\./.test(rs?.text || "") && !/\d{4}-\d{2}-\d{2}/.test(rs?.text || ""), rs?.text);
check("professor: '$6,300 by Zelle, or $6,500 by bank transfer, card or Venmo', on his dashboard",
  /Pay on your LOCKqz dashboard: https:\/\/(professor\.lockqz\.com|prof\.lockqz\.pages\.dev)\/?\n\n\$6,300 by Zelle, or \$6,500 by bank transfer, card or Venmo\. Memo for Zelle or Venmo: LQPREN01\./.test(rp?.text || ""), rp?.text);

{ // card-only mode (STUDENT_CARD_ONLY with Stripe on): the emails name only the card, as the pay page does
  const r1 = await call("/email/students", { ou: OU, kind: "all" }, { token: PROF, envx: { ...feeOn, STUDENT_CARD_ONLY: "1" } });
  check("card-only mode: the install email names only the card ('$210 by card'), no Zelle / Venmo", /2\. Pay for this semester when LOCKqz asks: \$210 by card\./.test(r1.data?.text || "") && !/Zelle|Venmo/.test(r1.data?.text || ""), (r1.data?.text || "").slice(0, 500)); }
{ // class lists read the way people read them
  for (const [u, nm] of [["5101", "de la Cruz, Ana"], ["5102", "Zhang, Wei"], ["5103", "Student 10"], ["5104", "Student 2"], ["5105", "Davis, Al"]]) ros.run(OU, u, nm, `n${u}@usc.edu`, "n" + u, "9", "Student", now());
  sqlite.prepare("DELETE FROM roster_snap WHERE ou=?").run(OU);
  const names = ((await call("/bs", null, { token: PROF, get: true })).data?.courses?.find(c => c.ou === OU)?.students || []).map(x => x.name);
  const at = n => names.indexOf(n);
  check("students sorted as people read them: 'de la Cruz' among the Ds (not after 'Zhang'), 'Student 2' before 'Student 10'",
    at("Davis, Al") < at("de la Cruz, Ana") && at("de la Cruz, Ana") < at("Zhang, Wei") && at("Student 2") < at("Student 10") && at("Student 2") >= 0, JSON.stringify(names)); }
console.log("P the student download page on a Chromebook");
{ const idx = readFileSync(join(CF, "public", "index.html"), "utf8");
  check("a Chromebook is told LOCKqz needs a Mac, Windows or Linux computer (not 'Open on your computer')", /\/CrOS\/\.test\(ua\)\) \$\("nope"\)\.textContent = "LOCKqz needs a Mac, Windows or Linux computer\. It does not run on Chromebooks\.";/.test(idx)); }
console.log("X the Brightspace Sync panel (sync.js, extension 1.0.6)");
{ const sj = readFileSync(join(CF, "public", "sync.js"), "utf8");
  check("panel counts: '1 student', '1 quiz' (no '1 students', '1 quizzes')", sj.includes('" student" + (students === 1 ? "" : "s")') && sj.includes('" quiz" + (nq === 1 ? "" : "zes")') && !sj.includes('" students, " + nq + " quizzes'));
  check("panel Send email: one install step for any computer, the fee from LOCKqz while it is on (no 'Click Download and run the installer')",
    sj.includes('Install LOCKqz on your computer: " + INSTALL') && sj.includes('Pay for this semester when LOCKqz asks: " + fee') && !sj.includes("Click Download and run the installer"));
  check("sync.js stays pure ASCII (it runs inside Brightspace)", !/[^\x00-\x7f]/.test(sj));
  const man = JSON.parse(readFileSync(join(CF, "..", "extension-prof", "manifest.json"), "utf8"));
  check("extension version 1.0.6", man.version === "1.0.6", man.version);
  const SYNC = { courses: [{ ou: "98010", name: "X", code: "X", role: "Instructor", classlist: [], quizzes: [] }] };
  const on = await call("/sync", SYNC, { token: PROF, envx: feeOn }), off = await call("/sync", SYNC, { token: PROF, envx: feeOff });
  check("/sync tells the panel the fee while it is on ('$200 by Zelle, or $210 by card or Venmo'), null when off", on.data?.fee === "$200 by Zelle, or $210 by card or Venmo" && off.data?.fee === null, JSON.stringify([on.data?.fee, off.data?.fee])); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
