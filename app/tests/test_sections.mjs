// Per-section billing ($1,000 per USC section per semester). Real API, in-memory SQLite, no network.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-sec-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);

let pass = 0, fail = 0;
const ok = m => { pass++; console.log("  ok:", m); };
const bad = m => { fail++; console.log("  FAIL:", m); };
const check = (m, c, i = "") => (c ? ok(m) : bad(m + (i ? `  (${i})` : "")));

const sign = (key, path, ts, body) =>
  createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");

function d1(sqlite) {
  return { prepare(sql) {
    const st = sqlite.prepare(sql); let args = [];
    const s = { bind(...a) { args = a.map(x => (x === undefined ? null : typeof x === "boolean" ? Number(x) : x)); return s; },
                first: async () => st.get(...args) ?? null,
                all: async () => ({ results: st.all(...args) }),
                run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }) };
    return s;
  }, async batch(sts){ for (const _ of sts) {} } };
}
// db.batch runs each prepared statement; our shim's statements already ran on .bind? No: emulate real batch.
function d1real(sqlite) {
  const mk = () => { let args = []; let st = null;
    return { _sql(sql){ st = sqlite.prepare(sql); return this; },
      bind(...a){ args = a.map(x => x===undefined?null:typeof x==="boolean"?Number(x):x); this._run=()=>st.run(...args); return this; },
      first: async()=> st.get(...args) ?? null, all: async()=>({results:st.all(...args)}),
      run: async()=>({meta:{changes:Number(st.run(...args).changes)}}) }; };
  return { prepare(sql){ return mk()._sql(sql); },
           async batch(sts){ for (const s of sts) s._run(); } };
}

const BASE = "https://lockqz.test", ADMIN = "admin-test-key";
const OU = "98765", QI = "12345", LOCK_ID = `${OU}-${QI}`;
const QUIZ_URL = `https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${QI}&ou=${OU}`;

function makeDb(oldSchema) {
  const sqlite = new DatabaseSync(":memory:");
  let schema = readFileSync(join(CF, "schema.sql"), "utf8");
  if (oldSchema) {   // schema before this feature: strip the two new columns, then migrate_010 adds them
    schema = schema.replace(/,\n  gated     INTEGER DEFAULT 0[^\n]*/, "").replace(/,\n  verified  INTEGER DEFAULT 0[^\n]*/, "").replace(/\n  ip        TEXT,[^\n]*/, "");
  }
  sqlite.exec(schema);
  if (oldSchema) { sqlite.exec(readFileSync(join(CF, "migrate_010_gate_verify.sql"), "utf8")); sqlite.exec(readFileSync(join(CF, "migrate_011_lock_ip.sql"), "utf8")); }
  for (const m of ["migrate_012_bs_code.sql", "migrate_013_sa_keep.sql", "migrate_014_lockqz_off.sql"]) sqlite.exec(readFileSync(join(CF, m), "utf8"));
  return sqlite;
}

