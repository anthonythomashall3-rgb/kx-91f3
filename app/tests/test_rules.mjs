// Exam rules (27 Nov 2026): the professor chooses what students may use in an exam beside Brightspace.
//   K  one list of rows everywhere: the server's keys, the dashboard's rows and the apps' catalog (mac/rules-catalog.json,
//      the same file on Windows) are the same 40 rows; messaging and the rows with AI inside start blocked.
//   S  POST /rules: only the class's professor; unknown rows dropped; a preset stays a preset; an AI site is never
//      allowed; Brightspace / sign-in sites and the system or a browser are never blocked; "every exam" ends the exams'
//      own rules.
//   B  /bs gives each class's rule and each exam's own (RULES_ON); nothing while RULES_ON is off.
//   P  /password sends the rules the exam follows (own > class > default "Notes + internet"); nothing while RULES_ON is off.
//   D  dashboard (real Chromium): the pill under each protected exam, the panel, Save, "this exam", the switches.
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url)), APP = join(HERE, ".."), CF = join(APP, "cloudflare"), PUB = join(CF, "public");
const tmp = mkdtempSync(join(tmpdir(), "lqz-rules-"));
const SRC = readFileSync(join(CF, "functions", "api", "[[route]].js"), "utf8");
writeFileSync(join(tmp, "route.mjs"), SRC);
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
  FREE_FOREVER: "dbristow@usc.edu", REQUIRE_GATE: "0", RULES_ON: "1" };
let env = ENV;
const sign = (key, path, ts, raw) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(raw).digest("hex")}`).digest("hex");
async function api(path, body, headers = {}, e = env) {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const res = await onRequest({ request: new Request("https://lockqz.pages.dev/api" + path, { method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.49.0.1", ...headers }, body: raw }), env: e });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function dev(path, body, d, e = env) {
  const raw = JSON.stringify(body), ts = String(Math.floor(Date.now() / 1000));
  return api(path, body, { "X-LOCKqz-Device": d.id, "X-LOCKqz-Time": ts, "X-LOCKqz-Sig": sign(d.key, "/api" + path, ts, raw) }, e);
}
const ADMIN = { "X-LOCKqz-Teacher": "admin-key" };
const one = (sql, ...a) => sqlite.prepare(sql).get(...a);

// ---- K: one list of rows ----
console.log("K one list of rows everywhere");
const cat = JSON.parse(readFileSync(join(APP, "mac", "rules-catalog.json"), "utf8"));
const catKeys = Object.keys(cat.rows), catOff = catKeys.filter(k => cat.rows[k].default === "block");
const arr = name => JSON.parse(SRC.match(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`))[1]);
const srvKeys = arr("RULE_KEYS"), srvOff = arr("RULE_BLOCKED");
const dash = readFileSync(join(PUB, "dashboard.html"), "utf8");
const dashKeys = [...dash.slice(dash.indexOf("const RG = ["), dash.indexOf("const RKEYS")).matchAll(/\{ k: "([a-z]+)"/g)].map(m => m[1]);
check("40 rows, the same in the server, the dashboard and the catalog", catKeys.length === 40 && JSON.stringify(srvKeys) === JSON.stringify(catKeys) && JSON.stringify(dashKeys) === JSON.stringify(catKeys), JSON.stringify([srvKeys.length, dashKeys.length]));
check("start blocked: the messaging rows and the rows with AI inside (and only those)", JSON.stringify(srvOff) === JSON.stringify(catOff)
  && JSON.stringify(catOff) === JSON.stringify(["solvers", "text", "chat", "email", "calls", "youtube", "social", "homework", "writing", "translate"]), JSON.stringify(catOff));
check("server's never-close names and always-open sites = the catalog's", JSON.stringify([...new Set(JSON.parse(SRC.match(/const RULE_NEVER_CLOSE = new Set\((\[[^\]]*\])\)/)[1]))]) === JSON.stringify(cat.never_close)
  && JSON.stringify(arr("RULE_BASE")) === JSON.stringify(cat.base_allow));
