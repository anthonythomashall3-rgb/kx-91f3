// LOCKqz — live quiz-monitor status logic (the /live endpoint + the heartbeat refresh).
// Drives the REAL functions/api/[[route]].js (in-memory SQLite), so it can never drift from the
// Worker the way a copied status function did. Verifies:
//  - the per-student status truth table (locked / tamper / helper_killed / browser_closed / dark)
//  - a quiz-time heartbeat (every ~300s, free-plan budget) keeps the 660s live-monitor window
//    fresh, so a locked student is never falsely flagged; the 60s password gate is met by the
//    fresh heartbeat the helper sends right before every password request
//  - heartbeat source maps to the right column (agent/ext -> ext_seen, helper -> helper_seen)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-live-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(process.env.LQZ_ROUTE || join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log("  ok:", m); };
const bad = m => { fail++; console.log("  FAIL:", m); };
const eq  = (m, a, b) => (a === b ? ok(m) : bad(`${m}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
const db = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
  const s = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return s; },
    first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
    run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run: () => st.run(...args) };
  return s; }, async batch(sts) { for (const s of sts) s._run(); } };
// LIVE_CACHE_MS=0: this suite edits the database directly between /live calls (no shared cache).
const env = { DB: db, TEACHER_KEY: "live-admin-key", REQUIRE_SIGNED: "1", LIVE_CACHE_MS: "0" };
const sign = (key, path, ts, raw) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(raw).digest("hex")}`).digest("hex");
async function api(path, body, dev) {
  const raw = JSON.stringify(body ?? {}), h = { "Content-Type": "application/json" };
  if (dev) { const ts = String(Math.floor(Date.now() / 1000)); h["X-LOCKqz-Device"] = dev.id; h["X-LOCKqz-Time"] = ts; h["X-LOCKqz-Sig"] = sign(dev.key, "/api" + path, ts, raw); }
  else h["X-LOCKqz-Teacher"] = env.TEACHER_KEY;
  const res = await onRequest({ request: new Request("https://lockqz.test/api" + path, body === undefined ? { method: "GET", headers: h } : { method: "POST", headers: h, body: raw }), env });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const OU = "321", QI = "654", Q = `${OU}-${QI}`;
const iso = agoMs => agoMs == null ? null : new Date(Date.now() - agoMs).toISOString();
let k = 0;
// one device with a lock row whose timestamps are `ago` ms in the past (null = never seen)
async function statusOf(lastLock, helperSeen, extSeen, tampered = false) {
  const id = "live-dev-" + (++k);
  sqlite.prepare("INSERT INTO devices (device_id,student,platform) VALUES (?,?,?)").run(id, id + "@usc.edu", "mac");
  sqlite.prepare("INSERT INTO locks (device_id,quiz_id,last_lock,helper_seen,ext_seen,signed) VALUES (?,?,?,?,?,1)").run(id, Q, iso(lastLock), iso(helperSeen), iso(extSeen));
  if (tampered) sqlite.prepare("INSERT INTO events (device_id,quiz_id,event,ts) VALUES (?,?,?,?)").run(id, Q, "tamper", iso(0));
  const r = await api(`/live?quiz=${Q}`);
  return (r.data?.rows || []).find(x => x.device_id === id)?.status;
}
const fresh = 10_000, stale = 700_000, gone = 800_000;   // live window 660s; agent "browser closed" after 720s

console.log("T1 status truth table (real /live)");
eq("all fresh -> locked",                            await statusOf(fresh, fresh, fresh), "locked");
eq("tamper flag wins even if fresh",                 await statusOf(fresh, fresh, fresh, true), "tamper");
eq("helper stale, agent still reporting -> helper_killed", await statusOf(stale, stale, fresh), "helper_killed");
eq("agent gone (>720s), helper fresh -> browser_closed", await statusOf(stale, fresh, gone), "browser_closed");
eq("both stale -> dark (wifi drop, not cheating)",   await statusOf(gone, gone, gone), "dark");
eq("both never-seen (null) -> dark",                 await statusOf(stale, null, null), "dark");
eq("last_lock fresh overrides -> locked",            await statusOf(fresh, stale, stale), "locked");

console.log("T2 a 300s heartbeat keeps a locked student from being flagged");
eq("300s < 660s live window -> still locked",        await statusOf(300_000, 300_000, 300_000), "locked");
eq("one missed beat (600s) is still locked (wifi blip tolerance)", await statusOf(600_000, 600_000, 600_000), "locked");

console.log("T3 heartbeat source maps to the right column; the helper's beat refreshes the lock");
const dev = { id: "live-hb-1", key: randomBytes(32).toString("hex") };
await api("/register", { device_id: dev.id, key: dev.key, student: "hb@usc.edu", platform: "mac" });
await api("/report", { event: "lock", quiz_id: Q }, dev);
const cols = () => sqlite.prepare("SELECT last_lock, helper_seen, ext_seen FROM locks WHERE device_id=? AND quiz_id=?").get(dev.id, Q);
sqlite.prepare("UPDATE locks SET last_lock=?, helper_seen=?, ext_seen=NULL WHERE device_id=?").run(iso(100_000), iso(100_000), dev.id);
for (const src of ["agent", "ext", "extension"]) {
  await api("/report", { event: "heartbeat", quiz_id: Q, source: src }, dev);
  const c = cols();
  eq(`source '${src}' -> ext_seen only (does not keep the lock alive)`, !!c.ext_seen && Date.now() - Date.parse(c.last_lock) > 50_000, true);
}
for (const src of ["helper", undefined]) {
  sqlite.prepare("UPDATE locks SET last_lock=?, helper_seen=? WHERE device_id=?").run(iso(100_000), iso(100_000), dev.id);
  await api("/report", { event: "heartbeat", quiz_id: Q, ...(src ? { source: src } : {}) }, dev);
  const c = cols();
  eq(`source '${src}' -> helper_seen + last_lock refreshed`, Date.now() - Date.parse(c.helper_seen) < 5_000 && Date.now() - Date.parse(c.last_lock) < 5_000, true);
}

console.log("T4 C1: the helper's SIGNED password request is itself fresh proof of the lock (no heartbeat first)");
sqlite.prepare("INSERT INTO quizzes (quiz_id,password,created_at,qi,ou,lock_id) VALUES ('LIVEQ','LQ-LIVE1234',?,?,?,?)").run(iso(0), QI, OU, Q);
const url = `https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${QI}&ou=${OU}`;
sqlite.prepare("UPDATE locks SET last_lock=? WHERE device_id=?").run(iso(90_000), dev.id);
eq("a signed request on a 90s-old lock row gets the password", (await api("/password", { url }, dev)).data?.password, "LQ-LIVE1234");
eq("... and refreshes the lock row itself", Date.now() - Date.parse(cols().last_lock) < 5_000, true);
sqlite.prepare("DELETE FROM locks WHERE device_id=?").run(dev.id);
eq("no lock row at all -> no password", (await api("/password", { url }, dev)).data?.password ?? null, null);
await api("/report", { event: "lock", quiz_id: Q }, dev);
eq("after a lock the password is released", (await api("/password", { url }, dev)).data?.password, "LQ-LIVE1234");

console.log("");
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
