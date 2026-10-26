// LOCKqz API (Cloudflare Pages Function). Bindings: env.DB (D1), env.TEACHER_KEY (admin key).
// Routes are under /api/*.  Teachers sign up / log in with email + password; each sees only
// their own quizzes, courses, students and activity. The TEACHER_KEY is the admin master key
// (sees everything, can reset a teacher's password). Device endpoints (/report, /password, /install)
// are authenticated with per-device keys; see "Device authentication" below.
const AI_DOMAINS = [
  "openai.com","chatgpt.com","chat.openai.com","oaistatic.com","oaiusercontent.com","cdn.oaistatic.com","platform.openai.com","sora.com",
  "sora.chatgpt.com","auth.openai.com","anthropic.com","claude.ai","claude.com","console.anthropic.com","gemini.google.com","bard.google.com",
  "aistudio.google.com","makersuite.google.com","generativelanguage.googleapis.com","notebooklm.google.com","notebooklm.google","gemini.google","labs.google","learning.google.com",
  "jules.google","jules.google.com","google.com/ai","google.com/aimode","copilot.microsoft.com","copilot.cloud.microsoft","m365.cloud.microsoft/chat","m365copilot.com",
  "bing.com/chat","sydney.bing.com","edgeservices.bing.com","perplexity.ai","perplexity.com","pplx.ai","labs.perplexity.ai","grok.com",
  "x.ai","grok.x.com","x.com/i/grok","console.x.ai","deepseek.com","chat.deepseek.com","platform.deepseek.com","mistral.ai",
  "chat.mistral.ai","console.mistral.ai","meta.ai","qwen.ai","chat.qwen.ai","tongyi.aliyun.com","qianwen.com","tongyi.com",
  "dashscope.aliyuncs.com","dashscope-intl.aliyuncs.com","kimi.com","kimi.moonshot.cn","moonshot.cn","kimi.ai","moonshot.ai","api.moonshot.ai",
  "platform.moonshot.ai","z.ai","chat.z.ai","api.z.ai","chatglm.cn","bigmodel.cn","poe.com","character.ai",
  "beta.character.ai","you.com","phind.com","duck.ai","huggingface.co/chat","hf.co/chat","chat.lmsys.org","lmarena.ai",
  "groq.com","chatbot.so","cluely.com","pi.ai","inflection.ai","venice.ai","together.ai","api.together.xyz",
  "chat.reka.ai","reka.ai","cohere.com","coral.cohere.com","jasper.ai","writesonic.com","chatsonic.com","copy.ai",
  "quillbot.com","deepai.org","forefront.ai","theb.ai","yiyan.baidu.com","doubao.com","spark.ai","xinghuo.xfyun.cn",
  "grammarly.com","app.grammarly.com","capi.grammarly.com","auth.grammarly.com","go.superhuman.com","jenni.ai","rytr.me","wordtune.com",
  "hix.ai","smodin.io","paperpal.com","undetectable.ai","stealthgpt.ai","humanizeai.pro","gauthmath.com","questionai.com",
  "studyx.ai","brainly.com","solvely.ai","julius.ai","iask.ai","mathgptpro.com","mathos.ai","caktus.ai",
  "studyfetch.com","khanmigo.ai","symbolab.com","mathway.com","photomath.com","chegg.com","coursehero.com","genspark.ai",
  "felo.ai","andisearch.com","komo.ai","consensus.app","elicit.com","scispace.com","chatpdf.com","manus.im",
  "flowith.io","liner.com","getliner.com","t3.chat","typingmind.com","chathub.gg","mammouth.ai","lumo.proton.me",
  "janitorai.com","talkie-ai.com","yuanbao.tencent.com","hunyuan.tencent.com","dola.com","cici.com","ciciai.com","coze.com",
  "coze.cn","hailuoai.com","minimaxi.com","minimax.io","agent.minimax.io","yuewen.cn","stepfun.com","metaso.cn",
  "tiangong.cn","ying.baichuan-ai.com","chat.sensetime.com","wrtn.ai","giga.chat","sider.ai","api1.sider.ai","api2.sider.ai",
  "api3.sider.ai","monica.im","api.monica.im","maxai.me","api.maxai.me","app.maxai.me","getmerlin.in","arcane.getmerlin.in",
  "api.getmerlin.in","uam.getmerlin.in","harpa.ai","api.harpa.ai","aria.opera.com","github.com/copilot","api.githubcopilot.com","api.individual.githubcopilot.com",
  "api.business.githubcopilot.com","api.enterprise.githubcopilot.com","githubcopilot.com","copilot-proxy.githubusercontent.com","cursor.com","cursor.sh","api2.cursor.sh","api3.cursor.sh",
  "api4.cursor.sh","repo42.cursor.sh","us-only.gcpp.cursor.sh","windsurf.com","codeium.com","server.codeium.com","api.jetbrains.ai","antigravity.google",
  "kiro.dev","trae.ai","v0.dev","v0.app","bolt.new","lovable.dev","cloudcode-pa.googleapis.com","api.openai.com",
  "api.anthropic.com","api.perplexity.ai","api.mistral.ai","api.groq.com","api.x.ai","api.deepseek.com","api.cohere.ai","openrouter.ai",
  "api.openrouter.ai","fireworks.ai","api.fireworks.ai","deepinfra.com","api.deepinfra.com","cerebras.ai","api.cerebras.ai","cloud.sambanova.ai",
  "api.sambanova.ai","hyperbolic.xyz","api.hyperbolic.xyz","novita.ai","api.novita.ai","replicate.com","api.replicate.com","router.huggingface.co",
  "api.ai21.com","studio.ai21.com","ollama.com","ollama.ai","lmstudio.ai","gpt4all.io","jan.ai","msty.app",
  "chat.webllm.ai","webllm.mlc.ai","remotedesktop.google.com","remotedesktop-pa.googleapis.com","web.teamviewer.com","my.anydesk.com","web.parsec.app","api.sec-tunnel.com",
  "mask.icloud.com","mask-h2.icloud.com","cloudflare-dns.com","chrome.cloudflare-dns.com","mozilla.cloudflare-dns.com","dns.google","dns.google.com","dns.quad9.net",
  "doh.opendns.com","dns.nextdns.io","firefox.dns.nextdns.io","chromium.dns.nextdns.io","doh.xfinity.com","private.canadianshield.cira.ca","wikimedia-dns.org","dns.adguard-dns.com",
  "doh.mullvad.net","freedns.controld.com","dns.alidns.com","doh.pub","appsgenaiserver-pa.clients6.google.com","appsgenaiserver-pa.googleapis.com","chat.learnwise.ai","learnwise.ai",
  "blackbox.ai","www.blackbox.ai","hf.space","translate.goog","lens.google.com","abacus.ai","chatllm.abacus.ai","anakin.ai","notegpt.io","perchance.org/ai-chat"
];
const now = () => new Date().toISOString();
// "Today" in America/Los_Angeles as YYYY-MM-DD, so a professor stays active through the end of their
// paid date in Pacific time (not 5pm Pacific, which UTC-midnight would give).
// DST-correct (Intl, America/Los_Angeles); the fixed UTC-8 fallback only runs if Intl has no tz data.
const LA_FMT = (() => { try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }); } catch { return null; } })();
const laToday = () => {
  if (LA_FMT) { const p = {}; for (const x of LA_FMT.formatToParts(new Date(Date.now()))) p[x.type] = x.value; if (p.year && p.month && p.day) return `${p.year}-${p.month}-${p.day}`; }
  return new Date(Date.now() - 8*3600000).toISOString().slice(0,10);
};
// A real calendar date "YYYY-MM-DD" (rejects "12/31/2026", "2026-02-31", "tomorrow").
const isDate = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && (() => { const d = new Date(s + "T00:00:00Z"); return !isNaN(d) && d.toISOString().slice(0,10) === s; })();
// Optional text field from a client body -> string or null (never an object: D1 would 500 on it).
const str = (v, n = 200) => v == null || v === "" ? null : String(typeof v === "object" ? JSON.stringify(v) : v).slice(0, n);
const placeholders = n => Array(n).fill("?").join(",");
const chunk = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };
// Multi-row INSERT statements, each under D1's 100-bound-parameter cap.
function multiInsert(db, head, cols, rows, tail = "") {
  const per = Math.max(1, Math.floor(99 / cols));
  return chunk(rows, per).map(part => db.prepare(`${head} VALUES ${part.map(() => "(" + placeholders(cols) + ")").join(",")} ${tail}`).bind(...part.flat()));
}
// db.batch counts as ONE D1 query on the Free plan (50 per request); keep each batch modest.
async function runBatches(db, sts) { for (const part of chunk(sts, 100)) if (part.length) await db.batch(part); }
const STALE_MS = 660000;   // live monitor: helpers ping every ~300 s, so a lock not refreshed for 11 minutes "went dark"
const EVENT_DAYS = 120;    // retention: activity events are deleted after 120 days (privacy.html)
const rid = (n=6) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map(b=>"ABCDEFGHJKMNPQRSTUVWXYZ23456789"[b%30]).join("");
const hex = a => Array.from(new Uint8Array(a)).map(b=>b.toString(16).padStart(2,"0")).join("");
const CORS = { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"Content-Type, X-LOCKqz-Teacher, X-LOCKqz-Sync", "Access-Control-Allow-Methods":"GET, POST, OPTIONS", "Access-Control-Max-Age":"86400" };
const json = (o, s=200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type":"application/json", ...CORS } });

// Build stamp: deploy.sh replaces the two placeholders in its staging copy (same build -> both hosts).
const BUILD_VERSION = "__LQZ_VERSION__", BUILD_ID = "__LQZ_BUILD__";
const buildInfo = () => ({ version: BUILD_VERSION.startsWith("__") ? "dev" : BUILD_VERSION, api: BUILD_ID.startsWith("__") ? "dev" : BUILD_ID });

// Password hashing: PBKDF2-SHA256 with a per-user salt.
// Workers Free allows ~10 ms CPU per request; 100k rounds cost ~23 ms (measured), so new hashes use
// 20k rounds (~5 ms) and, when the Pages secret PW_PEPPER is set, an HMAC pepper first (a stolen
// database alone is then useless for guessing). Stored as "p2$<rounds>$<peppered 0|1>$<hex>".
// Old hashes (bare hex = 100k rounds, no pepper) stay valid and are re-hashed at the next login.
const PW_ROUNDS = 20000;
async function pbkdf2(pw, salt, rounds) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name:"PBKDF2", hash:"SHA-256", salt:new TextEncoder().encode(salt), iterations:rounds }, key, 256));
}
async function hashPw(pw, salt, pepper = "") {
  const pep = pepper ? 1 : 0;
  const input = pep ? await hmacHex(pepper, "lqz-pw:" + pw) : pw;
  return `p2$${PW_ROUNDS}$${pep}$` + await pbkdf2(input, salt, PW_ROUNDS);
}
// -> { ok, rehash }: rehash = the stored hash uses an older/costlier setting (re-hash it now).
async function checkPw(pw, salt, stored, pepper = "") {
  stored = String(stored || "");
  const m = stored.match(/^p2\$(\d+)\$([01])\$([0-9a-f]{64})$/);
  if (!m) { const ok = sameHex(await pbkdf2(pw, salt, 100000), stored); return { ok, rehash: ok }; }
  if (m[2] === "1" && !pepper) return { ok: false, rehash: false };   // pepper secret missing: never accept
  const input = m[2] === "1" ? await hmacHex(pepper, "lqz-pw:" + pw) : pw;
  const ok = sameHex(await pbkdf2(input, salt, Number(m[1])), m[3]);
  return { ok, rehash: ok && (Number(m[1]) !== PW_ROUNDS || (m[2] === "0" && !!pepper)) };
}

