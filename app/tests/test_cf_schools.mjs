// Several schools on the Cloudflare site (functions/api/_middleware.js): each school on its own database,
// a request finds its school by itself, and a site with one school is untouched.
import { DatabaseSync } from "node:sqlite";
import { createHmac, createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-cfschools-"));
writeFileSync(join(tmp, "package.json"), '{"type":"module"}');
for (const f of ["[[route]].js", "_middleware.js"]) writeFileSync(join(tmp, f), readFileSync(join(CF, "functions", "api", f)));
const { onRequest, readSchools } = await import(pathToFileURL(join(tmp, "_middleware.js")).href);
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

function makeDb() {
  const sqlite = new DatabaseSync(":memory:"); sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
  for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort()) { try { sqlite.exec(readFileSync(join(CF, m), "utf8")); } catch {} }
  const db = { sqlite, calls: 0, prepare(sql) { db.calls++; const st = sqlite.prepare(sql); let a = [];
    const o = { bind(...x) { a = x.map(v => v === undefined ? null : typeof v === "boolean" ? Number(v) : v); return o; }, first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }),
      run: async () => ({ meta: { changes: Number(st.run(...a).changes) } }), _run() { st.run(...a); } }; return o; }, async batch(sts) { for (const s of sts) s._run(); } };
  return db;
}
const usc = makeDb(), stateu = makeDb();
const SCHOOLS = JSON.stringify({ default: "usc", schools: [
  { id: "usc", name: "USC", brightspace: ["brightspace.usc.edu", "usc.brightspace.com"], domains: ["usc.edu"] },
  { id: "stateu", name: "State University", brightspace: ["learn.stateu.edu"], domains: ["stateu.edu"] },
  { id: "nodb", name: "No database yet", brightspace: ["bs.nodb.edu"], domains: ["nodb.edu"] } ] });
const base = { DB: usc, DB_STATEU: stateu, TEACHER_KEY: "admin-key-0123456789", REQUIRE_SIGNED: "1", STUDENT_FEE_FROM: "", REQUIRE_GATE: "0", LIVE_CACHE_MS: "0", PAY_SECRET: "pay-secret-0123456789" };
let ip = 0, nexts = 0;
async function call(path, { body, headers = {}, env = { ...base, SCHOOLS }, method } = {}) {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const request = new Request("https://lockqz.pages.dev/api" + path, { method: method || (raw ? "POST" : "GET"), headers: { ...(raw ? { "Content-Type": "application/json" } : {}), "CF-Connecting-IP": "10.1.0." + (++ip % 250), ...headers }, body: raw });
  const r = await onRequest({ request, env, next: async () => { nexts++; return new Response('{"next":true}', { status: 200, headers: { "Content-Type": "application/json" } }); } });
  let data = null; try { data = await r.clone().json(); } catch {}
  return { status: r.status, data };
}
const count = (db, sql, ...a) => db.sqlite.prepare(sql).get(...a).n;
const emails = db => db.sqlite.prepare("SELECT email FROM teachers ORDER BY email").all().map(r => r.email).join(",");

console.log("S1 one school: nothing changes");
const one = await call("/version", { env: base });
check("without the schools setting the request goes straight on", one.data?.next === true && nexts === 1);
const bad = await call("/version", { env: { ...base, SCHOOLS: "{ not json" } });
check("a setting that does not load stops the API with a clear answer", bad.status === 503 && /schools/.test(String(bad.data?.error)), JSON.stringify(bad));
let threw = false; try { readSchools({ schools: [{ id: "a", brightspace: ["x.edu"] }, { id: "b", brightspace: ["x.edu"] }] }); } catch { threw = true; }
check("one Brightspace address for two schools is refused", threw);

