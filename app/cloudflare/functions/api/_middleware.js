// Several schools on the Cloudflare site. Each school has its own D1 database and its own settings, so one
// school's classes, exams, students and payments are never in the same tables as another's (Brightspace numbers
// its courses and quizzes per school; two schools can use the same numbers). The API file is unchanged: this
// picks the school a request belongs to and hands the request to the API with that school's database.
// The same rules as app/server/schools.mjs (the plain server).
//
// Setting SCHOOLS (JSON): { "default": "usc", "schools": [ { "id": "usc", "name": "...",
//   "brightspace": ["brightspace.usc.edu"], "domains": ["usc.edu"], "env": { ... } }, ... ] }
// The default school uses the binding DB; every other school the binding DB_<ID> (DB_STATEU for "stateu").
// Without SCHOOLS the site is one school and this file does nothing.
import { onRequest as api } from "./[[route]].js";

const low = s => String(s || "").trim().toLowerCase();
const hostOf = u => { try { return new URL(String(u)).hostname.toLowerCase(); } catch { return ""; } };
const domainOf = e => { const m = /^[^@\s]+@([^@\s]+)$/.exec(low(e)); return m ? m[1] : ""; };
const ID = /^[a-z0-9][a-z0-9-]{0,30}$/;
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const sha = async s => hex(await crypto.subtle.digest("SHA-256", typeof s === "string" ? new TextEncoder().encode(s) : s));
const json = (o, status) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export function readSchools(text) {
  const cfg = typeof text === "string" ? JSON.parse(text) : text;
  const list = Array.isArray(cfg?.schools) ? cfg.schools : [];
  if (!list.length) throw new Error("schools: no school listed");
  const byId = new Map(), hosts = new Map(), domains = new Map();
  for (const s of list) {
    const id = low(s.id);
    if (!ID.test(id) || byId.has(id)) throw new Error("schools: bad or repeated id " + JSON.stringify(s.id));
    const bs = (s.brightspace || []).map(low).filter(Boolean), dm = (s.domains || []).map(low).filter(Boolean);
    if (!bs.length) throw new Error("schools: " + id + " has no Brightspace address");
    for (const h of bs) { if (hosts.has(h)) throw new Error("schools: " + h + " is listed for two schools"); hosts.set(h, id); }
    for (const d of dm) { if (domains.has(d)) throw new Error("schools: " + d + " is listed for two schools"); domains.set(d, id); }
    byId.set(id, { id, name: String(s.name || id), brightspace: bs, domains: dm, env: { ...(s.env || {}) } });
  }
  const def = low(cfg.default || list[0].id);
  if (!byId.has(def)) throw new Error("schools: default " + def + " is not listed");
  return { byId, default: def, hosts, domains };
}
// The email domain of a school also covers its subdomains (marshall.usc.edu -> usc.edu).
const byDomain = (domains, d) => { for (let x = d; x && x.includes("."); x = x.slice(x.indexOf(".") + 1)) if (domains.has(x)) return domains.get(x); return null; };

