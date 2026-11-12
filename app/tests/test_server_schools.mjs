// Several schools on the plain server (app/server/schools.mjs): each school has its own database and
// settings; a request is handed to the right school by its Brightspace address, its computer, its
// professor sign-in or its email domain. Two schools here use the SAME course and quiz numbers.
import { readFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";
import { start } from "../server/server.mjs";
import { readSchools } from "../server/schools.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
const tmp = mkdtempSync(join(tmpdir(), "lqz-schools-"));
const sign = (key, path, ts, body) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");
const SCHOOLS = { default: "usc", schools: [
  { id: "usc", name: "USC", brightspace: ["brightspace.usc.edu", "usc.brightspace.com"], domains: ["usc.edu"] },
  { id: "state", name: "State", brightspace: ["learn.state.edu"], domains: ["state.edu"], env: { ADMIN_EMAIL: "admin@state.edu" } } ] };
const OU = "98765", QI = "12345", LOCK_ID = OU + "-" + QI;
const quizUrl = host => `https://${host}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${QI}&ou=${OU}`;

try {
  console.log("M1 the list of schools");
  const bad = c => { try { readSchools(c); return false; } catch { return true; } };
  check("a Brightspace address or email domain listed for two schools is refused", bad({ schools: [{ id: "a", brightspace: ["x.edu"] }, { id: "b", brightspace: ["x.edu"] }] }) && bad({ schools: [{ id: "a", brightspace: ["x.edu"], domains: ["d.edu"] }, { id: "b", brightspace: ["y.edu"], domains: ["d.edu"] }] }));
  check("a school with no Brightspace address, a bad id or an unknown default is refused", bad({ schools: [{ id: "a" }] }) && bad({ schools: [{ id: "../a", brightspace: ["x.edu"] }] }) && bad({ default: "z", schools: [{ id: "a", brightspace: ["x.edu"] }] }) && bad({ schools: [] }));

  const mails = [];
  const ENV = { TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", STUDENT_FEE_FROM: "", REQUIRE_GATE: "0", PAY_SECRET: "clock-secret-0123456789", MAIL_SINK: async m => { mails.push(m); } };
  const data = join(tmp, "data");
  let s = await start({ port: 0, dataDir: data, envFile: null, inheritEnv: false, env: ENV, schools: SCHOOLS });
  const dbOf = id => s.multi.schools.get(id).db.sqlite;
  const now = new Date().toISOString();
  for (const [id, pw] of [["usc", "LQ-USC-0001"], ["state", "LQ-STATE-02"]])
    dbOf(id).prepare("INSERT INTO quizzes (quiz_id,title,password,created_at,qi,teacher_id,lock_id,ou) VALUES (?,?,?,?,?,?,?,?)").run("q1", "Final", pw, now, QI, "t1", LOCK_ID, OU);
  const call = async (path, body, { key = null, device = null, headers = {}, method = "POST" } = {}) => {
    const raw = JSON.stringify(body ?? {}), h = { "Content-Type": "application/json", ...headers };
    if (key) { const ts = String(Math.floor(Date.now() / 1000)); h["X-LOCKqz-Device"] = device; h["X-LOCKqz-Time"] = ts; h["X-LOCKqz-Sig"] = sign(key, "/api" + path, ts, raw); }
    const res = await fetch("http://127.0.0.1:" + s.port + "/api" + path, { method, headers: h, body: method === "POST" ? raw : undefined });
    let j = null; try { j = await res.json(); } catch {}
    return { status: res.status, data: j, headers: res.headers };
  };
  let ipn = 0; const ip = () => ({ "CF-Connecting-IP": "203.0.113." + (++ipn) });
  const sit = async (dev, key, host, who) => {
    const c = await call("/covered", { url: quizUrl(host), device_id: dev }, { key, device: dev });
    const l = await call("/report", { device_id: dev, event: "lock", quiz_id: LOCK_ID, student: who }, { key, device: dev });
    const p = await call("/password", { url: quizUrl(host), device_id: dev }, { key, device: dev });
    return { c, l, p };
  };

  console.log("M2 two schools, the same course and quiz numbers");
  check("each school has its own database file", readdirSync(join(data, "schools")).filter(f => f.endsWith(".db")).sort().join() === "state.db,usc.db");
  const KU = randomBytes(32).toString("hex"), DU = "mac-aaaaaaaa-0000-0000-0000-000000000001";
  const KS = randomBytes(32).toString("hex"), DS = "win-bbbbbbbb-0000-0000-0000-000000000002";
  let r = await call("/register", { device_id: DU, key: KU, platform: "mac-15", version: "0.6.18", student: "amy@usc.edu" }, { headers: ip() });
  check("a USC student's computer registers at USC", r.status === 200 && !!dbOf("usc").prepare("SELECT 1 FROM devices WHERE device_id=?").get(DU) && !dbOf("state").prepare("SELECT 1 FROM devices WHERE device_id=?").get(DU));
  r = await call("/register", { device_id: DS, key: KS, platform: "windows", version: "0.6.18", student: "bo@state.edu" }, { headers: ip() });
  check("a State student's computer registers at State (by email domain)", r.status === 200 && !!dbOf("state").prepare("SELECT 1 FROM devices WHERE device_id=?").get(DS) && !dbOf("usc").prepare("SELECT 1 FROM devices WHERE device_id=?").get(DS));
  let a = await sit(DU, KU, "brightspace.usc.edu", "amy@usc.edu"), b = await sit(DS, KS, "learn.state.edu", "bo@state.edu");
  check("USC student gets USC's password", a.p.status === 200 && a.p.data.password === "LQ-USC-0001", JSON.stringify(a.p.data));
  check("State student gets State's password for the same quiz number", b.p.status === 200 && b.p.data.password === "LQ-STATE-02", JSON.stringify(b.p.data));
  check("each school holds only its own lock", dbOf("usc").prepare("SELECT COUNT(*) n FROM locks").get().n === 1 && dbOf("state").prepare("SELECT COUNT(*) n FROM locks").get().n === 1 &&
    dbOf("usc").prepare("SELECT device_id FROM locks").get().device_id === DU && dbOf("state").prepare("SELECT device_id FROM locks").get().device_id === DS);
  r = await call("/report", { device_id: DS, event: "heartbeat", quiz_id: LOCK_ID }, { key: KS, device: DS });
  check("a heartbeat (no address in it) reaches the computer's own school", r.status === 200 && r.data.verified !== false && dbOf("usc").prepare("SELECT COUNT(*) n FROM locks").get().n === 1);
  r = await call("/report", { device_id: DS, event: "unlock", quiz_id: LOCK_ID, detail: { reason: "quiz_submitted" } }, { key: KS, device: DS });
  check("unlock at State leaves USC's lock alone", r.status === 200 && dbOf("state").prepare("SELECT COUNT(*) n FROM locks").get().n === 0 && dbOf("usc").prepare("SELECT COUNT(*) n FROM locks").get().n === 1);

  console.log("M3 a school's password never goes to another school's computer");
  r = await call("/password", { url: quizUrl("learn.state.edu"), device_id: DU }, { key: KU, device: DU });
  check("USC computer locked on USC's quiz asks for State's: no password", !r.data?.password, JSON.stringify(r.data));
  r = await call("/password", { url: quizUrl("learn.state.edu"), device_id: "mac-nobody" });
  check("an unsigned request for State's password: refused", r.status === 401 && !r.data?.password);
  r = await call("/covered", { url: quizUrl("brightspace.elsewhere.edu"), device_id: DU }, { key: KU, device: DU });
  check("a Brightspace LOCKqz has no school for: not covered (other school)", r.status === 200 && r.data.covered === false && r.data.reason === "other_school", JSON.stringify(r.data));

  console.log("M4 a computer registered before LOCKqz knew its school");
  const KL = randomBytes(32).toString("hex"), DL = "mac-cccccccc-0000-0000-0000-000000000003";
  r = await call("/register", { device_id: DL, key: KL, platform: "mac-15", version: "0.6.18" }, { headers: ip() });
  check("with nothing to go by it registers at the default school", r.status === 200 && !!dbOf("usc").prepare("SELECT 1 FROM devices WHERE device_id=?").get(DL));
  r = await call("/covered", { url: quizUrl("learn.state.edu"), device_id: DL });
  check("an unsigned request naming it does not carry it over", !dbOf("state").prepare("SELECT 1 FROM devices WHERE device_id=?").get(DL));
  r = await call("/covered", { url: quizUrl("learn.state.edu"), device_id: DL }, { key: randomBytes(32).toString("hex"), device: DL });
  check("nor does a request signed with another key", !dbOf("state").prepare("SELECT 1 FROM devices WHERE device_id=?").get(DL));
  const c = await sit(DL, KL, "learn.state.edu", "cy@state.edu");
  check("its own signed request for a State quiz carries it to State, key and all", c.c.status === 200 && dbOf("state").prepare("SELECT device_key FROM devices WHERE device_id=?").get(DL)?.device_key === dbOf("usc").prepare("SELECT device_key FROM devices WHERE device_id=?").get(DL)?.device_key);
  check("and it gets State's password", c.p.status === 200 && c.p.data.password === "LQ-STATE-02", JSON.stringify(c.p.data));
  check("its lock is at State, not at USC", dbOf("state").prepare("SELECT COUNT(*) n FROM locks WHERE device_id=?").get(DL).n === 1 && dbOf("usc").prepare("SELECT COUNT(*) n FROM locks WHERE device_id=?").get(DL).n === 0);

  console.log("M5 naming the school, and each school's own settings");
  r = await call("/version", null, { method: "GET", headers: { "X-LOCKqz-School": "nowhere" } });
  check("an unknown school name: 400", r.status === 400);
  const vu = await call("/version", null, { method: "GET" }), vs = await call("/version", null, { method: "GET", headers: { "X-LOCKqz-School": "state" } });
  check("each school answers with its own settings (sign-in domain)", (vu.data.google_hd ?? "usc.edu") === "usc.edu" && (vs.data.google_hd ?? "state.edu") === "state.edu", JSON.stringify([vu.data.google_hd, vs.data.google_hd]));
  const o = await fetch("http://127.0.0.1:" + s.port + "/api/login", { method: "OPTIONS" });
  check("pages may send the school's name (CORS)", o.status === 204 && /X-LOCKqz-School/.test(o.headers.get("access-control-allow-headers") || ""));
  check("each school runs its own copy of the API (nothing kept in memory is shared)", s.multi.schools.get("usc").onRequest !== s.multi.schools.get("state").onRequest);

  console.log("M6 a professor's sign-in belongs to their school");
  s.multi.learn("teacher", "tok-state-0123456789abcdef", "state"); s.multi.learn("sync", "sync-usc-0123456789abcdef", "usc");
  check("a sign-in is found again by its token, a Sync key by its key; only hashes are stored", s.multi.known("teacher", "tok-state-0123456789abcdef") === "state" && s.multi.known("sync", "sync-usc-0123456789abcdef") === "usc" && s.multi.known("teacher", "someone-else") === null);
  const before = s.counters.bySchool.state || 0;
  r = await call("/me", null, { method: "GET", headers: { "X-LOCKqz-Teacher": "tok-state-0123456789abcdef" } });
  check("a request with that sign-in goes to State", (s.counters.bySchool.state || 0) === before + 1, JSON.stringify(s.counters.bySchool));
  r = await call("/sync", { host: "learn.state.edu", courses: [] }, { headers: { "X-LOCKqz-Sync": "sync-usc-0123456789abcdef" } });
  check("a Sync sent from State's Brightspace goes to State, where a USC key opens nothing", (s.counters.bySchool.state || 0) === before + 2 && r.status >= 400, String(r.status));

  console.log("M6b a computer stays at its school unless it moves itself");
  r = await call("/version", null, { method: "GET", headers: { "X-LOCKqz-Device": DU, "X-LOCKqz-School": "state" } });
  check("naming another school in a request that carries someone's computer id moves nothing", r.status === 200 && s.multi.known("device", DU) === "usc", String(s.multi.known("device", DU)));
  r = await call("/register", { device_id: DU, key: randomBytes(32).toString("hex"), platform: "mac-15", version: "0.6.18", student: "eve@state.edu" }, { headers: { ...ip(), "X-LOCKqz-School": "state" } });
  check("registering that id at the other school with another key moves nothing either", s.multi.known("device", DU) === "usc", r.status + " " + s.multi.known("device", DU));
  const again = await call("/report", { device_id: DU, event: "heartbeat", quiz_id: LOCK_ID }, { key: KU, device: DU });
  check("the real computer still reaches USC with its own key", again.status === 200 && again.data.verified !== false, JSON.stringify(again.data));
  const DN = "mac-eeeeeeee-0000-0000-0000-000000000009";
  r = await call("/version", null, { method: "GET", headers: { "X-LOCKqz-Device": DN, "X-LOCKqz-School": "state" } });
  check("a computer no school holds is not noted anywhere", s.multi.known("device", DN) === null, String(s.multi.known("device", DN)));

  console.log("M7 the clock, health, copies");
  r = await call("/cron", {}, { headers: { "X-LOCKqz-Pay": "clock-secret-0123456789" } });
  const clock = id => dbOf(id).prepare("SELECT COUNT(*) n FROM sync_nudges WHERE ou='clock'").get().n;
  check("one clock call runs every school's exam emails", r.status === 200 && clock("usc") >= 1 && clock("state") >= 1, `${r.status} usc ${clock("usc")} state ${clock("state")}`);
  const h = await (await fetch("http://127.0.0.1:" + s.port + "/healthz")).json();
  check("/healthz names each school", h.ok === true && h.schools?.usc?.requests > 0 && h.schools?.state?.requests > 0, JSON.stringify(h.schools));
  const snaps = s.takeSnapshot();
  check("a copy is made of every school's database", Array.isArray(snaps) && snaps.length === 2 && snaps.some(f => /state-/.test(f)) && snaps.some(f => /usc-/.test(f)));
  await s.close();

  console.log("M8 restart: computers and sign-ins are still at their schools");
  s = await start({ port: 0, dataDir: data, envFile: null, inheritEnv: false, env: ENV, schools: SCHOOLS });
  check("the directory survived", s.multi.known("device", DL) === "state" && s.multi.known("device", DU) === "usc" && s.multi.known("teacher", "tok-state-0123456789abcdef") === "state");
  r = await call("/report", { device_id: DL, event: "heartbeat", quiz_id: LOCK_ID }, { key: KL, device: DL });
  check("the carried-over computer still reaches State", r.status === 200 && r.data.verified !== false);
  await s.close();

  console.log("M9 one school listed: same answers as the one-database server");
  writeFileSync(join(tmp, "one.json"), JSON.stringify({ schools: [SCHOOLS.schools[0]] }));
  s = await start({ port: 0, dataDir: join(tmp, "one"), envFile: null, inheritEnv: false, env: ENV, schools: join(tmp, "one.json") });
  dbOf("usc").prepare("INSERT INTO quizzes (quiz_id,title,password,created_at,qi,teacher_id,lock_id,ou) VALUES (?,?,?,?,?,?,?,?)").run("q1", "Final", "LQ-ONE", now, QI, "t1", LOCK_ID, OU);
  const K1 = randomBytes(32).toString("hex"), D1 = "mac-dddddddd-0000-0000-0000-000000000004";
  await call("/register", { device_id: D1, key: K1, platform: "mac-15", version: "0.6.18" }, { headers: ip() });
  const one = await sit(D1, K1, "usc.brightspace.com", "s@gmail.com");
  check("register, covered, lock, password all as before", one.c.status === 200 && one.l.status === 200 && one.p.data?.password === "LQ-ONE", JSON.stringify(one.p.data));
  await s.close();
} catch (e) { fail++; console.log("  FAIL: crashed:", e && e.stack || e); }
finally { try { rmSync(tmp, { recursive: true, force: true }); } catch {} }
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
