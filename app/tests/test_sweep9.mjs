import { payT } from "./pay_t.mjs";
// Bug sweep 9 (10 Nov 2026), real API on in-memory SQLite (production prices), clock moved where a section needs it:
//   S1 "Access until" on the pay page is the last day of what the student PAID. (From 6 weeks before a term until 2
//      weeks before the current one ends -- 30 Nov-1 Dec, 7-27 Apr, 11-26 Jul -- a student paid for this term only
//      was shown the NEXT term's last day.)
//   S2 a professor's email on the student pay page (the "Stop these emails" link of his renewal email): told to pay
//      on the dashboard; the student fee page is never shown for it.
//   S3 the bank-transfer email names Zelle at Zelle's own price (professors: $6,300, not the $6,500 transfer price).
//   S4 sign-up and password-reset codes get the big code box in the email, like the students' codes.
//   S5 "Let in" / "Undo" on the live page works for an email with an apostrophe (o'brien@...) (real Chromium).
//   S7 Admin > Payments: a payment moved from one professor to another takes its activation with it.
//   S6 exams of one class that start together (versions A / B, an extended-time copy) send ONE reminder to students
//      who are not ready, 2 days and 3 hours before -- not one per exam.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const CF = join(HERE, "..", "cloudflare"), PUB = join(CF, "public");
const tmp = mkdtempSync(join(tmpdir(), "lqz-sweep9-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
const RealDate = Date; let fakeNow = null;
class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fakeNow ?? RealDate.now()); } static now() { return fakeNow ?? RealDate.now(); } }
globalThis.Date = FakeDate;
const at = iso => { fakeNow = iso == null ? null : RealDate.parse(iso); };

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch {} }
const db = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
  const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
    first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
    run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } }; return o; },
  async batch(sts) { sqlite.exec("BEGIN"); try { for (const s of sts) s._run(); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; } return []; } };
const MAILS = [], SECRET = "pay-secret-s9-0123456789";
// Production's prices and ways (wrangler.toml), fee on.
const env = { DB: db, TEACHER_KEY: "admin-key-s9", REQUIRE_SIGNED: "1", ADMIN_EMAIL: "admin@usc.edu", ROT_SECRET: "rot-s9", LIVE_CACHE_MS: "0", PAID_CACHE_MS: "0",
  PAY_SECRET: SECRET, MAIL_SINK: async m => { MAILS.push(m); return true; },
  STUDENT_FEE: "180", STUDENT_FEE_FROM: "2000-01-01", STUDENT_TOTAL: "200", STUDENT_OTHER_TOTAL: "210", STUDENT_OTHER_PRICE: "210", STUDENT_CARD_PRICE: "210",
  STUDENT_OTHER_TOTAL_PREV: "200", STUDENT_OTHER_FROM: "2026-11-08T20:00:00Z", TAX_RATE: "0.25", TAX_FROM: "2026-10-26T13:00:00Z",
  PROF_TOTAL: "6500", PROF_CARD_TOTAL: "6500", PROF_ZELLE_TOTAL: "6300", PROF_BANK_TOTAL: "6500", PROF_OTHER_PRICE: "5000", ZELLE_TO: "(858) 900-4347", VENMO_HANDLE: "LOCKqz",
  STUDENT_VENMO: "1", INVOICE_EMAIL: "support@lockqz.com", BANK_DETAILS: "Bank: Test Bank", REQUIRE_GATE: "1" };
