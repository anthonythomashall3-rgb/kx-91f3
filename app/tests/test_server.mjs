// LOCKqz API on a plain server (app/server): the SAME API file Cloudflare runs, behind a real listening
// HTTP server, on a real SQLite database file. Checks the database layer (same answers as Cloudflare D1's
// calls), the database set-up from schema.sql + every migrate_*.sql, the server (signed devices, student's
// address, limits, health, snapshots, restart keeps the data) and a small exam-day run.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";
import { openDb, migrate, statements, snapshot } from "../server/d1.mjs";
import { start, readEnvFile, readWranglerVars, memoryCache } from "../server/server.mjs";
import { run as load } from "../server/loadtest.mjs";
import { importDump } from "../server/import.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
const tmp = mkdtempSync(join(tmpdir(), "lqz-server-"));
const sign = (key, path, ts, body) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");

try {
  console.log("S1 database layer: the calls the API makes, with D1's answers");
  let db = openDb(":memory:");
  await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b INTEGER)");
  let r = await db.prepare("INSERT INTO t (a,b) VALUES (?,?)").bind("x", true).run();
  check("run: changes 1, last_row_id 1, success", r.meta.changes === 1 && r.meta.last_row_id === 1 && r.success === true, JSON.stringify(r));
  r = await db.prepare("INSERT INTO t (a,b) VALUES (?,?)").bind(undefined, false).run();
  check("undefined is stored as NULL, true/false as 1/0", (await db.prepare("SELECT a,b FROM t WHERE id=2").first()).a === null && (await db.prepare("SELECT b FROM t WHERE id=1").first()).b === 1);
  check("first: one row as an object; no row = null", (await db.prepare("SELECT a FROM t WHERE id=?").bind(1).first()).a === "x" && (await db.prepare("SELECT a FROM t WHERE id=?").bind(99).first()) === null);
  check("first(column): that value", (await db.prepare("SELECT a, b FROM t WHERE id=1").first("a")) === "x");
  r = await db.prepare("SELECT id FROM t ORDER BY id").all();
  check("all: results list", Array.isArray(r.results) && r.results.length === 2 && r.results[1].id === 2);
  r = await db.prepare("UPDATE t SET b=5 WHERE id>?").bind(0).run();
  check("update: changes counts the rows", r.meta.changes === 2);
  r = await db.prepare("UPDATE t SET b=6 WHERE id=1 RETURNING id, b").all();
  check("... RETURNING gives its rows", r.results.length === 1 && r.results[0].b === 6);
  const st = db.prepare("SELECT ? AS v");
  check("a prepared statement bound twice answers each binding", (await st.bind(1).first()).v === 1 && (await st.bind(2).first()).v === 2);
  r = await db.batch([db.prepare("INSERT INTO t (a) VALUES ('p')"), db.prepare("INSERT INTO t (a) VALUES ('q')")]);
  check("batch: one answer per statement", r.length === 2 && r[1].meta.changes === 1 && (await db.prepare("SELECT COUNT(*) n FROM t").first()).n === 4);
  let threw = false;
  try { await db.batch([db.prepare("INSERT INTO t (a) VALUES ('gone')"), db.prepare("INSERT INTO t (id,a) VALUES (1,'dup')")]); } catch { threw = true; }
  check("batch: one statement failing undoes the whole list", threw && (await db.prepare("SELECT COUNT(*) n FROM t WHERE a='gone'").first()).n === 0);
  check("batch: the next batch still works", (await db.batch([db.prepare("INSERT INTO t (a) VALUES ('after')")])).length === 1);
  check("an empty batch is fine", (await db.batch([])).length === 0);
  for (let i = 0; i < 600; i++) await db.prepare("SELECT " + i + " AS n").first();
  check("many different statements: still answering (statement cache turns over)", (await db.prepare("SELECT a FROM t WHERE id=1").first()).a === "x");
  db.close();

  console.log("S2 database set-up from schema.sql + migrations");
  check("a trigger stays one statement", statements("CREATE TABLE a (x);\nCREATE TRIGGER tr AFTER INSERT ON a BEGIN UPDATE a SET x=1; DELETE FROM a WHERE x=2; END;\nCREATE INDEX i ON a(x);").length === 3);
  const file = join(tmp, "lockqz.db");
  db = openDb(file);
  const first = migrate(db, CF);
  const files = readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f));
  check("every migration applied once and recorded", first.length === files.length && db.sqlite.prepare("SELECT COUNT(*) n FROM _migrations").get().n === files.length, `${first.length} of ${files.length}`);
  check("a second set-up changes nothing", migrate(db, CF).length === 0);
  // The reference: what the other suites build (schema, then each migration, statement by statement).
  const ref = new DatabaseSync(":memory:");
  ref.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
  for (const m of files.sort()) { try { ref.exec(readFileSync(join(CF, m), "utf8")); } catch { for (const s of statements(readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, ""))) { try { ref.exec(s); } catch {} } } }
  const shape = d => d.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != '_migrations' ORDER BY type, name").all().map(x => x.type + ":" + x.name).join("\n");
  const cols = d => d.prepare("SELECT m.name t, p.name c FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type='table' AND m.name != '_migrations' AND m.name NOT LIKE 'sqlite_%' ORDER BY 1,2").all().map(x => x.t + "." + x.c).join("\n");
  check("same tables, indexes and triggers as the reference", shape(db.sqlite) === shape(ref), "differs");
  check("same columns as the reference", cols(db.sqlite) === cols(ref));
  check("triggers are there", db.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger'").get().n >= 6);
  check("the file is in write-ahead mode", db.sqlite.prepare("PRAGMA journal_mode").get().journal_mode === "wal");
  db.close();

  console.log("S3 settings");
  writeFileSync(join(tmp, "lockqz.env"), "# secrets\nTEACHER_KEY=abc\nPW_PEPPER = \"p p\"\nBAD LINE\nGOOGLE_JWKS_TEST=x\nPATH=/nope\n");
  const fe = readEnvFile(join(tmp, "lockqz.env"));
  check("KEY=value lines are read, quotes removed, comments and junk skipped", fe.TEACHER_KEY === "abc" && fe.PW_PEPPER === "p p" && !("BAD" in fe));
  const wv = readWranglerVars(join(CF, "wrangler.toml"));
  check("the public settings of wrangler.toml are read", wv.ADMIN_EMAIL === "athall@usc.edu" && wv.REQUIRE_GATE === "1" && !("database_id" in wv));
  const mc = memoryCache();
  await mc.put("https://x/k", new Response("v", { headers: { "Cache-Control": "max-age=60" } }));
  check("cache: kept for max-age, gone after delete", (await (await mc.match("https://x/k")).text()) === "v" && (await mc.delete("https://x/k")) && (await mc.match("https://x/k")) === undefined);
  await mc.put("https://x/z", new Response("v", { headers: { "Cache-Control": "max-age=0" } }));
  check("cache: max-age=0 is not served", (await mc.match("https://x/z")) === undefined);

  console.log("S4 the server: real HTTP, real database file");
  const mails = [];
  const ENV = { TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", STUDENT_FEE_FROM: "", REQUIRE_GATE: "0", MAIL_SINK: async m => { mails.push(m); } };
  const data = join(tmp, "data");
  let s = await start({ port: 0, dataDir: data, envFile: join(tmp, "lockqz.env"), inheritEnv: false, env: ENV });
  const base = () => "http://127.0.0.1:" + s.port;
  const OU = "98765", QI = "12345", LOCK_ID = OU + "-" + QI, QURL = `https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${QI}&ou=${OU}`;
  s.db.sqlite.prepare("INSERT INTO quizzes (quiz_id,title,password,created_at,qi,teacher_id,lock_id,ou) VALUES (?,?,?,?,?,?,?,?)").run("q1", "Quiz 1", "LQ-SECRET01", new Date().toISOString(), QI, "t1", LOCK_ID, OU);
  const call = async (path, body, { key = null, device = null, headers = {}, method = "POST" } = {}) => {
    const raw = JSON.stringify(body ?? {}), h = { "Content-Type": "application/json", ...headers };
    if (key) { const ts = String(Math.floor(Date.now() / 1000)); h["X-LOCKqz-Device"] = device; h["X-LOCKqz-Time"] = ts; h["X-LOCKqz-Sig"] = sign(key, "/api" + path, ts, raw); }
    const res = await fetch(base() + "/api" + path, { method, headers: h, body: method === "POST" ? raw : undefined });
    let j = null; try { j = await res.json(); } catch {}
    return { status: res.status, data: j, headers: res.headers };
  };
  check("the test-only setting in the settings file is not used", !("GOOGLE_JWKS_TEST" in s.env) && !("PATH" in s.env) && s.env.PW_PEPPER === "p p");
  let v = await call("/version", null, { method: "GET" });
  check("GET /api/version answers with the release version", v.status === 200 && v.data.version === readFileSync(join(HERE, "..", "VERSION"), "utf8").trim() && v.data.strict === true, JSON.stringify(v.data));
  check("answers are JSON and may be read by the LOCKqz pages (CORS)", /json/.test(v.headers.get("content-type") || "") && !!v.headers.get("access-control-allow-origin"));
  let o = await fetch(base() + "/api/login", { method: "OPTIONS" });
  check("OPTIONS pre-check: 204", o.status === 204);
  const K = randomBytes(32).toString("hex"), DEV = "mac-11111111-2222-3333-4444-555555555555";
  let q = await call("/report", { device_id: "fake-device-01", event: "lock", quiz_id: LOCK_ID });
  check("an unsigned lock is refused (401)", q.status === 401);
  q = await call("/register", { device_id: DEV, key: K, platform: "mac-15", version: "0.6.18", student: "s@usc.edu" }, { headers: { "CF-Connecting-IP": "203.0.113.7" } });
  check("a computer registers", q.status === 200 && q.data.registered === true, JSON.stringify(q.data));
  check("the student's address as Cloudflare reports it is recorded", s.db.sqlite.prepare("SELECT reg_ip FROM devices WHERE device_id=?").get(DEV).reg_ip === "203.0.113.7");
  q = await call("/password", { url: QURL, device_id: DEV }, { key: K, device: DEV });
  check("no password before the lock (403)", q.status === 403 && !q.data?.password);
  q = await call("/report", { device_id: DEV, event: "lock", quiz_id: LOCK_ID, student: "s@usc.edu" }, { key: K, device: DEV });
  check("signed lock accepted, heartbeat pace sent", q.status === 200 && Number.isInteger(q.data.beat_s), JSON.stringify(q.data));
  q = await call("/password", { url: QURL, device_id: DEV }, { key: K, device: DEV });
  check("password released while locked", q.status === 200 && q.data.password === "LQ-SECRET01", JSON.stringify(q.data));
  q = await call("/password", { url: QURL, device_id: DEV }, { key: randomBytes(32).toString("hex"), device: DEV });
  check("a wrong key gets nothing (401 bad signature)", q.status === 401 && q.data.why === "bad signature");
  q = await call("/report", { device_id: DEV, event: "unlock", quiz_id: LOCK_ID, detail: { reason: "quiz_submitted" } }, { key: K, device: DEV });
  check("unlock accepted, lock row gone", q.status === 200 && !s.db.sqlite.prepare("SELECT 1 FROM locks WHERE device_id=?").get(DEV));
  let h = await (await fetch(base() + "/healthz")).json();
  check("/healthz: ok, counts requests and rows", h.ok === true && h.requests > 5 && h.db.written > 0, JSON.stringify(h));
  check("anything outside /api: 404", (await fetch(base() + "/etc/passwd")).status === 404);
  const big = await fetch(base() + "/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(7 * 1024 * 1024) }).then(x => x.status, () => 413);
  check("an over-size request is refused", big === 413, String(big));
  check("a request that is not JSON gets an answer, not a crash", [200, 400, 401].includes((await fetch(base() + "/api/report", { method: "POST", body: "{nope" })).status) && s.counters.errors === 0);
  const snap = s.takeSnapshot();
  const copy = new DatabaseSync(snap);
  check("a snapshot is a whole readable copy", copy.prepare("SELECT password FROM quizzes WHERE quiz_id='q1'").get().password === "LQ-SECRET01" && copy.prepare("SELECT COUNT(*) n FROM devices").get().n === 1);
  copy.close();
  for (let i = 0; i < 8; i++) s.takeSnapshot();
  check("only the newest snapshots are kept", readdirSync(join(data, "snapshots")).length === 6, String(readdirSync(join(data, "snapshots")).length));
  check("no copy of the API file is left behind", !existsSync(join(data, "run")) || readdirSync(join(data, "run")).length === 0);
  await s.close();

  console.log("S5 restart: nothing is lost, nothing is re-applied");
  s = await start({ port: 0, dataDir: data, envFile: null, inheritEnv: false, env: ENV });
  check("no database step runs again", s.applied.length === 0);
  check("the computer is still registered", s.db.sqlite.prepare("SELECT student FROM devices WHERE device_id=?").get(DEV)?.student === "s@usc.edu");
  q = await call("/report", { device_id: DEV, event: "lock", quiz_id: LOCK_ID }, { key: K, device: DEV });
  check("its key still signs", q.status === 200);
  await s.close();

  console.log("S6 the student's address when the server is not behind Cloudflare");
  s = await start({ port: 0, dataDir: join(tmp, "direct"), envFile: null, inheritEnv: false, env: { ...ENV, TRUST_PROXY: "0" } });
  q = await call("/register", { device_id: "win-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", key: K, platform: "windows", version: "0.6.18" }, { headers: { "CF-Connecting-IP": "198.51.100.9" } });
  check("a typed-in address header is not believed", q.status === 200 && s.db.sqlite.prepare("SELECT reg_ip FROM devices WHERE device_id LIKE 'win-%'").get().reg_ip === "127.0.0.1", JSON.stringify(s.db.sqlite.prepare("SELECT reg_ip FROM devices").all()));
  await s.close();

  console.log("S6b a server with no secret of its own answers nothing");
  s = await start({ port: 0, dataDir: join(tmp, "nosecret"), envFile: null, inheritEnv: false, env: { REQUIRE_SIGNED: "1" } });
  q = await call("/version", null, { method: "GET" });
  const hz = await (await fetch("http://127.0.0.1:" + s.port + "/healthz")).json();
  check("the API is closed (503 not_configured) and /healthz says so, until ROT_SECRET or TEACHER_KEY is set", q.status === 503 && q.data?.error === "not_configured" && hz.ok === true && hz.configured === false, q.status + " " + JSON.stringify(hz).slice(0, 80));
  await s.close();

  console.log("S7 moving the data: a SQL export becomes the server's database");
  const src = openDb(join(tmp, "src.db")); migrate(src, CF);
  src.sqlite.prepare("INSERT INTO devices (device_id,student,platform,version,installed_at,last_seen,student_verified) VALUES (?,?,?,?,?,?,1)").run("mac-x", "o'brien@usc.edu", "mac", "0.6.18", "2026-11-01T00:00:00Z", "2026-11-01T00:00:00Z");
  src.sqlite.prepare("INSERT INTO quizzes (quiz_id,title,password,created_at,qi,teacher_id,lock_id,ou) VALUES (?,?,?,?,?,?,?,?)").run("q9", "Line one\nline; two", "LQ-X", "2026-11-01T00:00:00Z", "1", "t1", "2-1", "2");
  // The export's shape: PRAGMA line, CREATE statements, one INSERT per row.
  const lit = v => v === null ? "NULL" : typeof v === "number" || typeof v === "bigint" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";
  let dump = "PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB);\nINSERT INTO \"sqlite_sequence\" VALUES('x',1);\n";
  const objs = src.sqlite.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END").all();
  for (const t of objs.filter(x => x.type === "table")) { dump += t.sql + ";\n";
    for (const row of src.sqlite.prepare(`SELECT * FROM "${t.name}"`).all()) dump += `INSERT INTO "${t.name}" VALUES(${Object.values(row).map(lit).join(",")});\n`; }
  for (const t of objs.filter(x => x.type !== "table")) dump += t.sql + ";\n";
  src.close();
  writeFileSync(join(tmp, "export.sql"), dump);
  const im = importDump(join(tmp, "export.sql"), join(tmp, "imported", "lockqz.db"), CF);
  const n = name => im.tables.find(t => t.table === name)?.rows;
  check("every table arrives with its rows, file intact", n("devices") === 1 && n("quizzes") === 1 && im.integrity === "ok", JSON.stringify(im.tables.filter(t => t.rows)));
  check("no database step is applied twice", im.applied.length === 0, im.applied.join(","));
  const got = openDb(join(tmp, "imported", "lockqz.db"));
  check("text with an apostrophe, a line break and a semicolon is unchanged", got.sqlite.prepare("SELECT student FROM devices").get().student === "o'brien@usc.edu" && got.sqlite.prepare("SELECT title FROM quizzes").get().title === "Line one\nline; two");
  check("triggers came along", got.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger'").get().n >= 6);
  got.close();
  let refused = false; try { importDump(join(tmp, "export.sql"), join(tmp, "imported", "lockqz.db"), CF); } catch { refused = true; }
  check("an existing database file is never written over", refused);

  console.log("S8 exam-day run: 400 students, 100 at a time, 6 heartbeats each");
  const L = await load({ students: 400, parallel: 100, beats: 6, quiet: true });
  console.log("   ", JSON.stringify({ requests: L.requests, per_second: L.per_second, ms_p95: L.ms_p95, sittings_per_hour: L.sittings_per_hour }));
  check("every student got the password", L.passwords === 400, JSON.stringify(L.failed));
  check("no request failed, no server error", Object.keys(L.failed).length === 0 && L.server_errors === 0, JSON.stringify(L.failed));
  check("every lock was released", L.locks_left === 0);
  check("faster than 50,000 exam sittings an hour on this machine", L.sittings_per_hour > 50000, String(L.sittings_per_hour));
} catch (e) { fail++; console.log("  FAIL: crashed:", e && e.stack || e); }
finally { try { rmSync(tmp, { recursive: true, force: true }); } catch {} }
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
