// Bug sweep 18 (12 Nov 2026): a big Sync (over 400 students in all) is sent in parts - class lists first, about
// 400 students per request, then one request with every class and its exams - so no single request is large.
//   P1 the parts + the last request leave LOCKqz exactly as one big request does (a new invited professor: verified,
//      class lists, exams, protection after payment);
//   P2 a part never drops the professor's other classes from his dashboard; the last request still does;
//   P3 the Sync tab's own code makes those requests (sync.js), and one request for a small professor.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-sweep18-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
const RealDate = Date; let fakeNow = RealDate.parse("2026-11-12T18:00:00Z");
class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fakeNow); } static now() { return fakeNow; } }
globalThis.Date = FakeDate;
const LIMIT = 50;
let worldN = 0, CUR = null;   // CUR: the world whose request is running (for the fetch mock)
globalThis.fetch = async (u, init = {}) => { u = String(u); const W = CUR; W.C.n++; if (W.C.n > LIMIT) { W.C.over++; throw new Error("Too many subrequests."); }
  if (u === "https://api.stripe.com/v1/payment_intents") { const f = new URLSearchParams(String(init.body)), key = (init.headers && (init.headers["Idempotency-Key"] || init.headers["idempotency-key"])) || null; W.intents.push({ f, key });
    return new Response(JSON.stringify({ id: "pi_renew_" + key, status: "succeeded", amount: Number(f.get("amount")), amount_received: Number(f.get("amount")), metadata: {} }), { status: 200 }); }
  if (u.startsWith("https://api.stripe.com/v1/payment_intents/pi_renew_")) { const id = decodeURIComponent(u.split("/").pop().split("?")[0]); W.reads.push(id); const was = W.intents.find(i => "pi_renew_" + i.key === id);
    return new Response(JSON.stringify(was ? { id, status: "succeeded", amount: Number(was.f.get("amount")), amount_received: Number(was.f.get("amount")), metadata: {} } : { error: { message: "No such payment_intent" } }), { status: was ? 200 : 404 }); }
  if (u.startsWith("https://api.stripe.com/v1/payment_intents/pi_")) return new Response(JSON.stringify({ id: u.split("/").pop().split("?")[0], payment_method: { id: "pm_card1", type: "card", card: { brand: "visa", last4: "4242" } } }), { status: 200 });
  return new Response("{}", { status: 200 }); };
