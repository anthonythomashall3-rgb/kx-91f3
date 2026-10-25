// LOCKqz API (Cloudflare Pages Function). Bindings: env.DB (D1), env.TEACHER_KEY (admin key).
// Routes are under /api/*.  Teachers sign up / log in with email + password; each sees only
// their own quizzes, courses, students and activity. The TEACHER_KEY is the admin master key
// (sees everything, can reset a teacher's password). Device endpoints (/report, /password, /install)
// are authenticated with per-device keys; see "Device authentication" below.
const AI_DOMAINS = [   // = app/mac/blocklist.txt (tests/test_blocklist.mjs keeps them in sync)
  "openai.com","chatgpt.com","chat.openai.com","oaistatic.com","oaiusercontent.com","sora.com",
  "sora.chatgpt.com","anthropic.com","claude.ai","claude.com","console.anthropic.com","gemini.google.com",
  "bard.google.com","aistudio.google.com","makersuite.google.com","generativelanguage.googleapis.com","notebooklm.google.com","notebooklm.google",
  "copilot.microsoft.com","copilot.cloud.microsoft","m365.cloud.microsoft","bing.com/chat","perplexity.ai","pplx.ai",
  "grok.com","x.ai","grok.x.com","deepseek.com","chat.deepseek.com","mistral.ai",
  "chat.mistral.ai","meta.ai","qwen.ai","chat.qwen.ai","tongyi.aliyun.com","kimi.com",
  "kimi.moonshot.cn","moonshot.cn","z.ai","chatglm.cn","bigmodel.cn","poe.com",
  "character.ai","you.com","phind.com","huggingface.co/chat","hf.co/chat","chat.lmsys.org",
  "lmarena.ai","groq.com","chatbot.so","cluely.com","pi.ai","inflection.ai",
  "venice.ai","together.ai","api.together.xyz","chat.reka.ai","reka.ai","cohere.com",
  "coral.cohere.com","jasper.ai","writesonic.com","chatsonic.com","copy.ai","quillbot.com",
  "deepai.org","forefront.ai","theb.ai","yiyan.baidu.com","doubao.com","spark.ai",
  "xinghuo.xfyun.cn","grammarly.com","app.grammarly.com","api.openai.com","api.anthropic.com","api.perplexity.ai",
  "api.mistral.ai","api.groq.com","api.x.ai","api.deepseek.com","api.cohere.ai","openrouter.ai",
  "api.openrouter.ai","ollama.com","ollama.ai","lmstudio.ai","gpt4all.io","jan.ai",
  "msty.app","cloudflare-dns.com","chrome.cloudflare-dns.com","mozilla.cloudflare-dns.com","dns.google","dns.google.com",
  "dns.quad9.net","doh.opendns.com","dns.nextdns.io",
  "cdn.oaistatic.com","platform.openai.com","sydney.bing.com","labs.perplexity.ai","x.com/i/grok","console.x.ai","platform.deepseek.com","console.mistral.ai","chat.z.ai","api.z.ai","beta.character.ai","duck.ai"];
const now = () => new Date().toISOString();
// "Today" in America/Los_Angeles as YYYY-MM-DD, so a professor stays active through the end of their
// paid date in Pacific time (not 5pm Pacific, which UTC-midnight would give).
// DST-correct (Intl, America/Los_Angeles); the fixed UTC-8 fallback only runs if Intl has no tz data.
const LA_FMT = (() => { try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }); } catch { return null; } })();
const laToday = () => {
  if (LA_FMT) { const p = {}; for (const x of LA_FMT.formatToParts(new Date())) p[x.type] = x.value; if (p.year && p.month && p.day) return `${p.year}-${p.month}-${p.day}`; }
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
const rid = (n=6) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map(b=>"ABCDEFGHJKMNPQRSTUVWXYZ23456789"[b%30]).join("");
const hex = a => Array.from(new Uint8Array(a)).map(b=>b.toString(16).padStart(2,"0")).join("");
const CORS = { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"Content-Type, X-LOCKqz-Teacher, X-LOCKqz-Sync", "Access-Control-Allow-Methods":"GET, POST, OPTIONS", "Access-Control-Max-Age":"86400" };
const json = (o, s=200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type":"application/json", ...CORS } });

// Password hashing: PBKDF2-SHA256, 100k rounds, per-user salt.
async function hashPw(pw, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name:"PBKDF2", hash:"SHA-256", salt:new TextEncoder().encode(salt), iterations:100000 }, key, 256);
  return hex(bits);
}
const ids = u => ({ qi: (u.match(/qi=(\d+)/) || u.match(/quizId=(\d+)/) || [])[1] || null,
                    ou: (u.match(/ou=(\d+)/) || u.match(/\/home\/(\d+)/) || [])[1] || null });

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
async function verifyDevice(request, raw, db) {
  const id = (request.headers.get("X-LOCKqz-Device") || "").trim();
  const ts = (request.headers.get("X-LOCKqz-Time") || "").trim();
  const sig = (request.headers.get("X-LOCKqz-Sig") || "").trim().toLowerCase();
  if (!id || !ts || !sig) return { ok: false, why: "unsigned" };
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(unixNow() - t) > SIG_WINDOW_S) return { ok: false, why: "clock", id };
  const d = await db.prepare("SELECT device_key, revoked FROM devices WHERE device_id=?").bind(id).first();
  if (!d || !d.device_key) return { ok: false, why: "unregistered", id };
  if (d.revoked) return { ok: false, why: "revoked", id };
  const msg = `POST\n${new URL(request.url).pathname}\n${ts}\n${await sha256hex(raw)}`;
  return request.method === "POST" && sameHex(await hmacHex(d.device_key, msg), sig) ? { ok: true, id } : { ok: false, why: "bad signature", id };
}
const isRegistered = async (db, id) => !!(id && await db.prepare("SELECT 1 AS r FROM devices WHERE device_id=? AND device_key IS NOT NULL").bind(String(id)).first());

