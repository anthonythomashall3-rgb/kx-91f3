// Professors are confirmed automatically by their verification email (owner, 10 Nov 2026):
//   C1 welcome email: an account that still pays is told to activate LOCKqz first (3 steps); a free or invited
//      account gets the 2 steps. Two invites for one email: the account closes both.
//   C2 a professor whose classes nobody in LOCKqz has synced yet confirms his email (sign-up code), adds the
//      extension, opens Brightspace: his first sync confirms him (Brightspace lists him as Instructor), names
//      him, shows his students and protects his exams. No admin step, no admin email.
//   C3 not confirmed: an account whose Brightspace class list names it Student; an email LOCKqz knows as a
//      student (a confirmed student install, or a trusted class list naming it student); a class another
//      professor already runs in LOCKqz cannot be taken. An invited professor still confirms as before.
//   C4 the sign-up page's subtitle; the dashboard of an account that instructs none of its classes.
// Real API, in-memory SQLite, mail captured; the dashboard in real Chromium when Playwright is installed.
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare"), PUB = join(CF, "public");
const tmp = mkdtempSync(join(tmpdir(), "lqz-confirm-"));
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
const mail = [];
const env = { DB: d1real(sqlite), TEACHER_KEY: "tk-conf", REQUIRE_SIGNED: "1", ROT_SECRET: "rs-conf", PW_PEPPER: "pep-conf", LIVE_CACHE_MS: "0",
  MAIL_SINK: async m => { mail.push(m); return true; }, FEE_EXEMPT: "ada@usc.edu,nina@usc.edu", ADMIN_EMAIL: "admin@usc.edu" };