let winCat = null; try { winCat = readFileSync(join(APP, "windows", "rules-catalog.json"), "utf8"); } catch {}
check("Windows ships the same catalog file", winCat === readFileSync(join(APP, "mac", "rules-catalog.json"), "utf8"));
check("the catalog is plain ASCII (Windows PowerShell 5.1 reads it)", /^[\x00-\x7f]*$/.test(readFileSync(join(APP, "mac", "rules-catalog.json"), "utf8")));
const aiList = readFileSync(join(APP, "mac", "blocklist.txt"), "utf8").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
const allowedOnes = catKeys.filter(k => cat.rows[k].default === "allow").flatMap(k => [...cat.rows[k].hosts, ...cat.rows[k].paths, ...cat.rows[k].web]);
check("no row that starts allowed opens a site on the AI list", !allowedOnes.some(x => aiList.includes(x)), allowedOnes.filter(x => aiList.includes(x)).join(","));
check("base sites never on the AI list", !cat.base_allow.some(x => aiList.includes(x)));
check("a catalog name that a row closes is never a system name or a browser", !catKeys.flatMap(k => [...cat.rows[k].mac, ...cat.rows[k].win, ...cat.rows[k].linux]).some(n => cat.never_close.includes(n.toLowerCase())));

// ---- setup: a class, its professor, two exams, a student's computer ----
const OU = "302972", day = 86400e3;
const cl = [{ id: "4000", name: "Bristow, Duke", email: "dbristow@usc.edu", role: "Instructor" }, { id: "5001", name: "One, Stu", email: "stu1@usc.edu", role: "Student" },
  { id: "5002", name: "Two, Stu", email: "stu2@usc.edu", role: "Student" }];
await api("/signup", { email: "athall@usc.edu", password: "adminpass1", name: "Admin" });
await api("/sync", { courses: [{ ou: OU, name: "20263_14792 BUAD-306: Business Finance", code: "20263_14792", role: "Instructor", classlist: cl, quizzes: [] }] }, ADMIN);
const inv = await api("/invite", { email: "dbristow@usc.edu", until: "2026-12-31" }, ADMIN);
const BT = (await api("/signup", { email: "dbristow@usc.edu", password: "dbristow-pass-1", invite: inv.data.code })).data?.token;
const T = { "X-LOCKqz-Teacher": BT };
const iso = d => new Date(Date.now() + d).toISOString();
const quizzes = [{ qi: "901", name: "Exam 3", start: iso(-day), end: iso(5 * day), active: true }, { qi: "902", name: "Final Exam", start: iso(-day), end: iso(9 * day), active: true }];
let r = await api("/sync", { whoami: { id: "4000", name: "Duke Bristow" }, courses: [{ ou: OU, name: "20263_14792 BUAD-306: Business Finance", code: "20263_14792", role: "Instructor", classlist: cl, quizzes }] }, T);
check("setup: both exams protected", r.status === 200 && Number(one("SELECT COUNT(*) AS n FROM quizzes WHERE ou=? AND password IS NOT NULL", OU)?.n) === 2, JSON.stringify(r.data).slice(0, 160));
const STU = { id: "mac-" + randomBytes(4).toString("hex"), key: randomBytes(32).toString("hex") };
await api("/register", { device_id: STU.id, key: STU.key, student: "stu1@usc.edu", platform: "mac" });
const QURL = qi => `https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${qi}&ou=${OU}`;
async function pw(qi, e = env) { await dev("/report", { device_id: STU.id, event: "lock", quiz_id: `${OU}-${qi}` }, STU, e); return dev("/password", { url: QURL(qi), device_id: STU.id }, STU, e); }

