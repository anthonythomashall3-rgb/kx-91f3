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
  const denied = (v, extra = {}) => json({ error: "unauthorized device", why: v.why, server_time: unixNow(), ...extra }, 401);

  // ---- who is calling? admin (master key) | teacher (session token) | nobody ----
  const hdr = (request.headers.get("X-LOCKqz-Teacher") || "").trim();
  const adminKey = (env.TEACHER_KEY || "").trim();
  let me = null;                                   // { id, email, name, admin }
  if (hdr && adminKey && hdr === adminKey) me = { id:"admin", email:"admin", name:"Admin", admin:true, verified:true };
  else {
    const syncKey = (request.headers.get("X-LOCKqz-Sync") || "").trim();
    const t = hdr ? await db.prepare("SELECT id,email,name,role,active_until,verified FROM teachers WHERE token=?").bind(hdr).first().catch(()=>null)
          : syncKey ? await db.prepare("SELECT id,email,name,role,active_until,verified FROM teachers WHERE sync_key=?").bind(syncKey).first().catch(()=>null) : null;
    if (t) me = { id:t.id, email:t.email, name:t.name, admin: t.role === "admin", verified: t.role === "admin" || t.verified === 1, active: t.role === "admin" || t.verified === 1 || (!!t.active_until && t.active_until >= now().slice(0,10)), active_until: t.active_until||null };
  }
  const teacher = () => !!me;
  const mine = (col="teacher_id") => me.admin ? { sql:"1=1", args:[] } : { sql:`${col}=?`, args:[me.id] };
  const inCourse = async ou => me && (me.admin || !!(await db.prepare("SELECT 1 FROM teacher_courses WHERE teacher_id=? AND ou=?").bind(me.id, String(ou)).first()));
  async function bsState(ous) {
    ous = ous.map(String).filter(o => /^\d+$/.test(o));
    if (!ous.length) return { protect: [], clear: [] };
    const ph = ous.map(()=>"?").join(",");
    const protect = (await db.prepare(`SELECT ou,qi,password,title FROM quizzes WHERE ou IN (${ph}) AND qi IS NOT NULL`).bind(...ous).all()).results;
    const clear = (await db.prepare(`SELECT ou,qi,password FROM pending_clear WHERE ou IN (${ph})`).bind(...ous).all()).results;
    return { protect, clear };
  }

  try {
    // ---- device endpoints (signed by the device key; see verifyDevice) ----
    if (p === "/blocklist") return json({ domains: AI_DOMAINS });

    // One-time device registration (trust on first use). A device id can never be re-keyed, so a
    // registered student's device cannot be taken over by registering the same id again.
    if (p === "/register" && request.method === "POST") {
      const id = String(body.device_id || "").trim(), key = String(body.key || "").trim().toLowerCase();
      if (!/^[A-Za-z0-9._-]{6,80}$/.test(id) || id === "unknown") return json({ error: "bad device id" }, 400);
      if (!/^[0-9a-f]{64}$/.test(key)) return json({ error: "bad key" }, 400);
      await db.prepare("INSERT INTO devices (device_id,student,platform,version,installed_at,last_seen,device_key,registered_at,reg_ip) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET device_key=excluded.device_key, registered_at=excluded.registered_at, reg_ip=excluded.reg_ip, platform=COALESCE(excluded.platform,devices.platform), version=COALESCE(excluded.version,devices.version), last_seen=excluded.last_seen WHERE devices.device_key IS NULL")
        .bind(id, body.student || null, body.platform || null, body.version || null, now(), now(), key, now(), request.headers.get("CF-Connecting-IP") || null).run();
      const d = await db.prepare("SELECT device_key, revoked FROM devices WHERE device_id=?").bind(id).first();
      if (d && d.revoked) return json({ error: "device revoked" }, 403);
      return d && sameHex(d.device_key, key) ? json({ ok: true, registered: true }) : json({ error: "device already registered" }, 409);
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
          if (claimed && quiz_id) await db.prepare("UPDATE locks SET ext_seen=? WHERE device_id=? AND quiz_id=?").bind(now(), claimed, quiz_id).run();
          return json({ ok: true, verified: false });
        }
        if (!legacy) return denied(v);
      }
      const device_id = v.ok ? v.id : (body.device_id || null);
      const signed = v.ok ? 1 : 0;
      if (ev !== "heartbeat")
        await db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,?,?,?,?,?)")
          .bind(device_id||null, student||null, quiz_id||null, ev, detail?JSON.stringify(detail):null, now()).run();
      if (device_id) await db.prepare("INSERT OR IGNORE INTO devices (device_id,installed_at) VALUES (?,?)").bind(device_id, now()).run();
      await db.prepare("UPDATE devices SET last_seen=?, student=COALESCE(?,student) WHERE device_id=?").bind(now(), student||null, device_id||null).run();
      if (ev === "lock")
        await db.prepare("INSERT INTO locks (device_id,quiz_id,last_lock,helper_seen,signed) VALUES (?,?,?,?,?) ON CONFLICT(device_id,quiz_id) DO UPDATE SET last_lock=excluded.last_lock,helper_seen=excluded.helper_seen,signed=excluded.signed").bind(device_id, quiz_id, now(), now(), signed).run();
      if (ev === "unlock")
        await db.prepare("DELETE FROM locks WHERE device_id=? AND quiz_id=?").bind(device_id, quiz_id).run();
      if (ev === "heartbeat" && quiz_id) {
        // Only the helper's heartbeat keeps a lock alive; the agent's only proves the agent runs.
        if (agentBeat) await db.prepare("UPDATE locks SET ext_seen=? WHERE device_id=? AND quiz_id=?").bind(now(), device_id, quiz_id).run();
        else await db.prepare("UPDATE locks SET last_lock=?, helper_seen=?, signed=? WHERE device_id=? AND quiz_id=?").bind(now(), now(), signed, device_id, quiz_id).run();
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
      const lockId = `${ou || "x"}-${qi || "x"}`;
      const lk = await db.prepare("SELECT last_lock, signed FROM locks WHERE device_id=? AND quiz_id=?").bind(device_id, lockId).first();
      const fresh = lk && (Date.now() - Date.parse(lk.last_lock) < 60000) && (!(strict || v.ok) || Number(lk.signed) === 1);
      if (!fresh) return json({ password: null, reason: "not locked" }, 403);
      let pw = null;
      if (qi) { const q = await db.prepare("SELECT password FROM quizzes WHERE qi=?").bind(qi).first(); if (q) pw = q.password; }
      if (!pw && ou) { const c = await db.prepare("SELECT password FROM courses WHERE ou=?").bind(ou).first(); if (c) pw = c.password; }
      if (pw) await db.prepare("INSERT INTO events (device_id,student,quiz_id,event,detail,ts) VALUES (?,(SELECT student FROM devices WHERE device_id=?),?,?,?,?)")
        .bind(device_id, device_id, lockId, "password_released", JSON.stringify({ verified: v.ok, ip: request.headers.get("CF-Connecting-IP") || null }), now()).run();
      return json({ password: pw, lockId });
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
          if (inv && !inv.used_at && (!inv.email || inv.email === email))
            await db.prepare("UPDATE invites SET used_at=?, used_by=? WHERE code=? AND used_at IS NULL").bind(now(), email, inv.code).run();
          else inv = null;
        }
      }
      const id = rid(10), salt = rid(16), token = hex(crypto.getRandomValues(new Uint8Array(24)));
      await db.prepare("INSERT INTO teachers (id,email,name,pw_hash,salt,token,created_at,role,active_until) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(id, email, String(body.name||"").trim()||null, await hashPw(pw,salt), salt, token, now(), n===0?"admin":"teacher", inv ? inv.active_until : null).run();
      return json({ token, email, name: body.name||null });
    }
    if (p === "/login" && request.method === "POST") {
      const email = String(body.email||"").trim().toLowerCase(), pw = String(body.password||"");
      const t = await db.prepare("SELECT id,email,name,pw_hash,salt,token FROM teachers WHERE email=?").bind(email).first();
      if (!t || (await hashPw(pw, t.salt)) !== t.pw_hash) return json({ error:"wrong email or password" }, 401);
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
      const pw = String(body.password||"");
      if (pw.length < 8) return json({ error:"password must be at least 8 characters" }, 400);
      const salt = rid(16);
      await db.prepare("UPDATE teachers SET pw_hash=?, salt=? WHERE id=?").bind(await hashPw(pw,salt), salt, me.id).run();
      return json({ ok:true });
    }
    // Admin only: list teachers / reset a teacher's password (no email service, so the
    // admin hands the new password to the teacher).
    if (p === "/teachers") {
      if (!me?.admin) return json({ error:"admin only" }, 401);
      const r = await db.prepare("SELECT id,email,name,created_at,active_until FROM teachers ORDER BY created_at DESC").all();
      return json({ teachers: r.results });
    }
    // Admin only: turn a teacher on (after payment) until a date, or off.
    if (p === "/activate" && request.method === "POST") {
      if (!me?.admin) return json({ error:"admin only" }, 401);
      const email = String(body.email||"").trim().toLowerCase();
      const until = body.until ? String(body.until).slice(0,10) : null;   // "YYYY-MM-DD" or null = off
      const r = await db.prepare("UPDATE teachers SET active_until=? WHERE email=?").bind(until, email).run();
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
      await db.prepare("DELETE FROM invites WHERE code=? AND used_at IS NULL").bind(String(body.code||"")).run();
      return json({ ok:true });
    }

    // ---- teacher endpoints (need a logged-in teacher or the admin key) ----
    if (!teacher()) return json({ error: "unauthorized" }, 401);

    if ((p === "/quiz" || p === "/course" || p === "/protect" || p === "/gate") && request.method === "POST" && !me.admin && !me.verified)
      return json({ error: "Verify you teach this course first: open Brightspace and click LOCKqz Sync." }, 403);
    if ((p === "/quiz" || p === "/course" || (p === "/protect" && body.on)) && request.method === "POST" && !me.active)
      return json({ error: "Your account is not active yet. Contact the LOCKqz admin to activate it." }, 402);

    if (p === "/quiz" && request.method === "POST") {
      const quiz_id = body.quiz_id || rid(8);
      const password = "LQ-" + rid(8);
      const { qi, ou } = ids(String(body.url||""));
      const lock_id = `${ou||"x"}-${qi||"x"}`;
      await db.prepare("INSERT INTO quizzes (quiz_id,title,url,password,created_at,qi,teacher_id,lock_id) VALUES (?,?,?,?,?,?,?,?)")
        .bind(quiz_id, body.title||null, body.url||null, password, now(), qi, me.id, lock_id).run();
      return json({ quiz_id, password, qi, lock_id, tag: `[LOCKqz] ${body.title||quiz_id}` });
    }
    if (p === "/quizzes") {
      const m = mine();
      const r = await db.prepare(`SELECT quiz_id,title,url,password,created_at,qi,lock_id,teacher_id,ou FROM quizzes WHERE (${m.sql} OR ou IN (SELECT ou FROM teacher_courses WHERE teacher_id=?)) ORDER BY created_at DESC`).bind(...m.args, me.id).all();
      return json({ quizzes: r.results });
    }
    if (p === "/course" && request.method === "POST") {
      const u = String(body.url || "");
      const ou = (u.match(/ou=(\d+)/) || u.match(/\/home\/(\d+)/) || u.match(/\/(\d+)(?:\/|$)/) || [])[1];
      if (!ou) return json({ error: "could not find the course id (ou=) in that link" }, 400);
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
        const q = await db.prepare(`SELECT ou,qi,password FROM quizzes WHERE quiz_id=? AND (${m.sql} OR ou IN (SELECT ou FROM teacher_courses WHERE teacher_id=?))`).bind(body.quiz_id, ...m.args, me.id).first();
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
      for (const c of courses) {
        const ou = String(c.ou || ""); if (!/^\d+$/.test(ou)) continue;
        st.push(db.prepare("INSERT INTO teacher_courses (teacher_id,ou,name,code,role,synced_at) VALUES (?,?,?,?,?,?) ON CONFLICT(teacher_id,ou) DO UPDATE SET name=excluded.name,code=excluded.code,role=excluded.role,synced_at=excluded.synced_at")
          .bind(me.id, ou, c.name||null, c.code||null, c.role||null, t));
        if (Array.isArray(c.classlist)) {
          st.push(db.prepare("DELETE FROM roster WHERE ou=?").bind(ou));
          for (const s of c.classlist.slice(0, 3000))
            st.push(db.prepare("INSERT OR REPLACE INTO roster (ou,user_id,name,email,username,org_id,role,synced_at) VALUES (?,?,?,?,?,?,?,?)")
              .bind(ou, String(s.id ?? ""), s.name||null, String(s.email||"").toLowerCase()||null, s.username||null, s.org_id ? String(s.org_id) : null, s.role||null, t));
        }
        if (Array.isArray(c.quizzes)) {
          const ours = new Set((await db.prepare("SELECT qi FROM bs_quizzes WHERE ou=? AND bs_password_is_ours=1").bind(ou).all()).results.map(x => String(x.qi)));
          st.push(db.prepare("DELETE FROM bs_quizzes WHERE ou=?").bind(ou));
          for (const q of c.quizzes.slice(0, 1000))
            st.push(db.prepare("INSERT OR REPLACE INTO bs_quizzes (ou,qi,name,active,start_date,end_date,due_date,bs_has_password,bs_password_is_ours,synced_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
              .bind(ou, String(q.qi), q.name||null, q.active?1:0, q.start||null, q.end||null, q.due||null, q.has_password?1:0, ours.has(String(q.qi)) && q.has_password ? 1 : 0, t));
        }
      }
      for (let i = 0; i < st.length; i += 90) await db.batch(st.slice(i, i + 90));
      // The Sync script only sends courses where the teacher is instructor/TA, so any course here
      // proves they are staff: verify them automatically. No email, no invite, no admin step.
      if (me.id !== "admin" && courses.length) await db.prepare("UPDATE teachers SET verified=1 WHERE id=?").bind(me.id).run();
      return json(await bsState(courses.map(c => c.ou)));
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
      if (!(await inCourse(ou))) return json({ error:"Sync this course from Brightspace first." }, 403);
      const ex = await db.prepare("SELECT quiz_id,password FROM quizzes WHERE qi=?").bind(qi).first();
      if (body.on) {
        await db.prepare("DELETE FROM pending_clear WHERE ou=? AND qi=?").bind(ou, qi).run();
        if (ex) { await db.prepare("UPDATE quizzes SET ou=?, lock_id=? WHERE qi=?").bind(ou, `${ou}-${qi}`, qi).run(); return json({ ou, qi, on:true, password: ex.password }); }
        const bq = await db.prepare("SELECT name FROM bs_quizzes WHERE ou=? AND qi=?").bind(ou, qi).first();
        const password = "LQ-" + rid(8);
        await db.prepare("INSERT INTO quizzes (quiz_id,title,url,password,created_at,qi,teacher_id,lock_id,ou) VALUES (?,?,?,?,?,?,?,?,?)")
          .bind(rid(8), bq?.name||null, null, password, now(), qi, me.id, `${ou}-${qi}`, ou).run();
        return json({ ou, qi, on:true, password });
      }
      if (ex) {
        await db.prepare("INSERT OR REPLACE INTO pending_clear (ou,qi,password) VALUES (?,?,?)").bind(ou, qi, ex.password).run();
        await db.prepare("DELETE FROM quizzes WHERE qi=?").bind(qi).run();
      }
      return json({ ou, qi, on:false, clear: ex ? ex.password : null });
    }
    // Turn the live access gate on/off for a quiz. While on, the Sync tab hides the quiz from everyone
    // and admits only students LOCKqz is actively locking. Requires the course to be synced + protected.
    if (p === "/gate" && request.method === "POST") {
      const ou = String(body.ou||""), qi = String(body.qi||"");
      if (!/^\d+$/.test(ou) || !/^\d+$/.test(qi)) return json({ error:"bad quiz" }, 400);
      if (!(await inCourse(ou))) return json({ error:"Sync this course from Brightspace first." }, 403);
      const r = await db.prepare("UPDATE quizzes SET gated=? WHERE qi=?").bind(body.on?1:0, qi).run();
      if (!r.meta.changes) return json({ error:"Protect this quiz first." }, 400);
      return json({ ou, qi, gated: !!body.on });
    }
    if (p === "/bs") {
      const cs = (await db.prepare("SELECT ou,name,code,role,synced_at FROM teacher_courses WHERE teacher_id=? ORDER BY name").bind(me.id).all()).results;
      if (!cs.length) return json({ courses: [] });
      const ous = cs.map(c => c.ou), ph = ous.map(()=>"?").join(",");
      const roster = (await db.prepare(`SELECT ou,user_id,name,email,username,role FROM roster WHERE ou IN (${ph}) ORDER BY name`).bind(...ous).all()).results;
      const qz = (await db.prepare(`SELECT b.ou,b.qi,b.name,b.active,b.start_date,b.end_date,b.due_date,b.bs_has_password,b.bs_password_is_ours,q.password,q.lock_id,q.gated FROM bs_quizzes b LEFT JOIN quizzes q ON q.qi=b.qi WHERE b.ou IN (${ph}) ORDER BY b.name`).bind(...ous).all()).results;
      const devs = (await db.prepare(`SELECT device_id,lower(student) AS who,platform,version,last_seen FROM devices WHERE lower(student) IN (SELECT lower(email) FROM roster WHERE ou IN (${ph})) OR lower(student) IN (SELECT lower(name) FROM roster WHERE ou IN (${ph}))`).bind(...ous, ...ous).all()).results;
      const by = {}; devs.forEach(d => { (by[d.who] = by[d.who] || []).push(d); });
      return json({ courses: cs.map(c => ({ ...c,
        students: roster.filter(r => r.ou === c.ou && /learner|student/i.test(r.role||"")).map(r => {
          const d = by[(r.email||"").toLowerCase()] || by[(r.name||"").toLowerCase()] || [];
          return { name:r.name, email:r.email, installed: d.length > 0, platform: d[0]?.platform||null, last_seen: d[0]?.last_seen||null }; }),
        quizzes: qz.filter(q => q.ou === c.ou) })) });
    }

    // Which lock ids (events.quiz_id = "<ou>-<qi>") belong to the caller?
    async function scope(col) {
      if (me.admin) return { sql:"1=1", args:[] };
      const qs = (await db.prepare("SELECT lock_id,qi FROM quizzes WHERE teacher_id=?").bind(me.id).all()).results;
      const cs = (await db.prepare("SELECT ou FROM courses WHERE teacher_id=?").bind(me.id).all()).results;
      const parts = [], args = [];
      qs.forEach(q => { if (q.lock_id) { parts.push(`${col}=?`); args.push(q.lock_id); } if (q.qi) { parts.push(`${col} LIKE ?`); args.push(`%-${q.qi}`); } });
      cs.forEach(c => { parts.push(`${col} LIKE ?`); args.push(`${c.ou}-%`); });
      const tc = (await db.prepare("SELECT ou FROM teacher_courses WHERE teacher_id=?").bind(me.id).all()).results;
      tc.forEach(c => { parts.push(`${col} LIKE ?`); args.push(`${c.ou}-%`); });
      return parts.length ? { sql:`(${parts.join(" OR ")})`, args } : { sql:"0", args:[] };
    }

    if (p === "/roster") {
      const s = await scope("e.quiz_id");
      const r = me.admin
        ? await db.prepare("SELECT device_id,student,platform,version,installed_at,last_seen FROM devices ORDER BY last_seen DESC").all()
        : await db.prepare(`SELECT DISTINCT d.device_id,d.student,d.platform,d.version,d.installed_at,d.last_seen FROM devices d JOIN events e ON e.device_id=d.device_id WHERE ${s.sql} ORDER BY d.last_seen DESC`).bind(...s.args).all();
      return json({ devices: r.results });
    }
    if (p === "/sessions") {
      const quiz = url.searchParams.get("quiz");
      const s = await scope("quiz_id");
      const r = await db.prepare(`SELECT device_id,student,quiz_id,event,detail,ts FROM events WHERE ${s.sql} AND (? IS NULL OR quiz_id=? OR quiz_id LIKE ?) ORDER BY ts DESC LIMIT 500`)
        .bind(...s.args, quiz, quiz, quiz ? `${quiz}-%` : "\u0000").all();
      return json({ events: r.results });
    }
    if (p === "/live") {
      const quiz = url.searchParams.get("quiz");
      if (!quiz) return json({ error: "quiz id required" }, 400);
      const like = `${quiz}-%`;
      const s = await scope("l.quiz_id"), s2 = await scope("e.quiz_id");
      const STALE = 90000, nowMs = Date.now(), age = t => t ? (nowMs - Date.parse(t)) : null;
      const locks = (await db.prepare(`SELECT l.device_id,l.quiz_id,l.last_lock,l.helper_seen,l.ext_seen,l.signed,d.student,d.platform FROM locks l LEFT JOIN devices d ON d.device_id=l.device_id WHERE (l.quiz_id=? OR l.quiz_id LIKE ?) AND ${s.sql}`).bind(quiz, like, ...s.args).all()).results;
      const tamp = new Set(((await db.prepare("SELECT DISTINCT device_id FROM events WHERE (quiz_id=? OR quiz_id LIKE ?) AND event='tamper'").bind(quiz, like).all()).results).map(t=>t.device_id));
      const done = (await db.prepare(`SELECT DISTINCT e.device_id,d.student,d.platform FROM events e LEFT JOIN devices d ON d.device_id=e.device_id WHERE (e.quiz_id=? OR e.quiz_id LIKE ?) AND e.event IN ('unlock','auto_unlock') AND ${s2.sql}`).bind(quiz, like, ...s2.args).all()).results;
      const active = new Set(locks.map(l=>l.device_id));
      const rows = locks.map(l => {
        const a = age(l.last_lock), h = age(l.helper_seen), e = age(l.ext_seen);
        let status = "locked";
        if (tamp.has(l.device_id)) status = "tamper";
        else if (a !== null && a > STALE) {
          const helperDown = h === null || h > STALE, extDown = e === null || e > STALE;
          status = helperDown && !extDown ? "helper_killed" : (extDown && !helperDown ? "browser_closed" : "dark");
        }
        return { device_id:l.device_id, student:l.student||null, platform:l.platform||null, status, last_lock:l.last_lock, age_ms:a, verified: Number(l.signed) === 1 };
      });
      done.forEach(d => { if (!active.has(d.device_id)) rows.push({ device_id:d.device_id, student:d.student||null, platform:d.platform||null, status:"done" }); });
      // A student is admitted ONLY when LOCKqz is holding a fresh, device-signed lock (status "locked",
      // verified). The gate loop reads r.eligible + r.user_id to grant/revoke Brightspace special access.
      rows.forEach(r => { r.email = String(r.student||"").toLowerCase().includes("@") ? String(r.student).toLowerCase() : null; r.eligible = (r.status === "locked" && r.verified === true); });
      const em = [...new Set(rows.map(r => r.email).filter(Boolean))];
      if (em.length) {
        const nm = (await db.prepare(`SELECT lower(email) AS e, name, user_id FROM roster WHERE lower(email) IN (${em.map(()=>"?").join(",")})`).bind(...em).all()).results;
        const nameOf = Object.fromEntries(nm.map(x => [x.e, x.name]));
        const idOf = Object.fromEntries(nm.map(x => [x.e, x.user_id]));
        rows.forEach(r => { if (r.email) { r.user_id = idOf[r.email] || null; const n = nameOf[r.email]; if (n) r.student = n; } });
      }
      return json({ quiz, now: now(), stale_ms: STALE, rows });
    }

    return json({ error: "not found", path: p }, 404);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}
