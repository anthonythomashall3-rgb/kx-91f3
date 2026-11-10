import { withPayT } from "./pay_t.mjs";
// Bug sweep 7 (10 Nov 2026), real API on in-memory SQLite:
//   S1 the apps' "pay for LOCKqz" message names every way at its own price ($200 Zelle / $210 card or Venmo),
//      never the $180 base; apps before 0.6.12 get the prices in their old "Pay $<amount>" sentence.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-sweep7-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
function d1(sqlite) {
  const mk = sql => { const st = sqlite.prepare(sql); let args = [];
    const s = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return s; },
      first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
      run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } };
    return s; };
  return { prepare: mk, async batch(sts) { sqlite.exec("BEGIN"); try { for (const s of sts) s._run(); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; } return []; } };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch {} }
const MAILS = [];
// Production's prices and ways (wrangler.toml), fee on.
const env = { DB: d1(sqlite), TEACHER_KEY: "admin-key-s7", REQUIRE_SIGNED: "1", ADMIN_EMAIL: "admin@usc.edu", ROT_SECRET: "rot-s7", LIVE_CACHE_MS: "0", PAID_CACHE_MS: "0",
  PAY_SECRET: "pay-secret-s7-0123456789", MAIL_SINK: async m => { MAILS.push(m); return true; },
  STUDENT_FEE: "180", STUDENT_FEE_FROM: "2000-01-01", STUDENT_TOTAL: "200", STUDENT_OTHER_TOTAL: "210", STUDENT_OTHER_PRICE: "210", STUDENT_CARD_PRICE: "210",
  PROF_TOTAL: "6500", PROF_CARD_TOTAL: "6500", PROF_ZELLE_TOTAL: "6300", PROF_BANK_TOTAL: "6500", ZELLE_TO: "(858) 900-4347", VENMO_HANDLE: "LOCKqz",
  STUDENT_VENMO: "1", STRIPE_SECRET_KEY: "sk_test_s7", STRIPE_WEBHOOK_SECRET: "whsec_s7", INVOICE_EMAIL: "support@lockqz.com" };
