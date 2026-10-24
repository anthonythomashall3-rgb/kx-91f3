// Device authentication: runs the REAL API (cloudflare/functions/api/[[route]].js) against an
// in-memory SQLite database (node:sqlite) and proves the 23 Oct 2026 fix:
//   a script that never installed LOCKqz can no longer fake a "locked" report and read the
//   quiz password; a registered device cannot be impersonated; unsigned heartbeats cannot keep
//   a lock alive. Runs twice: on a fresh schema and on an old schema upgraded by migrate_009.
// No network. Exits non-zero on any failure.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-auth-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);

let pass = 0, fail = 0;
const ok = m => { pass++; console.log("  ok:", m); };
const bad = m => { fail++; console.log("  FAIL:", m); };
const check = (m, cond, info = "") => (cond ? ok(m) : bad(m + (info ? `  (${info})` : "")));

// Shared vector: Python helper, PowerShell helper and this server must all produce it.
const VECTOR = { key: "00".repeat(32), path: "/api/report", ts: "1700000000", body: '{"a":1}',
                 sig: "9f569120c07099a12759105ba726aa27111277be70b407d718a8ff0013400111" };
const sign = (key, path, ts, body) =>
  createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");

// Minimal D1 stand-in over node:sqlite (prepare/bind/first/all/run).
function d1(sqlite) {
  return { prepare(sql) {
    const st = sqlite.prepare(sql); let args = [];
    const s = { bind(...a) { args = a.map(x => (x === undefined ? null : typeof x === "boolean" ? Number(x) : x)); return s; },
                first: async () => st.get(...args) ?? null,
                all: async () => ({ results: st.all(...args) }),
                run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }) };
    return s;
  } };
}

const BASE = "https://lockqz.test";
const QUIZ_URL = "https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=12345&ou=98765";
const LOCK_ID = "98765-12345";
const ADMIN = "admin-test-key";

function makeDb(oldSchema) {
  const sqlite = new DatabaseSync(":memory:");
  let schema = readFileSync(join(CF, "schema.sql"), "utf8");
  if (oldSchema)   // the schema as it was before this fix: no key/signed columns
    schema = schema.split("\n").filter(l => !/device_key|registered_at|reg_ip|revoked|\bsigned\b/.test(l)).join("\n")
      .replace(/last_seen   TEXT,\n\);/, "last_seen   TEXT\n);").replace(/ext_seen  TEXT,\n  PRIMARY/, "ext_seen  TEXT,\n  PRIMARY");
  sqlite.exec(schema);
  if (oldSchema) sqlite.exec(readFileSync(join(CF, "migrate_009_device_auth.sql"), "utf8"));
  for (const m of ["migrate_012_bs_code.sql", "migrate_013_sa_keep.sql", "migrate_014_lockqz_off.sql", "migrate_015_bs_user.sql"]) { try { sqlite.exec(readFileSync(join(CF, m), "utf8")); } catch (e) { /* already in schema.sql */ } }
  const now = new Date().toISOString();
  sqlite.prepare("INSERT INTO quizzes (quiz_id,title,password,created_at,qi,teacher_id,lock_id,ou) VALUES (?,?,?,?,?,?,?,?)")
    .run("q1", "Quiz 1", "LQ-SECRET01", now, "12345", "t1", LOCK_ID, "98765");
  return sqlite;
}

