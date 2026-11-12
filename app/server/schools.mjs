// Several schools on one server: each school has its own database file and its own settings, so one school's
// classes, exams, students and payments are never in the same tables as another's (Brightspace numbers its
// courses and quizzes per school; two schools can use the same numbers). The API file itself is unchanged:
// this picks the school a request belongs to and hands the request to that school's copy of the API.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb, migrate } from "./d1.mjs";

const low = s => String(s || "").trim().toLowerCase();
const hash = s => createHash("sha256").update(String(s)).digest("hex");
const hostOf = u => { try { return new URL(String(u)).hostname.toLowerCase(); } catch { return ""; } };
const domainOf = e => { const m = /^[^@\s]+@([^@\s]+)$/.exec(low(e)); return m ? m[1] : ""; };
const ID = /^[a-z0-9][a-z0-9-]{0,30}$/;

// schools.json: { "default": "usc", "schools": [ { "id": "usc", "name": "...", "brightspace": ["host", ...],
//   "domains": ["usc.edu"], "env": { "GOOGLE_HD": "usc.edu", ... } }, ... ] }
export function readSchools(fileOrObject) {
  const cfg = typeof fileOrObject === "string" ? JSON.parse(readFileSync(fileOrObject, "utf8")) : fileOrObject;
  const list = Array.isArray(cfg?.schools) ? cfg.schools : [];
  if (!list.length) throw new Error("schools: no school listed");
  const seen = new Set(), hosts = new Map(), domains = new Map(), out = [];
  for (const s of list) {
    const id = low(s.id);
    if (!ID.test(id) || seen.has(id)) throw new Error("schools: bad or repeated id " + JSON.stringify(s.id));
    seen.add(id);
    const bs = (s.brightspace || []).map(low).filter(Boolean), dm = (s.domains || []).map(low).filter(Boolean);
    if (!bs.length) throw new Error("schools: " + id + " has no Brightspace address");
    for (const h of bs) { if (hosts.has(h)) throw new Error("schools: " + h + " is listed for two schools"); hosts.set(h, id); }
    for (const d of dm) { if (domains.has(d)) throw new Error("schools: " + d + " is listed for two schools"); domains.set(d, id); }
    out.push({ id, name: String(s.name || id), brightspace: bs, domains: dm, env: { ...(s.env || {}) } });
  }
  const def = low(cfg.default || out[0].id);
  if (!seen.has(def)) throw new Error("schools: default " + def + " is not listed");
  return { list: out, default: def, hosts, domains };
}

// The email domain of a school also covers its subdomains (marshall.usc.edu -> usc.edu).
const byDomain = (domains, d) => { for (let x = d; x && x.includes("."); x = x.slice(x.indexOf(".") + 1)) if (domains.has(x)) return domains.get(x); return null; };

