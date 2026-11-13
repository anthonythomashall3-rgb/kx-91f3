// Plain server on every processor: WORKERS=3 runs three server processes that share one port and one
// database file. Started here the way the machine starts it (node server.mjs), then used over real HTTP.
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";
import { openDb } from "../server/d1.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
const tmp = mkdtempSync(join(tmpdir(), "lqz-workers-"));
const sign = (key, path, ts, body) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
let child = null;
try {
  const port = await freePort();
  // one request per connection, so the processes take turns
  const req = (method, path, body, headers = {}) => new Promise(done => {
    const raw = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port, path, method, agent: false, headers: { ...(raw ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw) } : {}), ...headers } }, rs => {
      const ch = []; rs.on("data", c => ch.push(c)); rs.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(ch)); } catch {} done({ status: rs.statusCode, data: j }); }); });
    r.setTimeout(4000, () => r.destroy(new Error("no answer")));   // a request caught in a process as it dies is not waited for
    r.on("error", () => done({ status: 0, data: null })); r.end(raw || undefined);
  });
  const signed = (path, body, dev, key, ip) => { const raw = JSON.stringify(body), ts = String(Math.floor(Date.now() / 1000));
    return req("POST", "/api" + path, body, { "X-LOCKqz-Device": dev, "X-LOCKqz-Time": ts, "X-LOCKqz-Sig": sign(key, "/api" + path, ts, raw), "CF-Connecting-IP": ip }); };

  console.log("W1 three server processes, one port, one database");
  const out = [];
  child = spawn(process.execPath, ["--no-warnings", join(HERE, "..", "server", "server.mjs")], { stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, WORKERS: "3", PORT: String(port), LOCKQZ_DATA: join(tmp, "data"), TEACHER_KEY: "admin-key-0123456789", REQUIRE_SIGNED: "1", STUDENT_FEE_FROM: "", REQUIRE_GATE: "0", MAIL_USER: "", MAIL_APP_PASSWORD: "" } });
  child.stdout.on("data", d => out.push(String(d))); child.stderr.on("data", d => out.push(String(d)));
  let up = false; for (let i = 0; i < 100 && !up; i++) { await sleep(150); up = (await req("GET", "/healthz")).status === 200; }
  check("the server answers", up, out.join("").slice(-400));
  // the processes come up one after another: keep asking (up to 30 s) until all three have answered
  const pids = new Set(); for (const t0 = Date.now(); pids.size < 3 && Date.now() - t0 < 30000;) { const h = await req("GET", "/healthz"); if (h.data?.pid) pids.add(h.data.pid); else await sleep(100); }
  check("three different processes answer on the one port", pids.size === 3, [...pids].join(","));
  check("the database was set up once, before they started", /starting 3 server processes, applied \d+ database steps/.test(out.join("")), out.join("").slice(0, 300));

  // The exam is put in through another connection to the same file (as an import or a copy tool would).
  const OU = "98765", QI = "12345", LOCK_ID = OU + "-" + QI, URL_ = `https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${QI}&ou=${OU}`;
  const side = openDb(join(tmp, "data", "lockqz.db"));
  side.sqlite.prepare("INSERT INTO quizzes (quiz_id,title,password,created_at,qi,teacher_id,lock_id,ou) VALUES (?,?,?,?,?,?,?,?)").run("q1", "Final", "LQ-SECRET01", new Date().toISOString(), QI, "t1", LOCK_ID, OU);

  console.log("W2 150 students sit the exam at once, every step on whichever process is free");
  let got = 0; const bad = {};
  const want = (r, what, ok = r.status === 200) => { if (!ok) bad[what + " " + r.status] = (bad[what + " " + r.status] || 0) + 1; return ok; };
  await Promise.all(Array.from({ length: 150 }, async (_, i) => {
    const dev = "mac-" + String(i).padStart(8, "0") + "-" + randomBytes(6).toString("hex"), key = randomBytes(32).toString("hex"), ip = `10.1.${i >> 8}.${i & 255}`, who = `s${i}@usc.edu`;
    want(await req("POST", "/api/register", { device_id: dev, key, platform: "mac-15", version: "0.6.18", student: who }, { "CF-Connecting-IP": ip }), "/register");
    want(await signed("/covered", { url: URL_, device_id: dev }, dev, key, ip), "/covered");
    want(await signed("/report", { device_id: dev, event: "lock", quiz_id: LOCK_ID, student: who }, dev, key, ip), "lock");
    const p = await signed("/password", { url: URL_, device_id: dev }, dev, key, ip);
    if (want(p, "/password", p.status === 200 && p.data?.password === "LQ-SECRET01")) got++;
    for (let b = 0; b < 3; b++) want(await signed("/report", { device_id: dev, event: "heartbeat", quiz_id: LOCK_ID, student: who }, dev, key, ip), "heartbeat");
    want(await signed("/report", { device_id: dev, event: "unlock", quiz_id: LOCK_ID, student: who, detail: { reason: "quiz_submitted" } }, dev, key, ip), "unlock");
  }));
  check("every student got the password", got === 150, JSON.stringify(bad));
  check("no step failed (a lock made on one process is seen by the others at once)", Object.keys(bad).length === 0, JSON.stringify(bad));
  check("the one database holds all 150 computers and no lock is left", side.sqlite.prepare("SELECT COUNT(*) n FROM devices").get().n === 150 && side.sqlite.prepare("SELECT COUNT(*) n FROM locks").get().n === 0);
  check("the file is intact", side.sqlite.prepare("PRAGMA integrity_check").get().integrity_check === "ok");
  side.close();

  console.log("W3 a server process that dies is started again; the others keep answering");
  const victim = [...pids][1];
  process.kill(victim, "SIGKILL");
  let okDuring = 0; for (let i = 0; i < 10; i++) { if ((await req("GET", "/api/version")).status === 200) okDuring++; await sleep(30); }
  check("requests are still answered right after", okDuring >= 9, String(okDuring));
  const after = new Set(); for (let i = 0; i < 120 && after.size < 3; i++) { await sleep(60); const h = await req("GET", "/healthz"); if (h.data?.pid && h.data.pid !== victim) after.add(h.data.pid); }
  check("three processes are answering again, one of them new", after.size === 3 && [...after].some(p => !pids.has(p)), [...after].join(","));

  console.log("W4 stopping");
  const closed = new Promise(r => child.once("exit", r));
  child.kill("SIGTERM");
  await Promise.race([closed, sleep(8000)]);
  check("the server and all its processes stop", child.exitCode !== null || child.signalCode !== null);
  await sleep(300);
  check("nothing answers on the port any more", (await req("GET", "/healthz")).status === 0);
} catch (e) { fail++; console.log("  FAIL: crashed:", e && e.stack || e); }
finally { try { if (child && child.exitCode === null) child.kill("SIGKILL"); } catch {} try { rmSync(tmp, { recursive: true, force: true }); } catch {} }
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
