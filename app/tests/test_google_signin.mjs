// Google sign-in (31 Oct): instead of an emailed 6-digit code, the app opens a one-time page where the
// student signs in with their school Google account; the server checks Google's ID token (RS256 against
// Google's public keys, issuer, audience = our client id, expiry, nonce = the one-time link, verified email,
// school domain) and confirms the computer's email. Professors can sign in to the dashboard the same way.
// Real API, in-memory SQLite, tokens signed with a local RSA key served as the test "Google" key set.
import { withPayT } from "./pay_t.mjs";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes, generateKeyPairSync, sign as rsaSign } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url)), APP = join(HERE, ".."), CF = join(APP, "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-google-"));
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

// The test "Google": one RSA key (kid g1) in the key set; a second key Google never published.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "g1", alg: "RS256", use: "sig" };
const CID = "1234-test.apps.googleusercontent.com";
const env = { DB: d1real(sqlite), TEACHER_KEY: "tk-google", REQUIRE_SIGNED: "1", ROT_SECRET: "rs-google", MAIL_SINK: async () => true,
  GOOGLE_CLIENT_ID: CID, GOOGLE_HD: "usc.edu", GOOGLE_JWKS_TEST: JSON.stringify({ keys: [jwk] }) };
const b64u = b => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function idToken(claims, { key = privateKey, kid = "g1", alg = "RS256" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg, kid, typ: "JWT" }));
  const p = b64u(JSON.stringify({ iss: "https://accounts.google.com", aud: CID, iat: now, exp: now + 3600, email_verified: true, hd: "usc.edu", ...claims }));
  return `${h}.${p}.${b64u(rsaSign("RSA-SHA256", Buffer.from(h + "." + p), key))}`;
}
const sign = (key, path, ts, body) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");
async function call(path, body, { key = null, device = null, get = false, envx = {} } = {}) {
  body = withPayT(path, body, env);
  const raw = JSON.stringify(body ?? {}), h = { "Content-Type": "application/json", "CF-Connecting-IP": "10.9.9.9" };
  if (key) { const ts = String(Math.floor(Date.now()/1000)); h["X-LOCKqz-Device"] = device; h["X-LOCKqz-Time"] = ts; h["X-LOCKqz-Sig"] = sign(key, `/api${path}`, ts, raw); }
  const res = await onRequest({ request: new Request("https://lockqz.test/api" + path, get ? { method: "GET", headers: h } : { method: "POST", headers: h, body: raw }), env: { ...env, ...envx } });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
async function device(id) { const k = randomBytes(32).toString("hex"); await call("/register", { device_id: id, key: k, platform: "mac-15" }); return k; }
const nOf = url => (/[?&]n=([0-9a-f]{32})$/.exec(url || "") || [])[1];

console.log("G1 a computer's one-time setup through Google");
const k1 = await device("dev-g1");
let r = await call("/verify", { op: "google_start" }, { key: k1, device: "dev-g1" });
const n1 = nOf(r.data?.url);
check("google_start -> a one-time link to /google?n=<32 hex>", r.data?.ok === true && !!n1 && r.data.url.startsWith("https://lockqz.pages.dev/google?n="), JSON.stringify(r.data));
r = await call("/auth/google", { credential: idToken({ email: "Al@usc.edu", nonce: n1 }), n: n1 });
check("Google's token for the link's nonce -> ok", r.data?.ok === true && r.data.email === "al@usc.edu", JSON.stringify(r.data));
r = await call("/verify", { op: "status" }, { key: k1, device: "dev-g1" });
check("the app sees the confirmed email (+ its proof for reinstalls)", r.data?.verified === true && r.data.student === "al@usc.edu" && !!r.data.vtoken, JSON.stringify(r.data));
check("logged as email_verified (google)", sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE device_id='dev-g1' AND event='email_verified' AND detail='google'").get().n === 1);
r = await call("/auth/google", { credential: idToken({ email: "al@usc.edu", nonce: n1 }), n: n1 });
check("the same link twice -> expired (410)", r.status === 410);

console.log("G2 tokens that must be refused");
const k2 = await device("dev-g2");
const n2 = nOf((await call("/verify", { op: "google_start" }, { key: k2, device: "dev-g2" })).data?.url);
const bad = async (m, tok) => { const x = await call("/auth/google", { credential: tok, n: n2 }); check(m, x.status === 401, `${x.status} ${JSON.stringify(x.data)}`); };
await bad("another link's nonce", idToken({ email: "bo@usc.edu", nonce: n1 }));
await bad("another app's audience", idToken({ email: "bo@usc.edu", nonce: n2, aud: "evil.apps.googleusercontent.com" }));
await bad("expired", idToken({ email: "bo@usc.edu", nonce: n2, exp: Math.floor(Date.now() / 1000) - 3600 }));
await bad("email not verified by Google", idToken({ email: "bo@usc.edu", nonce: n2, email_verified: false }));
await bad("signed with a key Google never published", idToken({ email: "bo@usc.edu", nonce: n2 }, { key: other.privateKey }));
await bad("unknown key id", idToken({ email: "bo@usc.edu", nonce: n2 }, { kid: "nope" }));
await bad("not Google's issuer", idToken({ email: "bo@usc.edu", nonce: n2, iss: "https://evil.example" }));
await bad("garbage", "a.b.c");
let x = await call("/auth/google", { credential: idToken({ email: "bo@gmail.com", nonce: n2, hd: undefined }), n: n2 });
check("a personal Google account -> 403 'Use your usc.edu Google account.'", x.status === 403 && /usc\.edu/.test(x.data?.error || ""), JSON.stringify(x.data));
r = await call("/verify", { op: "status" }, { key: k2, device: "dev-g2" });
check("nothing was confirmed by any of those", r.data?.verified === false, JSON.stringify(r.data));

console.log("G3 professors sign in to the dashboard with Google");
sqlite.prepare("INSERT INTO teachers (id,email,name,verified,vouched,created_at) VALUES ('t-g','prof@usc.edu','Prof G',1,1,datetime('now'))").run();
r = await call("/auth/google", { credential: idToken({ email: "prof@usc.edu" }) });
check("existing professor -> session token", typeof r.data?.token === "string" && r.data.token.length >= 32 && r.data.email === "prof@usc.edu", JSON.stringify(r.data));
const tok = r.data?.token;
r = await call("/auth/google", { credential: idToken({ email: "prof@usc.edu" }) });
check("same token next time (one account, one session token)", r.data?.token === tok);
r = await call("/auth/google", { credential: idToken({ email: "stranger@usc.edu" }) });
check("no professor account -> 404, no account made", r.status === 404 && !sqlite.prepare("SELECT 1 FROM teachers WHERE email='stranger@usc.edu'").get());

console.log("G4 off switch, limits, public config");
r = await call("/verify", { op: "google_start" }, { key: k2, device: "dev-g2", envx: { GOOGLE_CLIENT_ID: "" } });
check("no client id -> google_off (the app uses the email code)", r.data?.error === "google_off", JSON.stringify(r.data));
r = await call("/auth/google", { credential: idToken({ email: "prof@usc.edu" }) }, { envx: { GOOGLE_CLIENT_ID: "" } });
check("no client id -> /auth/google 404", r.status === 404);
r = await call("/version", null, { get: true });
check("/version names the public client id + school domain", r.data?.google === CID && r.data?.google_hd === "usc.edu", JSON.stringify(r.data));
const k3 = await device("dev-g3"); let last = null;
for (let i = 0; i < 11; i++) last = await call("/verify", { op: "google_start" }, { key: k3, device: "dev-g3" });
check("at most 10 links per computer per day", last.status === 429, String(last.status));
r = await call("/verify", { op: "google_start" });
check("unsigned google_start refused", r.status === 401 || r.status === 403, String(r.status));

console.log("G5 every app offers Google first, the email code stays the fallback");
const rd = p => readFileSync(join(APP, p), "utf8");
const agm = rd("mac/lockqz-agent.py"), agl = rd("linux/lockqz-agent.py"), agw = rd("windows/lockqz-agent.ps1"), andr = rd("android/app/src/main/java/app/lockqz/MainActivity.kt");
check("Mac: Sign in with Google dialog, opens the link, waits on status, else the code", agm.includes('"Sign in with Google"') && agm.includes('ui.open_url(url)') && agm.includes('g = _google(call, ui, state)') && agm.includes("GOOGLE_URL.match(url)"));
check("Linux: opens the link with xdg-open", agl.includes("def open_url") && agl.includes('"xdg-open"'));
check("Windows: Google-Setup before Ask-Email", agw.includes("function Google-Setup") && agw.indexOf("$gs = Google-Setup $state") > 0 && agw.indexOf("$gs = Google-Setup $state") < agw.indexOf("$email = Ask-Email $state"));
check("Android: askGoogle before askEmail when no email is saved", andr.includes("private fun askGoogle(") && andr.includes('Api.verify(this, "google_start")'));
const page = rd("cloudflare/public/google.html"), dash = rd("cloudflare/public/dashboard.html");
check("/google page: Google Identity Services with the link's nonce, posts to /api/auth/google", page.includes("accounts.google.com/gsi/client") && page.includes("nonce: n") && page.includes('"/api/auth/google"'));
check("dashboard: Sign in with Google only when it is on", dash.includes("async function gInit()") && dash.includes('post("/auth/google"') && dash.includes("if(!v || !v.google) return;"));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