export function openSchools(cfg, { dataDir, cloudflareDir, baseEnv, loadApi, version }) {
  const dir = join(dataDir, "schools"); mkdirSync(dir, { recursive: true });
  // The directory: which school a computer, a professor's sign-in or a Sync key belongs to. Hashes only.
  const book = openDb(join(dataDir, "directory.db")).sqlite;
  book.exec("CREATE TABLE IF NOT EXISTS who (kind TEXT NOT NULL, k TEXT NOT NULL, school TEXT NOT NULL, at TEXT, PRIMARY KEY (kind, k)) WITHOUT ROWID");
  const get = book.prepare("SELECT school FROM who WHERE kind=? AND k=?"), put = book.prepare("INSERT INTO who (kind,k,school,at) VALUES (?,?,?,datetime('now')) ON CONFLICT(kind,k) DO UPDATE SET school=excluded.school, at=excluded.at WHERE school IS NOT excluded.school");
  const known = (kind, k) => { if (!k) return null; const r = get.get(kind, kind === "device" ? String(k) : hash(k)); return r && schools.has(r.school) ? r.school : null; };
  const learn = (kind, k, school) => { if (k && school) put.run(kind, kind === "device" ? String(k).slice(0, 200) : hash(k), school); };

  const schools = new Map();
  const applied = {};
  for (const s of cfg.list) {
    const db = openDb(join(dir, s.id + ".db"));
    applied[s.id] = migrate(db, cloudflareDir);
    // The school's own Brightspace addresses and sign-in domain, unless its settings say otherwise.
    const env = { ...baseEnv, BS_HOSTS: s.brightspace.join(","), ...(s.domains[0] ? { GOOGLE_HD: s.domains[0] } : {}), ...s.env, DB: db, NO_API_PROXY: "1" };
    schools.set(s.id, { ...s, db, env, onRequest: null });
  }
  const ready = (async () => { for (const s of schools.values()) s.onRequest = await loadApi(s); })();

  // Which school is this request for? Most certain first.
  function pick(req, path, body, headers) {
    const named = low(headers.get("x-lockqz-school") || "");
    if (named) return schools.has(named) ? { school: named, by: "named" } : { error: "unknown school" };
    const bsHost = low(body.host) || hostOf(body.url);
    if (bsHost) { const s = cfg.hosts.get(bsHost); if (s) return { school: s, by: "brightspace" }; if (hostOf(body.url)) return { school: null, by: "other_school" }; }
    for (const [kind, v] of [["teacher", headers.get("x-lockqz-teacher")], ["sync", headers.get("x-lockqz-sync")]]) { const s = known(kind, v); if (s) return { school: s, by: kind }; }
    const dev = headers.get("x-lockqz-device") || (typeof body.device_id === "string" ? body.device_id : "");
    const s1 = known("device", dev); if (s1) return { school: s1, by: "device" };
    for (const e of [body.email, body.student]) { const s = byDomain(cfg.domains, domainOf(e)); if (s) return { school: s, by: "email" }; }
    return { school: cfg.default, by: "default" };
  }

  // A computer that registered before LOCKqz knew its school is carried over, key and all, the first time
  // one of its requests names another school (same key, so its signatures still check).
  function carry(dev, to, signed) {
    if (!dev) return;
    const T = schools.get(to).db.sqlite;
    if (T.prepare("SELECT 1 FROM devices WHERE device_id=?").get(dev)) return;
    for (const s of schools.values()) {
      if (s.id === to) continue;
      const row = s.db.sqlite.prepare("SELECT * FROM devices WHERE device_id=?").get(dev);
      if (!row) continue;
      // Only for the computer itself: the request must carry that computer's own signature.
      if (!row.device_key || !signed || !signed(String(row.device_key))) return;
      const cols = Object.keys(row);
      T.prepare(`INSERT OR IGNORE INTO devices (${cols.map(c => '"' + c + '"').join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map(c => row[c]));
      return;
    }
  }
  const signedBy = (headers, apiPath, raw) => key => {
    const ts = headers.get("x-lockqz-time") || "", sig = low(headers.get("x-lockqz-sig") || "");
    if (!/^\d{1,12}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig) || Math.abs(Date.now() / 1000 - Number(ts)) > 600) return false;
    const want = createHmac("sha256", key).update(`POST\n${apiPath}\n${ts}\n${createHash("sha256").update(raw).digest("hex")}`).digest("hex");
    return timingSafeEqual(Buffer.from(want), Buffer.from(sig));
  };

  const EVERY = new Set(["/cron", "/pay/tick"]);   // the clock: every school does its own exam emails and renewals
  async function handle(makeRequest, path, body, headers, method, ctx, raw = Buffer.alloc(0)) {
    await ready;
    if (EVERY.has(path)) {
      let first = null;
      for (const s of schools.values()) { const r = await s.onRequest({ ...ctx, request: makeRequest(), env: s.env }); if (s.id === cfg.default || !first) first = r; }
      return { response: first, school: "*", by: "every" };
    }
    const p = pick(null, path, body, headers);
    if (p.error) return { response: new Response(JSON.stringify({ error: p.error }), { status: 400, headers: { "Content-Type": "application/json" } }), school: null, by: "named" };
    if (!p.school) {   // a quiz at a Brightspace LOCKqz has no school for: the default school's own answer ("other school")
      const s = schools.get(cfg.default);
      return { response: await s.onRequest({ ...ctx, request: makeRequest(), env: s.env }), school: s.id, by: p.by };
    }
    const s = schools.get(p.school);
    const dev = headers.get("x-lockqz-device") || (typeof body.device_id === "string" ? body.device_id : "");
    if (dev && p.by !== "device" && p.by !== "default") carry(dev, s.id, signedBy(headers, "/api" + path, raw));
    const response = await s.onRequest({ ...ctx, request: makeRequest(), env: s.env });
    // Remember where this computer / sign-in belongs, from what the school's API answered.
    if (response.status === 200) {
      // A computer is noted under a school only when that school holds it, and a computer already noted under
      // another school moves only on its own signature (the key that other school holds for it).
      if (dev && (p.by !== "default" || path === "/register")) {
        const cur = known("device", dev), here = () => !!s.db.sqlite.prepare("SELECT 1 FROM devices WHERE device_id=?").get(dev);
        if (cur !== s.id) {
          const old = cur ? schools.get(cur).db.sqlite.prepare("SELECT device_key FROM devices WHERE device_id=?").get(dev) : null;
          if (old && old.device_key ? signedBy(headers, "/api" + path, raw)(String(old.device_key)) && here() : here()) learn("device", dev, s.id);
        }
      }
      if (/json/.test(response.headers.get("content-type") || "") && !headers.get("x-lockqz-device")) {
        let j = null; try { j = await response.clone().json(); } catch {}
        if (j && typeof j === "object") {
          if (typeof j.token === "string" && j.token.length >= 16) learn("teacher", j.token, s.id);
          for (const k of ["sync_key", "key"]) if (path === "/synckey" && typeof j[k] === "string" && j[k].length >= 16) learn("sync", j[k], s.id);
        }
      }
    }
    return { response, school: s.id, by: p.by };
  }
  return { handle, schools, ready, applied, known, learn, close() { for (const s of schools.values()) s.db.close(); book.close(); } };
}