// ---- S: POST /rules ----
console.log("S saving rules");
r = await api("/rules", { ou: OU, qi: "901", rules: { p: "notes" } });
check("no account -> refused", r.status === 401 || r.status === 403, String(r.status));
const STB = (await api("/signup", { email: "stu2@usc.edu", password: "stu2-pass-123", name: "Stu Two" })).data?.token;
if (STB) { r = await api("/rules", { ou: OU, qi: "901", rules: { p: "notes" } }, { "X-LOCKqz-Teacher": STB }); check("a student's account -> refused", r.status === 403 || r.status === 401, String(r.status)); }
r = await api("/rules", { ou: OU, qi: "777", rules: { p: "notes" } }, T);
check("an exam not in the class -> 404", r.status === 404, JSON.stringify(r.data));
r = await api("/rules", { ou: OU, qi: "901", rules: { p: "custom", b: [...srvOff, "excel", "bogus", "excel"], allow: ["https://www.Investopedia.com/terms/b/bond.asp", "bad site", "investopedia.com"], block: ["Spotify", "khanacademy.org", "<script>"] } }, T);
const saved = JSON.parse(one("SELECT rules FROM quiz_rules WHERE ou=? AND qi='901'", OU)?.rules || "null");
check("custom: unknown rows dropped, sites cleaned, junk dropped", r.status === 200 && r.data?.label === "Custom" && saved?.b.includes("excel") && !saved?.b.includes("bogus") && saved.b.length === srvOff.length + 1
  && JSON.stringify(saved.allow) === '["investopedia.com"]' && JSON.stringify(saved.block) === '["Spotify","khanacademy.org"]', JSON.stringify(saved));
r = await api("/rules", { ou: OU, qi: "901", rules: { p: "custom", b: [...srvOff, "search", "wiki", "web"] } }, T);
check("the same switches as a preset, nothing typed -> that preset ('Notes only')", r.data?.label === "Notes only" && r.data?.rules?.p === "notes", JSON.stringify(r.data));
for (const [bad, why] of [[{ allow: ["chatgpt.com"] }, /AI/], [{ allow: ["chat.openai.com"] }, /AI/], [{ allow: ["gemini.google.com"] }, /AI/], [{ block: ["brightspace.com"] }, /needed/],
  [{ block: ["usc.brightspace.com"] }, /needed/], [{ block: ["google.com"] }, /needed/], [{ block: ["Finder"] }, /cannot be closed/], [{ block: ["explorer.exe"] }, /cannot be closed/],
  [{ block: ["Google Chrome"] }, /cannot be closed/], [{ block: ["Safari.app"] }, /cannot be closed/], [{ block: ["python3"] }, /cannot be closed/]]) {
  r = await api("/rules", { ou: OU, qi: "902", rules: { p: "custom", b: srvOff, allow: [], block: [], ...bad } }, T);
  check(`refused: ${JSON.stringify(bad)} (${r.data?.error})`, r.status === 400 && why.test(r.data?.error || ""), JSON.stringify(r.data));
}
check("nothing saved for the refused ones", !one("SELECT 1 AS x FROM quiz_rules WHERE ou=? AND qi='902'", OU));
r = await api("/rules", { ou: OU, qi: "902", rules: { p: "custom", b: srvOff, allow: ["wikipedia.org"], block: [] } }, T);
check("a site that is not AI is allowed (wikipedia.org)", r.status === 200 && r.data?.rules?.allow?.[0] === "wikipedia.org", JSON.stringify(r.data));

