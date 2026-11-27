// Bug sweep 39 (27 Nov 2026): the professor's pages say what LOCKqz really does with the live settings.
//   R  reminders: one email 2 days before each exam when EXAM_REMIND_3H = "0" (not "and again 3 hours before");
//      a class that waits for its professor's own first email (MAIL_HOLD) says its reminders start after it.
//   G  one password per exam (REQUIRE_GATE off): the class page and the live view never mention a browser that must
//      stay open or a gate; with the gate on they still do.
//   D  an exam that starts and ends on the same day shows its day once ("Sun, Dec 6, 12:00 – 3:00 PM").
//   P  on a phone the exam's switch goes under its name and dates (no one-word-per-line names).
//   A  Admin, Professors: an account that never pays (FREE_FOREVER / FEE_EXEMPT) is "free", never "off" after its date.
//   C  a co-teacher who never pays keeps a shared class protected when the other professor is turned off.
//   S  the Microsoft Store catch-up workflow: sends the live version when the Store is behind, once per version.
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, "..", ".."), CF = join(HERE, "..", "cloudflare"), PUB = join(CF, "public");
const tmp = mkdtempSync(join(tmpdir(), "lqz-s39-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort()) { try { sqlite.exec(readFileSync(join(CF, m), "utf8")); } catch (e) { if (!/duplicate column|already exists/.test(e.message)) throw e; } }
const db = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
  const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
    first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
    run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } }; return o; },
  async batch(sts) { for (const s of sts) s._run(); } };
const ENV = { DB: db, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", ROT_SECRET: "rs", PW_PEPPER: "pp", MAIL_SINK: async () => true,
  FREE_FOREVER: "dbristow@usc.edu,cob@usc.edu", MAIL_HOLD: "dbristow@usc.edu", EXAM_REMIND_3H: "0", REQUIRE_GATE: "0", STUDENT_MAIL_ON: "1" };
