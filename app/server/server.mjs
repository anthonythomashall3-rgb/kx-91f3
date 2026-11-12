#!/usr/bin/env node
// LOCKqz API on a plain server: the same code Cloudflare runs (functions/api/[[route]].js), one SQLite
// file for the database, no per-day request allowance. Node 22.5+, no packages to install.
//   node server.mjs            settings come from the environment and from ./lockqz.env (KEY=value lines)
import http from "node:http";
import tls from "node:tls";
import { Duplex } from "node:stream";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDb, migrate, snapshot } from "./d1.mjs";

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

export async function loadApi(cloudflareDir, workDir, build = {}) {
  // The API file is an ES module inside a CommonJS package: run a copy named .mjs.
  let src = readFileSync(join(cloudflareDir, "functions", "api", "[[route]].js"), "utf8");
  if (build.version) src = src.replace('"__LQZ_VERSION__"', JSON.stringify(build.version));
  if (build.id) src = src.replace('"__LQZ_BUILD__"', JSON.stringify(build.id));
  mkdirSync(workDir, { recursive: true });
  const f = join(workDir, "route-" + process.pid + "-" + Date.now() + ".mjs");
  writeFileSync(f, src);
  try { return (await import(pathToFileURL(f).href)).onRequest; } finally { try { unlinkSync(f); } catch {} }
}

export async function start(opts = {}) {
  const cf = resolve(opts.cloudflareDir || join(HERE, "..", "cloudflare"));
  const fileEnv = readEnvFile(opts.envFile === undefined ? join(HERE, "lockqz.env") : opts.envFile);
  const env = { ...readWranglerVars(join(cf, "wrangler.toml")), ...pick(fileEnv), ...(opts.inheritEnv === false ? {} : pick(process.env)), ...(opts.env || {}) };
  const data = resolve(opts.dataDir || env.LOCKQZ_DATA || join(HERE, "data"));
  mkdirSync(data, { recursive: true });
  const db = opts.db || openDb(opts.dbFile || join(data, "lockqz.db"));
  const applied = migrate(db, cf);
  env.DB = db;
  if (typeof env.MAIL_OPEN !== "function" && typeof env.MAIL_SINK !== "function") env.MAIL_OPEN = mailOpen(env);
  // This server answers for its own address: it never forwards the API to another LOCKqz host.
  if (env.NO_API_PROXY === undefined) env.NO_API_PROXY = "1";
  if (!globalThis.caches) globalThis.caches = { default: memoryCache() };
  let version = ""; try { version = readFileSync(join(cf, "..", "VERSION"), "utf8").trim(); } catch {}
  const onRequest = opts.onRequest || await loadApi(cf, join(data, "run"), { version, id: env.LOCKQZ_BUILD || "server" });
  const trustProxy = String(env.TRUST_PROXY ?? "1") === "1";   // behind Cloudflare (Tunnel): its CF-Connecting-IP is the student's address
  const maxBody = Number(env.MAX_BODY || 6 * 1024 * 1024);
  const counters = { started: Date.now(), requests: 0, errors: 0, busy: 0 };
  const pending = new Set();

  const server = http.createServer(async (req, res) => {
    counters.requests++;
    try {
      const path = (req.url || "/").split("?")[0];
      if (path === "/healthz") {
        let ok = true; try { db.sqlite.prepare("SELECT 1").get(); } catch { ok = false; }
        res.writeHead(ok ? 200 : 500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(JSON.stringify({ ok, version, up_s: Math.round((Date.now() - counters.started) / 1000), requests: counters.requests, errors: counters.errors, db: db.stats }));
      }
      if (!path.startsWith("/api/") && path !== "/api") { res.writeHead(404, { "Content-Type": "application/json" }); return res.end('{"error":"not found"}'); }
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > maxBody) { res.writeHead(413, { "Content-Type": "application/json" }); return res.end('{"error":"too large"}'); } chunks.push(c); }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) { if (v !== undefined && k !== "content-length" && k !== "connection" && k !== "transfer-encoding") headers.set(k, Array.isArray(v) ? v.join(", ") : v); }
      if (!trustProxy || !headers.get("cf-connecting-ip")) headers.set("cf-connecting-ip", String(req.socket.remoteAddress || "?").replace(/^::ffff:/, ""));
      const host = String(env.PUBLIC_HOST || headers.get("host") || "localhost");
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const request = new Request("https://" + host + req.url, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
      const context = { request, env, waitUntil(p) { const q = Promise.resolve(p).catch(e => { counters.errors++; console.error("background:", e && e.message); }).finally(() => pending.delete(q)); pending.add(q); } };
      const out = await onRequest(context);
      const h = {}; out.headers.forEach((v, k) => { h[k] = v; });
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
    const f = join(snapDir, "lockqz-" + new Date().toISOString().replace(/[:.]/g, "-") + ".db");
    snapshot(db, f);
    const all = readdirSync(snapDir).filter(n => /^lockqz-.*\.db$/.test(n)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - keep))) { try { unlinkSync(join(snapDir, old)); } catch {} }
    return f;
  };
  const timer = every > 0 ? setInterval(() => { try { takeSnapshot(); } catch (e) { console.error("snapshot:", e.message); } }, every * 60000) : null;
  if (timer) timer.unref();

  const port = Number(opts.port ?? env.PORT ?? 8787), bind = opts.host || env.BIND || "127.0.0.1";
  await new Promise((ok, bad) => { server.once("error", bad); server.listen(port, bind, ok); });
  const close = async () => { if (timer) clearInterval(timer); const shut = new Promise(r => server.close(r)); server.closeIdleConnections?.(); const hard = setTimeout(() => server.closeAllConnections?.(), 3000); await shut; clearTimeout(hard); await Promise.allSettled([...pending]); if (!opts.db) db.close(); };
  return { server, db, env, port: server.address().port, applied, takeSnapshot, counters, close };
}

// Only the settings the API itself reads are taken from the process environment (never PATH, HOME, ...),
// and never the hooks that exist for tests.
const OWN = ["PORT", "BIND", "PUBLIC_HOST", "TRUST_PROXY", "MAX_BODY", "LOCKQZ_DATA", "LOCKQZ_BUILD", "SNAPSHOT_MIN", "SNAPSHOT_KEEP"];
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
  const s = await start();
  console.log(`LOCKqz API ${s.env.LOCKQZ_BUILD || ""} on ${s.server.address().address}:${s.port}` + (s.applied.length ? `, applied ${s.applied.length} database steps` : ""));
  if (String(s.env.REQUIRE_SIGNED || "") !== "1") console.log("warning: REQUIRE_SIGNED is not 1");
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await s.close(); process.exit(0); });
}
