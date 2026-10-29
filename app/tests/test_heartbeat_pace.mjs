// Free-plan scale (28 Oct 2026): the server sets the helper heartbeat (BEAT_S, default 600 s = half the old
// traffic) and the live monitor's "dark" window follows it (2 pings + 1 min). Real API, in-memory SQLite.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";
const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-beat-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
const sign = (key, path, ts, body) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch {} }
const db = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
  const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
    first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
    run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } }; return o; },
  async batch(sts) { for (const s of sts) s._run(); } };
const ADMIN = "admin-key-beat";
let env = { DB: db, TEACHER_KEY: ADMIN, REQUIRE_SIGNED: "1", LIVE_CACHE_MS: "0" };
async function call(path, body, { key = null, device = null, teacher = null, get = false } = {}) {
  const raw = JSON.stringify(body ?? {}), h = { "Content-Type": "application/json" };
  if (teacher) h["X-LOCKqz-Teacher"] = teacher;
  if (key) { const ts = String(Math.floor(Date.now() / 1000)); h["X-LOCKqz-Device"] = device; h["X-LOCKqz-Time"] = ts; h["X-LOCKqz-Sig"] = sign(key, `/api${path.split("?")[0]}`, ts, raw); }
  const res = await onRequest({ request: new Request("https://lockqz.test/api" + path, get ? { method: "GET", headers: h } : { method: "POST", headers: h, body: raw }), env });
  let data = null; try { data = await res.json(); } catch {} return { status: res.status, data };
}
sqlite.prepare("INSERT INTO quizzes (quiz_id,title,password,created_at,qi,teacher_id,lock_id,ou,gated) VALUES ('q1','Quiz','LQ-1',datetime('now'),'77','admin','300-77','300',0)").run();
const k = randomBytes(32).toString("hex"), dev = "dev-beat01";
await call("/register", { device_id: dev, key: k, student: "pat@usc.edu", platform: "mac-15" });
sqlite.prepare("UPDATE devices SET student_verified=1 WHERE device_id=?").run(dev);

console.log("B1 the server tells the helper how often to ping");
let r = await call("/report", { event: "lock", quiz_id: "300-77" }, { key: k, device: dev });
check("lock reply: beat_s = 600 (default)", r.status === 200 && r.data?.beat_s === 600, JSON.stringify(r.data));
r = await call("/report", { event: "heartbeat", quiz_id: "300-77", source: "helper" }, { key: k, device: dev });
check("helper heartbeat reply: beat_s = 600", r.data?.beat_s === 600, JSON.stringify(r.data));
r = await call("/report", { event: "heartbeat", quiz_id: "300-77", source: "agent" }, { key: k, device: dev });
check("agent heartbeat (helper unreachable): no beat_s", r.data && r.data.beat_s === undefined, JSON.stringify(r.data));
env = { ...env, BEAT_S: "300" }; r = await call("/report", { event: "heartbeat", quiz_id: "300-77", source: "helper" }, { key: k, device: dev });
check("BEAT_S=300 -> 300 (tunable without an app update)", r.data?.beat_s === 300, JSON.stringify(r.data));
env = { ...env, BEAT_S: "5" }; r = await call("/report", { event: "heartbeat", quiz_id: "300-77", source: "helper" }, { key: k, device: dev });
check("absurd BEAT_S is clamped (>= 120 s)", r.data?.beat_s === 120, JSON.stringify(r.data));
env = { ...env, BEAT_S: undefined };

console.log("B2 live monitor: 'dark' only after two missed 10-minute pings");
const at = min => new Date(Date.now() - min * 60000).toISOString();
const status = async min => { sqlite.prepare("UPDATE locks SET last_lock=?, helper_seen=? WHERE device_id=?").run(at(min), at(min), dev);
  const l = await call("/live?quiz=300-77", null, { teacher: ADMIN, get: true }); return { st: (l.data?.rows || []).find(x => x.device_id === dev)?.status, stale: l.data?.stale_ms }; };
let s = await status(15);
check("last ping 15 min ago (one missed) -> still locked, stale window 21 min", s.st === "locked" && s.stale === 1260000, JSON.stringify(s));
s = await status(22);
check("last ping 22 min ago -> dark", s.st === "dark" || s.st === "helper_killed", JSON.stringify(s));

console.log("B3 both helpers follow the server's interval");
const py = readFileSync(join(HERE, "..", "mac", "lockqzd.py"), "utf8"), ps = readFileSync(join(HERE, "..", "windows", "lockqzd.ps1"), "utf8");
check("mac: report() adopts beat_s (60-900 s) unless a test set beat_cycles", /BEAT_FROM_SERVER = "beat_cycles" not in CONF/.test(py) && /BEAT_SECS = max\(60, min\(900, j\["beat_s"\]\)\)/.test(py));
check("windows: LQ-BeatSecs clamps 60-900 and the watcher uses $script:BeatSecs (30 s while a release is pending)", /function LQ-BeatSecs/.test(ps) && /LQ-Due \$lastBeat \$now \$beatEvery/.test(ps) && /\$beatEvery = if \(\$State\.release_pending\) \{ 30 \} else \{ \$script:BeatSecs \}/.test(ps) && /\$script:BeatSecs = LQ-BeatSecs \$hr\.data \$script:BeatSecs/.test(ps));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