const sign = (key, path, ts, raw) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(raw).digest("hex")}`).digest("hex");
async function call(path, body, { teacher = null, dev = null, get = false, ip = "10.0.7.9", envx = {} } = {}) {
  body = withPayT(path, body, env);
  const raw = JSON.stringify(body ?? {});
  const h = { "Content-Type": "application/json", "CF-Connecting-IP": ip };
  if (teacher) h["X-LOCKqz-Teacher"] = teacher;
  if (dev) { const ts = String(Math.floor(Date.now() / 1000)); h["X-LOCKqz-Device"] = dev.id; h["X-LOCKqz-Time"] = ts; h["X-LOCKqz-Sig"] = sign(dev.key, "/api" + path.replace(/\?.*/, ""), ts, raw); }
  const res = await onRequest({ request: new Request("https://lockqz.test/api" + path, { method: get ? "GET" : "POST", headers: h, body: get ? undefined : raw }), env: { ...env, ...envx } });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const ADMIN = (await call("/signup", { email: "admin@usc.edu", password: "adminpass1", name: "Anthony Hall" })).data?.token;
const roster = [{ id: "8001", name: "Pat Prof", email: "p@usc.edu", role: "Instructor" }, ...[0, 1].map(i => ({ id: String(9100 + i), name: "Stu " + i, email: `s${i}@usc.edu`, role: "Student" }))];
await call("/sync", { courses: [{ ou: "500", name: "ECON 203", classlist: roster, quizzes: [] }] }, { teacher: ADMIN });
const code = (await call("/invite", { email: "p@usc.edu", until: "2099-12-31" }, { teacher: ADMIN })).data?.code;
const P = (await call("/signup", { email: "p@usc.edu", password: "profpass12", name: "Pat Prof", invite: code })).data?.token;
await call("/sync", { whoami: { id: "8001" }, courses: [{ ou: "500", name: "ECON 203", classlist: roster, quizzes: [{ qi: "1", name: "Q1", active: true }] }] }, { teacher: P });
let ipN = 0;
async function device(id, email, version, platform = "mac") {
  const d = { id, key: randomBytes(32).toString("hex") };
  await call("/register", { device_id: id, key: d.key, platform, version }, { ip: "10.9.7." + (++ipN) });
  await call("/report", { event: "install", platform, version }, { dev: d });
  const k = MAILS.length; await call("/verify", { op: "send", email }, { dev: d }); const m = MAILS.slice(k).find(x => x.to === email);
  if (m) await call("/verify", { op: "code", email, code: m.code }, { dev: d });
  return d;
}
const URL_Q = "https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=1&ou=500";
const pw = async d => { await call("/report", { event: "lock", quiz_id: "500-1" }, { dev: d }); return call("/password", { url: URL_Q, device_id: d.id }, { dev: d }); };

console.log("S1 the apps' unpaid message names every way at its own price");
check("set-up: the class is protected", !!sqlite.prepare("SELECT 1 FROM quizzes WHERE ou='500' AND qi='1'").get());
const OLD = await device("mac-s7-old", "s0@usc.edu", "0.6.11"), NEW = await device("mac-s7-new", "s1@usc.edu", "0.6.12");
const LINE = "$200 by Zelle, or $210 by card or Venmo";
const o = await pw(OLD), n = await pw(NEW);
check("unpaid: 402 with the pay block", o.status === 402 && o.data?.reason === "unpaid" && !!o.data?.pay && n.status === 402 && !!n.data?.pay, `${o.status} ${n.status} ${JSON.stringify(o.data)}`);
check("pay.line = every way at its own price", o.data?.pay?.line === LINE && n.data?.pay?.line === LINE, JSON.stringify([o.data?.pay?.line, n.data?.pay?.line]));
check("app 0.6.11's own sentence now reads 'Pay $200 by Zelle, or $210 by card or Venmo for LOCKqz this semester' (was 'Pay $180')",
  `Pay $${o.data?.pay?.amount} for LOCKqz this semester` === `Pay ${LINE} for LOCKqz this semester`, String(o.data?.pay?.amount));
check("app 0.6.12+: amount stays the number (it reads line)", n.data?.pay?.amount === 180, String(n.data?.pay?.amount));
const ps = await call("/pay/start", { email: "s1@usc.edu" });
check("the pay page's own answer is unchanged (amount is a number)", typeof ps.data?.amount === "number", JSON.stringify(ps.data)?.slice(0, 200));
const co = await call("/report", { event: "lock", quiz_id: "500-1" }, { dev: NEW }).then(() => call("/password", { url: URL_Q, device_id: NEW.id }, { dev: NEW, envx: { STUDENT_CARD_ONLY: "1" } }));
check("card-only mode: only the card, no Zelle / Venmo handle (so no memo)", co.data?.pay?.line === "$210 by card" && !co.data?.pay?.zelle && !co.data?.pay?.venmo, JSON.stringify(co.data?.pay));

console.log("S3 an exam the dashboard shows as 'Not protected' gives AI back (and asks no fee); one not synced yet waits");
{
  const U = qi => `https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${qi}&ou=500`;
  const ask = async (d, qi) => { await call("/report", { event: "lock", quiz_id: "500-" + qi }, { dev: d }); return call("/password", { url: U(qi), device_id: d.id }, { dev: d }); };
  sqlite.prepare("INSERT INTO bs_quizzes (ou,qi,name,active,start_date,end_date,synced_at) VALUES ('500','2','Practice (AI allowed)',1,NULL,NULL,?)").run(new Date().toISOString());
  const np = await ask(NEW, "2");
  check("synced, no LOCKqz password: 200 not_protected (the app gives AI back), not 'unpaid'", np.status === 200 && np.data?.reason === "not_protected" && !np.data?.pay, `${np.status} ${JSON.stringify(np.data)}`);
  const un = await ask(NEW, "3");
  check("not synced yet (newer than the last Sync): no release, the usual answer (here: pay first)", un.status === 402 && un.data?.reason === "unpaid", `${un.status} ${JSON.stringify(un.data)}`);
  sqlite.prepare("INSERT INTO pending_clear (ou,qi,password) VALUES ('500','2','LQ-oldpass1')").run();
  const pc = await ask(NEW, "2");
  check("turned off moments ago (its password still in Brightspace): still protected until the Sync takes it out", pc.status === 402 && pc.data?.reason === "unpaid", `${pc.status} ${JSON.stringify(pc.data)}`);
  sqlite.prepare("DELETE FROM pending_clear WHERE ou='500' AND qi='2'").run();
  const pr = await ask(NEW, "1");
  check("a protected exam is unchanged (pay first)", pr.status === 402 && pr.data?.reason === "unpaid", `${pr.status}`);
}

console.log("S4 the admin's Forget deletes everything kept for the email (as the privacy page says), the saved card included");
{
  const E = "s0@usc.edu", t = new Date().toISOString(), calls = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => { if (String(u).startsWith("https://api.stripe.com/")) { calls.push(String(u)); return new Response("{}", { status: 200 }); } return realFetch(u, o); };
  sqlite.prepare("INSERT INTO card_renew (email,customer,pm,brand,last4,autorenew,created_at) VALUES (?,?,?,?,?,1,?)").run(E, "cus_s7", "pm_s7", "visa", "4242", t);
  sqlite.prepare("INSERT INTO renew_sent (email,term,at) VALUES (?,?,?)").run(E, "Spring 2027", t);
  sqlite.prepare("INSERT INTO renew_optout (email,at) VALUES (?,?)").run(E, t);
  sqlite.prepare("INSERT INTO pay_nudge (email,at) VALUES (?,?)").run(E, t);
  sqlite.prepare("INSERT INTO assist (ou,email,tools,at) VALUES ('500',?,'[\"readwrite\"]',?)").run(E, t);
  sqlite.prepare("INSERT INTO letin (ou,qi,email,at) VALUES ('500','1',?,?)").run(E, t);
  sqlite.prepare("INSERT INTO gsign (n,device_id,at,email,done) VALUES ('n-s7','mac-s7-old',?,?,1)").run(t, E);
  const f = await call("/forget", { email: E }, { teacher: ADMIN });
  const left = ["card_renew", "renew_sent", "renew_optout", "pay_nudge", "assist", "letin", "gsign", "devices", "roster", "pay_codes_students"]
    .filter(tb => sqlite.prepare(`SELECT 1 FROM ${tb} WHERE ${tb === "devices" ? "student" : "email"}=?`).get(E));
  check("forgotten: no row left for the email (saved card, renewals, reminders, allowances, let-ins, Google links, devices, class lists)", f.status === 200 && left.length === 0, `${f.status} left: ${left}`);
  check("the card saved at Stripe for renewals is detached (never charged next semester)", calls.some(u => u === "https://api.stripe.com/v1/payment_methods/pm_s7/detach"), JSON.stringify(calls));
  globalThis.fetch = realFetch;
}

console.log("S5 the student's account page names each computer plainly (Linux, Android; not 'linux-ubuntu-24.04')");
{
  const E = "s9@usc.edu";
  await device("lnx-s7", E, "0.6.12", "linux-ubuntu-24.04"); await device("and-s7", E, "0.6.12", "android-14-samsung");
  const k = MAILS.length; await call("/account", { op: "send", email: E }); const m = MAILS.slice(k).find(x => x.to === E);
  const tok = (await call("/account", { op: "code", email: E, code: m?.code })).data?.token;
  const st = await call("/account", { op: "status", token: tok });
  const os = (st.data?.devices || []).map(d => d.os).sort();
  check("account: Android, Linux", JSON.stringify(os) === JSON.stringify(["Android", "Linux"]), JSON.stringify(st.data?.devices || st.data));
}

{ const dash = readFileSync(join(CF, "public", "dashboard.html"), "utf8"), m = dash.match(/const osName = (p => \{[^\n]*\});/);
  const osName = m ? eval(m[1]) : () => "?";
  check("professor's class list: 'Ready · Mac' / Windows / Linux / Android (not 'mac-14.6')", ["mac-14.6", "windows", "linux-ubuntu-24.04", "android-14-samsung", null].map(osName).join(",") === "Mac,Windows,Linux,Android," && /"Ready" \+ \(osName\(x\.platform\)/.test(dash)); }

console.log("S2 the Mac app's message (pay_text)");
{
  const { execFileSync } = await import("node:child_process");
  const py = `import importlib.util,json,sys,os
