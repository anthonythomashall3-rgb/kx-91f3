#!/usr/bin/env node
// Exam-day load on the plain server: N students each sit one exam (register, is-this-quiz-covered, lock,
// password, heartbeats, unlock) against a real listening server and a real database file.
//   node loadtest.mjs [students=2000] [parallel=200] [heartbeats=6]
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { start } from "./server.mjs";

const sign = (key, path, ts, body) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");

export async function run({ students = 2000, parallel = 200, beats = 6, quiet = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lqz-load-"));
  const s = await start({ port: 0, dataDir: dir, envFile: null, inheritEnv: false,
    env: { TEACHER_KEY: "load-key", REQUIRE_SIGNED: "1", STUDENT_FEE_FROM: "", REQUIRE_GATE: "0", MAIL_SINK: async () => {}, BEAT_S: "600" } });
  const now = new Date().toISOString(), OU = "98765", QI = "12345", LOCK_ID = OU + "-" + QI;
  const URL_ = `https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${QI}&ou=${OU}`;
  s.db.sqlite.prepare("INSERT INTO quizzes (quiz_id,title,password,created_at,qi,teacher_id,lock_id,ou) VALUES (?,?,?,?,?,?,?,?)").run("q1", "Final", "LQ-SECRET01", now, QI, "t1", LOCK_ID, OU);
  const agent = new http.Agent({ keepAlive: true, maxSockets: parallel });
  const times = [], bad = {}; let sent = 0;
  const post = (path, body, dev, key, ip) => new Promise(done => {
    const raw = JSON.stringify(body), h = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw) };
    if (ip) h["CF-Connecting-IP"] = ip;   // each student comes from their own address, as Cloudflare reports it
    if (key) { const ts = String(Math.floor(Date.now() / 1000)); h["X-LOCKqz-Device"] = dev; h["X-LOCKqz-Time"] = ts; h["X-LOCKqz-Sig"] = sign(key, "/api" + path, ts, raw); }
    const t0 = process.hrtime.bigint(); sent++;
    const rq = http.request({ host: "127.0.0.1", port: s.port, path: "/api" + path, method: "POST", headers: h, agent }, rs => {
      const ch = []; rs.on("data", c => ch.push(c)); rs.on("end", () => { times.push(Number(process.hrtime.bigint() - t0) / 1e6); let j = null; try { j = JSON.parse(Buffer.concat(ch)); } catch {} done({ status: rs.statusCode, data: j }); });
    });
    rq.on("error", () => done({ status: 0, data: null })); rq.end(raw);
  });
  const want = (r, path, ok = r.status === 200) => { if (!ok) bad[path + " " + r.status] = (bad[path + " " + r.status] || 0) + 1; return ok; };
  let got = 0;
  async function sitting(i) {
    const dev = "mac-" + String(i).padStart(8, "0") + "-" + randomBytes(12).toString("hex"), key = randomBytes(32).toString("hex"), who = `s${i}@usc.edu`;
    const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
    want(await post("/register", { device_id: dev, key, platform: "mac-15", version: "0.6.18", student: who }, null, null, ip), "/register");
    want(await post("/covered", { url: URL_, device_id: dev }, dev, key, ip), "/covered");
    want(await post("/report", { device_id: dev, event: "lock", quiz_id: LOCK_ID, student: who }, dev, key, ip), "/report lock");
    const p = await post("/password", { url: URL_, device_id: dev }, dev, key, ip);
    if (want(p, "/password", p.status === 200 && p.data?.password === "LQ-SECRET01")) got++;
    for (let b = 0; b < beats; b++) want(await post("/report", { device_id: dev, event: "heartbeat", quiz_id: LOCK_ID, student: who }, dev, key, ip), "/report heartbeat");
    want(await post("/report", { device_id: dev, event: "unlock", quiz_id: LOCK_ID, student: who, detail: { reason: "quiz_submitted" } }, dev, key, ip), "/report unlock");
  }
  const t0 = Date.now(); let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallel, students) }, async () => { while (next < students) await sitting(next++); }));
  const secs = (Date.now() - t0) / 1000;
  times.sort((a, b) => a - b);
  const pct = q => times[Math.min(times.length - 1, Math.floor(times.length * q))];
  const out = { students, passwords: got, requests: sent, seconds: +secs.toFixed(2), per_second: Math.round(sent / secs), sittings_per_hour: Math.round(students / secs * 3600),
    ms_p50: +pct(0.5).toFixed(1), ms_p95: +pct(0.95).toFixed(1), ms_p99: +pct(0.99).toFixed(1), failed: bad, server_errors: s.counters.errors,
    rows_written: s.db.stats.written, locks_left: s.db.sqlite.prepare("SELECT COUNT(*) n FROM locks").get().n };
  agent.destroy(); await s.close(); rmSync(dir, { recursive: true, force: true });
  if (!quiet) console.log(JSON.stringify(out, null, 2));
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [n, p, b] = process.argv.slice(2).map(Number);
  await run({ students: n || 2000, parallel: p || 200, beats: Number.isFinite(b) ? b : 6 });
}
