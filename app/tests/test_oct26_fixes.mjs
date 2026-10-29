import { withPayT } from "./pay_t.mjs";
// 26 Oct 2026 fixes (real API, in-memory SQLite, Stripe mocked with real session states):
//   F1 one payable Stripe Checkout per code (reuse / expire / race) + overpayments carried to the next term
//   F3 a LOCAL unlock the server did not expect is red on /live until Brightspace proves the submission
//   F5 the retired course-wide static password is never released and /course is gone
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-oct26-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

function d1(sqlite) {
  const mk = sql => { const st = sqlite.prepare(sql); let args = [];
    const s = { bind(...a) { if (a.length > 100) throw new Error("too many SQL variables"); args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return s; },
      first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
      run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } };
    return s; };
  return { prepare: mk, async batch(sts) { sqlite.exec("BEGIN"); try { for (const s of sts) s._run(); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; } return []; } };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch {} }
const MAILS = [], WH = "whsec_oct26_0123456789";
const env = { DB: d1(sqlite), TEACHER_KEY: "admin-key-o26", REQUIRE_SIGNED: "1", ADMIN_EMAIL: "admin@usc.edu", ROT_SECRET: "rot-o26",
  STUDENT_FEE: "180", STUDENT_FEE_FROM: "2000-01-01", PAY_SECRET: "pay-secret-o26-0123456789", LIVE_CACHE_MS: "0",
  STRIPE_SECRET_KEY: "sk_test_o26", STRIPE_WEBHOOK_SECRET: WH, FEE_EXEMPT: "s0@usc.edu,s1@usc.edu,s2@usc.edu", STRIPE_BANK: "1", MAIL_SINK: async m => { MAILS.push(m); return true; } };
const BASE = "https://lockqz.test";
const sign = (key, path, ts, raw) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(raw).digest("hex")}`).digest("hex");
async function call(path, body, { teacher = null, dev = null, get = false, ip = "10.0.0.9" } = {}) {
  body = withPayT(path, body, env);
  const raw = JSON.stringify(body ?? {});
  const h = { "Content-Type": "application/json", "CF-Connecting-IP": ip };
  if (teacher) h["X-LOCKqz-Teacher"] = teacher;
  if (dev) { const ts = String(Math.floor(Date.now() / 1000)); h["X-LOCKqz-Device"] = dev.id; h["X-LOCKqz-Time"] = ts; h["X-LOCKqz-Sig"] = sign(dev.key, "/api" + path.replace(/\?.*/, ""), ts, raw); }
  const res = await onRequest({ request: new Request(BASE + "/api" + path, { method: get ? "GET" : "POST", headers: h, body: get ? undefined : raw }), env });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const one = (sql, ...a) => sqlite.prepare(sql).get(...a);
const iso = ms => new Date(Date.now() + ms).toISOString();

// ---- Stripe mock with real session states: create (open), GET, expire ----
const S = new Map(); let made = 0; const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init = {}) => {
  u = String(u);
  if (!u.startsWith("https://api.stripe.com/v1/checkout/sessions")) return realFetch(u, init);
  await new Promise(r => setTimeout(r, 5));   // network: lets two requests interleave
  const rest = u.slice("https://api.stripe.com/v1/checkout/sessions".length);
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st });
  if (rest === "" && init.method === "POST") {
    const f = new URLSearchParams(String(init.body)), id = "cs_o26_" + (++made);
    S.set(id, { id, status: "open", url: "https://checkout.stripe.com/c/pay/" + id, f });
    return J(S.get(id));
  }
  const m = rest.match(/^\/(cs_[A-Za-z0-9_]+)(\/expire)?$/), s = m && S.get(m[1]);
  if (!s) return J({ error: { code: "resource_missing" } }, 404);
  if (m[2]) { if (s.status !== "open") return J({ error: { code: "checkout_session_not_open" } }, 400); s.status = "expired"; return J(s); }
  return J(s);
};
const opened = () => [...S.values()].filter(s => s.status === "open");
const hook = async event => {
  const raw = JSON.stringify(event), ts = Math.floor(Date.now() / 1000), v1 = createHmac("sha256", WH).update(`${ts}.${raw}`).digest("hex");
  const res = await onRequest({ request: new Request(BASE + "/api/pay/stripe/webhook", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${ts},v1=${v1}` }, body: raw }), env });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const paid = (code, cents, pi) => ({ type: "checkout.session.completed", data: { object: { id: "cs_" + pi, mode: "payment", currency: "usd", payment_status: "paid", amount_total: cents, payment_intent: pi, payment_method_types: ["card"], metadata: { code }, customer_details: { email: "x@usc.edu" } } } });