async function world(extra = {}) {
  const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href + "?w=" + (++worldN));
  const sqlite = new DatabaseSync(":memory:"); sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
  for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
    for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch {} }
  const W = { sqlite, MAILS: [], intents: [], reads: [], C: { n: 0, over: 0, worst: {}, failBatch: 0 } };
  const hit = () => { W.C.n++; if (W.C.n > LIMIT) { W.C.over++; throw new Error("D1_ERROR: Too many API requests by single worker invocation."); } };
  const db = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
    const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
      first: async () => { hit(); return st.get(...args) ?? null; }, all: async () => { hit(); return { results: st.all(...args) }; }, run: async () => { hit(); return { meta: { changes: Number(st.run(...args).changes) } }; }, _run() { st.run(...args); } }; return o; },
    async batch(sts) { hit(); if (W.C.failBatch > 0) { W.C.failBatch--; throw new Error("D1_ERROR: Network connection lost."); } sqlite.exec("BEGIN"); try { for (const s of sts) s._run(); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; } return []; } };
  const env = { DB: db, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", ROT_SECRET: "rs", LIVE_CACHE_MS: "0", PAID_CACHE_MS: "0", PAY_SECRET: "paysecret-0123456789", ADMIN_EMAIL: "admin@usc.edu",
    MAIL_SINK: async m => { W.C.n++; if (W.C.n > LIMIT) { W.C.over++; throw new Error("Too many subrequests."); } W.MAILS.push(m); return true; },
    PROF_TOTAL: "6500", PROF_CARD_TOTAL: "6500", PROF_ZELLE_TOTAL: "6300", PROF_BANK_TOTAL: "6500", PROF_OTHER_PRICE: "5000", ZELLE_TO: "(858) 900-4347", REQUIRE_GATE: "1", ...extra };
  let ip = 0;
  W.api = async (path, body, { teacher, pay, get, hook } = {}) => { const raw = JSON.stringify(body ?? {}); const h = { "Content-Type": "application/json", "CF-Connecting-IP": "10." + (20 + worldN) + "." + ((++ip >> 8) & 255) + "." + (ip & 255) };
    if (teacher) h["X-LOCKqz-Teacher"] = teacher; if (pay) h["X-LOCKqz-Pay"] = env.PAY_SECRET;
    if (hook) { const ts = Math.floor(Date.now() / 1000); h["Stripe-Signature"] = `t=${ts},v1=${createHmac("sha256", env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${raw}`).digest("hex")}`; }
    W.C.n = 0; CUR = W; const pend = [];
    const res = await onRequest({ request: new Request("https://lockqz.pages.dev/api" + path, { method: get ? "GET" : "POST", headers: h, body: get ? undefined : raw }), env, waitUntil: p => pend.push(p) });
    await Promise.allSettled(pend); const k = path.split("?")[0]; W.C.worst[k] = Math.max(W.C.worst[k] || 0, W.C.n);
    return { status: res.status, data: await res.json().catch(() => null) }; };
  return W;
}
const tok = em => createHmac("sha256", "rs").update("lqz-pay-status:" + em).digest("hex").slice(0, 32);
const soon = h => new RealDate(fakeNow + h * 3600000).toISOString();


const NC = 9, NS = 130, NQ = 4;
const roster = c => [{ id: "8001", name: "Pat Prof", email: "p@usc.edu", role: "Instructor" }, ...Array.from({ length: NS }, (_, i) => ({ id: String(100000 + c * 1000 + i), name: "Stu " + c + " " + i, email: `s${c}x${i}@usc.edu`, role: "Student" }))];
const courses = (n = NC) => Array.from({ length: n }, (_, c) => ({ ou: String(500 + c), name: `20263_${14792 + c} ECON ${203 + c}`, code: "ECON-" + c, role: "Instructor", classlist: roster(c),
  quizzes: Array.from({ length: NQ }, (_, i) => ({ qi: String(c * 100 + i), name: "Quiz " + i, active: true, start: soon(40 + i), end: soon(42 + i), has_password: false })) }));
// what the Sync tab does (the same rule as sync.js)
const partsOf = cs => { const out = []; let part = [], n = 0; for (const c of cs) { if (!c.classlist) continue; if (part.length && n + c.classlist.length > 400) { out.push(part); part = []; n = 0; } part.push({ ...c, quizzes: null }); n += c.classlist.length; } if (part.length) out.push(part); return out; };
const who = { id: "8001", name: "Pat Prof" };
async function run(split, n = NC) { fakeNow = RealDate.parse("2026-11-12T18:00:00Z"); const W = await world();
  const ADMIN = (await W.api("/signup", { email: "admin@usc.edu", password: "adminpass1", name: "A H" })).data.token;
  const inv = (await W.api("/invite", { email: "p@usc.edu" }, { teacher: ADMIN })).data.code;
  const H = { teacher: (await W.api("/signup", { email: "p@usc.edu", password: "profpass12", name: "Pat Prof", invite: inv })).data.token };
  W.sync = async (cs, sp = split) => { let reqs = 0, worst = 0;
    if (sp) for (const part of partsOf(cs)) { const r = await W.api("/sync", { whoami: who, roster_part: true, courses: part }, H); reqs++; worst = Math.max(worst, JSON.stringify(part).length); if (r.status !== 200) return { status: r.status, reqs }; }
    const last = sp ? cs.map(c => ({ ...c, classlist: null })) : cs; const r = await W.api("/sync", { whoami: who, courses: last }, H); reqs++; worst = Math.max(worst, JSON.stringify(last).length);
    return { ...r, reqs, worst }; };
  W.H = H; W.r1 = await W.sync(courses(n));
  const memo = (await W.api("/my-sections", undefined, { ...H, get: true })).data.memo;
  await W.api("/pay/notify", { payments: [{ txn: "pz1", amount: 6300 * n, payer: "Pat", note: memo, via: "zelle" }] }, { pay: true });
  W.r2 = await W.sync(courses(n));
  W.dump = () => ({ roster: W.sqlite.prepare("SELECT ou,user_id,name,email,role FROM roster ORDER BY ou,user_id").all(), snap: W.sqlite.prepare("SELECT ou,hash,rows FROM roster_snap ORDER BY ou").all(),
    tc: W.sqlite.prepare("SELECT ou,name,code,role,in_sync FROM teacher_courses ORDER BY teacher_id,ou").all(), bq: W.sqlite.prepare("SELECT ou,qi,name,start_date FROM bs_quizzes ORDER BY ou,qi").all(),
    q: W.sqlite.prepare("SELECT ou,qi,gated FROM quizzes WHERE qi IS NOT NULL ORDER BY ou,qi").all(), t: W.sqlite.prepare("SELECT email,verified,vouched,bs_user_id FROM teachers ORDER BY email").all() });
  return W; }
const ONE = await run(false), PARTS = await run(true);
const a = ONE.dump(), b = PARTS.dump();
check("P1 one big request works as before (a new invited professor: verified, 9 classes, 1,179 class-list rows, 36 exams protected after payment)",
  ONE.r1.status === 200 && ONE.r1.reqs === 1 && a.t.find(t => t.email === "p@usc.edu").verified === 1 && a.roster.length === NC * (NS + 1) && a.q.length === NC * NQ && ONE.r2.data.protect.length === NC * NQ, `${ONE.r1.status} roster ${a.roster.length} exams ${a.q.length} protect ${ONE.r2.data?.protect?.length}`);
check("P1 the same Sync in parts: 4 small requests instead of 1 big one", PARTS.r1.status === 200 && PARTS.r1.reqs === 4 && PARTS.r1.worst < ONE.r1.worst / 2, `requests ${PARTS.r1.reqs}, biggest ${PARTS.r1.worst} vs ${ONE.r1.worst} bytes`);
for (const k of Object.keys(a)) check(`P1 parts leave the same ${({ roster: "class lists", snap: "class-list snapshots", tc: "classes", bq: "Brightspace exams", q: "protected exams", t: "accounts" })[k]} as one request`, JSON.stringify(a[k]) === JSON.stringify(b[k]), `${a[k].length} vs ${b[k].length} rows`);
check("P1 and the same answer for the Sync tab (classes, exams to protect)", JSON.stringify(ONE.r2.data.ous) === JSON.stringify(PARTS.r2.data.ous) && PARTS.r2.data.protect.length === ONE.r2.data.protect.length && JSON.stringify(Object.keys(ONE.r2.data).sort()) === JSON.stringify(Object.keys(PARTS.r2.data).sort()));
// P2: a class the professor no longer has
{ const W = PARTS, six = courses(6), inSync = () => W.sqlite.prepare("SELECT COUNT(*) n FROM teacher_courses tc JOIN teachers t ON t.id=tc.teacher_id WHERE t.email='p@usc.edu' AND COALESCE(tc.in_sync,1)<>0").get().n;
  const p = partsOf(six); await W.api("/sync", { whoami: who, roster_part: true, courses: p[0] }, W.H);
  check("P2 a part (3 of the classes) does not take the other classes off the dashboard", inSync() === NC, String(inSync()));
  for (const part of p.slice(1)) await W.api("/sync", { whoami: who, roster_part: true, courses: part }, W.H);
  await W.api("/sync", { whoami: who, courses: six.map(c => ({ ...c, classlist: null })) }, W.H);
  check("P2 the last request does: the 3 classes Brightspace no longer lists leave the dashboard", inSync() === 6, String(inSync()));
  check("P2 their class lists stay as they were (a request without a class list never removes one)", W.sqlite.prepare("SELECT COUNT(*) n FROM roster").get().n === NC * (NS + 1));
  const r = await W.api("/sync", { whoami: who, roster_part: true, courses: [{ ...six[0], classlist: six[0].classlist.slice(0, 50), quizzes: null }] }, W.H);
  check("P2 a class list that shrank is updated by its part (81 students left the class)", r.status === 200 && W.sqlite.prepare("SELECT COUNT(*) n FROM roster WHERE ou='500'").get().n === 50, String(W.sqlite.prepare("SELECT COUNT(*) n FROM roster WHERE ou='500'").get().n));
  check("P2 never more than 50 database calls in any of these requests", W.C.over === 0 && ONE.C.over === 0 && W.C.worst["/sync"] <= 45, `worst ${W.C.worst["/sync"]}`); }
// P3: sync.js itself
{ const src = readFileSync(join(CF, "public", "sync.js"), "utf8");
  check("P3 the Sync tab sends class lists in parts only past 400 students, about 400 per request, then every class with its exams",
    /if \(nStu > 400\) \{/.test(src) && /roster_part: true, courses: part/.test(src) && /inPart \+ pc\.classlist\.length > 400/.test(src) && /Object\.assign\(\{\}, pc, \{ quizzes: null \}\)/.test(src)
    && /Object\.assign\(\{\}, c, \{ classlist: null \}\)/.test(src) && /courses: sendCourses \}\);/.test(src));
  // the Sync tab's own lines, run as they are, against a server that answers like LOCKqz
  const i0 = src.indexOf("    var who = { id: me.Identifier"), i1 = src.indexOf("\n", src.indexOf("var state = await lq(\"/sync\"", i0));
  const runTab = async (cs, W) => { const sent = []; const lq = async (path, body) => { sent.push(JSON.parse(JSON.stringify(body))); const r = await W.api(path, body, W.H); if (r.status !== 200) throw new Error("status " + r.status); return r.data; };
    const fn = new Function("lq", "courses", "me", "location", "return (async function () {\n" + src.slice(i0, i1) + "\nreturn state; })();");
    const state = await fn(lq, cs, { Identifier: "8001", FirstName: "Pat", LastName: "Prof" }, { host: "" }); return { sent, state }; };
  const W = await run(false, 2), before = JSON.stringify(W.dump());
  const big = await runTab(courses(NC), W), small = await runTab(courses(2), W);
  check("P3 the tab's code, run as it is: 1,179 students go out as 3 class-list parts and one last request, and LOCKqz ends up with every class list",
    i0 > 0 && big.sent.length === 4 && big.sent.slice(0, 3).every(b => b.roster_part === true && b.courses.every(c => c.quizzes === null && c.classlist.length === NS + 1) && b.courses.length === 3)
    && big.sent[3].roster_part === undefined && big.sent[3].courses.length === NC && big.sent[3].courses.every(c => c.classlist === null && c.quizzes.length === NQ)
    && Array.isArray(big.state.ous) && W.sqlite.prepare("SELECT COUNT(*) n FROM roster").get().n === NC * (NS + 1), `requests ${big.sent.length}`);
  check("P3 a professor with 262 students still syncs in one request, class lists inside", small.sent.length === 1 && small.sent[0].roster_part === undefined && small.sent[0].courses.every(c => c.classlist.length === NS + 1), `requests ${small.sent.length}`);
  const api = readFileSync(join(CF, "functions", "api", "[[route]].js"), "utf8");
  check("P3 the server keeps the dashboard's class list as it is for a part", /Array\.isArray\(body\.courses\) && body\.roster_part !== true\) st\.push\(db\.prepare\("UPDATE teacher_courses SET in_sync=0/.test(api));
  const ext = JSON.parse(readFileSync(join(HERE, "..", "extension-prof", "manifest.json"), "utf8")).version;
  check("P3 the professor extension carries this Sync (1.0.8 or later)", ext.split(".").map(Number).reduce((a, n) => a * 1000 + n, 0) >= 1000008, ext); }

globalThis.Date = RealDate;
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
