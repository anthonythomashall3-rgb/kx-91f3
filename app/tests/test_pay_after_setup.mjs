// The pay page opens by itself right after setup (13 Nov 2026), instead of a pay-link email. The REAL API on an
// in-memory database:
//   P1 the app's signed status check gets pay_url (the student's own pay page) once the email is confirmed and
//      this semester's fee is unpaid; never before the email is confirmed, never once paid, never with no fee;
//   P2 that link opens that student's pay status (and nobody else's);
//   P3 the live site's settings turn the "One step left" email off (PAY_NUDGE_HOURS = 0), and with that setting an
//      unpaid install gets no such email.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-pas-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
let pass = 0, fail = 0;
const check = (m, c, info = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m, info); } };
const sign = (key, path, ts, body) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");
function d1(sqlite) { return { prepare(sql) { const st = sqlite.prepare(sql); let a = [];
  const s = { bind(...x) { a = x.map(v => v === undefined ? null : typeof v === "boolean" ? Number(v) : v); return s; },
    first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => ({ meta: { changes: Number(st.run(...a).changes) } }) };
  return s; }, async batch(sts) { for (const x of sts) await x.run(); } }; }
const BASE = "https://lockqz.test", ADMIN = "admin-test-key", OU = "98765", QI = "12345", LOCK_ID = `${OU}-${QI}`;
async function call(env, path, body, { key = null, device = null, teacher = null } = {}) {
  const raw = JSON.stringify(body ?? {}), h = { "Content-Type": "application/json" };
  if (key) { const ts = String(Math.floor(Date.now() / 1000)); h["X-LOCKqz-Device"] = device; h["X-LOCKqz-Time"] = ts; h["X-LOCKqz-Sig"] = sign(key, "/api" + path, ts, raw); }
  if (teacher) h["X-LOCKqz-Teacher"] = teacher;
  const res = await onRequest({ request: new Request(BASE + "/api" + path, { method: "POST", headers: h, body: raw }), env });
  let data = null; try { data = await res.json(); } catch {} return { status: res.status, data };
}
async function get(env, path) {
  const res = await onRequest({ request: new Request(BASE + "/api" + path, { headers: { "X-LOCKqz-Teacher": ADMIN } }), env });
  return { status: res.status, data: await res.json() };
}
function makeDb(oldSchema) {
  const sqlite = new DatabaseSync(":memory:");
  let schema = readFileSync(join(CF, "schema.sql"), "utf8");
  if (oldSchema) schema = schema.replace(/,\n  student_verified INTEGER DEFAULT 0[^\n]*/, "").replace(/\n-- One pending email code[^\n]*\nCREATE TABLE IF NOT EXISTS email_codes[^\n]*/, "");
  sqlite.exec(schema);
  for (const m of ["migrate_012_bs_code.sql", "migrate_013_sa_keep.sql", "migrate_015_student_verify.sql", "migrate_016_bs_user.sql"]) { try { sqlite.exec(readFileSync(join(CF, m), "utf8")); } catch (e) { /* already in schema.sql */ } }
  const t = new Date().toISOString();
  for (const [id, name, email, role] of [["4001", "Al Student", "al@usc.edu", "Student"], ["4002", "Bo Student", "bo@usc.edu", "Student"]])
    sqlite.prepare("INSERT INTO roster (ou,user_id,name,email,role,synced_at) VALUES (?,?,?,?,?,?)").run(OU, id, name, email, role, t);
  return sqlite;
}


const sqlite = makeDb(false), mail = [];
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort()) for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch {} }
const fee = { DB: d1(sqlite), TEACHER_KEY: ADMIN, REQUIRE_SIGNED: "1", ROT_SECRET: "rs", PAY_SECRET: "paysecret-0123456789", MAIL_SINK: m => { mail.push(m); return true; },
  STUDENT_FEE: "180", STUDENT_FEE_FROM: "2026-10-25", STUDENT_TOTAL: "200", ZELLE_TO: "(858) 900-4347", PAID_CACHE_MS: "0" };
const nofee = { ...fee, STUDENT_FEE_FROM: "" };
const reg = async dev => { const k = randomBytes(32).toString("hex"); await call(fee, "/register", { device_id: dev, key: k, platform: "mac-15" }); return k; };
const DEV = "mac-" + "a1".repeat(16), S = { key: await reg(DEV), device: DEV };