let ipN = 0;
async function call(path, body, { teacher = null, pay = false, get = false } = {}) {
  const h = { "Content-Type": "application/json", "CF-Connecting-IP": "10.9." + ((++ipN >> 8) & 255) + "." + (ipN & 255) };
  if (teacher) h["X-LOCKqz-Teacher"] = teacher; if (pay) h["X-LOCKqz-Pay"] = SECRET;
  const res = await onRequest({ request: new Request("https://lockqz.test/api" + path, { method: get ? "GET" : "POST", headers: h, body: get ? undefined : JSON.stringify(body ?? {}) }), env, waitUntil: () => {} });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const payStart = em => call("/pay/start", { email: em, t: payT(env, em) });
const zelle = async (em, amount = 200) => { const code = (await payStart(em)).data?.code;
  return (await call("/pay/notify", { payments: [{ txn: "s9-" + em + "-" + Date.now() + "-" + (++ipN), amount, payer: "P", note: code, via: "zelle" }] }, { pay: true })).data?.results?.[0]; };

try {
  console.log("S1 'Access until' on the pay page = the last day of what the student paid");
  for (const [d, counted, until, was] of [
    ["2026-11-10", "20263", "2026-12-16", null],
    ["2026-11-30", "20263", "2026-12-16", "2027-05-12"],
    ["2026-12-01", "20263", "2026-12-16", "2027-05-12"],
    ["2026-12-05", "20271", "2027-05-12", null],          // last 2 weeks: the payment counts for Spring (and the rest of Fall)
    ["2027-04-15", "20271", "2027-05-12", "2027-08-10"],
    ["2027-07-20", "20272", "2027-08-10", "2027-12-18"]]) {
    at(d + "T20:00:00Z");
    const em = "s9-" + d + "@usc.edu", before = (await payStart(em)).data, r = await zelle(em), s = (await payStart(em)).data;
    check(`${d}: before paying, 'until' is the last day of the term the payment will count for (${counted})`, before?.paid === false && before.until === until, `${before?.until}`);
    check(`${d}: $200 Zelle counts for ${counted}; the pay page then says paid, access until ${until}` + (was ? ` (was ${was})` : ""), r?.paid === true && r.term === counted && s?.paid === true && s.until === until, `${r?.term} ${s?.until}`);
  }
  {
    at("2026-11-30T20:00:00Z");
    const em = "s9-both@usc.edu"; await zelle(em); const r2 = await zelle(em), s = (await payStart(em)).data;
    check("paid this term AND the next one: until = the next term's last day", r2?.term === "20271" && s?.paid === true && s.until === "2027-05-12", `${r2?.term} ${s?.until}`);
    at("2026-12-20T20:00:00Z");
    const g = (await payStart(em)).data;
    check("between terms, paid for the next one: until = its last day", g?.paid === true && g.until === "2027-05-12", `${g?.paid} ${g?.until}`);
  }
  at(null);

  console.log("S2 a professor's email on the student pay page: pay on the dashboard (never the student fee)");
  const ADMIN = (await call("/signup", { email: "admin@usc.edu", password: "adminpass1", name: "Anthony Hall" })).data?.token;
  const inv = (await call("/invite", { email: "prof9@usc.edu" }, { teacher: ADMIN })).data?.code;
  const P = (await call("/signup", { email: "prof9@usc.edu", password: "profpass12", name: "Pat Prof", invite: inv })).data?.token;
  {
    const off = await call("/pay/renew", { email: "prof9@usc.edu", on: false, t: payT(env, "prof9@usc.edu") });
    const s = (await payStart("prof9@usc.edu")).data;
    check("'Stop these emails' still turns the professor's renewal emails off", off.status === 200 && off.data?.ok === true, JSON.stringify(off.data));
    check("the pay page is told it is a professor account: no memo code, no student price, renew state kept", s?.professor === true && !s.code && !s.ways && s.renew === false && /professor\.lockqz\.com/.test(String(s.dashboard)), JSON.stringify(s));
    check("no student pay code was made for the professor", !sqlite.prepare("SELECT 1 FROM pay_codes_students WHERE email='prof9@usc.edu'").get());
    const page = readFileSync(join(PUB, "pay.html"), "utf8");
    check("pay.html shows 'Professors pay on the dashboard' for it", /if \(d\.professor\)/.test(page) && /Professors pay on the dashboard/.test(page));
    const a = (await payStart("admin@usc.edu")).data;
    check("the admin (takes quizzes himself) still gets the student page: paid, no fee", a?.paid === true && !a.professor, JSON.stringify(a).slice(0, 120));
    const st = (await payStart("s9-plain@usc.edu")).data;
    check("a student is unchanged: memo code + prices", !!st?.code && st.ways?.zelle?.total === 200 && st.ways.card.total === 210 && !st.professor, JSON.stringify(st).slice(0, 160));
  }

  console.log("S3 the bank-transfer email names Zelle at Zelle's own price");
  {
    const k = MAILS.length, r = await call("/pay/bank", { email: "prof9@usc.edu", t: payT(env, "prof9@usc.edu") }), m = MAILS.slice(k).find(x => x.to === "prof9@usc.edu");
    check("professor asks for bank details: email sent, amount $6,500.00", r.status === 200 && r.data?.amount === 6500 && /Amount: \$6,500\.00/.test(m?.text || ""), JSON.stringify(r.data));
    check("'Faster: Zelle $6,300.00 to (858) 900-4347' (was $6,500.00: $200 too much)", /Faster: Zelle \$6,300\.00 to \(858\) 900-4347 with memo LQ/.test(m?.text || ""), (m?.text || "").split("\n").find(l => /Faster/.test(l)) || "no line");
  }

  console.log("S4 sign-up and password-reset codes get the code box");
  {
    let k = MAILS.length; await call("/signup/code", { email: "newprof9@usc.edu" }); let m = MAILS.slice(k).find(x => x.to === "newprof9@usc.edu");
    check("professor sign-up code email: big code box", !!m && /font-size:30px[^>]*>\d{6}<\/span>/.test(m.html || "") && /sign-up code is \d{6}/.test(m.text), (m?.html || "").slice(900, 1100));
    k = MAILS.length; await call("/forgot", { email: "prof9@usc.edu" }); m = MAILS.slice(k).find(x => x.to === "prof9@usc.edu");
    check("password reset code email: big code box", !!m && /font-size:30px[^>]*>\d{6}<\/span>/.test(m.html || "") && /password reset code is \d{6}/.test(m.text));
  }

  console.log("S6 two exams of one class that start together: one reminder, not one per exam");
  {
    sqlite.prepare("UPDATE teachers SET active_until='2099-12-31' WHERE email='prof9@usc.edu'").run();
    const T0 = RealDate.parse("2026-11-20T20:00:00Z"), iso = t => new RealDate(t).toISOString();
    const roster = [{ id: "8001", name: "Pat Prof", email: "prof9@usc.edu", role: "Instructor" }, { id: "9201", name: "Stu A", email: "ra@usc.edu", role: "Student" }, { id: "9202", name: "Stu B", email: "rb@usc.edu", role: "Student" }];
    at("2026-11-17T18:00:00Z");
    await call("/sync", { courses: [{ ou: "600", name: "FBE 437", classlist: roster, quizzes: [] }] }, { teacher: ADMIN });
    const sy = await call("/sync", { whoami: { id: "8001" }, courses: [{ ou: "600", name: "FBE 437", classlist: roster, quizzes: [
      { qi: "1", name: "Exam 3 (A)", active: true, start: iso(T0), end: iso(T0 + 3600e3) }, { qi: "2", name: "Exam 3 (B)", active: true, start: iso(T0), end: iso(T0 + 3600e3) },
      { qi: "3", name: "Exam 3 (extra time)", active: true, start: iso(T0 + 1800e3), end: iso(T0 + 3 * 3600e3) }, { qi: "4", name: "Quiz 9", active: true, start: iso(T0 + 26 * 3600e3), end: iso(T0 + 27 * 3600e3) }] }] }, { teacher: P });
    check("set-up: four protected exams (three start within 30 minutes, one a day later)", sy.status === 200 && Number(sqlite.prepare("SELECT COUNT(*) AS c FROM quizzes WHERE ou='600'").get().c) === 4, JSON.stringify(sy.data).slice(0, 160));
    const k = MAILS.length;
    for (let t = T0 - 50 * 3600e3; t <= T0 + 27 * 3600e3; t += 10 * 60e3) { fakeNow = t; await call("/cron", {}, { pay: true }); }
    const subj = MAILS.slice(k).filter(m => /^Reminder: install LOCKqz/.test(m.subject)).map(m => m.subject.replace(/^Reminder: install LOCKqz before /, "").replace(/ on .*/, ""));
    check("the three exams that start together: 2 reminders in all (2 days + 3 hours before), was 6", subj.filter(x => /^Exam 3/.test(x)).length === 2, subj.join(" | "));
    check("the exam a day later still gets its own two reminders", subj.filter(x => x === "Quiz 9").length === 2, subj.join(" | "));
    check("every exam is marked done (no reminder left to send later)", Number(sqlite.prepare("SELECT COUNT(*) AS c FROM mail_sent WHERE ou='600' AND (kind LIKE 'r48:%' OR kind LIKE 'r3:%')").get().c) === 8, JSON.stringify(sqlite.prepare("SELECT kind,n FROM mail_sent WHERE ou='600'").all()));
    at(null);
  }

  console.log("S7 a payment moved from one professor to another takes its activation with it");
  {
    at("2026-11-12T20:00:00Z");
    const mk = async em => { const c = (await call("/invite", { email: em }, { teacher: ADMIN })).data?.code; const t = (await call("/signup", { email: em, password: "profpass12", name: "Prof " + em[0].toUpperCase(), invite: c })).data?.token;
      return { t, memo: (await call("/my-sections", null, { teacher: t, get: true })).data?.memo }; };
    const a = await mk("wrong9@usc.edu"), b = await mk("right9@usc.edu");
    const r = (await call("/pay/notify", { payments: [{ txn: "s9-move", amount: 6300, payer: "Right", note: a.memo, via: "zelle" }] }, { pay: true })).data?.results?.[0];
    const act = async t => (await call("/me", null, { teacher: t, get: true })).data;
    check("set-up: a $6,300 Zelle with the wrong professor's memo activated him", r?.paid === true && (await act(a.t)).active === true, JSON.stringify(r));
    const mv = await call("/pay-assign", { txn: "s9-move", code: b.memo }, { teacher: ADMIN });
    const A = await act(a.t), B = await act(b.t);
    check("admin assigns it to the right professor: he is active until the term's last day", mv.status === 200 && mv.data?.paid === true && B.active === true && B.active_until === "2026-12-16", JSON.stringify(mv.data));
    check("... and the first professor is no longer active (was: stayed active without a payment)", A.active === false && !A.active_until, JSON.stringify(A));
    sqlite.prepare("UPDATE teachers SET active_until='2027-06-30' WHERE email='wrong9@usc.edu'").run();
    await call("/pay/notify", { payments: [{ txn: "s9-move2", amount: 6300, payer: "X", note: a.memo, via: "zelle" }] }, { pay: true });
    await call("/pay-assign", { txn: "s9-move2", code: b.memo }, { teacher: ADMIN });
    check("a date the admin set by hand (Activate) is never taken away by a move", (await act(a.t)).active_until === "2027-06-30");
    at(null);
  }

  console.log("S5 Let in / Undo for an email with an apostrophe (real Chromium)");
  let chromium = null; try { ({ chromium } = createRequire(import.meta.url)("playwright")); } catch {}
  {
    const page = readFileSync(join(PUB, "dashboard.html"), "utf8");
    check("dashboard: the Let in button passes the email as data, not inside the onclick script", /data-e="\$\{esc\(s\.email\)\}" onclick="letIn\(this\.dataset\.q,this\.dataset\.e,/.test(page) && !/onclick="letIn\('\$\{/.test(page));
  }
  if (!chromium) console.log("  skipped: no playwright here (CI runs it)");
  else {
    const roster = [{ id: "8001", name: "Pat Prof", email: "prof9@usc.edu", role: "Instructor" }, { id: "9101", name: "Stu O'Brien", email: "o'brien@usc.edu", role: "Student" }];
    await call("/sync", { courses: [{ ou: "500", name: "ECON 203", classlist: roster, quizzes: [] }] }, { teacher: ADMIN });
    sqlite.prepare("UPDATE teachers SET active_until='2099-12-31' WHERE email='prof9@usc.edu'").run();
    await call("/sync", { whoami: { id: "8001" }, courses: [{ ou: "500", name: "ECON 203", classlist: roster, quizzes: [{ qi: "1", name: "Q1", active: true, start: new Date(Date.now() - 3600e3).toISOString(), end: new Date(Date.now() + 7200e3).toISOString() }] }] }, { teacher: P });
    const on = await call("/letin", { quiz: "500-1", email: "o'brien@usc.edu", on: true }, { teacher: P });
    const rows = () => Number(sqlite.prepare("SELECT COUNT(*) AS c FROM letin WHERE ou='500' AND qi='1'").get().c);
    check("set-up: the professor let O'Brien in", on.status === 200 && rows() === 1, JSON.stringify(on.data));
    const browser = await chromium.launch({ headless: true });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.route("https://professor.lockqz.com/**", async rt => { const u = new URL(rt.request().url()); const f = u.pathname === "/" ? "dashboard.html" : u.pathname.slice(1);
        try { await rt.fulfill({ status: 200, contentType: f.endsWith(".js") ? "application/javascript" : f.endsWith(".png") ? "image/png" : "text/html", body: readFileSync(join(PUB, f)) }); } catch { await rt.fulfill({ status: 404, body: "" }); } });
      await ctx.route("https://lockqz.com/api/**", async rt => { const q = rt.request(); const u = new URL(q.url());
        const res = await onRequest({ request: new Request("https://lockqz.test" + u.pathname + u.search, { method: q.method(), headers: { ...q.headers(), "cf-connecting-ip": "10.9.9.9" }, body: ["GET", "HEAD", "OPTIONS"].includes(q.method()) ? undefined : q.postData() }), env, waitUntil: () => {} });
        await rt.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) }); });
      await ctx.route(/accounts\.google\.com|google\.com\/chrome/, rt => rt.fulfill({ status: 204, body: "" }));
      await ctx.addInitScript(t => { localStorage.setItem("lockqz_token", t); for (const k of ["lockqz_tour_", "lockqz_welcome_", "lqz_welcome_"]) localStorage.setItem(k + "prof9@usc.edu", "1"); }, P);
      const pg = await ctx.newPage(); const errs = []; pg.on("pageerror", e => errs.push(e.message));
      await pg.goto("https://professor.lockqz.com/#live/500-1"); await pg.waitForTimeout(2500);
      const undo = pg.locator("button", { hasText: /^Undo$/ }).first();
      check("the live page shows Undo for O'Brien", await undo.count() === 1, await pg.innerText("body").then(t => t.slice(0, 200)));
      if (await undo.count()) { await undo.click(); await pg.waitForTimeout(1200); }
      check("clicking Undo takes O'Brien off the let-in list (was: a script error, nothing happened)", rows() === 0 && !errs.length, `rows ${rows()} errors ${errs.join(" | ").slice(0, 120)}`);
    } finally { await browser.close(); }
  }
} catch (e) { fail++; console.log("  FAIL: threw", e && e.stack || e); }
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
