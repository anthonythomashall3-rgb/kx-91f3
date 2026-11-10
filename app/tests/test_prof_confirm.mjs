// Professors whose classes LOCKqz does not know yet (10 Nov 2026):
//   C1 welcome email: an account that still pays is told to activate LOCKqz first (3 steps); a free or invited
//      account gets the 2 steps.
//   C2 a professor whose classes no trusted account has synced: the admin is emailed ONCE (his classes, his own
//      Brightspace role in each, the USC Schedule of Classes instructor); his dashboard says LOCKqz is checking,
//      with no switches, no "0 students" and no "open Brightspace" advice he has already followed.
//   C3 the admin confirms him (Admin, Professors, Confirm): verified at once, bound to his Brightspace id, named
//      from his class list and emailed; his next sync keeps him verified and protects his exams. Only the admin,
//      only an account that confirmed its email, only an Instructor on his own class list, only once.
//   C4 the sign-up page's subtitle.
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
  MAIL_SINK: async m => { mail.push(m); return true; }, FEE_EXEMPT: "ada@usc.edu", ADMIN_EMAIL: "admin@usc.edu" };
async function call(path, body, { token = null, get = false } = {}) {
  const h = { "Content-Type": "application/json", "CF-Connecting-IP": "10.3.0." + (1 + mail.length % 200) };
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

const ADMIN = (await call("/signup", { email: "admin@usc.edu", password: "adminpass1", name: "Anthony Hall" })).data.token;

console.log("C1 the welcome email");
const ADA = (await signUp("ada@usc.edu")).token;              // fee-exempt (free), no name typed
const PAT = (await signUp("pat@usc.edu", { name: "Pat Payne" })).token;   // pays
const inv = (await call("/invite", { email: "ivy@usc.edu", until: "2099-12-31" }, { token: ADMIN })).data;
await call("/signup", { email: "ivy@usc.edu", password: "ivy-pass-123", name: "Ivy Invited", invite: inv?.code });
const wPat = mailTo("pat@usc.edu", /^Welcome/).pop(), wAda = mailTo("ada@usc.edu", /^Welcome/).pop(), wIvy = mailTo("ivy@usc.edu", /^Welcome/).pop();
check("an account that pays: '3 steps', activating LOCKqz on the dashboard comes first",
  /3 steps/.test(wPat?.subject || "") && /1\. Activate LOCKqz on your dashboard: https:\/\/(professor\.lockqz\.com|prof\.lockqz\.pages\.dev)\/?\n2\. Add LOCKqz to Chrome[^\n]*\n3\. Open Brightspace/.test(wPat?.text || ""), wPat?.subject + " | " + (wPat?.text || "").slice(0, 400));
check("...and its HTML has the Activate LOCKqz button before Add LOCKqz to Chrome", /Activate LOCKqz[\s\S]*<b>2\.<\/b>[\s\S]*Add LOCKqz to Chrome[\s\S]*<b>3\.<\/b>[\s\S]*Open Brightspace/.test(wPat?.html || ""));
check("a free account: '2 steps', free, nothing to activate", /2 steps/.test(wAda?.subject || "") && /free for you/.test(wAda?.text || "") && !/Activate/.test((wAda?.text || "") + (wAda?.html || "")), wAda?.subject);
check("an invited account with a date: '2 steps', nothing to activate", /2 steps/.test(wIvy?.subject || "") && !/Activate/.test((wIvy?.text || "") + (wIvy?.html || "")), wIvy?.subject);

console.log("C2 a professor in classes LOCKqz does not know yet");
sqlite.prepare("INSERT INTO usc_sections (term,section,course,title,first,last) VALUES ('20263','30001','BUAD-306','Business Finance','Ada','Lovelace')").run();
const soon = new Date(Date.now() + 2 * 864e5).toISOString(), soonEnd = new Date(Date.now() + 2 * 864e5 + 3 * 36e5).toISOString();
const stu = n => Array.from({ length: n }, (_, i) => ({ id: String(7101 + i), name: "Student " + (i + 1), email: `s${i + 1}@usc.edu`, role: "Student" }));
const adaSync = () => call("/sync", { whoami: { id: "7001", name: "Ada Lovelace" }, courses: [
  { ou: "880001", name: "BUAD-306: Business Finance", code: "20263_30001", role: "Instructor", lis_roles: ["urn:lti:role:ims/lis/Instructor"],
    classlist: [{ id: "7001", name: "Lovelace, Ada", email: "ada@usc.edu", role: "Instructor" }, ...stu(12)],
    quizzes: [{ qi: "501", name: "Exam 3", active: true, start: soon, end: soonEnd }] },
  { ou: "880002", name: "FBE-437: Entrepreneurial Finance", code: "20263_30002", role: "Instructor",
    classlist: [{ id: "7001", name: "Lovelace, Ada", email: "ada@usc.edu", role: "Instructor" }, ...stu(5)], quizzes: [] }] }, { token: ADA });
let r = await adaSync();
check("her sync is stored", r.status === 200, JSON.stringify(r.data).slice(0, 200));
check("she stays unconfirmed (nobody trusted has synced these classes)", acct("ada@usc.edu")?.verified === 0 && acct("ada@usc.edu")?.vouched === 1, JSON.stringify(acct("ada@usc.edu")));
const ask = mailTo("admin@usc.edu", /^Confirm a professor/);
check("the admin is emailed: 'Confirm a professor: Ada Lovelace (ada@usc.edu)'", ask.length === 1 && ask[0].subject === "Confirm a professor: Ada Lovelace (ada@usc.edu)", ask.map(m => m.subject).join(" | "));
check("...listing each class with her Brightspace role and the USC Schedule of Classes instructor",
  /BUAD-306: Business Finance \(20263_30001\)\. Brightspace role: Instructor\. USC Schedule of Classes: Ada Lovelace\./.test(ask[0]?.text || "")
  && /FBE-437: Entrepreneurial Finance \(20263_30002\)\. Brightspace role: Instructor\. USC Schedule of Classes: no instructor listed\./.test(ask[0]?.text || "")
  && /synced 2 classes that no account you trust has synced/.test(ask[0]?.text || "") && /(professor\.lockqz\.com|prof\.lockqz\.pages\.dev)\/#admin/.test(ask[0]?.text || ""), (ask[0]?.text || "").slice(0, 600));
await adaSync();
check("a second sync does not email the admin again", mailTo("admin@usc.edu", /^Confirm a professor/).length === 1);
let bs = (await call("/bs", null, { token: ADA, get: true })).data;
check("her classes are listed but hidden (no class list, no passwords) until she is confirmed",
  bs?.courses?.length === 2 && bs.courses.every(c => c.roster_hidden === true && c.students.length === 0) && bs.courses.flatMap(c => c.quizzes || []).every(q => !q.password), JSON.stringify(bs).slice(0, 300));
r = await call("/protect", { ou: "880001", qi: "501" }, { token: ADA });
check("she cannot protect an exam yet (403)", r.status === 403, String(r.status));

console.log("C3 the admin confirms her");
const NINA = (await signUp("nina@usc.edu")).token;
await call("/sync", { whoami: { id: "7301" }, courses: [{ ou: "880003", name: "GSBA-521A", code: "20263_30003", role: "Student",
  classlist: [{ id: "7301", name: "Nina Learner", email: "nina@usc.edu", role: "Student" }], quizzes: [] }] }, { token: NINA });
sqlite.prepare("INSERT INTO teachers (id,email,name,pw_hash,salt,token,created_at,role,vouched) VALUES ('old1','old@usc.edu','Old Account','x','y','tok-old',?, 'teacher', 0)").run(new Date().toISOString());
let tl = (await call("/teachers", null, { token: ADMIN, get: true })).data?.teachers || [];
const tAda = tl.find(t => t.email === "ada@usc.edu"), tNina = tl.find(t => t.email === "nina@usc.edu"), tBoss = tl.find(t => t.email === "admin@usc.edu");
check("/teachers: Ada is an Instructor in 2 of her synced classes (Confirm shows); Nina in 0; the admin row has none", tAda?.instr === 2 && Number(tAda?.vouched) === 1 && tNina?.instr === 0 && tBoss?.instr == null, JSON.stringify([tAda, tNina].map(t => t && [t.instr, t.vouched])));
r = await call("/teachers/confirm", { email: "ada@usc.edu" }, { token: ADA });
check("only the admin can confirm (403)", r.status === 403 && acct("ada@usc.edu").verified === 0, String(r.status));
r = await call("/teachers/confirm", { email: "nina@usc.edu" }, { token: ADMIN });
check("not an Instructor on her own class lists -> refused (409)", r.status === 409 && /instructor/.test(r.data?.error || "") && acct("nina@usc.edu").verified === 0, JSON.stringify(r.data));
r = await call("/teachers/confirm", { email: "old@usc.edu" }, { token: ADMIN });
check("an account that never confirmed its email -> refused (409)", r.status === 409 && /never confirmed its email/.test(r.data?.error || ""), JSON.stringify(r.data));
r = await call("/teachers/confirm", { email: "nobody@usc.edu" }, { token: ADMIN });
check("no such professor -> 404", r.status === 404);

let chromium; try { ({ chromium } = createRequire(import.meta.url)("playwright")); } catch {}
if (!chromium) try { ({ chromium } = createRequire("/opt/npm-tools/node_modules/")("playwright")); } catch {}
const browser = chromium ? await chromium.launch({ headless: true }) : null;
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
if (browser) {
  console.log("C2 her dashboard (real Chromium)");
  const { ctx, pg, errs } = await open(ADA, "ada@usc.edu"); const t = await pg.innerText("#app");
  check("says LOCKqz is checking that she teaches these classes, emailed when done", /LOCKqz is checking that you teach these classes\. You will get an email when it is done, usually within one business day\./.test(t), t.slice(0, 400));
  check("headline 'LOCKqz is checking your classes.' (not 'LOCKqz is off. Students can use AI')", /LOCKqz is checking your classes\./.test(t) && !/Students can use AI/.test(t), t.slice(0, 400));
  check("each class: 'Waiting for LOCKqz to confirm that you teach this class.'", (t.match(/Waiting for LOCKqz to confirm that you teach this class\./g) || []).length === 2, t);
  check("no '0 students', no empty-roster line, no 'Open Brightspace ... connects by itself'", !/0 students|No students on the Brightspace roster|connects by itself/.test(t), t);
  check("no on/off switches and no Email students buttons on her classes", await pg.locator("#app .sw").count() === 0 && await pg.locator("#app :text('Email students')").count() === 0);
  check("the next exam is still shown", /Next exam: Exam 3/.test(t));
  await pg.click("a[href='#class/880001']"); await pg.waitForTimeout(600); const tc = await pg.innerText("#app");
  check("class page: the same note, the exam listed, no switches, no Students list", /Waiting for LOCKqz to confirm that you teach this class\./.test(tc) && /Exam 3/.test(tc) && !/Students|Not protected/.test(tc) && await pg.locator("#app .sw").count() === 0, tc.slice(0, 400));
  check("no page errors", !errs.length, errs.join(" | ")); await ctx.close();

  console.log("C4 the sign-up page");
  { const { ctx, pg } = await open(null, "");
    const s0 = await pg.innerText("#lsub"); await pg.click("#lswitch"); const s1 = await pg.innerText("#lsub"); await pg.click("#lswitch"); const s2 = await pg.innerText("#lsub");
    check("Create account: 'Use your school email. ...'; Sign in: 'Sign in. ...'", /^Sign in\./.test(s0) && /^Use your school email\. Your classes, rosters and exams come from Brightspace by themselves\.$/.test(s1) && s2 === s0, [s0, s1, s2].join(" | "));
    await ctx.close(); }

  console.log("C3 the admin's Professors list");
  const a = await open(ADMIN, "admin@usc.edu", "#admin"); await a.pg.waitForTimeout(800);
  const rowAda = a.pg.locator("#teachers tr", { hasText: "ada@usc.edu" }), rowNina = a.pg.locator("#teachers tr", { hasText: "nina@usc.edu" });
  check("Ada's row: 'not verified · instructor in 2' + Confirm; Nina's row has no Confirm",
    /not verified · instructor in 2/.test(await rowAda.innerText()) && await rowAda.locator("button", { hasText: "Confirm" }).count() === 1 && await rowNina.locator("button", { hasText: "Confirm" }).count() === 0, await rowAda.innerText());
  await rowAda.locator("button", { hasText: "Confirm" }).click(); await a.pg.waitForTimeout(1200);
  check("after Confirm her row no longer says 'not verified'", !/not verified/.test(await a.pg.locator("#teachers tr", { hasText: "ada@usc.edu" }).innerText()));
  check("no page errors (admin)", !a.errs.length, a.errs.join(" | ")); await a.ctx.close();
} else {
  console.log("  skip: real-browser checks (no playwright); confirming through the API");
  await call("/teachers/confirm", { email: "ada@usc.edu" }, { token: ADMIN });
}

console.log("C3 after the admin confirmed her");
const A1 = acct("ada@usc.edu");
check("verified, bound to her Brightspace id, named from her class list ('Lovelace, Ada' -> 'Ada Lovelace')", A1.verified === 1 && A1.bs_user_id === "7001" && A1.name === "Ada Lovelace", JSON.stringify(A1));
const done = mailTo("ada@usc.edu", /^LOCKqz: your classes are confirmed$/).pop();
check("she is emailed: 'Hi Professor Lovelace, LOCKqz confirmed that you teach 20263_30001, 20263_30002. Open Brightspace ...'",
  /^Hi Professor Lovelace,\n\nLOCKqz confirmed that you teach 20263_30001, 20263_30002\. Open Brightspace in Chrome once and LOCKqz protects your exams from then on\./.test(done?.text || ""), done?.text);
r = await call("/teachers/confirm", { email: "ada@usc.edu" }, { token: ADMIN });
check("confirming twice -> 409 already confirmed", r.status === 409 && /already confirmed/.test(r.data?.error || ""));
r = await adaSync();
check("her next sync keeps her verified", r.status === 200 && acct("ada@usc.edu").verified === 1, JSON.stringify(acct("ada@usc.edu")));
bs = (await call("/bs", null, { token: ADA, get: true })).data;
const c1 = bs?.courses?.find(c => c.ou === "880001");
check("her classes now show their students (12 and 5)", c1 && c1.roster_hidden === false && c1.students.length === 12 && bs.courses.find(c => c.ou === "880002")?.students.length === 5, JSON.stringify(bs?.courses?.map(c => [c.roster_hidden, c.students.length])));
check("and her exam is protected by itself (LOCKqz password set)", !!c1?.quizzes?.find(q => String(q.qi) === "501")?.password, JSON.stringify(c1?.quizzes));
check("the admin was asked about her once, and once about Nina (role Student, so he can tell)", mailTo("admin@usc.edu", /^Confirm a professor: Ada/).length === 1
  && mailTo("admin@usc.edu", /^Confirm a professor: nina@usc\.edu$/).length === 1 && /Brightspace role: Student\./.test(mailTo("admin@usc.edu", /nina/).pop()?.text || ""), mail.filter(m => m.to === "admin@usc.edu").map(m => m.subject).join(" | "));
if (browser) {
  const { ctx, pg, errs } = await open(ADA, "ada@usc.edu"); const t = await pg.innerText("#app");
  check("her dashboard: no 'checking' note, her students and switches are there", !/LOCKqz is checking|Waiting for LOCKqz/.test(t) && /12 students/.test(t) && await pg.locator("#app .sw").count() > 0, t.slice(0, 400));
  check("header shows her name, not her email", /Ada Lovelace/.test(await pg.innerText("#who").catch(() => "")), await pg.innerText("#who").catch(() => "?"));
  check("no page errors", !errs.length, errs.join(" | ")); await ctx.close();
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
