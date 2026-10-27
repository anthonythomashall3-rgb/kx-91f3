import { withPayT } from "./pay_t.mjs";
// Round-3 API regressions (26 Oct 2026): one block per finding fixed in app/cloudflare/functions/api.
// Runs the REAL API against in-memory SQLite with a D1 shim that enforces the 100-parameter cap, counts
// D1 queries per request (Free plan: 50; target <= 45) and rows written, and logs every statement so a
// check can EXPLAIN its query plan. Prove a check fails on the old code with
//   LQZ_CF=<old app/cloudflare dir> node --no-warnings test_round3_api.mjs     (old route + old schema)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes, pbkdf2Sync } from "node:crypto";

// Controllable clock (the API reads Date): CLOCK.off ms are added to the real time.
const RealDate = Date, CLOCK = { off: 0 };
class FDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + CLOCK.off); } static now() { return RealDate.now() + CLOCK.off; } }
globalThis.Date = FDate;
const setToday = isoLA => { CLOCK.off = 0; CLOCK.off = RealDate.parse(isoLA + "T20:00:00Z") - RealDate.now(); };   // noon in LA

const HERE = dirname(fileURLToPath(import.meta.url));
const CF = process.env.LQZ_CF || join(HERE, "..", "cloudflare");
const ROUTE = join(CF, "functions", "api", "[[route]].js");
const tmp = mkdtempSync(join(tmpdir(), "lqz-r3-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(ROUTE));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

let Q = 0, W = 0, LOG = [];
function d1(sqlite) {
  const mk = sql => { const st = sqlite.prepare(sql); let args = [];
    const s = {
      bind(...a) { if (a.length > 100) throw new Error("too many SQL variables (" + a.length + ")");
        args = a.map(x => { if (x === undefined) throw new Error("D1_TYPE_ERROR: undefined"); if (x !== null && typeof x === "object") throw new Error("D1_TYPE_ERROR: object"); return typeof x === "boolean" ? Number(x) : x; }); return s; },
      first: async () => { Q++; LOG.push([sql, args]); return st.get(...args) ?? null; },
      all: async () => { Q++; LOG.push([sql, args]); return { results: st.all(...args) }; },
      run: async () => { Q++; LOG.push([sql, args]); const c = Number(st.run(...args).changes); W += c; return { meta: { changes: c } }; },
      _run() { LOG.push([sql, args]); W += Number(st.run(...args).changes); } };
    return s; };
  return { prepare: mk, async batch(sts) { Q++; sqlite.exec("BEGIN"); try { for (const s of sts) s._run(); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; } return []; } };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch {} }
const MAILS = [];
const env = { DB: d1(sqlite), TEACHER_KEY: "admin-key-r3", REQUIRE_SIGNED: "1", ADMIN_EMAIL: "admin@usc.edu", ROT_SECRET: "rot-secret-r3",
              STUDENT_FEE: "5", PAY_SECRET: "pay-secret-r3-0123456789", LIVE_CACHE_MS: "0", MAIL_SINK: async m => { MAILS.push(m); return true; } };
const BASE = "https://lockqz.test";
const sign = (key, path, ts, raw) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(raw).digest("hex")}`).digest("hex");
async function call(path, body, { teacher = null, sync = null, dev = null, get = false, ip = "10.0.0.9", hdr = {}, envx = {} } = {}) {
  body = withPayT(path, body, { ...env, ...envx });
  const raw = JSON.stringify(body ?? {});
  const h = { "Content-Type": "application/json", "CF-Connecting-IP": ip, ...hdr };
  if (teacher) h["X-LOCKqz-Teacher"] = teacher;
  if (sync) h["X-LOCKqz-Sync"] = sync;
  if (dev) { const ts = String(Math.floor(Date.now() / 1000)); h["X-LOCKqz-Device"] = dev.id; h["X-LOCKqz-Time"] = ts; h["X-LOCKqz-Sig"] = sign(dev.key, "/api" + path.replace(/\?.*/, ""), ts, raw); }
  Q = 0; W = 0; LOG = [];
  const res = await onRequest({ request: new Request(BASE + "/api" + path, { method: get ? "GET" : "POST", headers: h, body: get ? undefined : raw }), env: { ...env, ...envx } });
  return { status: res.status, data: await res.json().catch(() => null), q: Q, w: W, log: LOG };
}
// Tolerant of the OLD schema (LQZ_CF runs): a column that does not exist yet reads as "missing".
const one = (sql, ...a) => { try { return sqlite.prepare(sql).get(...a); } catch { return { __missing: true }; } };
const n = (sql, ...a) => { try { return Number(Object.values(sqlite.prepare(sql).get(...a))[0]); } catch { return NaN; } };
const tid = email => one("SELECT id FROM teachers WHERE email=?", email)?.id;
const plans = log => log.map(([sql, args]) => { try { return { sql, plan: sqlite.prepare("EXPLAIN QUERY PLAN " + sql).all(...args).map(r => r.detail).join(" | ") }; } catch (e) { return { sql, plan: "?" + e.message }; } });
const badEventPlans = log => plans(log).filter(p => /\bevents\b/.test(p.sql) && /(SCAN (e|events)\b(?! USING)|USING (COVERING )?INDEX idx_events_event_ts \(event=\?\)$)/m.test(p.plan.split(" | ").filter(x => /\b(e|events)\b/.test(x)).join("\n")));
const quizUrl = (ou, qi, host = "usc.brightspace.com") => `https://${host}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${qi}&ou=${ou}`;
let ipN = 0;
async function device(id, email) {
  const d = { id, key: randomBytes(32).toString("hex") };
  await call("/register", { device_id: id, key: d.key, platform: "mac", version: "0.4.1" }, { ip: "10.8." + (++ipN % 250) + "." + (ipN >> 8) });
  if (email) { const k = MAILS.length; await call("/verify", { op: "send", email }, { dev: d }); const m = MAILS.slice(k).find(x => x.to === email);
    if (m) await call("/verify", { op: "code", email, code: m.code }, { dev: d }); }
  return d;
}
const lock = (d, lid, extra = {}) => call("/report", { event: "lock", quiz_id: lid, ...extra }, { dev: d });
const beat = (d, lid) => call("/report", { event: "heartbeat", quiz_id: lid, source: "helper" }, { dev: d });
const unlock = (d, lid, reason) => call("/report", { event: "unlock", quiz_id: lid, reason }, { dev: d });
const pw = (d, ou, qi, host) => call("/password", { url: quizUrl(ou, qi, host), device_id: d.id }, { dev: d });
const iso = ms => new Date(Date.now() + ms).toISOString();
async function invited(email, until = "2099-12-31") {
  const code = (await call("/invite", { email, until }, { teacher: ADMIN })).data?.code;
  return (await call("/signup", { email, password: "profpass12", name: "Prof " + email.split("@")[0], invite: code }, { ip: "10.77.0.1" })).data?.token;
}
const ADMIN = (await call("/signup", { email: "admin@usc.edu", password: "adminpass1", name: "Anthony Hall" })).data.token;
let r;

console.log("S1 email code: 5 wrong tries kill the code even when no new code can be sent (no unlimited guessing)");
{ const V = "victim3@usc.edu";
  const d = { id: "mac-r3-brute", key: randomBytes(32).toString("hex") };
  await call("/register", { device_id: d.id, key: d.key, platform: "mac", version: "0.4.1" }, { ip: "10.31.0.1" });
  // 3 codes to the same address in an hour = the per-recipient limit; the 3rd code is live.
  for (let i = 0; i < 3; i++) await call("/verify", { op: "send", email: V }, { dev: d });
  const live3 = MAILS.filter(m => m.to === V).pop()?.code;
  check("precondition: 3 codes sent, the 4th is refused", !!live3 && (await call("/verify", { op: "send", email: V }, { dev: d })).status === 429);
  const wrong = String((Number(live3) + 1) % 1000000).padStart(6, "0");
  for (let i = 0; i < 4; i++) await call("/verify", { op: "code", email: V, code: wrong }, { dev: d });
  r = await call("/verify", { op: "code", email: V, code: wrong }, { dev: d });
  check("5th wrong try: a new code cannot be sent (429)", r.status === 429, JSON.stringify(r.data));
  r = await call("/verify", { op: "code", email: V, code: live3 }, { dev: d });
  check("... and the old code is dead: guessing it right afterwards does NOT verify", r.data?.verified !== true && one("SELECT student_verified FROM devices WHERE device_id=?", d.id)?.student_verified !== 1, JSON.stringify(r.data));
  check("... no code row is left to guess", n("SELECT COUNT(*) FROM email_codes WHERE device_id=?", d.id) === 0);
}

// ---------- world: course 900 seeded by the admin; co-instructors P9 (9001) and Q9 (9002) ----------
const roster900 = [{ id: "9001", name: "Pat Nine", email: "p9@usc.edu", role: "Instructor" }, { id: "9002", name: "Quinn Nine", email: "q9@usc.edu", role: "Instructor" },
  ...Array.from({ length: 3 }, (_, i) => ({ id: String(9500 + i), name: "Stu " + i, email: `st9${i}@usc.edu`, role: "Student" }))];
await call("/sync", { courses: [{ ou: "900", name: "FBE 900", classlist: roster900, quizzes: [] }] }, { teacher: ADMIN });
const P9 = await invited("p9@usc.edu"), Q9 = await invited("q9@usc.edu");
await call("/sync", { whoami: { id: "9001" }, courses: [{ ou: "900", name: "FBE 900", classlist: roster900, quizzes: [{ qi: "1", name: "Mid", active: true, end: iso(86400e3) }] }] }, { teacher: P9 });
await call("/sync", { whoami: { id: "9002" }, courses: [{ ou: "900", name: "FBE 900", classlist: roster900, quizzes: [{ qi: "1", name: "Mid", active: true, end: iso(86400e3) }] }] }, { teacher: Q9 });
const DS = await device("mac-r3-st0", "st90@usc.edu");
await lock(DS, "900-1");

console.log("S2 the Sync bookmark key reads no class lists and cannot rotate itself");
{ const K = (await call("/synckey", null, { teacher: P9, get: true })).data?.key;
  check("precondition: the key works for the Sync endpoints", (await call("/me", null, { sync: K, get: true })).status === 200);
  r = await call("/bs", null, { sync: K, get: true });
  check("/bs with the Sync key: refused (no student emails)", r.status === 403 && !JSON.stringify(r.data).includes("st90@usc.edu"), r.status + " " + JSON.stringify(r.data).slice(0, 120));
  r = await call("/synckey", {}, { sync: K });
  check("POST /synckey with the Sync key: refused (key unchanged)", r.status === 403 && one("SELECT sync_key FROM teachers WHERE email='p9@usc.edu'")?.sync_key === K);
  check("/bs with the session token still works", (await call("/bs", null, { teacher: P9, get: true })).data?.courses?.length === 1);
}

console.log("S3 (FERPA) a co-instructor removed from the class list loses the course's activity and devices");
{ const before = (await call("/sessions?quiz=900", null, { teacher: P9, get: true })).data?.events || [];
  check("precondition: P9 sees course 900's events and its quiz row is P9's", before.some(e => e.device_id === "mac-r3-st0") && n("SELECT COUNT(*) FROM quizzes WHERE ou='900' AND teacher_id=?", tid("p9@usc.edu")) === 1, JSON.stringify(before).slice(0, 200));
  // Q9 syncs: Brightspace no longer lists P9 in the course.
  await call("/sync", { whoami: { id: "9002" }, courses: [{ ou: "900", name: "FBE 900", classlist: roster900.filter(x => x.id !== "9001"), quizzes: [{ qi: "1", name: "Mid", active: true, end: iso(86400e3) }] }] }, { teacher: Q9 });
  const ev = (await call("/sessions?quiz=900", null, { teacher: P9, get: true })).data?.events || [];
  const all = (await call("/sessions", null, { teacher: P9, get: true })).data?.events || [];
  const devs = (await call("/roster", null, { teacher: P9, get: true })).data?.devices || [];
  check("/sessions?quiz=900: nothing for the removed co-instructor", ev.length === 0, JSON.stringify(ev).slice(0, 200));
  check("/sessions (all): no event of course 900", !all.some(e => String(e.quiz_id || "").startsWith("900-") || e.device_id === "mac-r3-st0"));
  check("/roster: no device of course 900", !devs.some(d => d.device_id === "mac-r3-st0"), JSON.stringify(devs).slice(0, 200));
  check("the remaining instructor still sees it", ((await call("/sessions?quiz=900", null, { teacher: Q9, get: true })).data?.events || []).some(e => e.device_id === "mac-r3-st0"));
}

{ const qz = (await call("/quizzes", null, { teacher: P9, get: true })).data?.quizzes || [];
  const q = qz.find(x => String(x.ou) === "900");
  check("/quizzes: the removed co-instructor still sees the row, not its live password", !!q && q.password === null, JSON.stringify(qz));
  const qq = ((await call("/quizzes", null, { teacher: Q9, get: true })).data?.quizzes || []);
  check("... while it is P9's row, its password is never handed to anyone else either", !qq.some(x => String(x.ou) === "900" && x.password));
}

console.log("S8 malformed client fields never throw a 500");
{ r = await call("/register", { device_id: "mac-r3-obj", key: randomBytes(32).toString("hex"), student: { x: 1 }, platform: ["mac"], version: 5 }, { ip: "10.88.0.1" });
  check("/register with object fields: no 500", r.status === 200, r.status + " " + JSON.stringify(r.data));
}

console.log("S4 roster sync: a class list longer than LOCKqz reads (3,000) never drops students");
{ const big = Array.from({ length: 3001 }, (_, i) => ({ id: String(200000 + i), name: "Big " + i, email: `big${i}@usc.edu`, role: "Student" }));
  await call("/sync", { whoami: { id: "9002" }, courses: [{ ou: "900", name: "FBE 900", classlist: [roster900[1], ...big], quizzes: null }] }, { teacher: Q9 });
  check("students past the 3,000th row are kept (st90 still on the roster)", n("SELECT COUNT(*) FROM roster WHERE ou='900' AND email='st90@usc.edu'") === 1);
  await call("/sync", { whoami: { id: "9002" }, courses: [{ ou: "900", name: "FBE 900", classlist: [roster900[1], roster900[3]], quizzes: null }] }, { teacher: Q9 });
  check("a normal-size list still drops students Brightspace no longer lists", n("SELECT COUNT(*) FROM roster WHERE ou='900' AND email='st90@usc.edu'") === 0 && n("SELECT COUNT(*) FROM roster WHERE ou='900' AND email='st91@usc.edu'") === 1);
}

console.log("S5 self-signup is rate-limited per IP; invite sign-ups are not");
{ let ok = 0, last = null;
  for (let i = 0; i < 11; i++) { last = await call("/signup", { email: `spam${i}@x.com`, password: "spampass12" }, { ip: "10.55.0.1" }); if (last.status === 200) ok++; }
  check("10 self-sign-ups from one IP in an hour, the 11th is refused (429)", ok === 10 && last.status === 429, `${ok} ${last.status}`);
  const code = (await call("/invite", { email: "late@usc.edu", until: "2099-12-31" }, { teacher: ADMIN })).data?.code;
  r = await call("/signup", { email: "late@usc.edu", password: "latepass12", invite: code }, { ip: "10.55.0.1" });
  check("an invited professor from the same IP still signs up", r.status === 200 && !!r.data?.token, JSON.stringify(r.data));
}

console.log("S6 bank-details emails have a global daily cap (Gmail's quota is shared with students' email codes)");
{ const st = [];
  for (let i = 0; i < 3; i++) st.push((await call("/pay/bank", { email: `bank${i}@usc.edu` }, { ip: "10.66.0." + i, envx: { BANK_MAIL_DAILY_MAX: "2", STUDENT_FEE_FROM: "2020-01-01" } })).status);
  check("the 3rd address of the day is refused once the cap (2) is reached", st[0] === 200 && st[1] === 200 && st[2] === 429, st.join(","));
  r = await call("/pay/bank", { email: "bank9@usc.edu" }, { ip: "10.66.0.9", hdr: { "X-LOCKqz-Pay": env.PAY_SECRET }, envx: { BANK_MAIL_DAILY_MAX: "2", STUDENT_FEE_FROM: "2020-01-01" } });
  check("the Gmail script (answering a payer's own email) is not capped", r.status === 200, JSON.stringify(r.data));
}

console.log("S7 /pay/tick: wrong key refused, right key accepted");
check("/pay/tick wrong key -> 401", (await call("/pay/tick", {}, { hdr: { "X-LOCKqz-Pay": "x".repeat(env.PAY_SECRET.length) } })).status === 401);
check("/pay/tick right key -> 200", (await call("/pay/tick", {}, { hdr: { "X-LOCKqz-Pay": env.PAY_SECRET } })).status === 200);

console.log("S8 payment status: only the email's owner (pay-link token) or the admin can see it");
{ const FEE = { STUDENT_FEE_FROM: "2000-01-01" }, E = "priv@usc.edu";
  const k = MAILS.length;
  const anon = await call("/pay/start", { email: E, t: null }, { envx: FEE, ip: "10.9.9.1" });
  check("typed email (no token): no code, no paid status, no amounts", anon.status === 200 && anon.data?.link_sent === true && !("code" in anon.data) && !("paid" in anon.data) && !("received" in anon.data) && !("token" in anon.data), JSON.stringify(anon.data));
  const mail = MAILS.slice(k).find(m => m.to === E);
  check("the owner is emailed a pay link with the token", !!mail && /pay\?email=priv%40usc\.edu&t=[0-9a-f]{32}/.test(JSON.stringify(mail)), JSON.stringify(mail));
  const again = await call("/pay/start", { email: E, t: null }, { envx: FEE, ip: "10.9.9.1" });
  check("a second ask within 10 min sends no second email", again.data?.link_sent === true && MAILS.slice(k).filter(m => m.to === E).length === 1);
  const wrong = await call("/pay/start", { email: E, t: "0".repeat(32) }, { envx: FEE, ip: "10.9.9.1" });
  check("wrong token: same answer as no token", wrong.data?.link_sent === true && !("code" in wrong.data));
  const own = await call("/pay/start", { email: E }, { envx: FEE, ip: "10.9.9.1" });
  check("owner's link (token): full pay info", /^LQS/.test(own.data?.code || "") && own.data?.paid === false, JSON.stringify(own.data));
  const adm = await call("/pay/start", { email: E, t: null }, { envx: FEE, teacher: ADMIN, ip: "10.9.9.1" });
  check("admin: full pay info for any email", adm.data?.code === own.data?.code && "paid" in adm.data, JSON.stringify(adm.data));
  check("/pay/stripe without token -> 403", (await call("/pay/stripe", { email: E, t: null }, { envx: { ...FEE, STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" }, ip: "10.9.9.2" })).status === 403);
  check("/pay/renew without token -> 403", (await call("/pay/renew", { email: E, on: false, t: null }, { envx: FEE })).status === 403);
  const bk = await call("/pay/bank", { email: E, t: null }, { envx: FEE, ip: "10.9.9.3" });
  check("/pay/bank without token: never says paid or the amount", bk.data && !("paid" in bk.data) && !("amount" in bk.data), JSON.stringify(bk.data));
  check("/pay/status without code or token -> 403", (await call("/pay/status?email=" + encodeURIComponent(E), null, { envx: FEE, get: true })).status === 403);
}

console.log("");
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
