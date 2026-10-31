// Professor fallbacks (31 Oct): (1) "Let in" a student WITHOUT LOCKqz (no computer that runs it, a broken
// laptop): the gate grants them Brightspace special access like an accommodation and the professor reads them
// the current code; (2) the exam-day backup card ("If LOCKqz is down") on the live page and in the extension
// popup (works with LOCKqz down); (3) the extension keeps the professor's computer awake while an exam is on.
// Real API, in-memory SQLite + structural checks of the dashboard, sync.js and the built extension.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), APP = join(HERE, ".."), CF = join(APP, "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-letin-"));
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
  return { prepare(sql){ return mk()._sql(sql); }, async batch(sts){ for (const s of sts) s._run(); } };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort()) { try { sqlite.exec(readFileSync(join(CF, m), "utf8")); } catch (e) { if (!/duplicate column|already exists|table .* already/.test(e.message)) throw e; } }
const ADMIN = "admin-letin-key";
const env = { DB: d1real(sqlite), TEACHER_KEY: ADMIN, ADMIN_EMAIL: "boss@usc.edu", REQUIRE_SIGNED: "1", MAIL_SINK: async () => true };
async function call(path, body, { teacher = null, get = false } = {}) {
  const h = { "Content-Type": "application/json" }; if (teacher) h["X-LOCKqz-Teacher"] = teacher;
  const res = await onRequest({ request: new Request("https://lockqz.test/api" + path, get ? { method: "GET", headers: h } : { method: "POST", headers: h, body: JSON.stringify(body ?? {}) }), env });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
// A class (ou 5001) with one gated exam (qi 51) whose current Brightspace code is known, and a roster.
sqlite.prepare("INSERT INTO quizzes (quiz_id,title,password,created_at,qi,teacher_id,lock_id,ou,gated,bs_code) VALUES ('q1','Midterm','LQ-50010051',datetime('now'),'51','x','5001-51','5001',1,'RT-7788')").run();
const addRoster = (email, uid, role = "Student") => sqlite.prepare("INSERT INTO roster (ou,user_id,name,email,role) VALUES (?,?,?,?,?)").run("5001", uid, email.split("@")[0], email, role);
addRoster("ipad@usc.edu", "9001"); addRoster("other@usc.edu", "9002");

console.log("L1 let a student in without LOCKqz");
let r = await call("/letin", { quiz: "5001-51", email: "ipad@usc.edu" }, { teacher: ADMIN });
check("POST /letin -> ok, listed", r.data?.ok === true && (r.data.letin || []).includes("ipad@usc.edu"), JSON.stringify(r.data));
check("the professor sees the code Brightspace holds now (gated: the rotating code)", r.data?.code === "RT-7788" && r.data.rotates === true && r.data.changes_in > 0, JSON.stringify(r.data));
r = await call("/letin", { quiz: "5001-51", email: "nobody@usc.edu" }, { teacher: ADMIN });
check("someone not on the class list -> 404", r.status === 404);
r = await call("/letin", { quiz: "5001-51", email: "ipad@usc.edu" });
check("no professor sign-in -> refused", r.status === 401 || r.status === 403, String(r.status));
r = await call("/letin", { quiz: "51", email: "ipad@usc.edu" }, { teacher: ADMIN });
check("bad exam id -> 400", r.status === 400);

console.log("L2 the gate admits them (live.letin = Brightspace user ids)");
r = await call("/live?quiz=5001-51", null, { teacher: ADMIN, get: true });
check("live lists the let-in student's Brightspace id", (r.data?.letin || []).includes("9001") && !(r.data?.letin || []).includes("9002"), JSON.stringify(r.data?.letin));
check("live lists the let-in email for the dashboard", (r.data?.letin_emails || []).includes("ipad@usc.edu"));
const sync = readFileSync(join(CF, "public", "sync.js"), "utf8");
check("sync.js: let-in ids join the gate's grants and are never revoked", /\(live\.letin \|\| \[\]\)\.forEach\(function \(u\)[^}]*want\[u\] = true; delete revoke\[u\];/.test(sync));

console.log("L3 undo");
r = await call("/letin", { quiz: "5001-51", email: "ipad@usc.edu", on: false }, { teacher: ADMIN });
check("on:false removes the student", r.data?.ok === true && !(r.data.letin || []).length && r.data.code === null, JSON.stringify(r.data));
r = await call("/letin?quiz=5001-51", null, { teacher: ADMIN, get: true });
check("GET shows nobody let in, no code read", r.data?.ok === true && !(r.data.letin || []).length && r.data.code === null);

console.log("L4 dashboard: Let in / Undo on the live page, code box, backup card");
const dash = readFileSync(join(CF, "public", "dashboard.html"), "utf8");
check("Let in button on students with no LOCKqz lock", dash.includes('onclick="letIn(') && dash.includes('"Let in":"Undo"') && dash.includes("Let in · no LOCKqz"));
check("code box only while someone is let in, one request per 30 s", dash.includes("async function showCode(") && dash.includes("Date.now() - LIVE_CODE_AT < 30000") && dash.includes('"/letin?quiz="'));
check("backup card on the live page (Brightspace only, works with LOCKqz down)", dash.includes("const BACKUP_CARD") && dash.includes("If LOCKqz is down") && dash.includes("${BACKUP_CARD}"));

console.log("L5 extension: keep-awake during exams + backup card in the popup (built packages)");
const bg = readFileSync(join(APP, "extension-prof", "background.js"), "utf8"), pop = readFileSync(join(APP, "extension-prof", "popup.html"), "utf8");
check("keeps the computer awake while an exam or its gate is on, releases after", bg.includes('api.power.requestKeepAwake("system")') && bg.includes("api.power.releaseKeepAwake()") && bg.includes("const examOn ="));
check("popup: If LOCKqz is down (static, works offline)", pop.includes("If LOCKqz is down") && pop.includes("only users with special access"));
const man = n => JSON.parse(execFileSync("unzip", ["-p", join(APP, "extension-prof", "dist", n), "manifest.json"]).toString());
const mc = man("lockqz-prof-chromium.zip"), mf = man("lockqz-prof-firefox.zip"), src = JSON.parse(readFileSync(join(APP, "extension-prof", "manifest.json"), "utf8"));
check("Chromium package asks for power (no install warning)", mc.permissions.includes("power"));
check("Firefox package has no power permission (Firefox has no power API)", !mf.permissions.includes("power"));
check("packages match the source version", mc.version === src.version && mf.version === src.version, `${mc.version} ${mf.version} ${src.version}`);
check("packaged sync.js is the site's own", execFileSync("unzip", ["-p", join(APP, "extension-prof", "dist", "lockqz-prof-chromium.zip"), "sync.js"]).equals(readFileSync(join(CF, "public", "sync.js"))));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