// ---- P + B ----
console.log("P /password and B /bs");
r = await pw("901");
check("/password: the exam's own rule (Notes only: search, wiki, web blocked)", !!r.data?.password && r.data?.rules?.label === "Notes only" && ["search", "wiki", "web", "chat", "calls"].every(k => r.data.rules.b.includes(k)) && r.data.rules.v === 1, JSON.stringify(r.data));
r = await api("/bs", undefined, T);
let c = r.data?.courses?.find(x => x.ou === OU);
check("/bs: rules_on, no class rule yet, each exam's own rule", r.data?.rules_on === true && c?.rules === null && c?.quizzes?.find(q => q.qi === "901")?.rules?.p === "notes" && c?.quizzes?.find(q => q.qi === "902")?.rules?.p === "custom", JSON.stringify(c?.quizzes?.map(q => q.rules)));
r = await api("/rules", { ou: OU, qi: "901", all: true, rules: { p: "custom", b: srvOff.filter(k => k !== "calls") } }, T);
check("every exam: the class's rule saved, the exams' own rules end", r.status === 200 && one("SELECT COUNT(*) AS n FROM quiz_rules WHERE ou=?", OU)?.n === 1 && one("SELECT qi FROM quiz_rules WHERE ou=?", OU)?.qi === "*", JSON.stringify(r.data));
r = await pw("902");
check("/password: the class's rule (video calls allowed for an exam watched over Zoom)", r.data?.rules?.label === "Custom" && !r.data.rules.b.includes("calls") && r.data.rules.b.includes("text"), JSON.stringify(r.data?.rules));
await api("/rules", { ou: OU, qi: "902", rules: { p: "open" } }, T);
r = await pw("902");
check("/password: an exam's own rule beats the class's", r.data?.rules?.label === "Notes + internet" && r.data.rules.b.includes("calls"), JSON.stringify(r.data?.rules));
sqlite.prepare("DELETE FROM quiz_rules").run();
r = await pw("901");
check("/password: no rule anywhere -> the default (Notes + internet: messaging and AI-inside rows blocked)", r.data?.rules?.label === "Notes + internet" && JSON.stringify(r.data.rules.b) === JSON.stringify(srvOff) && r.data.rules.allow.length === 0, JSON.stringify(r.data?.rules));
const OFF = { ...ENV, RULES_ON: "0" };
await api("/rules", { ou: OU, qi: "901", rules: { p: "notes" } }, T);
r = await pw("901", OFF);
check("RULES_ON off: /password gives the password and no rules", !!r.data?.password && !("rules" in r.data), JSON.stringify(r.data));
r = await api("/bs", undefined, T, OFF);
c = r.data?.courses?.find(x => x.ou === OU);
check("RULES_ON off: /bs says rules_on false and reads no rules", r.data?.rules_on === false && c?.rules === null && c?.quizzes?.every(q => q.rules === null));
r = await pw("901");
check("RULES_ON on: an unchanged password answer otherwise (lockId, end)", r.data?.lockId === `${OU}-901` && "end" in r.data);

