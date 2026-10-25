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
  "dns.quad9.net","doh.opendns.com","dns.nextdns.io"];
const now = () => new Date().toISOString();
// "Today" in America/Los_Angeles as YYYY-MM-DD, so a professor stays active through the end of their
// paid date in Pacific time (not 5pm Pacific, which UTC-midnight would give).
const laToday = () => new Date(Date.now() - 7*3600000).toISOString().slice(0,10);
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
    const t = hdr ? await db.prepare("SELECT id,email,name,role,active_until,verified,bs_user_id FROM teachers WHERE token=?").bind(hdr).first().catch(()=>null)
          : syncKey ? await db.prepare("SELECT id,email,name,role,active_until,verified,bs_user_id FROM teachers WHERE sync_key=?").bind(syncKey).first().catch(()=>null) : null;
    if (t) me = { id:t.id, email:t.email, name:t.name, admin: t.role === "admin", verified: t.role === "admin" || t.verified === 1, active: t.role === "admin" || (!!t.active_until && t.active_until >= laToday()), active_until: t.active_until||null, bs_user_id: t.bs_user_id||null };
  }
  // The sync key (in the bookmarklet URL, readable by any script on the Brightspace page) authorizes
  // ONLY the Brightspace-connector endpoints. Account management needs the real session token.
  const viaSyncKey = !!(request.headers.get("X-LOCKqz-Sync") || "").trim() && !(hdr && adminKey && sameHex(hdr, adminKey)) && !(hdr);
  const SYNC_OK = new Set(["/sync","/sync-result","/protect","/gate","/rotating","/rotated","/submitted","/live","/synckey","/me","/bs"]);
  const teacher = () => !!me;
  const mine = (col="teacher_id") => me.admin ? { sql:"1=1", args:[] } : { sql:`${col}=?`, args:[me.id] };
  const inCourse = async ou => me && (me.admin || !!(await db.prepare("SELECT 1 FROM teacher_courses WHERE teacher_id=? AND ou=?").bind(me.id, String(ou)).first()));
  // Only the INSTRUCTOR of a course (named Instructor on a roster an admin or verified professor synced)
  // may act on it. TAs NEVER qualify -- a TA could otherwise reach the other classes they are in.
  // Anthony (admin) is the sole exception, handled by me.admin at each call site.
  const EMAIL = String(me && me.email || "").toLowerCase();
  const INSTR_SQL = "(r.role LIKE '%nstructor%' OR r.role LIKE '%rofessor%' OR r.role LIKE '%aculty%')";
  // Roles LOCKqz locks during quizzes: everyone except the course's instructors (Learners and TAs).
  const takesQuizzes = role => !/nstructor|rofessor|aculty/i.test(String(role||"")) && !!String(role||"").trim();
  async function hasTrustedOwner(ou) {
    return !!(await db.prepare("SELECT 1 FROM teacher_courses tc JOIN teachers te ON te.id=tc.teacher_id WHERE tc.ou=? AND (te.role='admin' OR te.verified=1) LIMIT 1").bind(String(ou)).first());
  }
  // Unpaid or expired professor: queue every quiz they protect for password removal (their next
  // LOCKqz Sync takes it out of Brightspace, so no student is ever locked out of a quiz).
  async function releaseAll(tid) {
    const qs = (await db.prepare("SELECT qi,ou,password FROM quizzes WHERE teacher_id=? AND ou IS NOT NULL").bind(tid).all()).results;
    for (const q of qs) {
      await db.prepare("INSERT OR REPLACE INTO pending_clear (ou,qi,password) VALUES (?,?,?)").bind(String(q.ou), String(q.qi), q.password).run();
      await db.prepare("DELETE FROM quizzes WHERE qi=? AND ou=? AND teacher_id=?").bind(q.qi, String(q.ou), tid).run();
    }
  }
  // ---- per-section billing ($1,000 per section per semester) ----
  // A Brightspace course (ou) is paid when the professor paid for the USC section(s) it holds.
  // Admin and an account-wide activation (active_until) count as paid for everything.
  const PRICE = 5000;   // flat, per professor per semester (all their sections); paid = admin Activate until the semester end
  const secNums = txt => (String(txt).match(/(?<!\d)\d{5}(?!\d)/g) || []);
  const courseKeys = txt => { const out = new Set(); const re = /(?<![A-Z])([A-Z]{2,5})[\s_\-]*(\d{3}[A-Z]?)(?![0-9])/g; let m; while ((m = re.exec(String(txt).toUpperCase()))) out.add(m[1] + m[2]); return [...out]; };
  const ckey = c => String(c||"").toUpperCase().replace(/[^A-Z0-9]/g, "");
  async function paidOuFor(t, ou) {
    if (!t) return false;
    if (t.admin || t.active) return true;
    const paid = (await db.prepare("SELECT term,section,course,first,last FROM paid_sections WHERE teacher_id=? AND until>=?").bind(t.id, laToday()).all().catch(()=>({results:[]}))).results;
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
    const qs = (await db.prepare("SELECT qi,ou,password FROM quizzes WHERE teacher_id=? AND ou IS NOT NULL").bind(t.id).all()).results;
    const cache = {};
    for (const q of qs) {
      const ou = String(q.ou);
      if (!(ou in cache)) cache[ou] = await paidOuFor(t, ou);
      if (cache[ou]) continue;
      await db.prepare("INSERT OR REPLACE INTO pending_clear (ou,qi,password) VALUES (?,?,?)").bind(ou, String(q.qi), q.password).run();
      await db.prepare("DELETE FROM quizzes WHERE qi=? AND ou=? AND teacher_id=?").bind(q.qi, ou, t.id).run();
    }
  }
  const curTerms = () => { const d = laToday(), y = +d.slice(0,4), m = +d.slice(5,7), s = m <= 5 ? 1 : (m <= 7 ? 2 : 3); return [String(y*10+s), String(s < 3 ? y*10+s+1 : (y+1)*10+1)]; };
  const splitName = n => { const w = String(n||"").trim().split(/\s+/).filter(Boolean); return w.length >= 2 ? { first: w[0], last: w[w.length-1] } : null; };
  async function payCode(tid) {
    const ex = await db.prepare("SELECT code FROM pay_codes WHERE teacher_id=?").bind(tid).first();
    if (ex) return ex.code;
    const code = "LQ" + rid(5).toUpperCase();
    await db.prepare("INSERT OR IGNORE INTO pay_codes (teacher_id,code) VALUES (?,?)").bind(tid, code).run();
    return (await db.prepare("SELECT code FROM pay_codes WHERE teacher_id=?").bind(tid).first()).code;
  }
  // The professor's USC sections (public Schedule of Classes), with what is paid.
  async function sectionsFor(tid, name) {
    const nm = splitName(name);
    const [cur, nxt] = curTerms();
    if (!nm) return { name: name||null, sections: [] };
    let rows = (await db.prepare("SELECT term,section,course,title,first,last,seats,registered FROM usc_sections WHERE term IN (?,?) AND lower(last)=lower(?) AND lower(first)=lower(?) ORDER BY term,course,section").bind(cur, nxt, nm.last, nm.first).all()).results;
    if (!rows.length) rows = (await db.prepare("SELECT term,section,course,title,first,last,seats,registered FROM usc_sections WHERE term IN (?,?) AND lower(last)=lower(?) AND lower(first) LIKE lower(?) ORDER BY term,course,section").bind(cur, nxt, nm.last, nm.first.slice(0,1) + "%").all()).results;
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
  async function studentCode(email) {
    email = String(email||"").trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
    const ex = await db.prepare("SELECT code FROM pay_codes_students WHERE email=?").bind(email).first();
    if (ex) return ex.code;
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
  async function payInfo(email) {
    const code = await studentCode(email);
    return { amount: STUDENT_FEE, code, venmo: (env.VENMO_HANDLE || "").replace(/^@/, "") || null, zelle: env.ZELLE_TO || null,
             url: PAY_URL + (email ? "?email=" + encodeURIComponent(String(email).toLowerCase()) : "") };
  }
  // Record one payment (idempotent by txn) and apply it: student fee, or professor activation.
  async function applyPayment(p) {
    const txn = String(p.txn||"").slice(0,120); const amount = Number(p.amount);
    if (!txn || !(amount > 0) || amount > 100000) return { ok:false, error:"bad payment" };
    const text = `${p.note||""} ${p.subject||""}`.toUpperCase();
    let code = (text.match(/LQS[A-Z0-9]{5}/) || [])[0] || (text.match(/(?<![A-Z0-9])LQ[A-Z0-9]{5}(?![A-Z0-9])/) || [])[0] || null;
    if (!code) { const em = (String(p.note||"").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [])[0]; if (em) code = await studentCode(em); }
    const term = curTerms()[0];
    const ins = await db.prepare("INSERT OR IGNORE INTO payments (txn,code,amount,via,payer,note,term,received_at,matched) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(txn, code, amount, String(p.via||"").slice(0,20), String(p.payer||"").slice(0,120), String(p.note||"").slice(0,300), term, now(), null).run();
    if (!ins.meta.changes) return { ok:true, duplicate:true };
    return { ok:true, ...(await settle(code, term)) };
  }
  async function settle(code, term) {
    if (!code) return { matched:null };
    if (code.startsWith("LQS")) {
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
  async function trustedInstructor(ou) {
    if (!me || !EMAIL) return false;
    if (me.admin) return true;
    // Must be listed as Instructor on a TRUSTED roster for this course, by BOTH email and the caller's
    // own Brightspace user id (captured at first sync) -- so holding someone else's email is not enough.
    if (!me.bs_user_id) return false;
    return !!(await db.prepare(`SELECT 1 FROM roster r JOIN teacher_courses tc ON tc.ou=r.ou JOIN teachers te ON te.id=tc.teacher_id WHERE r.ou=? AND lower(r.email)=? AND r.user_id=? AND ${INSTR_SQL} AND (te.role='admin' OR te.verified=1) LIMIT 1`).bind(String(ou), EMAIL, String(me.bs_user_id)).first());
  }
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
      if (v.ok) body.device_id = v.id;
      await db.prepare("INSERT INTO devices (device_id,student,platform,version,installed_at,last_seen) VALUES (?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET platform=excluded.platform,version=excluded.version,last_seen=excluded.last_seen")
        .bind(body.device_id, body.student||null, body.platform||null, body.version||null, now(), now()).run();
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
      const device_id = v.ok ? v.id : (body.device_id || null);
      const signed = v.ok ? 1 : 0;
      const qidOk = typeof quiz_id === "string" && /^\d+-\d+$/.test(quiz_id) ? quiz_id : null;
      const detailStr = detail ? JSON.stringify(detail).slice(0, 2000) : null;
      const evName = String(ev).slice(0, 40);
      if (ev !== "heartbeat")
        await db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)")
          .bind(device_id||null, (student?String(student).slice(0,200):null), qidOk, evName, detailStr, now()).run();
      if (device_id) await db.prepare("INSERT OR IGNORE INTO devices (device_id,installed_at) VALUES (?,?)").bind(device_id, now()).run();
      // D1 free plan = 100k row writes/day: a heartbeat refreshes last_seen at most every 10 minutes
      // (an UPDATE that matches no row writes nothing). Real events always update it.
      if (ev === "heartbeat")
        await db.prepare("UPDATE devices SET last_seen=? WHERE device_id=? AND (last_seen IS NULL OR last_seen < ?)").bind(now(), device_id||null, new Date(Date.now() - 600000).toISOString()).run();
      else
        await db.prepare("UPDATE devices SET last_seen=?, student=CASE WHEN student_verified=1 THEN student ELSE COALESCE(?,student) END WHERE device_id=?").bind(now(), student||null, device_id||null).run();
      const clientIp = request.headers.get("CF-Connecting-IP") || null;
      if (ev === "lock" && qidOk)
        await db.prepare("INSERT INTO locks (device_id,quiz_id,last_lock,helper_seen,signed,ip) VALUES (?,?,?,?,?,?) ON CONFLICT(device_id,quiz_id) DO UPDATE SET last_lock=excluded.last_lock,helper_seen=excluded.helper_seen,signed=excluded.signed,ip=excluded.ip").bind(device_id, qidOk, now(), now(), signed, clientIp).run();
      if (ev === "unlock" && qidOk)
        await db.prepare("DELETE FROM locks WHERE device_id=? AND quiz_id=?").bind(device_id, qidOk).run();
      if (ev === "heartbeat" && qidOk) {
        // Only the helper's heartbeat keeps a lock alive; the agent's only proves the agent runs.
        if (agentBeat) await db.prepare("UPDATE locks SET ext_seen=? WHERE device_id=? AND quiz_id=?").bind(now(), device_id, qidOk).run();
        else await db.prepare("UPDATE locks SET last_lock=?, helper_seen=?, signed=?, ip=COALESCE(?,ip) WHERE device_id=? AND quiz_id=?").bind(now(), now(), signed, clientIp, device_id, qidOk).run();
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
        const stu = await db.prepare("SELECT student FROM devices WHERE device_id=?").bind(device_id).first();
        if (!(await studentPaid(stu?.student))) return json({ password: null, reason: "unpaid", pay: await payInfo(stu?.student) }, 402);
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
      if (pw) await db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,(SELECT student FROM devices WHERE device_id=?),?,?,?,?)")
        .bind(device_id, device_id, lockId, "password_released", JSON.stringify({ verified: v.ok, ip: request.headers.get("CF-Connecting-IP") || null }), now()).run();
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
      const dup = await db.prepare("SELECT id FROM teachers WHERE email=?").bind(email).first();
      if (dup) return json({ error:"that email already has an account — log in instead" }, 409);
      // An instructor email that an admin/verified professor has already put on a trusted roster is a
      // real professor's identity. Self-signup can't claim it without an admin invite code (which only
      // the admin issues to that person), so a student can't pre-register bristow@usc.edu.
      const codeUp = String(body.invite||"").trim().toUpperCase();
      const invPre = codeUp ? await db.prepare("SELECT 1 FROM invites WHERE code=? AND used_at IS NULL AND (email IS NULL OR email=?)").bind(codeUp, email).first() : null;
      if (!invPre) {
        const INSTR_ANY = "(r.role LIKE '%nstructor%' OR r.role LIKE '%rofessor%' OR r.role LIKE '%aculty%')";
        const claimed = await db.prepare(`SELECT 1 FROM roster r JOIN teacher_courses tc ON tc.ou=r.ou JOIN teachers te ON te.id=tc.teacher_id WHERE lower(r.email)=? AND ${INSTR_ANY} AND (te.role='admin' OR te.verified=1) LIMIT 1`).bind(email).first();
        if (claimed) return json({ error:"This email belongs to a professor already on a course roster. Ask the LOCKqz admin for an invite to claim it." }, 409);
      }
      // The first account on the site is the admin. Anyone can sign up after that, but a new teacher
      // is UNVERIFIED and can protect nothing until they prove -- through their OWN Brightspace login
      // (LOCKqz Sync) -- that they are an instructor or TA. A student can make an account but can never
      // verify (no staff role in Brightspace), so a student can never act as a teacher. No email from
      // anyone is needed. An optional invite code still sets the paid window, but is not required.
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
      const id = rid(10), salt = rid(16), token = hex(crypto.getRandomValues(new Uint8Array(24)));
      await db.prepare("INSERT INTO teachers (id,email,name,pw_hash,salt,token,created_at,role,active_until) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(id, email, String(body.name||"").trim()||null, await hashPw(pw,salt), salt, token, now(), n===0?"admin":"teacher", inv ? inv.active_until : null).run();
      return json({ token, email, name: body.name||null });
    }
    if (p === "/login" && request.method === "POST") {
      const email = String(body.email||"").trim().toLowerCase(), pw = String(body.password||"");
      const ip = request.headers.get("CF-Connecting-IP") || "?";
      const lkey = `login:${email}:${ip}`, since = new Date(Date.now()-900000).toISOString();
      const fails = (await db.prepare("SELECT COUNT(*) AS n FROM events WHERE event='login_fail' AND detail=? AND ts>?").bind(lkey, since).first()).n;
      if (fails >= 5) return json({ error:"too many attempts — wait 15 minutes" }, 429);
      const t = await db.prepare("SELECT id,email,name,pw_hash,salt,token FROM teachers WHERE email=?").bind(email).first();
      if (!t || (await hashPw(pw, t.salt)) !== t.pw_hash) {
        await db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)").bind(null,null,null,"login_fail",lkey,now()).run();
        return json({ error:"wrong email or password" }, 401);
      }
      let token = t.token;
      if (!token) { token = hex(crypto.getRandomValues(new Uint8Array(24))); await db.prepare("UPDATE teachers SET token=? WHERE id=?").bind(token, t.id).run(); }
      return json({ token, email: t.email, name: t.name });
    }
    if (p === "/forgot" && request.method === "POST") {
      const email = String(body.email||"").trim().toLowerCase();
      const t = await db.prepare("SELECT id FROM teachers WHERE email=?").bind(email).first().catch(()=>null);
      if (t) await db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)")
        .bind(null,null,null,"reset_request",email,now()).run();
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
      if (me && !me.admin) await db.prepare("UPDATE teachers SET token=NULL WHERE id=?").bind(me.id).run();
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
      if (!me?.admin) return json({ error:"admin only" }, 401);
      const r = await db.prepare("SELECT t.id,t.email,t.name,t.created_at,t.active_until,(SELECT COUNT(*) FROM paid_sections ps WHERE ps.teacher_id=t.id AND ps.until>=?) AS paid_sections,(SELECT code FROM pay_codes pc WHERE pc.teacher_id=t.id) AS memo FROM teachers t ORDER BY t.created_at DESC").bind(laToday()).all();
      return json({ teachers: r.results });
    }
    // Admin only: turn a teacher on (after payment) until a date, or off.
    if (p === "/activate" && request.method === "POST") {
      if (!me?.admin) return json({ error:"admin only" }, 401);
      const email = String(body.email||"").trim().toLowerCase();
      const until = body.until ? String(body.until).slice(0,10) : null;   // "YYYY-MM-DD" or null = off
      const r = await db.prepare("UPDATE teachers SET active_until=? WHERE email=?").bind(until, email).run();
      if (r.meta.changes && (!until || until < laToday())) {
        const tt = await db.prepare("SELECT id FROM teachers WHERE email=?").bind(email).first();
        if (tt) await releaseUnpaid({ id: tt.id, admin: false, active: false });
      }
      return r.meta.changes ? json({ email, active_until: until }) : json({ error:"no such professor" }, 404);
    }
    if (p === "/reset" && request.method === "POST") {
      if (!me?.admin) return json({ error:"admin only" }, 401);
      const email = String(body.email||"").trim().toLowerCase(), salt = rid(16), pw = body.password || ("LQ-"+rid(8));
      const r = await db.prepare("UPDATE teachers SET pw_hash=?,salt=?,token=NULL WHERE email=?").bind(await hashPw(pw,salt), salt, email).run();
      return r.meta.changes ? json({ email, password: pw }) : json({ error:"no such professor" }, 404);
    }
    // Admin only: invite a teacher (one-time code; optional email lock; account active until a date).
    if (p === "/invite" && request.method === "POST") {
      if (!me?.admin) return json({ error:"admin only" }, 401);
      const email = String(body.email||"").trim().toLowerCase() || null;
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error:"enter a valid email" }, 400);
      if (email && await db.prepare("SELECT id FROM teachers WHERE email=?").bind(email).first()) return json({ error:"that email already has an account" }, 409);
      const code = rid(10), until = body.until ? String(body.until).slice(0,10) : null;
      await db.prepare("INSERT INTO invites (code,email,active_until,created_at) VALUES (?,?,?,?)").bind(code, email, until, now()).run();
      return json({ code, email, active_until: until });
    }
    if (p === "/invites") {
      if (!me?.admin) return json({ error:"admin only" }, 401);
      const r = await db.prepare("SELECT code,email,active_until,created_at,used_at,used_by FROM invites ORDER BY created_at DESC LIMIT 100").all();
      return json({ invites: r.results });
    }
    if (p === "/uninvite" && request.method === "POST") {
      if (!me?.admin) return json({ error:"admin only" }, 401);
      const r = await db.prepare("DELETE FROM invites WHERE code=? AND used_at IS NULL").bind(String(body.code||"")).run();
      return r.meta.changes ? json({ ok:true }) : json({ error:"invite not found or already used" }, 404);
    }

    // Admin: a professor's sections + mark sections paid / unpaid (after the Venmo payment arrives).
    if (p === "/teacher-sections") {
      if (!me?.admin) return json({ error:"admin only" }, 401);
      const t = await db.prepare("SELECT id,email,name FROM teachers WHERE email=?").bind(String(url.searchParams.get("email")||"").toLowerCase()).first();
      if (!t) return json({ error:"no such professor" }, 404);
      const r = await sectionsFor(t.id, url.searchParams.get("name") || t.name);
      return json({ ...r, email: t.email, memo: await payCode(t.id), price: PRICE });
    }
    if (p === "/pay-sections" && request.method === "POST") {
      if (!me?.admin) return json({ error:"admin only" }, 401);
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
      const info = await payInfo(email);
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
      if (secret.length < 16 || got !== secret) return json({ error:"unauthorized" }, 401);
      const list = Array.isArray(body.payments) ? body.payments.slice(0, 100) : [body];
      const out = []; for (const x of list) out.push(await applyPayment(x || {}));
      return json({ results: out });
    }
    if (p === "/payments") {
      if (!me?.admin) return json({ error:"admin only" }, 401);
      const r = await db.prepare("SELECT p.txn,p.code,p.amount,p.via,p.payer,p.note,p.term,p.received_at,COALESCE(s.email,t.email) AS who FROM payments p LEFT JOIN pay_codes_students s ON s.code=p.code LEFT JOIN pay_codes pc ON pc.code=p.code LEFT JOIN teachers t ON t.id=pc.teacher_id ORDER BY p.received_at DESC LIMIT 300").all();
      return json({ payments: r.results, fee_on: feeOn(), fee: STUDENT_FEE, fee_from: env.STUDENT_FEE_FROM || null, script_key: await paySecret() });
    }
    if (p === "/pay-assign" && request.method === "POST") {
      if (!me?.admin) return json({ error:"admin only" }, 401);
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
      const dupe = await db.prepare("SELECT teacher_id FROM quizzes WHERE ou=? AND qi=?").bind(ou, qi).first();
      if (dupe && dupe.teacher_id !== me.id && !me.admin) return json({ error:"that quiz is already managed by another professor" }, 409);
      const quiz_id = body.quiz_id || rid(8);
      const password = "LQ-" + rid(8);
      const lock_id = `${ou}-${qi}`;
      await db.prepare("INSERT INTO quizzes (quiz_id,title,url,password,created_at,qi,teacher_id,lock_id,ou) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(quiz_id, body.title||null, body.url||null, password, now(), qi, me.id, lock_id, ou).run();
      return json({ quiz_id, password, qi, lock_id, tag: `[LOCKqz] ${body.title||quiz_id}` });
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
      if (body.quiz_id) {
        const q = await db.prepare(`SELECT ou,qi,password FROM quizzes WHERE quiz_id=? AND ${m.sql}`).bind(body.quiz_id, ...m.args).first();
        if (q) {
          if (q.ou && q.qi) await db.prepare("INSERT OR REPLACE INTO pending_clear (ou,qi,password) VALUES (?,?,?)").bind(q.ou, q.qi, q.password).run();
          await db.prepare("DELETE FROM quizzes WHERE quiz_id=?").bind(body.quiz_id).run();
        }
      }
      if (body.ou)      await db.prepare(`DELETE FROM courses WHERE ou=? AND ${m.sql}`).bind(body.ou, ...m.args).run();
      return json({ ok:true });
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
      const courses = (Array.isArray(body.courses) ? body.courses : []).slice(0, 80), t = now(), st = [];
      const myEmail = String(me.email||"").toLowerCase();
      // Capture the caller's own Brightspace id once (first sync wins; it can never be changed later),
      // so verification can require the roster's Instructor row to carry this same id.
      const whoId = body.whoami && body.whoami.id != null ? String(body.whoami.id) : null;
      if (whoId && !me.admin) {
        await db.prepare("UPDATE teachers SET bs_user_id=? WHERE id=? AND (bs_user_id IS NULL OR bs_user_id='')").bind(whoId, me.id).run();
        if (!me.bs_user_id) me.bs_user_id = whoId;   // reflect it within THIS request (auto-protect below needs it)
      }
      const LEARNER = "(role LIKE '%earner%' OR role LIKE '%tudent%')";
      // Trust the roster, not the browser. A course is TRUSTED once an admin or an already-verified
      // professor has synced it. An untrusted caller (new signup, or a student) may seed a course that
      // nobody trusted owns yet, but can NEVER overwrite a course a trusted professor already owns
      // unless that course's roster lists them as staff -- so a student can't wipe or fake a real class.
      const allowed = {};
      for (const c of courses) {
        const ou = String(c.ou||""); if (!/^\d+$/.test(ou) || ou in allowed) continue;
        if (me.admin) { allowed[ou] = true; continue; }
        // Write a course only if you are its trusted instructor, or nobody trusted owns it yet
        // (seeding). Seeding grants no power until an admin/verified instructor vouches for the course.
        allowed[ou] = (await trustedInstructor(ou)) || !(await hasTrustedOwner(ou));
      }
      for (const c of courses) {
        const ou = String(c.ou || ""); if (!/^\d+$/.test(ou) || !allowed[ou]) continue;
        // A trusted owner syncing this course evicts any seed rows a non-trusted account left on it.
        if (me.admin || await trustedInstructor(ou)) await db.prepare("DELETE FROM teacher_courses WHERE ou=? AND teacher_id<>? AND teacher_id NOT IN (SELECT id FROM teachers WHERE role='admin' OR verified=1)").bind(ou, me.id).run();
        st.push(db.prepare("INSERT INTO teacher_courses (teacher_id,ou,name,code,role,synced_at) VALUES (?,?,?,?,?,?) ON CONFLICT(teacher_id,ou) DO UPDATE SET name=excluded.name,code=excluded.code,role=excluded.role,synced_at=excluded.synced_at")
          .bind(me.id, ou, c.name||null, c.code||null, c.role||null, t));
        if (Array.isArray(c.classlist)) {
          // Free-plan write budget: compare with what is stored and write only changed/new/removed rows.
          const old = new Map((await db.prepare("SELECT user_id,name,email,username,org_id,role FROM roster WHERE ou=?").bind(ou).all()).results.map(r => [String(r.user_id), r]));
          const seen = new Set();
          for (const s of c.classlist.slice(0, 3000)) {
            const row = [String(s.id ?? ""), s.name||null, String(s.email||"").toLowerCase()||null, s.username||null, s.org_id ? String(s.org_id) : null, s.role||null];
            seen.add(row[0]);
            const o = old.get(row[0]);
            if (o && o.name === row[1] && o.email === row[2] && o.username === row[3] && (o.org_id ?? null) === row[4] && o.role === row[5]) continue;
            st.push(db.prepare("INSERT OR REPLACE INTO roster (ou,user_id,name,email,username,org_id,role,synced_at) VALUES (?,?,?,?,?,?,?,?)").bind(ou, ...row, t));
          }
          for (const id of old.keys()) if (!seen.has(id)) st.push(db.prepare("DELETE FROM roster WHERE ou=? AND user_id=?").bind(ou, id));
        }
        if (Array.isArray(c.quizzes)) {
          const oldQ = new Map((await db.prepare("SELECT qi,name,active,start_date,end_date,due_date,bs_has_password,bs_password_is_ours FROM bs_quizzes WHERE ou=?").bind(ou).all()).results.map(r => [String(r.qi), r]));
          const seenQ = new Set();
          for (const q of c.quizzes.slice(0, 1000)) {
            const qi = String(q.qi), o = oldQ.get(qi); seenQ.add(qi);
            const row = [q.name||null, q.active?1:0, q.start||null, q.end||null, q.due||null, q.has_password?1:0, (o && Number(o.bs_password_is_ours) === 1) && q.has_password ? 1 : 0];
            if (o && o.name === row[0] && Number(o.active) === row[1] && o.start_date === row[2] && o.end_date === row[3] && o.due_date === row[4] && Number(o.bs_has_password) === row[5] && Number(o.bs_password_is_ours) === row[6]) continue;
            st.push(db.prepare("INSERT OR REPLACE INTO bs_quizzes (ou,qi,name,active,start_date,end_date,due_date,bs_has_password,bs_password_is_ours,synced_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(ou, qi, ...row, t));
          }
          for (const qi of oldQ.keys()) if (!seenQ.has(qi)) st.push(db.prepare("DELETE FROM bs_quizzes WHERE ou=? AND qi=?").bind(ou, qi));
        }
      }
      for (let i = 0; i < st.length; i += 90) await db.batch(st.slice(i, i + 90));
      // Protect-by-default: new active quizzes get a LOCKqz password automatically (allowed courses only).
      const today = now().slice(0, 10);
      for (const c of courses) {
        const ou = String(c.ou || ""); if (!/^\d+$/.test(ou) || !allowed[ou] || !Array.isArray(c.quizzes)) continue;
        if (!(await paidOu(ou))) continue;                           // unpaid section: never auto-protect
        if (!me.admin && !(await trustedInstructor(ou))) continue;   // auto-protect only courses you instruct
        for (const q of c.quizzes) {
          const qi = String(q.qi || ""); if (!/^\d+$/.test(qi)) continue;
          if (q.active === false) continue;
          if (q.end && String(q.end).slice(0, 10) < today) continue;   // skip ended quizzes
          const seen = await db.prepare("SELECT 1 FROM quizzes WHERE qi=? AND ou=? UNION ALL SELECT 1 FROM pending_clear WHERE ou=? AND qi=? UNION ALL SELECT 1 FROM lockqz_off WHERE ou=? AND qi=?").bind(qi, ou, ou, qi, ou, qi).first();
          if (seen) continue;
          await db.prepare("INSERT INTO quizzes (quiz_id,title,url,password,created_at,qi,teacher_id,lock_id,ou,gated) VALUES (?,?,?,?,?,?,?,?,?,0)")
            .bind(rid(8), q.name||null, null, "LQ-" + rid(8), now(), qi, me.id, `${ou}-${qi}`, ou).run();
        }
      }
      // VERIFY ONLY FROM A TRUSTED ROSTER -- a student can never become a professor:
      //  - if this email is a Learner/Student on ANY roster, it is never verified (and loses it);
      //  - else verified only if a TRUSTED course's roster (one an admin or verified professor synced)
      //    lists this email with a staff role. So the admin (or an already-verified professor) syncing
      //    a course is what lets its real instructors/TAs in; a stranger needs that seed first.
      if (!me.admin) {
        // Verified iff this email is an Instructor on a TRUSTED course's roster. A grad-student who
        // instructs one course and takes another is still verified (instructor takes precedence over
        // being a learner elsewhere). A pure student is never an Instructor anywhere, so never verified.
        // Verified iff a TRUSTED roster lists this email as Instructor AND that row's Brightspace user
        // id equals the id this account first synced with. So pre-registering someone else's email and
        // waiting for the admin to seed the roster no longer grants verification (the ids won't match).
        const myBs = (await db.prepare("SELECT bs_user_id FROM teachers WHERE id=?").bind(me.id).first())?.bs_user_id || null;
        const prof = myBs ? await db.prepare(`SELECT 1 FROM roster r JOIN teacher_courses tc ON tc.ou=r.ou JOIN teachers te ON te.id=tc.teacher_id WHERE lower(r.email)=? AND ${INSTR_SQL} AND r.user_id=? AND (te.role='admin' OR te.verified=1) LIMIT 1`).bind(myEmail, String(myBs)).first() : null;
        await db.prepare("UPDATE teachers SET verified=? WHERE id=?").bind(prof ? 1 : 0, me.id).run();
      }
      await releaseUnpaid(me);
      // Only hand back passwords for courses this caller instructs (never leak another course's).
      const ownOus = [];
      for (const c of courses) { const ou = String(c.ou||""); if (/^\d+$/.test(ou) && (me.admin || await trustedInstructor(ou))) ownOus.push(ou); }
      return json(await bsState(ownOus));
    }
    if (p === "/sync-result" && request.method === "POST") {
      for (const r of (Array.isArray(body.results) ? body.results : []).slice(0, 1000)) {
        const ou = String(r.ou||""), qi = String(r.qi||"");
        if (!(await inCourse(ou))) continue;
        if (r.status === "set" || r.status === "already")
          await db.prepare("UPDATE bs_quizzes SET bs_password_is_ours=1, bs_has_password=1 WHERE ou=? AND qi=?").bind(ou, qi).run();
        else if (r.status === "cleared") {
          await db.prepare("DELETE FROM pending_clear WHERE ou=? AND qi=?").bind(ou, qi).run();
          await db.prepare("UPDATE bs_quizzes SET bs_password_is_ours=0 WHERE ou=? AND qi=?").bind(ou, qi).run();
        } else if (r.status === "error")
          await db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)").bind(null, null, `${ou}-${qi}`, "brightspace_sync_error", String(r.msg||"").slice(0,300), now()).run();
      }
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
      await db.prepare("UPDATE quizzes SET bs_code=? WHERE qi=? AND ou=? AND gated=1").bind(code, qi, ou).run();
      return json({ ok: true });
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
      for (let i = 0; i < uids.length; i += 1)
        await db.prepare("INSERT OR IGNORE INTO submissions (ou,qi,user_id,at) VALUES (?,?,?,?)").bind(ou, qi, uids[i], now()).run();
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
      const sub = "SELECT ou FROM teacher_courses WHERE teacher_id=?";
      const roster = (await db.prepare(`SELECT ou,user_id,name,email,username,role FROM roster WHERE ou IN (${sub}) ORDER BY name`).bind(me.id).all()).results;
      const qz = (await db.prepare(`SELECT b.ou,b.qi,b.name,b.active,b.start_date,b.end_date,b.due_date,b.bs_has_password,b.bs_password_is_ours,q.password,q.lock_id,q.gated FROM bs_quizzes b LEFT JOIN quizzes q ON q.qi=b.qi AND q.ou=b.ou WHERE b.ou IN (${sub}) ORDER BY b.name`).bind(me.id).all()).results;
      const devs = (await db.prepare(`SELECT device_id,lower(student) AS who,platform,version,last_seen FROM devices WHERE (student_verified=1 OR ?=0) AND (lower(student) IN (SELECT lower(email) FROM roster WHERE ou IN (${sub})) OR lower(student) IN (SELECT lower(name) FROM roster WHERE ou IN (${sub})))`).bind(codesOn ? 1 : 0, me.id, me.id).all()).results;
      const by = {}; devs.forEach(d => { (by[d.who] = by[d.who] || []).push(d); });
      const adminEmails = new Set(((await db.prepare("SELECT lower(email) AS e FROM teachers WHERE role='admin'").all()).results).map(x => x.e));
      return json({ courses: cs.map(c => ({ ...c,
        // Everyone LOCKqz locks: Learners AND TAs (any non-instructor role). The admin is the one
        // exempt person (developer mode), so he is never listed as someone who must install.
        students: roster.filter(r => r.ou === c.ou && takesQuizzes(r.role) && !adminEmails.has((r.email||"").toLowerCase())).map(r => {
          const d = by[(r.email||"").toLowerCase()] || by[(r.name||"").toLowerCase()] || [];
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
      return { sql:`(${col} IN (SELECT lock_id FROM quizzes WHERE teacher_id=?) OR ${ouExpr} IN (SELECT ou FROM teacher_courses WHERE teacher_id=?) OR ${ouExpr} IN (SELECT ou FROM courses WHERE teacher_id=?))`,
               args:[me.id, me.id, me.id] };
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
      const like = `${quiz}-%`;
      const _ou0 = String(quiz).split("-")[0];
      if (!me.admin && !(await inCourse(_ou0)) && !(await trustedInstructor(_ou0))) return json({ error: "not your course" }, 403);
      const s = scope("l.quiz_id"), s2 = scope("e.quiz_id");
      const STALE = 660000, nowMs = Date.now(), age = t => t ? (nowMs - Date.parse(t)) : null;   // helper pings every ~300s
      // Free-plan read budget (5M rows/day): the Sync tab calls /live every 10s per gated quiz, so every
      // query here must use an index. "quiz_id = q OR starts with q-" is written as a RANGE (an index
      // can serve it; LIKE cannot), and the three events scans are one indexed query.
      const QR = col => `(${col}=? OR (${col}>=? AND ${col}<?))`, qa = [quiz, quiz + "-", quiz + "."];
      const locks = (await db.prepare(`SELECT l.device_id,l.quiz_id,l.last_lock,l.helper_seen,l.ext_seen,l.signed,l.ip,d.student,d.platform,d.student_verified FROM locks l LEFT JOIN devices d ON d.device_id=l.device_id WHERE ${QR("l.quiz_id")} AND ${s.sql}`).bind(...qa, ...s.args).all()).results;
      const evs = (await db.prepare(`SELECT e.device_id, e.event, MAX(e.event='lock' AND e.detail LIKE '%"developer":true%') AS dev FROM events e WHERE ${QR("e.quiz_id")} AND e.event IN ('tamper','lock','unlock','auto_unlock') AND ${s2.sql} GROUP BY e.device_id, e.event`).bind(...qa, ...s2.args).all()).results;
      const tamp = new Set(evs.filter(x => x.event === "tamper").map(x => x.device_id));
      // Developer mode: only the admin's own Mac may hold a lock without blocking AI. A dev claim
      // from any other device is a modified client -> tamper (never admitted).
      const devClaim = new Set(evs.filter(x => x.event === "lock" && Number(x.dev) === 1).map(x => x.device_id));
      const adminEm = new Set(((await db.prepare("SELECT lower(email) AS e FROM teachers WHERE role='admin'").all()).results).map(x => x.e));
      const doneIds = [...new Set(evs.filter(x => x.event === "unlock" || x.event === "auto_unlock").map(x => x.device_id))].filter(id => !locks.some(l => l.device_id === id));
      const done = doneIds.length ? (await db.prepare("SELECT device_id,student,platform,student_verified FROM devices WHERE device_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(doneIds)).all()).results : [];
      const active = new Set(locks.map(l=>l.device_id));
      const rows = locks.map(l => {
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
        return { device_id:l.device_id, student:l.student||null, platform:l.platform||null, status, last_lock:l.last_lock, age_ms:a, verified: Number(l.signed) === 1, ip: l.ip||null, sv: Number(l.student_verified) === 1 };
      });
      done.forEach(d => { if (!active.has(d.device_id)) rows.push({ device_id:d.device_id, student:d.student||null, platform:d.platform||null, status:"done", sv: Number(d.student_verified) === 1 }); });
      // A student is admitted ONLY when LOCKqz is holding a fresh, device-signed lock (status "locked",
      // verified). The gate loop reads r.eligible + r.user_id to grant/revoke Brightspace special access.
      const _qi = String(quiz).split("-").pop(), _ou = String(quiz).split("-")[0];
      const _sq = /^\d+$/.test(_qi) ? await db.prepare("SELECT start_date FROM bs_quizzes WHERE ou=? AND qi=?").bind(_ou, _qi).first() : null;
      const started = !(_sq && _sq.start_date) || Date.now() >= Date.parse(_sq.start_date);   // not before scheduled start
      rows.forEach(r => { r.eligible = (started && (r.status === "locked" || r.status === "developer") && r.verified === true); });
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
      // Server-confirmed submissions (reported by the professor's trusted Sync session). A device that
      // reported "unlock" is a clean "done" ONLY if Brightspace shows its student submitted; otherwise,
      // while the quiz is still open, it is "left_early" (AI unblocked without a real submit) -- a red
      // flag, never a quiet green done. A forced local unlock therefore cannot pose as a submission.
      const subs = rows.some(r => r.status === "done") ? new Set(((await db.prepare("SELECT user_id FROM submissions WHERE ou=? AND qi=?").bind(_ou, _qi).all()).results).map(x => String(x.user_id))) : new Set();
      rows.forEach(r => {
        if (r.status === "done") {
          const submitted = r.user_id && subs.has(String(r.user_id));
          if (submitted) r.submitted = true;
          else if (started) { r.status = "left_early"; r.submitted = false; }
        }
      });
      return json({ quiz, now: now(), stale_ms: STALE, rows });
    }

    return json({ error: "not found", path: p }, 404);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}
