// Professors sign up by themselves (9 Nov 2026). "New here? Create an account" on professor.lockqz.com emails a
// 6-digit code; typing it back proves the person owns the inbox, so the account is vouched (the standing an admin
// invite gives) and a professor whose email is already on a course roster claims it with no invite. Google
// sign-in on the professor site makes the account the same way. Students and TAs on a class list never get a
// professor account by themselves; admin invite links keep working.
// Real API, in-memory SQLite, mail captured, tokens signed with a local RSA key served as the test "Google" key set.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateKeyPairSync, sign as rsaSign } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url)), APP = join(HERE, ".."), CF = join(APP, "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-psignup-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
function d1real(sqlite) {
  const mk = () => { let args = [], st = null;
    return { _sql(sql){ st = sqlite.prepare(sql); return this; },
      bind(...a){ args = a.map(x => x===undefined?null:typeof x==="boolean"?Number(x):x); this._run=()=>st.run(...args); return this; },
      first: async()=> st.get(...args) ?? null, all: async()=>({results:st.all(...args)}),
      run: async()=>({meta:{changes:Number(st.run(...args).changes)}}) }; };
  return { prepare(sql){ return mk()._sql(sql); }, async batch(sts){ for (const s of sts) s._run(); } };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort()) { try { sqlite.exec(readFileSync(join(CF, m), "utf8")); } catch (e) { if (!/duplicate column|already exists|table .* already/.test(e.message)) throw e; } }

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "g1", alg: "RS256", use: "sig" };
const CID = "1234-test.apps.googleusercontent.com";
const mail = [];
const env = { DB: d1real(sqlite), TEACHER_KEY: "tk-psu", REQUIRE_SIGNED: "1", ROT_SECRET: "rs-psu", PW_PEPPER: "pep-psu",
  MAIL_SINK: async m => { mail.push(m); return true; }, FEE_EXEMPT: "dbristow@usc.edu",
  GOOGLE_CLIENT_ID: CID, GOOGLE_HD: "usc.edu", GOOGLE_JWKS_TEST: JSON.stringify({ keys: [jwk] }) };