async function call(env, path, body, { key = null, device = null, tsOffset = 0, signPath = null, signBody = null, headers = {} } = {}) {
  const raw = JSON.stringify(body ?? {});
  const h = { "Content-Type": "application/json", ...headers };
  if (key) {
    const ts = String(Math.floor(Date.now() / 1000) + tsOffset);
    h["X-LOCKqz-Device"] = device; h["X-LOCKqz-Time"] = ts;
    h["X-LOCKqz-Sig"] = sign(key, signPath ?? `/api${path}`, ts, signBody ?? raw);
  }
  const res = await onRequest({ request: new Request(BASE + "/api" + path, { method: "POST", headers: h, body: raw }), env });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function suite(label, oldSchema) {
  console.log(`\n== ${label} ==`);
  const sqlite = makeDb(oldSchema);
  const strict = { DB: d1(sqlite), TEACHER_KEY: ADMIN, REQUIRE_SIGNED: "1" };
  const legacy = { DB: d1(sqlite), TEACHER_KEY: ADMIN };
  const K = randomBytes(32).toString("hex"), DEV = "mac-11111111-2222-3333-4444-555555555555";
  const lock = (env, o) => call(env, "/report", { device_id: o.device ?? DEV, event: "lock", quiz_id: LOCK_ID, student: "s@usc.edu" }, o);
  const pass_ = (env, o) => call(env, "/password", { url: QUIZ_URL, device_id: o.device ?? DEV }, o);
  const age = (dev, secs) => sqlite.prepare("UPDATE locks SET last_lock=? WHERE device_id=?").run(new Date(Date.now() - secs * 1000).toISOString(), dev);

  console.log("T1 the reported hole: a script with no LOCKqz fakes a lock and asks for the password");
  let r = await lock(strict, { device: "fake-device-01" });
  check("unsigned fake lock refused (401)", r.status === 401, `got ${r.status}`);
  r = await pass_(strict, { device: "fake-device-01" });
  check("unsigned password request refused, no password", r.status === 401 && !r.data?.password, `got ${r.status} ${JSON.stringify(r.data)}`);
  r = await call(strict, "/install", { device_id: "fake-device-01", student: "x@usc.edu" });
  check("unsigned /install refused", r.status === 401, `got ${r.status}`);

  console.log("T2 a real install registers its key and gets the password only while locked");
  r = await call(strict, "/register", { device_id: DEV, key: K, platform: "mac-15", version: "0.2.0", student: "s@usc.edu" });
  check("register 200", r.status === 200 && r.data?.registered, `got ${r.status}`);
  r = await pass_(strict, { key: K, device: DEV });
  check("signed password before any lock -> 403 not locked", r.status === 403 && !r.data?.password, `got ${r.status}`);
  r = await lock(strict, { key: K, device: DEV });
  check("signed lock accepted", r.status === 200, `got ${r.status} ${JSON.stringify(r.data)}`);
  r = await pass_(strict, { key: K, device: DEV });
  check("signed password while locked -> released (exactly the quiz's password; seed never sent)", r.status === 200 && r.data?.password === "LQ-SECRET01" && !("seed" in r.data), `got ${r.status} ${JSON.stringify(r.data)}`);
  const ev = sqlite.prepare("SELECT detail FROM events WHERE device_id=? AND event='password_released'").get(DEV);
  check("password release logged for the teacher", !!ev && JSON.parse(ev.detail).verified === true);

  console.log("T3 nobody else can use the real device id");
  r = await lock(strict, { device: DEV });
  check("unsigned lock claiming the device refused", r.status === 401);
  r = await pass_(strict, { key: randomBytes(32).toString("hex"), device: DEV });
  check("password signed with a wrong key refused", r.status === 401 && r.data?.why === "bad signature", JSON.stringify(r.data));
  r = await call(strict, "/register", { device_id: DEV, key: randomBytes(32).toString("hex") });
  check("re-registering the device with another key refused (409)", r.status === 409, `got ${r.status}`);
  r = await call(strict, "/register", { device_id: DEV, key: K });
  check("re-registering with the same key is harmless (200)", r.status === 200);
  r = await call(legacy, "/password", { url: QUIZ_URL, device_id: DEV });
  check("registered device cannot be impersonated unsigned, even before the strict switch", r.status === 401);

  console.log("T4 signatures are bound to time, path and body");
  r = await pass_(strict, { key: K, device: DEV, tsOffset: -900 });
  check("15-minute-old signature refused, server time returned", r.status === 401 && r.data?.why === "clock" && Number.isFinite(r.data?.server_time));
  r = await pass_(strict, { key: K, device: DEV, signPath: "/api/report" });
  check("signature made for another endpoint refused", r.status === 401 && r.data?.why === "bad signature");
  r = await pass_(strict, { key: K, device: DEV, signBody: JSON.stringify({ url: "https://other", device_id: DEV }) });
  check("tampered body refused", r.status === 401 && r.data?.why === "bad signature");
  r = await call(strict, "/report", { device_id: "someone-else-1", event: "lock", quiz_id: LOCK_ID }, { key: K, device: DEV });
  check("signed body naming another device refused", r.status === 400);

  console.log("T5 only the signed helper keeps a lock alive");
  age(DEV, 70);
  r = await call(strict, "/report", { device_id: DEV, event: "heartbeat", quiz_id: LOCK_ID, source: "agent" });
  check("unsigned agent heartbeat accepted as liveness only", r.status === 200 && r.data?.verified === false);
  r = await call(strict, "/report", { event: "heartbeat" });
  check("bare unsigned heartbeat is a harmless no-op (CI reachability check)", r.status === 200);
  r = await pass_(strict, { key: K, device: DEV });
  check("stale lock + unsigned heartbeats -> no password", r.status === 403);
  r = await call(strict, "/report", { device_id: DEV, event: "heartbeat", quiz_id: LOCK_ID, source: "helper" }, { key: K, device: DEV });
  check("signed helper heartbeat accepted", r.status === 200);
  r = await pass_(strict, { key: K, device: DEV });
  check("lock alive again after signed helper heartbeat -> password", r.status === 200 && r.data?.password === "LQ-SECRET01");
  r = await call(strict, "/report", { device_id: DEV, event: "unlock", quiz_id: LOCK_ID }, { key: K, device: DEV });
  r = await pass_(strict, { key: K, device: DEV });
  check("after unlock -> no password", r.status === 403);

  console.log("T6 the admin can revoke a device");
  r = await call(strict, "/revoke-device", { device_id: DEV }, { headers: { "X-LOCKqz-Teacher": "not-admin" } });
  check("non-admin cannot revoke", r.status === 401);
  r = await call(strict, "/revoke-device", { device_id: DEV }, { headers: { "X-LOCKqz-Teacher": ADMIN } });
  check("admin revoke 200", r.status === 200);
  r = await lock(strict, { key: K, device: DEV });
  check("revoked device's signed lock refused", r.status === 401 && r.data?.why === "revoked");

  console.log("T7 rollout: before REQUIRE_SIGNED=1, unregistered old installs keep working");
  r = await lock(legacy, { device: "old-install-01" });
  check("legacy unsigned lock accepted", r.status === 200);
  r = await pass_(legacy, { device: "old-install-01" });
  check("legacy unsigned password released", r.status === 200 && r.data?.password === "LQ-SECRET01");
  r = await pass_(strict, { device: "old-install-01" });
  check("same request refused once REQUIRE_SIGNED=1", r.status === 401);

  console.log("T8 open read endpoints unchanged");
  const res = await onRequest({ request: new Request(BASE + "/api/blocklist"), env: strict });
  check("/blocklist open", res.status === 200 && (await res.json()).domains.length >= 20);
}

console.log("T0 signing vector matches the Python and PowerShell helpers");
check("HMAC vector", sign(VECTOR.key, VECTOR.path, VECTOR.ts, VECTOR.body) === VECTOR.sig);
await suite("fresh database (schema.sql)", false);
await suite("existing database upgraded by migrate_009_device_auth.sql", true);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