let ipN = 0;
async function call(path, body, { token = null, get = false } = {}) {
  const h = { "Content-Type": "application/json", "CF-Connecting-IP": "10.3." + (++ipN % 250) + ".1" };
  if (token) h["X-LOCKqz-Teacher"] = token;
  const res = await onRequest({ request: new Request("https://lockqz.test/api" + path, get ? { method: "GET", headers: h } : { method: "POST", headers: h, body: JSON.stringify(body ?? {}) }), env, waitUntil: () => {} });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const acct = em => sqlite.prepare("SELECT id, name, vouched, verified, bs_user_id FROM teachers WHERE email=?").get(em);
const codeFor = em => mail.filter(m => m.to === em && m.code).pop()?.code;
const mailTo = (em, re) => mail.filter(m => m.to === em && re.test(m.subject || ""));
async function signUp(email, extra = {}) {
  await call("/signup/code", { email });
  return (await call("/signup", { email, password: "pass-" + email.slice(0, 4) + "-123", code: codeFor(email), ...extra })).data;
}
const soon = new Date(Date.now() + 2 * 864e5).toISOString(), soonEnd = new Date(Date.now() + 2 * 864e5 + 3 * 36e5).toISOString();
const stu = (n, base = 7101) => Array.from({ length: n }, (_, i) => ({ id: String(base + i), name: "Student " + (i + 1), email: `s${base + i}@usc.edu`, role: "Student" }));
const course = (ou, name, code, me, role, students, quizzes = []) => ({ ou, name, code, role, classlist: [{ ...me, role }, ...students], quizzes });

const ADMIN = (await call("/signup", { email: "admin@usc.edu", password: "adminpass1", name: "Anthony Hall" })).data.token;
const AID = acct("admin@usc.edu").id;

console.log("C1 the welcome email");
const ADA = (await signUp("ada@usc.edu")).token;              // fee-exempt (free), no name typed
await signUp("pat@usc.edu", { name: "Pat Payne" });            // pays
const inv = (await call("/invite", { email: "ivy@usc.edu", until: "2099-12-31" }, { token: ADMIN })).data;
const IVY = (await call("/signup", { email: "ivy@usc.edu", password: "ivy-pass-123", name: "Ivy Invited", invite: inv?.code })).data?.token;
for (const [em, nm, want] of [["drj@usc.edu", "Dr. Jane Smith, PhD", "Smith"], ["vd@usc.edu", "Mary Ann Van Dyke", "Van Dyke"], ["cm@usc.edu", "Bristow, Duke", "Bristow"], ["jr@usc.edu", "Sam Lee Jr.", "Lee"]]) {
  await signUp(em, { name: nm }); const w = mailTo(em, /^Welcome/).pop();
  check(`'${nm}' is greeted 'Hi Professor ${want},'`, (w?.text || "").startsWith(`Hi Professor ${want},`), (w?.text || "").slice(0, 40)); }
const wPat = mailTo("pat@usc.edu", /^Welcome/).pop(), wAda = mailTo("ada@usc.edu", /^Welcome/).pop(), wIvy = mailTo("ivy@usc.edu", /^Welcome/).pop();
check("an account that pays: '3 steps', activating LOCKqz on the dashboard comes first",
  /3 steps/.test(wPat?.subject || "") && /1\. Activate LOCKqz on your dashboard: https:\/\/(professor\.lockqz\.com|prof\.lockqz\.pages\.dev)\/?\n2\. Add LOCKqz to Chrome[^\n]*\n3\. Open Brightspace/.test(wPat?.text || ""), wPat?.subject + " | " + (wPat?.text || "").slice(0, 400));
check("...and its HTML has the Activate LOCKqz button before Add LOCKqz to Chrome", /Activate LOCKqz[\s\S]*<b>2\.<\/b>[\s\S]*Add LOCKqz to Chrome[\s\S]*<b>3\.<\/b>[\s\S]*Open Brightspace/.test(wPat?.html || ""));
check("a free account: '2 steps', free, nothing to activate", /2 steps/.test(wAda?.subject || "") && /free for you/.test(wAda?.text || "") && !/Activate/.test((wAda?.text || "") + (wAda?.html || "")), wAda?.subject);
check("an invited account with a date: '2 steps', nothing to activate", /2 steps/.test(wIvy?.subject || "") && !/Activate/.test((wIvy?.text || "") + (wIvy?.html || "")), wIvy?.subject);
{ const i1 = (await call("/invite", { email: "two@usc.edu" }, { token: ADMIN })).data, i2 = (await call("/invite", { email: "two@usc.edu", until: "2099-12-31" }, { token: ADMIN })).data;
  await call("/signup", { email: "two@usc.edu", password: "two-pass-123", name: "Tom Two", invite: i2?.code });
  const left = sqlite.prepare("SELECT COUNT(*) AS n FROM invites WHERE email='two@usc.edu' AND used_at IS NULL").get().n;
  check("two invites for one email: the account closes both", !!i1?.code && !!i2?.code && left === 0 && acct("two@usc.edu")?.vouched === 1, String(left)); }

console.log("C2 confirmed by his verification email: no admin step");
const ADA_ME = { id: "7001", name: "Lovelace, Ada", email: "ada@usc.edu" };
const adaSync = () => call("/sync", { whoami: { id: "7001", name: "Ada Lovelace" }, courses: [
  course("880001", "BUAD-306: Business Finance", "20263_30001", ADA_ME, "Instructor", stu(12), [{ qi: "501", name: "Exam 3", active: true, start: soon, end: soonEnd }]),
  course("880002", "FBE-437: Entrepreneurial Finance", "20263_30002", ADA_ME, "Instructor", stu(5, 7201))] }, { token: ADA });
const before = mail.length;
let r = await adaSync();
check("her first sync is stored", r.status === 200, JSON.stringify(r.data).slice(0, 200));
const A1 = acct("ada@usc.edu");
check("confirmed at once: verified, bound to her Brightspace id, named from Brightspace", A1.verified === 1 && A1.bs_user_id === "7001" && A1.name === "Ada Lovelace", JSON.stringify(A1));
check("her email confirmation is kept (a 'self-' row), never listed as an invite", sqlite.prepare("SELECT COUNT(*) AS n FROM invites WHERE email='ada@usc.edu' AND code LIKE 'self-%' AND used_at IS NOT NULL").get().n === 1
  && !((await call("/invites", null, { token: ADMIN, get: true })).data?.invites || []).some(i => /^self-/.test(i.code)));
check("nobody is asked to confirm her (no email to the admin)", !mail.slice(before).some(m => m.to === "admin@usc.edu"), mail.slice(before).map(m => m.to + ": " + m.subject).join(" | "));
let bs = (await call("/bs", null, { token: ADA, get: true })).data;
const c1 = bs?.courses?.find(c => c.ou === "880001");
check("her classes show their students (12 and 5)", c1 && c1.roster_hidden === false && c1.students.length === 12 && bs.courses.find(c => c.ou === "880002")?.students.length === 5, JSON.stringify(bs?.courses?.map(c => [c.roster_hidden, c.students.length])));
check("her exam is protected by itself (LOCKqz password set)", !!c1?.quizzes?.find(q => String(q.qi) === "501")?.password, JSON.stringify(c1?.quizzes));
r = await adaSync();
check("her next sync keeps her confirmed", r.status === 200 && acct("ada@usc.edu").verified === 1);
check("the admin Professors list has no Confirm step any more", !readFileSync(join(PUB, "dashboard.html"), "utf8").includes("teachers/confirm") && (await call("/teachers/confirm", { email: "ada@usc.edu" }, { token: ADMIN })).status === 404);

console.log("C3 not confirmed");
const NINA = (await signUp("nina@usc.edu")).token;   // fee-exempt so her dashboard opens
r = await call("/sync", { whoami: { id: "7301", name: "Nina Learner" }, courses: [course("880003", "GSBA-521A: Business Strategy", "20263_30003", { id: "7301", name: "Learner, Nina", email: "nina@usc.edu" }, "Student", stu(3, 7311))] }, { token: NINA });
check("Brightspace names her Student in her own class -> not confirmed", r.status === 200 && acct("nina@usc.edu").verified === 0, JSON.stringify(acct("nina@usc.edu")));
sqlite.prepare("INSERT INTO devices (device_id, device_key, student, student_verified, installed_at, last_seen) VALUES ('dev-sam','k','sam@usc.edu',1,?,?)").run(new Date().toISOString(), new Date().toISOString());
const SAM = (await signUp("sam@usc.edu")).token;
await call("/sync", { whoami: { id: "7401" }, courses: [course("880004", "FBE-527: Corporate Finance", "20263_30004", { id: "7401", name: "Sam S", email: "sam@usc.edu" }, "Instructor", stu(2, 7411))] }, { token: SAM });
check("an email with a confirmed LOCKqz student install -> not confirmed", acct("sam@usc.edu")?.verified === 0, JSON.stringify(acct("sam@usc.edu")));
const LEE = (await signUp("lee@usc.edu")).token;
sqlite.prepare("INSERT INTO teacher_courses (teacher_id,ou,name,code,role,synced_at,in_sync) VALUES (?,?,?,?,?,?,1)").run(AID, "880090", "ECON-203", "20263_30090", "Teaching Assistant", new Date().toISOString());
sqlite.prepare("INSERT INTO roster (ou,user_id,name,email,username,org_id,role,synced_at) VALUES ('880090','7501','Lee L','lee@usc.edu','lee','1','Student',?)").run(new Date().toISOString());
await call("/sync", { whoami: { id: "7501" }, courses: [course("880005", "FBE-593: Real Estate", "20263_30005", { id: "7501", name: "Lee L", email: "lee@usc.edu" }, "Instructor", stu(2, 7511))] }, { token: LEE });
check("an email a trusted class list names as a student -> not confirmed", acct("lee@usc.edu")?.verified === 0, JSON.stringify(acct("lee@usc.edu")));
const EVE = (await signUp("eve@usc.edu")).token;
await call("/sync", { whoami: { id: "7601" }, courses: [course("880001", "BUAD-306: Business Finance", "20263_30001", { id: "7601", name: "Eve E", email: "eve@usc.edu" }, "Instructor", stu(1, 7611))] }, { token: EVE });
bs = (await call("/bs", null, { token: ADA, get: true })).data;
check("a class another professor already runs cannot be taken (her class list intact, the newcomer not confirmed)",
  acct("eve@usc.edu")?.verified === 0 && bs?.courses?.find(c => c.ou === "880001")?.students.length === 12, JSON.stringify([acct("eve@usc.edu"), bs?.courses?.find(c => c.ou === "880001")?.students.length]));
sqlite.prepare("INSERT INTO devices (device_id, device_key, student, student_verified, installed_at, last_seen) VALUES ('dev-ivy','k','ivy@usc.edu',1,?,?)").run(new Date().toISOString(), new Date().toISOString());
await call("/sync", { whoami: { id: "7701" }, courses: [course("880006", "BUAD-215: Foundations", "20263_30006", { id: "7701", name: "Invited, Ivy", email: "ivy@usc.edu" }, "Instructor", stu(2, 7711))] }, { token: IVY });
check("an invited professor still confirms through his own sync (the invite stands, even with a student install)", acct("ivy@usc.edu")?.verified === 1, JSON.stringify(acct("ivy@usc.edu")));

console.log("A the admin page");
{ // a password reset request the professor finished himself (emailed code) leaves the admin's list
  await call("/forgot", { email: "pat@usc.edu" });
  const reqs = async () => ((await call("/reset-requests", null, { token: ADMIN, get: true })).data?.requests || []).map(x => x.email);
  const before = await reqs(), code = mail.filter(m => m.to === "pat@usc.edu" && m.code).pop()?.code;
  r = await call("/forgot/reset", { email: "pat@usc.edu", code, password: "new-pass-4567" });
  check("a reset request is listed, and gone once he resets with the emailed code", before.includes("pat@usc.edu") && r.status === 200 && !(await reqs()).includes("pat@usc.edu"), JSON.stringify([before, r.status]));
  await call("/forgot", { email: "ivy@usc.edu" });
  r = await call("/reset", { email: "ivy@usc.edu" }, { token: ADMIN });
  check("...or once the admin resets it (Reset pw)", r.status === 200 && !(await reqs()).includes("ivy@usc.edu"));
  const tl = (await call("/teachers", null, { token: ADMIN, get: true })).data?.teachers || [];
  check("/teachers says who is the admin (his row is never 'not verified')", tl.find(t => t.email === "admin@usc.edu")?.role === "admin");
  { const e2 = { ...env, STUDENT_TOTAL: "200", STUDENT_OTHER_TOTAL: "210", STUDENT_FEE: "180" };
    const res = await onRequest({ request: new Request("https://lockqz.test/api/payments", { headers: { "X-LOCKqz-Teacher": ADMIN, "CF-Connecting-IP": "10.4.0.1" } }), env: e2, waitUntil: () => {} });
    const d = await res.json();
    check("admin Payments shows what students actually pay ($200 Zelle, $210 card or Venmo), not only the $180 base", d.fee_paid?.zelle === 200 && d.fee_paid?.card === 210 && d.fee === 180, JSON.stringify(d.fee_paid)); }
}
let chromium; try { ({ chromium } = createRequire(import.meta.url)("playwright")); } catch {}
if (!chromium) try { ({ chromium } = createRequire("/opt/npm-tools/node_modules/")("playwright")); } catch {}
if (!chromium) console.log("  skip: real-browser checks (no playwright)");
else {
  const browser = await chromium.launch({ headless: true });
  async function open(token, email, hash = "") {
    const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", viewport: { width: 1280, height: 900 } });
    await ctx.route("https://professor.lockqz.com/**", async rt => { const u = new URL(rt.request().url()); const f = u.pathname === "/" ? "dashboard.html" : u.pathname.slice(1);
      try { await rt.fulfill({ status: 200, contentType: f.endsWith(".js") ? "application/javascript" : f.endsWith(".png") ? "image/png" : "text/html", body: readFileSync(join(PUB, f)) }); } catch { await rt.fulfill({ status: 404, body: "" }); } });
    await ctx.route("https://lockqz.com/api/**", async rt => { const q = rt.request(); const u = new URL(q.url());
      const res = await onRequest({ request: new Request("https://lockqz.pages.dev" + u.pathname + u.search, { method: q.method(), headers: { ...q.headers(), "cf-connecting-ip": "10.8.0.9" }, body: ["GET", "HEAD", "OPTIONS"].includes(q.method()) ? undefined : q.postData() }), env, waitUntil: () => {} });
      await rt.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) }); });
    await ctx.route(/google\.com|gstatic\.com|chromewebstore/, rt => rt.fulfill({ status: 204, body: "" }));
    await ctx.addInitScript(([t, e]) => { if (location.host === "professor.lockqz.com" && t) { localStorage.setItem("lockqz_token", t);
      for (const k of ["lockqz_tour_", "lockqz_welcome_", "lqz_welcome_"]) localStorage.setItem(k + e, "1"); } }, [token, email]);
    const pg = await ctx.newPage(); const errs = []; pg.on("pageerror", e => errs.push(e.message));
    await pg.goto("https://professor.lockqz.com/" + hash); await pg.waitForTimeout(1800);
    return { ctx, pg, errs };
  }
  console.log("C2 her dashboard (real Chromium)");
  { const { ctx, pg, errs } = await open(ADA, "ada@usc.edu"); const t = await pg.innerText("#app");
    check("her students and switches are there, no 'not the instructor' line", /12 students/.test(t) && await pg.locator("#app .sw").count() > 0 && !/does not list you|Only this class's instructor/.test(t), t.slice(0, 400));
    check("header shows her name, not her email", /Ada Lovelace/.test(await pg.innerText("#who").catch(() => "")), await pg.innerText("#who").catch(() => "?"));
    check("plurals: '12 addresses copied', '1 address', '2 students'", await pg.evaluate(() => [pl(12, "address"), pl(1, "address"), pl(2, "student")].join("|")) === "12 addresses|1 address|2 students");
    await pg.evaluate(() => { location.hash = "#class/880001"; }); await pg.waitForTimeout(700); const cOn = await pg.innerText("#app");
    await pg.evaluate(() => { location.hash = ""; }); await pg.waitForTimeout(700);
    const on1 = await pg.innerText("section.band").catch(() => "");
    await pg.click("section.band button.sw"); await pg.waitForTimeout(1500); const off1 = await pg.innerText("section.band").catch(() => "");
    check("one exam protected, its password not in Brightspace yet: 'Your upcoming exam is waiting to be set in Brightspace.' (not '0 of your 1 upcoming exam')", /^Your upcoming exam is waiting to be set in Brightspace\./m.test(on1) && !/0 of your/.test(on1), on1);
    check("all off: 'LOCKqz is off. Students can use AI ...' never next to 'nothing for you to do'", /LOCKqz is off/.test(off1) && !/nothing for you to do/.test(off1), off1);
    await pg.evaluate(() => { location.hash = "#class/880001"; }); await pg.waitForTimeout(700); const cOff = await pg.innerText("#app");
    check("class page: 'Nothing to do' only while its exams are protected; off: 'LOCKqz is off for this class'",
      /Nothing to do\./.test(cOn) && /every exam starts protected/.test(cOn) && !/Nothing to do\./.test(cOff) && /LOCKqz is off for this class/.test(cOff), cOn.slice(0, 300) + " || " + cOff.slice(0, 300));
    check("no page errors", !errs.length, errs.join(" | ")); await ctx.close(); }
  console.log("C4 an account that instructs none of its classes");
  { const { ctx, pg, errs } = await open(NINA, "nina@usc.edu"); const t = await pg.innerText("#app");
    check("headline 'Brightspace does not list you as the instructor of this class.' (not 'LOCKqz is off. Students can use AI')", /Brightspace does not list you as the instructor of this class\./.test(t) && !/Students can use AI/.test(t), t.slice(0, 400));
    check("the class: 'Only this class's instructor can turn LOCKqz on for it.', no switches, no Email students, no '0 students'",
      /Only this class's instructor can turn LOCKqz on for it\./.test(t) && await pg.locator("#app .sw").count() === 0 && await pg.locator("#app :text('Email students')").count() === 0 && !/0 students|No students on the Brightspace roster/.test(t), t);
    await pg.click("a[href='#class/880003']"); await pg.waitForTimeout(600); const tc = await pg.innerText("#app");
    check("class page: the same line, no switches, no Students list", /Only this class's instructor can turn LOCKqz on for it\./.test(tc) && !/Students|Not protected/.test(tc) && await pg.locator("#app .sw").count() === 0, tc.slice(0, 300));
    check("no page errors", !errs.length, errs.join(" | ")); await ctx.close(); }
  console.log("C4 the sign-up page");
  { const { ctx, pg } = await open(null, "");
    const s0 = await pg.innerText("#lsub"); await pg.click("#lswitch"); const s1 = await pg.innerText("#lsub"); await pg.click("#lswitch"); const s2 = await pg.innerText("#lsub");
    check("Create account: 'Use your school email. ...'; Sign in: 'Sign in. ...'", /^Sign in\./.test(s0) && /^Use your school email\. Your classes, rosters and exams come from Brightspace by themselves\.$/.test(s1) && s2 === s0, [s0, s1, s2].join(" | "));
    await ctx.close(); }
  console.log("C2 the admin's Professors list");
  { const { ctx, pg, errs } = await open(ADMIN, "admin@usc.edu", "#admin"); await pg.waitForTimeout(800);
    const row = await pg.locator("#teachers tr", { hasText: "ada@usc.edu" }).innerText();
    check("Ada's row: her 2 classes, confirmed (no 'not verified'), no Confirm button", /2 classes/.test(row) && !/not verified/.test(row) && await pg.locator("#teachers button", { hasText: "Confirm" }).count() === 0, row);
    sqlite.prepare("INSERT INTO teacher_courses (teacher_id,ou,name,code,role,synced_at,in_sync) VALUES (?,?,?,?,?,?,1)").run(AID, "880091", "ECON-204", "20263_30091", "Teaching Assistant", new Date().toISOString());
    sqlite.prepare("INSERT INTO payments (txn,amount,via,payer,note,received_at,matched) VALUES ('t-void',0,'zelle','x','y',?,'void')").run(new Date().toISOString());
    await pg.evaluate(() => { loadTeachers(); loadPayments(); }); await pg.waitForTimeout(900);
    const adminRow = await pg.locator("#teachers tr", { hasText: "admin@usc.edu" }).innerText();
    check("the admin's own row: his classes, never 'not verified'", /class/.test(adminRow) && !/not verified/.test(adminRow), adminRow);
    const vrow = pg.locator("#payments tr", { hasText: "void" });
    check("a voided payment shows 'void' and no Void button", await vrow.count() === 1 && await vrow.locator("button", { hasText: "Void" }).count() === 0, await vrow.innerText().catch(() => "?"));
    check("no page errors (admin)", !errs.length, errs.join(" | ")); await ctx.close(); }
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