const b64u = b => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function idToken(claims) {
  const now = Math.floor(Date.now() / 1000), h = b64u(JSON.stringify({ alg: "RS256", kid: "g1", typ: "JWT" }));
  const p = b64u(JSON.stringify({ iss: "https://accounts.google.com", aud: CID, iat: now, exp: now + 3600, email_verified: true, hd: "usc.edu", ...claims }));
  return `${h}.${p}.${b64u(rsaSign("RSA-SHA256", Buffer.from(h + "." + p), privateKey))}`;
}
async function call(path, body, { ip = "10.1.0.1", token = null, get = false, envx = {} } = {}) {
  const h = { "Content-Type": "application/json", "CF-Connecting-IP": ip };
  if (token) h["X-LOCKqz-Teacher"] = token;
  const res = await onRequest({ request: new Request("https://lockqz.test/api" + path, get ? { method: "GET", headers: h } : { method: "POST", headers: h, body: JSON.stringify(body ?? {}) }), env: { ...env, ...envx } });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const codeFor = em => mail.filter(m => m.to === em && m.code).pop()?.code;
const row = em => sqlite.prepare("SELECT id, role, vouched, verified FROM teachers WHERE email=?").get(em);
const nowIso = () => new Date().toISOString();

// The admin (first account) has synced two courses: their class lists are trusted.
const ADMIN = (await call("/signup", { email: "admin@usc.edu", password: "adminpass1", name: "Anthony Hall" })).data.token;
const AID = row("admin@usc.edu").id;
for (const ou of ["C1", "C2"]) sqlite.prepare("INSERT INTO teacher_courses (teacher_id,ou,name,code,role,synced_at,in_sync) VALUES (?,?,?,?,?,?,1)").run(AID, ou, "FBE " + ou, ou, "Teaching Assistant", nowIso());
const ros = sqlite.prepare("INSERT INTO roster (ou,user_id,name,email,username,org_id,role,synced_at) VALUES (?,?,?,?,?,?,?,?)");
ros.run("C1", "u-b", "Duke Bristow", "dbristow@usc.edu", "dbristow", "1", "Instructor", nowIso());
ros.run("C1", "u-s", "Sam Student", "sam@usc.edu", "sam", "2", "Student", nowIso());
ros.run("C1", "u-t", "Tia Assistant", "tia@usc.edu", "tia", "3", "Teaching Assistant", nowIso());
ros.run("C1", "u-g", "Gil Grad", "grad@usc.edu", "grad", "4", "Learner", nowIso());
ros.run("C2", "u-g2", "Gil Grad", "grad@usc.edu", "grad", "4", "Instructor", nowIso());

console.log("P1 a professor on a course roster claims his email with an emailed code (no invite)");
let r = await call("/signup", { email: "dbristow@usc.edu", password: "realprof12", name: "Duke Bristow" });
check("no code, no invite -> still refused (409) and told to get the emailed code", r.status === 409 && /emailed code/.test(r.data?.error || ""), JSON.stringify(r.data));
r = await call("/signup/code", { email: " DBristow@usc.edu " });
check("/signup/code -> ok", r.status === 200 && r.data?.ok === true && r.data.email === "dbristow@usc.edu", JSON.stringify(r.data));
const c1 = codeFor("dbristow@usc.edu");
check("a 6-digit code was emailed to him", /^\d{6}$/.test(c1 || ""));
check("the email says where to type it (professor.lockqz.com)", /professor\.lockqz\.com/.test(mail.filter(m => m.code).pop()?.text || ""));
const wrong = c1 === "000000" ? "111111" : "000000";
r = await call("/signup", { email: "dbristow@usc.edu", password: "realprof12", name: "Duke Bristow", code: wrong });
check("a wrong code -> 400 wrong_code, no account", r.status === 400 && r.data?.error === "wrong_code" && !row("dbristow@usc.edu"), JSON.stringify(r.data));
r = await call("/signup", { email: "dbristow@usc.edu", password: "realprof12", name: "Duke Bristow", code: c1 });
check("the right code -> account + session token", r.status === 200 && typeof r.data?.token === "string", JSON.stringify(r.data));
const BT = r.data?.token;
check("the account is vouched (as an invite makes it), not yet verified", row("dbristow@usc.edu")?.vouched === 1 && row("dbristow@usc.edu")?.verified === 0 && row("dbristow@usc.edu")?.role === "teacher");
r = await call("/me", null, { get: true, token: BT });
check("fee-exempt professor -> active trial, no payment", r.data?.trial === true && r.data?.active === true, JSON.stringify(r.data));
check("the code is spent (one code, one account)", !sqlite.prepare("SELECT 1 FROM email_codes WHERE device_id='prof:dbristow@usc.edu'").get());
check("welcome email sent", mail.some(m => m.to === "dbristow@usc.edu" && !m.code));
r = await call("/signup/code", { email: "dbristow@usc.edu" });
check("a second code for an existing account -> 409 log in instead", r.status === 409, JSON.stringify(r.data));
r = await call("/login", { email: "dbristow@usc.edu", password: "realprof12" });
check("he signs in with his password", r.status === 200 && !!r.data?.token, JSON.stringify(r.data));

console.log("P2 codes expire, allow five tries, and are rate-limited");
r = await call("/signup/code", { email: "new@usc.edu" }, { ip: "10.2.0.1" });
check("an email on no class list gets a code too", r.status === 200 && /^\d{6}$/.test(codeFor("new@usc.edu") || ""), JSON.stringify(r.data));
sqlite.prepare("UPDATE email_codes SET expires=? WHERE device_id='prof:new@usc.edu'").run(Date.now() - 1000);
r = await call("/signup", { email: "new@usc.edu", password: "newprof123", code: codeFor("new@usc.edu") }, { ip: "10.2.0.1" });
check("an expired code -> code_expired", r.status === 400 && r.data?.error === "code_expired" && !row("new@usc.edu"), JSON.stringify(r.data));
await call("/signup/code", { email: "new@usc.edu" }, { ip: "10.2.0.1" });
const good = codeFor("new@usc.edu"), bad = good === "999999" ? "888888" : "999999";
let last = null;
for (let i = 0; i < 5; i++) last = await call("/signup", { email: "new@usc.edu", password: "newprof123", code: bad }, { ip: "10.2.0.1" });
check("the fifth wrong code -> too_many_tries, the code is gone", last.data?.error === "too_many_tries" && !sqlite.prepare("SELECT 1 FROM email_codes WHERE device_id='prof:new@usc.edu'").get(), JSON.stringify(last.data));
r = await call("/signup", { email: "new@usc.edu", password: "newprof123", code: good }, { ip: "10.2.0.1" });
check("the old right code no longer works after that", r.status === 400 && !row("new@usc.edu"), JSON.stringify(r.data));
await call("/signup/code", { email: "new@usc.edu" }, { ip: "10.2.0.1" });
r = await call("/signup", { email: "new@usc.edu", password: "newprof123", code: codeFor("new@usc.edu") }, { ip: "10.2.0.1" });
check("a fresh code -> account, vouched", r.status === 200 && row("new@usc.edu")?.vouched === 1, JSON.stringify(r.data));
for (let i = 0; i < 3; i++) last = await call("/signup/code", { email: "lim@usc.edu" }, { ip: "10.2.0.2" });
check("three codes an hour to one address are fine", last.status === 200, JSON.stringify(last.data));
last = await call("/signup/code", { email: "lim@usc.edu" }, { ip: "10.2.0.2" });
check("the fourth -> 429 too_many_codes", last.status === 429 && last.data?.error === "too_many_codes", JSON.stringify(last.data));
r = await call("/signup/code", { email: "not-an-email" });
check("a bad address -> 400", r.status === 400);
r = await call("/signup/code", { email: "off@usc.edu" }, { envx: { MAIL_SINK: undefined } });
check("no mail set up -> 503 off (Google stays)", r.status === 503 && r.data?.error === "off", JSON.stringify(r.data));

console.log("P3 students and TAs on a class list never get a professor account by themselves");
const sent0 = mail.length;
r = await call("/signup/code", { email: "sam@usc.edu" }, { ip: "10.3.0.1" });
check("a student's email -> 403 student_email, no code sent", r.status === 403 && r.data?.error === "student_email" && mail.length === sent0, JSON.stringify(r.data));
r = await call("/signup/code", { email: "tia@usc.edu" }, { ip: "10.3.0.1" });
check("a TA's email -> 403", r.status === 403 && r.data?.error === "student_email", JSON.stringify(r.data));
r = await call("/auth/google", { credential: idToken({ email: "sam@usc.edu", name: "Sam Student" }) }, { ip: "10.3.0.1" });
check("a student's Google sign-in -> 403, no account", r.status === 403 && !row("sam@usc.edu"), JSON.stringify(r.data));
r = await call("/signup/code", { email: "grad@usc.edu" }, { ip: "10.3.0.1" });
check("a grad student who is an instructor in another course -> a code", r.status === 200, JSON.stringify(r.data));
r = await call("/invite", { email: "tia@usc.edu" }, { token: ADMIN });
const tinv = r.data?.code;
r = await call("/signup", { email: "tia@usc.edu", password: "tiapass123", invite: tinv }, { ip: "10.3.0.1" });
check("the admin can still invite anyone (the invite decides)", r.status === 200 && row("tia@usc.edu")?.vouched === 1, JSON.stringify(r.data));

console.log("P4 an account nobody vouched for gives way to the inbox's owner");
r = await call("/signup", { email: "prof2@usc.edu", password: "squatter1" }, { ip: "10.4.0.1" });
const sq = row("prof2@usc.edu");
check("setup: an unvouched account squats prof2@usc.edu", r.status === 200 && sq?.vouched === 0, JSON.stringify(r.data));
r = await call("/signup/code", { email: "prof2@usc.edu" }, { ip: "10.4.0.2" });
check("the owner can still get a code", r.status === 200, JSON.stringify(r.data));
r = await call("/signup", { email: "prof2@usc.edu", password: "realowner1", code: codeFor("prof2@usc.edu") }, { ip: "10.4.0.2" });
check("the code takes the account over (same row, vouched)", r.status === 200 && row("prof2@usc.edu")?.id === sq?.id && row("prof2@usc.edu")?.vouched === 1, JSON.stringify(r.data));
check("the squatter's password stops working", (await call("/login", { email: "prof2@usc.edu", password: "squatter1" }, { ip: "10.4.0.3" })).status === 401);
check("the owner's password works", (await call("/login", { email: "prof2@usc.edu", password: "realowner1" }, { ip: "10.4.0.3" })).status === 200);
await call("/signup", { email: "prof3@usc.edu", password: "squatter3" }, { ip: "10.4.0.4" });
r = await call("/auth/google", { credential: idToken({ email: "prof3@usc.edu", name: "Pat Three" }) }, { ip: "10.4.0.5" });
check("Google takes a squatted account over too", r.status === 200 && r.data?.created === true && row("prof3@usc.edu")?.vouched === 1, JSON.stringify(r.data));
check("...and the squatter's password stops working", (await call("/login", { email: "prof3@usc.edu", password: "squatter3" }, { ip: "10.4.0.6" })).status === 401);

console.log("P5 Google sign-in on the professor site makes the account");
r = await call("/auth/google", { credential: idToken({ email: "Ada@usc.edu", name: "Ada Lovelace" }) }, { ip: "10.5.0.1" });
check("a USC Google account with no LOCKqz account -> made, vouched, named from Google", r.status === 200 && r.data?.created === true && r.data.name === "Ada Lovelace" && row("ada@usc.edu")?.vouched === 1, JSON.stringify(r.data));
const at = r.data?.token;
r = await call("/auth/google", { credential: idToken({ email: "ada@usc.edu", name: "Ada Lovelace" }) }, { ip: "10.5.0.1" });
check("next time -> the same account and session (no second row)", r.status === 200 && r.data?.token === at && !r.data.created && sqlite.prepare("SELECT COUNT(*) AS n FROM teachers WHERE email='ada@usc.edu'").get().n === 1, JSON.stringify(r.data));
check("welcome email sent", mail.some(m => m.to === "ada@usc.edu" && !m.code));
check("no password works for a Google-made account", (await call("/login", { email: "ada@usc.edu", password: "" }, { ip: "10.5.0.2" })).status !== 200);
r = await call("/auth/google", { credential: idToken({ email: "someone@gmail.com", hd: undefined }) }, { ip: "10.5.0.1" });
check("a non-school Google account -> 404, no account made", r.status === 404 && !row("someone@gmail.com"), JSON.stringify(r.data));
r = await call("/auth/google", { credential: idToken({ email: "dbristow@usc.edu" }) }, { ip: "10.5.0.1" });
check("an existing professor just signs in", r.status === 200 && !r.data?.created && r.data?.email === "dbristow@usc.edu", JSON.stringify(r.data));

console.log("P6 invite links keep working; the page offers sign-up to everyone");
r = await call("/invite", { email: "inv@usc.edu" }, { token: ADMIN });
r = await call("/signup", { email: "inv@usc.edu", password: "invpass123", invite: r.data?.code }, { ip: "10.6.0.1" });
check("invite sign-up needs no code", r.status === 200 && row("inv@usc.edu")?.vouched === 1, JSON.stringify(r.data));
const dash = readFileSync(join(CF, "public", "dashboard.html"), "utf8");
check("'New here? Create an account' is shown without an invite", /<div class="muted" id="signuprow">/.test(dash));
check("the code box and the two steps (code, then sign-up with it)", dash.includes('id="sucode"') && dash.includes('post("/signup/code", { email: em })') && dash.includes('code:signup&&!INVITE?$("sucode").value.trim():""'));
check("an invite link skips the code", dash.includes("if(signup && !INVITE){"));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