const ADMIN = (await call("/signup", { email: "admin@usc.edu", password: "adminpass1", name: "Anthony Hall" })).data.token;

console.log("F1a student: a second checkout for the same code reuses the open session");
const AL = (await call("/pay/start", { email: "al@usc.edu" })).data.code;
let r1 = await call("/pay/stripe", { email: "al@usc.edu", method: "card" });
let r2 = await call("/pay/stripe", { email: "al@usc.edu", method: "card" });
check("first checkout made one session", r1.status === 200 && made === 1, JSON.stringify(r1.data));
check("second checkout (other tab / double click) = same URL, no new session", r2.status === 200 && r2.data?.url === r1.data?.url && r2.data?.reused === true && made === 1, JSON.stringify(r2.data));
check("only ONE payable session for this code", opened().filter(s => s.f.get("metadata[code]") === AL).length === 1);
check("sessions expire on their own (expires_at set, <= 24 h)", (() => { const e = Number(S.get("cs_o26_1").f.get("expires_at")); return e > Date.now() / 1000 + 1800 && e <= Date.now() / 1000 + 86400; })());

console.log("F1b a different method (or a session older than 30 min) expires the old one first");
let r3 = await call("/pay/stripe", { email: "al@usc.edu", method: "bank" });
check("bank checkout = a new session", r3.status === 200 && made === 2 && r3.data?.url !== r1.data?.url, JSON.stringify(r3.data));
check("the card session was expired at Stripe (not payable any more)", S.get("cs_o26_1").status === "expired" && opened().filter(s => s.f.get("metadata[code]") === AL).length === 1);
sqlite.prepare("UPDATE events SET ts=? WHERE event='stripe_sess' AND device_id=?").run(iso(-31 * 60000), "code:" + AL);
let r4 = await call("/pay/stripe", { email: "al@usc.edu", method: "bank" });
check("31 minutes later: a fresh session, the old one expired", r4.status === 200 && made === 3 && S.get("cs_o26_2").status === "expired" && opened().filter(s => s.f.get("metadata[code]") === AL).length === 1, JSON.stringify(r4.data));

console.log("F1c a session already paid (webhook not here yet) -> no new checkout");
S.get("cs_o26_3").status = "complete";
let r5 = await call("/pay/stripe", { email: "al@usc.edu", method: "card" });
check("409 'being processed', no new session", r5.status === 409 && r5.data?.processing === true && made === 3, JSON.stringify(r5.data));

console.log("F1d two checkouts at the very same moment end with one payable session");
await call("/pay/start", { email: "bo@usc.edu" });
const [p1, p2] = await Promise.all([call("/pay/stripe", { email: "bo@usc.edu", method: "card" }), call("/pay/stripe", { email: "bo@usc.edu", method: "card" })]);
const BO = one("SELECT code FROM pay_codes_students WHERE email='bo@usc.edu'").code;
check("both answers carry the same URL", p1.data?.url && p1.data.url === p2.data?.url, `${p1.data?.url} ${p2.data?.url}`);
check("only one of the sessions is still payable", opened().filter(s => s.f.get("metadata[code]") === BO).length === 1, String(opened().length));

