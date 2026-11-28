// Bug sweep 40 (28 Nov 2026), server and dashboard.
//   A  AI built into apps that stay open during a quiz is cut where it has its own address (Dropbox Dash, Foxit's AI
//      Assistant, Anaconda Assistant, MATLAB's AI Chat Playground, IBM watsonx.ai) - served to every computer now.
//   R  rows whose AI LOCKqz cannot turn off on its own (Dropbox, Box, e-textbooks, MATLAB) are rows with AI inside: they
//      start blocked everywhere (server, catalog, dashboard), never promise "AI stays off", "Notes only" no longer says
//      textbooks; the dashboard's default rows are the catalog's.
//   B  "Also block" never takes the school's own Brightspace site (BS_HOSTS).
//   C  a class turned off lets go of its past exams too (a make-up through special access is never stuck behind a
//      password nobody hands out); the exams not over are left to their own switches, a running gate to its own.
//   H  a locked computer's heartbeat carries the exam's rules (own > class > default), so a change made during the exam
//      reaches the computers already in it; nothing while RULES_ON is off, nothing for the agent's own heartbeat.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url)), APP = join(HERE, ".."), CF = join(APP, "cloudflare"), PUB = join(CF, "public");
const tmp = mkdtempSync(join(tmpdir(), "lqz-s40-"));
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
const sign = (key, path, ts, raw) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(raw).digest("hex")}`).digest("hex");
async function api(path, body, headers = {}, e = ENV) {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const res = await onRequest({ request: new Request("https://lockqz.pages.dev/api" + path, { method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.40.0.1", ...headers }, body: raw }), env: e });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function dev(path, body, d, e = ENV) {
  const raw = JSON.stringify(body), ts = String(Math.floor(Date.now() / 1000));
  return api(path, body, { "X-LOCKqz-Device": d.id, "X-LOCKqz-Time": ts, "X-LOCKqz-Sig": sign(d.key, "/api" + path, ts, raw) }, e);
}
const ADMIN = { "X-LOCKqz-Teacher": "admin-key" };
const one = (sql, ...a) => sqlite.prepare(sql).get(...a);
const arr = name => JSON.parse(SRC.match(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`))[1]);

// ---- A ----
console.log("A AI inside apps that stay open: cut where it has its own address (served now, in both app lists)");
const served = JSON.parse(SRC.match(/const AI_DOMAINS = (\[[\s\S]*?\]);/)[1]);
const macBl = readFileSync(join(APP, "mac", "blocklist.txt"), "utf8").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
const winBl = readFileSync(join(APP, "windows", "blocklist.txt"), "utf8").split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
const need = ["dash.ai", "dash.dropbox.com", "ai.foxit.com", "ai-assistant.foxit.com", "anaconda.com", "anaconda.cloud", "mathworks.com/matlabcentral/playground",
  "us-south.ml.cloud.ibm.com", "eu-de.ml.cloud.ibm.com", "jp-tok.ml.cloud.ibm.com", "dataplatform.cloud.ibm.com", "eu-gb.dataplatform.cloud.ibm.com"];
check("Dropbox Dash, Foxit AI, Anaconda Assistant, MATLAB AI Chat Playground, watsonx.ai: served and in the Mac and Windows lists",
  need.every(d => served.includes(d) && macBl.includes(d) && winBl.includes(d)), need.filter(d => !served.includes(d) || !macBl.includes(d) || !winBl.includes(d)).join(","));
check("never the file storage or the package mirrors (dropbox.com, repo.anaconda.com, matlab.mathworks.com, login.mathworks.com stay off the AI list)",
  !["dropbox.com", "repo.anaconda.com", "conda.anaconda.org", "matlab.mathworks.com", "login.mathworks.com", "mathworks.com", "foxit.com", "ibm.com", "cloud.ibm.com"].some(d => served.includes(d)));
const wild = f => (readFileSync(join(APP, f), "utf8").match(/WILD_DOMAINS=\(([^)]*)\)/) || [, ""])[1].replace(/\\/g, " ").split(/\s+/).filter(Boolean);
check("every name under dash.ai is cut too (Mac, Linux, Windows, Android whole-domain lists)", wild("mac/extra-block.sh").includes("dash.ai") && wild("linux/lockqz.sh").includes("dash.ai")
  && /\$WildDomains = @\([^)]*"dash\.ai"/.test(readFileSync(join(APP, "windows", "lockqz.ps1"), "utf8")) && /"dash\.ai"\)/.test(readFileSync(join(APP, "android/app/src/main/java/app/lockqz/DnsVpnService.kt"), "utf8")));
