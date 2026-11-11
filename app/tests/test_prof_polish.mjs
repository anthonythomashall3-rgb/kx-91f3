// What Professor Bristow met on his first visit (9 Nov 2026), now right:
//   N  names: a professor who never typed a name is named from the class list ("Bristow, Duke" -> "Duke Bristow"):
//      dashboard header, welcome email ("Hi Professor Bristow,"), emails written for him ("Professor Duke Bristow"),
//      never his email address; an account made earlier gets the name on its next visit; Brightspace's own name
//      at his first sync when no class list has one. Student email footers link lockqz.com/privacy.
//   B  browsers: Safari, Firefox (until the Mozilla-signed package exists), phones and tablets are told to open the
//      page in Chrome on a computer -- never developer-mode unzip steps.
//   W  first visit: "Welcome to LOCKqz" first, the test-run welcome after it (never both at once).
//   E  Email students: Outlook, Gmail or the mail app, students in Bcc, Copy buttons (works without a mail app).
//   P  plain wording: "both of your upcoming exams", "1 student", reminders "2 days and again 3 hours before".
//   U  the name menu closes on a click elsewhere or Escape; every page has a tab icon.
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare"), PUB = join(CF, "public");
const tmp = mkdtempSync(join(tmpdir(), "lqz-polish-"));
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
const mail = [];
const env = { DB: db, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", ROT_SECRET: "rs", PW_PEPPER: "pp", FEE_EXEMPT: "dbristow@usc.edu",
  MAIL_SINK: async m => { mail.push(m); return true; } };