// ---- Student email verification (25 Oct 2026) ----
// A device's student email counts (quiz gate, professor's "Ready" list) only after the student
// types the 6-digit code LOCKqz emailed to it. Codes: 15 minutes, 5 tries, only a hash is stored.
// Mail goes out through Gmail SMTP (free, 500/day) using Pages secrets MAIL_USER + MAIL_APP_PASSWORD.
// Without those secrets codes are off and an email is accepted after the roster check (old behaviour).
const CODE_MS = 15 * 60000, CODE_TRIES = 5;
const EMAIL_OK = e => /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e);
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
  const text = `Your LOCKqz code is ${code}\n\nType it into the LOCKqz window on your computer. It expires in 15 minutes.\n\nIf you did not ask for this, ignore this email.`;
  if (typeof env.MAIL_SINK === "function") return env.MAIL_SINK({ to, subject, text, code });   // tests
  const open = typeof env.MAIL_OPEN === "function" ? env.MAIL_OPEN   // tests: fake SMTP server
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
  const raw = request.method === "POST" ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array(0);
  let body = {};
  if (raw.length) { try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { body = {}; } }
  if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
  const strict = String(env.REQUIRE_SIGNED || "").trim() === "1";
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
    if (t) me = { id:t.id, email:t.email, name:t.name, admin: t.role === "admin", verified: t.role === "admin" || t.verified === 1, active: t.role === "admin" || (!!t.active_until && t.active_until >= laToday()), active_until: t.active_until||null, bs_user_id: t.bs_user_id||null, vouched: t.role === "admin" || Number(t.vouched) === 1 || t.verified === 1 };
  }
  const clientIp = request.headers.get("CF-Connecting-IP") || "?";
  // The sync key (in the bookmarklet URL, readable by any script on the Brightspace page) authorizes
  // ONLY the Brightspace-connector endpoints. Account management needs the real session token.
  const viaSyncKey = !!(request.headers.get("X-LOCKqz-Sync") || "").trim() && !(hdr && adminKey && sameHex(hdr, adminKey)) && !(hdr);
  const SYNC_OK = new Set(["/sync","/sync-result","/protect","/gate","/rotating","/rotated","/submitted","/live","/synckey","/me","/bs"]);
  const teacher = () => !!me;
  const mine = (col="teacher_id") => me.admin ? { sql:"1=1", args:[] } : { sql:`${col}=?`, args:[me.id] };
  // Only the INSTRUCTOR of a course (named Instructor on a roster an admin or verified professor synced)
  // may act on it. TAs NEVER qualify -- a TA could otherwise reach the other classes they are in.
  // Anthony (admin) is the sole exception, handled by me.admin at each call site.
  const EMAIL = String(me && me.email || "").toLowerCase();
  const INSTR_SQL = "(r.role LIKE '%nstructor%' OR r.role LIKE '%rofessor%' OR r.role LIKE '%aculty%')";
  // A roster row r is TRUSTED when an admin or a verified professor has synced that course.
  // (teacher_id 'admin' = a sync made with the master key; real account ids never look like that.)
  const TRUSTED_TC = "EXISTS (SELECT 1 FROM teacher_courses tct LEFT JOIN teachers tet ON tet.id=tct.teacher_id WHERE tct.ou=r.ou AND (tct.teacher_id='admin' OR tet.role='admin' OR tet.verified=1))";
  // Roles LOCKqz locks during quizzes: everyone except the course's instructors (Learners and TAs).
  const takesQuizzes = role => !/nstructor|rofessor|aculty/i.test(String(role||"")) && !!String(role||"").trim();
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
  // ---- per-section billing ($1,000 per section per semester) ----
  // A Brightspace course (ou) is paid when the professor paid for the USC section(s) it holds.
  // Admin and an account-wide activation (active_until) count as paid for everything.
  const PRICE = 5000;   // flat, per professor per semester (all their sections); paid = admin Activate until the semester end
  const secNums = txt => (String(txt).match(/(?<!\d)\d{5}(?!\d)/g) || []);
  const courseKeys = txt => { const out = new Set(); const re = /(?<![A-Z])([A-Z]{2,5})[\s_\-]*(\d{3}[A-Z]?)(?![0-9])/g; let m; while ((m = re.exec(String(txt).toUpperCase()))) out.add(m[1] + m[2]); return [...out]; };
  const ckey = c => String(c||"").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const paidCache = new Map();   // per request: teacher id -> paid_sections rows; `${id}:${ou}` -> bool
  async function paidOuFor(t, ou) {
    if (!t) return false;
    if (t.admin || t.active) return true;
    const ck = `${t.id}:${ou}`;
    if (paidCache.has(ck)) return paidCache.get(ck);
    const v = await paidOuUncached(t, String(ou));
    paidCache.set(ck, v);
    return v;
  }
  async function paidOuUncached(t, ou) {
    if (!paidCache.has(t.id)) paidCache.set(t.id, (await db.prepare("SELECT term,section,course,first,last FROM paid_sections WHERE teacher_id=? AND until>=?").bind(t.id, laToday()).all().catch(()=>({results:[]}))).results);
    const paid = paidCache.get(t.id);
    if (!paid.length) return false;
    const tc = await db.prepare("SELECT name,code FROM teacher_courses WHERE ou=? ORDER BY (teacher_id=?) DESC LIMIT 1").bind(String(ou), t.id).first();
    if (!tc) return false;
    const txt = `${tc.name||""} ${tc.code||""}`;
    const paidSec = new Set(paid.map(x => String(x.section)));
    const nums = secNums(txt);
    if (nums.some(n => paidSec.has(n))) return true;
    for (const c of courseKeys(txt)) {
      const here = paid.filter(x => ckey(x.course) === c);
      if (!here.length) continue;
      // The shell names specific real sections of this course, none of them paid -> not paid.
      if (nums.length) {
        const ph = nums.map(()=>"?").join(",");
        const real = (await db.prepare(`SELECT section,course FROM usc_sections WHERE section IN (${ph})`).bind(...nums).all()).results.filter(r => ckey(r.course) === c);
        if (real.length) continue;
      }
      // Combined shell (no section numbers): every section of this course the professor teaches must be paid.
      const h = here[0];
      const all = (await db.prepare("SELECT DISTINCT section,course FROM usc_sections WHERE term=? AND lower(last)=lower(?) AND lower(first)=lower(?)").bind(h.term, h.last||"", h.first||"").all()).results.filter(r => ckey(r.course) === c);
      if (!all.length || all.every(r => paidSec.has(String(r.section)))) return true;
    }
    return false;
  }
  const paidOu = ou => paidOuFor(me, ou);
  // Release every quiz this professor protects in a course that is not paid (next Sync removes the
  // password from Brightspace, so no student is locked out).
  async function releaseUnpaid(t) {
    if (!t || t.admin || t.active) return;          // fully active: nothing to release (no query)
    const qs = (await db.prepare("SELECT qi,ou,password FROM quizzes WHERE teacher_id=? AND ou IS NOT NULL").bind(t.id).all()).results;
    const st = [];
    for (const q of qs) {
      const ou = String(q.ou);
      if (await paidOuFor(t, ou)) continue;
      st.push(db.prepare("INSERT OR REPLACE INTO pending_clear (ou,qi,password) VALUES (?,?,?)").bind(ou, String(q.qi), q.password));
      st.push(db.prepare("DELETE FROM quizzes WHERE qi=? AND ou=? AND teacher_id=?").bind(q.qi, ou, t.id));
    }
    await runBatches(db, st);
  }
  const curTerms = () => { const d = laToday(), y = +d.slice(0,4), m = +d.slice(5,7), s = m <= 5 ? 1 : (m <= 7 ? 2 : 3); return [String(y*10+s), String(s < 3 ? y*10+s+1 : (y+1)*10+1)]; };
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
  const STUDENT_FEE = Number(env.STUDENT_FEE || 5);
  const feeOn = () => { const from = String(env.STUDENT_FEE_FROM || ""); return /^\d{4}-\d{2}-\d{2}$/.test(from) && laToday() >= from; };
  const termEnd = () => { const d = laToday(), y = d.slice(0,4), m = +d.slice(5,7); return m <= 5 ? `${y}-05-31` : (m <= 7 ? `${y}-08-15` : `${y}-12-31`); };
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
  const paidSum = async (code, term) => Number((await db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE code=? AND term=?").bind(code, term).first())?.s || 0);
  async function studentPaid(email) {
    if (!feeOn()) return true;
    email = String(email||"").trim().toLowerCase(); if (!email) return false;
    const staff = await db.prepare("SELECT 1 FROM teachers WHERE lower(email)=? AND (role='admin' OR verified=1)").bind(email).first();
    if (staff) return true;                                     // professors and the admin never pay the student fee
    const c = await db.prepare("SELECT code FROM pay_codes_students WHERE email=?").bind(email).first();
    return !!c && (await paidSum(c.code, curTerms()[0])) >= STUDENT_FEE;
  }
  async function payInfo(email, limitIp = null) {
    const code = await studentCode(email, limitIp);
    if (code && typeof code === "object") return code;   // { limited: true }
    return { amount: STUDENT_FEE, code, venmo: (env.VENMO_HANDLE || "").replace(/^@/, "") || null, zelle: env.ZELLE_TO || null,
             url: PAY_URL + (email ? "?email=" + encodeURIComponent(String(email).toLowerCase()) : "") };
  }
  // Record one payment (idempotent by txn) and apply it: student fee, or professor activation.
  async function applyPayment(p) {
    const txn = String(p.txn||"").slice(0,120); const amount = Number(p.amount);
    if (!txn || !(amount > 0) || amount > 100000) return { ok:false, error:"bad payment" };
    const text = `${p.note||""} ${p.subject||""}`.toUpperCase();
    let code = (text.match(/LQS[A-Z0-9]{5}(?![A-Z0-9])/) || [])[0] || (text.match(/(?<![A-Z0-9])LQ[A-Z0-9]{5}(?![A-Z0-9])/) || [])[0] || null;
    if (!code) { const em = (String(p.note||"").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [])[0]; if (em) code = await studentCode(em); }
    const term = curTerms()[0];
    const ins = await db.prepare("INSERT OR IGNORE INTO payments (txn,code,amount,via,payer,note,term,received_at,matched) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(txn, code, amount, String(p.via||"").slice(0,20), String(p.payer||"").slice(0,120), String(p.note||"").slice(0,300), term, now(), null).run();
    if (!ins.meta.changes) return { ok:true, duplicate:true };
    return { ok:true, ...(await settle(code, term)) };
  }
  async function settle(code, term) {
    if (!code) return { matched:null };
    // By FORMAT, not prefix: student codes are "LQS"+5 (8 chars), professor codes "LQ"+5 (7 chars) --
    // an older professor code can itself start with "LQS" (e.g. LQSABCD).
    if (/^LQS[A-Z0-9]{5}$/.test(code)) {
      const st = await db.prepare("SELECT email FROM pay_codes_students WHERE code=?").bind(code).first();
      if (!st) return { matched:null };
      const sum = await paidSum(code, term);
      return { matched:"student", email: st.email, paid: sum >= STUDENT_FEE, total: sum };
    }
    const pc = await db.prepare("SELECT teacher_id FROM pay_codes WHERE code=?").bind(code).first();
    if (!pc) return { matched:null };
    const sum = await paidSum(code, term), done = sum >= PRICE;
    if (done) await db.prepare("UPDATE teachers SET active_until=? WHERE id=? AND (active_until IS NULL OR active_until<?)").bind(termEnd(), pc.teacher_id, termEnd()).run();
    return { matched:"professor", paid: done, total: sum };
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
      const hit = new Set((await db.prepare(`SELECT DISTINCT r.ou AS ou FROM roster r WHERE r.ou IN (${placeholders(part.length)}) AND lower(r.email)=? AND r.user_id=? AND ${INSTR_SQL} AND ${TRUSTED_TC}`)
        .bind(...part, EMAIL, String(me.bs_user_id)).all()).results.map(x => String(x.ou)));
      part.forEach(o => tiCache.set(o, hit.has(o)));
    }
    ous.forEach(o => { if (tiCache.get(o)) out.add(o); });
    return out;
  }
  const trustedInstructor = async ou => (await trustedOus([ou])).has(String(ou));
  // SQL: the courses the caller instructs (same rule as trustedOus), as a subquery with fixed params.
  const myOusSql = () => me.admin ? { sql: "SELECT ou FROM teacher_courses", args: [] }
    : { sql: `SELECT r.ou FROM roster r WHERE lower(r.email)=? AND r.user_id=? AND ${INSTR_SQL} AND ${TRUSTED_TC}`, args: [EMAIL, String(me.bs_user_id || "\u0000")] };
  // Load a quiz by (ou,qi) and confirm the caller instructs THAT course. Prevents acting on another
  // course's quiz by passing your own ou with a foreign qi.
  async function ownedQuiz(ou, qi) {
    if (!/^\d+$/.test(String(ou)) || !/^\d+$/.test(String(qi))) return { bad: true };
    if (!(me.admin || await trustedInstructor(ou))) return { forbidden: true };
    const row = await db.prepare("SELECT quiz_id,password,gated,sa_keep,bs_code,ou,teacher_id FROM quizzes WHERE ou=? AND qi=?").bind(String(ou), String(qi)).first();
    return { row };
  }
  async function bsState(ous) {
    ous = ous.map(String).filter(o => /^\d+$/.test(o));
    if (!ous.length) return { protect: [], clear: [] };
    const ph = ous.map(()=>"?").join(",");
    const protect = (await db.prepare(`SELECT ou,qi,password,title,gated FROM quizzes WHERE ou IN (${ph}) AND qi IS NOT NULL`).bind(...ous).all()).results;
    const clear = (await db.prepare(`SELECT ou,qi,password FROM pending_clear WHERE ou IN (${ph})`).bind(...ous).all()).results;
    return { protect, clear };
  }

  try {
    // The Sync bookmark's key authorizes ONLY the Brightspace-connector endpoints (it is exposed in the
    // bookmarklet URL inside the Brightspace page). Everything else needs the real session token.
    if (viaSyncKey && !SYNC_OK.has(p)) return json({ error: "this action needs your LOCKqz login, not the Sync bookmark" }, 403);
    // ---- device endpoints (signed by the device key; see verifyDevice) ----
    if (p === "/blocklist") return json({ domains: AI_DOMAINS });

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
        .bind(id, body.student || null, body.platform || null, body.version || null, now(), now(), key, now(), request.headers.get("CF-Connecting-IP") || null).run();
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
      const d = await db.prepare("SELECT student, student_verified FROM devices WHERE device_id=?").bind(dev).first();
      if (op === "status") return json({ student: d?.student || null, verified: Number(d?.student_verified) === 1, codes: codesOn });
      if (!EMAIL_OK(email)) return json({ error: "bad_email" }, 400);
      const rosterName = async () => (await db.prepare("SELECT name FROM roster WHERE lower(email)=? AND name IS NOT NULL LIMIT 1").bind(email).first())?.name || null;
      const since = ms => new Date(Date.now() - ms).toISOString();
      const sent = async (ms, all) => (await db.prepare(`SELECT COUNT(*) AS n FROM events WHERE event='code_sent' AND ts>=?${all ? "" : " AND device_id=?"}`).bind(since(ms), ...(all ? [] : [dev])).first()).n;
      const issue = async () => {             // email a fresh code (rate-limited) -> response
        if ((await sent(3600000)) >= 5 || (await sent(86400000)) >= 15) return json({ error: "too_many_codes", retry_minutes: 60 }, 429);
        if ((await sent(86400000, true)) >= Number(env.MAIL_DAILY_MAX || 480)) return json({ error: "mail_busy" }, 503);
        const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
        try { await sendCode(env, email, code); }
        catch (e) { await db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)").bind(dev, email, null, "code_send_failed", String(e).slice(0, 200), now()).run(); return json({ error: "send_failed" }, 502); }
        await db.prepare("INSERT OR REPLACE INTO email_codes (device_id,email,code_hash,expires,tries,created_at) VALUES (?,?,?,?,0,?)")
          .bind(dev, email, await sha256hex(enc.encode(dev + ":" + code)), Date.now() + CODE_MS, now()).run();
        await db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)").bind(dev, email, null, "code_sent", null, now()).run();
        return null;
      };
      if (op === "check") return json({ email, name: await rosterName(), codes: codesOn });
      if (op === "send") {
        if (!codesOn) {                       // codes off: accept after the roster check (pre-25-Oct behaviour)
          await db.prepare("UPDATE devices SET student=? WHERE device_id=? AND COALESCE(student_verified,0)=0").bind(email, dev).run();
          return json({ ok: true, bound: true, name: await rosterName() });
        }
        return (await issue()) || json({ ok: true, sent: true, minutes: CODE_MS / 60000 });
      }
      if (op === "code") {
        const row = await db.prepare("SELECT email, code_hash, expires, tries FROM email_codes WHERE device_id=?").bind(dev).first();
        if (!row || row.email !== email) return (await issue()) || json({ error: "no_code", resent: true });
        if (Date.now() > Number(row.expires)) return (await issue()) || json({ error: "expired", resent: true });
        const given = String(body.code || "").replace(/\D/g, "");
        if (!sameHex(await sha256hex(enc.encode(dev + ":" + given)), row.code_hash)) {
          if (Number(row.tries) + 1 >= CODE_TRIES) return (await issue()) || json({ error: "too_many_tries", resent: true });
          await db.prepare("UPDATE email_codes SET tries=tries+1 WHERE device_id=?").bind(dev).run();
          return json({ error: "wrong_code", tries_left: CODE_TRIES - Number(row.tries) - 1 });
        }
        await db.prepare("UPDATE devices SET student=?, student_verified=1 WHERE device_id=?").bind(email, dev).run();
        await db.prepare("DELETE FROM email_codes WHERE device_id=?").bind(dev).run();
        await db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)").bind(dev, email, null, "email_verified", null, now()).run();
        return json({ ok: true, verified: true, name: await rosterName() });
      }
      return json({ error: "bad op" }, 400);
    }

    if (p === "/install" && request.method === "POST") {
      const v = await verifyDevice(request, raw, db);
      if (!v.ok && (strict || await isRegistered(db, body.device_id))) return denied(v);
      const did = v.ok ? v.id : (typeof body.device_id === "string" ? body.device_id.trim() : "");
      if (!did || did.length > 120) return json({ error: "bad device id" }, 400);
      await db.prepare("INSERT INTO devices (device_id,student,platform,version,installed_at,last_seen) VALUES (?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET platform=excluded.platform,version=excluded.version,last_seen=excluded.last_seen")
        .bind(did, str(body.student), str(body.platform, 60), str(body.version, 60), now(), now()).run();
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
      const signed = v.ok ? 1 : 0;
      const qidOk = typeof quiz_id === "string" && /^\d+-\d+$/.test(quiz_id) ? quiz_id : null;
      const studentStr = str(student);
      // Unlock reports carry {reason} (quiz_submitted / quiz_left / quiz_tab_closed / cap ...): keep it
      // in the event detail so the live monitor can tell a clean submit from a mid-quiz unlock.
      const reason = typeof body.reason === "string" && body.reason ? body.reason.slice(0, 40) : null;
      const detailObj = reason ? (detail != null && detail !== "" ? { reason, detail } : { reason }) : detail;
      const detailStr = detailObj ? JSON.stringify(detailObj).slice(0, 2000) : null;
      const evName = String(ev).slice(0, 40);
      if (ev !== "heartbeat")
        await db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)")
          .bind(device_id||null, studentStr, qidOk, evName, detailStr, now()).run();
      if (device_id) await db.prepare("INSERT OR IGNORE INTO devices (device_id,installed_at) VALUES (?,?)").bind(device_id, now()).run();
      // D1 free plan = 100k row writes/day: a heartbeat refreshes last_seen at most every 10 minutes
      // (an UPDATE that matches no row writes nothing). Real events always update it.
      if (ev === "heartbeat")
        await db.prepare("UPDATE devices SET last_seen=? WHERE device_id=? AND (last_seen IS NULL OR last_seen < ?)").bind(now(), device_id||null, new Date(Date.now() - 600000).toISOString()).run();
      else
        await db.prepare("UPDATE devices SET last_seen=?, student=CASE WHEN student_verified=1 THEN student ELSE COALESCE(?,student) END WHERE device_id=?").bind(now(), studentStr, device_id||null).run();
      const clientIp = request.headers.get("CF-Connecting-IP") || null;
      // The helper went dark for longer than the live monitor's window and is now back: record the gap
      // (writes nothing in the normal case), so a later fresh lock cannot hide that AI may have been open.
      const vt = v => String(v||"0").split(".").map(n => parseInt(n,10)||0);
      const newer = (a, b) => { const x = vt(a), y = vt(b); for (let i = 0; i < 3; i++) if ((x[i]||0) !== (y[i]||0)) return (x[i]||0) > (y[i]||0); return true; };
      const gapRule = (ev === "lock" || (ev === "heartbeat" && !agentBeat)) && qidOk
        && newer((await db.prepare("SELECT version FROM devices WHERE device_id=?").bind(device_id||null).first())?.version, "0.4.0");
      const noteGap = async () => { if (!gapRule) return; return db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) SELECT device_id,(SELECT student FROM devices WHERE device_id=?),quiz_id,'lock_gap','{\"from\":\"'||last_lock||'\"}',? FROM locks WHERE device_id=? AND quiz_id=? AND last_lock<?")
        .bind(device_id, now(), device_id, qidOk, new Date(Date.now() - STALE_MS).toISOString()).run(); };
      if (ev === "lock" && qidOk) {
        await noteGap();
        await db.prepare("INSERT INTO locks (device_id,quiz_id,last_lock,helper_seen,signed,ip) VALUES (?,?,?,?,?,?) ON CONFLICT(device_id,quiz_id) DO UPDATE SET last_lock=excluded.last_lock,helper_seen=excluded.helper_seen,signed=excluded.signed,ip=excluded.ip").bind(device_id, qidOk, now(), now(), signed, clientIp).run();
      }
      if (ev === "unlock" && qidOk)
        await db.prepare("DELETE FROM locks WHERE device_id=? AND quiz_id=?").bind(device_id, qidOk).run();
      if (ev === "heartbeat" && qidOk) {
        // Only the helper's heartbeat keeps a lock alive; the agent's only proves the agent runs.
        if (agentBeat) await db.prepare("UPDATE locks SET ext_seen=? WHERE device_id=? AND quiz_id=?").bind(now(), device_id, qidOk).run();
        else {
          await noteGap();
          await db.prepare("UPDATE locks SET last_lock=?, helper_seen=?, signed=?, ip=COALESCE(?,ip) WHERE device_id=? AND quiz_id=?").bind(now(), now(), signed, clientIp, device_id, qidOk).run();
        }
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
      const { qi, ou } = ids(String(body.url || ""));
      if (!/^\d+$/.test(String(qi||"")) || !/^\d+$/.test(String(ou||""))) return json({ password: null, reason: "bad quiz url" }, 400);
      const lockId = `${ou}-${qi}`;
      const lk = await db.prepare("SELECT last_lock, signed FROM locks WHERE device_id=? AND quiz_id=?").bind(device_id, lockId).first();
      const fresh = lk && (Date.now() - Date.parse(lk.last_lock) < 60000) && (!(strict || v.ok) || Number(lk.signed) === 1);
      if (!fresh) return json({ password: null, reason: "not locked" }, 403);
      const devLk = await db.prepare("SELECT 1 FROM events e JOIN devices d ON d.device_id=e.device_id WHERE e.device_id=? AND e.quiz_id=? AND e.event='lock' AND e.detail LIKE '%\"developer\":true%' AND lower(COALESCE(d.student,'')) NOT IN (SELECT lower(email) FROM teachers WHERE role='admin') LIMIT 1").bind(device_id, lockId).first();
      if (devLk) return json({ password: null, reason: "not locked" }, 403);   // dev mode is admin-only
      // Student fee: no password until this semester's $5 is paid (matched automatically from Venmo/Zelle).
      if (feeOn()) {
        const stu = await db.prepare("SELECT student, student_verified FROM devices WHERE device_id=?").bind(device_id).first();
        // With email codes on, only a CONFIRMED email counts: an unverified device cannot claim a
        // professor's (fee-exempt) or a paid classmate's email just by reporting it.
        const unconfirmed = codesOn && Number(stu?.student_verified) !== 1;
        const who = unconfirmed ? null : stu?.student;
        if (!(await studentPaid(who))) return unconfirmed
          ? json({ password: null, reason: "verify", needs_verify: true }, 402)   // no pay block: the agent re-runs email setup
          : json({ password: null, reason: "unpaid", pay: await payInfo(who) }, 402);
      }
      // Admit only at the quiz's scheduled start time -- even if the professor unhid it early. But a
      // student with an accommodation (in the gate's kept special-access list) may have an earlier
      // window, so let them through the start gate.
      const sq = await db.prepare("SELECT start_date FROM bs_quizzes WHERE ou=? AND qi=?").bind(String(ou||""), String(qi||"")).first();
      if (sq && sq.start_date && Date.now() < Date.parse(sq.start_date)) {
        const dq = await db.prepare("SELECT sa_keep FROM quizzes WHERE ou=? AND qi=?").bind(ou, qi).first();
        let accommodated = false;
        if (dq && dq.sa_keep) {
          const who = (await db.prepare("SELECT user_id FROM roster WHERE ou=? AND (lower(email)=(SELECT lower(student) FROM devices WHERE device_id=?) OR lower(name)=(SELECT lower(student) FROM devices WHERE device_id=?))").bind(ou, device_id, device_id).first());
          try { accommodated = who && who.user_id && JSON.parse(dq.sa_keep).map(String).includes(String(who.user_id)); } catch {}
        }
        if (!accommodated) return json({ password: null, reason: "not started", start: sq.start_date }, 403);
      }
      let pw = null, rot = null;
      if (qi && ou) { const q = await db.prepare("SELECT password, gated, bs_code FROM quizzes WHERE qi=? AND ou=?").bind(qi, ou).first(); if (q) { pw = q.password; if (Number(q.gated) === 1 && q.bs_code) rot = q.bs_code; } }
      if (!pw && ou) { const c = await db.prepare("SELECT password FROM courses WHERE ou=?").bind(ou).first(); if (c) pw = c.password; }
      // Give the student EXACTLY what is in Brightspace: the code the Sync tab last confirmed writing
      // (gated quiz) or the quiz's fixed LOCKqz password (protected, not gated). Never a computed code,
      // so a closed or sleeping Sync tab can never cause a wrong password.
      // Logged once per device + quiz + released code (+ IP): agents re-ask often, and every repeat
      // would be a row written (D1 Free: 100k/day). A new code or a new IP is logged again.
      const given = rot || pw;
      if (given) {
        const det = JSON.stringify({ verified: v.ok, ip: request.headers.get("CF-Connecting-IP") || null, v: (await sha256hex(enc.encode(lockId + ":" + given))).slice(0, 8) });
        await db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) SELECT ?,(SELECT student FROM devices WHERE device_id=?),?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM events WHERE device_id=? AND quiz_id=? AND event='password_released' AND detail=?)")
          .bind(device_id, device_id, lockId, "password_released", det, now(), device_id, lockId, det).run();
      }
      return json({ password: rot || pw, lockId });
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
        const claimed = await db.prepare(`SELECT 1 FROM roster r WHERE lower(r.email)=? AND ${INSTR_SQL} AND ${TRUSTED_TC} LIMIT 1`).bind(email).first();
        if (claimed) return json({ error:"This email belongs to a professor already on a course roster. Ask the LOCKqz admin for an invite to claim it." }, 409);
      }
      // The first account on the site is the admin. Anyone can still make an account after that (the
      // site only offers sign-up through an invite link), but it is UNVERIFIED and can protect nothing.
      // Only an INVITED (vouched) account can verify -- by syncing a course whose trusted roster lists
      // its email as Instructor. Without that, anyone could sign up as bristow@usc.edu before his roster
      // is seeded and later "verify" as him. The invite also sets the paid window.
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
          .bind(String(body.name||"").trim()||null, await hashPw(pw,salt), salt, token, inv.active_until, now(), id).run();
      } else
        await db.prepare("INSERT INTO teachers (id,email,name,pw_hash,salt,token,created_at,role,active_until,vouched) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .bind(id, email, String(body.name||"").trim()||null, await hashPw(pw,salt), salt, token, now(), n===0?"admin":"teacher", inv ? inv.active_until : null, vouched).run();
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
      if (!t || (await hashPw(pw, t.salt)) !== t.pw_hash) {
        await db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)").bind("ip:" + ip,null,null,"login_fail",lkey,now()).run();
        return json({ error:"wrong email or password" }, 401);
      }
      let token = t.token;
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
    if (p === "/me") return me ? json({ email: me.email, name: me.name, admin: me.admin, verified: !!me.verified, active: me.active, active_until: me.active_until }) : json({ error:"unauthorized" }, 401);
    if (p === "/logout" && request.method === "POST") {
      // Every real account (admins included) loses its session token; only the master key has no row.
      if (me && me.id !== "admin" && !viaSyncKey) await db.prepare("UPDATE teachers SET token=NULL WHERE id=?").bind(me.id).run();
      return json({ ok:true });
    }
    if (p === "/changepw" && request.method === "POST") {
      if (!me) return json({ error:"unauthorized" }, 401);
      if (me.id === "admin") return json({ error:"the master admin key has no stored password" }, 400);
      const cur = await db.prepare("SELECT pw_hash,salt FROM teachers WHERE id=?").bind(me.id).first();
      if (!cur || (await hashPw(String(body.old_password||""), cur.salt)) !== cur.pw_hash) return json({ error:"current password is wrong" }, 403);
      const pw = String(body.password||"");
      if (pw.length < 8) return json({ error:"password must be at least 8 characters" }, 400);
      const salt = rid(16), token = hex(crypto.getRandomValues(new Uint8Array(24)));
      await db.prepare("UPDATE teachers SET pw_hash=?, salt=?, token=?, sync_key=NULL WHERE id=?").bind(await hashPw(pw,salt), salt, token, me.id).run();
      return json({ ok:true, token });
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
      const r = await db.prepare(`UPDATE teachers SET pw_hash=?,salt=?,token=NULL${gating ? "" : ",sync_key=NULL"} WHERE email=?`).bind(await hashPw(pw,salt), salt, email).run();
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
      const term = String(body.term||""), until = String(body.until||"").slice(0,10);
      const secs = (Array.isArray(body.sections) ? body.sections : []).map(String).filter(x => /^\d{5}$/.test(x)).slice(0, 100);
      if (!/^\d{5}$/.test(term) || !secs.length) return json({ error:"bad term or sections" }, 400);
      for (const sec of secs) {
        if (body.off) { await db.prepare("DELETE FROM paid_sections WHERE teacher_id=? AND term=? AND section=?").bind(t.id, term, sec).run(); continue; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return json({ error:"bad until date" }, 400);
        const r = await db.prepare("SELECT course,first,last FROM usc_sections WHERE term=? AND section=? LIMIT 1").bind(term, sec).first();
        await db.prepare("INSERT OR REPLACE INTO paid_sections (teacher_id,term,section,course,first,last,until,paid_at,via) VALUES (?,?,?,?,?,?,?,?,?)")
          .bind(t.id, term, sec, r?.course||null, r?.first||null, r?.last||null, until, now(), String(body.via||"admin").slice(0,40)).run();
      }
      if (body.off) await releaseUnpaid({ id: t.id, admin: false, active: false });
      return json({ ok: true, sections: secs, until: body.off ? null : until });
    }

    // ---- payments (public + Apps Script + admin) ----
    if (p === "/pay/start" && request.method === "POST") {
      const email = String(body.email||"").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error:"enter your school email" }, 400);
      const info = await payInfo(email, clientIp);
      if (info.limited) return json({ error:"too many requests — try again in an hour" }, 429);
      return json({ ...info, paid: await studentPaid(email), required: feeOn(), term: curTerms()[0] });
    }
    if (p === "/pay/status") {
      const email = String(url.searchParams.get("email")||"").trim().toLowerCase();
      if (!email) return json({ error:"email required" }, 400);
      return json({ paid: await studentPaid(email), required: feeOn() });
    }
    if (p === "/pay/notify" && request.method === "POST") {
      const secret = await paySecret();
      const got = String(request.headers.get("X-LOCKqz-Pay") || "");
      if (secret.length < 16 || !sameHex(got, secret)) return json({ error:"unauthorized" }, 401);   // constant-time
      const list = Array.isArray(body.payments) ? body.payments.slice(0, 100) : [body];
      const out = []; for (const x of list) out.push(await applyPayment(x || {}));
      return json({ results: out });
    }
    if (p === "/payments") {
      if (!me?.admin) return json({ error:"admin only" }, 403);
      const r = await db.prepare("SELECT p.txn,p.code,p.amount,p.via,p.payer,p.note,p.term,p.received_at,COALESCE(s.email,t.email) AS who FROM payments p LEFT JOIN pay_codes_students s ON s.code=p.code LEFT JOIN pay_codes pc ON pc.code=p.code LEFT JOIN teachers t ON t.id=pc.teacher_id ORDER BY p.received_at DESC LIMIT 300").all();
      return json({ payments: r.results, fee_on: feeOn(), fee: STUDENT_FEE, fee_from: env.STUDENT_FEE_FROM || null, script_key: await paySecret() });
    }
    if (p === "/pay-assign" && request.method === "POST") {
      if (!me?.admin) return json({ error:"admin only" }, 403);
      const txn = String(body.txn||""); let code = String(body.code||"").trim().toUpperCase();
      if (/@/.test(code)) code = await studentCode(code.toLowerCase());
      if (!txn || !/^LQS?[A-Z0-9]{5}$/.test(code||"")) return json({ error:"bad txn or code" }, 400);
      const pr = await db.prepare("SELECT term FROM payments WHERE txn=?").bind(txn).first();
      if (!pr) return json({ error:"no such payment" }, 404);
      await db.prepare("UPDATE payments SET code=? WHERE txn=?").bind(code, txn).run();
      return json({ ok:true, ...(await settle(code, pr.term)) });
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
      if (!(await paidOu(payOu))) return json({ error: "Not active. LOCKqz turns on after payment ($5,000 per semester)." }, 402);
    }

    // The professor's own USC sections this semester (public Schedule of Classes), what is paid, and
    // how to pay: Venmo $1,000 per section with the memo code. Optional ?name= when the name differs.
    if (p === "/my-sections") {
      const nm = url.searchParams.get("name");
      if (nm && splitName(nm)) await db.prepare("UPDATE teachers SET name=? WHERE id=?").bind(String(nm).trim().slice(0,80), me.id).run();
      const r = await sectionsFor(me.id, nm || me.name);
      return json({ ...r, price: PRICE, venmo: (env.VENMO_HANDLE || "").replace(/^@/, "") || null, zelle: env.ZELLE_TO || null, invoice: env.INVOICE_EMAIL || env.ADMIN_EMAIL || null, memo: await payCode(me.id), all_active: !!me.active });
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
      return json({ quizzes: r.results });
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
        .bind(ou, body.title||null, password, now(), me.id).run();
      return json({ ou, password });
    }
    if (p === "/courses") {
      const m = mine();
      const r = await db.prepare(`SELECT ou,title,password,created_at,teacher_id FROM courses WHERE ${m.sql} ORDER BY created_at DESC`).bind(...m.args).all();
      return json({ courses: r.results });
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
        await db.prepare("UPDATE teachers SET sync_key=? WHERE id=?").bind(k, me.id).run();
      }
      return json({ key: k });
    }
    if (p === "/sync" && request.method === "POST") {
      // D1 budget (Free plan: 50 queries per request, a db.batch = 1; 100k rows written per day): every
      // per-course lookup is ONE query for all courses, writes go out in batches, and only rows that
      // actually changed are written -- a repeat sync with nothing new writes ~0 rows.
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
        const b = await db.prepare(`UPDATE teachers SET bs_user_id=? WHERE id=? AND (bs_user_id IS NULL OR bs_user_id='') AND EXISTS (SELECT 1 FROM roster r WHERE lower(r.email)=? AND r.user_id=? AND ${TRUSTED_TC})`)
          .bind(whoId, me.id, myEmail, whoId).run();
        if (b.meta.changes) me.bs_user_id = whoId;
      }
      // Trust the roster, not the browser. You may write a course if you are its trusted instructor, or
      // nobody trusted OWNS it (an admin, or a verified professor who is Instructor on it). An unverified
      // account may only seed a course no admin/verified account has synced at all -- so a student can
      // never wipe or fake a real class. Seeding grants no power until a trusted instructor syncs it.
      const trusted0 = await trustedOus(ous);
      const info = me.admin ? {} : await ownerInfo(ous.filter(o => !trusted0.has(o)));
      const A = ous.filter(o => me.admin || trusted0.has(o) || (!info[o]?.owned && (me.verified || !info[o]?.trusted)));
      const withRoster = A.filter(o => Array.isArray(byOu.get(o).classlist)), withQuiz = A.filter(o => Array.isArray(byOu.get(o).quizzes));
      const sel = async (sql, list, extra = []) => {
        const out = [];
        for (const part of chunk(list, 99 - extra.length)) out.push(...(await db.prepare(sql.replace("%IN%", placeholders(part.length))).bind(...extra, ...part).all()).results);
        return out;
      };
      const oldTc = new Map((A.length ? await sel("SELECT ou,name,code,role,synced_at FROM teacher_courses WHERE teacher_id=? AND ou IN (%IN%)", A, [me.id]) : []).map(r => [String(r.ou), r]));
      const oldRoster = withRoster.length ? await sel("SELECT ou,user_id,name,email,username,org_id,role FROM roster WHERE ou IN (%IN%)", withRoster) : [];
      const oldBq = withQuiz.length ? await sel("SELECT ou,qi,name,active,start_date,end_date,due_date,bs_has_password,bs_password_is_ours FROM bs_quizzes WHERE ou IN (%IN%)", withQuiz) : [];
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
      for (const ou of withRoster) {
        const keep = new Set();
        for (const s of byOu.get(ou).classlist.slice(0, 3000)) {
          if (!s || typeof s !== "object") continue;
          const uid = String(s.id ?? ""), k = ou + "\u0000" + uid;
          if (keep.has(uid)) continue; keep.add(uid);
          const v = [str(s.name), (str(s.email) || "").toLowerCase() || null, str(s.username), str(s.org_id), str(s.role, 80)];
          const o = oldR.get(k);
          if (!o || !same(o.name, v[0]) || !same(o.email, v[1]) || !same(o.username, v[2]) || !same(o.org_id, v[3]) || !same(o.role, v[4])) rUp.push([ou, uid, ...v, t]);
        }
        const drop = oldRoster.filter(r => String(r.ou) === ou && !keep.has(String(r.user_id))).map(r => String(r.user_id));
        for (const part of chunk(drop, 98)) st.push(db.prepare(`DELETE FROM roster WHERE ou=? AND user_id IN (${placeholders(part.length)})`).bind(ou, ...part));
      }
      st.push(...multiInsert(db, "INSERT INTO roster (ou,user_id,name,email,username,org_id,role,synced_at)", 8, rUp,
        "ON CONFLICT(ou,user_id) DO UPDATE SET name=excluded.name,email=excluded.email,username=excluded.username,org_id=excluded.org_id,role=excluded.role,synced_at=excluded.synced_at"));
      // Brightspace quizzes: same diff. bs_password_is_ours survives only while the quiz still has a password.
      const oldQ = new Map(oldBq.map(r => [String(r.ou) + "\u0000" + String(r.qi), r]));
      for (const ou of withQuiz) {
        const keep = new Set();
        for (const q of byOu.get(ou).quizzes.slice(0, 1000)) {
          if (!q || typeof q !== "object" || q.qi == null) continue;
          const qi = String(q.qi); if (keep.has(qi)) continue; keep.add(qi);
          const o = oldQ.get(ou + "\u0000" + qi);
          const v = [str(q.name), q.active ? 1 : 0, str(q.start, 40), str(q.end, 40), str(q.due, 40), q.has_password ? 1 : 0, (o && Number(o.bs_password_is_ours) === 1 && q.has_password) ? 1 : 0];
          if (!o || !same(o.name, v[0]) || Number(o.active) !== v[1] || !same(o.start_date, v[2]) || !same(o.end_date, v[3]) || !same(o.due_date, v[4]) || Number(o.bs_has_password) !== v[5] || Number(o.bs_password_is_ours) !== v[6]) bUp.push([ou, qi, ...v, t]);
        }
        const drop = oldBq.filter(r => String(r.ou) === ou && !keep.has(String(r.qi))).map(r => String(r.qi));
        for (const part of chunk(drop, 98)) st.push(db.prepare(`DELETE FROM bs_quizzes WHERE ou=? AND qi IN (${placeholders(part.length)})`).bind(ou, ...part));
      }
      st.push(...multiInsert(db, "INSERT INTO bs_quizzes (ou,qi,name,active,start_date,end_date,due_date,bs_has_password,bs_password_is_ours,synced_at)", 10, bUp,
        "ON CONFLICT(ou,qi) DO UPDATE SET name=excluded.name,active=excluded.active,start_date=excluded.start_date,end_date=excluded.end_date,due_date=excluded.due_date,bs_has_password=excluded.bs_has_password,bs_password_is_ours=excluded.bs_password_is_ours,synced_at=excluded.synced_at"));
      await runBatches(db, st);
      // VERIFY ONLY FROM A TRUSTED ROSTER -- a student can never become a professor. Verified iff the
      // account is VOUCHED (admin invite) AND a trusted roster lists this email as Instructor with the
      // Brightspace id bound above. A grad student who instructs one course and takes another is still
      // verified; a pure student is never an Instructor anywhere. Written only when it changes.
      if (!me.admin) {
        const prof = me.vouched && me.bs_user_id ? await db.prepare(`SELECT 1 FROM roster r WHERE lower(r.email)=? AND r.user_id=? AND ${INSTR_SQL} AND ${TRUSTED_TC} LIMIT 1`).bind(myEmail, String(me.bs_user_id)).first() : null;
        if (!!prof !== !!me.verified) { await db.prepare("UPDATE teachers SET verified=? WHERE id=?").bind(prof ? 1 : 0, me.id).run(); me.verified = !!prof; }
      }
      // Re-check AFTER the writes: a professor syncing a course for the first time becomes its trusted
      // instructor only now (their course row + roster are in), so seed eviction must come after.
      tiCache.clear();
      const trusted = await trustedOus(A);
      const mineA = A.filter(o => trusted.has(o)), st2 = [];
      // A trusted owner syncing a course evicts any seed rows a non-trusted account left on it.
      for (const part of chunk(mineA, 98)) st2.push(db.prepare(`DELETE FROM teacher_courses WHERE ou IN (${placeholders(part.length)}) AND teacher_id<>? AND teacher_id<>'admin' AND teacher_id NOT IN (SELECT id FROM teachers WHERE role='admin' OR verified=1)`).bind(...part, me.id));
      // Protect-by-default: new active quizzes get a LOCKqz password automatically (courses you instruct, paid).
      const autoOus = [];
      for (const ou of mineA) if (Array.isArray(byOu.get(ou).quizzes) && await paidOu(ou)) autoOus.push(ou);
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
          if (q.active === false) continue;
          const end = q.end ? Date.parse(q.end) : NaN; if (!isNaN(end) && end < Date.now()) continue;   // skip ended quizzes
          seen.add(`${ou}-${qi}`);
          add.push([rid(8), str(q.name), null, "LQ-" + rid(8), t, qi, me.id, `${ou}-${qi}`, ou, 0]);
        }
        st2.push(...multiInsert(db, "INSERT OR IGNORE INTO quizzes (quiz_id,title,url,password,created_at,qi,teacher_id,lock_id,ou,gated)", 10, add));
      }
      await runBatches(db, st2);
      await releaseUnpaid(me);
      // Only hand back passwords for courses this caller instructs (never leak another course's).
      return json(await bsState(mineA));
    }
    if (p === "/sync-result" && request.method === "POST") {
      const list = (Array.isArray(body.results) ? body.results : []).slice(0, 1000).filter(r => r && typeof r === "object");
      const okOus = await trustedOus(list.map(r => String(r.ou || "")));   // only the course's trusted instructor
      const st = [];
      for (const r of list) {
        const ou = String(r.ou||""), qi = String(r.qi||"");
        if (!okOus.has(ou) || !/^\d+$/.test(qi)) continue;
        if (r.status === "set" || r.status === "already")
          st.push(db.prepare("UPDATE bs_quizzes SET bs_password_is_ours=1, bs_has_password=1 WHERE ou=? AND qi=? AND NOT (COALESCE(bs_password_is_ours,0)=1 AND COALESCE(bs_has_password,0)=1)").bind(ou, qi));
        else if (r.status === "cleared") {
          st.push(db.prepare("DELETE FROM pending_clear WHERE ou=? AND qi=?").bind(ou, qi));
          st.push(db.prepare("UPDATE bs_quizzes SET bs_password_is_ours=0 WHERE ou=? AND qi=? AND COALESCE(bs_password_is_ours,0)<>0").bind(ou, qi));
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
      const ex = await db.prepare("SELECT quiz_id,password FROM quizzes WHERE qi=? AND ou=?").bind(qi, ou).first();
      if (body.on) {
        await db.prepare("DELETE FROM pending_clear WHERE ou=? AND qi=?").bind(ou, qi).run();
        await db.prepare("DELETE FROM lockqz_off WHERE ou=? AND qi=?").bind(ou, qi).run();
        if (ex) { await db.prepare("UPDATE quizzes SET lock_id=? WHERE qi=? AND ou=?").bind(`${ou}-${qi}`, qi, ou).run(); return json({ ou, qi, on:true, password: ex.password }); }
        const bq = await db.prepare("SELECT name FROM bs_quizzes WHERE ou=? AND qi=?").bind(ou, qi).first();
        const password = "LQ-" + rid(8);
        await db.prepare("INSERT INTO quizzes (quiz_id,title,url,password,created_at,qi,teacher_id,lock_id,ou) VALUES (?,?,?,?,?,?,?,?,?)")
          .bind(rid(8), bq?.name||null, null, password, now(), qi, me.id, `${ou}-${qi}`, ou).run();
        return json({ ou, qi, on:true, password });
      }
      if (ex) {
        await db.prepare("INSERT OR REPLACE INTO pending_clear (ou,qi,password) VALUES (?,?,?)").bind(ou, qi, ex.password).run();
        await db.prepare("DELETE FROM quizzes WHERE qi=? AND ou=?").bind(qi, ou).run();
      }
      // Remember the professor turned it OFF, so the next Sync's auto-protect does not re-add it.
      await db.prepare("INSERT OR REPLACE INTO lockqz_off (ou,qi,teacher_id,at) VALUES (?,?,?,?)").bind(ou, qi, me.id, now()).run();
      return json({ ou, qi, on:false, clear: ex ? ex.password : null });
    }
    // Turn the live access gate on/off for a quiz. While on, the Sync tab hides the quiz from everyone
    // and admits only students LOCKqz is actively locking. Requires the course to be synced + protected.
    if (p === "/gate" && request.method === "POST") {
      const ou = String(body.ou||""), qi = String(body.qi||"");
      if (!/^\d+$/.test(ou) || !/^\d+$/.test(qi)) return json({ error:"bad quiz" }, 400);
      if (!me.admin && !(await trustedInstructor(ou))) return json({ error:"Only the professor of this course can gate its quizzes." }, 403);
      const cur = await db.prepare("SELECT gated, sa_keep FROM quizzes WHERE qi=? AND ou=?").bind(qi, ou).first();
      if (!cur) return json({ error:"Protect this quiz first." }, 400);
      // Accommodation list: recorded once when the gate first starts; kept across Sync-tab reloads.
      let keep = cur.sa_keep;
      if (body.on && !(Number(cur.gated) === 1 && keep)) keep = JSON.stringify((Array.isArray(body.keep) ? body.keep : []).map(String).filter(x => /^\d+$/.test(x)).slice(0, 3000));
      if (!body.on) keep = null;
      await db.prepare("UPDATE quizzes SET gated=?, sa_keep=?, bs_code=CASE WHEN ?=1 THEN bs_code ELSE NULL END WHERE qi=? AND ou=?").bind(body.on?1:0, keep, body.on?1:0, qi, ou).run();
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
      const uids = (Array.isArray(body.user_ids) ? body.user_ids : []).map(String).filter(x => /^\d+$/.test(x)).slice(0, 3000);
      const t = now();
      await runBatches(db, multiInsert(db, "INSERT OR IGNORE INTO submissions (ou,qi,user_id,at)", 4, [...new Set(uids)].map(u => [ou, qi, u, t])));
      return json({ ok: true, count: uids.length });
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
      // Passwords, protection state and who-installed are shown ONLY for courses the caller INSTRUCTS
      // (trusted roster). A seed row (e.g. a student who synced the course first) lists the course and
      // its class list, never its quiz passwords.
      const own = await trustedOus(cs.map(c => String(c.ou)));
      const sub = "SELECT ou FROM teacher_courses WHERE teacher_id=?";
      const roster = (await db.prepare(`SELECT ou,user_id,name,email,username,role FROM roster WHERE ou IN (${sub}) ORDER BY name`).bind(me.id).all()).results;
      const qz = (await db.prepare(`SELECT b.ou,b.qi,b.name,b.active,b.start_date,b.end_date,b.due_date,b.bs_has_password,b.bs_password_is_ours,q.password,q.lock_id,q.gated FROM bs_quizzes b LEFT JOIN quizzes q ON q.qi=b.qi AND q.ou=b.ou WHERE b.ou IN (${sub}) ORDER BY b.name`).bind(me.id).all()).results
        .map(q => own.has(String(q.ou)) ? q : { ...q, password: null, lock_id: null, gated: null });
      const devs = (await db.prepare(`SELECT device_id,lower(student) AS who,platform,version,last_seen FROM devices WHERE (student_verified=1 OR ?=0) AND (lower(student) IN (SELECT lower(email) FROM roster WHERE ou IN (${sub})) OR lower(student) IN (SELECT lower(name) FROM roster WHERE ou IN (${sub})))`).bind(codesOn ? 1 : 0, me.id, me.id).all()).results;
      const by = {}; devs.forEach(d => { (by[d.who] = by[d.who] || []).push(d); });
      const adminEmails = new Set(((await db.prepare("SELECT lower(email) AS e FROM teachers WHERE role='admin'").all()).results).map(x => x.e));
      return json({ courses: cs.map(c => ({ ...c,
        // Everyone LOCKqz locks: Learners AND TAs (any non-instructor role). The admin is the one
        // exempt person (developer mode), so he is never listed as someone who must install.
        students: roster.filter(r => r.ou === c.ou && takesQuizzes(r.role) && !adminEmails.has((r.email||"").toLowerCase())).map(r => {
          const d = !own.has(String(c.ou)) ? [] : by[(r.email||"").toLowerCase()] || by[(r.name||"").toLowerCase()] || [];
          return { name:r.name, email:r.email, ta: !/learner|student/i.test(r.role||""), installed: d.length > 0, platform: d[0]?.platform||null, last_seen: d[0]?.last_seen||null }; }),
        quizzes: qz.filter(q => q.ou === c.ou) })) });
    }

    // Which lock ids (events.quiz_id = "<ou>-<qi>") belong to the caller?
    // quiz_id is "<ou>-<qi>". A caller owns a row when its ou (the part before the first "-") is a
    // course they instruct, or the row's lock_id is one of their quizzes. Expressed as subqueries so
    // the bound-parameter count is fixed (D1 caps at 100), no matter how many quizzes they have.
    function scope(col) {
      if (me.admin) return { sql:"1=1", args:[] };
      const ouExpr = `substr(${col},1,instr(${col}||'-','-')-1)`;
      // Courses: only those the caller INSTRUCTS on a trusted roster -- not any teacher_courses row (a
      // seed row from syncing someone else's course grants nothing).
      const mo = myOusSql();
      return { sql:`(${col} IN (SELECT lock_id FROM quizzes WHERE teacher_id=?) OR ${ouExpr} IN (${mo.sql}) OR ${ouExpr} IN (SELECT ou FROM courses WHERE teacher_id=?))`,
               args:[me.id, ...mo.args, me.id] };
    }

    if (p === "/roster") {
      const s = scope("e.quiz_id");
      const r = me.admin
        ? await db.prepare("SELECT device_id,student,platform,version,installed_at,last_seen FROM devices ORDER BY last_seen DESC").all()
        : await db.prepare(`SELECT DISTINCT d.device_id,d.student,d.platform,d.version,d.installed_at,d.last_seen FROM devices d JOIN events e ON e.device_id=d.device_id WHERE ${s.sql} ORDER BY d.last_seen DESC`).bind(...s.args).all();
      return json({ devices: r.results });
    }
    if (p === "/sessions") {
      const quiz = url.searchParams.get("quiz");
      const s = scope("quiz_id");
      const r = await db.prepare(`SELECT device_id,student,quiz_id,event,detail,ts FROM events WHERE ${s.sql} AND (? IS NULL OR quiz_id=? OR quiz_id LIKE ?) ORDER BY ts DESC LIMIT 500`)
        .bind(...s.args, quiz, quiz, quiz ? `${quiz}-%` : "\u0000").all();
      return json({ events: r.results });
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
      const qc = col => exact ? { sql: `${col}=?`, args: [quiz] } : { sql: `${col}>=? AND ${col}<?`, args: [quiz + "-", quiz + "."] };
      const lc = qc("l.quiz_id"), ec = qc("e.quiz_id");
      const locks = (await db.prepare(`SELECT l.device_id,l.quiz_id,l.last_lock,l.helper_seen,l.ext_seen,l.signed,l.ip,d.student,d.platform,d.student_verified FROM locks l LEFT JOIN devices d ON d.device_id=l.device_id WHERE ${lc.sql}`).bind(...lc.args).all()).results;
      // ONE pass over this quiz's events: tamper, developer-mode lock claims, and every unlock / gap.
      const evs = (await db.prepare(`SELECT e.device_id,e.quiz_id,e.event,e.detail,e.ts,d.student,d.platform,d.student_verified FROM events e LEFT JOIN devices d ON d.device_id=e.device_id WHERE ${ec.sql} AND e.event IN ('tamper','lock','unlock','auto_unlock','lock_gap') AND (e.event<>'lock' OR e.detail LIKE '%"developer":true%') ORDER BY e.ts`).bind(...ec.args).all()).results;
      const tamp = new Set(), devClaim = new Set(), incidents = new Map();
      for (const e of evs) {
        if (e.event === "tamper") tamp.add(e.device_id);
        else if (e.event === "lock") devClaim.add(e.device_id);
        else { const k = e.device_id + "|" + e.quiz_id; if (!incidents.has(k)) incidents.set(k, []); incidents.get(k).push(e); }
      }
      // Developer mode: only the admin's own Mac may hold a lock without blocking AI. A dev claim
      // from any other device is a modified client -> tamper (never admitted).
      const adminEm = new Set(((await db.prepare("SELECT lower(email) AS e FROM teachers WHERE role='admin'").all()).results).map(x => x.e));
      // Quiz windows (Brightspace start/end) for this course.
      const win = new Map(((await db.prepare(`SELECT qi,start_date,end_date FROM bs_quizzes WHERE ou=?${exact ? " AND qi=?" : ""}`).bind(_ou0, ...(exact ? [quiz.split("-")[1]] : [])).all()).results).map(w => [String(w.qi), w]));
      const startOf = qi => { const w = win.get(qi); const s = w && w.start_date ? Date.parse(w.start_date) : NaN; return isNaN(s) ? null : s; };
      const endOf = qi => { const w = win.get(qi); const s = w && w.end_date ? Date.parse(w.end_date) : NaN; return isNaN(s) ? null : s; };
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
      // Server-confirmed submissions (reported by the professor's trusted Sync session). Any unlock --
      // or a period the helper went dark -- inside the quiz window, while the student has NOT submitted,
      // is "left_early" (red: AI may have been open), even if a later lock re-created the lock row: the
      // events stay, so a re-lock can never hide it. Clean: a submissions row, or the agent's own
      // "quiz_submitted" unlock (only while the Sync tab is not reporting submissions for this quiz, or
      // for 2 minutes until its report arrives). The helper's 3-hour cap ("cap") is NOT clean.
      const subs = new Set(((await db.prepare(`SELECT qi,user_id FROM submissions WHERE ou=?${exact ? " AND qi=?" : ""}`).bind(_ou0, ...(exact ? [quiz.split("-")[1]] : [])).all()).results).map(x => String(x.qi) + ":" + String(x.user_id)));
      const subsFor = new Set([...subs].map(x => x.split(":")[0]));
      const reasonOf = e => { let d = null; try { d = JSON.parse(e.detail); } catch { d = e.detail; }
        const r = d && typeof d === "object" ? d.reason : (typeof d === "string" ? d : null);
        return typeof r === "string" && r ? r.slice(0, 40) : null; };
      rows.forEach(r => {
        const qi = r._q.split("-")[1];
        const submitted = !!(r.user_id && subs.has(qi + ":" + String(r.user_id)));
        if (submitted) { if (r.status === "done") r.submitted = true; return; }
        const inc = (incidents.get(r.device_id + "|" + r._q) || []).filter(e => inWindow(e.ts, qi) &&
          !(e.event === "unlock" && reasonOf(e) === "quiz_submitted" && (!subsFor.has(qi) || nowMs - Date.parse(e.ts) < 120000)));
        if (r.status === "done" && !inc.length) return;
        if (inc.length && (r.status === "locked" || r.status === "done" || r.status === "browser_closed")) {
          const last = inc[inc.length - 1];
          r.status = "left_early"; r.submitted = false;
          r.reason = last.event === "lock_gap" ? "went_dark" : (reasonOf(last) || (last.event === "auto_unlock" ? "cap" : "unlock"));
          r.flagged_at = last.ts;
        }
      });
      rows.forEach(r => { delete r._q; });
      return json({ quiz, now: now(), stale_ms: STALE, rows });
    }

    return json({ error: "not found", path: p }, 404);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}