console.log("P1 the status check");
let r = await call(fee, "/verify", { op: "status" }, S);
check("before the email is confirmed: no pay link", r.status === 200 && r.data.verified === false && !("pay_url" in r.data), JSON.stringify(r.data));
await call(fee, "/verify", { op: "send", email: "al@usc.edu" }, S);
const code = (mail.at(-1)?.text.match(/\b(\d{6})\b/) || [])[1];
r = await call(fee, "/verify", { op: "code", email: "al@usc.edu", code }, S);
check("the student types the emailed code: confirmed", r.data?.verified === true, JSON.stringify(r.data));
r = await call(fee, "/verify", { op: "status" }, S);
const link = r.data?.pay_url || "";
check("confirmed and unpaid: the status check carries the student's own pay page", r.data.verified === true && r.data.paid === false && /^https:\/\/lockqz\.(com|pages\.dev|test)\/pay\?email=al%40usc\.edu&t=[0-9a-f]{32}$/.test(link), JSON.stringify(r.data));
r = await call(nofee, "/verify", { op: "status" }, S);
check("no fee in force: paid, no pay link", r.data.paid === true && !("pay_url" in r.data), JSON.stringify(r.data));

console.log("P2 the link is that student's");
const u = new URL(link), q = u.searchParams;
const st = async (email, t) => call(fee, "/pay/start", { email, t });
r = await st(q.get("email"), q.get("t"));
check("it opens al's pay page: his memo code and the amount, not paid", r.status === 200 && /^LQS/i.test(String(r.data.code || "")) && !r.data.paid, JSON.stringify(r.data).slice(0, 200));
const al = r.data;
r = await st("bo@usc.edu", q.get("t"));
check("the same key is not another student's link: for bo it gives only what a typed email gives (no owner's key, no renewal switch)", r.status === 200 && r.data?.limited === true && !("token" in r.data) && !("renew" in r.data), r.status + " " + JSON.stringify(r.data).slice(0, 120));
r = await onRequest({ request: new Request(BASE + "/api/pay/notify", { method: "POST", headers: { "Content-Type": "application/json", "X-LOCKqz-Pay": fee.PAY_SECRET }, body: JSON.stringify({ payments: [{ txn: "z1", amount: 200, payer: "Al", note: al.code, via: "zelle" }] }) }), env: fee });
r = await call(fee, "/verify", { op: "status" }, S);
check("once the payment arrived: paid, and no pay link any more", r.data.paid === true && !("pay_url" in r.data), JSON.stringify(r.data));

console.log("P3 the email is off on the live site");
const toml = readFileSync(join(CF, "wrangler.toml"), "utf8");
check("wrangler.toml sets PAY_NUDGE_HOURS = \"0\"", /^PAY_NUDGE_HOURS = "0"$/m.test(toml));
const DEV2 = "mac-" + "b2".repeat(16), S2 = { key: await reg(DEV2), device: DEV2 };
await call(fee, "/verify", { op: "send", email: "bo@usc.edu" }, S2);
await call(fee, "/verify", { op: "code", email: "bo@usc.edu", code: (mail.at(-1)?.text.match(/\b(\d{6})\b/) || [])[1] }, S2);
sqlite.prepare("UPDATE devices SET installed_at=? WHERE device_id=?").run(new Date(Date.now() - 5 * 3600000).toISOString(), DEV2);
const tick = async env => (await (await onRequest({ request: new Request(BASE + "/api/pay/tick", { method: "POST", headers: { "Content-Type": "application/json", "X-LOCKqz-Pay": fee.PAY_SECRET }, body: "{}" }), env })).json());
let n0 = mail.length; r = await tick({ ...fee, PAY_NUDGE_HOURS: "0" });
check("with that setting an unpaid install from 5 hours ago gets no 'One step left' email", mail.length === n0 && r.nudge?.why === "off", JSON.stringify(r.nudge));
r = await tick(fee);
check("(the email itself still works when it is switched on)", mail.slice(n0).some(m => m.to === "bo@usc.edu" && /One step left/.test(m.subject)), JSON.stringify(r.nudge));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