console.log("F1e professor checkout reuses too");
const PT = (await call("/signup", { email: "prof@usc.edu", password: "profpass1", name: "Duke Bristow" })).data.token;
const MEMO = (await call("/my-sections", null, { teacher: PT, get: true })).data?.memo;
const n0 = made;
const q1 = await call("/pay/stripe-prof", { method: "card" }, { teacher: PT }), q2 = await call("/pay/stripe-prof", { method: "card" }, { teacher: PT });
check("professor: second checkout = same URL", q1.status === 200 && q2.data?.url === q1.data?.url && made === n0 + 1, JSON.stringify(q2.data));

console.log("F1f an overpayment is carried to the next term, never lost");
const cur = one("SELECT term FROM payments LIMIT 1")?.term;   // none yet
let w1 = await hook(paid(AL, 20000, "pi_al_1")), w2 = await hook(paid(AL, 20000, "pi_al_2"));
const rows = sqlite.prepare("SELECT txn, term, note FROM payments WHERE code=? ORDER BY received_at, txn").all(AL);
check("first payment: this term, paid", w1.data?.result?.paid === true && !w1.data.result.carried_from, JSON.stringify(w1.data));
check("second payment counts for the NEXT term", !!w2.data?.result?.carried_from && w2.data.result.term !== w1.data.result.term && w2.data.result.paid === true, JSON.stringify(w2.data));
check("... tagged in the note for Admin -> Payments", /\[overpaid \d{5}: counts for \d{5}\]/.test(rows.find(x => x.txn === "stripe:pi_al_2")?.note || ""), JSON.stringify(rows));
await hook(paid(MEMO, 515000, "pi_prof_1")); const wp = await hook(paid(MEMO, 515000, "pi_prof_2"));
const until = one("SELECT active_until FROM teachers WHERE email='prof@usc.edu'")?.active_until;
check("professor paid twice: active through the end of the NEXT term", !!wp.data?.result?.carried_from && until && until > "2027-01-01", `${until} ${JSON.stringify(wp.data)}`);
void cur;

