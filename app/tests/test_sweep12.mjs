// Bug sweep 12 (11 Nov 2026), real API on in-memory SQLite (schema.sql + every migration):
//   D1 an exam the professor deletes in Brightspace: LOCKqz lets go of it at the next Sync (no password to set
//      or remove on an exam that is gone, nothing for the Sync tab to retry); the other exams stay protected.
//   D2 a Sync whose quiz list could not be read (sent as null) changes nothing.
//   D3 an exam waiting for its password to be removed, then deleted in Brightspace: nothing left to remove.
//   D4 schema.sql alone has every table the API names (letin, gsign).
//   W1 account panel: only LOCKqz's own answer (200) is shown as the account; support form can send again.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-sweep12-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

const RealDate = Date; let fakeNow = RealDate.parse("2026-11-12T18:00:00Z");
class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fakeNow); } static now() { return fakeNow; } }
globalThis.Date = FakeDate;
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
// D4 first: the fresh schema alone
const only = new DatabaseSync(":memory:"); only.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
const have = new Set(only.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch {} }
const missing = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name).filter(t => !have.has(t));
check("D4 schema.sql alone has every table the migrations make (letin and gsign included)", have.has("letin") && have.has("gsign") && !missing.length, missing.join(","));
const db = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
  const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
    first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }), run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } }; return o; },
  async batch(sts) { for (const s of sts) s._run(); } };
const env = { DB: db, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", ROT_SECRET: "rs", LIVE_CACHE_MS: "0", PAID_CACHE_MS: "0", PAY_SECRET: "paysecret-0123456789", ADMIN_EMAIL: "admin@usc.edu", MAIL_SINK: async () => true,
  PROF_TOTAL: "6500", PROF_CARD_TOTAL: "6500", PROF_ZELLE_TOTAL: "6300", PROF_BANK_TOTAL: "6500", PROF_OTHER_PRICE: "5000", ZELLE_TO: "(858) 900-4347", REQUIRE_GATE: "1" };
let ip = 0;
async function api(path, body, { teacher, pay, get } = {}) { const h = { "Content-Type": "application/json", "CF-Connecting-IP": "10.12." + ((++ip >> 8) & 255) + "." + (ip & 255) };
  if (teacher) h["X-LOCKqz-Teacher"] = teacher; if (pay) h["X-LOCKqz-Pay"] = env.PAY_SECRET;
  const res = await onRequest({ request: new Request("https://lockqz.pages.dev/api" + path, { method: get ? "GET" : "POST", headers: h, body: get ? undefined : JSON.stringify(body ?? {}) }), env, waitUntil: () => {} });
  return { status: res.status, data: await res.json().catch(() => null) }; }

const ADMIN = (await api("/signup", { email: "admin@usc.edu", password: "adminpass1", name: "A H" })).data.token;
const roster = [{ id: "8001", name: "Pat Prof", email: "p@usc.edu", role: "Instructor" }, { id: "8002", name: "Quinn Co", email: "q@usc.edu", role: "Instructor" }, { id: "9100", name: "Stu Zero", email: "s0@usc.edu", role: "Student" }];
await api("/sync", { courses: [{ ou: "500", name: "20263_14792 ECON 203", classlist: roster, quizzes: [] }] }, { teacher: ADMIN });
const inv = (await api("/invite", { email: "p@usc.edu" }, { teacher: ADMIN })).data.code;
const H = { teacher: (await api("/signup", { email: "p@usc.edu", password: "profpass12", name: "Pat Prof", invite: inv })).data.token };
let Q = [{ qi: "1", name: "Final", active: true, start: "2026-12-10T20:00:00Z", end: "2026-12-10T22:00:00Z" }, { qi: "2", name: "Quiz 2", active: true, start: "2026-12-11T20:00:00Z", end: "2026-12-11T21:00:00Z" }, { qi: "3", name: "Practice", active: true }];
const sync = (quizzes = Q) => api("/sync", { whoami: { id: "8001" }, courses: [{ ou: "500", name: "20263_14792 ECON 203", classlist: roster, quizzes }] }, H);
const rows = t => sqlite.prepare(`SELECT qi FROM ${t} WHERE ou='500' ORDER BY qi`).all().map(r => r.qi).join(",");
await sync();
const memo = (await api("/my-sections", undefined, { ...H, get: true })).data.memo;
await api("/pay/notify", { payments: [{ txn: "pz1", amount: 6300, payer: "Pat", note: memo, via: "zelle" }] }, { pay: true });
let r = await sync();
check("setup: a paid professor's three exams are protected", r.status === 200 && rows("quizzes") === "1,2,3", JSON.stringify(r.data).slice(0, 200));
await api("/sync-result", { results: r.data.protect.map(p => ({ ou: "500", qi: p.qi, status: "set" })) }, H);
Q = Q.map(q => ({ ...q, has_password: true, lq_password: true }));
await sync();