async function call(env, path, body, { teacher = null, sync = null, key = null, device = null } = {}) {
  const raw = JSON.stringify(body ?? {});
  const h = { "Content-Type": "application/json" };
  if (teacher) h["X-LOCKqz-Teacher"] = teacher;
  if (sync) h["X-LOCKqz-Sync"] = sync;
  if (key) { const ts = String(Math.floor(Date.now()/1000)); h["X-LOCKqz-Device"]=device; h["X-LOCKqz-Time"]=ts; h["X-LOCKqz-Sig"]=sign(key, `/api${path}`, ts, raw); }
  const res = await onRequest({ request: new Request(BASE+"/api"+path, { method:"POST", headers:h, body:raw }), env });
  let data=null; try{ data=await res.json(); }catch{}
  return { status:res.status, data };
}
async function getc(env, path, { teacher=null, sync=null } = {}) {
  const h = {}; if (teacher) h["X-LOCKqz-Teacher"]=teacher; if (sync) h["X-LOCKqz-Sync"]=sync;
  const res = await onRequest({ request: new Request(BASE+"/api"+path, { method:"GET", headers:h }), env });
  let data=null; try{ data=await res.json(); }catch{}
  return { status:res.status, data };
}

  const sqlite = makeDb(false);
  const env = { DB: d1real(sqlite), TEACHER_KEY: ADMIN, REQUIRE_SIGNED: "1", VENMO_HANDLE: "@lockqz-test" };
  const ADMIN_TOK = (await call(env, "/signup", { email: "admin@usc.edu", password: "adminpass1" })).data.token;
  const [CUR] = (() => { const d = new Date(Date.now() - 7*3600000).toISOString().slice(0,10), y=+d.slice(0,4), m=+d.slice(5,7), s = m<=5?1:(m<=7?2:3); return [String(y*10+s)]; })();
  const ins = sqlite.prepare("INSERT INTO usc_sections (term,section,course,title,first,last,seats,registered) VALUES (?,?,?,?,?,?,?,?)");
  ins.run(CUR, "15351", "FBE 437", "Ent Fin", "Duke", "Bristow", 60, 58);
  ins.run(CUR, "15353", "FBE 437", "Ent Fin", "Duke", "Bristow", 60, 58);
  ins.run(CUR, "15395", "FBE 527", "Ent Fin", "Duke", "Bristow", 77, 63);
  ins.run(CUR, "15999", "FBE 437", "Ent Fin", "Other", "Person", 60, 50);

  let r = await call(env, "/signup", { email: "prof@usc.edu", password: "profpass1", name: "Duke Bristow" });
  const TOK = r.data.token;
  const SYNC = (await getc(env, "/synckey", { teacher: TOK })).data.key;
  const roster = [ { id: "4000", name: "Duke Bristow", email: "prof@usc.edu", role: "Instructor" }, { id: "4001", name: "Al", email: "al@usc.edu", role: "Student" } ];
  // Three Brightspace shells: section 15351, section 15353, and a combined FBE 437 shell with no section number.
  const C = [ { ou: "500001", name: "FBE 437 Entrepreneurial Finance (15351)", code: "20263_FBE_437_15351" },
              { ou: "500002", name: "FBE 437 Entrepreneurial Finance (15353)", code: "20263_FBE_437_15353" },
              { ou: "500003", name: "FBE 437 Entrepreneurial Finance", code: "FBE-437-COMBINED" } ];
  const courses = (qi0) => C.map((c, i) => ({ ...c, role: "Instructor", classlist: roster, quizzes: [ { qi: String(qi0 + i), name: "Quiz", active: true } ] }));
  await call(env, "/sync", { courses: courses(700) }, { teacher: ADMIN_TOK });   // trusted seed
  r = await call(env, "/sync", { courses: courses(700) }, { sync: SYNC });
  check("professor verified", (await getc(env, "/me", { teacher: TOK })).data?.verified === true);

  console.log("S1 the professor's sections come straight from the public schedule (no AI, instant)");
  r = await getc(env, "/my-sections", { teacher: TOK });
  check("finds exactly Bristow's 3 sections this term", r.status === 200 && r.data?.sections?.length === 3 && r.data.term === CUR, JSON.stringify(r.data));
  check("$1,000 per section", r.data?.price === 1000);
  check("Venmo handle + memo code returned", r.data?.venmo === "lockqz-test" && /^LQ[A-Z0-9]{5}$/.test(r.data?.memo||""), JSON.stringify(r.data));
  check("nothing paid yet", r.data?.sections?.every(s => !s.paid));
  const MEMO = r.data.memo;
  check("memo code is stable", (await getc(env, "/my-sections", { teacher: TOK })).data?.memo === MEMO);
  r = await getc(env, "/my-sections?name=" + encodeURIComponent("Nobody Here"), { teacher: TOK });
  check("a wrong name finds nothing", r.data?.sections?.length === 0);
  await getc(env, "/my-sections?name=" + encodeURIComponent("Duke Bristow"), { teacher: TOK });

  console.log("S2 unpaid: no section is protected");
  check("sync auto-protected nothing", !sqlite.prepare("SELECT 1 FROM quizzes WHERE teacher_id=(SELECT id FROM teachers WHERE email='prof@usc.edu')").get());
  r = await call(env, "/protect", { ou: "500001", qi: "700", on: true }, { teacher: TOK });
  check("unpaid section: protect refused (402)", r.status === 402, `got ${r.status}`);

  console.log("S3 only the admin marks sections paid");
  r = await call(env, "/pay-sections", { email: "prof@usc.edu", term: CUR, sections: ["15351"], until: "2099-12-31" }, { teacher: TOK });
  check("professor cannot mark own section paid", r.status === 401, `got ${r.status}`);
  r = await call(env, "/pay-sections", { email: "prof@usc.edu", term: CUR, sections: ["15351"], until: "2099-12-31" }, { teacher: ADMIN_TOK });
  check("admin marks 15351 paid", r.status === 200, JSON.stringify(r.data));
  r = await getc(env, "/teacher-sections?email=prof%40usc.edu", { teacher: ADMIN_TOK });
  check("admin sees 15351 paid, others not", r.data?.sections?.filter(s => s.paid).map(s => s.section).join() === "15351", JSON.stringify(r.data?.sections));

  console.log("S4 per section: paying 15351 unlocks only 15351");
  r = await call(env, "/protect", { ou: "500001", qi: "700", on: true }, { teacher: TOK });
  check("paid section 15351: protect works", r.status === 200 && r.data?.on === true, JSON.stringify(r.data));
  r = await call(env, "/protect", { ou: "500002", qi: "701", on: true }, { teacher: TOK });
  check("unpaid section 15353: refused (402)", r.status === 402, `got ${r.status}`);
  r = await call(env, "/protect", { ou: "500003", qi: "702", on: true }, { teacher: TOK });
  check("combined FBE 437 shell with one of two sections paid: refused (402)", r.status === 402, `got ${r.status}`);
  r = await call(env, "/gate", { ou: "500002", qi: "701", on: true }, { teacher: TOK });
  check("unpaid section: gate refused (402)", r.status === 402, `got ${r.status}`);
  r = await call(env, "/rotating", { ou: "500002", qis: ["701"] }, { teacher: TOK });
  check("unpaid section: rotating refused (402)", r.status === 402, `got ${r.status}`);

  console.log("S5 paying the second section unlocks it and the combined shell; sync auto-protects them");
  await call(env, "/pay-sections", { email: "prof@usc.edu", term: CUR, sections: ["15353"], until: "2099-12-31" }, { teacher: ADMIN_TOK });
  r = await call(env, "/sync", { courses: courses(800) }, { sync: SYNC });
  const prot = sqlite.prepare("SELECT ou FROM quizzes WHERE qi IN ('800','801','802') ORDER BY ou").all().map(x => x.ou).join();
  check("all three FBE 437 shells auto-protected once both sections paid", prot === "500001,500002,500003", prot);
  r = await getc(env, "/my-sections", { teacher: TOK });
  check("my-sections shows 2 paid, FBE 527 unpaid", r.data?.sections?.filter(s => s.paid).length === 2 && r.data.sections.find(s => s.section === "15395")?.paid === false);

  console.log("S6 unmarking a section releases its quizzes (password removed at next sync; students never stranded)");
  r = await call(env, "/pay-sections", { email: "prof@usc.edu", term: CUR, sections: ["15353"], off: true }, { teacher: ADMIN_TOK });
  check("admin unmarks 15353", r.status === 200);
  const left = sqlite.prepare("SELECT DISTINCT ou FROM quizzes WHERE teacher_id=(SELECT id FROM teachers WHERE email='prof@usc.edu') ORDER BY ou").all().map(x => x.ou).join();
  check("only section 15351 stays protected", left === "500001", left);
  check("15353 + combined shell passwords queued for removal", !!sqlite.prepare("SELECT 1 FROM pending_clear WHERE ou='500002'").get() && !!sqlite.prepare("SELECT 1 FROM pending_clear WHERE ou='500003'").get());

  console.log("S7 expired paid date = unpaid");
  await call(env, "/pay-sections", { email: "prof@usc.edu", term: CUR, sections: ["15351"], until: "2020-01-01" }, { teacher: ADMIN_TOK });
  r = await call(env, "/protect", { ou: "500001", qi: "900", on: true }, { teacher: TOK });
  check("expired section: refused (402)", r.status === 402, `got ${r.status}`);

  console.log("S8 admin list shows paid count + Venmo code");
  r = await getc(env, "/teachers", { teacher: ADMIN_TOK });
  const row = (r.data?.teachers||[]).find(t => t.email === "prof@usc.edu");
  check("teachers row has memo code", row?.memo === MEMO, JSON.stringify(row));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