console.log("F3 a local unlock the server did not expect is red until Brightspace proves the submission");
const roster = [{ id: "8001", name: "Pat Prof", email: "p@usc.edu", role: "Instructor" }, ...[0, 1, 2].map(i => ({ id: String(9100 + i), name: "Stu " + i, email: `s${i}@usc.edu`, role: "Student" }))];
await call("/sync", { courses: [{ ou: "500", name: "ECON 203", classlist: roster, quizzes: [] }] }, { teacher: ADMIN });
const code = (await call("/invite", { email: "p@usc.edu", until: "2099-12-31" }, { teacher: ADMIN })).data?.code;
const P = (await call("/signup", { email: "p@usc.edu", password: "profpass12", name: "Pat Prof", invite: code })).data?.token;
await call("/sync", { whoami: { id: "8001" }, courses: [{ ou: "500", name: "ECON 203", classlist: roster, quizzes: [{ qi: "1", name: "Q1", active: true }] }] }, { teacher: P });
let ipN = 0;
async function device(id, email) {
  const d = { id, key: randomBytes(32).toString("hex") };
  await call("/register", { device_id: id, key: d.key, platform: "mac", version: "0.5.0" }, { ip: "10.9.0." + (++ipN) });
  const k = MAILS.length; await call("/verify", { op: "send", email }, { dev: d }); const m = MAILS.slice(k).find(x => x.to === email);
  if (m) await call("/verify", { op: "code", email, code: m.code }, { dev: d });
  return d;
}
const D = [await device("mac-o26-0", "s0@usc.edu"), await device("mac-o26-1", "s1@usc.edu"), await device("mac-o26-2", "s2@usc.edu")];
const lock = d => call("/report", { event: "lock", quiz_id: "500-1" }, { dev: d });
const localUnlock = (d, reason) => call("/report", { event: "unlock", quiz_id: "500-1", detail: { reason, local: true, before_end: true } }, { dev: d });
const ago = (d, ms) => sqlite.prepare("UPDATE events SET ts=? WHERE device_id=? AND event='unlock'").run(iso(-ms), d.id);
const row = async d => ((await call("/live?quiz=500-1", null, { teacher: P, get: true })).data?.rows || []).find(x => x.device_id === d.id);
// D0: "quiz_submitted" from the Mac with no submission anywhere (a forged local /unlock).
await lock(D[0]); await localUnlock(D[0], "quiz_submitted");
check("server marks it unexpected", /"unexpected":true/.test(one("SELECT detail FROM events WHERE device_id=? AND event='unlock'", D[0].id)?.detail || ""));
check("first 2 minutes: not red yet (the Sync tab's report may still be coming)", (await row(D[0]))?.status === "done");
ago(D[0], 3 * 60000);
let rw = await row(D[0]);
check("after 2 min with no Brightspace submission: red 'unverified' (even though no submissions are reported for this quiz)", rw?.status === "left_early" && rw?.reason === "unverified", JSON.stringify(rw));
// D1: Brightspace (Sync) already saw the submission after this lock -> expected, clean.
await lock(D[1]);
sqlite.prepare("UPDATE locks SET locked_at=? WHERE device_id=?").run(iso(-10 * 60000), D[1].id);
await call("/submitted", { ou: "500", qi: "1", users: [{ id: "9101", completed: iso(-5 * 60000) }] }, { teacher: P });
await localUnlock(D[1], "quiz_submitted");
check("submission known before the unlock -> expected (not flagged)", /"expected":"quiz_submitted"/.test(one("SELECT detail FROM events WHERE device_id=? AND event='unlock'", D[1].id)?.detail || ""));
ago(D[1], 3 * 60000); rw = await row(D[1]);
check("... shown as Submitted", rw?.status === "done" && rw?.submitted === true, JSON.stringify(rw));
// D0's student submits later in Brightspace than the forged unlock: stays red.
await call("/submitted", { ou: "500", qi: "1", users: [{ id: "9100", completed: iso(0) }] }, { teacher: P });
rw = await row(D[0]);
check("forged unlock BEFORE the real completion stays red", rw?.status === "left_early", JSON.stringify(rw));
// D2: an old helper's unlock (no local flag) is checked too (29 Oct 2026): every signed unlock the server cannot explain is tagged.
await lock(D[2]); await call("/report", { event: "unlock", quiz_id: "500-1", detail: { reason: "quiz_submitted" } }, { dev: D[2] });
check("old helpers' unlocks are checked as well (unexplained -> tagged)", /unexpected/.test(one("SELECT detail FROM events WHERE device_id=? AND event='unlock'", D[2].id)?.detail || ""));
check("dashboard explains 'unverified'", /unverified:"/.test(readFileSync(join(CF, "public", "dashboard.html"), "utf8")));

console.log("F5 the retired course-wide password");
sqlite.prepare("INSERT INTO courses (ou,title,password,created_at,teacher_id) VALUES ('600','Old','LQ-oldcourse',?,'admin')").run(iso(0));
await call("/sync", { courses: [{ ou: "600", name: "OLD 100", classlist: [{ id: "6001", name: "Kid", email: "s0@usc.edu", role: "Student" }], quizzes: [] }] }, { teacher: ADMIN });
await call("/report", { event: "lock", quiz_id: "600-77" }, { dev: D[0] });
const pr = await call("/password", { url: "https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=77&ou=600", device_id: D[0].id }, { dev: D[0] });
check("a quiz with only an old course-wide password gets NO password", !pr.data?.password, JSON.stringify(pr.data));
const cr = await call("/course", { url: "https://usc.brightspace.com/d2l/home/600" }, { teacher: ADMIN });
check("/course (make a course-wide password) is retired: 410", cr.status === 410, JSON.stringify(cr.data));

console.log("F6 (29 Oct) a local unlock that ASKS is HELD while the gate runs and nothing vouches for the end; released once Brightspace sees the submission");
sqlite.prepare("UPDATE quizzes SET gated=1 WHERE ou='500' AND qi='1'").run();
const ask = (d, reason) => call("/report", { event: "unlock", quiz_id: "500-1", detail: { reason, local: true, ask: true, before_end: true } }, { dev: d });
const D3 = await device("mac-o26-3", "s0@usc.edu");
await lock(D3);
let h = await ask(D3, "quiz_tab_closed");
check("gate on, no submission: hold:true, lock row kept", h.data?.hold === true && !!one("SELECT 1 FROM locks WHERE device_id=? AND quiz_id='500-1'", D3.id), JSON.stringify(h.data));
check("logged as unlock_held (not as an unlock)", !!one("SELECT 1 FROM events WHERE device_id=? AND event='unlock_held'", D3.id) && !one("SELECT 1 FROM events WHERE device_id=? AND event='unlock'", D3.id));
check("hold answer asks for 30 s beats", h.data?.beat_s === 30);
h = await ask(D3, "quiz_submitted");
check("a claimed 'quiz_submitted' with no submission is held just the same", h.data?.hold === true);
// the Sync tab reports the submission -> the next beat releases it
sqlite.prepare("UPDATE locks SET locked_at=? WHERE device_id=?").run(iso(-10 * 60000), D3.id);
await call("/submitted", { ou: "500", qi: "1", users: [{ id: "9100", completed: iso(-60000) }] }, { teacher: P });
const hb = await call("/report", { event: "heartbeat", quiz_id: "500-1" }, { dev: D3 });
check("heartbeat after the submission: unlock:true quiz_submitted", hb.data?.unlock === true && hb.data?.reason === "quiz_submitted", JSON.stringify(hb.data));
h = await ask(D3, "quiz_submitted");
check("asking again now: accepted (expected), lock row gone", h.data?.hold !== true && !one("SELECT 1 FROM locks WHERE device_id=? AND quiz_id='500-1'", D3.id), JSON.stringify(h.data));
// gate stopped: nobody proctoring -> a local unlock stands (flagged), never a 6-hour stranding
sqlite.prepare("UPDATE quizzes SET gated=0 WHERE ou='500' AND qi='1'").run();
const D4 = await device("mac-o26-4", "s1@usc.edu"); await lock(D4);
h = await ask(D4, "quiz_tab_closed");
check("gate off: not held, flagged unexpected", h.data?.hold !== true && /"unexpected":true/.test(one("SELECT detail FROM events WHERE device_id=? AND event='unlock'", D4.id)?.detail || ""), JSON.stringify(h.data));
// a device reporting non-stop hits the daily event ceiling and is dropped, not written
const D5 = await device("mac-o26-5", "s2@usc.edu");
for (let i = 0; i < 300; i++) sqlite.prepare("INSERT INTO events (device_id,quiz_id,event,ts) VALUES (?,?,?,?)").run(D5.id, "500-1", "quiz_left", iso(-1000 * i));
const flood = await call("/report", { event: "lock", quiz_id: "500-1" }, { dev: D5 });
check("301st event of the day: 429, nothing written", flood.status === 429 && flood.data?.dropped === "too_many_reports" && !one("SELECT 1 FROM locks WHERE device_id=?", D5.id));
const bt1 = await call("/report", { event: "heartbeat", quiz_id: "500-1" }, { dev: D[1] });
check("heartbeats are never dropped by the ceiling", bt1.status === 200);
const route = readFileSync(join(CF, "functions", "api", "[[route]].js"), "utf8");
check("no code path reads courses.password for /password", !/AS cpw/.test(route) && !/q\?\.cpw/.test(route));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