s=importlib.util.spec_from_file_location("a",os.path.join(sys.argv[1],"mac","lockqz-agent.py"));A=importlib.util.module_from_spec(s);s.loader.exec_module(A)
print(json.dumps([A.pay_text(json.loads(x)) for x in sys.argv[2:]]))`;
  const out = JSON.parse(execFileSync("python3", ["-c", py, join(HERE, ".."), JSON.stringify(n.data.pay), JSON.stringify(co.data.pay), JSON.stringify({ amount: 180, code: "LQS-AB12C" })],
    { env: { ...process.env, LOCKQZ_TOKEN_DIR: tmp, HOME: tmp }, encoding: "utf8" }).trim().split("\n").pop());
  check("prices + 'Memo for Zelle or Venmo'", out[0].startsWith(`Pay for LOCKqz this semester to get the quiz password: ${LINE}.`) && out[0].includes("Memo for Zelle or Venmo:  " + n.data.pay.code) && !out[0].includes("$180"), out[0]);
  check("card only: no memo line", out[1].startsWith("Pay for LOCKqz this semester to get the quiz password: $210 by card.") && !out[1].includes("Memo"), out[1]);
  check("an older server (amount only): the old sentence", out[2].startsWith("Pay $180 for LOCKqz this semester") && out[2].includes("Memo:  LQS-AB12C"), out[2]);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