// /live is polled every ~10 s by the dashboard AND the Sync tab's gate loop. The answer is the same for
// every authorized caller, so it is computed at most once per LIVE_CACHE_MS (default 8 s) per quiz and
// shared: a per-isolate memory cache plus the colo's Cache API (no D1 reads). Student events do NOT clear
// it (a 100-student class locks/unlocks every few seconds, which would defeat the sharing): a lock or an
// unlock shows within 8 s -- the gate loop itself only runs every 10 s. Starting/stopping a gate and a
// Sync that changed quiz dates clear it.
const LIVE_MEM = new Map();
// /live paid check (D1 Free: 5M rows read/day): a "paid" answer is reused for PAID_TTL ms -- in this
// isolate, and in this data center's cache per quiz (one Sync tab = one data center). Unpaid emails are
// re-checked every round, so a new payment admits at once; a voided payment stops admitting within PAID_TTL.
const PAID_MEM = new Map(), PAID_TTL = 300000;
const WRITE_CAP = e => /row write limit|exceeded D1.*writ/i.test(String(e));
const liveKey = (quiz, codes) => `${quiz}|${codes ? 1 : 0}`;
const liveCacheReq = (origin, key) => new Request(`${origin}/__lqz_cache/live/${encodeURIComponent(key)}`);
async function liveBust(origin, quizId) {
  const ou = String(quizId || "").split("-")[0];
  const keys = [];
  for (const q of [quizId, ou]) for (const c of [0, 1]) keys.push(liveKey(q, c));
  keys.forEach(k => LIVE_MEM.delete(k));
  try { if (typeof caches !== "undefined" && caches.default) await Promise.all(keys.map(k => caches.default.delete(liveCacheReq(origin, k)))); } catch {}
}
// A quiz opened from Content/Lessons: /d2l/le/content/<ou>/fullscreen/<topic>/ViewLocation?...&location=<quiz URL>.
const innerUrl = u => { try { const x = new URL(String(u || "")); if (/^\/d2l\/le\/(content|lessons)\/\d+\//i.test(x.pathname)) { const loc = x.searchParams.get("location") || ""; if (loc.startsWith("/d2l/")) return x.origin + loc; } } catch {} return String(u || ""); };
const ids = u => (u = innerUrl(u), { qi: (u.match(/[?&]qi=(\d+)/) || u.match(/[?&]quizId=(\d+)/) || [])[1] || null,
                    ou: (u.match(/[?&]ou=(\d+)/) || u.match(/\/home\/(\d+)/) || [])[1] || null });

// ---- Device authentication (23 Oct 2026) ----
// Each install has a random 256-bit key in a file only the root/SYSTEM helper can read. The helper
// registers it once (/register) and signs every device report and every password request:
//   X-LOCKqz-Device: <device_id>   X-LOCKqz-Time: <unix seconds>
//   X-LOCKqz-Sig: hex(HMAC-SHA256(key, "POST\n" + path + "\n" + time + "\n" + sha256hex(body)))
// With the Pages variable REQUIRE_SIGNED=1, unsigned device writes and password requests are refused,
// so a script that never installed LOCKqz can no longer fake a lock and read the quiz password.
// Without it (rollout), old unsigned installs keep working, but a registered device can never be
// impersonated and unsigned heartbeats can never keep a lock alive.
const SIG_WINDOW_S = 300;
// Per-minute code for a quiz: stable seed + HMAC(minute). Released to the locked app only; the app
// types it and never shows it, so a code a student exfiltrates stops working within ~60 seconds.
// Rotation period for the gated quiz password: 5 minutes (the hide-gate already keeps unlocked
// students out; a longer period means a student who pastes a little late is not rejected).
const ROT_MS = 300000;
const minuteBucket = () => Math.floor(Date.now() / ROT_MS);
async function rotatingPw(secret, ou, qi, bucket) {
  const h = await hmacHex(String(secret||"lqz-fallback"), `lqz-rot:${ou}:${qi}:${bucket}`);
  return "LQ-" + h.slice(0, 10).toUpperCase();
}
const enc = new TextEncoder();
const unixNow = () => Math.floor(Date.now() / 1000);
async function sha256hex(bytes) { return hex(await crypto.subtle.digest("SHA-256", bytes)); }
async function hmacHex(keyText, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(keyText), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
function sameHex(a, b) {   // constant-time compare
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
// Returns the device row too (dev), so callers need no second read of devices.
async function verifyDevice(request, raw, db) {
  const id = (request.headers.get("X-LOCKqz-Device") || "").trim();
  const ts = (request.headers.get("X-LOCKqz-Time") || "").trim();
  const sig = (request.headers.get("X-LOCKqz-Sig") || "").trim().toLowerCase();
  if (!id || !ts || !sig) return { ok: false, why: "unsigned" };
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(unixNow() - t) > SIG_WINDOW_S) return { ok: false, why: "clock", id };
  const d = await db.prepare("SELECT device_key, revoked, student, student_verified, version, platform, last_seen FROM devices WHERE device_id=?").bind(id).first();
  if (!d || !d.device_key) return { ok: false, why: "unregistered", id };
  if (d.revoked) return { ok: false, why: "revoked", id };
  const msg = `POST\n${new URL(request.url).pathname}\n${ts}\n${await sha256hex(raw)}`;
  return request.method === "POST" && sameHex(await hmacHex(d.device_key, msg), sig) ? { ok: true, id, dev: d } : { ok: false, why: "bad signature", id };
}
// C10 (USC first): the one Brightspace this server serves. Env BS_HOSTS = comma-separated hosts.
const bsHosts = env => String(env.BS_HOSTS || "brightspace.usc.edu,usc.brightspace.com").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
const hostOf = u => { try { return new URL(String(u)).host.toLowerCase(); } catch { return ""; } };
// Mask a roster name for the pre-verification "Is this you?" prompt: "Jane Q Smith" -> "J*** Q*** S***".
const maskName = n => n ? String(n).trim().split(/\s+/).map(w => w.slice(0, 1).toUpperCase() + "***").join(" ") : null;
const isRegistered = async (db, id) => !!(id && await db.prepare("SELECT 1 AS r FROM devices WHERE device_id=? AND device_key IS NOT NULL").bind(String(id)).first());

// ---- Student email verification (25 Oct 2026) ----
// A device's student email counts (quiz gate, professor's "Ready" list) only after the student
// types the 6-digit code LOCKqz emailed to it. Codes: 15 minutes, 5 tries, only a hash is stored.
// Mail goes out through Gmail SMTP (free, 500/day) using Pages secrets MAIL_USER + MAIL_APP_PASSWORD.
// Without those secrets codes are off and an email is accepted after the roster check (old behaviour).
const CODE_MS = 15 * 60000, CODE_TRIES = 5;
const EMAIL_OK = e => /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e);
// Trial testers (FEE_EXEMPT in wrangler.toml, comma-separated): never pay (student fee or professor fee)
// and get the test-run welcome. Everyone else pays.
const exemptSet = env => new Set(String(env.FEE_EXEMPT || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean));
const isExempt = (env, e) => !!e && exemptSet(env).has(String(e).trim().toLowerCase());
const WELCOME = "Welcome to the LOCKqz test run! You are exempt from paying during this trial period. Have fun testing!\n\nThank you for joining me on the USC students\u2019 edification journey.\n\nLocks keep honest people honest.";
const b64 = s => btoa(String.fromCharCode(...enc.encode(s)));
// Minimal SMTP client over a TLS socket. `open` returns { readable, writable } (cloudflare:sockets).
async function smtpSend(open, { user, pass, to, subject, text, fromName = "LOCKqz" }) {
  const sock = await open();
  const w = sock.writable.getWriter(), r = sock.readable.getReader(), dec = new TextDecoder();
  let buf = "";
  const reply = async () => {             // one full (possibly multi-line) reply -> code
    for (;;) {
      const lines = buf.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++)
        if (/^\d{3} /.test(lines[i])) { buf = lines.slice(i + 1).join("\r\n"); return Number(lines[i].slice(0, 3)); }
      const { value, done } = await r.read();
      if (done) throw new Error("smtp closed");
      buf += dec.decode(value, { stream: true });
    }
  };
  const say = async (line, want) => {
    if (line !== null) await w.write(enc.encode(line + "\r\n"));
    const c = await reply();
    if (!want.includes(c)) throw new Error(`smtp ${c} after ${String(line || "greeting").split(" ")[0]}`);
  };
  try {
    await say(null, [220]);
    await say("EHLO lockqz.pages.dev", [250]);
    await say("AUTH PLAIN " + b64("\0" + user + "\0" + pass), [235]);
    await say(`MAIL FROM:<${user}>`, [250]);
    await say(`RCPT TO:<${to}>`, [250, 251]);
    await say("DATA", [354]);
    const msg = [`From: ${fromName} <${user}>`, `To: <${to}>`, `Subject: ${subject}`,
      `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
      `Message-ID: <${crypto.randomUUID()}@lockqz.pages.dev>`, "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "",
      ...text.split("\n").map(l => (l.startsWith(".") ? "." + l : l))].join("\r\n");
    await say(msg + "\r\n.", [250]);
    try { await w.write(enc.encode("QUIT\r\n")); } catch {}
  } finally { try { await sock.close?.(); } catch {} }
  return true;
}
async function sendCode(env, to, code) {
  const subject = `Your LOCKqz code: ${code}`;
  const text = (isExempt(env, to) ? WELCOME + "\n\n" : "") + `Your LOCKqz code is ${code}\n\nType it into the LOCKqz window on your computer. It expires in 15 minutes.\n\nIf you did not ask for this, ignore this email.`;
  if (typeof env.MAIL_SINK === "function") return env.MAIL_SINK({ to, subject, text, code });   // tests
  const open = typeof env.MAIL_OPEN === "function" ? env.MAIL_OPEN   // tests: fake SMTP server
    : async () => (await import("cloudflare:sockets")).connect({ hostname: env.MAIL_HOST || "smtp.gmail.com", port: Number(env.MAIL_PORT || 465) },
                                { secureTransport: "on", allowHalfOpen: false });
  return smtpSend(open, { user: env.MAIL_USER, pass: String(env.MAIL_APP_PASSWORD).replace(/\s+/g, ""), to, subject, text });
}

async function sendMail(env, to, subject, text) {
  if (typeof env.MAIL_SINK === "function") return env.MAIL_SINK({ to, subject, text });   // tests
  const open = typeof env.MAIL_OPEN === "function" ? env.MAIL_OPEN
    : async () => (await import("cloudflare:sockets")).connect({ hostname: env.MAIL_HOST || "smtp.gmail.com", port: Number(env.MAIL_PORT || 465) },
                                { secureTransport: "on", allowHalfOpen: false });
  return smtpSend(open, { user: env.MAIL_USER, pass: String(env.MAIL_APP_PASSWORD).replace(/\s+/g, ""), to, subject, text });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const p = url.pathname.replace(/^\/api/, "") || "/";
  const db = env.DB;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  // One API, one set of secrets (25 Oct 2026): the other LOCKqz *.pages.dev addresses (prof., the old
  // lockdownqz ones, per-deploy preview hosts) run in Cloudflare environments that do not carry the main
  // site's secrets (email codes, signing), so they forward every API call to the main site instead of
  // answering with weaker rules. The dashboard and Sync panel call the main site directly; only old
  // installs and old Sync bookmarks come through here.
  const MAIN = String(env.API_HOST || "lockqz.pages.dev").toLowerCase();
  if (url.hostname.toLowerCase() !== MAIN && /\.pages\.dev$/i.test(url.hostname) && String(env.NO_API_PROXY || "") !== "1") {
    const h = new Headers(request.headers); h.delete("host");
    const init = { method: request.method, headers: h, redirect: "manual" };
    if (request.method !== "GET" && request.method !== "HEAD") init.body = await request.arrayBuffer();
    try { return await fetch("https://" + MAIN + url.pathname + url.search, init); }
    catch (e) { return json({ error: "LOCKqz is not reachable right now - try again in a minute" }, 502); }
  }
  const raw = request.method === "POST" ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array(0);
  let body = {};
  if (raw.length) { try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { body = {}; } }
  if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
  const strict = String(env.REQUIRE_SIGNED || "").trim() === "1";
  const PEPPER = String(env.PW_PEPPER || "");
  const codesOn = typeof env.MAIL_SINK === "function" || !!(env.MAIL_USER && env.MAIL_APP_PASSWORD);
  const denied = (v, extra = {}) => json({ error: "unauthorized device", why: v.why, server_time: unixNow(), ...extra }, 401);

  // ---- who is calling? admin (master key) | teacher (session token) | nobody ----
  const hdr = (request.headers.get("X-LOCKqz-Teacher") || "").trim();
  const adminKey = (env.TEACHER_KEY || "").trim();
  let me = null;                                   // { id, email, name, admin }
  if (hdr && adminKey && sameHex(hdr, adminKey)) me = { id:"admin", email:(env.ADMIN_EMAIL||"admin").toLowerCase(), name:"Admin", admin:true, verified:true, active:true };
  else {
    const syncKey = (request.headers.get("X-LOCKqz-Sync") || "").trim();
    const t = hdr ? await db.prepare("SELECT id,email,name,role,active_until,verified,bs_user_id,vouched FROM teachers WHERE token=?").bind(hdr).first().catch(()=>null)
          : syncKey ? await db.prepare("SELECT id,email,name,role,active_until,verified,bs_user_id,vouched FROM teachers WHERE sync_key=?").bind(syncKey).first().catch(()=>null) : null;
    const trial = !!t && isExempt(env, t.email) && (Number(t.vouched) === 1 || t.verified === 1);
    if (t) me = { id:t.id, email:t.email, name:t.name, admin: t.role === "admin", trial, verified: t.role === "admin" || t.verified === 1, active: t.role === "admin" || trial || (!!t.active_until && t.active_until >= laToday()), active_until: t.active_until||null, bs_user_id: t.bs_user_id||null, vouched: t.role === "admin" || Number(t.vouched) === 1 || t.verified === 1 };
  }
  const clientIp = request.headers.get("CF-Connecting-IP") || "?";
  // The sync key (in the bookmarklet URL, readable by any script on the Brightspace page) authorizes
  // ONLY the Brightspace-connector endpoints. Account management needs the real session token.
  const viaSyncKey = !!(request.headers.get("X-LOCKqz-Sync") || "").trim() && !(hdr && adminKey && sameHex(hdr, adminKey)) && !(hdr);
  // Not /bs (every class list with student emails: FERPA) and not /synckey (would let a leaked key rotate
  // itself and lock the professor's real bookmark out): the Sync tab never calls either; the dashboard
  // uses the session token.
  const SYNC_OK = new Set(["/sync","/sync-result","/protect","/gate","/rotating","/rotated","/submitted","/live","/me"]);
  const teacher = () => !!me;
  const mine = (col="teacher_id") => me.admin ? { sql:"1=1", args:[] } : { sql:`${col}=?`, args:[me.id] };
  // Only the INSTRUCTOR of a course (named Instructor on a roster an admin or verified professor synced)
  // may act on it. TAs NEVER qualify -- a TA could otherwise reach the other classes they are in.
  // The admin is the sole exception, handled by me.admin at each call site.
  const EMAIL = String(me && me.email || "").toLowerCase();
  // C4: instructor role names (schools name them differently); TAs (Teaching Assistant) never match.
  const INSTR_SQL = "(r.role LIKE '%nstructor%' OR r.role LIKE '%rofessor%' OR r.role LIKE '%aculty%' OR r.role LIKE '%eacher%' OR r.role LIKE '%ecturer%' OR r.role LIKE '%utor%' OR r.role LIKE '%ourse Leader%')";
  // A roster row r is TRUSTED when an admin or a verified professor has synced that course.
  // (teacher_id 'admin' = a sync made with the master key; real account ids never look like that.)
  const TRUSTED_TC = "EXISTS (SELECT 1 FROM teacher_courses tct LEFT JOIN teachers tet ON tet.id=tct.teacher_id WHERE tct.ou=r.ou AND (tct.teacher_id='admin' OR tet.role='admin' OR tet.verified=1))";
  // Roles LOCKqz locks during quizzes: everyone except the course's instructors (Learners and TAs).
  const INSTR_RE = /nstructor|rofessor|aculty|eacher|ecturer|utor|ourse leader/i;
  const takesQuizzes = role => !INSTR_RE.test(String(role||"")) && !!String(role||"").trim();
  // Emails are stored lowercase (devices.student is indexed and joined to roster.email).
  const lowMail = s => (s && String(s).includes("@")) ? String(s).toLowerCase() : s;
  const vt = v => String(v||"0").split(".").map(n => parseInt(n,10)||0);
  const newerOrSame = (a, b) => { const x = vt(a), y = vt(b); for (let i = 0; i < 3; i++) if ((x[i]||0) !== (y[i]||0)) return (x[i]||0) > (y[i]||0); return true; };
  // The helper was silent longer than the live window and is back: record the gap (writes nothing
  // in the normal case). Must run BEFORE the lock row is refreshed.
  const gapStmt = (db, device_id, qid) => db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) SELECT device_id,(SELECT student FROM devices WHERE device_id=?),quiz_id,'lock_gap','{\"from\":\"'||last_lock||'\"}',? FROM locks WHERE device_id=? AND quiz_id=? AND last_lock<?")
    .bind(device_id, now(), device_id, qid, new Date(Date.now() - STALE_MS).toISOString());
  // C9: may the helper unlock now on the server's word? "quiz_submitted" = the professor's Sync tab
  // saw this student complete the quiz after this lock began; "quiz_ended" = the quiz is GATED right
  // now (so LOCKqz knows every accommodation: the gate's kept special-access list), the student is not
  // in that list, this lock began before the end, and the end passed (+15 min, the helper's cap grace).
  // Never for a non-gated quiz: the server cannot see Brightspace special access there (makeup exams,
  // extended end dates), and bs_quizzes.end_date may be stale. A stopped gate (gated=0) never ends one.
  async function serverUnlock(dev, device_id, qid) {
    const [ou, qi] = qid.split("-");
    const em = dev && dev.student && (!codesOn || Number(dev.student_verified) === 1) ? String(dev.student).toLowerCase() : null;
    const r = await db.prepare("SELECT b.end_date AS end_date, q.gated AS gated, q.sa_keep AS sa_keep, (SELECT locked_at FROM locks WHERE device_id=? AND quiz_id=?) AS locked_at, r.user_id AS uid, (SELECT s.at FROM submissions s WHERE s.ou=? AND s.qi=? AND s.user_id=r.user_id) AS sub_at FROM (SELECT 1) one LEFT JOIN bs_quizzes b ON b.ou=? AND b.qi=? LEFT JOIN quizzes q ON q.ou=? AND q.qi=? LEFT JOIN roster r ON r.ou=? AND r.email=?")
      .bind(device_id, qid, ou, qi, ou, qi, ou, qi, ou, em).first();
    if (!r) return null;
    if (r.sub_at && r.locked_at && Date.parse(r.sub_at) >= Date.parse(r.locked_at)) return "quiz_submitted";
    const end = r.end_date ? Date.parse(r.end_date) : NaN, began = r.locked_at ? Date.parse(r.locked_at) : NaN;
    if (Number(r.gated) === 1 && !isNaN(end) && !isNaN(began) && began <= end && Date.now() > end + 15 * 60000) {
      let kept = true;   // unreadable list = assume accommodated (never release on doubt)
      try { kept = !r.uid || JSON.parse(r.sa_keep || "[]").map(String).includes(String(r.uid)); } catch {}
      if (!kept) return "quiz_ended";
    }
    return null;
  }
  // Per course: owned = an admin, or a verified professor who is INSTRUCTOR (same email + Brightspace
  // id) on that course's roster, has synced it; trusted = any admin/verified account has synced it.
  async function ownerInfo(ous) {
    const out = {};
    for (const part of chunk([...new Set(ous.map(String))].filter(o => /^\d+$/.test(o)), 99)) {
      const rows = (await db.prepare(`SELECT tc.ou AS ou,
          MAX(CASE WHEN tc.teacher_id='admin' OR te.role='admin' THEN 1 WHEN te.verified=1 AND EXISTS (SELECT 1 FROM roster r WHERE r.ou=tc.ou AND lower(r.email)=lower(te.email) AND r.user_id=te.bs_user_id AND ${INSTR_SQL}) THEN 1 ELSE 0 END) AS owned,
          MAX(CASE WHEN tc.teacher_id='admin' OR te.role='admin' OR te.verified=1 THEN 1 ELSE 0 END) AS trusted
        FROM teacher_courses tc LEFT JOIN teachers te ON te.id=tc.teacher_id WHERE tc.ou IN (${placeholders(part.length)}) GROUP BY tc.ou`).bind(...part).all()).results;
      for (const r of rows) out[String(r.ou)] = { owned: Number(r.owned) === 1, trusted: Number(r.trusted) === 1 };
    }
    return out;
  }
  // Retention (H15, privacy.html: 120 days): bounded clean-up of old rows (<= ~1,000 rows, cheap index
  // reads). Runs in every /sync and, so retention holds without any Sync, inside 1 in PURGE_EVERY
  // (default 200) device /report batches -- no extra D1 query (same batch).
  const purgeStmts = () => {
    const ago = d => new Date(Date.now() - d * 86400000).toISOString();
    return [db.prepare("DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY id LIMIT 300) AND ts<?").bind(ago(EVENT_DAYS)),
      db.prepare("DELETE FROM events WHERE id IN (SELECT id FROM events WHERE event IN ('login_fail','pay_code_new','pay_start','pay_stripe','pay_bank','signup','code_sent','code_send_failed') AND ts<? LIMIT 300)").bind(ago(2)),
      db.prepare("DELETE FROM events WHERE id IN (SELECT id FROM events WHERE event='reset_request' AND ts<? LIMIT 100)").bind(ago(30)),
      db.prepare("DELETE FROM email_codes WHERE expires<?").bind(Date.now() - 86400000)];
  };
  // REQUIRE_GATE=1: every LOCKqz-protected quiz is gated (the Sync tab hides it and admits only students
  // LOCKqz is locking, and starts the gate by itself), and no password is given for a protected quiz
  // that is not gated while it can still be taken -- so a password passed around opens nothing.
  const gateRequired = () => String(env.REQUIRE_GATE || "") === "1";
  const nudgeGate = async (ou, qi) => {
    try {
      if (!codesOn) return false;
      const since = new Date(Date.now() - 3600000).toISOString(), key = "gate:" + qi;
      const t = await db.prepare("SELECT t.email AS email, tc.name AS course FROM teacher_courses tc JOIN teachers t ON t.id=tc.teacher_id WHERE tc.ou=? AND (t.verified=1 OR t.role='admin') AND NOT EXISTS (SELECT 1 FROM sync_nudges n WHERE n.ou=? AND n.qi=? AND n.at>?) ORDER BY t.role='admin' LIMIT 1")
        .bind(ou, ou, key, since).first();
      if (!t || !t.email) return false;
      await db.prepare("INSERT OR REPLACE INTO sync_nudges (ou,qi,at) VALUES (?,?,?)").bind(ou, key, now()).run();
      const course = String(t.course || "your class").replace(/^\d+_\d+\s*/, "").slice(0, 120);
      const text = `A student is waiting to start a LOCKqz quiz in ${course}, but its gate is not running, so LOCKqz is holding the password.\n\nOpen Brightspace and click your LOCKqz Sync bookmark, and leave that tab open during the quiz. The gate starts by itself and the student gets in.\n\nLOCKqz`;
      const go = sendMail(env, t.email, "LOCKqz: open your Sync tab — a student is waiting", text).catch(() => {});
      if (typeof context.waitUntil === "function") context.waitUntil(go); else await go;
      return true;
    } catch { return false; }
  };
  const purgeDue = () => Math.random() * Math.max(1, Number(env.PURGE_EVERY || 200)) < 1;
  // A student opened a quiz LOCKqz has never seen (made after the professor's last Sync, so it carries no
  // LOCKqz password): email that course's professor once per quiz, at most once per 6 h per course.
  // Costs one read, and one row written only when an email goes out.
  const nudgeUnsynced = async (ou, qi) => {
    try {
      if (!codesOn) return false;
      const since = new Date(Date.now() - 6 * 3600000).toISOString();
      const t = await db.prepare("SELECT t.email AS email, tc.name AS course FROM teacher_courses tc JOIN teachers t ON t.id=tc.teacher_id WHERE tc.ou=? AND (t.verified=1 OR t.role='admin') AND NOT EXISTS (SELECT 1 FROM sync_nudges n WHERE n.ou=? AND (n.qi=? OR n.at>?)) ORDER BY t.role='admin' LIMIT 1")
        .bind(ou, ou, qi, since).first();
      if (!t || !t.email) return false;
      const ins = await db.prepare("INSERT OR IGNORE INTO sync_nudges (ou,qi,at) VALUES (?,?,?)").bind(ou, qi, now()).run();
      if (!ins.meta.changes) return false;
      const course = String(t.course || "your class").replace(/^\d+_\d+\s*/, "").slice(0, 120);
      const text = `A student just opened a quiz in ${course} that LOCKqz has not seen yet, so it has no LOCKqz password.\n\nOpen Brightspace and click your LOCKqz Sync bookmark. (A Sync tab left open re-syncs by itself every 15 minutes.)\n\nLOCKqz`;
      const go = sendMail(env, t.email, "LOCKqz: click Sync for your new quiz", text).catch(() => {});
      if (typeof context.waitUntil === "function") context.waitUntil(go); else await go;
      return true;
    } catch { return false; }
  };
  // ---- per-section billing ($1,000 per section per semester) ----
  // A Brightspace course (ou) is paid when the professor paid for the USC section(s) it holds.
  // Admin and an account-wide activation (active_until) count as paid for everything.
  const PRICE = 5000;   // flat, per professor per semester (all their sections); paid = admin Activate until the semester end
  const secNums = txt => (String(txt).match(/(?<!\d)\d{5}(?!\d)/g) || []);
  const courseKeys = txt => { const out = new Set(); const re = /(?<![A-Z])([A-Z]{2,5})[\s_\-]*(\d{3}[A-Z]?)(?![0-9])/g; let m; while ((m = re.exec(String(txt).toUpperCase()))) out.add(m[1] + m[2]); return [...out]; };
  const ckey = c => String(c||"").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const paidCache = new Map();   // per request: teacher id -> paid_sections rows; `${id}:${ou}` -> bool
  async function paidOuFor(t, ou) { return (await paidOusFor(t, [ou])).has(String(ou)); }
  // Batched: a section-billed professor with 20 courses costs ~4 queries, not ~1 per course.
  async function paidOusFor(t, list) {
    const ous = [...new Set(list.map(String))].filter(o => /^\d+$/.test(o)), out = new Set();
    if (!t || !ous.length) return out;
    if (t.admin || t.active) { ous.forEach(o => out.add(o)); return out; }
    const todo = ous.filter(o => { const k = `${t.id}:${o}`; if (paidCache.has(k)) { if (paidCache.get(k)) out.add(o); return false; } return true; });
    if (!todo.length) return out;
    if (!paidCache.has(t.id)) paidCache.set(t.id, (await db.prepare("SELECT term,section,course,first,last FROM paid_sections WHERE teacher_id=? AND until>=?").bind(t.id, laToday()).all().catch(()=>({results:[]}))).results);
    const paid = paidCache.get(t.id);
    const done = (o, v) => { paidCache.set(`${t.id}:${o}`, v); if (v) out.add(o); };
    if (!paid.length) { todo.forEach(o => done(o, false)); return out; }
    const tcs = new Map();
    for (const part of chunk(todo, 98))
      for (const r of (await db.prepare(`SELECT ou,name,code,teacher_id FROM teacher_courses WHERE ou IN (${placeholders(part.length)})`).bind(...part).all()).results) {
        const k = String(r.ou), cur = tcs.get(k);
        if (!cur || (r.teacher_id === t.id && cur.teacher_id !== t.id)) tcs.set(k, r);   // the caller's own row first
      }
    const paidSec = new Set(paid.map(x => String(x.section)));
    const txtOf = o => { const tc = tcs.get(o); return tc ? `${tc.name||""} ${tc.code||""}` : null; };
    // Section numbers named by any shell -> which real USC course each belongs to (one query per 99).
    const allNums = [...new Set(todo.flatMap(o => txtOf(o) ? secNums(txtOf(o)) : []))];
    const realSec = new Map();
    for (const part of chunk(allNums, 99))
      for (const r of (await db.prepare(`SELECT section,course FROM usc_sections WHERE section IN (${placeholders(part.length)})`).bind(...part).all()).results)
        (realSec.get(String(r.section)) || realSec.set(String(r.section), []).get(String(r.section))).push(r);
    const teachAll = new Map();   // "term|last|first" -> sections that person teaches (one query each, usually one)
    const taught = async h => { const k = `${h.term}|${String(h.last||"").toLowerCase()}|${String(h.first||"").toLowerCase()}`;
      if (!teachAll.has(k)) teachAll.set(k, (await db.prepare("SELECT DISTINCT section,course FROM usc_sections WHERE term=? AND lower(last)=lower(?) AND lower(first)=lower(?)").bind(h.term, h.last||"", h.first||"").all()).results);
      return teachAll.get(k); };
    for (const o of todo) {
      const txt = txtOf(o);
      if (txt === null) { done(o, false); continue; }
      const nums = secNums(txt);
      if (nums.some(n => paidSec.has(n))) { done(o, true); continue; }
      let ok = false;
      for (const c of courseKeys(txt)) {
        const here = paid.filter(x => ckey(x.course) === c);
        if (!here.length) continue;
        // The shell names specific real sections of this course, none of them paid -> not paid.
        if (nums.length && nums.some(n => (realSec.get(n) || []).some(r => ckey(r.course) === c))) continue;
        // Combined shell (no section numbers): every section of this course the professor teaches must be paid.
        const all = (await taught(here[0])).filter(r => ckey(r.course) === c);
        if (!all.length || all.every(r => paidSec.has(String(r.section)))) { ok = true; break; }
      }
      done(o, ok);
    }
    return out;
  }
  const paidOu = ou => paidOuFor(me, ou);
  // Release every quiz this professor protects in a course that is not paid (next Sync removes the
  // password from Brightspace, so no student is locked out).
  async function releaseUnpaid(t) {
    if (!t || t.admin || t.active) return;          // fully active: nothing to release (no query)
    const qs = (await db.prepare("SELECT qi,ou,password FROM quizzes WHERE teacher_id=? AND ou IS NOT NULL").bind(t.id).all()).results;
    if (!qs.length) return;
    const paidSet = await paidOusFor(t, qs.map(q => String(q.ou)));
    // Co-taught course: another trusted instructor of it who is active (or has paid sections) keeps
    // its quizzes protected (I-M8). One query for all unpaid courses.
    const unpaidOus = [...new Set(qs.map(q => String(q.ou)).filter(o => !paidSet.has(o)))];
    const covered = new Set();
    for (const part of chunk(unpaidOus, 90))
      (await db.prepare(`SELECT DISTINCT r.ou AS ou FROM roster r JOIN teachers te ON te.email=r.email AND te.bs_user_id=r.user_id WHERE r.ou IN (${placeholders(part.length)}) AND te.id<>? AND (te.role='admin' OR (te.verified=1 AND (te.active_until>=? OR EXISTS (SELECT 1 FROM paid_sections ps WHERE ps.teacher_id=te.id AND ps.until>=?)))) AND ${INSTR_SQL} AND ${TRUSTED_TC}`)
        .bind(...part, t.id, laToday(), laToday()).all()).results.forEach(x => covered.add(String(x.ou)));
    const st = [];
    for (const q of qs) {
      const ou = String(q.ou);
      if (paidSet.has(ou) || covered.has(ou)) continue;
      st.push(db.prepare("INSERT OR REPLACE INTO pending_clear (ou,qi,password) VALUES (?,?,?)").bind(ou, String(q.qi), q.password));
      st.push(db.prepare("DELETE FROM quizzes WHERE qi=? AND ou=? AND teacher_id=?").bind(q.qi, ou, t.id));
    }
    await runBatches(db, st);
  }
  // [current term, next term] by USC's calendar (TERMS below): the term in session, or between terms
  // the one that just ended (so a payment then counts for the next one).
  const curTerms = () => { const d = laToday(); let c = payTerm(d); if (d < termDates(c)[0]) c = prevTerm(c); return [c, nextTerm(c)]; };
  const splitName = n => { const w = String(n||"").trim().split(/\s+/).filter(Boolean); return w.length >= 2 ? { first: w[0], last: w[w.length-1] } : null; };
  async function payCode(tid) {
    const ex = await db.prepare("SELECT code FROM pay_codes WHERE teacher_id=?").bind(tid).first();
    if (ex) return ex.code;
    // Professor memo = "LQ" + 5 (7 chars); student = "LQS" + 5 (8 chars). Never start a professor code
    // with S, so a memo is never ambiguous to a person reading it (settle() goes by length anyway).
    let code; do { code = "LQ" + rid(5).toUpperCase(); } while (code[2] === "S");
    await db.prepare("INSERT OR IGNORE INTO pay_codes (teacher_id,code) VALUES (?,?)").bind(tid, code).run();
    return (await db.prepare("SELECT code FROM pay_codes WHERE teacher_id=?").bind(tid).first()).code;
  }
  // The professor's USC sections (public Schedule of Classes), with what is paid.
  async function sectionsFor(tid, name) {
    const nm = splitName(name);
    const [cur, nxt] = curTerms();
    if (!nm) return { name: name||null, sections: [] };
    let rows = (await db.prepare("SELECT term,section,course,title,first,last FROM usc_sections WHERE term IN (?,?) AND lower(last)=lower(?) AND lower(first)=lower(?) ORDER BY term,course,section").bind(cur, nxt, nm.last, nm.first).all()).results;
    if (!rows.length) rows = (await db.prepare("SELECT term,section,course,title,first,last FROM usc_sections WHERE term IN (?,?) AND lower(last)=lower(?) AND lower(first) LIKE lower(?) ORDER BY term,course,section").bind(cur, nxt, nm.last, nm.first.slice(0,1) + "%").all()).results;
    const paid = new Map((await db.prepare("SELECT term,section,until FROM paid_sections WHERE teacher_id=?").bind(tid).all()).results.map(r => [r.term + ":" + r.section, r.until]));
    const today = laToday();
    const seen = new Set(), sections = [];
    for (const r of rows) { const k = r.term + ":" + r.section; if (seen.has(k)) continue; seen.add(k);
      const u = paid.get(k); sections.push({ ...r, paid: !!u && u >= today, paid_until: u || null }); }
    // Show the current term if it has sections, else the next one.
    const term = sections.some(x => x.term === cur) ? cur : (sections.length ? nxt : cur);
    return { name: `${nm.first} ${nm.last}`, term, sections: sections.filter(x => x.term === term) };
  }
  // ---- payments: Venmo / Zelle, matched automatically from the payment alert emails ----
  // A Google Apps Script in the Gmail that receives the Venmo/Zelle alerts posts each payment to
  // /pay/notify. The memo code (LQSxxxxx student, LQxxxxx professor) says who paid.
  const STUDENT_FEE = Number(env.STUDENT_FEE || 180);
  // Student payment routes (no fees): Zelle (the business account's Zelle when ZELLE_BUSINESS_TO is set)
  // and bank transfer by invoice. Venmo only if STUDENT_VENMO=1 (off: personal Venmo bans business use).
  const stuZelle = () => String(env.ZELLE_BUSINESS_TO || env.ZELLE_TO || "") || null;
  const stuVenmo = () => env.STUDENT_VENMO === "1" ? ((env.VENMO_HANDLE || "").replace(/^@/, "") || null) : null;
  const stuBank = () => String(env.INVOICE_EMAIL || env.ADMIN_EMAIL || "") || null;
  // ---- income tax on top (Anthony, 26 Oct 2026). From TAX_FROM on, every price = base / (1 - TAX_RATE), so
  // LOCKqz keeps the base after setting aside income tax; the payer sees "Tax & fees (23%)" as its own line.
  // Bases: Zelle and bank transfer = the fee ($180 student, $5,000 professor); Venmo and PO =
  // STUDENT_OTHER_PRICE ($200) / PROF_OTHER_PRICE; card = STUDENT_CARD_PRICE / PROF_CARD_PRICE.
  // A payment counts by how it came: credit = amount x fee / that way's total (a $240 Zelle = $180 of a
  // student's fee; a $266.67 Venmo = $180). Payments received before TAX_FROM count 1:1, as before.
  const TAX_FROM = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z)?$/.test(String(env.TAX_FROM || "")) ? String(env.TAX_FROM) : "";
  const taxOn = () => !!TAX_FROM;
  const TAX_RATE = taxOn() ? Math.min(0.6, Math.max(0, Number(env.TAX_RATE) || 0)) : 0;
  const grossUp = x => Math.round(Number(x) * 100 / (1 - TAX_RATE)) / 100;
  const WAYS = ["zelle", "bank", "venmo", "card", "po"];
  const wayOf = via => { via = String(via || "").toLowerCase(); return via === "venmo" ? "venmo" : via === "stripe-card" ? "card" : via === "stripe-bank" ? "sbank" : via === "po" ? "po" : "zelle"; };
  const isStu = code => /^LQS[A-Z0-9]{5}$/.test(String(code || ""));
  const baseOf = (kind, way) => {
    const n = (v, d) => Number(v) > 0 ? Number(v) : d, other = way === "venmo" || way === "po";
    if (kind === "student") return way === "card" ? n(env.STUDENT_CARD_PRICE, 200) : way === "sbank" ? n(env.STUDENT_BANK_PRICE, 181.45) : other && taxOn() ? n(env.STUDENT_OTHER_PRICE, 200) : STUDENT_FEE;
    return way === "card" ? n(env.PROF_CARD_PRICE, 5150) : way === "sbank" ? n(env.PROF_BANK_PRICE, 5005) : other && taxOn() ? n(env.PROF_OTHER_PRICE, PRICE) : PRICE;
  };
  const feeOf = kind => kind === "student" ? STUDENT_FEE : PRICE;
  // Whole-number totals (Anthony, 26 Oct 06:05): students $240 Zelle / bank, $270 Venmo / card / PO; professors
  // $6,500, card $6,700. Tax & fees = TAX_RATE of the total. A way without a set total = base / (1 - TAX_RATE).
  const setTotal = (kind, way) => { const v = Number(kind === "student" ? (way === "zelle" ? env.STUDENT_TOTAL : way === "sbank" ? 0 : env.STUDENT_OTHER_TOTAL)
                                                                       : (way === "card" ? env.PROF_CARD_TOTAL : way === "sbank" ? 0 : env.PROF_TOTAL)); return v > 0 ? v : 0; };
  const totalOf = (kind, way) => { way = way === "bank" ? "zelle" : way; return setTotal(kind, way) || grossUp(baseOf(kind, way)); };
  const factorOf = (kind, way) => taxOn() ? feeOf(kind) / totalOf(kind, way) : 1;
  const creditOf = (code, via, amount) => Number(amount) * factorOf(isStu(code) ? "student" : "professor", wayOf(via));
  // The same credit in SQL, for every SUM over payments.
  const CREDIT = () => { if (!taxOn()) return "amount";
    const f = k => { const w = way => factorOf(k, way).toFixed(12); return `(CASE lower(COALESCE(via,'')) WHEN 'venmo' THEN ${w("venmo")} WHEN 'stripe-card' THEN ${w("card")} WHEN 'stripe-bank' THEN ${w("sbank")} WHEN 'po' THEN ${w("po")} ELSE ${w("zelle")} END)`; };
    return `(CASE WHEN COALESCE(received_at,'') < '${TAX_FROM}' THEN amount ELSE amount * (CASE WHEN length(code)=8 AND substr(code,1,3)='LQS' THEN ${f("student")} ELSE ${f("professor")} END) END)`; };
  const FULL = (sum, fee) => Number(sum) >= fee - 0.005;   // credits are fractions of cents
  // What each way costs for what is still owed (credit left): { total, base, tax }.
  const waysFor = (kind, left) => Object.fromEntries(WAYS.map(w => {
    const total = Math.max(0, Math.ceil(Number(left) / factorOf(kind, w) * 100 - 1e-6) / 100), base = Math.round(total * (1 - TAX_RATE) * 100) / 100;   // tax & fees = TAX_RATE of the total
    return [w, { total, base, tax: Math.round((total - base) * 100) / 100 }]; }));
  const taxInfo = () => taxOn() ? { rate: TAX_RATE, label: String(env.TAX_LABEL || "Tax & fees").slice(0, 40) } : null;
  // ---- Stripe: card + US bank account (ACH). Off until STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET are set.
  // Prices carry Stripe's fee so LOCKqz nets at least the base price: card 2.9% + 30c (student $200
  // nets $193.90; professor $5,150 nets $5,000.05), bank 0.8% capped at $5 (student $181.45 nets $180;
  // professor $5,005 nets $5,000). Only Stripe's signed webhook records a payment; the amount is Stripe's.
  const stripeOn = () => !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
  const cts = (v, d) => { const n = Math.round(Number(v || d) * 100); return n > 0 ? n : Math.round(d * 100); };
  // Cents to charge for what is still due (cents): the set price when nothing is paid yet, else the
  // remainder grossed up by Stripe's fee.
  const stripeCents = (kind, method, dueC) => {
    if (taxOn()) return dueC > 0 ? Math.max(50, Math.ceil(dueC / factorOf(kind, method === "card" ? "card" : "sbank") - 1e-6)) : 0;
    const fullC = Math.round((kind === "student" ? STUDENT_FEE : PRICE) * 100);
    const set = kind === "student" ? (method === "card" ? cts(env.STUDENT_CARD_PRICE, 200) : cts(env.STUDENT_BANK_PRICE, 181.45))
                                   : (method === "card" ? cts(env.PROF_CARD_PRICE, 5150) : cts(env.PROF_BANK_PRICE, 5005));
    if (dueC >= fullC) return set;
    if (dueC <= 0) return 0;
    return method === "card" ? Math.max(50, Math.ceil((dueC + 30) / 0.971)) : Math.min(Math.ceil(dueC / 0.992), dueC + 500);
  };
  // Stripe bank account (ACH) is OFF unless STRIPE_BANK="1": a consumer can return an ACH debit for up to
  // 60 days, while Zelle and a bank transfer the payer sends cannot be pulled back. Card stays on.
  const stripeBank = () => String(env.STRIPE_BANK || "0") === "1";
  const stripeInfo = (kind, dueC) => stripeOn() && dueC > 0 ? { card: stripeCents(kind, "card", dueC) / 100, bank: stripeBank() ? stripeCents(kind, "bank", dueC) / 100 : null } : null;
  async function stripeCheckout({ kind, method, code, email, term, dueC, back }) {
    const amt = stripeCents(kind, method, dueC);
    const f = new URLSearchParams({
      mode: "payment", "payment_method_types[0]": method === "card" ? "card" : "us_bank_account",
      "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(amt),
      "line_items[0][price_data][product_data][name]": `LOCKqz ${kind === "student" ? "student" : "professor"} · ${({1:"Spring",2:"Summer",3:"Fall"})[String(term).slice(4)] || ""} ${String(term).slice(0,4)}`.trim(),
      client_reference_id: code, "metadata[code]": code, "metadata[kind]": kind, "metadata[term]": String(term),
      "payment_intent_data[metadata][code]": code, "payment_intent_data[description]": "LOCKqz " + code,
      success_url: back + (back.includes("?") ? "&" : "?") + "stripe=" + method, cancel_url: back });
    if (email) f.set("customer_email", email);
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions", { method: "POST", body: f,
      headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY, "Content-Type": "application/x-www-form-urlencoded" } });
    const d = await r.json().catch(() => ({}));
    return r.ok && d.url ? { url: d.url, amount: amt / 100 } : { error: "Card payments are not available right now. Try again in a minute." };
  }
  // Stripe-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body"> (5 minutes tolerance).
  async function stripeVerified(header, rawText) {
    const parts = Object.fromEntries(String(header||"").split(",").map(x => x.split("=")).filter(x => x.length === 2 && x[0] === "t").map(x => [x[0], x[1]]));
    const v1 = String(header||"").split(",").filter(x => x.startsWith("v1=")).map(x => x.slice(3));
    const t = Number(parts.t); if (!t || Math.abs(unixNow() - t) > 300 || !v1.length) return false;
    const want = await hmacHex(String(env.STRIPE_WEBHOOK_SECRET), `${parts.t}.${rawText}`);
    return v1.some(v => sameHex(v, want));
  }
  const feeOn = () => { const from = String(env.STUDENT_FEE_FROM || ""); return /^\d{4}-\d{2}-\d{2}$/.test(from) && laToday() >= from; };
  // ---- terms: USC's academic calendar (usc.edu/academic-calendar), codes YYYY1/2/3 ----
  // [first day of classes, last day of finals (summer: last day of classes)]. Access paid for a term
  // lasts through its last day; after that the person is unpaid until they pay for the next term.
  // Years not listed use typical USC dates until the table is updated.
  const TERMS = { "20263": ["2026-08-24","2026-12-16"], "20271": ["2027-01-11","2027-05-12"], "20272": ["2027-05-19","2027-08-10"] };
  const termDates = code => { code = String(code); return TERMS[code] || ({ 1:[`${code.slice(0,4)}-01-10`,`${code.slice(0,4)}-05-14`], 2:[`${code.slice(0,4)}-05-18`,`${code.slice(0,4)}-08-12`], 3:[`${code.slice(0,4)}-08-22`,`${code.slice(0,4)}-12-18`] })[code.slice(4)]; };
  const nextTerm = code => { const y = +String(code).slice(0,4), t = +String(code).slice(4); return t < 3 ? `${y}${t+1}` : `${y+1}1`; };
  const prevTerm = code => { const y = +String(code).slice(0,4), t = +String(code).slice(4); return t > 1 ? `${y}${t-1}` : `${y-1}3`; };
  const termEndOf = term => termDates(term)[1];
  const termEnd = () => termEndOf(curTerms()[0]);
  // After the last day of a term a payment is for the next term; termStartOf = its first day of classes.
  const classesEndOf = term => termDates(term)[1];
  const termStartOf = term => termDates(term)[0];
  // The term in session today, else the next one to start (used for renewal emails).
  const payTerm = (day = laToday()) => { let c = `${+day.slice(0,4) - 1}3`; for (let i = 0; i < 8; i++) { if (day <= termDates(c)[1]) return c; c = nextTerm(c); } return c; };
  const PAY_AHEAD_DAYS = 42;   // ~6 weeks before a term starts, a payment from someone already paid up -- or made in the last 2 weeks of classes -- counts for the next term (and still for what is left of this one)
  const ahead = () => { const [, nxt] = curTerms(); return laToday() >= new Date(Date.parse(termStartOf(nxt) + "T00:00:00Z") - PAY_AHEAD_DAYS * 86400000).toISOString().slice(0,10); };
  const inGap = () => laToday() > classesEndOf(curTerms()[0]);
  // Which term a new payment counts for, given what this code already paid this term (H7).
  // studentStatus and professor activation also honor a next-term payment for what is left of the current term.
  const nearEnd = () => { const ce = Date.parse(classesEndOf(curTerms()[0]) + "T00:00:00Z"), t = Date.parse(laToday() + "T00:00:00Z"); return ce - t <= 14 * 86400000; };
  const payTermFor = (paidThisTerm, price) => { const [cur, nxt] = curTerms(); return inGap() || (ahead() && (FULL(paidThisTerm, price) || (nearEnd() && !(Number(paidThisTerm) > 0)))) ? nxt : cur; };   // a balance on a part-paid term stays on that term
  const PAY_URL = "https://lockqz.pages.dev/pay";
  // The Gmail script's key: PAY_SECRET if set, else derived from the server's own secret (the admin
  // copies it from Admin -> Payments into the script once). Nothing new to configure in Cloudflare.
  const paySecret = async () => env.PAY_SECRET ? String(env.PAY_SECRET) : ((env.ROT_SECRET || env.TEACHER_KEY) ? "lqp_" + (await hmacHex(String(env.ROT_SECRET || env.TEACHER_KEY), "lockqz-pay-notify")).slice(0, 40) : "");
  // limitIp: the public /pay/start passes the caller's IP, so random emails cannot write unlimited rows.
  async function studentCode(email, limitIp = null) {
    email = String(email||"").trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
    const ex = await db.prepare("SELECT code FROM pay_codes_students WHERE email=?").bind(email).first();
    if (ex) return ex.code;
    if (limitIp) {
      const n = (await db.prepare("SELECT COUNT(*) AS n FROM events WHERE event='pay_code_new' AND ts>? AND device_id=?").bind(new Date(Date.now() - 3600000).toISOString(), "ip:" + limitIp).first()).n;
      if (n >= 20) return { limited: true };
      await db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)").bind("ip:" + limitIp, null, null, "pay_code_new", null, now()).run();
    }
    for (let i = 0; i < 5; i++) {
      const code = "LQS" + rid(5).toUpperCase().replace(/[^A-Z0-9]/g, "X");
      const r = await db.prepare("INSERT OR IGNORE INTO pay_codes_students (email,code) VALUES (?,?)").bind(email, code).run();
      if (r.meta.changes) return code;
      const again = await db.prepare("SELECT code FROM pay_codes_students WHERE email=?").bind(email).first(); if (again) return again.code;
    }
    return null;
  }
  // Voided payments and alerts waiting for the admin's review never count (H12, H9).
  const COUNTS = "COALESCE(matched,'') NOT IN ('void','review')";
  const paidSum = async (code, term) => Number((await db.prepare(`SELECT COALESCE(SUM(${CREDIT()}),0) AS s FROM payments WHERE code=? AND term=? AND ${COUNTS}`).bind(code, term).first())?.s || 0);
  // Paid = this term's fee paid, or (in the weeks before the next term / after classes end) the next term's.
  async function studentStatus(email) {
    email = String(email||"").trim().toLowerCase();
    const [cur, nxt] = curTerms();
    if (!email) return { paid: !feeOn(), received: 0, term: cur, code: null };
    const c = await db.prepare("SELECT code FROM pay_codes_students WHERE email=?").bind(email).first();
    const sums = { [cur]: 0, [nxt]: 0 }, money = { [cur]: 0, [nxt]: 0 };
    if (c) for (const r of (await db.prepare(`SELECT term, COALESCE(SUM(${CREDIT()}),0) AS s, COALESCE(SUM(amount),0) AS m FROM payments WHERE code=? AND term IN (?,?) AND ${COUNTS} GROUP BY term`).bind(c.code, cur, nxt).all()).results) { sums[r.term] = Number(r.s); money[r.term] = Number(r.m); }
    const early = ahead() || inGap();
    // After a term's last day its payment no longer counts (access ends with the term).
    const paidTerm = (!inGap() && FULL(sums[cur], STUDENT_FEE)) || (early && FULL(sums[nxt], STUDENT_FEE));
    const term = payTermFor(sums[cur], STUDENT_FEE);
    return { paid: !feeOn() || paidTerm, received: sums[term], money: money[term], term, code: c ? c.code : null };
  }
  async function studentPaid(email) {
    if (!feeOn()) return true;
    email = String(email||"").trim().toLowerCase(); if (!email) return false;
    const staff = await db.prepare("SELECT 1 FROM teachers WHERE email=? AND (role='admin' OR verified=1)").bind(email).first();
    if (staff || isExempt(env, email)) return true;             // professors, the admin and trial testers never pay the student fee
    return (await studentStatus(email)).paid;
  }
  // Many students at once (the gate's /live): the set of emails that may take the quiz (paid this term,
  // or staff). 3 reads total, any number of emails.
  async function paidEmails(list) {
    const ems = [...new Set(list.map(e => String(e||"").trim().toLowerCase()).filter(e => e.includes("@")))];
    const ok = new Set(); if (!ems.length) return ok;
    if (!feeOn()) { ems.forEach(e => ok.add(e)); return ok; }
    const j = JSON.stringify(ems), [cur, nxt] = curTerms(), early = ahead() || inGap();
    ems.forEach(e => { if (isExempt(env, e)) ok.add(e); });
    (await db.prepare("SELECT lower(email) AS e FROM teachers WHERE lower(email) IN (SELECT value FROM json_each(?)) AND (role='admin' OR verified=1)").bind(j).all()).results.forEach(r => ok.add(r.e));
    const codes = new Map((await db.prepare("SELECT email, code FROM pay_codes_students WHERE email IN (SELECT value FROM json_each(?))").bind(j).all()).results.map(r => [r.code, r.email]));
    if (!codes.size) return ok;
    const sums = {};
    for (const r of (await db.prepare(`SELECT code, term, COALESCE(SUM(${CREDIT()}),0) AS s FROM payments WHERE code IN (SELECT value FROM json_each(?)) AND term IN (?,?) AND ${COUNTS} GROUP BY code, term`).bind(JSON.stringify([...codes.keys()]), cur, nxt).all()).results) sums[r.code + "|" + r.term] = Number(r.s);
    for (const [c, e] of codes) if ((!inGap() && FULL(sums[c + "|" + cur] || 0, STUDENT_FEE)) || (early && FULL(sums[c + "|" + nxt] || 0, STUDENT_FEE))) ok.add(e);
    return ok;
  }
  async function paidEmailsCached(list, quiz) {
    const ttl = Number(env.PAID_CACHE_MS ?? PAID_TTL); if (!(ttl > 0)) return paidEmails(list);   // tests: 0 = off
    const t = Date.now(), ems = [...new Set(list.map(e => String(e||"").trim().toLowerCase()).filter(e => e.includes("@")))];
    const ok = new Set(); if (!ems.length) return ok;
    const ck = new Request(`${url.origin}/__lqz_cache/paid/${encodeURIComponent(quiz)}`);
    let shared = {};
    try { if (typeof caches !== "undefined" && caches.default) { const h = await caches.default.match(ck); if (h) shared = await h.json() || {}; } } catch {}
    const until = e => Math.max(PAID_MEM.get(e) || 0, Number(shared[e]) || 0);
    const todo = ems.filter(e => { if (until(e) > t) { ok.add(e); return false; } return true; });
    if (!todo.length) return ok;
    for (const e of await paidEmails(todo)) { ok.add(e); PAID_MEM.set(e, t + ttl); shared[e] = t + ttl; }
    if (PAID_MEM.size > 20000) PAID_MEM.clear();
    for (const e of Object.keys(shared)) if (!(Number(shared[e]) > t)) delete shared[e];
    try { if (typeof caches !== "undefined" && caches.default) await caches.default.put(ck, new Response(JSON.stringify(shared), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${Math.ceil(ttl / 1000)}` } })); } catch {}
    return ok;
  }
  // Unique Zelle amount (OFF unless ZELLE_UNIQUE="1"; Anthony chose one price + memo): each unpaid student
  // gets $fee + $0.01..$9.99 for the term, so a Zelle with no memo still says who paid. Freed once paid.
  const zelleUnique = () => String(env.ZELLE_UNIQUE || "0") === "1" && !taxOn();
  const slotAmt = c => Math.round(STUDENT_FEE * 100 + c) / 100;
  async function zelleAmount(code, term) {
    const has = await db.prepare("SELECT cents FROM pay_slots WHERE term=? AND code=?").bind(term, code).first();
    if (has) return slotAmt(has.cents);
    const used = new Set((await db.prepare("SELECT cents FROM pay_slots WHERE term=?").bind(term).all()).results.map(r => Number(r.cents)));
    for (let c = 1, tries = 0; c < 1000 && tries < 3; c++) {
      if (c % 100 === 0 || used.has(c)) continue;
      tries++;
      await db.prepare("INSERT OR IGNORE INTO pay_slots (term,cents,code,at) VALUES (?,?,?,?)").bind(term, c, code, now()).run();
      const mine = await db.prepare("SELECT cents FROM pay_slots WHERE term=? AND code=?").bind(term, code).first();
      if (mine) return slotAmt(mine.cents);
    }
    return null;   // all taken: the memo is needed
  }
  async function payInfo(email, limitIp = null, slot = false) {
    const code = await studentCode(email, limitIp);
    if (code && typeof code === "object") return code;   // { limited: true }
    let zelle_amount = null;
    if (slot && zelleUnique() && feeOn() && stuZelle() && email) { const st = await studentStatus(email); if (!st.paid && !(st.received > 0)) zelle_amount = await zelleAmount(code, st.term); }
    const got = email ? (await studentStatus(email)).received : 0;
    const due = Math.round(STUDENT_FEE * 100) - Math.round(got * 100);
    const cardOnly = String(env.STUDENT_CARD_ONLY||"") === "1" && stripeOn();   // students: card only, once Stripe is configured
    return { amount: STUDENT_FEE, code, venmo: cardOnly ? null : stuVenmo(), zelle: cardOnly ? null : stuZelle(), bank: cardOnly ? null : stuBank(), po: null, zelle_amount: cardOnly ? null : zelle_amount, stripe: stripeInfo("student", due),
             tax: taxInfo(), ways: taxOn() ? waysFor("student", Math.max(0, STUDENT_FEE - got)) : null, bank_auto: true,
             url: PAY_URL + (email ? "?email=" + encodeURIComponent(String(email).toLowerCase()) : "") };
  }
  // Memo codes typed by people: "lqs-ab12c", "LQS AB12C", "LQ AB12C". Student (LQS+5) first, then
  // professor (LQ+5; an older professor code may itself start with S).
  const memoCode = text => {
    const t = String(text||"").toUpperCase();
    let m = t.match(/(?<![A-Z0-9])LQ[\s-]?S[\s-]?([A-Z0-9]{5})(?![A-Z0-9])/);
    if (m) return "LQS" + m[1];
    m = t.match(/(?<![A-Z0-9])LQ[\s-]?([A-Z0-9]{5})(?![A-Z0-9])/);
    return m ? "LQ" + m[1] : null;
  };
  // Record payments (idempotent by txn = the provider's transaction id when the script could read it)
  // and apply them. Batched for /pay/notify: ~8 queries for 100 alerts (D1 Free: 50 per request).
  async function applyPayments(list) {
    const out = new Array(list.length).fill(null), items = [];
    list.forEach((p, i) => {
      p = p && typeof p === "object" ? p : {};
      const txn = String(p.txn||"").slice(0,120), amount = Number(p.amount), review = p.needs_review === true;
      if (!txn || !(review ? amount >= 0 || p.amount == null : amount > 0) || amount > 100000) { out[i] = { ok:false, error:"bad payment" }; return; }
      const alt = p.msg ? "gmail:" + String(p.msg).slice(0, 100) : null;   // same alert under its Gmail id
      items.push({ i, txn, alt, amount: Number.isFinite(amount) ? amount : 0, review, code: memoCode(`${p.note||""} ${p.subject||""}`),
        email: (String(p.note||"").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [])[0] || null,
        via: String(p.via||"").slice(0,20), payer: String(p.payer||"").slice(0,120), note: String(p.note||"").slice(0,300), why: str(p.review_reason, 120) });
    });
    const seen = new Set(), keys = [...new Set(items.flatMap(x => [x.txn, x.alt]).filter(Boolean))];
    for (const part of chunk(keys, 99)) (await db.prepare(`SELECT txn FROM payments WHERE txn IN (${placeholders(part.length)})`).bind(...part).all()).results.forEach(r => seen.add(r.txn));
    const fresh = [];
    for (const x of items) { if (seen.has(x.txn) || (x.alt && seen.has(x.alt))) out[x.i] = { ok:true, duplicate:true }; else { seen.add(x.txn); fresh.push(x); } }
    // Memo with an email instead of a code: that student's code (created if needed, at most 10 per call).
    const needEm = [...new Set(fresh.filter(x => !x.code && x.email).map(x => x.email.toLowerCase()))];
    const emCode = new Map();
    for (const part of chunk(needEm, 99)) (await db.prepare(`SELECT email, code FROM pay_codes_students WHERE email IN (${placeholders(part.length)})`).bind(...part).all()).results.forEach(r => emCode.set(r.email, r.code));
    let made = 0;
    for (const e of needEm) if (!emCode.has(e) && made++ < 10) { const c = await studentCode(e); if (typeof c === "string") emCode.set(e, c); }
    fresh.forEach(x => { if (!x.code && x.email) x.code = emCode.get(x.email.toLowerCase()) || null; });
    // No memo: a unique Zelle amount ($fee + 0.01..9.99) names the student who was given it.
    const [cur0, nxt0] = curTerms();
    const slotC = x => { const c = Math.round(x.amount * 100) - Math.round(STUDENT_FEE * 100); return !x.code && !x.review && c > 0 && c < 1000 && c % 100 ? c : null; };
    const want = [...new Set(fresh.map(slotC).filter(Boolean))];
    if (want.length && zelleUnique()) {
      const byC = new Map();
      for (const r of (await db.prepare(`SELECT cents, code FROM pay_slots WHERE term IN (?,?) AND cents IN (${placeholders(want.length)})`).bind(cur0, nxt0, ...want).all()).results)
        byC.set(Number(r.cents), byC.has(Number(r.cents)) && byC.get(Number(r.cents)) !== r.code ? null : r.code);   // same cents in both terms = ambiguous
      fresh.forEach(x => { const c = slotC(x); if (c && byC.get(c)) { x.code = byC.get(c); x.note = `${x.note} [amount match]`.trim().slice(0, 300); } });
    }
    // What each code already paid this term and next (for the term each new payment counts for).
    const [cur, nxt] = curTerms(), codes = [...new Set(fresh.map(x => x.code).filter(Boolean))], sums = new Map();
    for (const part of chunk(codes, 97)) (await db.prepare(`SELECT code, term, COALESCE(SUM(${CREDIT()}),0) AS s FROM payments WHERE code IN (${placeholders(part.length)}) AND term IN (?,?) AND ${COUNTS} GROUP BY code, term`).bind(...part, cur, nxt).all()).results.forEach(r => sums.set(r.code + "|" + r.term, Number(r.s)));
    const priceOf = c => /^LQS[A-Z0-9]{5}$/.test(c) ? STUDENT_FEE : PRICE;
    const rows = [], t = now();
    for (const x of fresh) {
      x.term = x.code ? payTermFor(sums.get(x.code + "|" + cur) || 0, priceOf(x.code)) : cur;
      if (x.code && !x.review) sums.set(x.code + "|" + x.term, (sums.get(x.code + "|" + x.term) || 0) + creditOf(x.code, x.via, x.amount));
      rows.push([x.txn, x.code, x.amount, x.via, x.payer, x.why ? `${x.note} [review: ${x.why}]`.slice(0, 400) : x.note, x.term, t, x.review ? "review" : null]);
    }
    await runBatches(db, multiInsert(db, "INSERT OR IGNORE INTO payments (txn,code,amount,via,payer,note,term,received_at,matched)", 9, rows));
    // Settle: students are paid by their sums (computed on read); professors get activated.
    const stu = codes.filter(c => /^LQS[A-Z0-9]{5}$/.test(c)), prof = codes.filter(c => !/^LQS[A-Z0-9]{5}$/.test(c));
    const stuEmail = new Map(), profId = new Map();
    for (const part of chunk(stu, 99)) (await db.prepare(`SELECT code, email FROM pay_codes_students WHERE code IN (${placeholders(part.length)})`).bind(...part).all()).results.forEach(r => stuEmail.set(r.code, r.email));
    for (const part of chunk(prof, 99)) (await db.prepare(`SELECT code, teacher_id FROM pay_codes WHERE code IN (${placeholders(part.length)})`).bind(...part).all()).results.forEach(r => profId.set(r.code, r.teacher_id));
    const acts = [];
    for (const x of fresh) {
      const total = x.code ? (sums.get(x.code + "|" + x.term) || 0) : 0;
      let res = { matched: null };
      if (x.review) res = { matched: null, review: true };
      else if (x.code && stuEmail.has(x.code)) { res = { matched: "student", email: stuEmail.get(x.code), paid: FULL(total, STUDENT_FEE), total, term: x.term };
        if (res.paid) acts.push(db.prepare("DELETE FROM pay_slots WHERE code=?").bind(x.code)); }
      else if (x.code && profId.has(x.code)) {
        const done = FULL(total, PRICE); res = { matched: "professor", paid: done, total, term: x.term };
        if (done) acts.push(db.prepare("UPDATE teachers SET active_until=? WHERE id=? AND (active_until IS NULL OR active_until<?)").bind(termEndOf(x.term), profId.get(x.code), termEndOf(x.term)));
      }
      out[x.i] = { ok: true, ...res };
    }
    await runBatches(db, acts);
    return out;
  }
  async function renewalTick() {
    if (!(env.MAIL_USER && env.MAIL_APP_PASSWORD) && typeof env.MAIL_SINK !== "function") return { sent: 0, why: "mail off" };
    const day = laToday(), cur = payTerm(day), [start] = termDates(cur), prev = prevTerm(cur);
    // Window: from 7 days before the term starts to 14 days after.
    const ms = d => Date.parse(d + "T12:00:00Z"), dd = (ms(day) - ms(start)) / 864e5;
    if (dd < -7 || dd > 14) return { sent: 0, why: "not renewal time", term: cur };
    const due = (await db.prepare(`SELECT DISTINCT s.email AS email, 'student' AS kind, s.code AS code FROM payments p JOIN pay_codes_students s ON s.code=p.code
        WHERE p.term=? AND s.email NOT IN (SELECT email FROM renew_optout) AND s.email NOT IN (SELECT email FROM renew_sent WHERE term=?)
        AND s.code NOT IN (SELECT code FROM payments WHERE term=? AND code IS NOT NULL)
      UNION SELECT DISTINCT t.email, 'professor', c.code FROM payments p JOIN pay_codes c ON c.code=p.code JOIN teachers t ON t.id=c.teacher_id
        WHERE p.term=? AND lower(t.email) NOT IN (SELECT email FROM renew_optout) AND lower(t.email) NOT IN (SELECT email FROM renew_sent WHERE term=?)
        AND (t.active_until IS NULL OR t.active_until < ?) LIMIT 20`).bind(prev, cur, cur, prev, cur, termEndOf(cur)).all()).results;
    let sent = 0;
    for (const r of due) {
      const email = String(r.email).toLowerCase(), amt = totalOf(r.kind === "student" ? "student" : "professor", "zelle");
      const link = r.kind === "student" ? `${PAY_URL}?email=${encodeURIComponent(email)}` : "https://prof.lockqz.pages.dev/";
      const text = `LOCKqz renews for the new semester.\n\n${r.kind === "student" ? `Pay $${amt.toLocaleString("en-US")}${taxOn() ? ` (includes ${taxInfo().label.toLowerCase()})` : ""} with memo ${r.code}:\n${link}\n\nZelle ${stuZelle()||""} (paste ${r.code} in the Zelle memo/note)${stripeOn() ? "  ·  Card" : ""}${stuVenmo() ? `  ·  Venmo @${stuVenmo()}` : ""}  ·  Bank transfer: email ${stuBank()||""}` : `Pay $${amt.toLocaleString("en-US")} with memo ${r.code}:\n${link}\n\nVenmo @${(env.VENMO_HANDLE||"").replace(/^@/,"")}  ·  Zelle ${env.ZELLE_TO||""}`}\n\nAccess turns on as soon as the payment arrives and lasts until ${termEndOf(cur)}.\n\nStop these emails: ${PAY_URL}?email=${encodeURIComponent(email)}&renew=off`;
      try {
        if (typeof env.MAIL_SINK === "function") await env.MAIL_SINK({ to: email, subject: "Renew LOCKqz", text });
        else await smtpSend(async () => (await import("cloudflare:sockets")).connect({ hostname: env.MAIL_HOST || "smtp.gmail.com", port: Number(env.MAIL_PORT || 465) }, { secureTransport: "on", allowHalfOpen: false }),
                            { user: env.MAIL_USER, pass: String(env.MAIL_APP_PASSWORD).replace(/\s+/g, ""), to: email, subject: "Renew LOCKqz", text });
        await db.prepare("INSERT OR IGNORE INTO renew_sent (email,term,at) VALUES (?,?,?)").bind(email, cur, now()).run();
        sent++;
      } catch (e) { break; }
    }
    return { sent, term: cur };
  }
  async function settle(code, term) {
    if (!code) return { matched:null };
    // By FORMAT, not prefix: student codes are "LQS"+5 (8 chars), professor codes "LQ"+5 (7 chars) --
    // an older professor code can itself start with "LQS" (e.g. LQSABCD).
    if (/^LQS[A-Z0-9]{5}$/.test(code)) {
      const st = await db.prepare("SELECT email FROM pay_codes_students WHERE code=?").bind(code).first();
      if (!st) return { matched:null };
      const sum = await paidSum(code, term);
      return { matched:"student", email: st.email, paid: FULL(sum, STUDENT_FEE), total: sum };
    }
    const pc = await db.prepare("SELECT teacher_id FROM pay_codes WHERE code=?").bind(code).first();
    if (!pc) return { matched:null };
    const sum = await paidSum(code, term), done = FULL(sum, PRICE);
    if (done) await db.prepare("UPDATE teachers SET active_until=? WHERE id=? AND (active_until IS NULL OR active_until<?)").bind(termEndOf(term), pc.teacher_id, termEndOf(term)).run();
    return { matched:"professor", paid: done, total: sum };
  }
  // A payment was voided (refund, dispute, failed bank payment, admin): a professor whose paid total
  // drops below the price loses the activation that payments gave (an admin's own Activate date is kept).
  async function unsettle(code) {
    if (!code || /^LQS[A-Z0-9]{5}$/.test(code)) return;   // students: computed on read, nothing to undo
    const pc = await db.prepare("SELECT c.teacher_id AS id, t.active_until AS until FROM pay_codes c JOIN teachers t ON t.id=c.teacher_id WHERE c.code=?").bind(code).first();
    if (!pc) return;
    const [cur, nxt] = curTerms();
    if (![termEndOf(cur), termEndOf(nxt)].includes(pc.until)) return;
    const want = FULL(await paidSum(code, nxt), PRICE) ? termEndOf(nxt) : FULL(await paidSum(code, cur), PRICE) ? termEndOf(cur) : null;
    if (want !== pc.until) await db.prepare("UPDATE teachers SET active_until=? WHERE id=?").bind(want, pc.id).run();
  }
  // Must be listed as Instructor on a TRUSTED roster for the course, by BOTH email and the caller's own
  // Brightspace user id (bound from a trusted roster at sync) -- so holding someone else's email is not
  // enough. Answers are cached per request (one query for many courses; D1 Free = 50 queries/request).
  const tiCache = new Map();
  async function trustedOus(list) {
    const ous = [...new Set(list.map(String))].filter(o => /^\d+$/.test(o)), out = new Set();
    if (!me || !EMAIL) return out;
    if (me.admin) { ous.forEach(o => out.add(o)); return out; }
    if (!me.bs_user_id) return out;
    for (const part of chunk(ous.filter(o => !tiCache.has(o)), 90)) {
      const hit = new Set((await db.prepare(`SELECT DISTINCT r.ou AS ou FROM roster r WHERE r.ou IN (${placeholders(part.length)}) AND r.email=? AND r.user_id=? AND ${INSTR_SQL} AND ${TRUSTED_TC}`)
        .bind(...part, EMAIL, String(me.bs_user_id)).all()).results.map(x => String(x.ou)));
      part.forEach(o => tiCache.set(o, hit.has(o)));
    }
    ous.forEach(o => { if (tiCache.get(o)) out.add(o); });
    return out;
  }
  const trustedInstructor = async ou => (await trustedOus([ou])).has(String(ou));
  // SQL: the courses the caller instructs (same rule as trustedOus), as a subquery with fixed params.
  const myOusSql = () => me.admin ? { sql: "SELECT ou FROM teacher_courses", args: [] }
    : { sql: `SELECT r.ou FROM roster r WHERE r.email=? AND r.user_id=? AND ${INSTR_SQL} AND ${TRUSTED_TC}`, args: [EMAIL, String(me.bs_user_id || "\u0000")] };
  // Load a quiz by (ou,qi) and confirm the caller instructs THAT course. Prevents acting on another
  // course's quiz by passing your own ou with a foreign qi.
  async function ownedQuiz(ou, qi) {
    if (!/^\d+$/.test(String(ou)) || !/^\d+$/.test(String(qi))) return { bad: true };
    if (!(me.admin || await trustedInstructor(ou))) return { forbidden: true };
    const row = await db.prepare("SELECT quiz_id,password,gated,sa_keep,bs_code,ou,teacher_id FROM quizzes WHERE ou=? AND qi=?").bind(String(ou), String(qi)).first();
    return { row };
  }
  // bs_quizzes.orig = JSON {pw?: string|null, hidden?: bool}: what the professor had set in Brightspace
  // before LOCKqz first changed the quiz. Saved once; cleared when the quiz is released.
  const withOrig = row => { let o = {}; try { o = JSON.parse(row.orig || "{}") || {}; } catch {}
    const { orig, ...r } = row;
    return { ...r, orig_password: "pw" in o ? o.pw : null, orig_password_saved: "pw" in o, orig_hidden: "hidden" in o ? !!o.hidden : null, orig_hidden_saved: "hidden" in o }; };
  async function bsState(ous) {
    ous = ous.map(String).filter(o => /^\d+$/.test(o));
    if (!ous.length) return { protect: [], clear: [] };
    const ph = ous.map(()=>"?").join(",");
    // Each row carries the professor's own settings saved before LOCKqz changed them (C3).
    const protect = (await db.prepare(`SELECT q.ou,q.qi,q.password,q.title,q.gated,b.orig FROM quizzes q LEFT JOIN bs_quizzes b ON b.ou=q.ou AND b.qi=q.qi WHERE q.ou IN (${ph}) AND q.qi IS NOT NULL`).bind(...ous).all()).results.map(withOrig);
    const clear = (await db.prepare(`SELECT c.ou,c.qi,c.password,b.orig FROM pending_clear c LEFT JOIN bs_quizzes b ON b.ou=c.ou AND b.qi=c.qi WHERE c.ou IN (${ph})`).bind(...ous).all()).results.map(withOrig);
    return { protect, clear };
  }

  try {
    // The Sync bookmark's key authorizes ONLY the Brightspace-connector endpoints (it is exposed in the
    // bookmarklet URL inside the Brightspace page). Everything else needs the real session token.
    if (viaSyncKey && !SYNC_OK.has(p)) return json({ error: "this action needs your LOCKqz login, not the Sync bookmark" }, 403);
    // ---- device endpoints (signed by the device key; see verifyDevice) ----
    if (p === "/blocklist") return json({ domains: AI_DOMAINS });
    // C7: what this host runs (deploy.sh compares lockqz.pages.dev and lockdownqz.pages.dev). No auth.
    if (p === "/version") return json({ ...buildInfo(), codes_on: codesOn, strict, fee_on: feeOn(), stripe: stripeOn() });

    // One-time device registration (trust on first use). A device id can never be re-keyed, so a
    // registered student's device cannot be taken over by registering the same id again.
    if (p === "/register" && request.method === "POST") {
      const id = String(body.device_id || "").trim(), key = String(body.key || "").trim().toLowerCase();
      if (!/^[A-Za-z0-9._-]{6,80}$/.test(id) || id === "unknown") return json({ error: "bad device id" }, 400);
      if (!/^[0-9a-f]{64}$/.test(key)) return json({ error: "bad key" }, 400);
      const regIp = request.headers.get("CF-Connecting-IP") || "?";
      const regN = (await db.prepare("SELECT COUNT(*) AS n FROM devices WHERE reg_ip=? AND registered_at>?").bind(regIp, new Date(Date.now()-3600000).toISOString()).first()).n;
      if (regN > 30) return json({ error: "too many registrations" }, 429);
      await db.prepare("INSERT INTO devices (device_id,student,platform,version,installed_at,last_seen,device_key,registered_at,reg_ip) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET device_key=excluded.device_key, registered_at=excluded.registered_at, reg_ip=excluded.reg_ip, platform=COALESCE(excluded.platform,devices.platform), version=COALESCE(excluded.version,devices.version), last_seen=excluded.last_seen WHERE devices.device_key IS NULL")
        .bind(id, lowMail(str(body.student)), str(body.platform, 60), str(body.version, 60), now(), now(), key, now(), request.headers.get("CF-Connecting-IP") || null).run();
      const d = await db.prepare("SELECT device_key, revoked FROM devices WHERE device_id=?").bind(id).first();
      if (d && d.revoked) return json({ error: "device revoked" }, 403);
      return d && sameHex(d.device_key, key) ? json({ ok: true, registered: true }) : json({ error: "device already registered" }, 409);
    }

    // Student email setup (asked ONCE per computer). Signed by the device key, so nobody can bind an
    // email to someone else's computer. ops: status | check (roster name) | send (email a code) | code.
    if (p === "/verify" && request.method === "POST") {
      const v = await verifyDevice(request, raw, db);
      if (!v.ok) return denied(v);
      const dev = v.id, op = String(body.op || ""), email = String(body.email || "").trim().toLowerCase();
      const d = v.dev;
      // Proof of a confirmed email, kept by the app on the computer (survives uninstall/reinstall), so a
      // student types their email + code ONCE EVER: a new install hands it back (op "token") instead.
      const vSecret = env.ROT_SECRET || env.TEACHER_KEY;
      const vtokenFor = async em => vSecret ? (await hmacHex(String(vSecret), "lqz-verified:" + em)).slice(0, 40) : null;
      if (op === "status") {
        const ver = Number(d?.student_verified) === 1 && !!d?.student;
        return json({ student: d?.student || null, verified: ver, codes: codesOn, ...(ver ? { vtoken: await vtokenFor(String(d.student).toLowerCase()) } : {}) });
      }
      if (!EMAIL_OK(email)) return json({ error: "bad_email" }, 400);
      const rosterName = async () => (await db.prepare("SELECT name FROM roster WHERE email=? AND name IS NOT NULL LIMIT 1").bind(email).first())?.name || null;
      const since = ms => new Date(Date.now() - ms).toISOString();
      // H5: limits per computer (5/h, 15/day), per RECIPIENT across computers (3/h, 5/day), per IP
      // (10/h) and global (MAIL_DAILY_MAX); half of the global budget is reserved for addresses on a
      // synced class list. One indexed read covers them all (events(event, ts)).
      const issue = async () => {             // email a fresh code (rate-limited) -> response
        const hr = since(3600000);
        const c = await db.prepare("SELECT COALESCE(SUM(ts>=? AND device_id=?),0) AS dh, COALESCE(SUM(device_id=?),0) AS dd, COALESCE(SUM(ts>=? AND student=?),0) AS eh, COALESCE(SUM(student=?),0) AS ed, COALESCE(SUM(ts>=? AND detail=?),0) AS ih, COUNT(*) AS total FROM events WHERE event='code_sent' AND ts>=?")
          .bind(hr, dev, dev, hr, email, email, hr, "ip:" + clientIp, since(86400000)).first();
        if (Number(c.dh) >= 5 || Number(c.dd) >= 15 || Number(c.eh) >= 3 || Number(c.ed) >= 5 || Number(c.ih) >= 10) return json({ error: "too_many_codes", retry_minutes: 60 }, 429);
        const max = Number(env.MAIL_DAILY_MAX || 480);
        if (Number(c.total) >= max || (Number(c.total) >= max / 2 && !(await rosterName()))) return json({ error: "mail_busy" }, 503);
        const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
        try { await sendCode(env, email, code); }
        catch (e) { await db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)").bind(dev, email, null, "code_send_failed", String(e).slice(0, 200), now()).run(); return json({ error: "send_failed" }, 502); }
        await db.batch([
          db.prepare("INSERT OR REPLACE INTO email_codes (device_id,email,code_hash,expires,tries,created_at) VALUES (?,?,?,?,0,?)")
            .bind(dev, email, await sha256hex(enc.encode(dev + ":" + code)), Date.now() + CODE_MS, now()),
          db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)").bind(dev, email, null, "code_sent", "ip:" + clientIp, now())]);
        return null;
      };
      // H10: before the code is typed, only a masked name ("J*** S***") is shown -- enough for the
      // student to see it is their class list, without revealing a classmate's full name.
      if (op === "check") { const nm = await rosterName(); return json({ email, found: !!nm, name: maskName(nm), codes: codesOn }); }
      // A computer in a quiz keeps its email until the quiz ends (else one paid email is handed from computer to
      // computer while each keeps its lock and password).
      if ((op === "token" || op === "code" || op === "send") && d?.student && String(d.student).toLowerCase() !== email && await db.prepare("SELECT 1 FROM locks WHERE device_id=? AND last_lock>?").bind(dev, since(120000)).first())
        return json({ error: "in_quiz", message: "Finish your quiz first." }, 409);
      if (op === "token") {
        const want = await vtokenFor(email), got = String(body.vtoken || "").toLowerCase();
        if (!want || !sameHex(got, want)) return json({ error: "bad_token" }, 403);
        await db.batch([
          db.prepare("UPDATE devices SET student=?, student_verified=1 WHERE device_id=?").bind(email, dev),
          db.prepare("DELETE FROM forgotten WHERE email=?").bind(email),
          db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)").bind(dev, email, null, "email_verified", "token", now())]);
        return json({ ok: true, verified: true, student: email, vtoken: want });
      }
      const already = Number(d?.student_verified) === 1 && String(d?.student || "").toLowerCase() === email;
      if (op === "send") {
        if (!codesOn) {                       // codes off: accept after the roster check (pre-25-Oct behaviour)
          await db.prepare("UPDATE devices SET student=? WHERE device_id=? AND COALESCE(student_verified,0)=0").bind(email, dev).run();
          return json({ ok: true, bound: true, name: maskName(await rosterName()) });
        }
        return (await issue()) || json({ ok: true, sent: true, minutes: CODE_MS / 60000 });
      }
      if (op === "code") {
        // Re-submitting after success (double click, retried request) is a no-op, not a new email.
        if (already) return json({ ok: true, verified: true, name: await rosterName(), vtoken: await vtokenFor(email) });
        const row = await db.prepare("SELECT email, code_hash, expires, tries FROM email_codes WHERE device_id=?").bind(dev).first();
        if (!row || row.email !== email) return (await issue()) || json({ error: "no_code", resent: true });
        if (Date.now() > Number(row.expires)) return (await issue()) || json({ error: "expired", resent: true });
        const given = String(body.code || "").replace(/\D/g, "");
        if (!sameHex(await sha256hex(enc.encode(dev + ":" + given)), row.code_hash)) {
          // The 5th wrong try kills this code BEFORE a new one is asked for: if the new email is rate-limited
          // (429), the old code must not stay guessable without limit until it expires.
          if (Number(row.tries) + 1 >= CODE_TRIES) { await db.prepare("DELETE FROM email_codes WHERE device_id=?").bind(dev).run(); return (await issue()) || json({ error: "too_many_tries", resent: true }); }
          await db.prepare("UPDATE email_codes SET tries=tries+1 WHERE device_id=?").bind(dev).run();
          return json({ error: "wrong_code", tries_left: CODE_TRIES - Number(row.tries) - 1 });
        }
        await db.batch([
          db.prepare("UPDATE devices SET student=?, student_verified=1 WHERE device_id=?").bind(email, dev),
          db.prepare("DELETE FROM email_codes WHERE device_id=?").bind(dev),
          db.prepare("DELETE FROM forgotten WHERE email=?").bind(email),     // confirmed again = consent to be listed again
          db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)").bind(dev, email, null, "email_verified", null, now())]);
        return json({ ok: true, verified: true, name: await rosterName(), vtoken: await vtokenFor(email) });
      }
      return json({ error: "bad op" }, 400);
    }

    if (p === "/install" && request.method === "POST") {
      const v = await verifyDevice(request, raw, db);
      if (!v.ok && (strict || await isRegistered(db, body.device_id))) return denied(v);
      const did = v.ok ? v.id : (typeof body.device_id === "string" ? body.device_id.trim() : "");
      if (!did || did.length > 120) return json({ error: "bad device id" }, 400);
      // C6: a repeat report with the same version/platform writes nothing (until a day has passed).
      await db.prepare("INSERT INTO devices (device_id,student,platform,version,installed_at,last_seen) VALUES (?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET platform=excluded.platform,version=excluded.version,last_seen=excluded.last_seen WHERE devices.platform IS NOT excluded.platform OR devices.version IS NOT excluded.version OR devices.last_seen IS NULL OR devices.last_seen < ?")
        .bind(did, lowMail(str(body.student)), str(body.platform, 60), str(body.version, 60), now(), now(), new Date(Date.now() - 86400000).toISOString()).run();
      return json({ ok: true });
    }

    if (p === "/report" && request.method === "POST") {
      const v = await verifyDevice(request, raw, db);
      const { event, quiz_id, student, detail } = body;
      const ev = event || "heartbeat";
      const agentBeat = ev === "heartbeat" && /^(ext|agent)/.test(String(body.source || body.from || "helper"));
      if (v.ok && body.device_id && body.device_id !== v.id) return json({ error: "device mismatch" }, 400);
      if (!v.ok) {
        const claimed = body.device_id ? String(body.device_id) : null;
        const legacy = !strict && !(await isRegistered(db, claimed));
        // An unsigned heartbeat only shows the agent is alive: it may touch ext_seen, nothing else.
        if (ev === "heartbeat" && (agentBeat || !legacy)) {
          if (claimed && typeof quiz_id === "string" && /^\d+-\d+$/.test(quiz_id)) await db.prepare("UPDATE locks SET ext_seen=? WHERE device_id=? AND quiz_id=?").bind(now(), claimed, quiz_id).run();
          return json({ ok: true, verified: false });
        }
        if (!legacy) return denied(v);
      }
      const device_id = v.ok ? v.id : (body.device_id != null ? String(body.device_id).slice(0, 120) : null);
      const dev = v.ok ? v.dev : null;     // the device row (signed requests only; read once by verifyDevice)
      const signed = v.ok ? 1 : 0;
      const qidOk = typeof quiz_id === "string" && /^\d+-\d+$/.test(quiz_id) ? quiz_id : null;
      const studentStr = lowMail(str(student));
      // Unlock reports carry {reason} (quiz_submitted / quiz_left / quiz_tab_closed / cap ...): keep it
      // in the event detail so the live monitor can tell a clean submit from a mid-quiz unlock.
      const reason = typeof body.reason === "string" && body.reason ? body.reason.slice(0, 40) : null;
      const detailObj = reason ? (detail != null && detail !== "" ? { reason, detail } : { reason }) : detail;
      const detailStr = detailObj ? JSON.stringify(detailObj).slice(0, 2000) : null;
      // A developer-mode lock claim is logged as "dev_lock", so /live and /password find the few claims
      // through the index without reading every student's lock event.
      const evName = ev === "lock" && /"developer":true/.test(detailStr || "") ? "dev_lock" : String(ev).slice(0, 40);
      const st = [];
      // "install" (sent at every helper start): logged only when the version/platform changed or the
      // device was quiet for a day (C6); the device row keeps the reported version for the gap rule.
      const ver = str(body.version, 60), plat = str(body.platform, 60);
      const quietDay = !dev || !dev.last_seen || dev.last_seen < new Date(Date.now() - 7 * 86400000).toISOString();
      const changed = !!dev && ((ver && ver !== dev.version) || (plat && plat !== dev.platform));
      const logIt = ev !== "heartbeat" && (ev !== "install" || !dev || changed || quietDay);
      if (logIt) st.push(db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)").bind(device_id||null, studentStr, qidOk, evName, detailStr, now()));
      if (device_id && !dev) st.push(db.prepare("INSERT OR IGNORE INTO devices (device_id,installed_at) VALUES (?,?)").bind(device_id, now()));
      if (ev === "install" && changed) st.push(db.prepare("UPDATE devices SET version=COALESCE(?,version), platform=COALESCE(?,platform) WHERE device_id=?").bind(ver, plat, device_id));
      // D1 free plan = 100k row writes/day: a heartbeat refreshes last_seen at most every 60 minutes
      // (an UPDATE that matches no row writes nothing). Real events always update it; the student
      // (indexed) is written only when it actually changes.
      if (ev === "heartbeat" || (ev === "install" && !logIt))
        st.push(db.prepare("UPDATE devices SET last_seen=? WHERE device_id=? AND (last_seen IS NULL OR last_seen < ?)").bind(now(), device_id||null, new Date(Date.now() - 3600000).toISOString()));
      else {
        st.push(db.prepare("UPDATE devices SET last_seen=? WHERE device_id=?").bind(now(), device_id||null));
        if (studentStr) st.push(db.prepare("UPDATE devices SET student=? WHERE device_id=? AND COALESCE(student_verified,0)<>1 AND student IS NOT ?").bind(studentStr, device_id||null, studentStr));
      }
      const clientIp = request.headers.get("CF-Connecting-IP") || null;
      // The helper went dark for longer than the live monitor's window and is now back: record the gap
      // (writes nothing in the normal case), so a later fresh lock cannot hide that AI may have been open.
      const verNow = dev ? dev.version : (qidOk ? (await db.prepare("SELECT version FROM devices WHERE device_id=?").bind(device_id||null).first())?.version : null);
      const gapRule = (ev === "lock" || (ev === "heartbeat" && !agentBeat)) && qidOk && newerOrSame(verNow, "0.4.0");
      if (gapRule) st.push(gapStmt(db, device_id, qidOk));
      if (ev === "lock" && qidOk)
        st.push(db.prepare("INSERT INTO locks (device_id,quiz_id,last_lock,helper_seen,signed,ip,locked_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(device_id,quiz_id) DO UPDATE SET last_lock=excluded.last_lock,helper_seen=excluded.helper_seen,signed=excluded.signed,ip=excluded.ip,locked_at=COALESCE(locks.locked_at,excluded.locked_at)").bind(device_id, qidOk, now(), now(), signed, clientIp, now()));
      if (ev === "unlock" && qidOk)
        st.push(db.prepare("DELETE FROM locks WHERE device_id=? AND quiz_id=?").bind(device_id, qidOk));
      if (ev === "heartbeat" && qidOk) {
        // Only the helper's heartbeat keeps a lock alive; the agent's only proves the agent runs.
        if (agentBeat) st.push(db.prepare("UPDATE locks SET ext_seen=? WHERE device_id=? AND quiz_id=?").bind(now(), device_id, qidOk));
        else st.push(db.prepare("UPDATE locks SET last_lock=?, helper_seen=?, signed=?, ip=COALESCE(?,ip) WHERE device_id=? AND quiz_id=?").bind(now(), now(), signed, clientIp, device_id, qidOk));
      }
      if (purgeDue()) st.push(...purgeStmts());   // retention without a Sync (same batch: no extra query)
      await runBatches(db, st);
      // C9: the server knows this student submitted (professor's Sync tab) or the quiz is over -> tell
      // the helper to unlock now. Only for the helper's own signed lock/heartbeat (old clients ignore it).
      if (v.ok && qidOk && (ev === "lock" || (ev === "heartbeat" && !agentBeat))) {
        const u = await serverUnlock(dev, device_id, qidOk);
        if (u) return json({ ok: true, unlock: true, reason: u });
      }
      return json({ ok: true });
    }

    // Release the quiz/course password ONLY while this device is locked for this page. The request
    // and the lock must both be signed by the device's key (strict mode / registered devices).
    if (p === "/password" && request.method === "POST") {
      const v = await verifyDevice(request, raw, db);
      const claimed = body.device_id ? String(body.device_id) : "";
      if (!v.ok && (strict || await isRegistered(db, claimed))) return denied(v, { password: null });
      const device_id = v.ok ? v.id : claimed;
      const qurl = String(body.url || "");
      const { qi, ou } = ids(qurl);
      if (!/^\d+$/.test(String(qi||"")) || !/^\d+$/.test(String(ou||""))) return json({ password: null, reason: "bad quiz url" }, 400);
      // C10: USC first -- a quiz on another school's Brightspace is not ours to unlock.
      const qhost = hostOf(qurl);
      if (qhost && !bsHosts(env).includes(qhost)) return json({ password: null, reason: "other_school" }, 403);
      const lockId = `${ou}-${qi}`;
      const lk = await db.prepare("SELECT last_lock, signed FROM locks WHERE device_id=? AND quiz_id=?").bind(device_id, lockId).first();
      let fresh = lk && (Date.now() - Date.parse(lk.last_lock) < 60000) && (!(strict || v.ok) || Number(lk.signed) === 1);
      // C1: a request signed with the helper's device key is itself fresh proof of the lock, so the
      // helper no longer sends a heartbeat before each password request. The lock row is refreshed
      // here (only when it is older than the 60 s rule; a long silence is recorded as a gap first).
      if (!fresh && v.ok && lk) {
        const st = [];
        if (newerOrSame(v.dev?.version, "0.4.0")) st.push(gapStmt(db, device_id, lockId));
        st.push(db.prepare("UPDATE locks SET last_lock=?, helper_seen=?, signed=1, ip=COALESCE(?,ip) WHERE device_id=? AND quiz_id=?").bind(now(), now(), request.headers.get("CF-Connecting-IP") || null, device_id, lockId));
        // D1 daily write cap reached: the signed request is still the lock's proof -> never fail the exam.
        try { await runBatches(db, st); } catch (e) { if (!WRITE_CAP(e)) throw e; }
        fresh = true;
      }
      if (!fresh) return json({ password: null, reason: "not locked" }, 403);
      const devLk = await db.prepare("SELECT 1 FROM events e JOIN devices d ON d.device_id=e.device_id WHERE e.device_id=? AND e.quiz_id=? AND (e.event='dev_lock' OR (e.event='lock' AND e.detail LIKE '%\"developer\":true%')) AND lower(COALESCE(d.student,'')) NOT IN (SELECT lower(email) FROM teachers WHERE role='admin') LIMIT 1").bind(device_id, lockId).first();
      if (devLk) return json({ password: null, reason: "not locked" }, 403);   // dev mode is admin-only
      // Student fee: no password until this semester's fee is paid (matched automatically from Zelle / bank alerts).
      const stu = v.ok ? v.dev : (feeOn() ? await db.prepare("SELECT student, student_verified FROM devices WHERE device_id=?").bind(device_id).first() : null);
      if (feeOn()) {
        // With email codes on, only a CONFIRMED email counts: an unverified device cannot claim a
        // professor's (fee-exempt) or a paid classmate's email just by reporting it.
        // Always a CONFIRMED email while the fee is on (even if email codes are off): a typed email
        // is never enough to ride on someone else's payment.
        const unconfirmed = Number(stu?.student_verified) !== 1;
        const who = unconfirmed ? null : stu?.student;
        if (!(await studentPaid(who))) return unconfirmed
          ? json({ password: null, reason: "verify", needs_verify: true }, 402)   // no pay block: the agent re-runs email setup
          : json({ password: null, reason: "unpaid", pay: await payInfo(who) }, 402);
        // One payment = one student. A paid email cannot be shared: (1) never on two computers in a quiz
        // at the same time; (2) at most 2 computers per email (seen in the last 30 days, not revoked).
        // Staff (professors / admin) are exempt.
        const wl = String(who).toLowerCase();
        if (!isExempt(env, wl) && !(await db.prepare("SELECT 1 FROM teachers WHERE email=? AND (role='admin' OR verified=1)").bind(wl).first())) {
          const sh = await db.prepare(`SELECT
              (SELECT COUNT(DISTINCT l.device_id) FROM locks l JOIN devices d ON d.device_id=l.device_id WHERE d.student=? AND d.student_verified=1 AND COALESCE(d.revoked,0)=0 AND l.device_id<>? AND l.last_lock>?) AS live,
              (SELECT COUNT(*) FROM (SELECT device_id FROM devices WHERE student=? AND student_verified=1 AND COALESCE(revoked,0)=0 AND device_id<>? AND last_seen>?
                 UNION SELECT e.device_id FROM events e JOIN devices d2 ON d2.device_id=e.device_id WHERE e.event='password_released' AND e.student=? AND e.device_id<>? AND e.ts>? AND COALESCE(d2.revoked,0)=0)) AS other`)
            .bind(wl, device_id, new Date(Date.now() - 120000).toISOString(), wl, device_id, new Date(Date.now() - 30 * 864e5).toISOString(), wl, device_id, new Date(Date.now() - 30 * 864e5).toISOString()).first();
          if (Number(sh?.live) > 0) return json({ password: null, reason: "in_use", error: "This email is in a quiz on another computer." }, 402);
          if (Number(sh?.other) >= 2) return json({ password: null, reason: "too_many_devices", error: "This email is already used on 2 computers. Email lockqz.app@gmail.com to remove one." }, 402);
        }
      }
      // Everything about this quiz in ONE read: LOCKqz password + gate state, Brightspace dates, a
      // password still waiting to be removed from Brightspace (I-M9), and the course-wide password.
      const q = await db.prepare("SELECT q.password AS password, q.gated AS gated, q.bs_code AS bs_code, q.sa_keep AS sa_keep, b.start_date AS start_date, b.end_date AS end_date, (SELECT password FROM pending_clear WHERE ou=? AND qi=?) AS pc, (SELECT password FROM courses WHERE ou=?) AS cpw, b.qi AS bq FROM (SELECT 1) one LEFT JOIN quizzes q ON q.ou=? AND q.qi=? LEFT JOIN bs_quizzes b ON b.ou=? AND b.qi=?")
        .bind(ou, qi, ou, ou, qi, ou, qi).first();
      const gated = Number(q?.gated) === 1;
      // C2: the start check applies only while the quiz is GATED (the gate hides the quiz, so LOCKqz
      // decides who may enter and when). Otherwise Brightspace enforces its own start date and every
      // accommodation itself. A student in the gate's kept special-access list (accommodation) may
      // have an earlier window, so they pass the start check.
      let accommodated = false;
      if (gated && q.sa_keep) {
        let keep = []; try { keep = JSON.parse(q.sa_keep).map(String); } catch {}
        if (keep.length) {
          const sk = stu?.student || (await db.prepare("SELECT student FROM devices WHERE device_id=?").bind(device_id).first())?.student;
          const who = sk ? await db.prepare("SELECT user_id FROM roster WHERE ou=? AND (email=? OR lower(name)=?) LIMIT 1").bind(ou, String(sk).toLowerCase(), String(sk).toLowerCase()).first() : null;
          accommodated = !!(who && who.user_id && keep.includes(String(who.user_id)));
        }
      }
      if (gated && q.start_date && Date.now() < Date.parse(q.start_date) && !accommodated)
        return json({ password: null, reason: "not started", start: q.start_date }, 403);
      // Give the student EXACTLY what is in Brightspace: the code the Sync tab last confirmed writing
      // (gated quiz) or the quiz's fixed LOCKqz password (protected, not gated). Never a computed code,
      // so a closed or sleeping Sync tab can never cause a wrong password. A quiz turned off moments
      // before the exam still holds our password in Brightspace until the next Sync removes it, so that
      // password keeps being released until then (pending_clear).
      // REQUIRE_GATE: a protected quiz that can still be taken is only opened through the gate. Its
      // professor is emailed (at most once an hour per quiz) to open the Sync tab; the app keeps asking.
      if (gateRequired() && q?.password && !gated && !(q.end_date && Date.now() > Date.parse(q.end_date))) {
        await nudgeGate(ou, qi);
        return json({ password: null, reason: "gate_off" }, 402);
      }
      const rot = gated && q.bs_code ? q.bs_code : null;
      const given = rot || q?.password || q?.pc || q?.cpw || null;
      if (!given && !q?.bq) await nudgeUnsynced(ou, qi);   // a quiz newer than the professor's last Sync
      // Logged once per device + quiz + released code (+ IP): agents re-ask often, and every repeat
      // would be a row written (D1 Free: 100k/day). A new code or a new IP is logged again.
      if (given) {
        const det = JSON.stringify({ verified: v.ok, ip: request.headers.get("CF-Connecting-IP") || null, v: (await sha256hex(enc.encode(lockId + ":" + given))).slice(0, 8) });
        // A gated quiz's code changes every 5 min: a new code for the same device + quiz + IP is not a new
        // row (5 rows written each with the indexes); the first release keeps its code hash.
        const pre = gated ? det.slice(0, det.indexOf(',"v":')) : det;
        await db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) SELECT ?,(SELECT student FROM devices WHERE device_id=?),?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM events WHERE device_id=? AND quiz_id=? AND event='password_released' AND substr(detail,1,length(?))=?)")
          .bind(device_id, device_id, lockId, "password_released", det, now(), device_id, lockId, pre, pre).run().catch(e => { if (!WRITE_CAP(e)) throw e; });
      }
      // C2: end = the quiz's Brightspace end (the helper's failsafe cap = end + 15 min) ONLY while the
      // quiz is gated (LOCKqz then knows the accommodations) and this student is not accommodated.
      // Otherwise null -> the helper's 6 h failsafe: special access the server cannot see (makeup exams,
      // a later personal end date) or an end changed in Brightspace since the last Sync must never cut
      // a student's lock short.
      const end = gated && q?.end_date && !accommodated && !isNaN(Date.parse(q.end_date)) ? new Date(Date.parse(q.end_date)).toISOString() : null;
      // Gated: the code changes only at the next 5-min bucket (+ the Sync tab's round), so the agent may
      // wait until then; older agents ignore it and keep their 15 s schedule.
      // Only when Brightspace already holds this bucket's code (else the Sync tab is about to change it).
      let recheck = null;
      if (rot) { const b = minuteBucket();
        if (rot === await rotatingPw(env.ROT_SECRET || env.TEACHER_KEY || "lqz-fallback", ou, qi, b)) recheck = Math.max(15, Math.ceil(((b + 1) * ROT_MS + 40000 - Date.now()) / 1000)); }
      return json({ password: given, lockId, end, ...(recheck ? { recheck } : {}) });
    }

    if (p === "/match" && request.method === "POST") {
      const { qi, ou } = ids(String(body.url || ""));
      if (qi) { const q = await db.prepare("SELECT quiz_id FROM quizzes WHERE qi=?").bind(qi).first(); if (q) return json({ match:true, quiz_id:q.quiz_id }); }
      if (ou) { const c = await db.prepare("SELECT ou FROM courses WHERE ou=?").bind(ou).first(); if (c) return json({ match:true, quiz_id:`${ou}-${qi||"x"}` }); }
      return json({ match: false });
    }

    // Admin: revoke a device (e.g. one caught faking a lock). Its signed requests are refused.
    if (p === "/revoke-device" && request.method === "POST") {
      if (!me?.admin) return json({ error: "admin only" }, 401);
      const r = await db.prepare("UPDATE devices SET revoked=1 WHERE device_id=?").bind(String(body.device_id || "")).run();
      return r.meta.changes ? json({ ok: true }) : json({ error: "no such device" }, 404);
    }

    // ---- teacher accounts ----
    if (p === "/signup" && request.method === "POST") {
      const email = String(body.email||"").trim().toLowerCase(), pw = String(body.password||"");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error:"enter a valid email" }, 400);
      if (pw.length < 8) return json({ error:"password must be at least 8 characters" }, 400);
      // An instructor email that an admin/verified professor has already put on a trusted roster is a
      // real professor's identity. Self-signup can't claim it without an admin invite code (which only
      // the admin issues to that person), so a student can't pre-register bristow@usc.edu.
      const codeUp = String(body.invite||"").trim().toUpperCase();
      const invPre = codeUp ? await db.prepare("SELECT email FROM invites WHERE code=? AND used_at IS NULL AND (email IS NULL OR email=?)").bind(codeUp, email).first() : null;
      const dup = await db.prepare("SELECT id, role, verified, vouched FROM teachers WHERE email=?").bind(email).first();
      // An account nobody vouched for (no invite) and that never verified may be squatting a
      // professor's email. The real professor's invite for that exact email takes it over (below).
      const squat = dup && invPre && invPre.email === email && dup.role !== "admin" && Number(dup.vouched) !== 1 && Number(dup.verified) !== 1;
      if (dup && !squat) return json({ error:"that email already has an account — log in instead" }, 409);
      if (!invPre) {
        const claimed = await db.prepare(`SELECT 1 FROM roster r WHERE r.email=? AND ${INSTR_SQL} AND ${TRUSTED_TC} LIMIT 1`).bind(email).first();
        if (claimed) return json({ error:"This email belongs to a professor already on a course roster. Ask the LOCKqz admin for an invite to claim it." }, 409);
      }
      // The first account on the site is the admin. Anyone can still make an account after that (the
      // site only offers sign-up through an invite link), but it is UNVERIFIED and can protect nothing.
      // Only an INVITED (vouched) account can verify -- by syncing a course whose trusted roster lists
      // its email as Instructor. Without that, anyone could sign up as bristow@usc.edu before his roster
      // is seeded and later "verify" as him. The invite also sets the paid window.
      // Self-signup (no valid invite): 10 per IP per hour, checked before any password hashing or row is
      // written (else one script fills the D1 free plan's 100k rows/day and burns CPU on PBKDF2).
      if (!invPre) {
        const hr = new Date(Date.now() - 3600000).toISOString();
        if (Number((await db.prepare("SELECT COUNT(*) AS n FROM events WHERE event='signup' AND ts>? AND device_id=?").bind(hr, "ip:" + clientIp).first()).n) >= 10)
          return json({ error:"too many sign-ups from here — try again in an hour" }, 429);
        await db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)").bind("ip:" + clientIp, null, null, "signup", null, now()).run();
      }
      const n = (await db.prepare("SELECT COUNT(*) AS n FROM teachers").first()).n;
      let inv = null;
      {
        const code = String(body.invite||"").trim().toUpperCase();
        if (code) {
          inv = await db.prepare("SELECT code,email,active_until,used_at FROM invites WHERE code=?").bind(code).first();
          if (inv && !inv.used_at && (!inv.email || inv.email === email)) {
            const u = await db.prepare("UPDATE invites SET used_at=?, used_by=? WHERE code=? AND used_at IS NULL").bind(now(), email, inv.code).run();
            if (!u.meta.changes) inv = null;   // lost the race — treat as no invite
          } else inv = null;
        }
      }
      if (squat && !inv) return json({ error:"that email already has an account — log in instead" }, 409);
      const id = squat ? dup.id : rid(10), salt = rid(16), token = hex(crypto.getRandomValues(new Uint8Array(24)));
      // vouched = the admin vouched for whoever holds this account (an invite, or the first/admin
      // account). Only a vouched account can ever become a verified professor: a self-made account
      // proves nothing about owning its email, so it could otherwise claim a professor's identity.
      const vouched = (inv || n === 0) ? 1 : 0;
      if (squat) {
        await db.prepare("DELETE FROM teacher_courses WHERE teacher_id=?").bind(id).run();
        await db.prepare("UPDATE teachers SET name=?, pw_hash=?, salt=?, token=?, sync_key=NULL, bs_user_id=NULL, verified=0, vouched=1, active_until=?, created_at=? WHERE id=?")
          .bind(String(body.name||"").trim()||null, await hashPw(pw,salt,PEPPER), salt, token, inv.active_until, now(), id).run();
      } else
        await db.prepare("INSERT INTO teachers (id,email,name,pw_hash,salt,token,created_at,role,active_until,vouched) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .bind(id, email, String(body.name||"").trim()||null, await hashPw(pw,salt,PEPPER), salt, token, now(), n===0?"admin":"teacher", inv ? inv.active_until : null, vouched).run();
      return json({ token, email, name: body.name||null });
    }
    if (p === "/login" && request.method === "POST") {
      const email = String(body.email||"").trim().toLowerCase(), pw = String(body.password||"");
      const ip = clientIp;
      const lkey = `login:${email}:${ip}`, since = new Date(Date.now()-900000).toISOString();
      // Per email+IP (5 / 15 min) AND per IP (30 / 15 min, any emails) -- checked BEFORE anything is
      // written, so random emails from one IP cannot write unlimited rows. Index: events(event, ts).
      const lf = await db.prepare("SELECT COALESCE(SUM(detail=?),0) AS mine, COALESCE(SUM(device_id=?),0) AS ipn FROM events WHERE event='login_fail' AND ts>?").bind(lkey, "ip:" + ip, since).first();
      if (Number(lf.mine) >= 5 || Number(lf.ipn) >= 30) return json({ error:"too many attempts — wait 15 minutes" }, 429);
      const t = await db.prepare("SELECT id,email,name,pw_hash,salt,token FROM teachers WHERE email=?").bind(email).first();
      const chk = t ? await checkPw(pw, t.salt, t.pw_hash, PEPPER) : { ok: false };
      if (!chk.ok) {
        await db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)").bind("ip:" + ip,null,null,"login_fail",lkey,now()).run();
        return json({ error:"wrong email or password" }, 401);
      }
      let token = t.token;
      // Old 100k-round hash (too slow for the Workers Free CPU limit): re-hash it now, transparently.
      if (chk.rehash) { const salt = rid(16); await db.prepare("UPDATE teachers SET pw_hash=?, salt=? WHERE id=?").bind(await hashPw(pw, salt, PEPPER), salt, t.id).run(); }
      if (!token) { token = hex(crypto.getRandomValues(new Uint8Array(24))); await db.prepare("UPDATE teachers SET token=? WHERE id=?").bind(token, t.id).run(); }
      return json({ token, email: t.email, name: t.name });
    }
    if (p === "/forgot" && request.method === "POST") {
      const email = String(body.email||"").trim().toLowerCase();
      const t = await db.prepare("SELECT id FROM teachers WHERE email=?").bind(email).first().catch(()=>null);
      // At most one request per email per hour and 10 per IP per hour (else nothing is written).
      const hr = new Date(Date.now() - 3600000).toISOString();
      if (t) await db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM events WHERE event='reset_request' AND ts>? AND detail=?) AND (SELECT COUNT(*) FROM events WHERE event='reset_request' AND ts>? AND device_id=?) < 10")
        .bind("ip:" + clientIp,null,null,"reset_request",email,now(), hr, email, hr, "ip:" + clientIp).run();
      return json({ ok:true });   // always ok — never reveal whether the email exists
    }
    // Public: is this invite link valid? (lets the sign-up form open and prefill the email)
    if (p === "/invite-check") {
      const code = String(url.searchParams.get("code")||"").trim().toUpperCase();
      const inv = code ? await db.prepare("SELECT email,used_at FROM invites WHERE code=?").bind(code).first().catch(()=>null) : null;
      return json(inv && !inv.used_at ? { ok:true, email: inv.email||null } : { ok:false });
    }
    if (p === "/me") {
      if (!me) return json({ error:"unauthorized" }, 401);
      if (me.trial && me.id !== "admin") { const end = termEndOf(curTerms()[0]);
        if (!me.active_until || me.active_until < end) { await db.prepare("UPDATE teachers SET active_until=? WHERE id=?").bind(end, me.id).run(); me.active_until = end; } }
      return json({ email: me.email, name: me.name, admin: me.admin, verified: !!me.verified, active: me.active, active_until: me.active_until, ...(me.trial ? { trial: true } : {}) });
    }
    if (p === "/logout" && request.method === "POST") {
      // Every real account (admins included) loses its session token; only the master key has no row.
      if (me && me.id !== "admin" && !viaSyncKey) await db.prepare("UPDATE teachers SET token=NULL WHERE id=?").bind(me.id).run();
      return json({ ok:true });
    }
    if (p === "/changepw" && request.method === "POST") {
      if (!me) return json({ error:"unauthorized" }, 401);
      if (me.id === "admin") return json({ error:"the master admin key has no stored password" }, 400);
      const cur = await db.prepare("SELECT pw_hash,salt FROM teachers WHERE id=?").bind(me.id).first();
      if (!cur || !(await checkPw(String(body.old_password||""), cur.salt, cur.pw_hash, PEPPER)).ok) return json({ error:"current password is wrong" }, 403);
      const pw = String(body.password||"");
      if (pw.length < 8) return json({ error:"password must be at least 8 characters" }, 400);
      const salt = rid(16), token = hex(crypto.getRandomValues(new Uint8Array(24)));
      // Like /reset: the Sync bookmark key dies with the old password -- except while a gate runs (the
      // gate's Sync tab must keep working); then it is cleared when the last gate stops (I-M2, I-M6).
      const gating = await db.prepare("SELECT 1 FROM quizzes WHERE teacher_id=? AND gated=1 LIMIT 1").bind(me.id).first();
      await db.prepare(`UPDATE teachers SET pw_hash=?, salt=?, token=?${gating ? ",sync_key_kept=1" : ",sync_key=NULL,sync_key_kept=0"} WHERE id=?`).bind(await hashPw(pw,salt,PEPPER), salt, token, me.id).run();
      return json({ ok:true, token, ...(gating ? { sync_key_kept: "a gate is running; the Sync bookmark keeps working until it stops" } : {}) });
    }
    // Admin only: list teachers / reset a teacher's password (no email service, so the
    // admin hands the new password to the teacher).
    if (p === "/teachers") {
      if (!me?.admin) return json({ error:"admin only" }, 403);
      const r = await db.prepare("SELECT t.id,t.email,t.name,t.created_at,t.active_until,(SELECT COUNT(*) FROM paid_sections ps WHERE ps.teacher_id=t.id AND ps.until>=?) AS paid_sections,(SELECT code FROM pay_codes pc WHERE pc.teacher_id=t.id) AS memo FROM teachers t ORDER BY t.created_at DESC").bind(laToday()).all();
      return json({ teachers: r.results });
    }
    // Admin only: turn a teacher on (after payment) until a date, or off.
    if (p === "/activate" && request.method === "POST") {
      if (!me?.admin) return json({ error:"admin only" }, 403);
      const email = String(body.email||"").trim().toLowerCase();
      const until = body.until ? String(body.until).trim() : null;   // "YYYY-MM-DD" or null = off
      if (until !== null && !isDate(until)) return json({ error:"until must be a date YYYY-MM-DD" }, 400);
      const r = await db.prepare(`UPDATE teachers SET active_until=?${until ? ",vouched=1" : ""} WHERE email=?`).bind(until, email).run();
      if (r.meta.changes && (!until || until < laToday())) {
        const tt = await db.prepare("SELECT id FROM teachers WHERE email=?").bind(email).first();
        if (tt) await releaseUnpaid({ id: tt.id, admin: false, active: false });
      }
      return r.meta.changes ? json({ email, active_until: until }) : json({ error:"no such professor" }, 404);
    }
    if (p === "/reset" && request.method === "POST") {
      if (!me?.admin) return json({ error:"admin only" }, 403);
      const email = String(body.email||"").trim().toLowerCase(), salt = rid(16), pw = body.password || ("LQ-"+rid(8));
      // The old Sync bookmark key dies with the old password (it is a login for the Sync endpoints).
      const gating = await db.prepare("SELECT 1 FROM quizzes q JOIN teachers t ON t.id=q.teacher_id WHERE t.email=? AND q.gated=1 LIMIT 1").bind(email).first();
      const r = await db.prepare(`UPDATE teachers SET pw_hash=?,salt=?,token=NULL${gating ? ",sync_key_kept=1" : ",sync_key=NULL,sync_key_kept=0"} WHERE email=?`).bind(await hashPw(pw,salt,PEPPER), salt, email).run();
      return r.meta.changes ? json({ email, password: pw, ...(gating ? { sync_key_kept: "a gate is running; the Sync bookmark keeps working until it stops" } : {}) }) : json({ error:"no such professor" }, 404);
    }
    // Admin only: invite a teacher (one-time code; optional email lock; account active until a date).
    if (p === "/invite" && request.method === "POST") {
      if (!me?.admin) return json({ error:"admin only" }, 403);
      const email = String(body.email||"").trim().toLowerCase() || null;
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error:"enter a valid email" }, 400);
      // An existing account blocks a new invite -- unless nobody ever vouched for it (no invite) and it
      // never verified: that may be someone squatting the professor's email, and the invite reclaims it.
      if (email && await db.prepare("SELECT id FROM teachers WHERE email=? AND (role='admin' OR vouched=1 OR verified=1)").bind(email).first()) return json({ error:"that email already has an account" }, 409);
      const until = body.until ? String(body.until).trim() : null;
      if (until !== null && !isDate(until)) return json({ error:"until must be a date YYYY-MM-DD" }, 400);
      const code = rid(10);
      await db.prepare("INSERT INTO invites (code,email,active_until,created_at) VALUES (?,?,?,?)").bind(code, email, until, now()).run();
      return json({ code, email, active_until: until });
    }
    if (p === "/invites") {
      if (!me?.admin) return json({ error:"admin only" }, 403);
      const r = await db.prepare("SELECT code,email,active_until,created_at,used_at,used_by FROM invites ORDER BY created_at DESC LIMIT 100").all();
      return json({ invites: r.results });
    }
    if (p === "/uninvite" && request.method === "POST") {
      if (!me?.admin) return json({ error:"admin only" }, 403);
      const r = await db.prepare("DELETE FROM invites WHERE code=? AND used_at IS NULL").bind(String(body.code||"")).run();
      return r.meta.changes ? json({ ok:true }) : json({ error:"invite not found or already used" }, 404);
    }

    // Admin: a professor's sections + mark sections paid / unpaid (after the Venmo payment arrives).
    if (p === "/teacher-sections") {
      if (!me?.admin) return json({ error:"admin only" }, 403);
      const t = await db.prepare("SELECT id,email,name FROM teachers WHERE email=?").bind(String(url.searchParams.get("email")||"").toLowerCase()).first();
      if (!t) return json({ error:"no such professor" }, 404);
      const r = await sectionsFor(t.id, url.searchParams.get("name") || t.name);
      return json({ ...r, email: t.email, memo: await payCode(t.id), price: PRICE });
    }
    if (p === "/pay-sections" && request.method === "POST") {
      if (!me?.admin) return json({ error:"admin only" }, 403);
      const t = await db.prepare("SELECT id FROM teachers WHERE email=?").bind(String(body.email||"").trim().toLowerCase()).first();
      if (!t) return json({ error:"no such professor" }, 404);
      const term = String(body.term||""), until = String(body.until||"").trim();
      const secs = [...new Set((Array.isArray(body.sections) ? body.sections : []).map(String).filter(x => /^\d{5}$/.test(x)))].slice(0, 100);
      if (!/^\d{5}$/.test(term) || !secs.length) return json({ error:"bad term or sections" }, 400);
      if (!body.off && !isDate(until)) return json({ error:"bad until date" }, 400);
      const st = [];
      if (body.off) for (const part of chunk(secs, 97)) st.push(db.prepare(`DELETE FROM paid_sections WHERE teacher_id=? AND term=? AND section IN (${placeholders(part.length)})`).bind(t.id, term, ...part));
      else {
        const info = new Map();
        for (const part of chunk(secs, 98)) (await db.prepare(`SELECT section,course,first,last FROM usc_sections WHERE term=? AND section IN (${placeholders(part.length)})`).bind(term, ...part).all()).results.forEach(r => { if (!info.has(String(r.section))) info.set(String(r.section), r); });
        st.push(...multiInsert(db, "INSERT OR REPLACE INTO paid_sections (teacher_id,term,section,course,first,last,until,paid_at,via)", 9,
          secs.map(sec => { const r = info.get(sec); return [t.id, term, sec, r?.course||null, r?.first||null, r?.last||null, until, now(), String(body.via||"admin").slice(0,40)]; })));
      }
      await runBatches(db, st);
      if (body.off) await releaseUnpaid({ id: t.id, admin: false, active: false });
      return json({ ok: true, sections: secs, until: body.off ? null : until });
    }

    // ---- payments (public + Apps Script + admin) ----
    // /pay/status needs the code or this token from /pay/start (H10: nobody can look up whether an
    // arbitrary email paid or belongs to a professor).
    const statusToken = async email => (await hmacHex(String(env.ROT_SECRET || env.TEACHER_KEY || "lqz-fallback"), "lqz-pay-status:" + email)).slice(0, 32);
    if (p === "/pay/start" && request.method === "POST") {
      const email = String(body.email||"").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error:"enter your school email" }, 400);
      // Per IP: 30 lookups an hour (each lookup hands out that email's memo code).
      const hr = new Date(Date.now() - 3600000).toISOString();
      if (Number((await db.prepare("SELECT COUNT(*) AS n FROM events WHERE event='pay_start' AND ts>? AND device_id=?").bind(hr, "ip:" + clientIp).first()).n) >= 30)
        return json({ error:"too many requests — try again in an hour" }, 429);
      await db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)").bind("ip:" + clientIp, null, null, "pay_start", null, now()).run();
      const info = await payInfo(email, clientIp, !(await studentPaid(email)));
      if (info.limited) return json({ error:"too many requests — try again in an hour" }, 429);
      const stt = await studentStatus(email);
      const ro = await db.prepare("SELECT 1 FROM renew_optout WHERE email=?").bind(email).first().catch(() => null);
      return json({ ...info, paid: await studentPaid(email), required: feeOn(), term: stt.term, until: termEndOf(stt.term), received: stt.received, money: stt.money, token: await statusToken(email), renew: !ro });
    }
    if (p === "/pay/status") {
      const email = String(url.searchParams.get("email")||"").trim().toLowerCase();
      if (!email) return json({ error:"email required" }, 400);
      const stt = await studentStatus(email);
      const tok = String(url.searchParams.get("token")||""), code = String(url.searchParams.get("code")||"").trim().toUpperCase();
      if (!((tok && sameHex(tok, await statusToken(email))) || (code && stt.code && code === stt.code))) return json({ error:"code or token required (from /pay/start)" }, 403);
      return json({ paid: await studentPaid(email), required: feeOn(), received: stt.received, money: stt.money, amount: STUDENT_FEE, term: stt.term, ways: taxOn() ? waysFor("student", Math.max(0, STUDENT_FEE - stt.received)) : null });
    }
    // Student: start a Stripe Checkout (card or bank) for what is still due this term.
    if (p === "/pay/stripe" && request.method === "POST") {
      if (!stripeOn()) return json({ error:"Card payments are not on yet." }, 503);
      const email = String(body.email||"").trim().toLowerCase(), method = body.method === "bank" && stripeBank() ? "bank" : "card";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error:"enter your school email" }, 400);
      const hr = new Date(Date.now() - 3600000).toISOString();
      if (Number((await db.prepare("SELECT COUNT(*) AS n FROM events WHERE event='pay_stripe' AND ts>? AND device_id=?").bind(hr, "ip:" + clientIp).first()).n) >= 20)
        return json({ error:"too many requests — try again in an hour" }, 429);
      await db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)").bind("ip:" + clientIp, null, null, "pay_stripe", null, now()).run();
      const code = await studentCode(email, clientIp);
      if (!code || typeof code === "object") return json({ error:"too many requests — try again in an hour" }, 429);
      if (await studentPaid(email)) return json({ error:"already paid" }, 409);
      const st = await studentStatus(email), due = Math.round(STUDENT_FEE * 100) - Math.round(st.received * 100);
      const r = await stripeCheckout({ kind: "student", method, code, email, term: st.term, dueC: due, back: `${PAY_URL}?email=${encodeURIComponent(email)}` });
      return json(r, r.url ? 200 : 502);
    }
    // Stripe's webhook (signed). Paid checkouts are recorded like any other payment (txn = the
    // PaymentIntent, so the card "completed" and the bank "async succeeded" events count once);
    // refunds and disputes void the payment.
    if (p === "/pay/stripe/webhook" && request.method === "POST") {
      if (!stripeOn()) return json({ error:"off" }, 503);
      const text = new TextDecoder().decode(raw);
      if (!(await stripeVerified(request.headers.get("Stripe-Signature"), text))) return json({ error:"bad signature" }, 400);
      const ev = body, o = ev?.data?.object || {};
      if ((ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") && o.payment_status === "paid" && o.mode === "payment" && String(o.currency).toLowerCase() === "usd") {
        const code = String(o.metadata?.code || o.client_reference_id || "");
        const res = await applyPayments([{ txn: "stripe:" + (o.payment_intent || o.id), amount: Number(o.amount_total) / 100, note: code,
          via: "stripe-" + ((o.payment_method_types || [])[0] === "us_bank_account" ? "bank" : "card"), payer: String(o.customer_details?.email || o.customer_email || "") }]);
        return json({ ok: true, result: res[0] });
      }
      // Cancelled money = no access: refunds, disputes (card chargebacks, bank-account returns) and failed payments.
      // Failed / cancelled attempts are never recorded (only payment_status "paid" is), and a PaymentIntent that
      // succeeded cannot fail later, so for a card a failure event is an attempt before the success (Stripe does
      // not deliver events in order). Refund / dispute arriving BEFORE the paid event leaves a
      // void tombstone, so the late "completed" event is a duplicate and never grants access.
      if (["charge.failed", "payment_intent.payment_failed", "payment_intent.canceled"].includes(ev.type)) {
        // Only a Stripe bank-account (ACH) payment can fail after it counted (a return); a card PaymentIntent that
        // succeeded never fails later, so a card failure is a stale earlier attempt.
        const pi = String(ev.type.startsWith("payment_intent.") ? o.id : o.payment_intent || "");
        const pr = pi ? await db.prepare("SELECT code FROM payments WHERE txn=? AND via='stripe-bank'").bind("stripe:" + pi).first() : null;
        if (pr) { await db.prepare("UPDATE payments SET matched='void' WHERE txn=?").bind("stripe:" + pi).run(); await unsettle(pr.code); }
        return json({ ok: true, voided: !!pr });
      }
      if (["charge.refunded", "charge.dispute.created"].includes(ev.type)) {
        const pi = String(o.payment_intent || "");
        const pr = pi ? await db.prepare("SELECT code FROM payments WHERE txn=?").bind("stripe:" + pi).first() : null;
        if (pr) { await db.prepare("UPDATE payments SET matched='void' WHERE txn=?").bind("stripe:" + pi).run(); await unsettle(pr.code); }
        else if (pi) await db.prepare("INSERT OR IGNORE INTO payments (txn,code,amount,via,payer,note,term,received_at,matched) VALUES (?,NULL,0,'stripe-card','',?,NULL,?,'void')").bind("stripe:" + pi, ev.type, now()).run();
        return json({ ok: true, voided: !!pr });
      }
      return json({ ok: true, ignored: ev.type || null });
    }
    // Renewal: no card is stored (Venmo/Zelle can't be charged), so "auto-renew" = LOCKqz emails each
    // past payer a one-tap pay link before the next term, and access continues as soon as it's paid.
    // Anyone can turn those emails off (or back on) for their address.
    // Bank transfer (ACH / wire): emails the payer LOCKqz's bank details, the amount (income tax included)
    // and their memo at once. Called by the pay page, the professor dashboard, and the Gmail script (which
    // answers anyone who emails LOCKqz about a bank transfer). BANK_DETAILS = a Pages secret (several lines:
    // bank, account holder, routing, account number); until it is set, the payer is told the details follow
    // and the admin is emailed to send them.
    if (p === "/pay/bank" && request.method === "POST") {
      const sec = await paySecret(), script = sec.length >= 16 && sameHex(String(request.headers.get("X-LOCKqz-Pay") || ""), sec);
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "enter your school email" }, 400);
      const hr = new Date(Date.now() - 3600000).toISOString(), ten = new Date(Date.now() - 600000).toISOString();
      if (!script && Number((await db.prepare("SELECT COUNT(*) AS n FROM events WHERE event='pay_bank' AND ts>? AND device_id=?").bind(hr, "ip:" + clientIp).first()).n) >= 10)
        return json({ error: "too many requests — try again in an hour" }, 429);
      if (await db.prepare("SELECT 1 FROM events WHERE event='pay_bank' AND student=? AND ts>?").bind(email, ten).first())
        return json({ ok: true, sent: true, to: email, again: true });   // one email per address per 10 minutes
      // Global cap per day: these emails share Gmail's ~500/day sending limit with the students' email codes,
      // so many IPs asking for bank details to random addresses must never stop students verifying before a quiz.
      if (!script && Number((await db.prepare("SELECT COUNT(*) AS n FROM events WHERE event='pay_bank' AND ts>?").bind(new Date(Date.now() - 86400000).toISOString()).first()).n) >= Number(env.BANK_MAIL_DAILY_MAX || 60))
        return json({ error: "Too many requests today. Email " + (stuBank() || "lockqz.app@gmail.com") + " for the bank details." }, 429);
      const prof = await db.prepare("SELECT id FROM teachers WHERE lower(email)=?").bind(email).first();
      let kind = "student", code, left;
      if (prof) {
        kind = "professor"; code = await payCode(prof.id);
        const [cur, nxt] = curTerms(), sums = { [cur]: 0, [nxt]: 0 };
        for (const x of (await db.prepare(`SELECT term, COALESCE(SUM(${CREDIT()}),0) AS s FROM payments WHERE code=? AND term IN (?,?) AND ${COUNTS} GROUP BY term`).bind(code, cur, nxt).all()).results) sums[x.term] = Number(x.s);
        left = PRICE - sums[payTermFor(sums[cur], PRICE)];
      } else {
        code = await studentCode(email, script ? null : clientIp);
        if (!code || typeof code === "object") return json({ error: "too many requests — try again in an hour" }, 429);
        left = (await studentPaid(email)) ? 0 : STUDENT_FEE - (await studentStatus(email)).received;
      }
      await db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)").bind("ip:" + (script ? "gmail" : clientIp), email, null, "pay_bank", kind, now()).run();
      if (!(left > 0.005)) return json({ ok: true, paid: true });
      const w = taxOn() ? waysFor(kind, left).bank : { total: Math.round(left * 100) / 100, base: Math.round(left * 100) / 100, tax: 0 };
      const m = n => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const details = String(env.BANK_DETAILS || "").trim();
      const text = `LOCKqz — bank transfer (ACH or wire)\n\n`
        + `Amount: ${m(w.total)}` + (w.tax > 0 ? `  (LOCKqz ${m(w.base)} + ${taxInfo().label.toLowerCase()} ${Math.round(TAX_RATE * 100)}% ${m(w.tax)})` : "") + `\n`
        + `Memo / reference: ${code}\nPut ${code} in the memo, or LOCKqz can't tell the payment is yours.\n\n`
        + (details ? details + "\n\n" : "LOCKqz's bank account details follow in a separate email.\n\n")
        + `Access turns on by itself within a minute of the money arriving (ACH usually 1–3 business days, wire same day).\n`
        + (stuZelle() ? `Faster: Zelle ${m(w.total)} to ${stuZelle()} with memo ${code}. It arrives in minutes.\n` : "")
        + `\nQuestions: reply to this email.`;
      try { await sendMail(env, email, `LOCKqz bank transfer details · ${code}`, text); }
      catch (e) { return json({ error: "Could not send the email. Try again in a minute." }, 502); }
      if (!details && env.ADMIN_EMAIL) try { await sendMail(env, String(env.ADMIN_EMAIL), `Send bank details: ${email} (${code})`, `${email} asked to pay ${m(w.total)} by bank transfer (memo ${code}).\nReply to them with LOCKqz's bank details.\nTo answer automatically: set the Pages secret BANK_DETAILS.`); } catch {}
      return json({ ok: true, sent: true, to: email, amount: w.total });
    }
    if (p === "/pay/renew" && request.method === "POST") {
      const email = String(body.email||"").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error:"bad email" }, 400);
      if (body.on) await db.prepare("DELETE FROM renew_optout WHERE email=?").bind(email).run();
      else await db.prepare("INSERT OR IGNORE INTO renew_optout (email,at) VALUES (?,?)").bind(email, now()).run();
      return json({ ok:true, renew: !!body.on });
    }
    // Called by the Gmail script about once an hour: sends due renewal emails, a few per call.
    if (p === "/pay/tick" && request.method === "POST") {
      const secret = await paySecret();
      if (secret.length < 16 || !sameHex(String(request.headers.get("X-LOCKqz-Pay") || ""), secret)) return json({ error:"unauthorized" }, 401);   // constant-time
      return json(await renewalTick());
    }
    if (p === "/pay/notify" && request.method === "POST") {
      const secret = await paySecret();
      const got = String(request.headers.get("X-LOCKqz-Pay") || "");
      if (secret.length < 16 || !sameHex(got, secret)) return json({ error:"unauthorized" }, 401);   // constant-time
      const list = Array.isArray(body.payments) ? body.payments.slice(0, 100) : [body];
      return json({ results: await applyPayments(list) });
    }
    if (p === "/payments") {
      if (!me?.admin) return json({ error:"admin only" }, 403);
      const r = await db.prepare("SELECT p.txn,p.code,p.amount,p.via,p.payer,p.note,p.term,p.received_at,p.matched,COALESCE(s.email,t.email) AS who FROM payments p LEFT JOIN pay_codes_students s ON s.code=p.code LEFT JOIN pay_codes pc ON pc.code=p.code LEFT JOIN teachers t ON t.id=pc.teacher_id ORDER BY p.received_at DESC LIMIT 300").all();
      return json({ payments: r.results.map(x => ({ ...x, review: x.matched === "review", void: x.matched === "void" })), fee_on: feeOn(), fee: STUDENT_FEE, fee_from: env.STUDENT_FEE_FROM || null, script_key: await paySecret() });
    }
    // Admin: put any payment on a code (an email = that student's code); also clears void/review.
    // Optional amount for a review row whose amount the script could not read.
    if (p === "/pay-assign" && request.method === "POST") {
      if (!me?.admin) return json({ error:"admin only" }, 403);
      const txn = String(body.txn||""); let code = String(body.code||"").trim().toUpperCase();
      if (/@/.test(code)) code = await studentCode(code.toLowerCase());
      if (!txn || !/^LQS?[A-Z0-9]{5}$/.test(code||"")) return json({ error:"bad txn or code" }, 400);
      const pr = await db.prepare("SELECT term, code, matched FROM payments WHERE txn=?").bind(txn).first();
      if (!pr) return json({ error:"no such payment" }, 404);
      // A no-memo / review row was stored under the current term without a code: put it on the term a payment
      // with this code would count for now (else a gap-time Zelle credits the term that just ended).
      if (!pr.code || pr.matched === "review") { const [cur] = curTerms(); pr.term = payTermFor(await paidSum(code, cur), /^LQS[A-Z0-9]{5}$/.test(code) ? STUDENT_FEE : PRICE); }
      const amt = body.amount != null && body.amount !== "" ? Number(body.amount) : null;
      if (amt !== null && !(amt > 0 && amt <= 100000)) return json({ error:"bad amount" }, 400);
      await db.prepare(`UPDATE payments SET code=?, term=?, matched=NULL${amt !== null ? ", amount=?" : ""} WHERE txn=?`).bind(...(amt !== null ? [code, pr.term, amt, txn] : [code, pr.term, txn])).run();
      return json({ ok:true, was: pr.code || null, ...(await settle(code, pr.term)) });
    }
    // Admin: void a payment (refunded, duplicate, wrong alert). It stops counting at once for students;
    // a professor's activation date is left for the admin to change (Professors -> Activate).
    if (p === "/pay-void" && request.method === "POST") {
      if (!me?.admin) return json({ error:"admin only" }, 403);
      const txn = String(body.txn||"");
      const pr = await db.prepare("SELECT term, code FROM payments WHERE txn=?").bind(txn).first();
      if (!pr) return json({ error:"no such payment" }, 404);
      await db.prepare("UPDATE payments SET matched='void' WHERE txn=?").bind(txn).run();
      await unsettle(pr.code);
      return json({ ok:true, txn, code: pr.code || null, total: pr.code ? await paidSum(pr.code, pr.term) : 0 });
    }
    // Admin: professor password-reset requests (made on the sign-in page), newest first.
    if (p === "/reset-requests") {
      if (!me?.admin) return json({ error:"admin only" }, 403);
      const r = await db.prepare("SELECT e.detail AS email, MAX(e.ts) AS at, COUNT(*) AS n, t.name AS name FROM events e LEFT JOIN teachers t ON t.email=e.detail WHERE e.event='reset_request' AND e.ts>? GROUP BY e.detail ORDER BY at DESC LIMIT 100")
        .bind(new Date(Date.now() - 30 * 86400000).toISOString()).all();
      return json({ requests: r.results });
    }
    // Admin: delete everything LOCKqz holds about one student (H15), and keep their class-list rows from
    // being imported again by the next Sync. Payment rows stay (money records) without name or memo.
    if (p === "/forget" && request.method === "POST") {
      if (!me?.admin) return json({ error:"admin only" }, 403);
      const email = String(body.email||"").trim().toLowerCase();
      if (!EMAIL_OK(email)) return json({ error:"enter the student's email" }, 400);
      if (await db.prepare("SELECT 1 FROM teachers WHERE email=?").bind(email).first()) return json({ error:"that is a professor account" }, 409);
      const devIds = (await db.prepare("SELECT device_id FROM devices WHERE student=? OR lower(student)=?").bind(email, email).all()).results.map(r => r.device_id);
      const ros = (await db.prepare("SELECT ou, user_id FROM roster WHERE email=?").bind(email).all()).results;
      const pc = await db.prepare("SELECT code FROM pay_codes_students WHERE email=?").bind(email).first();
      const st = [];
      for (const part of chunk(devIds, 99)) {
        const ph = placeholders(part.length);
        st.push(db.prepare(`DELETE FROM events WHERE device_id IN (${ph})`).bind(...part), db.prepare(`DELETE FROM locks WHERE device_id IN (${ph})`).bind(...part),
                db.prepare(`DELETE FROM email_codes WHERE device_id IN (${ph})`).bind(...part), db.prepare(`DELETE FROM devices WHERE device_id IN (${ph})`).bind(...part));
      }
      st.push(db.prepare("DELETE FROM events WHERE student=? AND event IN ('code_sent','code_send_failed','email_verified')").bind(email));
      for (const r of ros) st.push(db.prepare("DELETE FROM submissions WHERE ou=? AND user_id=?").bind(r.ou, r.user_id));
      st.push(db.prepare("DELETE FROM roster WHERE email=?").bind(email), db.prepare("DELETE FROM email_codes WHERE email=?").bind(email));
      if (pc) st.push(db.prepare("UPDATE payments SET payer=NULL, note=NULL WHERE code=?").bind(pc.code), db.prepare("DELETE FROM pay_codes_students WHERE email=?").bind(email));
      st.push(db.prepare("INSERT OR REPLACE INTO forgotten (email, at) VALUES (?,?)").bind(email, now()));
      await runBatches(db, st);
      return json({ ok:true, email, devices: devIds.length, roster_rows: ros.length });
    }

    // ---- teacher endpoints (need a logged-in teacher or the admin key) ----
    if (!teacher()) return json({ error: "unauthorized" }, 401);

    if ((p === "/quiz" || p === "/course" || p === "/protect" || p === "/gate") && request.method === "POST" && !me.admin && !me.verified)
      return json({ error: "Verify you teach this course first: open Brightspace and click LOCKqz Sync." }, 403);
    // PAID ONLY: verification proves you are a professor; only the admin's Activate (after payment)
    // turns the tool on. Nothing that protects, gates or rotates a quiz works for an unpaid account.
    if ((p === "/quiz" || p === "/course" || (p === "/protect" && body.on) || (p === "/gate" && body.on) || p === "/rotating") && request.method === "POST") {
      const u = String(body.url||"");
      const payOu = p === "/quiz" ? ids(u).ou : p === "/course" ? (u.match(/ou=(\d+)/) || u.match(/\/home\/(\d+)/) || u.match(/\/(\d+)(?:\/|$)/) || [])[1] : String(body.ou||"");
      if (!(await paidOu(payOu))) return json({ error: `Not active. LOCKqz turns on after payment ($${totalOf("professor", "zelle").toLocaleString("en-US")} per semester).` }, 402);
    }

    // The professor's own USC sections this semester (public Schedule of Classes), what is paid, and
    // how to pay: Venmo $1,000 per section with the memo code. Optional ?name= when the name differs.
    if (p === "/my-sections") {
      const nm = url.searchParams.get("name");
      if (nm && splitName(nm)) await db.prepare("UPDATE teachers SET name=? WHERE id=?").bind(String(nm).trim().slice(0,80), me.id).run();
      const r = await sectionsFor(me.id, nm || me.name);
      const memo = await payCode(me.id), [cur, nxt] = curTerms(), sums = { [cur]: 0, [nxt]: 0 }, paidMoney = { [cur]: 0, [nxt]: 0 };
      for (const x of (await db.prepare(`SELECT term, COALESCE(SUM(${CREDIT()}),0) AS s, COALESCE(SUM(amount),0) AS m FROM payments WHERE code=? AND term IN (?,?) AND ${COUNTS} GROUP BY term`).bind(memo, cur, nxt).all()).results) { sums[x.term] = Number(x.s); paidMoney[x.term] = Number(x.m); }
      const payTerm = payTermFor(sums[cur], PRICE);   // H14: partial payments add up per term
      const dueC = Math.round(PRICE * 100) - Math.round(sums[payTerm] * 100);
      return json({ ...r, price: PRICE, venmo: (env.VENMO_HANDLE || "").replace(/^@/, "") || null, zelle: env.ZELLE_TO || null, invoice: env.INVOICE_EMAIL || env.ADMIN_EMAIL || null, po: env.INVOICE_EMAIL || env.ADMIN_EMAIL || null, stripe: me.active ? null : stripeInfo("professor", dueC), memo, all_active: !!me.active, received: sums[payTerm], pay_term: payTerm, money: paidMoney[payTerm], tax: taxInfo(), ways: taxOn() ? waysFor("professor", Math.max(0, PRICE - sums[payTerm])) : null });
    }
    // Professor: Stripe Checkout (card or bank) for what is still due this term.
    if (p === "/pay/stripe-prof" && request.method === "POST") {
      if (me.admin || me.active) return json({ error:"already active" }, 409);
      if (!stripeOn()) return json({ error:"Card payments are not on yet." }, 503);
      const memo = await payCode(me.id), [cur, nxt] = curTerms(), sums = { [cur]: 0, [nxt]: 0 };
      for (const x of (await db.prepare(`SELECT term, COALESCE(SUM(${CREDIT()}),0) AS s FROM payments WHERE code=? AND term IN (?,?) AND ${COUNTS} GROUP BY term`).bind(memo, cur, nxt).all()).results) sums[x.term] = Number(x.s);
      const term = payTermFor(sums[cur], PRICE), dueC = Math.round(PRICE * 100) - Math.round(sums[term] * 100);
      if (dueC <= 0) return json({ error:"already paid" }, 409);
      const back = /^https:\/\/([a-z0-9-]+\.)*lockqz\.pages\.dev\/[^\s]*$/i.test(String(body.back||"")) ? String(body.back) : "https://prof.lockqz.pages.dev/";
      const r = await stripeCheckout({ kind: "professor", method: body.method === "bank" && stripeBank() ? "bank" : "card", code: memo, email: me.email, term, dueC, back });
      return json(r, r.url ? 200 : 502);
    }
    if (p === "/quiz" && request.method === "POST") {
      const { qi, ou } = ids(String(body.url||""));
      if (!/^\d+$/.test(String(ou||"")) || !/^\d+$/.test(String(qi||""))) return json({ error:"could not find ou= and qi= in that link" }, 400);
      if (!me.admin && !(await trustedInstructor(ou))) return json({ error:"Only the professor of this course can add its quizzes." }, 403);
      const lock_id = `${ou}-${qi}`;
      const dupe = await db.prepare("SELECT quiz_id,title,password,teacher_id FROM quizzes WHERE ou=? AND qi=?").bind(ou, qi).first();
      if (dupe && dupe.teacher_id !== me.id && !me.admin) return json({ error:"that quiz is already managed by another professor" }, 409);
      // One quiz = one row = one password (UNIQUE(ou,qi), migrate_020). Adding it again returns it as is.
      if (dupe) return json({ quiz_id: dupe.quiz_id, password: dupe.password, qi, lock_id, tag: `[LOCKqz] ${dupe.title||dupe.quiz_id}`, existing: true });
      // The professor added it back by hand: auto-protect may manage it again.
      await db.prepare("DELETE FROM lockqz_off WHERE ou=? AND qi=?").bind(ou, qi).run();
      await db.prepare("DELETE FROM pending_clear WHERE ou=? AND qi=?").bind(ou, qi).run();
      const quiz_id = rid(8);   // never the caller's: a chosen id could collide with (or probe) another row
      const password = "LQ-" + rid(8);
      await db.prepare("INSERT INTO quizzes (quiz_id,title,url,password,created_at,qi,teacher_id,lock_id,ou) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(quiz_id, str(body.title), str(body.url, 1000), password, now(), qi, me.id, lock_id, ou).run();
      return json({ quiz_id, password, qi, lock_id, tag: `[LOCKqz] ${str(body.title)||quiz_id}` });
    }
    if (p === "/quizzes") {
      const m = mine();
      const r = await db.prepare(`SELECT quiz_id,title,url,password,created_at,qi,lock_id,teacher_id,ou FROM quizzes WHERE ${m.sql} ORDER BY created_at DESC`).bind(...m.args).all();
      // A quiz's live password only for courses the caller instructs NOW (a removed co-instructor keeps the
      // row, so they can still remove it, but not the password students type).
      const okQ = await trustedOus(r.results.map(x => String(x.ou || "")));
      return json({ quizzes: r.results.map(x => okQ.has(String(x.ou || "")) ? x : { ...x, password: null }) });
    }
    if (p === "/course" && request.method === "POST") {
      const u = String(body.url || "");
      const ou = (u.match(/ou=(\d+)/) || u.match(/\/home\/(\d+)/) || u.match(/\/(\d+)(?:\/|$)/) || [])[1];
      if (!ou) return json({ error: "could not find the course id (ou=) in that link" }, 400);
      if (!me.admin && !(await trustedInstructor(ou))) return json({ error:"Only the professor of this course can protect it." }, 403);
      const ex = await db.prepare("SELECT teacher_id FROM courses WHERE ou=?").bind(ou).first();
      if (ex && ex.teacher_id && ex.teacher_id !== me.id && !me.admin) return json({ error:"that course is already protected by another professor" }, 409);
      const password = "LQ-" + rid(8);
      await db.prepare("INSERT INTO courses (ou,title,password,created_at,teacher_id) VALUES (?,?,?,?,?) ON CONFLICT(ou) DO UPDATE SET password=excluded.password,title=excluded.title,teacher_id=excluded.teacher_id")
        .bind(ou, str(body.title), password, now(), me.id).run();
      return json({ ou, password });
    }
    if (p === "/courses") {
      const m = mine();
      const r = await db.prepare(`SELECT ou,title,password,created_at,teacher_id FROM courses WHERE ${m.sql} ORDER BY created_at DESC`).bind(...m.args).all();
      const okC = await trustedOus(r.results.map(x => String(x.ou || "")));
      return json({ courses: r.results.map(x => okC.has(String(x.ou || "")) ? x : { ...x, password: null }) });
    }
    if (p === "/delete" && request.method === "POST") {
      const m = mine();
      let gone = 0;
      if (body.quiz_id) {
        const q = await db.prepare(`SELECT ou,qi,password FROM quizzes WHERE quiz_id=? AND ${m.sql}`).bind(String(body.quiz_id), ...m.args).first();
        if (q) {
          if (q.ou && q.qi) {
            await db.prepare("INSERT OR REPLACE INTO pending_clear (ou,qi,password) VALUES (?,?,?)").bind(String(q.ou), String(q.qi), q.password).run();
            // Removed on purpose: the next Sync's auto-protect must not quietly put it back.
            await db.prepare("INSERT OR REPLACE INTO lockqz_off (ou,qi,teacher_id,at) VALUES (?,?,?,?)").bind(String(q.ou), String(q.qi), me.id, now()).run();
          }
          gone += (await db.prepare("DELETE FROM quizzes WHERE quiz_id=?").bind(String(body.quiz_id)).run()).meta.changes;
        }
      }
      if (body.ou) gone += (await db.prepare(`DELETE FROM courses WHERE ou=? AND ${m.sql}`).bind(String(body.ou), ...m.args).run()).meta.changes;
      return gone ? json({ ok:true }) : json({ error:"nothing to remove (not found, or not yours)" }, 404);
    }

    // ---------- Brightspace connector: runs on the teacher's own Brightspace login (LOCKqz Sync bookmark) ----------
    if (p === "/synckey") {
      if (me.id === "admin") return json({ error:"log in with your professor account" }, 400);
      let k = (await db.prepare("SELECT sync_key FROM teachers WHERE id=?").bind(me.id).first())?.sync_key;
      if (!k || request.method === "POST") {
        k = "lqs_" + hex(crypto.getRandomValues(new Uint8Array(20)));
        await db.prepare("UPDATE teachers SET sync_key=?, sync_key_kept=0 WHERE id=?").bind(k, me.id).run();
      }
      return json({ key: k });
    }
    if (p === "/sync" && request.method === "POST") {
      // D1 budget (Free plan: 50 queries per request, a db.batch = 1; 100k rows written per day): every
      // per-course lookup is ONE query for all courses, writes go out in batches, and only rows that
      // actually changed are written -- a repeat sync with nothing new writes ~0 rows.
      // C10 (USC first): only this server's Brightspace (old Sync bookmarks send no host: allowed).
      const host = String(body.host || "").trim().toLowerCase();
      if (host && !bsHosts(env).includes(host)) return json({ error: "LOCKqz is not set up for this school yet.", reason: "other_school" }, 403);
      const t = now(), myEmail = EMAIL;
      const byOu = new Map();
      for (const c of (Array.isArray(body.courses) ? body.courses : []).slice(0, 80)) {
        const ou = String(c && c.ou || ""); if (/^\d+$/.test(ou) && !byOu.has(ou)) byOu.set(ou, c);
      }
      const ous = [...byOu.keys()];
      // The caller's own Brightspace id: bound ONCE, and only to the id a TRUSTED roster (admin- or
      // verified-professor-synced) already lists for this account's email -- a browser-sent id alone
      // proves nothing. After that it never changes.
      const whoId = body.whoami && body.whoami.id != null && /^[A-Za-z0-9_-]{1,64}$/.test(String(body.whoami.id)) ? String(body.whoami.id) : null;
      if (whoId && !me.admin && !me.bs_user_id) {
        const b = await db.prepare(`UPDATE teachers SET bs_user_id=? WHERE id=? AND (bs_user_id IS NULL OR bs_user_id='') AND EXISTS (SELECT 1 FROM roster r WHERE r.email=? AND r.user_id=? AND ${TRUSTED_TC})`)
          .bind(whoId, me.id, myEmail, whoId).run();
        if (b.meta.changes) me.bs_user_id = whoId;
      }
      // C4: roles. A course whose LIS roles (Access.LISRoles) name the caller Instructor marks the
      // caller's own class-list row as instructor; TeachingAssistant never does. A user with no role
      // name but the role_id Brightspace gives its learners is a learner.
      const LIS_INSTR = r => /(^|[\/#:])Instructor$/i.test(r) && !/TeachingAssistant/i.test(r);
      for (const c of byOu.values()) {
        const lis = Array.isArray(c.lis_roles) ? c.lis_roles.map(String).slice(0, 20) : [];
        c._lisInstr = lis.some(LIS_INSTR);
        if (!Array.isArray(c.classlist)) continue;
        const learnerIds = new Set(c.classlist.filter(x => x && /learner|student/i.test(String(x.role||"")) && x.role_id != null).map(x => String(x.role_id)));
        for (const x of c.classlist) {
          if (!x || typeof x !== "object") continue;
          if (!String(x.role||"").trim() && x.role_id != null && learnerIds.has(String(x.role_id))) x.role = "Student";
          if (c._lisInstr && whoId && String(x.id ?? "") === whoId && !INSTR_RE.test(String(x.role||""))) x.role = (String(x.role||"").trim() + " (Instructor)").trim();
        }
      }
      // Trust the roster, not the browser. You may write a course if you are its trusted instructor, or
      // nobody trusted OWNS it (an admin, or a verified professor who is Instructor on it). An unverified
      // account may only seed a course no admin/verified account has synced at all -- so a student can
      // never wipe or fake a real class. Seeding grants no power until a trusted instructor syncs it.
      const trusted0 = await trustedOus(ous);
      const info = me.admin ? {} : await ownerInfo(ous.filter(o => !trusted0.has(o)));
      const A = ous.filter(o => me.admin || trusted0.has(o) || (!info[o]?.owned && (me.verified || !info[o]?.trusted)));
      // H4 (FERPA): an account nobody vouched for stores NO class list or quiz rows at all -- its seed is
      // only the course name. Class lists from vouched accounts are readable only by trusted instructors.
      const canStore = me.admin || me.vouched;
      const withRoster = canStore ? A.filter(o => Array.isArray(byOu.get(o).classlist)) : [], withQuiz = canStore ? A.filter(o => Array.isArray(byOu.get(o).quizzes)) : [];
      const sel = async (sql, list, extra = []) => {
        const out = [];
        for (const part of chunk(list, 99 - extra.length)) out.push(...(await db.prepare(sql.replace("%IN%", placeholders(part.length))).bind(...extra, ...part).all()).results);
        return out;
      };
      const oldTc = new Map((A.length ? await sel("SELECT ou,name,code,role,synced_at FROM teacher_courses WHERE teacher_id=? AND ou IN (%IN%)", A, [me.id]) : []).map(r => [String(r.ou), r]));
      const oldRoster = withRoster.length ? await sel("SELECT ou,user_id,name,email,username,org_id,role FROM roster WHERE ou IN (%IN%)", withRoster) : [];
      const oldBq = withQuiz.length ? await sel("SELECT ou,qi,name,active,start_date,end_date,due_date,bs_has_password,bs_password_is_ours FROM bs_quizzes WHERE ou IN (%IN%)", withQuiz) : [];
      // H15: students deleted on request are never imported again (until they confirm their email again).
      const forgotten = withRoster.length ? new Set((await db.prepare("SELECT email FROM forgotten").all().catch(() => ({ results: [] }))).results.map(r => r.email)) : new Set();
      const same = (a, b) => (a == null ? null : String(a)) === (b == null ? null : String(b));
      const st = [], tcRows = [], touch = [], rUp = [], bUp = [];
      const touchBefore = new Date(Date.now() - 600000).toISOString();   // "last synced" kept fresh to 10 min
      for (const ou of A) {
        const c = byOu.get(ou), o = oldTc.get(ou);
        const v = [str(c.name), str(c.code), str(c.role, 80)];
        if (!o || !same(o.name, v[0]) || !same(o.code, v[1]) || !same(o.role, v[2])) tcRows.push([me.id, ou, ...v, t]);
        else if (!o.synced_at || o.synced_at < touchBefore) touch.push(ou);
      }
      st.push(...multiInsert(db, "INSERT INTO teacher_courses (teacher_id,ou,name,code,role,synced_at)", 6, tcRows,
        "ON CONFLICT(teacher_id,ou) DO UPDATE SET name=excluded.name,code=excluded.code,role=excluded.role,synced_at=excluded.synced_at"));
      for (const part of chunk(touch, 98)) st.push(db.prepare(`UPDATE teacher_courses SET synced_at=? WHERE teacher_id=? AND ou IN (${placeholders(part.length)})`).bind(t, me.id, ...part));
      // Class lists: upsert changed/new students, delete the ones Brightspace no longer lists.
      const oldR = new Map(oldRoster.map(r => [String(r.ou) + "\u0000" + String(r.user_id), r]));
      let selfInstr = false;     // I-B1: this sync's class lists name the caller (email + own id) Instructor
      for (const ou of withRoster) {
        const keep = new Set();
        for (const s of byOu.get(ou).classlist.slice(0, 3000)) {
          if (!s || typeof s !== "object") continue;
          const uid = String(s.id ?? ""), k = ou + "\u0000" + uid;
          if (keep.has(uid)) continue;
          const v = [str(s.name), (str(s.email) || "").toLowerCase() || null, str(s.username), str(s.org_id), str(s.role, 80)];
          if (v[1] && forgotten.has(v[1])) continue;
          keep.add(uid);
          if (whoId && uid === whoId && v[1] === myEmail && INSTR_RE.test(v[4] || "")) selfInstr = true;
          const o = oldR.get(k);
          if (!o || !same(o.name, v[0]) || !same(o.email, v[1]) || !same(o.username, v[2]) || !same(o.org_id, v[3]) || !same(o.role, v[4])) rUp.push([ou, uid, ...v, t]);
        }
        // A class list longer than the 3,000 read here is cut short: dropping "missing" students would then
        // remove real ones (and the gate could no longer admit them), so nobody is dropped for that course.
        const cut = byOu.get(ou).classlist.length > 3000;
        const drop = cut ? [] : oldRoster.filter(r => String(r.ou) === ou && !keep.has(String(r.user_id))).map(r => String(r.user_id));
        for (const part of chunk(drop, 98)) st.push(db.prepare(`DELETE FROM roster WHERE ou=? AND user_id IN (${placeholders(part.length)})`).bind(ou, ...part));
      }
      st.push(...multiInsert(db, "INSERT INTO roster (ou,user_id,name,email,username,org_id,role,synced_at)", 8, rUp,
        "ON CONFLICT(ou,user_id) DO UPDATE SET name=excluded.name,email=excluded.email,username=excluded.username,org_id=excluded.org_id,role=excluded.role,synced_at=excluded.synced_at"));
      // Brightspace quizzes: same diff. bs_password_is_ours survives only while the quiz still has a password.
      const oldQ = new Map(oldBq.map(r => [String(r.ou) + "\u0000" + String(r.qi), r]));
      const ownPw = new Set();   // quizzes that carry the professor's OWN Brightspace password (not ours)
      for (const ou of withQuiz) {
        const keep = new Set();
        for (const q of byOu.get(ou).quizzes.slice(0, 1000)) {
          if (!q || typeof q !== "object" || q.qi == null) continue;
          const qi = String(q.qi); if (keep.has(qi)) continue; keep.add(qi);
          const o = oldQ.get(ou + "\u0000" + qi);
          // A password in LOCKqz's own format (lq_password: "LQ-" + 8 of rid()'s letters, or a gate code
          // "LQ-" + 10 hex) is ours, never the professor's: e.g. a course copied from a term LOCKqz
          // protected keeps the old code, which nobody can hand out any more -> auto-protect replaces it.
          const v = [str(q.name), q.active ? 1 : 0, str(q.start, 40), str(q.end, 40), str(q.due, 40), q.has_password ? 1 : 0, (q.has_password && ((o && Number(o.bs_password_is_ours) === 1) || q.lq_password === true)) ? 1 : 0];
          if (v[5] === 1 && v[6] === 0) ownPw.add(`${ou}-${qi}`);
          if (!o || !same(o.name, v[0]) || Number(o.active) !== v[1] || !same(o.start_date, v[2]) || !same(o.end_date, v[3]) || !same(o.due_date, v[4]) || Number(o.bs_has_password) !== v[5] || Number(o.bs_password_is_ours) !== v[6]) bUp.push([ou, qi, ...v, t]);
        }
        const drop = byOu.get(ou).quizzes.length > 1000 ? [] : oldBq.filter(r => String(r.ou) === ou && !keep.has(String(r.qi))).map(r => String(r.qi));
        for (const part of chunk(drop, 98)) st.push(db.prepare(`DELETE FROM bs_quizzes WHERE ou=? AND qi IN (${placeholders(part.length)})`).bind(ou, ...part));
      }
      st.push(...multiInsert(db, "INSERT INTO bs_quizzes (ou,qi,name,active,start_date,end_date,due_date,bs_has_password,bs_password_is_ours,synced_at)", 10, bUp,
        "ON CONFLICT(ou,qi) DO UPDATE SET name=excluded.name,active=excluded.active,start_date=excluded.start_date,end_date=excluded.end_date,due_date=excluded.due_date,bs_has_password=excluded.bs_has_password,bs_password_is_ours=excluded.bs_password_is_ours,synced_at=excluded.synced_at"));
      await runBatches(db, st);
      if (bUp.length) for (const ou of new Set(bUp.map(r => r[0]))) await liveBust(url.origin, ou);
      // VERIFY ONLY FROM A TRUSTED ROSTER -- a student can never become a professor. Verified iff the
      // account is VOUCHED (admin invite) AND a trusted roster lists this email as Instructor with the
      // Brightspace id bound above. A grad student who instructs one course and takes another is still
      // verified; a pure student is never an Instructor anywhere. Written only when it changes.
      if (!me.admin) {
        // I-B1: an invited professor whose course nobody trusted has synced yet verifies through their
        // OWN Sync: the account is vouched, its email was fixed by the admin's invite, and the class list
        // its own Brightspace login returned lists that email + its own Brightspace id as Instructor.
        // (Unvouched accounts never get here: canStore is false, so selfInstr stays false.)
        if (selfInstr && !me.verified && me.vouched && (!me.bs_user_id || me.bs_user_id === whoId)
            && await db.prepare("SELECT 1 FROM invites WHERE used_by=? AND email=? AND used_at IS NOT NULL LIMIT 1").bind(myEmail, myEmail).first()) {
          const u = await db.prepare("UPDATE teachers SET bs_user_id=?, verified=1 WHERE id=? AND vouched=1 AND (bs_user_id IS NULL OR bs_user_id='' OR bs_user_id=?)").bind(whoId, me.id, whoId).run();
          if (u.meta.changes) { me.bs_user_id = whoId; me.verified = true; }
        }
        const prof = me.vouched && me.bs_user_id ? await db.prepare(`SELECT 1 FROM roster r WHERE r.email=? AND r.user_id=? AND ${INSTR_SQL} AND ${TRUSTED_TC} LIMIT 1`).bind(myEmail, String(me.bs_user_id)).first() : null;
        if (!!prof !== !!me.verified) { await db.prepare("UPDATE teachers SET verified=? WHERE id=?").bind(prof ? 1 : 0, me.id).run(); me.verified = !!prof; }
      }
      // Re-check AFTER the writes: a professor syncing a course for the first time becomes its trusted
      // instructor only now (their course row + roster are in), so seed eviction must come after.
      tiCache.clear();
      const trusted = await trustedOus(A);
      const mineA = A.filter(o => trusted.has(o)), st2 = [];
      // A trusted owner syncing a course evicts any seed rows a non-trusted account left on it.
      for (const part of chunk(mineA, 98)) st2.push(db.prepare(`DELETE FROM teacher_courses WHERE ou IN (${placeholders(part.length)}) AND teacher_id<>? AND teacher_id<>'admin' AND teacher_id NOT IN (SELECT id FROM teachers WHERE role='admin' OR verified=1)`).bind(...part, me.id));
      // Protect-by-default: quizzes that have not ended get a LOCKqz password automatically (courses you
      // instruct, paid) -- inactive (hidden/draft) ones too, so they are covered the moment they open
      // (F10). Never a quiz with the professor's OWN Brightspace password: it is listed as "has its own
      // password" and protected only when ticked (its password is saved first, C3).
      const quizOus = mineA.filter(ou => Array.isArray(byOu.get(ou).quizzes));
      const paidSet = quizOus.length ? await paidOusFor(me, quizOus) : new Set();
      const autoOus = quizOus.filter(ou => paidSet.has(ou));
      if (autoOus.length) {
        const seen = new Set();
        for (const part of chunk(autoOus, 33)) {
          const ph = placeholders(part.length);
          (await db.prepare(`SELECT ou,qi FROM quizzes WHERE ou IN (${ph}) AND qi IS NOT NULL UNION SELECT ou,qi FROM pending_clear WHERE ou IN (${ph}) UNION SELECT ou,qi FROM lockqz_off WHERE ou IN (${ph})`).bind(...part, ...part, ...part).all())
            .results.forEach(r => seen.add(String(r.ou) + "-" + String(r.qi)));
        }
        const add = [];
        for (const ou of autoOus) for (const q of byOu.get(ou).quizzes.slice(0, 1000)) {
          const qi = String(q && q.qi || ""); if (!/^\d+$/.test(qi) || seen.has(`${ou}-${qi}`)) continue;
          if (ownPw.has(`${ou}-${qi}`)) continue;
          const end = q.end ? Date.parse(q.end) : NaN; if (!isNaN(end) && end < Date.now()) continue;   // skip ended quizzes
          seen.add(`${ou}-${qi}`);
          add.push([rid(8), str(q.name), null, "LQ-" + rid(8), t, qi, me.id, `${ou}-${qi}`, ou, 0]);
        }
        st2.push(...multiInsert(db, "INSERT OR IGNORE INTO quizzes (quiz_id,title,url,password,created_at,qi,teacher_id,lock_id,ou,gated)", 10, add));
      }
      // Retention (H15) + D1 storage: bounded clean-up of old rows, at most ~1,000 rows per sync.
      st2.push(...purgeStmts());
      await runBatches(db, st2);
      await releaseUnpaid(me);
      // Only hand back passwords for courses this caller instructs (never leak another course's).
      return json({ ...(await bsState(mineA)), auto_gate: gateRequired() });
    }
    if (p === "/sync-result" && request.method === "POST") {
      const list = (Array.isArray(body.results) ? body.results : []).slice(0, 1000).filter(r => r && typeof r === "object");
      const okOus = await trustedOus(list.map(r => String(r.ou || "")));   // only the course's trusted instructor
      const st = [];
      for (const r of list) {
        const ou = String(r.ou||""), qi = String(r.qi||"");
        if (!okOus.has(ou) || !/^\d+$/.test(qi)) continue;
        // C3: the professor's own settings, saved ONCE before LOCKqz first changes them (an existing
        // saved value is never overwritten until the quiz is released).
        if (r.status !== "cleared") {
          if ("orig_password" in r && (r.orig_password === null || typeof r.orig_password === "string"))
            st.push(db.prepare("UPDATE bs_quizzes SET orig=json_set(COALESCE(orig,'{}'),'$.pw',?) WHERE ou=? AND qi=? AND json_type(COALESCE(orig,'{}'),'$.pw') IS NULL").bind(r.orig_password === null ? null : String(r.orig_password).slice(0, 200), ou, qi));
          if ("orig_hidden" in r && typeof r.orig_hidden === "boolean")
            st.push(db.prepare("UPDATE bs_quizzes SET orig=json_set(COALESCE(orig,'{}'),'$.hidden',json(?)) WHERE ou=? AND qi=? AND json_type(COALESCE(orig,'{}'),'$.hidden') IS NULL").bind(r.orig_hidden ? "true" : "false", ou, qi));
        }
        if (r.status === "set" || r.status === "already")
          st.push(db.prepare("UPDATE bs_quizzes SET bs_password_is_ours=1, bs_has_password=1 WHERE ou=? AND qi=? AND NOT (COALESCE(bs_password_is_ours,0)=1 AND COALESCE(bs_has_password,0)=1)").bind(ou, qi));
        else if (r.status === "cleared") {
          st.push(db.prepare("DELETE FROM pending_clear WHERE ou=? AND qi=?").bind(ou, qi));
          st.push(db.prepare("UPDATE bs_quizzes SET bs_password_is_ours=0, orig=NULL WHERE ou=? AND qi=? AND (COALESCE(bs_password_is_ours,0)<>0 OR orig IS NOT NULL)").bind(ou, qi));
        } else if (r.status === "error")
          st.push(db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)").bind(null, null, `${ou}-${qi}`, "brightspace_sync_error", String(r.msg||"").slice(0,300), now()));
      }
      await runBatches(db, st);
      return json({ ok:true });
    }
    if (p === "/protect" && request.method === "POST") {
      const ou = String(body.ou||""), qi = String(body.qi||"");
      if (!/^\d+$/.test(ou) || !/^\d+$/.test(qi)) return json({ error:"bad quiz" }, 400);
      if (!me.admin && !(await trustedInstructor(ou))) return json({ error:"Only the professor of this course can protect its quizzes." }, 403);
      const ex = await db.prepare("SELECT q.quiz_id AS quiz_id, q.password AS password, (SELECT password FROM pending_clear WHERE ou=? AND qi=?) AS pc FROM (SELECT 1) one LEFT JOIN quizzes q ON q.qi=? AND q.ou=?").bind(ou, qi, qi, ou).first();
      if (body.on) {
        if (ex && ex.quiz_id) {
          await db.batch([db.prepare("DELETE FROM pending_clear WHERE ou=? AND qi=?").bind(ou, qi), db.prepare("DELETE FROM lockqz_off WHERE ou=? AND qi=?").bind(ou, qi),
            db.prepare("UPDATE quizzes SET lock_id=? WHERE qi=? AND ou=? AND lock_id IS NOT ?").bind(`${ou}-${qi}`, qi, ou, `${ou}-${qi}`)]);
          return json({ ou, qi, on:true, password: ex.password });
        }
        // I-H2: turned off and on again before a Sync removed our password from Brightspace -> reuse
        // that password (it is what Brightspace still holds). Idempotent: a double click adds no row.
        const bq = await db.prepare("SELECT name FROM bs_quizzes WHERE ou=? AND qi=?").bind(ou, qi).first();
        const password = (ex && ex.pc) || ("LQ-" + rid(8));
        await db.batch([
          db.prepare("INSERT INTO quizzes (quiz_id,title,url,password,created_at,qi,teacher_id,lock_id,ou) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(ou,qi) DO NOTHING").bind(rid(8), bq?.name||null, null, password, now(), qi, me.id, `${ou}-${qi}`, ou),
          db.prepare("DELETE FROM pending_clear WHERE ou=? AND qi=?").bind(ou, qi), db.prepare("DELETE FROM lockqz_off WHERE ou=? AND qi=?").bind(ou, qi)]);
        const now2 = await db.prepare("SELECT password FROM quizzes WHERE ou=? AND qi=?").bind(ou, qi).first();
        return json({ ou, qi, on:true, password: now2 ? now2.password : password });
      }
      if (ex && ex.quiz_id) {
        await db.batch([db.prepare("INSERT OR REPLACE INTO pending_clear (ou,qi,password) VALUES (?,?,?)").bind(ou, qi, ex.password),
          db.prepare("DELETE FROM quizzes WHERE qi=? AND ou=?").bind(qi, ou)]);
      }
      // Remember the professor turned it OFF, so the next Sync's auto-protect does not re-add it.
      await db.prepare("INSERT OR REPLACE INTO lockqz_off (ou,qi,teacher_id,at) VALUES (?,?,?,?)").bind(ou, qi, me.id, now()).run();
      return json({ ou, qi, on:false, clear: ex && ex.quiz_id ? ex.password : (ex && ex.pc) || null });
    }
    // Turn the live access gate on/off for a quiz. While on, the Sync tab hides the quiz from everyone
    // and admits only students LOCKqz is actively locking. Requires the course to be synced + protected.
    if (p === "/gate" && request.method === "POST") {
      const ou = String(body.ou||""), qi = String(body.qi||"");
      if (!/^\d+$/.test(ou) || !/^\d+$/.test(qi)) return json({ error:"bad quiz" }, 400);
      if (!me.admin && !(await trustedInstructor(ou))) return json({ error:"Only the professor of this course can gate its quizzes." }, 403);
      const cur = await db.prepare("SELECT gated, sa_keep, teacher_id FROM quizzes WHERE qi=? AND ou=?").bind(qi, ou).first();
      if (!cur) return json({ error:"Protect this quiz first." }, 400);
      // Accommodation list: recorded once when the gate first starts; kept across Sync-tab reloads.
      let keep = cur.sa_keep;
      if (body.on && !(Number(cur.gated) === 1 && keep)) keep = JSON.stringify((Array.isArray(body.keep) ? body.keep : []).map(String).filter(x => /^\d+$/.test(x)).slice(0, 3000));
      if (!body.on) keep = null;
      const st = [db.prepare("UPDATE quizzes SET gated=?, sa_keep=?, bs_code=CASE WHEN ?=1 THEN bs_code ELSE NULL END WHERE qi=? AND ou=?").bind(body.on?1:0, keep, body.on?1:0, qi, ou)];
      // F4/I-H6: the Sync tab may pass the quiz's dates as Brightspace has them right now (the start
      // check while gated uses them); null = no date in Brightspace.
      const dt = v => v === null ? null : (typeof v === "string" && !isNaN(Date.parse(v)) ? v.slice(0, 40) : undefined);
      if (body.on && ("start" in body || "end" in body)) {
        const s0 = dt(body.start), e0 = dt(body.end);
        if (s0 !== undefined || e0 !== undefined)
          st.push(db.prepare(`UPDATE bs_quizzes SET ${[s0 !== undefined ? "start_date=?" : "", e0 !== undefined ? "end_date=?" : ""].filter(Boolean).join(",")} WHERE ou=? AND qi=?`).bind(...[s0, e0].filter(x => x !== undefined), ou, qi));
      }
      // I-M6: a Sync key kept only because the password was reset/changed during a gate dies when the
      // owner's last gate stops.
      if (!body.on && cur.teacher_id) st.push(db.prepare("UPDATE teachers SET sync_key=NULL, sync_key_kept=0 WHERE id=? AND sync_key_kept=1 AND NOT EXISTS (SELECT 1 FROM quizzes WHERE teacher_id=? AND gated=1)").bind(cur.teacher_id, cur.teacher_id));
      await db.batch(st);
      await liveBust(url.origin, `${ou}-${qi}`);
      return json({ ou, qi, gated: !!body.on, keep: keep ? JSON.parse(keep) : [] });
    }
    // The Sync tab confirms the exact password it just wrote into Brightspace for a gated quiz.
    if (p === "/rotated" && request.method === "POST") {
      const ou = String(body.ou||""), qi = String(body.qi||""), code = String(body.code||"");
      if (!/^\d+$/.test(ou) || !/^\d+$/.test(qi) || !/^LQ-[A-Za-z0-9-]{1,40}$/.test(code)) return json({ error:"bad request" }, 400);
      if (!me.admin && !(await trustedInstructor(ou))) return json({ error:"Only the professor of this course." }, 403);
      const r = await db.prepare("UPDATE quizzes SET bs_code=? WHERE qi=? AND ou=? AND gated=1").bind(code, qi, ou).run();
      return r.meta.changes ? json({ ok: true }) : json({ error: "that quiz is not protected and gated" }, 409);
    }
    // The Sync tab (the professor's own trusted Brightspace session) reports which students Brightspace
    // shows as having SUBMITTED the quiz. This is the only unforgeable proof a quiz actually ended, so
    // a device's "unlock" counts as a clean "done" only when the student is on this list; any other
    // unlock is flagged and the gate keeps their access revoked.
    if (p === "/submitted" && request.method === "POST") {
      const ou = String(body.ou||""), qi = String(body.qi||"");
      if (!/^\d+$/.test(ou) || !/^\d+$/.test(qi)) return json({ error:"bad quiz" }, 400);
      if (!me.admin && !(await trustedInstructor(ou))) return json({ error:"Only the professor of this course." }, 403);
      // C5: {users:[{id, completed:"<ISO>"}]} carries Brightspace's completion time (stored in `at`;
      // Brightspace's time always wins, a later one = a later attempt). The old {user_ids:[...]}/{ids:[...]}
      // shape has no time: at stays NULL ("submitted, time unknown" -> the pre-C5 rule applies on /live).
      const soon = Date.now() + 300000;
      const users = (Array.isArray(body.users) ? body.users : []).filter(u => u && typeof u === "object" && /^\d+$/.test(String(u.id ?? ""))).slice(0, 3000)
        .map(u => { const c = Date.parse(String(u.completed || "")); return [String(u.id), !isNaN(c) && c <= soon ? new Date(c).toISOString() : null]; });
      const timed = new Map(users.filter(u => u[1]).map(u => [u[0], u[1]]));
      const plain = new Set([...users.filter(u => !u[1]).map(u => u[0]), ...(Array.isArray(body.user_ids) ? body.user_ids : Array.isArray(body.ids) ? body.ids : []).map(String).filter(x => /^\d+$/.test(x)).slice(0, 3000)]);
      timed.forEach((_, k) => plain.delete(k));
      await runBatches(db, [
        ...multiInsert(db, "INSERT INTO submissions (ou,qi,user_id,at)", 4, [...timed].map(([u, c]) => [ou, qi, u, c]), "ON CONFLICT(ou,qi,user_id) DO UPDATE SET at=excluded.at WHERE submissions.at IS NOT excluded.at"),
        ...multiInsert(db, "INSERT OR IGNORE INTO submissions (ou,qi,user_id,at)", 4, [...plain].map(u => [ou, qi, u, null]))]);
      return json({ ok: true, count: timed.size + plain.size });
    }
    // Current rotating code(s) for quizzes the teacher protects -- the Sync tab writes these into
    // Brightspace each cycle so the live password changes every minute. Returns current + next so a
    // write is valid right up to the tick.
    if (p === "/rotating") {
      // The Sync tab passes {ou, qis:[...]} for ONE course it instructs; only that course's codes return.
      const ou = String(body.ou||"");
      if (!/^\d+$/.test(ou)) return json({ error:"bad course" }, 400);
      if (!me.admin && !(await trustedInstructor(ou))) return json({ error:"Only the professor of this course." }, 403);
      const qis = (Array.isArray(body.qis) ? body.qis : []).map(String).filter(x => /^\d+$/.test(x)).slice(0, 200);
      if (!qis.length) return json({ codes: {} });
      const ph = qis.map(()=>"?").join(",");
      const rows = (await db.prepare(`SELECT qi FROM quizzes WHERE ou=? AND qi IN (${ph})`).bind(ou, ...qis).all()).results;
      const secret = env.ROT_SECRET || env.TEACHER_KEY || "lqz-fallback";
      const b = minuteBucket(), codes = {};
      for (const r of rows) codes[String(r.qi)] = { cur: await rotatingPw(secret, ou, r.qi, b), next: await rotatingPw(secret, ou, r.qi, b + 1), bucket: b };
      return json({ codes });
    }
    if (p === "/bs") {
      const cs = (await db.prepare("SELECT ou,name,code,role,synced_at FROM teacher_courses WHERE teacher_id=? ORDER BY name LIMIT 200").bind(me.id).all()).results;
      if (!cs.length) return json({ courses: [] });
      // Passwords, protection state, class lists and who-installed are shown ONLY for courses the
      // caller INSTRUCTS (trusted roster). A seed row (e.g. a student who synced the course first)
      // lists the course and its quizzes, never a class list (H4, FERPA) or a password.
      const own = await trustedOus(cs.map(c => String(c.ou)));
      const ownList = cs.map(c => String(c.ou)).filter(o => own.has(o));
      const sub = "SELECT ou FROM teacher_courses WHERE teacher_id=?";
      const roster = [], devs = [];
      for (const part of chunk(ownList, 98)) {
        const ph = placeholders(part.length);
        roster.push(...(await db.prepare(`SELECT ou,user_id,name,email,username,role FROM roster WHERE ou IN (${ph}) ORDER BY name`).bind(...part).all()).results);
        // Installed devices by email through devices(student) -- no scan of every device (I-B3).
        devs.push(...(await db.prepare(`SELECT DISTINCT d.device_id, d.student AS who, d.platform, d.version, d.last_seen FROM roster r JOIN devices d ON d.student=r.email WHERE r.ou IN (${ph}) AND (d.student_verified=1 OR ?=0)`).bind(...part, codesOn ? 1 : 0).all()).results);
        // Old installs that typed a name (only while email codes are off).
        if (!codesOn) devs.push(...(await db.prepare(`SELECT device_id, lower(student) AS who, platform, version, last_seen FROM devices WHERE lower(student) IN (SELECT lower(name) FROM roster WHERE ou IN (${ph}))`).bind(...part).all()).results);
      }
      const qz = (await db.prepare(`SELECT b.ou,b.qi,b.name,b.active,b.start_date,b.end_date,b.due_date,b.bs_has_password,b.bs_password_is_ours,b.orig,q.password,q.lock_id,q.gated FROM bs_quizzes b LEFT JOIN quizzes q ON q.qi=b.qi AND q.ou=b.ou WHERE b.ou IN (${sub}) ORDER BY b.name`).bind(me.id).all()).results
        .map(q => own.has(String(q.ou)) ? withOrig(q) : withOrig({ ...q, orig: null, password: null, lock_id: null, gated: null }));
      const by = {}; devs.forEach(d => { (by[d.who] = by[d.who] || []).push(d); });
      const adminEmails = new Set(((await db.prepare("SELECT lower(email) AS e FROM teachers WHERE role='admin'").all()).results).map(x => x.e));
      return json({ courses: cs.map(c => ({ ...c, roster_hidden: !own.has(String(c.ou)),
        // Everyone LOCKqz locks: Learners AND TAs (any non-instructor role). The admin is the one
        // exempt person (developer mode), so he is never listed as someone who must install.
        students: roster.filter(r => r.ou === c.ou && takesQuizzes(r.role) && !adminEmails.has((r.email||"").toLowerCase())).map(r => {
          const d = by[(r.email||"").toLowerCase()] || by[(r.name||"").toLowerCase()] || [];
          return { name:r.name, email:r.email, ta: !/learner|student/i.test(r.role||""), installed: d.length > 0, platform: d[0]?.platform||null, last_seen: d[0]?.last_seen||null }; }),
        // has_own_password: the professor's own Brightspace password is on it (auto-protect skips it).
        quizzes: qz.filter(q => q.ou === c.ou).map(q => ({ ...q, has_own_password: Number(q.bs_has_password) === 1 && Number(q.bs_password_is_ours) !== 1 && !q.lock_id })) })) });
    }

    // Which events (events.quiz_id = "<ou>-<qi>") belong to the caller? Those of the courses they
    // INSTRUCT on a trusted roster (a seed row grants nothing), protect as a whole course, or hold
    // quizzes in. Read as quiz_id RANGES per course through the events(quiz_id, event) index, over the
    // last 30 days (H11: no scan of the whole events table).
    // FERPA: only courses the caller instructs NOW (trusted roster). A quiz or course row the caller made
    // earlier (e.g. a co-instructor since removed from the class list, or a TA re-roled) grants nothing.
    async function scopeOus() {
      const mo = myOusSql();
      return (await db.prepare(`SELECT DISTINCT ou FROM (${mo.sql})`).bind(...mo.args).all()).results.map(r => String(r.ou)).filter(o => /^\d+$/.test(o));
    }
    const rangeSql = (n, col = "quiz_id") => "(" + Array(n).fill(`(${col}>=? AND ${col}<?)`).join(" OR ") + ")";
    const rangeArgs = list => list.flatMap(o => [o + "-", o + "."]);
    const SCOPE_DAYS = 30;

    if (p === "/roster") {
      if (me.admin) return json({ devices: (await db.prepare("SELECT device_id,student,platform,version,installed_at,last_seen FROM devices ORDER BY last_seen DESC LIMIT 5000").all()).results });
      const since = new Date(Date.now() - SCOPE_DAYS * 86400000).toISOString(), seen = new Map();
      for (const part of chunk(await scopeOus(), 45))
        for (const d of (await db.prepare(`SELECT d.device_id,d.student,d.platform,d.version,d.installed_at,d.last_seen FROM devices d WHERE d.device_id IN (SELECT device_id FROM events WHERE ${rangeSql(part.length)} AND ts>?)`).bind(...rangeArgs(part), since).all()).results) seen.set(d.device_id, d);
      return json({ devices: [...seen.values()].sort((a, b) => String(b.last_seen||"").localeCompare(String(a.last_seen||""))) });
    }
    if (p === "/sessions") {
      const quiz = url.searchParams.get("quiz");
      const since = new Date(Date.now() - SCOPE_DAYS * 86400000).toISOString();
      const COLS = "id,device_id,student,quiz_id,event,detail,ts";
      // ?quiz= "<ou>-<qi>" (one quiz) or "<ou>" (its course); anything else matches nothing.
      const qOu = quiz ? (String(quiz).match(/^(\d+)(?:-\d+)?$/) || [])[1] : null;
      if (quiz && !qOu) return json({ events: [] });
      let ous = me.admin ? null : await scopeOus();
      if (qOu && ous && !ous.includes(qOu)) return json({ events: [] });
      if (qOu) ous = [qOu];
      let rows;
      if (!ous) rows = (await db.prepare(`SELECT ${COLS} FROM events WHERE ts>? ORDER BY id DESC LIMIT 500`).bind(since).all()).results;
      else {
        rows = [];
        const exact = quiz && /^\d+-\d+$/.test(quiz);
        for (const part of chunk(ous, 45)) rows.push(...(await db.prepare(`SELECT ${COLS} FROM events WHERE ${exact ? "quiz_id=?" : rangeSql(part.length)} AND ts>? ORDER BY id DESC LIMIT 500`).bind(...(exact ? [quiz] : rangeArgs(part)), since).all()).results);
        rows.sort((a, b) => b.id - a.id); rows = rows.slice(0, 500);
      }
      return json({ events: rows.map(({ id, ...r }) => r) });
    }
    if (p === "/live") {
      const quiz = url.searchParams.get("quiz");
      if (!quiz) return json({ error: "quiz id required" }, 400);
      const _ou0 = String(quiz).split("-")[0];
      // Only the course's trusted instructor (or the admin) -- never a seed row in teacher_courses.
      if (!me.admin && !(await trustedInstructor(_ou0))) return json({ error: "not your course" }, 403);
      const STALE = STALE_MS, nowMs = Date.now(), age = t => t ? (nowMs - Date.parse(t)) : null;
      // "<ou>-<qi>" = one quiz (exact match, uses the index); "<ou>" = every quiz of the course (range).
      const exact = /^\d+-\d+$/.test(quiz), courseWide = /^\d+$/.test(quiz);
      if (!exact && !courseWide) return json({ quiz, now: now(), stale_ms: STALE, rows: [] });
      // Shared answer (see LIVE_MEM): at most one computation per quiz per LIVE_TTL ms.
      const TTL = Number(env.LIVE_CACHE_MS ?? 8000), ck = liveKey(quiz, codesOn);
      const cacheHdr = { "Content-Type": "application/json", ...CORS };
      if (TTL > 0) {
        const m = LIVE_MEM.get(ck);
        if (m && nowMs - m.at < TTL && nowMs >= m.at) return new Response(m.body, { headers: cacheHdr });
        try { if (typeof caches !== "undefined" && caches.default) { const hit = await caches.default.match(liveCacheReq(url.origin, ck)); if (hit) { const b = await hit.text(); LIVE_MEM.set(ck, { at: nowMs, body: b }); return new Response(b, { headers: cacheHdr }); } } } catch {}
      }
      const liveOut = await (async () => {
      const qc = col => exact ? { sql: `${col}=?`, args: [quiz] } : { sql: `${col}>=? AND ${col}<?`, args: [quiz + "-", quiz + "."] };
      const lc = qc("l.quiz_id"), ec = qc("e.quiz_id");
      const locks = (await db.prepare(`SELECT l.device_id,l.quiz_id,l.last_lock,l.helper_seen,l.ext_seen,l.signed,l.ip,d.student,d.platform,d.student_verified FROM locks l LEFT JOIN devices d ON d.device_id=l.device_id WHERE ${lc.sql}`).bind(...lc.args).all()).results;
      // ONE pass over this quiz's events: tamper, developer-mode lock claims, and every unlock / gap.
      // Index events(quiz_id, event): only these event rows are read (course-wide: quiz_id range).
      const evs = (await db.prepare(`SELECT e.device_id,e.quiz_id,e.event,e.detail,e.ts,d.student,d.platform,d.student_verified FROM events e LEFT JOIN devices d ON d.device_id=e.device_id WHERE ${ec.sql} AND ${exact ? "e.event" : "+e.event"} IN ('tamper','dev_lock','unlock','auto_unlock','lock_gap') ORDER BY e.ts`).bind(...ec.args).all()).results;
      const tamp = new Set(), devClaim = new Set(), incidents = new Map();
      for (const e of evs) {
        if (e.event === "tamper") tamp.add(e.device_id);
        else if (e.event === "dev_lock") devClaim.add(e.device_id);
        else { const k = e.device_id + "|" + e.quiz_id; if (!incidents.has(k)) incidents.set(k, []); incidents.get(k).push(e); }
      }
      // Developer mode: only the admin's own Mac may hold a lock without blocking AI. A dev claim
      // from any other device is a modified client -> tamper (never admitted).
      const adminEm = new Set(((await db.prepare("SELECT lower(email) AS e FROM teachers WHERE role='admin'").all()).results).map(x => x.e));
      // Quiz windows (Brightspace start/end) for this course.
      const win = new Map(((await db.prepare(`SELECT qi,start_date,end_date FROM bs_quizzes WHERE ou=?${exact ? " AND qi=?" : ""}`).bind(_ou0, ...(exact ? [quiz.split("-")[1]] : [])).all()).results).map(w => [String(w.qi), w]));
      const ms0 = v => { const x = v ? Date.parse(v) : NaN; return isNaN(x) ? null : x; };
      win.forEach(w => { w._s = ms0(w.start_date); w._e = ms0(w.end_date); });   // parsed once (CPU: 10 ms on Workers Free)
      const startOf = qi => { const w = win.get(qi); return w ? w._s : null; };
      const endOf = qi => { const w = win.get(qi); return w ? w._e : null; };
      const started = qi => { const s = startOf(qi); return s === null || nowMs >= s; };   // not before scheduled start
      const inWindow = (ts, qi) => { const t = Date.parse(ts), s = startOf(qi), e = endOf(qi); return !isNaN(t) && (s === null || t >= s) && (e === null || t <= e); };
      const rows = [], lockedKeys = new Set();
      for (const l of locks) {
        lockedKeys.add(l.device_id + "|" + l.quiz_id);
        const a = age(l.last_lock), h = age(l.helper_seen), e = age(l.ext_seen);
        let status = "locked";
        const dev = devClaim.has(l.device_id);
        if (tamp.has(l.device_id) || (dev && !adminEm.has(String(l.student||"").toLowerCase()))) status = "tamper";
        else if (a !== null && a > STALE) {
          // "helper_killed" needs PROOF: the agent kept reporting after the helper went silent. A wifi
          // drop silences both -> "dark" (never treated as cheating; access is kept).
          const helperDown = h === null || h > STALE, extDown = e === null || e > 720000;   // the agent reports only while it cannot reach the helper
          const agentAfterHelper = e !== null && (h === null || e < h - 30000);
          status = helperDown && agentAfterHelper ? "helper_killed" : (extDown && !helperDown ? "browser_closed" : "dark");
        }
        else if (dev) status = "developer";
        rows.push({ device_id:l.device_id, student:l.student||null, platform:l.platform||null, status, last_lock:l.last_lock, age_ms:a, verified: Number(l.signed) === 1, ip: l.ip||null, sv: Number(l.student_verified) === 1, _q: l.quiz_id });
      }
      // Devices that unlocked and hold no lock now.
      for (const [k, list] of incidents) {
        if (lockedKeys.has(k)) continue;
        const u = list.filter(e => e.event === "unlock" || e.event === "auto_unlock").pop();
        if (!u) continue;
        rows.push({ device_id:u.device_id, student:u.student||null, platform:u.platform||null, status:"done", sv: Number(u.student_verified) === 1, _q: u.quiz_id });
      }
      // A student is admitted ONLY when LOCKqz is holding a fresh, device-signed lock (status "locked",
      // verified). The gate loop reads r.eligible + r.user_id to grant/revoke Brightspace special access.
      rows.forEach(r => { r.eligible = (started(r._q.split("-")[1]) && (r.status === "locked" || r.status === "developer") && r.verified === true); });
      // Resolve each locked device to a Brightspace user_id, by email OR name OR username, from THIS
      // course's roster only (one query, no per-student bound params -> no D1 100-param limit).
      // Only the roster rows we need: by email through the email index (emails are stored lowercase).
      // The whole-course scan is a fallback only for old installs that typed a name (codes off).
      const whoList = [...new Set(rows.map(r => String(r.student||"").toLowerCase()).filter(Boolean))];
      const byMail = whoList.filter(w => w.includes("@"));
      let rl = byMail.length ? (await db.prepare("SELECT email AS e, lower(name) AS n, lower(username) AS u, name AS display, user_id FROM roster WHERE email IN (SELECT value FROM json_each(?)) AND ou=?").bind(JSON.stringify(byMail), _ou0).all()).results : [];
      if (!codesOn && whoList.some(w => !w.includes("@")))
        rl = (await db.prepare("SELECT lower(email) AS e, lower(name) AS n, lower(username) AS u, name AS display, user_id FROM roster WHERE ou=?").bind(_ou0).all()).results;
      const byEmail = {}, byName = {}, byUser = {};
      rl.forEach(x => { if (x.e) byEmail[x.e] = x; if (x.n) byName[x.n] = x; if (x.u) byUser[x.u] = x; });
      rows.forEach(r => {
        // Once email codes are on, only a CONFIRMED email (typed code) admits a student.
        if (codesOn && !r.sv) { r.user_id = null; r.email = null; return; }
        const who = String(r.student||"").toLowerCase();
        const hit = byEmail[who] || byName[who] || byUser[who];
        if (hit) { r.user_id = hit.user_id || null; if (hit.display) r.student = hit.display; }
        r.email = who.includes("@") ? who : (hit && hit.e) || null;
      });
      // Student fee: the gate never admits an unpaid student (no Brightspace user -> no special access),
      // so a quiz password passed on by a paid classmate is useless to them.
      // Rows with an email but no class-list match are marked too: the Sync tab may resolve them itself.
      if (feeOn()) { const okPaid = await paidEmailsCached(rows.map(r => r.email), quiz);
        rows.forEach(r => { if ((r.user_id || r.email) && !okPaid.has(String(r.email||"").toLowerCase())) { r.user_id = null; r.eligible = false; r.unpaid = true; } }); }
      // Server-confirmed submissions (reported by the professor's trusted Sync session), with the time
      // Brightspace says each student completed (C5). Any unlock -- or a period the helper went dark --
      // inside the quiz window and BEFORE that completion is "left_early" (red: AI may have been open),
      // even after the student submits and even if a later lock re-created the lock row: the events
      // stay, so neither a re-lock nor a submission can hide it. Re-admission: a flagged student who
      // is locked again stays eligible (the gate admits them) but stays red for the professor.
      // Clean: the agent's own "quiz_submitted" unlock (only while the Sync tab is not reporting
      // submissions for this quiz, or for 2 minutes until its report arrives). The helper's failsafe
      // cap is red only inside the window before submission; after the window it is not flagged.
      const subs = new Map(((await db.prepare(`SELECT qi,user_id,at FROM submissions WHERE ou=?${exact ? " AND qi=?" : ""}`).bind(_ou0, ...(exact ? [quiz.split("-")[1]] : [])).all()).results).map(x => [String(x.qi) + ":" + String(x.user_id), x.at]));
      const subsFor = new Set([...subs.keys()].map(x => x.split(":")[0]));
      const reasonOf = e => { let d = null; try { d = JSON.parse(e.detail); } catch { d = e.detail; }
        const r = d && typeof d === "object" ? d.reason : (typeof d === "string" ? d : null);
        return typeof r === "string" && r ? r.slice(0, 40) : null; };
      // A gap spans from when the helper went silent (detail.from) to when it came back (ts).
      const whenOf = e => { if (e.event === "lock_gap") { try { const f = JSON.parse(e.detail).from; if (f && !isNaN(Date.parse(f))) return f; } catch {} } return e.ts; };
      const overlaps = (e, qi) => { const f = Date.parse(whenOf(e)), t = Date.parse(e.ts), s = startOf(qi), en = endOf(qi); return !isNaN(t) && (s === null || t >= s) && (en === null || f <= en); };
      rows.forEach(r => {
        const qi = r._q.split("-")[1];
        const key = qi + ":" + String(r.user_id);
        const submitted = !!(r.user_id && subs.has(key));
        const doneAt = submitted ? Date.parse(subs.get(key)) : NaN;
        const inc = (incidents.get(r.device_id + "|" + r._q) || []).filter(e => {
          const w = whenOf(e);
          if (!overlaps(e, qi)) return false;
          const clean = e.event === "unlock" && reasonOf(e) === "quiz_submitted";
          // Completion time unknown (old Sync tab): the submission itself is the proof (pre-C5 rule).
          // A "quiz_submitted" unlock is clean only if it came AFTER Brightspace's completion time (60 s
          // slack for clocks): the reason is chosen by the student's own agent (any navigation to the
          // quiz list / a submissions page sends it, and so does a local /unlock call).
          if (submitted) return !isNaN(doneAt) && Date.parse(w) < doneAt - (clean ? 60000 : 0);
          return !(clean && (!subsFor.has(qi) || nowMs - Date.parse(e.ts) < 120000));
        });
        if (submitted) r.submitted = true;
        // Dark lock + Brightspace completion while dark: the laptop was online enough to submit, so the
        // helper was stopped (not a wifi drop). Red, even with no unlock event.
        if (submitted && !isNaN(doneAt) && (r.status === "dark" || r.status === "helper_killed") && r.last_lock && Date.parse(r.last_lock) + STALE < doneAt) {
          r.status = "left_early"; r.reason = "went_dark"; r.flagged_at = r.last_lock; return; }
        if (!inc.length) return;
        if (r.status === "locked" || r.status === "done" || r.status === "browser_closed") {
          const last = inc[inc.length - 1];
          r.status = "left_early"; r.submitted = submitted;
          r.reason = last.event === "lock_gap" ? "went_dark" : (reasonOf(last) || (last.event === "auto_unlock" ? "cap" : "unlock"));
          r.flagged_at = whenOf(last);
        }
      });
      rows.forEach(r => { delete r._q; });
      return { quiz, now: now(), stale_ms: STALE, rows };
      })();
      const bodyStr = JSON.stringify(liveOut);
      if (TTL > 0) {
        LIVE_MEM.set(ck, { at: nowMs, body: bodyStr });
        if (LIVE_MEM.size > 500) LIVE_MEM.delete(LIVE_MEM.keys().next().value);
        try { if (typeof caches !== "undefined" && caches.default) await caches.default.put(liveCacheReq(url.origin, ck), new Response(bodyStr, { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${Math.max(1, Math.round(TTL / 1000))}` } })); } catch {}
      }
      return new Response(bodyStr, { headers: cacheHdr });
    }

    return json({ error: "not found", path: p }, 404);
  } catch (e) {
    // Free-plan D1 daily write cap: a clean, retryable answer (apps retry quietly; nobody sees a popup).
    if (/exceeded D1|row write limit|daily .*limit/i.test(String(e))) return json({ error: "server_busy", retry_minutes: 30 }, 503);
    return json({ error: String(e) }, 500);
  }
}