console.log("S2 professors land in their own school's database");
const pu = await call("/signup", { body: { email: "prof@usc.edu", password: "profpass1", name: "USC Prof" } });
const ps = await call("/signup", { body: { email: "prof@stateu.edu", password: "profpass1", name: "State Prof" } });
check("both sign up", pu.status === 200 && !!pu.data?.token && ps.status === 200 && !!ps.data?.token, JSON.stringify([pu, ps]).slice(0, 300));
check("USC's database holds only USC's professor", emails(usc) === "prof@usc.edu", emails(usc));
check("the new school's database holds only its professor", emails(stateu) === "prof@stateu.edu", emails(stateu));
check("sign-ins are noted as hashes only", count(usc, "SELECT COUNT(*) n FROM who WHERE kind='teacher'") === 2 && count(usc, "SELECT COUNT(*) n FROM who WHERE k=? OR k=?", pu.data.token, ps.data.token) === 0);
const me = await call("/me", { headers: { "X-LOCKqz-Teacher": ps.data.token } });
check("the new professor's sign-in finds its school by itself", me.status === 200, JSON.stringify(me).slice(0, 200));
const meU = await call("/me", { headers: { "X-LOCKqz-Teacher": pu.data.token } });
check("so does USC's", meU.status === 200);
const cross = await call("/me", { headers: { "X-LOCKqz-Teacher": ps.data.token, "X-LOCKqz-School": "usc" } });
check("a sign-in is worth nothing at another school", cross.status === 401, String(cross.status));

console.log("S3 students' computers");
const mk = () => ({ id: "mac-00000001-" + randomBytes(6).toString("hex"), key: randomBytes(32).toString("hex") });
const signed = (d, path, body, sign = true) => { const raw = JSON.stringify(body), ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", sign ? d.key : "0".repeat(64)).update(`POST\n/api${path}\n${ts}\n${createHash("sha256").update(raw).digest("hex")}`).digest("hex");
  return call(path, { body, headers: { "X-LOCKqz-Device": d.id, "X-LOCKqz-Time": ts, "X-LOCKqz-Sig": sig } }); };
const SU = "https://learn.stateu.edu/d2l/lms/quizzing/user/quiz_summary.d2l?qi=5&ou=7", has = (db, d) => count(db, "SELECT COUNT(*) n FROM devices WHERE device_id=?", d.id);
const a = mk();
const ra = await call("/register", { body: { device_id: a.id, key: a.key, platform: "mac-15", version: "0.6.22", student: "sam@stateu.edu" } });
check("a computer registering with the school's email lands in that school", ra.status === 200 && has(stateu, a) === 1 && has(usc, a) === 0, JSON.stringify(ra));
const ca = await signed(a, "/covered", { url: SU, device_id: a.id });
check("its quiz at the school's Brightspace is answered by that school", ca.status === 200 && ca.data?.reason !== "other_school", JSON.stringify(ca));
const hb = await signed(a, "/covered", { device_id: a.id, url: "" });
check("later requests find the school from the computer alone", hb.status !== 401 && hb.status !== 403, JSON.stringify(hb));
const other = await signed(a, "/covered", { url: "https://bs.elsewhere.edu/d2l/lms/quizzing/user/quiz_summary.d2l?qi=1&ou=2", device_id: a.id });
check("a quiz at a Brightspace that is no school here: other school", other.data?.reason === "other_school", JSON.stringify(other));
// a computer registered before its school was known (no email): it sits in the first school
const b = mk();
await call("/register", { body: { device_id: b.id, key: b.key, platform: "mac-15", version: "0.6.22" } });
check("a computer with no school yet sits in the first school", has(usc, b) === 1 && has(stateu, b) === 0);
const forged = await signed(b, "/covered", { url: SU, device_id: b.id }, false);
check("someone else cannot move it (no signature of its own)", has(stateu, b) === 0, JSON.stringify(forged));
const cb = await signed(b, "/covered", { url: SU, device_id: b.id });
check("its own signed request at the new school's quiz brings it along, key and all", cb.status === 200 && has(stateu, b) === 1, JSON.stringify(cb));
check("and it is noted under the new school", usc.sqlite.prepare("SELECT school FROM who WHERE kind='device' AND k=?").get(b.id)?.school === "stateu");