// ---- D: the dashboard in a real browser ----
let chromium; try { ({ chromium } = createRequire(import.meta.url)("playwright")); } catch {}
if (!chromium) try { ({ chromium } = createRequire("/opt/npm-tools/node_modules/")("playwright")); } catch {}
if (!chromium) console.log("  skip: real-browser checks (no playwright)");
else {
  console.log("D the dashboard");
  sqlite.prepare("DELETE FROM quiz_rules").run();
  const browser = await chromium.launch({ headless: true });
  async function open({ width = 1280, e = ENV, hash = "class/" + OU } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: "America/Los_Angeles", locale: "en-US" });
    await ctx.route("https://professor.lockqz.com/**", async rt => { const u = new URL(rt.request().url()); const f = u.pathname === "/" ? "dashboard.html" : u.pathname.slice(1);
      try { await rt.fulfill({ status: 200, contentType: f.endsWith(".js") ? "application/javascript" : f.endsWith(".png") ? "image/png" : "text/html", body: readFileSync(join(PUB, f)) }); } catch { await rt.fulfill({ status: 404, body: "" }); } });
    await ctx.route("https://lockqz.com/api/**", async rt => { const q = rt.request(); const u = new URL(q.url());
      const res = await onRequest({ request: new Request("https://lockqz.pages.dev" + u.pathname + u.search, { method: q.method(), headers: { ...q.headers(), "cf-connecting-ip": "10.49.0.9" },
        body: ["GET", "HEAD", "OPTIONS"].includes(q.method()) ? undefined : q.postData() }), env: e });
      await rt.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) }); });
    await ctx.route(/accounts\.google\.com|google\.com\/chrome|chromewebstore|fonts\.g/, rt => rt.fulfill({ status: 204, body: "" }));
    await ctx.addInitScript(([t, em]) => { if (location.host === "professor.lockqz.com") { localStorage.setItem("lockqz_token", t);
      for (const k of ["lockqz_tour_", "lockqz_welcome_", "lqz_welcome_"]) localStorage.setItem(k + em, "1"); } }, [BT, "dbristow@usc.edu"]);
    const pg = await ctx.newPage(); const errs = []; pg.on("pageerror", x => errs.push(x.message));
    await pg.goto("https://professor.lockqz.com/#" + hash); await pg.waitForTimeout(1800);
    return { ctx, pg, errs };
  }
  { const { ctx, pg, errs } = await open({ e: OFF });
    check("RULES_ON off: no pill on the class page", (await pg.locator("button.rp").count()) === 0);
    check("RULES_ON off: no page errors", !errs.length, errs.join(" | "));
    await ctx.close(); }
  { const { ctx, pg, errs } = await open();
    const pills = await pg.locator("button.rp").allInnerTexts();
    check("a pill under each protected exam: 'Notes + internet'", pills.length === 2 && pills.every(t => /Notes \+ internet/.test(t)), JSON.stringify(pills));
    await pg.locator("button.rp").first().click(); await pg.waitForTimeout(300);
    const pan = await pg.innerText(".lqr .pan");
    check("panel: exam name, 'What can students use?', 'AI is always blocked.', three choices, Default on the first",
      /Exam 3/i.test(pan) && /What can students use\?/.test(pan) && /AI is always blocked\./.test(pan) && /Notes \+ internet[\s\S]*Notes only[\s\S]*Custom/.test(pan) && /Default/.test(pan), pan.slice(0, 300));
    check("'Use for every exam in BUAD-306…' is ticked (no exam has its own rule)", await pg.locator(".lqr input[data-act=all]").isChecked() && /Use for every exam in BUAD-306/.test(pan));
    await pg.click(".lqr button.ch[data-v=notes]"); await pg.click(".lqr button[data-act=save]"); await pg.waitForTimeout(1200);
    check("Notes only for every exam -> the class's rule; both pills say 'Notes only'", JSON.parse(one("SELECT rules FROM quiz_rules WHERE ou=? AND qi='*'", OU)?.rules || "{}").p === "notes"
      && (await pg.locator("button.rp").allInnerTexts()).every(t => /Notes only/.test(t) && !/this exam/.test(t)), JSON.stringify(await pg.locator("button.rp").allInnerTexts()));
    await pg.locator("button.rp").nth(1).click(); await pg.waitForTimeout(300);
    await pg.click(".lqr button.ch[data-v=custom]"); await pg.waitForTimeout(200);
    const groups = await pg.locator(".lqr .grp").count();
    check("Custom: 9 sections, search box, Also allow / Also block, Always open / Always blocked", groups === 9 && await pg.locator("#lqr-find").count() === 1
      && /Also allow a website[\s\S]*Also block an app or website[\s\S]*Always open[\s\S]*Always blocked/i.test(await pg.innerText(".lqr .pan")));
    await pg.fill("#lqr-find", "zoom"); await pg.waitForTimeout(200);
    check("search 'zoom' leaves only Video calls", (await pg.locator(".lqr .rw").count()) === 1 && /Video calls/.test(await pg.innerText(".lqr #lqr-groups")));
    await pg.click(".lqr button.a[data-v=calls]"); await pg.fill("#lqr-find", ""); await pg.waitForTimeout(200);
    await pg.click(".lqr button.b[data-v=excel]");
    await pg.fill("#lqr-allow", "youtube.com"); await pg.click(".lqr button[data-act=addA]"); await pg.waitForTimeout(150);
    check("'Also allow youtube.com' moves the YouTube switch to Allowed (no chip), with 'Its AI works too.'", await pg.locator(".lqr button.a[data-v=youtube]").getAttribute("aria-pressed") === "true"
      && (await pg.locator(".lqr .chip").count()) === 0 && /Its AI works too\./.test(await pg.innerText(".lqr #lqr-groups")));
    await pg.fill("#lqr-allow", "https://www.investopedia.com/terms"); await pg.keyboard.press("Enter"); await pg.waitForTimeout(150);
    await pg.fill("#lqr-block", "Spotify"); await pg.click(".lqr button[data-act=addB]"); await pg.waitForTimeout(150);
    check("chips: investopedia.com allowed, Spotify blocked", JSON.stringify((await pg.locator(".lqr .chip").allInnerTexts()).map(t => t.replace(/[×\s]+$/, ""))) === '["investopedia.com","Spotify"]', JSON.stringify(await pg.locator(".lqr .chip").allInnerTexts()));
    await pg.click(".lqr input[data-act=all]");   // this exam only
    await pg.click(".lqr button[data-act=save]"); await pg.waitForTimeout(1200);
    const own = JSON.parse(one("SELECT rules FROM quiz_rules WHERE ou=? AND qi='902'", OU)?.rules || "{}");
    check("saved for this exam only: calls + YouTube allowed, Excel blocked, the two typed entries", own.p === "custom" && !own.b.includes("calls") && !own.b.includes("youtube") && own.b.includes("excel")
      && JSON.stringify(own.allow) === '["investopedia.com"]' && JSON.stringify(own.block) === '["Spotify"]' && JSON.parse(one("SELECT rules FROM quiz_rules WHERE ou=? AND qi='*'", OU)?.rules || "{}").p === "notes", JSON.stringify(own));
    const pills2 = await pg.locator("button.rp").allInnerTexts();
    check("pills: 'Notes only' and 'Custom · this exam'", /Notes only/.test(pills2[0]) && /Custom/.test(pills2[1]) && /this exam/.test(pills2[1]), JSON.stringify(pills2));
    await pg.locator("button.rp").nth(1).click(); await pg.waitForTimeout(300);
    check("reopened: its own rule, the box unticked", !(await pg.locator(".lqr input[data-act=all]").isChecked()) && await pg.locator(".lqr button.b[data-v=excel]").getAttribute("aria-pressed") === "true");
    await pg.keyboard.press("Escape"); await pg.waitForTimeout(150);
    check("Escape closes the panel", (await pg.locator(".lqr").count()) === 0);
    await pg.locator("button.rp").first().click(); await pg.waitForTimeout(300);
    check("another exam, box ticked: it says the other exam's own rule ends", /Ends the own rules of Final Exam\./.test(await pg.innerText(".lqr .pan")));
    await pg.click(".lqr button.ch[data-v=custom]"); await pg.fill("#lqr-allow", "chatgpt.com"); await pg.click(".lqr button[data-act=addA]");
    await pg.click(".lqr button[data-act=save]"); await pg.waitForTimeout(800);
    check("an AI site: the server's reason shows, the panel stays open", /chatgpt\.com is AI/.test(await pg.innerText(".lqr .pan").catch(() => "")), await pg.innerText(".lqr .pan").catch(() => "-"));
    await pg.click(".lqr button[data-act=cancel]");
    check("no page errors", !errs.length, errs.join(" | "));
    await ctx.close(); }
  { const { ctx, pg } = await open({ width: 390 });
    await pg.locator("button.rp").first().click(); await pg.waitForTimeout(300); await pg.click(".lqr button.ch[data-v=custom]"); await pg.waitForTimeout(200);
    const w = await pg.evaluate(() => ({ doc: document.documentElement.scrollWidth, pan: document.querySelector(".lqr .pan").getBoundingClientRect().width }));
    check("phone: the panel fits the screen (no sideways scroll)", w.pan <= 390 && w.doc <= 390, JSON.stringify(w));
    await ctx.close(); }
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