let env = ENV;
async function api(path, body, headers = {}, e = env) {
  const res = await onRequest({ request: new Request("https://lockqz.pages.dev/api" + path, { method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.39.0.1", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env: e });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const ADMIN = { "X-LOCKqz-Teacher": "admin-key" };
const one = (sql, ...a) => sqlite.prepare(sql).get(...a);
const OU = "302972", day = 86400e3;
const cl = [{ id: "4000", name: "Bristow, Duke", email: "dbristow@usc.edu", role: "Instructor" }, { id: "4100", name: "Hall, Anthony", email: "athall@usc.edu", role: "Teaching Assistant" },
  { id: "5001", name: "One, Stu", email: "stu1@usc.edu", role: "Student" }, { id: "5002", name: "Two, Stu", email: "stu2@usc.edu", role: "Student" }];
await api("/signup", { email: "athall@usc.edu", password: "adminpass1", name: "Anthony Hall" });
await api("/sync", { courses: [{ ou: OU, name: "20263_14792 BUAD-306: Business Finance", code: "20263_14792", role: "Teaching Assistant", classlist: cl, quizzes: [] }] }, ADMIN);
async function invited(email, until = "2026-12-31") { const r = await api("/invite", { email, until }, ADMIN);
  return (await api("/signup", { email, password: email.split("@")[0] + "-pass-1", invite: r.data.code })).data?.token; }
const BT = await invited("dbristow@usc.edu");
// Exams in Los Angeles time (the browser below runs there): one on a single day, one over two days.
const la = (dd, h) => { const d = new Date(Date.now() + dd * day); const ymd = d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  return new Date(`${ymd}T${String(h).padStart(2, "0")}:00:00-08:00`).toISOString(); };
const quizzes = [{ qi: "901", name: "Exam 3", start: la(5, 12), end: la(5, 15), active: true },
  { qi: "902", name: "Take-home Final", start: la(9, 9), end: la(10, 9), active: true }];
let r = await api("/sync", { whoami: { id: "4000", name: "Duke Bristow" }, courses: [{ ou: OU, name: "20263_14792 BUAD-306: Business Finance", code: "20263_14792", role: "Instructor", classlist: cl, quizzes }] }, { "X-LOCKqz-Teacher": BT });
check("setup: his own sync verifies him and protects both exams", r.status === 200 && one("SELECT verified FROM teachers WHERE email='dbristow@usc.edu'")?.verified === 1
  && Number(one("SELECT COUNT(*) AS n FROM quizzes WHERE ou=?", OU)?.n) === 2, JSON.stringify(r.data).slice(0, 160));

console.log("R reminders say what is sent");
r = await api("/bs", undefined, { "X-LOCKqz-Teacher": BT });
let c = r.data?.courses?.find(x => x.ou === OU);
check("/bs: remind_3h false with EXAM_REMIND_3H = \"0\"", r.data?.remind_3h === false, JSON.stringify(Object.keys(r.data || {})));
check("/bs: his class waits for his own first email (MAIL_HOLD)", c?.held === true, JSON.stringify(c && { held: c.held }));
r = await api("/bs", undefined, { "X-LOCKqz-Teacher": BT }, { ...ENV, EXAM_REMIND_3H: undefined, MAIL_HOLD: "" });
check("/bs: remind_3h true without the setting; nothing held without MAIL_HOLD", r.data?.remind_3h === true && r.data?.courses?.find(x => x.ou === OU)?.held === false);
const dash = readFileSync(join(PUB, "dashboard.html"), "utf8");
check("dashboard: both reminder wordings exist, chosen by remind_3h", dash.includes('BS.remind_3h === false ? "2 days before each exam" : "2 days and again 3 hours before each exam"'));
check("dashboard: no name of the owner in the served page", !/anthony/i.test(dash));

console.log("A admin page: free accounts");
sqlite.prepare("UPDATE teachers SET active_until='2026-01-01' WHERE email='dbristow@usc.edu'").run();
r = await api("/teachers", undefined, ADMIN);
const tb = (r.data?.teachers || []).find(t => t.email === "dbristow@usc.edu");
check("/teachers: a FREE_FOREVER professor is free \"forever\" (date in the past)", tb?.free === "forever", JSON.stringify(tb && { free: tb.free, until: tb.active_until }));
check("/teachers: the admin row is not free", (r.data?.teachers || []).find(t => t.email === "athall@usc.edu")?.free === null);
r = await api("/teachers", undefined, ADMIN, { ...ENV, FREE_FOREVER: "", FEE_EXEMPT: "dbristow@usc.edu" });
check("/teachers: a trial tester is free \"trial\"", (r.data?.teachers || []).find(t => t.email === "dbristow@usc.edu")?.free === "trial");
check("dashboard: free shown as free, never off", dash.includes('const on = !!t.free || t.role==="admin"') && dash.includes('"free forever":"free (trial)"'));

console.log("C a free co-teacher keeps a shared class protected");
{ const cc = [{ id: "6001", name: "Co A", email: "coa@usc.edu", role: "Instructor" }, { id: "6002", name: "Co B", email: "cob@usc.edu", role: "Instructor" }, { id: "6003", name: "K", email: "kk@usc.edu", role: "Student" }];
  await api("/sync", { courses: [{ ou: "600", name: "Co", classlist: cc, quizzes: [] }] }, ADMIN);
  const A = await invited("coa@usc.edu"), B = await invited("cob@usc.edu");
  await api("/sync", { whoami: { id: "6001" }, courses: [{ ou: "600", name: "Co", classlist: cc, quizzes: [{ qi: "61", name: "Q", active: true }] }] }, { "X-LOCKqz-Teacher": A });
  await api("/sync", { whoami: { id: "6002" }, courses: [{ ou: "600", name: "Co", classlist: cc, quizzes: [{ qi: "61", name: "Q", active: true }] }] }, { "X-LOCKqz-Teacher": B });
  check("setup: quiz 600-61 protected by A", one("SELECT teacher_id FROM quizzes WHERE ou='600' AND qi='61'")?.teacher_id === one("SELECT id FROM teachers WHERE email='coa@usc.edu'")?.id);
  sqlite.prepare("UPDATE teachers SET active_until='2026-01-01' WHERE email='cob@usc.edu'").run();   // B never pays: his date does not matter
  await api("/activate", { email: "coa@usc.edu", until: null }, ADMIN);
  check("A turned off; B is free forever (date past) -> the shared class stays protected", !!one("SELECT 1 FROM quizzes WHERE ou='600' AND qi='61'") && !one("SELECT 1 FROM pending_clear WHERE ou='600' AND qi='61'"));
}

console.log("S Microsoft Store catch-up");
{ const wf = readFileSync(join(ROOT, ".github", "workflows", "store-catchup.yml"), "utf8"), rel = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  check("runs on a schedule and by hand", /schedule:\s*\n\s*- cron: "41 \*\/6 \* \* \*"/.test(wf) && /workflow_dispatch:/.test(wf));
  check("looks at /api/store and /api/version; behind only on a clear answer", wf.includes("https://lockqz.pages.dev/api/store") && wf.includes("https://lockqz.pages.dev/api/version")
    && wf.includes('[ -n "$cur" ] && [ -n "$have" ] && [ -n "$live" ] && [ "$cur" != "$have" ]'));
  check("the Windows job runs only when behind, builds the live commit and checks its version", /if: needs\.look\.outputs\.behind == 'true' && vars\.MSIX_NAME != ''/.test(wf)
    && wf.includes('ref: "${{ needs.look.outputs.commit }}"') && wf.includes('if ($v -ne "${{ needs.look.outputs.version }}")'));
  const key = s => (s.match(/key: (store-sent-\$\{\{ hashFiles\('app\/VERSION'\) \}\})/) || [])[1];
  check("the same once-per-version marker as the Release (never restarts a certification)", !!key(wf) && key(wf) === key(rel) && /steps\.sent\.outputs\.cache-hit != 'true'/.test(wf));
  check("sends with the same package and Store id; a refusal is tried again at the next look", wf.includes("build-msix.ps1") && wf.includes("msstore publish") && wf.includes("-id 9P7D1114N2LJ")
    && /if \(\$LASTEXITCODE -eq 0\) \{ New-Item -ItemType Directory -Force store-sent/.test(wf) && /exit 0\s*$/.test(wf.trimEnd() + "\n"));
}

// ---- real Chromium: the pages themselves ----
let chromium; try { ({ chromium } = createRequire(import.meta.url)("playwright")); } catch {}
if (!chromium) try { ({ chromium } = createRequire("/opt/npm-tools/node_modules/")("playwright")); } catch {}
if (!chromium) { console.log("  skip: real-browser checks (no playwright)"); }
else {
  const browser = await chromium.launch({ headless: true });
  async function open(token, email, { width = 1280, e = ENV, hash = "" } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: "America/Los_Angeles", locale: "en-US",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36" });
    await ctx.route("https://professor.lockqz.com/**", async rt => { const u = new URL(rt.request().url()); const f = u.pathname === "/" ? "dashboard.html" : u.pathname.slice(1);
      try { await rt.fulfill({ status: 200, contentType: f.endsWith(".js") ? "application/javascript" : f.endsWith(".png") ? "image/png" : "text/html", body: readFileSync(join(PUB, f)) }); } catch { await rt.fulfill({ status: 404, body: "" }); } });
    await ctx.route("https://lockqz.com/api/**", async rt => { const q = rt.request(); const u = new URL(q.url());
      const res = await onRequest({ request: new Request("https://lockqz.pages.dev" + u.pathname + u.search, { method: q.method(), headers: { ...q.headers(), "cf-connecting-ip": "10.39.0.9" },
        body: ["GET", "HEAD", "OPTIONS"].includes(q.method()) ? undefined : q.postData() }), env: e });
      await rt.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) }); });
    await ctx.route(/accounts\.google\.com|google\.com\/chrome|chromewebstore/, rt => rt.fulfill({ status: 204, body: "" }));
    await ctx.addInitScript(([t, em]) => { if (location.host === "professor.lockqz.com") { localStorage.setItem("lockqz_token", t);
      for (const k of ["lockqz_tour_", "lockqz_welcome_", "lqz_welcome_"]) localStorage.setItem(k + em, "1"); } }, [token, email]);
    const pg = await ctx.newPage(); const errs = []; pg.on("pageerror", x => errs.push(x.message));
    await pg.goto("https://professor.lockqz.com/" + (hash ? "#" + hash : "")); await pg.waitForTimeout(1800);
    return { ctx, pg, errs };
  }
  { const { ctx, pg, errs } = await open(BT, "dbristow@usc.edu");
    const lbl = await pg.innerText("label.rem").catch(() => "");
    check("home: 'Remind students without LOCKqz by email 2 days before each exam · starts after you email your students'",
      /2 days before each exam/.test(lbl) && !/3 hours/.test(lbl) && /starts after you email your students/.test(lbl), lbl);
    await pg.evaluate(ou => { location.hash = "class/" + ou; }, OU); await pg.waitForTimeout(1200);
    const body = await pg.innerText("body");
    check("class page (gate off): 'Only students with LOCKqz can open the exam.', no browser that must stay open", /Only students with LOCKqz can open the exam\./.test(body) && !/while your browser is open/.test(body));
    check("same-day exam: its day once ('12:00 – 3:00 PM')", /12:00\s–\s3:00\sPM/.test(body) && !/12:00 PM – \w{3}, \w{3} \d+, 3:00 PM/.test(body), (body.match(/Exam 3[\s\S]{0,80}/) || [""])[0]);
    check("two-day exam: both days", /9:00 AM – \w{3}, \w{3} \d+, 9:00 AM/.test(body), (body.match(/Take-home Final[\s\S]{0,90}/) || [""])[0]);
    await pg.click("button.mailbtn"); await pg.waitForTimeout(1200); await pg.keyboard.press("Escape");
    check("his own Email students -> the class is no longer held", one("SELECT 1 AS x FROM mail_sent WHERE ou=? AND kind='prof' AND day='first'", OU)?.x === 1
      && (await api("/bs", undefined, { "X-LOCKqz-Teacher": BT })).data?.courses?.find(x => x.ou === OU)?.held === false);
    await pg.evaluate(() => { location.hash = ""; }); await pg.reload(); await pg.waitForTimeout(1800);
    const lbl2 = await pg.innerText("label.rem").catch(() => "");
    check("home after his email: the reminder line without 'starts after'", /2 days before each exam/.test(lbl2) && !/starts after/.test(lbl2), lbl2);
    await pg.evaluate(ou => { location.hash = "live/" + ou + "-901"; }, OU); await pg.waitForTimeout(1800);
    const foot = await pg.innerText("p.foot").catch(() => "");
    check("live view (gate off): 'Students without LOCKqz cannot open this exam.', no gate", /Students without LOCKqz cannot open this exam\./.test(foot) && !/gate/.test(foot), foot);
    check("no page errors", !errs.length, errs.join(" | "));
    await ctx.close(); }
  { const { ctx, pg } = await open(BT, "dbristow@usc.edu", { e: { ...ENV, REQUIRE_GATE: "1", EXAM_REMIND_3H: undefined }, hash: "class/" + OU });
    const body = await pg.innerText("body");
    check("gate on: the class page still says the browser must be open", /while your browser is open/.test(body));
    await pg.evaluate(() => { location.hash = ""; }); await pg.waitForTimeout(1200);
    check("EXAM_REMIND_3H unset: '2 days and again 3 hours before each exam'", /2 days and again 3 hours before each exam/.test(await pg.innerText("label.rem").catch(() => "")));
    await pg.evaluate(ou => { location.hash = "live/" + ou + "-901"; }, OU); await pg.waitForTimeout(1500);
    check("gate on: the live view names the gate", /while the gate is on/.test(await pg.innerText("p.foot").catch(() => "")));
    await ctx.close(); }
  { const { ctx, pg } = await open(BT, "dbristow@usc.edu", { width: 390, hash: "class/" + OU });
    const box = async sel => pg.evaluate(s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }, sel);
    const name = await box("li.ex .t"), sw = await box("li.ex .sw");
    check("phone: the exam's switch sits under its name and dates", !!name && !!sw && sw.y >= name.y + name.h, JSON.stringify({ name, sw }));
    check("phone: the exam name is one line wide (not a word per line)", !!name && name.w > 200, JSON.stringify(name));
    await ctx.close(); }
  { const { ctx, pg } = await open(BT, "dbristow@usc.edu", { hash: "class/" + OU });
    const name = await pg.evaluate(() => { const e = document.querySelector("li.ex .t").getBoundingClientRect(); const s = document.querySelector("li.ex .sw").getBoundingClientRect(); return { ny: e.y, sy: s.y, sh: s.height, nh: e.height }; });
    check("computer: the switch stays on the exam's own line", name.sy < name.ny + name.nh + 30, JSON.stringify(name));
    await ctx.close(); }
  { const AT = (await api("/login", { email: "athall@usc.edu", password: "adminpass1" })).data?.token;
    sqlite.prepare("UPDATE teachers SET active_until='2026-01-01' WHERE email='dbristow@usc.edu'").run();
    const { ctx, pg, errs } = await open(AT, "athall@usc.edu", { hash: "admin" });
    await pg.waitForTimeout(1500);
    const row = await pg.evaluate(() => [...document.querySelectorAll("#teachers tbody tr")].map(t => t.innerText).find(t => /dbristow@usc\.edu/.test(t)) || "");
    check("Admin, Professors: Professor Bristow 'free forever', not 'off'", /free forever/.test(row) && !/\boff\b/.test(row), row.replace(/\s+/g, " ").slice(0, 200));
    check("admin page: no page errors", !errs.length, errs.join(" | "));
    await ctx.close(); }
  await browser.close();
}
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