check("PDF Expert (its PDF Copilot works for everyone) is closed during a quiz on the Mac, and no row keeps it open",
  /AI_APPS=\([^)]*"PDF Expert"[^)]*\)/.test(readFileSync(join(APP, "mac", "lockqz.sh"), "utf8")) && !JSON.stringify(JSON.parse(readFileSync(join(APP, "mac", "rules-catalog.json"), "utf8")).rows).includes("PDF Expert"));

// ---- R ----
console.log("R rows whose AI LOCKqz cannot turn off start blocked, and say nothing about it staying off");
const cat = JSON.parse(readFileSync(join(APP, "mac", "rules-catalog.json"), "utf8"));
const AIROWS = ["dropbox", "box", "ebooks", "matlab"];
check("catalog: Dropbox, Box, e-textbooks and MATLAB start blocked", AIROWS.every(k => cat.rows[k].default === "block"));
check("server: the same rows start blocked (RULE_BLOCKED = the catalog's)", JSON.stringify(arr("RULE_BLOCKED")) === JSON.stringify(Object.keys(cat.rows).filter(k => cat.rows[k].default === "block")));
const dash = readFileSync(join(PUB, "dashboard.html"), "utf8");
const rg = dash.slice(dash.indexOf("const RG = ["), dash.indexOf("const RKEYS"));
const rowOf = k => (rg.match(new RegExp(`\\{ k: "${k}"[^}]*\\}`)) || [""])[0];
check("dashboard: the four rows are 'AI inside' rows (tag, 'Its AI works too.' when allowed)", AIROWS.every(k => /ai: true/.test(rowOf(k))), AIROWS.map(rowOf).join(" | "));
check("dashboard: no row promises its AI stays off for Dropbox, Box or e-textbooks", AIROWS.every(k => !/stays off/.test(rowOf(k))) && !/their AI stays off/.test(dash));
// The dashboard's default (Notes + internet) = the catalog's default blocks: messaging rows and the rows with AI inside.
const groups = [...rg.matchAll(/\{ id: "([a-z]+)", t: "[^"]*", rows: \[([\s\S]*?)\] \}/g)].map(m => ({ id: m[1], rows: [...m[2].matchAll(/\{ k: "([a-z]+)"[^}]*\}/g)].map(x => ({ k: x[1], ai: /ai: true/.test(x[0]) })) }));
const dashOff = groups.flatMap(g => g.rows.filter(r => g.id === "msg" || r.ai).map(r => r.k));
const catOff = Object.keys(cat.rows).filter(k => cat.rows[k].default === "block");
check("dashboard: its default-blocked rows are exactly the catalog's", JSON.stringify([...dashOff].sort()) === JSON.stringify([...catOff].sort()), JSON.stringify({ dashOff, catOff }));
check("'Notes only' says Brightspace, notes and files (no textbooks)", /notes: "Brightspace, notes and files\. No other websites\."/.test(dash));
check("Notes only with the row open: a notebook on this computer (localhost), MATLAB's and the e-textbooks' sign-in pages",
  ["localhost", "127.0.0.1"].every(x => cat.rows.python.web.includes(x)) && cat.rows.matlab.web.includes("login.mathworks.com") && ["login.pearson.com", "login.vitalsource.com", "login.cengage.com"].every(x => cat.rows.ebooks.web.includes(x)));
check("the catalog is the same file in the Windows app and the Android assets", readFileSync(join(APP, "windows", "rules-catalog.json"), "utf8") === readFileSync(join(APP, "mac", "rules-catalog.json"), "utf8")
  && readFileSync(join(APP, "android/app/src/main/assets/rules-catalog.json"), "utf8") === readFileSync(join(APP, "mac", "rules-catalog.json"), "utf8"));

// ---- setup: a class, its professor, two exams (one current, one past), a student's computer ----
const OU = "302972", day = 86400e3, iso = d => new Date(Date.now() + d).toISOString();
const cl = [{ id: "4000", name: "Bristow, Duke", email: "dbristow@usc.edu", role: "Instructor" }, { id: "5001", name: "One, Stu", email: "stu1@usc.edu", role: "Student" }];
await api("/signup", { email: "athall@usc.edu", password: "adminpass1", name: "Admin" });
await api("/sync", { courses: [{ ou: OU, name: "20263_14792 BUAD-306: Business Finance", code: "20263_14792", role: "Instructor", classlist: cl, quizzes: [] }] }, ADMIN);
const inv = await api("/invite", { email: "dbristow@usc.edu", until: "2026-12-31" }, ADMIN);
const BT = (await api("/signup", { email: "dbristow@usc.edu", password: "dbristow-pass-1", invite: inv.data.code })).data?.token;
const T = { "X-LOCKqz-Teacher": BT };
const quizzes = [{ qi: "901", name: "Exam 3", start: iso(-day), end: iso(5 * day), active: true }, { qi: "902", name: "Final Exam", start: iso(-day), end: iso(9 * day), active: true }];
let r = await api("/sync", { whoami: { id: "4000", name: "Duke Bristow" }, courses: [{ ou: OU, name: "20263_14792 BUAD-306: Business Finance", code: "20263_14792", role: "Instructor", classlist: cl, quizzes }] }, T);
check("setup: both exams protected", r.status === 200 && Number(one("SELECT COUNT(*) AS n FROM quizzes WHERE ou=? AND password IS NOT NULL", OU)?.n) === 2, JSON.stringify(r.data).slice(0, 160));

// ---- B ----
console.log("B 'Also block' never takes the school's own Brightspace site");
for (const site of ["brightspace.usc.edu", "https://brightspace.usc.edu/d2l/home", "usc.brightspace.com"]) {
  r = await api("/rules", { ou: OU, qi: "902", rules: { p: "custom", b: catOff, allow: [], block: [site] } }, T);
  check(`refused: ${site}`, r.status === 400 && /needed for the exam/.test(r.data?.error || ""), JSON.stringify(r.data));
}
r = await api("/rules", { ou: OU, qi: "902", rules: { p: "custom", b: catOff, allow: [], block: ["lms.other.edu"] } }, T, { ...ENV, BS_HOSTS: "lms.other.edu" });
check("another school's own Brightspace site (BS_HOSTS) too", r.status === 400 && /needed for the exam/.test(r.data?.error || ""), JSON.stringify(r.data));
r = await api("/rules", { ou: OU, qi: "902", rules: { p: "custom", b: catOff, allow: [], block: ["khanacademy.org"] } }, T);
check("an ordinary site is still taken", r.status === 200 && r.data?.rules?.block?.[0] === "khanacademy.org", JSON.stringify(r.data));
sqlite.prepare("DELETE FROM quiz_rules").run();

// ---- H ----
console.log("H a locked computer's heartbeat carries the exam's rules");
const STU = { id: "mac-" + randomBytes(4).toString("hex"), key: randomBytes(32).toString("hex") };
await api("/register", { device_id: STU.id, key: STU.key, student: "stu1@usc.edu", platform: "mac" });
await dev("/report", { device_id: STU.id, event: "lock", quiz_id: `${OU}-901` }, STU);
const beat = (e = ENV, extra = {}) => dev("/report", { device_id: STU.id, event: "heartbeat", quiz_id: `${OU}-901`, source: "helper", ...extra }, STU, e);
r = await beat();
check("no rule anywhere: the default (Notes + internet) with the heartbeat", r.status === 200 && r.data?.rules?.label === "Notes + internet" && JSON.stringify(r.data.rules.b) === JSON.stringify(catOff) && typeof r.data.beat_s === "number", JSON.stringify(r.data));
await api("/rules", { ou: OU, qi: "901", all: true, rules: { p: "custom", b: catOff.filter(k => k !== "calls") } }, T);
r = await beat();
check("the class's rule, changed during the exam (video calls allowed)", r.data?.rules?.label === "Custom" && !r.data.rules.b.includes("calls"), JSON.stringify(r.data?.rules));
await api("/rules", { ou: OU, qi: "901", rules: { p: "notes" } }, T);
r = await beat();
check("the exam's own rule beats the class's", r.data?.rules?.label === "Notes only" && r.data.rules.b.includes("web"), JSON.stringify(r.data?.rules));
r = await beat({ ...ENV, RULES_ON: "0" });
check("RULES_ON off: the heartbeat answer has no rules", r.status === 200 && !("rules" in (r.data || {})) && typeof r.data?.beat_s === "number", JSON.stringify(r.data));
r = await beat(ENV, { source: "agent" });
check("the agent's own heartbeat gets no rules", r.status === 200 && !("rules" in (r.data || {})), JSON.stringify(r.data));
r = await dev("/report", { device_id: STU.id, event: "lock", quiz_id: `${OU}-901` }, STU);
check("a lock report gets no rules (the /password answer brings them)", r.status === 200 && !("rules" in (r.data || {})), JSON.stringify(r.data));
const before = Number(one("SELECT COUNT(*) AS n FROM events")?.n);
await beat(); await beat();
check("heartbeats write no event rows", Number(one("SELECT COUNT(*) AS n FROM events")?.n) === before);

// ---- C ----
console.log("C a class turned off lets go of its past exams too");
// 903: an exam that is over (still carrying LOCKqz's password), 904: a past exam whose gate still runs, 901/902: not over.
const addQ = (qi, end, gated = 0) => {
  sqlite.prepare("INSERT INTO bs_quizzes (ou,qi,name,active,start_date,end_date,bs_has_password,bs_password_is_ours,prot_at) VALUES (?,?,?,?,?,?,1,1,?)").run(OU, qi, "Old " + qi, 1, iso(-20 * day), end, iso(-25 * day));
  sqlite.prepare("INSERT INTO quizzes (quiz_id,title,url,password,created_at,qi,teacher_id,lock_id,ou,gated) VALUES (?,?,?,?,?,?,?,?,?,?)").run("q" + qi, "Old " + qi, null, "LQ-PASTPW" + qi.slice(-1), iso(-25 * day), qi, "x", `${OU}-${qi}`, OU, gated);
};
addQ("903", iso(-10 * day)); addQ("904", iso(-10 * day), 1);
sqlite.prepare("INSERT INTO bs_quizzes (ou,qi,name,active,start_date,end_date,due_date,bs_has_password,bs_password_is_ours,prot_at) VALUES (?,?,?,?,?,?,?,1,1,?)").run(OU, "905", "Due only", 1, iso(-20 * day), null, iso(-3 * day), iso(-25 * day));
sqlite.prepare("INSERT INTO quizzes (quiz_id,title,url,password,created_at,qi,teacher_id,lock_id,ou,gated) VALUES (?,?,?,?,?,?,?,?,?,0)").run("q905", "Due only", null, "LQ-PASTPW5", iso(-25 * day), "905", "x", `${OU}-905`, OU);
r = await api("/class", { ou: OU, on: false }, T);
const inQ = qi => !!one("SELECT 1 AS x FROM quizzes WHERE ou=? AND qi=?", OU, qi), inPC = qi => one("SELECT password FROM pending_clear WHERE ou=? AND qi=?", OU, qi)?.password || null;
check("off: answered as before", r.status === 200 && r.data?.on === false && !!one("SELECT 1 AS x FROM course_off WHERE ou=?", OU), JSON.stringify(r.data));
check("off: the past exam's password waits to come out of Brightspace (the next Sync takes it)", !inQ("903") && inPC("903") === "LQ-PASTPW3");
check("off: a past exam with only a due date (over for a day) the same", !inQ("905") && inPC("905") === "LQ-PASTPW5");
check("off: exams that are not over are left to their own switches (the screen sends them)", inQ("901") && inQ("902") && !inPC("901"));
check("off: a running gate is left to its own switch", inQ("904") && !inPC("904"));
r = await api("/bs", undefined, T);
const c = r.data?.courses?.find(x => x.ou === OU), q903 = c?.quizzes?.find(q => q.qi === "903");
check("/bs: the past exam shows no LOCKqz password (Brightspace still has it until the Sync: pending)", q903 && !q903.password && Number(q903.bs_password_is_ours) === 1, JSON.stringify(q903));
r = await api("/class", { ou: OU, on: true }, T);
check("on again: answered as before; the past exam is not put back (auto-protect never protects a past exam)", r.status === 200 && r.data?.on === true && !inQ("903"));
r = await api("/class", { ou: OU, on: false }, { "X-LOCKqz-Teacher": (await api("/signup", { email: "stu1@usc.edu", password: "stu1-pass-123", name: "Stu" })).data?.token || "x" });
check("off by someone who does not teach it: refused, nothing let go", r.status === 403 && inQ("901"));

// Microsoft Store submission: the Store CLI runs with its plain output in both workflows (its log carries its own messages only).
for (const wf of ["release.yml", "store-catchup.yml"]) {
  const t = readFileSync(join(APP, "..", ".github", "workflows", wf), "utf8");
  const pub = t.split("\n").filter(l => /^\s*msstore publish /.test(l));
  check(`${wf}: msstore publish with plain output (no -v / --verbose)`, pub.length === 1 && !pub.some(l => /\s(-v|--verbose)(\s|$)/.test(l)), pub.join(" | "));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