async function api(path, body, headers = {}, ip = "10.7.0.1") {
  const res = await onRequest({ request: new Request("https://lockqz.pages.dev/api" + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env, waitUntil: () => {} });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const ADMIN = { "X-LOCKqz-Teacher": "admin-key" };
const OU = "302972", day = 86400e3;
const cl = [{ id: "4000", name: "Bristow, Duke", email: "dbristow@usc.edu", role: "Instructor" }, { id: "4100", name: "Hall, Anthony", email: "athall@usc.edu", role: "Teaching Assistant" },
  { id: "5001", name: "One, Stu", email: "stu1@usc.edu", role: "Student" }];
await api("/signup", { email: "athall@usc.edu", password: "adminpass1", name: "Anthony Hall" });
await api("/sync", { courses: [{ ou: OU, name: "20263_14792 BUAD-306: Business Finance", code: "20263_14792", role: "Teaching Assistant", classlist: cl, quizzes: [] }] }, ADMIN);
const row = em => sqlite.prepare("SELECT id, name, verified FROM teachers WHERE email=?").get(em);

console.log("N names come from the class list, never the email address");
let r = await api("/invite", { email: "dbristow@usc.edu", until: "2026-12-31" }, ADMIN);
r = await api("/signup", { email: "dbristow@usc.edu", password: "bristow-pass1", invite: r.data.code });
const BT = r.data?.token;
check("sign-up with no name typed -> named 'Duke Bristow' from the class list", r.status === 200 && row("dbristow@usc.edu")?.name === "Duke Bristow" && r.data.name === "Duke Bristow", JSON.stringify(r.data));
const wel = mail.filter(m => m.to === "dbristow@usc.edu").pop();
check("welcome email: 'Hi Professor Bristow,'", /^Hi Professor Bristow,/.test(wel?.text || "") && !/dbristow/.test((wel?.text || "").split("\n")[0]), (wel?.text || "").slice(0, 40));
sqlite.prepare("UPDATE teachers SET name=NULL WHERE email='dbristow@usc.edu'").run();
r = await api("/me", undefined, { "X-LOCKqz-Teacher": BT });
check("an account made without a name gets it on its next visit (/me)", r.data?.name === "Duke Bristow" && row("dbristow@usc.edu")?.name === "Duke Bristow", JSON.stringify(r.data));
r = await api("/invite", { email: "nobody@usc.edu" }, ADMIN);
await api("/signup", { email: "nobody@usc.edu", password: "nobody-pass1", invite: r.data.code });
check("no name anywhere -> welcome says 'Hi,' (never the address)", /^Hi,\n/.test(mail.filter(m => m.to === "nobody@usc.edu").pop()?.text || ""));
// His own first sync: Brightspace confirms him (verified) and the dashboard lists his class.
r = await api("/sync", { whoami: { id: "4000", name: "Duke Bristow" }, courses: [{ ou: OU, name: "20263_14792 BUAD-306: Business Finance", code: "20263_14792", role: "Instructor", classlist: cl,
  quizzes: [{ qi: "201", name: "Exam 3", start: new Date(Date.now() + 2 * day).toISOString(), end: new Date(Date.now() + 2.1 * day).toISOString(), active: true }] }] }, { "X-LOCKqz-Teacher": BT });
check("his own sync verifies him", r.status === 200 && row("dbristow@usc.edu")?.verified === 1, JSON.stringify(r.data).slice(0, 200));
// A professor no class list names: Brightspace's own name at his first sync.
sqlite.prepare("INSERT INTO teacher_courses (teacher_id,ou,name,code,role,synced_at,in_sync) VALUES ('admin','900','X','X','Teaching Assistant',?,1)").run(new Date().toISOString());
sqlite.prepare("INSERT INTO roster (ou,user_id,name,email,username,org_id,role,synced_at) VALUES ('900','77',NULL,'pat@usc.edu','pat','9','Instructor',?)").run(new Date().toISOString());
r = await api("/invite", { email: "pat@usc.edu" }, ADMIN);
const PT = (await api("/signup", { email: "pat@usc.edu", password: "pat-pass-123", invite: r.data.code })).data?.token;
check("setup: a professor with no name anywhere", row("pat@usc.edu") && row("pat@usc.edu").name === null);
await api("/sync", { whoami: { id: "77", name: "Pat Moreno" }, courses: [] }, { "X-LOCKqz-Teacher": PT });
check("his first sync names him from Brightspace", row("pat@usc.edu")?.name === "Pat Moreno", JSON.stringify(row("pat@usc.edu")));
r = await api("/email/students", { ou: OU, kind: "all" }, { "X-LOCKqz-Teacher": BT });
check("Email students: signed 'Professor Duke Bristow', never the address", r.status === 200 && /Professor Duke Bristow/.test(r.data?.text || "") && !/@usc\.edu/.test((r.data?.text || "").split("Respectfully")[1] || ""), (r.data?.text || "").slice(-200));
const route = readFileSync(join(CF, "functions", "api", "[[route]].js"), "utf8");
check("student email footer links lockqz.com/privacy (no 'cages' typo)", !/cages\.dev/.test(route) && /lockqz\.com\/privacy<\/a>/.test(route));

console.log("R a professor resets his own password (no admin)");
const before = mail.length;
r = await api("/forgot", { email: "nobody-here@usc.edu" }, {}, "10.7.1.1");
check("an unknown email: ok, nothing sent (never reveals who has an account)", r.status === 200 && r.data?.ok === true && mail.length === before);
r = await api("/forgot", { email: "DBristow@usc.edu" }, {}, "10.7.1.1");
const rc = mail.filter(m => m.to === "dbristow@usc.edu" && m.code).pop();
check("his own email gets a 6-digit reset code", r.data?.ok === true && /^\d{6}$/.test(rc?.code || "") && /password reset code/.test(rc?.text || ""), JSON.stringify(r.data));
r = await api("/forgot/reset", { email: "dbristow@usc.edu", code: rc.code === "000000" ? "111111" : "000000", password: "new-pass-123" }, {}, "10.7.1.1");
check("a wrong code -> wrong_code, password unchanged", r.status === 400 && r.data?.error === "wrong_code" && (await api("/login", { email: "dbristow@usc.edu", password: "bristow-pass1" }, {}, "10.7.1.2")).status === 200, JSON.stringify(r.data));
r = await api("/forgot/reset", { email: "dbristow@usc.edu", code: rc.code, password: "new-pass-123" }, {}, "10.7.1.1");
check("the right code -> new password set and signed in", r.status === 200 && typeof r.data?.token === "string", JSON.stringify(r.data));
const NBT = r.data?.token;
check("the old password stops working, the new one works", (await api("/login", { email: "dbristow@usc.edu", password: "bristow-pass1" }, {}, "10.7.1.3")).status === 401 && (await api("/login", { email: "dbristow@usc.edu", password: "new-pass-123" }, {}, "10.7.1.3")).status === 200);
check("the code is spent", (await api("/forgot/reset", { email: "dbristow@usc.edu", code: rc.code, password: "again-pass-1" }, {}, "10.7.1.1")).data?.error === "code_expired");
check("the old session ends", (await api("/me", undefined, { "X-LOCKqz-Teacher": BT })).status === 401);
const dashSrc = readFileSync(join(PUB, "dashboard.html"), "utf8");
check("the page: Email me a code -> code + new password -> Set new password", dashSrc.includes('onclick="requestReset()">Email me a code') && dashSrc.includes('post("/forgot/reset",{email,code,password:pw})') && !/admin has been notified/.test(dashSrc));
const BT2 = (await api("/login", { email: "dbristow@usc.edu", password: "new-pass-123" }, {}, "10.7.1.4")).data?.token;

console.log("I an invite still waiting for an email ends when that professor signs up by himself");
await api("/invite", { email: "inv2@usc.edu" }, ADMIN);
await api("/signup/code", { email: "inv2@usc.edu" }, {}, "10.7.2.1");
const c2 = mail.filter(m => m.to === "inv2@usc.edu" && m.code).pop()?.code;
r = await api("/signup", { email: "inv2@usc.edu", password: "inv2-pass-123", code: c2 }, {}, "10.7.2.1");
check("code sign-up works and the waiting invite is marked used", r.status === 200 && !sqlite.prepare("SELECT 1 FROM invites WHERE email='inv2@usc.edu' AND used_at IS NULL").get(), JSON.stringify(r.data));
check("fee reminders send students to lockqz.com/pay", route.includes("pay at ${SITE_URL}/pay before the exam.") && route.includes('href="${SITE_URL}/pay" style="color:#990000">lockqz.com/pay</a>'));

console.log("U/P/B/W/E in the page source");
const dash = readFileSync(join(PUB, "dashboard.html"), "utf8");
for (const f of readdirSync(PUB).filter(f => f.endsWith(".html"))) check(`tab icon on ${f}`, /<link rel="icon" type="image\/png" href="\/icon128\.png">/.test(readFileSync(join(PUB, f), "utf8")));
check("no developer-mode steps offered to Safari / phones (they get 'Open this page in Chrome')", dash.includes('const extD = BROWSER === "other" ? OTHER_TXT()') && dash.includes('"Open this page on your computer, in Chrome."'));
check("Firefox without the signed package counts as 'use Chrome'", /Firefox\\\/\/\.test\(u\) \? \(FF_XPI \? "firefox" : "other"\)/.test(dash));
check("reminder wording", dash.includes("2 days and again 3 hours before each exam"));
check("the Email students chooser closes when the page changes", dash.includes('window.addEventListener("hashchange", () => document.querySelectorAll(".lqaddr").forEach(e => e.remove()));'));

// ---- real Chromium: the page itself ----
let chromium; try { ({ chromium } = createRequire(import.meta.url)("playwright")); } catch {}
if (!chromium) try { ({ chromium } = createRequire("/opt/npm-tools/node_modules/")("playwright")); } catch {}
if (!chromium) { console.log("  skip: real-browser checks (no playwright)"); }
else {
  const UA = { safari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
    iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    chrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" };
  const browser = await chromium.launch({ headless: true });
  async function open(ua, { token = BT2, welcomed = true } = {}) {
    const ctx = await browser.newContext({ userAgent: ua, viewport: ua === UA.iphone ? { width: 390, height: 844 } : { width: 1280, height: 860 } });
    await ctx.route("https://professor.lockqz.com/**", async rt => { const u = new URL(rt.request().url()); const f = u.pathname === "/" ? "dashboard.html" : u.pathname.slice(1);
      try { await rt.fulfill({ status: 200, contentType: f.endsWith(".js") ? "application/javascript" : f.endsWith(".png") ? "image/png" : "text/html", body: readFileSync(join(PUB, f)) }); } catch { await rt.fulfill({ status: 404, body: "" }); } });
    await ctx.route("https://lockqz.com/api/**", async rt => { const q = rt.request(); const u = new URL(q.url());
      const res = await onRequest({ request: new Request("https://lockqz.pages.dev" + u.pathname + u.search, { method: q.method(), headers: { ...q.headers(), "cf-connecting-ip": "10.7.0.9" }, body: ["GET", "HEAD", "OPTIONS"].includes(q.method()) ? undefined : q.postData() }), env, waitUntil: () => {} });
      await rt.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) }); });
    await ctx.route(/accounts\.google\.com|google\.com\/chrome/, rt => rt.fulfill({ status: 204, body: "" }));
    await ctx.addInitScript(([t, w]) => { if (location.host === "professor.lockqz.com") { localStorage.setItem("lockqz_token", t); localStorage.setItem("lockqz_tour_dbristow@usc.edu", "1");
      if (w) { localStorage.setItem("lockqz_welcome_dbristow@usc.edu", "1"); localStorage.setItem("lqz_welcome_dbristow@usc.edu", "1"); } } }, [token, welcomed]);
    const pg = await ctx.newPage(); const errs = []; pg.on("pageerror", e => errs.push(e.message));
    await pg.goto("https://professor.lockqz.com/"); await pg.waitForTimeout(1800);
    return { ctx, pg, errs };
  }
  check("setup: the page's welcome key is the one this test sets", dash.includes('const WELKEY = () => "lockqz_welcome_" + String((ME && ME.email) || "").toLowerCase();'));
  console.log("B what each browser is told");
  for (const [k, want, not] of [["safari", /Open this page in Chrome\./, /Unzip|Developer mode/], ["firefox", /Open this page in Chrome\./, /Unzip|Temporary Add-on/], ["iphone", /Open this page on your computer, in Chrome\./, /Unzip|Get Chrome/]]) {
    const { ctx, pg, errs } = await open(UA[k]); const t = await pg.innerText("body");
    check(`${k}: '${want.source.replace(/\\/g, "")}', no developer-mode steps`, want.test(t) && !not.test(t), t.slice(0, 300));
    check(`${k}: no page errors`, !errs.length, errs.join(" | ")); await ctx.close();
  }
  { const { ctx, pg } = await open(UA.chrome); const href = await pg.getAttribute("a:has-text('Add to Chrome')", "href").catch(() => null);
    check("Chrome: 'Add to Chrome' opens the Chrome Web Store listing", /chromewebstore\.google\.com\/detail\//.test(href || ""), String(href));
    console.log("U the name menu");
    await pg.click("#who"); const open1 = await pg.evaluate(() => document.getElementById("menu").open);
    await pg.mouse.click(640, 700); const shut1 = await pg.evaluate(() => !document.getElementById("menu").open);
    await pg.click("#who"); await pg.keyboard.press("Escape"); const shut2 = await pg.evaluate(() => !document.getElementById("menu").open);
    check("opens, closes on a click elsewhere and on Escape", open1 && shut1 && shut2, [open1, shut1, shut2].join());
    check("header shows his name", /Duke Bristow/.test(await pg.innerText("#who")));
    console.log("E Email students");
    await pg.evaluate(ou => { location.hash = "class/" + ou; }, OU); await pg.waitForTimeout(1200);
    await pg.click("button.mailbtn"); await pg.waitForTimeout(1200);
    const box = await pg.$(".lqaddr [role=dialog]");
    const links = box ? await box.$$eval("a[data-i]", as => as.map(a => [a.textContent, a.getAttribute("href")])) : [];
    check("a chooser: Outlook, Gmail, Mail app", links.map(l => l[0]).join() === "Outlook,Gmail,Mail app", JSON.stringify(links.map(l => l[0])));
    check("Gmail and the mail app put the students in Bcc; Outlook (no Bcc in its link) copies them", /[?&]bcc=stu1%40usc\.edu/.test(links[1]?.[1] || "") && /^mailto:\?bcc=/.test(links[2]?.[1] || "") && !/bcc=/.test(links[0]?.[1] || ""), JSON.stringify(links).slice(0, 300));
    check("Copy addresses / Copy message / Done", !!box && (await box.innerText()).includes("Copy addresses") && (await box.innerText()).includes("Copy message"));
    await ctx.close(); }
  console.log("W first visit: one message at a time");
  { const { ctx, pg } = await open(UA.chrome, { welcomed: false });
    const w1 = await pg.innerText("body"), m1 = await pg.$(".lqwel");
    check("'Welcome to LOCKqz' first, without the test-run welcome on top", /Welcome to LOCKqz/.test(w1) && !m1);
    await pg.click("button:has-text('Got it')"); await pg.waitForTimeout(800);
    check("after 'Got it': the test-run welcome", !!(await pg.$(".lqwel")));
    await ctx.close(); }
  await browser.close();
}
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