let parsed = { text: null, cfg: null };                 // the setting, read once per server process
const seen = new Map(), SEEN_MS = 300000, SEEN_MAX = 5000;   // directory answers kept a few minutes: fewer database reads
const EVERY = new Set(["/cron", "/pay/tick"]);          // the clock: every school does its own exam emails and renewals

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.SCHOOLS) return context.next();
  let cfg;
  try { if (parsed.text !== env.SCHOOLS) parsed = { text: env.SCHOOLS, cfg: readSchools(env.SCHOOLS) }; cfg = parsed.cfg; }
  catch (e) { return json({ error: "schools setting does not load", detail: String(e.message || e) }, 503); }
  if (request.method === "OPTIONS") return context.next();

  const dbOf = id => id === cfg.default ? env.DB : env["DB_" + id.toUpperCase().replace(/-/g, "_")];
  const envOf = s => ({ ...env, BS_HOSTS: s.brightspace.join(","), BS_URL: "https://" + s.brightspace[0], ...(s.domains[0] ? { GOOGLE_HD: s.domains[0] } : {}), ...s.env, DB: dbOf(s.id), SCHOOL: s.id });
  const book = env.DB;   // the directory lives in the first school's database (table who)
  const keyOf = async (kind, k) => kind === "device" ? String(k).slice(0, 200) : await sha(String(k));
  async function known(kind, k) {
    if (!k) return null;
    const key = kind + ":" + await keyOf(kind, k), hit = seen.get(key);
    if (hit && Date.now() - hit.at < SEEN_MS) return hit.school;
    let school = null;
    try { const r = await book.prepare("SELECT school FROM who WHERE kind=? AND k=?").bind(kind, key.slice(kind.length + 1)).first(); school = r && cfg.byId.has(r.school) ? r.school : null; } catch {}
    if (seen.size >= SEEN_MAX) seen.clear();
    seen.set(key, { school, at: Date.now() });
    return school;
  }
  async function learn(kind, k, school) {
    if (!k || !school) return;
    const kk = await keyOf(kind, k);
    if ((seen.get(kind + ":" + kk) || {}).school === school) return;   // already noted: no write
    try { await book.prepare("INSERT INTO who (kind,k,school,at) VALUES (?,?,?,datetime('now')) ON CONFLICT(kind,k) DO UPDATE SET school=excluded.school, at=excluded.at WHERE school IS NOT excluded.school").bind(kind, kk, school).run(); } catch {}
    seen.set(kind + ":" + kk, { school, at: Date.now() });
  }

  const url = new URL(request.url), path = url.pathname.replace(/^\/api/, "") || "/", headers = request.headers;
  // The body is read here once and handed on unchanged (the API reads it again from its own copy).
  const raw = request.method === "POST" || request.method === "PUT" ? await request.clone().arrayBuffer() : new ArrayBuffer(0);
  let body = {}; if (raw.byteLength && raw.byteLength <= 2000000) { try { const j = JSON.parse(new TextDecoder().decode(raw)); if (j && typeof j === "object") body = j; } catch {} }
  const fresh = () => new Request(request.url, { method: request.method, headers, body: raw.byteLength ? raw : undefined });
  const run = (s, req) => { const e = envOf(s); return e.DB ? api({ ...context, request: req, env: e }) : json({ error: "school not set up", school: s.id }, 503); };

  // A payment code (LQ… a professor's, LQS… a student's) belongs to the school that gave it out.
  const CODE = /\bLQS?[A-Z0-9]{5}\b/, codeIn = t => (CODE.exec(String(t || "").toUpperCase()) || [])[0] || "";
  async function schoolOfCode(code) {
    if (!code) return null;
    const k = await known("code", code); if (k) return k;
    for (const s of cfg.byId.values()) { const d = dbOf(s.id); if (!d) continue;
      try { if (await d.prepare("SELECT 1 AS x FROM pay_codes WHERE code=? UNION ALL SELECT 1 FROM pay_codes_students WHERE code=? LIMIT 1").bind(code, code).first()) { await learn("code", code, s.id); return s.id; } } catch {} }
    return null;
  }
  const mailIn = t => (String(t || "").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [])[0] || "";
  const schoolOfPayment = async x => (await schoolOfCode(codeIn(`${x?.note || ""} ${x?.subject || ""} ${x?.code || ""}`))) || byDomain(cfg.domains, domainOf(mailIn(x?.note))) || cfg.default;

  const named = low(headers.get("x-lockqz-school") || "");
  if (named && !cfg.byId.has(named)) return json({ error: "unknown school" }, 400);
  if (EVERY.has(path) && !named) {   // one call for all schools; with many schools the caller names each school in turn
    let first = null;
    for (const s of cfg.byId.values()) { const r = await run(s, fresh()); if (s.id === cfg.default || !first) first = r; }
    return first;
  }

  // Payment notices (the bank-mail script): each payment goes to the school its code belongs to; one without a
  // known code goes to the first school, where the admin sees it for review.
  if (path === "/pay/notify" && request.method === "POST" && !named) {
    const many = Array.isArray(body.payments), list = many ? body.payments.slice(0, 100) : [body];
    const where = []; for (const x of list) where.push(await schoolOfPayment(x));
    const ids = [...new Set(where)];
    if (ids.length <= 1) return run(cfg.byId.get(ids[0] || cfg.default), request);
    const results = new Array(list.length).fill(null);
    for (const id of ids) {
      const idx = where.map((w, i) => w === id ? i : -1).filter(i => i >= 0);
      const r = await run(cfg.byId.get(id), new Request(request.url, { method: "POST", headers, body: JSON.stringify({ ...(many ? body : {}), payments: idx.map(i => list[i]) }) }));
      if (r.status !== 200) return r;
      let j = null; try { j = await r.json(); } catch {}
      idx.forEach((i, n) => { results[i] = j && Array.isArray(j.results) ? j.results[n] ?? null : null; });
    }
    return json({ results }, 200);
  }

  // Which school is this request for? Most certain first.
  const dev = headers.get("x-lockqz-device") || (typeof body.device_id === "string" ? body.device_id : "");
  let school = null, by = "";
  if (named) { school = named; by = "named"; }
  if (!school) { const h = low(body.host) || hostOf(body.url);
    if (h) { const s = cfg.hosts.get(h); if (s) { school = s; by = "brightspace"; } else if (hostOf(body.url)) by = "other_school"; } }
  if (!school && !by) for (const [kind, v] of [["teacher", headers.get("x-lockqz-teacher")], ["sync", headers.get("x-lockqz-sync")]]) { const s = await known(kind, v); if (s) { school = s; by = kind; break; } }
  if (!school && !by) { const s = await known("device", dev); if (s) { school = s; by = "device"; } }
  if (!school && !by) {   // a payment code: Stripe's confirmation carries it, so do the pay pages
    const o = body?.data?.object || {}, c = codeIn(`${body.code || ""} ${url.searchParams.get("code") || ""} ${o.metadata?.code || ""} ${o.client_reference_id || ""}`);
    const sc = await schoolOfCode(c); if (sc) { school = sc; by = "code"; } }
  if (!school && !by) for (const e of [body.email, body.student, url.searchParams.get("email")]) { const s = byDomain(cfg.domains, domainOf(e)); if (s) { school = s; by = "email"; break; } }
  // A quiz at a Brightspace that is no school here: the computer's own school says so ("other school").
  if (!school && by === "other_school") school = await known("device", dev);
  if (!school) { school = cfg.default; by = by || "default"; }
  const s = cfg.byId.get(school), db = dbOf(school);
  if (!db) return json({ error: "school not set up", school }, 503);

  // Did this computer itself sign the request? (the key a school holds for it)
  const signedBy = async key => {
    const ts = headers.get("x-lockqz-time") || "", sig = low(headers.get("x-lockqz-sig") || "");
    if (!key || !/^\d{1,12}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig) || Math.abs(Date.now() / 1000 - Number(ts)) > 600) return false;
    const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(key)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const want = hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`POST\n/api${path}\n${ts}\n${await sha(raw)}`)));
    let diff = 0; for (let i = 0; i < 64; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
    return diff === 0;
  };
  const holds = async (id, cols = "1") => { const d = dbOf(id); if (!d) return null; try { return await d.prepare(`SELECT ${cols} FROM devices WHERE device_id=?`).bind(dev).first(); } catch { return null; } };
  // A computer that registered before LOCKqz knew its school is carried over, key and all, the first time one
  // of its requests names another school (same key, so its signatures still check). Only on its own signature.
  const cur = dev && by !== "device" ? await known("device", dev) : null;
  if (dev && by !== "device" && by !== "default" && by !== "other_school" && !(await holds(school))) {
    const from = cur && cur !== school ? cur : (school !== cfg.default ? cfg.default : null);
    const row = from ? await holds(from, "*") : null;
    if (row && row.device_key && await signedBy(row.device_key)) {
      const cols = Object.keys(row);
      try { await db.prepare(`INSERT OR IGNORE INTO devices (${cols.map(c => '"' + c + '"').join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...cols.map(c => row[c])).run(); } catch {}
    }
  }

  const response = await run(s, request);
  // Remember where this computer / sign-in belongs, from what the school's API answered.
  if (response.status === 200 && by !== "other_school") {
    if (dev && by !== "device" && (by !== "default" || path === "/register") && cur !== school) {
      const old = cur ? await holds(cur, "device_key") : null;
      if ((old && old.device_key ? await signedBy(old.device_key) : true) && await holds(school)) await learn("device", dev, school);
    }
    if (/json/.test(response.headers.get("content-type") || "") && !headers.get("x-lockqz-device")) {
      let j = null; try { j = await response.clone().json(); } catch {}
      if (j && typeof j === "object") {
        if (typeof j.token === "string" && j.token.length >= 16) await learn("teacher", j.token, school);
        for (const k of ["sync_key", "key"]) if (path === "/synckey" && typeof j[k] === "string" && j[k].length >= 16) await learn("sync", j[k], school);
      }
    }
  }
  return response;
}
