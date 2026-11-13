#!/usr/bin/env node
// LOCKqz API on a plain server: the same code Cloudflare runs (functions/api/[[route]].js), one SQLite
// file for the database, no per-day request allowance. Node 22.5+, no packages to install.
//   node server.mjs            settings come from the environment and from ./lockqz.env (KEY=value lines)
import http from "node:http";
import cluster from "node:cluster";
import os from "node:os";
import tls from "node:tls";
import { Duplex } from "node:stream";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { openDb, migrate, snapshot } from "./d1.mjs";
import { readSchools, openSchools } from "./schools.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function readEnvFile(file) {
  const out = {};
  if (!file || !existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2].trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

// [vars] of wrangler.toml: the public settings the Cloudflare deploy uses (prices, dates, addresses).
export function readWranglerVars(file) {
  const out = {};
  if (!existsSync(file)) return out;
  let on = false;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) { on = /^\s*\[vars\]\s*$/.test(line); continue; }
    const m = on && /^\s*([A-Z][A-Z0-9_]*)\s*=\s*"(.*)"\s*(#.*)?$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// The small part of Cloudflare's cache the API uses (match / put / delete, kept for max-age seconds).
export function memoryCache(max = 5000) {
  const m = new Map();
  const key = r => typeof r === "string" ? r : r.url;
  return {
    async match(r) { const k = key(r), e = m.get(k); if (!e) return undefined; if (e.until <= Date.now()) { m.delete(k); return undefined; } return new Response(e.body, { headers: e.headers }); },
    async put(r, res) { const age = /max-age=(\d+)/.exec(res.headers.get("Cache-Control") || ""); if (!age) return;
      if (m.size >= max) m.delete(m.keys().next().value);
      m.set(key(r), { body: await res.text(), headers: [...res.headers], until: Date.now() + Number(age[1]) * 1000 }); },
    async delete(r) { return m.delete(key(r)); },
  };
}

// The email connection the API's own SMTP code writes to (TLS to the mail host).
const mailOpen = env => () => new Promise((ok, bad) => {
  const s = tls.connect({ host: env.MAIL_HOST || "smtp.gmail.com", port: Number(env.MAIL_PORT || 465), servername: env.MAIL_HOST || "smtp.gmail.com" }, () => {
    const w = Duplex.toWeb(s); ok({ readable: w.readable, writable: w.writable, close: () => s.destroy() });
  });
  s.setTimeout(20000, () => s.destroy(new Error("smtp timeout")));
  s.once("error", bad);
});

let LOADS = 0;
export async function loadApi(cloudflareDir, workDir, build = {}) {
  // The API file is an ES module inside a CommonJS package: run a copy named .mjs.
  let src = readFileSync(join(cloudflareDir, "functions", "api", "[[route]].js"), "utf8");
  if (build.version) src = src.replace('"__LQZ_VERSION__"', JSON.stringify(build.version));
  if (build.id) src = src.replace('"__LQZ_BUILD__"', JSON.stringify(build.id));
  if (build.brightspace) {   // the address "Open Brightspace" links to in this school's emails
    const was = 'BS_URL = "https://brightspace.usc.edu"';
    if (!src.includes(was)) throw new Error("the API file no longer names its Brightspace address the way this server expects");
    src = src.replace(was, "BS_URL = " + JSON.stringify(build.brightspace));
  }
  mkdirSync(workDir, { recursive: true });
  const f = join(workDir, "route-" + process.pid + "-" + Date.now() + "-" + (LOADS++) + ".mjs");
  writeFileSync(f, src);
  try { return (await import(pathToFileURL(f).href)).onRequest; } finally { try { unlinkSync(f); } catch {} }
}

// Where things are and what the settings say (wrangler.toml [vars] < lockqz.env < the environment < opts.env).
export function settings(opts = {}) {
  const cf = resolve(opts.cloudflareDir || join(HERE, "..", "cloudflare"));
  const fileEnv = readEnvFile(opts.envFile === undefined ? join(HERE, "lockqz.env") : opts.envFile);
  const env = { ...readWranglerVars(join(cf, "wrangler.toml")), ...pick(fileEnv), ...(opts.inheritEnv === false ? {} : pick(process.env)), ...(opts.env || {}) };
  const data = resolve(opts.dataDir || env.LOCKQZ_DATA || join(HERE, "data"));
  mkdirSync(data, { recursive: true });
  const schoolsFile = join(data, "schools.json");
  const multiCfg = opts.schools ? readSchools(opts.schools) : existsSync(schoolsFile) ? readSchools(schoolsFile) : null;
  return { cf, env, data, multiCfg };
}

// Bring every database up to date and close it again (done once, before several server processes start).
export function prepare(opts = {}) {
  const { cf, data, multiCfg } = settings(opts), applied = {};
  const files = multiCfg ? multiCfg.list.map(x => [x.id, join(data, "schools", x.id + ".db")]) : [["lockqz", opts.dbFile || join(data, "lockqz.db")]];
  if (multiCfg) mkdirSync(join(data, "schools"), { recursive: true });
  // The first time a server with one school gets a schools.json: its database becomes the default school's.
  const single = join(data, "lockqz.db"), first = multiCfg && join(data, "schools", multiCfg.default + ".db");
  if (multiCfg && !opts.dbFile && existsSync(single) && !existsSync(first)) {
    const d = openDb(single); try { d.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { d.close(); }
    renameSync(single, first); for (const x of ["-wal", "-shm"]) { try { rmSync(single + x); } catch {} }
    console.log(`the database is now school "${multiCfg.default}" (data/schools/${multiCfg.default}.db)`);
  }
  for (const [id, f] of files) { const d = openDb(f); try { applied[id] = migrate(d, cf); } finally { d.close(); } }
  return applied;
}

export async function start(opts = {}) {
  const { cf, env, data, multiCfg } = settings(opts);
  if (typeof env.MAIL_OPEN !== "function" && typeof env.MAIL_SINK !== "function") env.MAIL_OPEN = mailOpen(env);
  // This server answers for its own address: it never forwards the API to another LOCKqz host.
  if (env.NO_API_PROXY === undefined) env.NO_API_PROXY = "1";
  // Each school (and the one-school server) has its own cache; the API reaches it as caches.default.
  const scope = new AsyncLocalStorage(), ownCache = memoryCache();
  globalThis.caches = { get default() { return scope.getStore()?.cache || ownCache; } };
  let version = ""; try { version = readFileSync(join(cf, "..", "VERSION"), "utf8").trim(); } catch {}
  // Several schools: opts.schools, or a schools.json next to the data. Otherwise one school, one database.
  let db = null, applied = [], onRequest = null, multi = null;
  if (multiCfg) {
    multi = openSchools(multiCfg, { dataDir: data, cloudflareDir: cf, baseEnv: env, version,
      loadApi: s => loadApi(cf, join(data, "run"), { version, id: env.LOCKQZ_BUILD || "server", brightspace: String(s.env.BS_URL || "https://" + s.brightspace[0]) }) });
    await multi.ready;
    // every school's work runs with that school's own cache
    for (const s of multi.schools.values()) { const cache = memoryCache(), inner = s.onRequest; s.onRequest = c => scope.run({ cache }, () => inner(c)); }
    db = multi.schools.get(multiCfg.default).db; applied = multi.applied[multiCfg.default];
  } else {
    db = opts.db || openDb(opts.dbFile || join(data, "lockqz.db"), { profile: !!opts.profile });
    applied = migrate(db, cf);
    env.DB = db;
    onRequest = opts.onRequest || await loadApi(cf, join(data, "run"), { version, id: env.LOCKQZ_BUILD || "server" });
  }
  const trustProxy = String(env.TRUST_PROXY ?? "1") === "1";   // behind Cloudflare (Tunnel): its CF-Connecting-IP is the student's address
  const maxBody = Number(env.MAX_BODY || 6 * 1024 * 1024);
  const counters = { started: Date.now(), requests: 0, errors: 0, busy: 0, bySchool: {} };
  const pending = new Set();

  const allDbs = () => multi ? [...multi.schools.values()].map(x => x.db) : [db];
  const hasSecret = e => !!String(e.ROT_SECRET || e.TEACHER_KEY || "").trim();
  const unset = multi ? ![...multi.schools.values()].every(x => hasSecret(x.env)) : !hasSecret(env);
  const server = http.createServer(async (req, res) => {
    counters.requests++;
    try {
      const path = (req.url || "/").split("?")[0];
      if (path === "/healthz") {
        let ok = true; try { for (const d of allDbs()) d.sqlite.prepare("SELECT 1").get(); } catch { ok = false; }
        res.writeHead(ok ? 200 : 500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(JSON.stringify({ ok, configured: !unset, version, pid: process.pid, worker: Number(env.LOCKQZ_WORKER || 1), up_s: Math.round((Date.now() - counters.started) / 1000), requests: counters.requests, errors: counters.errors, db: db.stats, ...(multi ? { schools: Object.fromEntries([...multi.schools.values()].map(x => [x.id, { requests: counters.bySchool[x.id] || 0, written: x.db.stats.written }])) } : {}) }));
      }
      if (!path.startsWith("/api/") && path !== "/api") { res.writeHead(404, { "Content-Type": "application/json" }); return res.end('{"error":"not found"}'); }
      // Without its own secret the API would sign with a value anyone can read: it answers nothing until one is set.
      if (unset) { res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" }); return res.end('{"error":"not_configured"}'); }
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > maxBody) { res.writeHead(413, { "Content-Type": "application/json" }); return res.end('{"error":"too large"}'); } chunks.push(c); }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) { if (v !== undefined && k !== "content-length" && k !== "connection" && k !== "transfer-encoding") headers.set(k, Array.isArray(v) ? v.join(", ") : v); }
      if (!trustProxy || !headers.get("cf-connecting-ip")) headers.set("cf-connecting-ip", String(req.socket.remoteAddress || "?").replace(/^::ffff:/, ""));
      const host = String(env.PUBLIC_HOST || headers.get("host") || "localhost");
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const request = new Request("https://" + host + req.url, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
      const context = { request, env, waitUntil(p) { const q = Promise.resolve(p).catch(e => { counters.errors++; console.error("background:", e && e.message); }).finally(() => pending.delete(q)); pending.add(q); } };
      let out;
      if (multi) {
        const raw = hasBody ? Buffer.concat(chunks) : Buffer.alloc(0);
        let body = {}; if (raw.length) { try { body = JSON.parse(raw.toString("utf8")); } catch {} } if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
        const apiPath = path.replace(/^\/api/, "") || "/";
        const mk = () => new Request("https://" + host + req.url, { method: req.method, headers, body: hasBody ? raw : undefined });
        const r = await multi.handle(mk, apiPath, body, headers, req.method, { waitUntil: context.waitUntil }, raw);
        out = r.response;
        if (r.school && r.school !== "*") counters.bySchool[r.school] = (counters.bySchool[r.school] || 0) + 1;
      } else out = await onRequest(context);
      const h = {}; out.headers.forEach((v, k) => { h[k] = v; });
      if (multi && req.method === "OPTIONS" && h["access-control-allow-headers"]) h["access-control-allow-headers"] += ", X-LOCKqz-School";
      res.writeHead(out.status, h);
      res.end(Buffer.from(await out.arrayBuffer()));
    } catch (e) {
      counters.errors++;
      console.error(new Date().toISOString(), req.method, req.url, e && e.stack || e);
      if (!res.headersSent) res.writeHead(503, { "Content-Type": "application/json" });
      res.end('{"error":"server_busy"}');
    }
  });
  server.keepAliveTimeout = 65000; server.headersTimeout = 20000; server.requestTimeout = 60000;

  // A copy of the database every SNAPSHOT_MIN minutes (0 = off), the newest SNAPSHOT_KEEP kept.
  const snapDir = join(data, "snapshots"), every = Number(env.SNAPSHOT_MIN ?? 0), keep = Math.max(1, Number(env.SNAPSHOT_KEEP || 6));
  const takeSnapshot = () => {
    mkdirSync(snapDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-"), made = [];
    for (const [name, d] of multi ? [...multi.schools.values()].map(x => [x.id, x.db]) : [["lockqz", db]]) {
      const f = join(snapDir, name + "-" + stamp + ".db");
      snapshot(d, f); made.push(f);
      const all = readdirSync(snapDir).filter(n => n.startsWith(name + "-") && /-\d{4}-\d{2}-\d{2}T[\d-]+Z\.db$/.test(n) && n.slice(0, -(stamp.length + 4)) === name).sort();
      for (const old of all.slice(0, Math.max(0, all.length - keep))) { try { unlinkSync(join(snapDir, old)); } catch {} }
    }
    return multi ? made : made[0];
  };
  // With several server processes only the first one makes the copies.
  const timer = every > 0 && String(env.LOCKQZ_WORKER || "1") === "1" ? setInterval(() => { try { takeSnapshot(); } catch (e) { console.error("snapshot:", e.message); } }, every * 60000) : null;
  if (timer) timer.unref();

  const port = Number(opts.port ?? env.PORT ?? 8787), bind = opts.host || env.BIND || "127.0.0.1";
  await new Promise((ok, bad) => { server.once("error", bad); server.listen(port, bind, ok); });
  const close = async () => { if (timer) clearInterval(timer); const shut = new Promise(r => server.close(r)); server.closeIdleConnections?.(); const hard = setTimeout(() => server.closeAllConnections?.(), 3000); await shut; clearTimeout(hard); await Promise.allSettled([...pending]); if (multi) multi.close(); else if (!opts.db) db.close(); };
  return { server, db, env, port: server.address().port, applied, takeSnapshot, counters, close, multi };
}

// Only the settings the API itself reads are taken from the process environment (never PATH, HOME, ...),
// and never the hooks that exist for tests.
const OWN = ["PORT", "BIND", "PUBLIC_HOST", "TRUST_PROXY", "MAX_BODY", "LOCKQZ_DATA", "LOCKQZ_BUILD", "SNAPSHOT_MIN", "SNAPSHOT_KEEP", "WORKERS", "LOCKQZ_WORKER"];
const HOOK = /(_TEST$|^MAIL_SINK$|^MAIL_OPEN$|^SES_FETCH$|^DB$)/;
let API_NAMES = null;
function pick(e) {
  if (!API_NAMES) { API_NAMES = new Set(OWN);
    try { for (const m of readFileSync(join(HERE, "..", "cloudflare", "functions", "api", "[[route]].js"), "utf8").matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) API_NAMES.add(m[1]); } catch {} }
  const out = {};
  for (const [k, v] of Object.entries(e)) if (API_NAMES.has(k) && !HOOK.test(k)) out[k] = v;
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // WORKERS=n (or "auto" = one per processor): n server processes share the port and the database file, so
  // one slow request (a big class list) never holds up every student, and every processor is used.
  const w0 = settings().env.WORKERS, want = String(w0 || "1").toLowerCase() === "auto" ? Math.max(1, os.availableParallelism?.() || os.cpus().length) : Math.max(1, Math.min(64, Number(w0) || 1));
  if (cluster.isPrimary && want > 1) {
    const applied = prepare();
    const steps = Object.values(applied).reduce((a, x) => a + x.length, 0);
    console.log(`LOCKqz API: starting ${want} server processes` + (steps ? `, applied ${steps} database steps` : ""));
    let stopping = false; const born = new Map();
    const fork = id => { const w = cluster.fork({ LOCKQZ_WORKER: String(id) }); born.set(w.id, { id, at: Date.now() }); };
    for (let i = 1; i <= want; i++) fork(i);
    cluster.on("exit", (w, code) => { const b = born.get(w.id); born.delete(w.id); if (stopping || !b) return;
      console.error(`server process ${b.id} stopped (code ${code}); starting it again`);
      setTimeout(() => fork(b.id), Date.now() - b.at < 5000 ? 2000 : 100); });   // a process that dies at once is not restarted in a tight loop
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stopping = true; for (const w of Object.values(cluster.workers)) w.process.kill("SIGTERM"); setTimeout(() => process.exit(0), 4000).unref(); });
    // "systemctl reload lockqz-api" (after add-school.mjs, or a settings change): the settings are read again and
    // the server processes are replaced one at a time, each only once its replacement answers. No request is lost.
    let reloading = false;
    process.on("SIGHUP", async () => {
      if (reloading || stopping) return; reloading = true;
      try {
        try { prepare(); } catch (e) { console.error("reload: not done, the settings do not load: " + e.message); return; }
        for (const old of Object.values(cluster.workers)) {
          const b = born.get(old.id); if (!b) continue;
          born.delete(old.id);   // its exit is expected
          const w = cluster.fork({ LOCKQZ_WORKER: String(b.id) }); born.set(w.id, { id: b.id, at: Date.now() });
          const up = await new Promise(ok => { const t = setTimeout(() => ok(false), 60000); w.once("listening", () => { clearTimeout(t); ok(true); }); w.once("exit", () => { clearTimeout(t); ok(false); }); });
          if (!up) { born.set(old.id, b); console.error(`reload: server process ${b.id} did not come up again; the running one stays`); born.delete(w.id); try { w.process.kill("SIGTERM"); } catch {} return; }
          // The old process takes no new requests, finishes the ones it has, then stops (10 s at most).
          const gone = new Promise(ok => old.once("exit", ok)); try { old.disconnect(); } catch {}
          const t = setTimeout(() => { try { old.process.kill("SIGTERM"); } catch {} }, 10000); await gone; clearTimeout(t);
        }
        console.log("reload: done");
      } finally { reloading = false; }
    });
  } else {
    const s = await start();
    console.log(`LOCKqz API ${s.env.LOCKQZ_BUILD || ""} on ${s.server.address().address}:${s.port}` + (want > 1 ? ` (process ${s.env.LOCKQZ_WORKER})` : "") + (s.applied.length ? `, applied ${s.applied.length} database steps` : ""));
    if (String(s.env.REQUIRE_SIGNED || "") !== "1") console.log("warning: REQUIRE_SIGNED is not 1");
    if (!String(s.env.ROT_SECRET || s.env.TEACHER_KEY || "").trim()) console.log("warning: no ROT_SECRET / TEACHER_KEY in lockqz.env - the API answers 503 not_configured until one is set");
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await s.close(); process.exit(0); });
    // One server process: a reload is a clean stop; the service starts it again with the new settings.
    if (cluster.isPrimary) process.on("SIGHUP", async () => { await s.close(); process.exit(0); });
  }
}