console.log("S4 the edges");
const unk = await call("/version", { headers: { "X-LOCKqz-School": "nowhere" } });
check("a school that is not listed: refused", unk.status === 400);
const nodb = await call("/signup", { body: { email: "prof@nodb.edu", password: "profpass1", name: "No DB" } });
check("a listed school with no database yet answers clearly", nodb.status === 503 && nodb.data?.error === "school not set up", JSON.stringify(nodb));
const u0 = usc.calls, s0 = stateu.calls;
await call("/cron", { body: {}, headers: { "X-LOCKqz-Pay": "pay-secret-0123456789" } });
check("the clock reaches every school", usc.calls > u0 && stateu.calls > s0, `${usc.calls - u0}/${stateu.calls - s0}`);
const u1 = usc.calls, s1 = stateu.calls;
await call("/cron", { body: {}, headers: { "X-LOCKqz-School": "stateu", "X-LOCKqz-Pay": "pay-secret-0123456789" } });
check("the clock can be sent to one school", stateu.calls > s1 && usc.calls - u1 <= 0, `${usc.calls - u1}/${stateu.calls - s1}`);
const w0 = count(usc, "SELECT COUNT(*) n FROM who");
await call("/me", { headers: { "X-LOCKqz-Teacher": ps.data.token } }); await signed(a, "/covered", { url: SU, device_id: a.id });
check("requests from known people write nothing new to the directory", count(usc, "SELECT COUNT(*) n FROM who") === w0);

console.log("S5 add-school.py writes a setting the site loads");
{ const { execFileSync } = await import("node:child_process");
  const toml = join(tmp, "wrangler.toml"); writeFileSync(toml, readFileSync(join(CF, "wrangler.toml")));
  const run = (...a) => { try { return { ok: true, out: execFileSync("python3", [join(CF, "add-school.py"), "--toml", toml, "--no-check", "--db-id", "11111111-2222-3333-4444-555555555555", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; } catch (e) { return { ok: false, out: String(e.stderr || e) }; } };
  const r1 = run("--name", "Université de Montréal", "--brightspace", "https://Learn.UMontreal.ca/d2l/home", "--domain", "@umontreal.ca");
  const t1 = readFileSync(toml, "utf8"), m = /^SCHOOLS = '(.*)'$/m.exec(t1);
  let cfg = null; try { cfg = readSchools(m[1]); } catch {}
  check("the school is written down", r1.ok && !!cfg && cfg.default === "usc" && cfg.byId.has("universite-de-montreal") && cfg.hosts.get("learn.umontreal.ca") === "universite-de-montreal" && cfg.hosts.get("brightspace.usc.edu") === "usc", r1.out.slice(0, 200));
  check("with its own database binding", /\[\[d1_databases\]\]\nbinding = "DB_UNIVERSITE_DE_MONTREAL"\ndatabase_name = "lockqz-universite-de-montreal"\ndatabase_id = "11111111-/.test(t1));
  check("the settings that were there stay", t1.includes('GOOGLE_HD = "usc.edu"') && t1.includes('binding = "DB"') && t1.indexOf("SCHOOLS = ") > t1.indexOf("[vars]") && t1.indexOf("SCHOOLS = ") < t1.indexOf("DB_UNIVERSITE"));
  const r2 = run("--name", "Other", "--brightspace", "learn.umontreal.ca");
  check("the same Brightspace address twice: refused, file unchanged", !r2.ok && /already listed/.test(r2.out) && readFileSync(toml, "utf8") === t1, r2.out.slice(0, 200));
  const r3 = run("--name", "State University", "--id", "stateu", "--brightspace", "learn.stateu.edu", "--domain", "stateu.edu");
  let cfg3 = null; try { cfg3 = readSchools(/^SCHOOLS = '(.*)'$/m.exec(readFileSync(toml, "utf8"))[1]); } catch {}
  check("a second school is added to the same line", r3.ok && !!cfg3 && cfg3.byId.size === 3 && (readFileSync(toml, "utf8").match(/^SCHOOLS = /gm) || []).length === 1, r3.out.slice(0, 200));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