// D2: an unreadable quiz list changes nothing
r = await sync(null);
check("D2 a Sync whose quiz list could not be read keeps every exam", r.status === 200 && rows("quizzes") === "1,2,3", rows("quizzes"));

// D1: the professor deletes the Final in Brightspace
const errsBefore = sqlite.prepare("SELECT COUNT(*) n FROM events WHERE event='brightspace_sync_error'").get().n;
Q = Q.filter(q => q.qi !== "1");
r = await sync();
check("D1 the exam deleted in Brightspace is let go at the next Sync; the others stay protected",
  r.status === 200 && rows("quizzes") === "2,3" && JSON.stringify(r.data.protect.map(p => p.qi)) === '["2","3"]' && !r.data.clear.length, rows("quizzes") + " " + JSON.stringify(r.data.protect.map(p => p.qi)));
r = await sync();
check("D1 the next Sync has nothing to do for it (no retry, no error row)", JSON.stringify(r.data.protect.map(p => p.qi)) === '["2","3"]' && sqlite.prepare("SELECT COUNT(*) n FROM events WHERE event='brightspace_sync_error'").get().n === errsBefore);
check("D1 the remaining exams keep their passwords", sqlite.prepare("SELECT COUNT(*) n FROM quizzes WHERE ou='500' AND password LIKE 'LQ-%'").get().n === 2);

// D1b: a second professor of the same course whose Brightspace shows fewer exams never makes LOCKqz let go of the first one's
const inv2 = (await api("/invite", { email: "q@usc.edu" }, { teacher: ADMIN })).data.code;
const H2 = { teacher: (await api("/signup", { email: "q@usc.edu", password: "profpass34", name: "Quinn Co", invite: inv2 })).data.token };
r = await api("/sync", { whoami: { id: "8002" }, courses: [{ ou: "500", name: "20263_14792 ECON 203", classlist: roster, quizzes: Q.filter(q => q.qi !== "3") }] }, H2);
check("D1b another professor's shorter quiz list does not drop an exam the first professor protected", r.status === 200 && rows("quizzes") === "2,3", r.status + " " + rows("quizzes"));

// D3: quiz 2 turned off in LOCKqz (waiting for its password to be removed), then deleted in Brightspace
const q2 = sqlite.prepare("SELECT quiz_id FROM quizzes WHERE ou='500' AND qi='2'").get().quiz_id;
await api("/delete", { quiz_id: q2 }, H);
check("D3 setup: quiz 2 waits for its password to be removed", rows("pending_clear") === "2", rows("pending_clear"));
Q = Q.filter(q => q.qi !== "2");
r = await sync();
check("D3 with a second professor syncing the course, a waiting removal is kept (his Brightspace may differ)", r.status === 200 && rows("pending_clear") === "2", rows("pending_clear"));
sqlite.prepare("UPDATE teacher_courses SET in_sync=0 WHERE ou='500' AND teacher_id=(SELECT id FROM teachers WHERE email='q@usc.edu')").run();   // the second professor left the course
r = await sync();
check("D3 an exam deleted in Brightspace while its password waited to be removed: nothing left to remove", r.status === 200 && rows("pending_clear") === "" && !r.data.clear.length && rows("quizzes") === "3", rows("pending_clear") + "|" + rows("quizzes"));
// a course with more than 1000 quizzes is never pruned (its list is cut at 1000)
const big = Array.from({ length: 1001 }, (_, i) => ({ qi: String(5000 + i), name: "B" + i, active: true, end: "2026-01-01T00:00:00Z" }));
r = await sync(big);
check("a quiz list longer than 1000 never lets an exam go", r.status === 200 && rows("quizzes").split(",").includes("3"), rows("quizzes").slice(0, 60));

// W1: web pages
const acct = readFileSync(join(CF, "public", "account.js"), "utf8"), sup = readFileSync(join(CF, "public", "support.html"), "utf8");
check("W1 the account panel shows an account only from LOCKqz's own answer (HTTP 200), never from an error page",
  acct.includes('if (d.error || d._status !== 200)') && acct.includes('if (!s.error && s._status === 200) state.data = s'));
check("W1 the support form can send another message after one was sent", /Sent\. We'll reply to[^}]*\$\("go"\)\.disabled = false/.test(sup));

const pop = readFileSync(join(CF, "..", "extension-prof", "popup.js"), "utf8");
check("W2 extension popup: Sync now pressed while 'Sign in to Brightspace' already shows waits for that sync's own answer",
  pop.includes("was = !!st.signin") && pop.includes("(n.signin && (!was || Date.now() - t0 > 45000))"));
const wf = readFileSync(join(CF, "..", "..", ".github", "workflows", "release.yml"), "utf8");
check("W3 one Microsoft Store submission per version (a marker per app/VERSION; a later run for the same version does not submit again)",
  wf.includes("key: store-sent-${{ hashFiles('app/VERSION') }}") && wf.includes('steps.sent.outputs.cache-hit }}" -eq "true"') && wf.includes("Set-Content store-sent/version $v"));

globalThis.Date = RealDate;
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
