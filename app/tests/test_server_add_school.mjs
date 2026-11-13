// Plain server: a school is added while the server runs. add-school.mjs writes the school down, a reload
// replaces the server processes one at a time, and the new school answers on its own database.
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";
import { openDb } from "../server/d1.mjs";
import { addSchool, idFrom, hostOnly } from "../server/add-school.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
const tmp = mkdtempSync(join(tmpdir(), "lqz-addschool-")), data = join(tmp, "data");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const refuses = async (o, re) => { try { await addSchool({ dataDir: join(tmp, "unit"), check: false, ...o }); return false; } catch (e) { return re.test(e.message); } };
let child = null;
try {
  console.log("A1 what add-school accepts");
  check("an id is made from the name", idFrom("Université de Montréal (UdeM)") === "universite-de-montreal-udem" && idFrom("State University") === "state-university");
  check("an address is reduced to its host", hostOnly("https://Learn.StateU.edu/d2l/home") === "learn.stateu.edu" && hostOnly("not a host") === "");
  check("no name: refused", await refuses({ brightspace: ["learn.stateu.edu"] }, /name/));
  check("no Brightspace address: refused", await refuses({ name: "State U" }, /Brightspace address/));
  check("a bad email domain: refused", await refuses({ name: "State U", brightspace: ["learn.stateu.edu"], domains: ["stateu"] }, /--domain/));
  const bsYes = async () => new Response(JSON.stringify([{ ProductCode: "lp", LatestVersion: "1.64" }])), bsNo = async () => new Response("<html>", { status: 200 });
  check("an address that is not a Brightspace: refused", await refuses({ name: "State U", brightspace: ["www.example.org"], check: true, fetcher: bsNo }, /does not answer as a Brightspace/));
  const u1 = await addSchool({ dataDir: join(tmp, "unit"), name: "State University", brightspace: ["learn.stateu.edu"], domains: ["@StateU.edu"], check: true, fetcher: bsYes });
  const unit = JSON.parse(readFileSync(u1.file, "utf8"));
  check("the first school added also writes down the school the server already had", unit.default === "usc" && unit.schools.length === 2 && unit.schools[0].brightspace.includes("brightspace.usc.edu") && unit.schools[1].id === "state-university" && unit.schools[1].domains[0] === "stateu.edu");
  check("the same Brightspace address twice: refused", await refuses({ name: "Other", brightspace: ["learn.stateu.edu"] }, /two schools/));
  check("the same email domain twice: refused", await refuses({ name: "Other", brightspace: ["other.brightspace.com"], domains: ["usc.edu"] }, /two schools/));
  check("the same id twice: refused", await refuses({ id: "usc", name: "Other", brightspace: ["other.brightspace.com"] }, /repeated id/));
  check("a refused school leaves the file as it was", readFileSync(u1.file, "utf8") === JSON.stringify(unit, null, 2) + "\n");

  console.log("A2 a server with one school, two server processes");
  const port = await freePort(), out = [];
  const req = (method, path, body, headers = {}) => new Promise(done => {
    const raw = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port, path, method, agent: false, headers: { ...(raw ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw) } : {}), ...headers } }, rs => {
      const ch = []; rs.on("data", c => ch.push(c)); rs.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(ch)); } catch {} done({ status: rs.statusCode, data: j }); }); });
    r.setTimeout(8000, () => r.destroy(new Error("no answer"))); r.on("error", () => done({ status: 0, data: null })); r.end(raw || undefined);
  });
  child = spawn(process.execPath, ["--no-warnings", join(HERE, "..", "server", "server.mjs")], { stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, WORKERS: "2", PORT: String(port), LOCKQZ_DATA: data, TEACHER_KEY: "admin-key-0123456789", REQUIRE_SIGNED: "1", STUDENT_FEE_FROM: "", REQUIRE_GATE: "0", MAIL_USER: "", MAIL_APP_PASSWORD: "" } });
  child.stdout.on("data", d => out.push(String(d))); child.stderr.on("data", d => out.push(String(d)));
  let up = false; for (let i = 0; i < 100 && !up; i++) { await sleep(150); up = (await req("GET", "/healthz")).status === 200; }
  check("the server answers", up, out.join("").slice(-400));
  const pidsNow = async n => { const p = new Set(); for (const t0 = Date.now(); p.size < n && Date.now() - t0 < 30000;) { const h = await req("GET", "/healthz"); if (h.data?.pid) p.add(h.data.pid); else await sleep(100); } return p; };
  const before = await pidsNow(2);
  const usc = await req("POST", "/api/signup", { email: "prof@usc.edu", password: "profpass1", name: "USC Prof" }, { "CF-Connecting-IP": "10.9.0.1" });
  check("a USC professor signs up", usc.status === 200 && !!usc.data?.token, JSON.stringify(usc));
  const SU = "https://learn.stateu.edu/d2l/lms/quizzing/user/quiz_summary.d2l?qi=5&ou=7";
  // a student's computer (registered, signs its requests)
  const dev = "mac-00000001-" + randomBytes(6).toString("hex"), key = randomBytes(32).toString("hex");
  const sign = (path, ts, body) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");
  const covered = () => { const body = { url: SU, device_id: dev }, ts = String(Math.floor(Date.now() / 1000));
    return req("POST", "/api/covered", body, { "X-LOCKqz-Device": dev, "X-LOCKqz-Time": ts, "X-LOCKqz-Sig": sign("/api/covered", ts, JSON.stringify(body)), "CF-Connecting-IP": "10.9.0.2" }); };
  const reg = await req("POST", "/api/register", { device_id: dev, key, platform: "mac-15", version: "0.6.22", student: "sam@stateu.edu" }, { "CF-Connecting-IP": "10.9.0.2" });
  check("a student's computer registers", reg.status === 200, JSON.stringify(reg));
  const c0 = await covered();
  check("a quiz at another school's Brightspace: not a school here yet", c0.data?.reason === "other_school", JSON.stringify(c0));

  console.log("A3 the school is added and the server reloads while students keep asking");
  const added = await addSchool({ dataDir: data, name: "State University", id: "stateu", brightspace: ["learn.stateu.edu"], domains: ["stateu.edu"], check: false });
  check("add-school wrote the school down", added.schools === 2 && existsSync(join(data, "schools.json")));
  let asked = 0, lost = 0, stop = false;
  const asking = (async () => { while (!stop) { const r = await req("GET", "/api/health"); asked++; if (r.status === 0 || r.status >= 500) lost++; } })();
  child.kill("SIGHUP");
  let done = false; for (let i = 0; i < 400 && !done; i++) { await sleep(150); done = /reload: done/.test(out.join("")); }
  await sleep(300); stop = true; await asking;
  check("the reload finished", done, out.join("").slice(-500));
  check(`no request was lost during it (${asked} asked)`, asked > 20 && lost === 0, `${lost} of ${asked}`);
  const after = await pidsNow(2);
  check("both server processes were replaced", after.size === 2 && [...after].every(p => !before.has(p)), [...before] + " -> " + [...after]);
  check("the school the server had is now school usc, with its data", existsSync(join(data, "schools", "usc.db")) && !existsSync(join(data, "lockqz.db")));

  console.log("A4 each school on its own database");
  const me = await req("GET", "/api/me", undefined, { "X-LOCKqz-Teacher": usc.data.token });
  check("the USC professor is still signed in", me.status === 200, JSON.stringify(me).slice(0, 200));
  const su = await req("POST", "/api/signup", { email: "prof@stateu.edu", password: "profpass1", name: "State Prof" }, { "CF-Connecting-IP": "10.9.0.3" });
  check("a professor of the new school signs up", su.status === 200 && !!su.data?.token, JSON.stringify(su).slice(0, 300));
  const c1 = await covered();
  check("a quiz at the new school's Brightspace is answered by that school", c1.status === 200 && c1.data?.reason !== "other_school", JSON.stringify(c1));
  const emails = id => { const d = openDb(join(data, "schools", id + ".db")); try { return d.sqlite.prepare("SELECT email FROM teachers ORDER BY email").all().map(r => r.email).join(","); } finally { d.close(); } };
  check("USC's database holds only USC's professor", emails("usc") === "prof@usc.edu", emails("usc"));
  check("the new school's database holds only its professor", emails("stateu") === "prof@stateu.edu", emails("stateu"));
  const devs = id => { const d = openDb(join(data, "schools", id + ".db")); try { return d.sqlite.prepare("SELECT COUNT(*) n FROM devices WHERE device_id=?").get(dev).n; } finally { d.close(); } };
  check("the student's computer came along to the new school on its own signature", devs("stateu") === 1, devs("usc") + "/" + devs("stateu"));
  const me2 = await req("GET", "/api/me", undefined, { "X-LOCKqz-Teacher": su.data?.token || "x" });
  check("the new professor's sign-in finds its school by itself", me2.status === 200, JSON.stringify(me2).slice(0, 200));

  console.log("A5 a school file that does not load never stops the running server");
  const good = readFileSync(join(data, "schools.json"), "utf8");
  (await import("node:fs")).writeFileSync(join(data, "schools.json"), "{ not json");
  child.kill("SIGHUP");
  let said = false; for (let i = 0; i < 100 && !said; i++) { await sleep(100); said = /reload: not done/.test(out.join("")); }
  check("the reload is refused", said, out.join("").slice(-300));
  check("the same processes keep answering", [...await pidsNow(2)].every(p => after.has(p)) && (await req("GET", "/api/me", undefined, { "X-LOCKqz-Teacher": su.data?.token || "x" })).status === 200);
  (await import("node:fs")).writeFileSync(join(data, "schools.json"), good);
} catch (e) { fail++; console.log("  FAIL: crashed:", e.stack || e); }
finally { if (child) { child.kill("SIGTERM"); await sleep(400); try { child.kill("SIGKILL"); } catch {} } try { rmSync(tmp, { recursive: true, force: true }); } catch {} }
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
