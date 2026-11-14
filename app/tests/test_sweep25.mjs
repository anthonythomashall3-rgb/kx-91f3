// Sweep 25: lockqz.com answers API calls itself (it is the same Pages production as the main site), so a call from
// a LOCKqz page or the professor extension is one request, not two, and every visitor is counted by their own
// address. The dashboard asks for its first screen in one round. Real API, in-memory SQLite.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-sweep25-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

function d1(sqlite) {
  return { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
    const s = { bind(...a) { args = a.map(x => (x === undefined ? null : typeof x === "boolean" ? Number(x) : x)); s._run = () => st.run(...args); return s; },
      first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
      run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }) };
    return s; }, async batch(sts) { for (const s of sts) s._run(); } };
}
function makeEnv(extra = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
  return { DB: d1(sqlite), TEACHER_KEY: "admin-test-key", ROT_SECRET: "rot", MAIL_USER: "x@gmail.com", MAIL_APP_PASSWORD: "pw", REQUIRE_SIGNED: "1",
    API_DIRECT: "lockqz.com, www.lockqz.com", ...extra };
}
// Every forward the API makes is recorded here instead of leaving the test.
const forwards = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => { forwards.push(String(u)); return new Response(JSON.stringify({ forwarded: true }), { status: 200, headers: { "Content-Type": "application/json" } }); };
const req = (host, path, { method = "GET", body = null, ip = "203.0.113.7" } = {}) =>
  new Request(`https://${host}/api${path}`, { method, headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: body ? JSON.stringify(body) : undefined });
const run = async (env, r) => { const res = await onRequest({ request: r, env }); let d = null; try { d = await res.json(); } catch {} return { status: res.status, d }; };

console.log("A. Which address answers by itself");
{ const env = makeEnv();
  forwards.length = 0;
  let r = await run(env, req("lockqz.com", "/version"));
  check("lockqz.com/api/version is answered here (no forward)", r.status === 200 && r.d && !r.d.forwarded && "version" in r.d && forwards.length === 0, JSON.stringify(r.d));
  r = await run(env, req("www.lockqz.com", "/version"));
  check("www.lockqz.com too", r.status === 200 && r.d && !r.d.forwarded && forwards.length === 0);
  r = await run(env, req("LOCKQZ.COM", "/version"));
  check("the host name is compared without case", r.d && !r.d.forwarded && forwards.length === 0);
  r = await run(env, req("lockqz.pages.dev", "/version"));
  check("the main site answers as before", r.d && !r.d.forwarded && forwards.length === 0);
  r = await run(env, req("professor.lockqz.com", "/version"));
  check("professor.lockqz.com (not named) still forwards to the main site", r.d && r.d.forwarded === true && forwards[0] === "https://lockqz.pages.dev/api/version", forwards.join());
  forwards.length = 0;
  r = await run(env, req("abc123.lockqz.pages.dev", "/version"));
  check("a preview address still forwards", r.d && r.d.forwarded === true && forwards.length === 1);
  forwards.length = 0;
  r = await run(env, req("evil-lockqz.com", "/version"));
  check("a look-alike host is not treated as LOCKqz's (answered as a plain host, nothing forwarded)", forwards.length === 0);
}
console.log("B. Only where the main site's secrets are");
for (const [name, strip] of [["ROT_SECRET", { ROT_SECRET: "" }], ["MAIL_USER", { MAIL_USER: undefined }], ["MAIL_APP_PASSWORD", { MAIL_APP_PASSWORD: "" }], ["REQUIRE_SIGNED", { REQUIRE_SIGNED: "0" }], ["API_DIRECT", { API_DIRECT: "" }]]) {
  forwards.length = 0;
  const r = await run(makeEnv(strip), req("lockqz.com", "/version"));
  check(`without ${name}: lockqz.com forwards to the main site`, r.d && r.d.forwarded === true && forwards.length === 1);
}
{ forwards.length = 0;
  const r = await run(makeEnv({ API_DIRECT: undefined }), req("lockqz.com", "/version"));
  check("setting absent: forwards (the old behaviour)", r.d && r.d.forwarded === true); }

console.log("C. Each visitor is counted by their own address");
{ const env = makeEnv(); forwards.length = 0;
  const bad = ip => run(env, req("lockqz.com", "/login", { method: "POST", body: { email: "nobody@usc.edu", password: "wrong-password" }, ip }));
  let codes = []; for (let i = 0; i < 6; i++) codes.push((await bad("198.51.100.1")).status);
  check("one visitor: 5 wrong passwords, then 'wait'", codes.slice(0, 5).every(c => c === 401) && codes[5] === 429, codes.join());
  const other = await bad("198.51.100.2");
  check("another visitor on lockqz.com is not held by the first one's tries", other.status === 401, String(other.status));
  check("nothing was forwarded", forwards.length === 0);
  // POST bodies reach the API when it answers directly.
  const s = await run(env, req("lockqz.com", "/pay/start", { method: "POST", body: { email: "not-an-email" } }));
  check("a POST body is read on lockqz.com (bad email refused by the API itself)", s.status === 400 && /email/.test(String(s.d && s.d.error)));
  const o = await onRequest({ request: new Request("https://lockqz.com/api/login", { method: "OPTIONS" }), env });
  check("CORS preflight on lockqz.com (the professor page calls it from professor.lockqz.com)", o.status === 204 && o.headers.get("Access-Control-Allow-Origin") === "*");
}
console.log("D. Settings and pages");
{ const toml = readFileSync(join(CF, "wrangler.toml"), "utf8");
  check('wrangler.toml: API_DIRECT = "lockqz.com,www.lockqz.com"', /^API_DIRECT = "lockqz\.com,www\.lockqz\.com"$/m.test(toml));
  check("wrangler.toml never names a pages.dev or professor host as direct", !/^API_DIRECT = .*(pages\.dev|professor)/m.test(toml));
  const dash = readFileSync(join(CF, "public", "dashboard.html"), "utf8");
  const boot = dash.slice(dash.indexOf("async function boot(){"), dash.indexOf("const loadAll"));
  check("dashboard: the first screen is asked for in one round (boot calls loadAll once, no separate /me first)", /await loadAll\(\)/.test(boot) && !/get\("\/me"\)/.test(boot) && /applyAll\(R\)/.test(boot));
  check("dashboard: refresh() uses the same loader", /async function refresh\(\)\{ applyAll\(await loadAll\(\)\); \}/.test(dash));
  check("dashboard: loadAll asks /me, /bs, /quizzes and the Sync key together", /const loadAll = \(\) => Promise\.all\(\[get\("\/me"\), get\("\/bs"\), get\("\/quizzes"\), SYNCKEY\?\{key:SYNCKEY\}:get\("\/synckey"\)\]\);/.test(dash));
}
console.log("E. Shared answers in the data center's cache");
{ const api = readFileSync(join(CF, "functions", "api", "[[route]].js"), "utf8");
  check("every cached answer sits under the secret tag (no cache address is built from the bare site address)",
    !/liveCacheReq\(url\.origin|liveBust\(url\.origin|\$\{url\.origin\}\/__lqz_cache/.test(api) && (api.match(/await cacheBase\(\)/g) || []).length === 6);
  // The live answer is put in the cache under the tag, and found again there.
  const store = new Map(), seen = [];
  globalThis.caches = { default: { match: async r => { seen.push(r.url); const b = store.get(r.url); return b === undefined ? undefined : new Response(b); },
    put: async (r, res) => { seen.push(r.url); store.set(r.url, await res.text()); }, delete: async r => { seen.push(r.url); return store.delete(r.url); } } };
  const env = makeEnv({ LIVE_CACHE_MS: "8000" });
  const r = await onRequest({ request: new Request("https://lockqz.com/api/live?quiz=98765-12345", { headers: { "X-LOCKqz-Teacher": "admin-test-key" } }), env });
  const urls = seen.filter(u => /__lqz_cache\/live\//.test(u));
  check("the live answer is cached", r.status === 200 && urls.length >= 1, r.status + " " + seen.join());
  check("its cache address carries a 32-character tag from the secret, not just the quiz number", urls.every(u => /^https:\/\/lockqz\.com\/[0-9a-f]{32}\/__lqz_cache\/live\//.test(u)), urls.join());
  const env2 = makeEnv({ LIVE_CACHE_MS: "8000", ROT_SECRET: "another" }); seen.length = 0;
  await onRequest({ request: new Request("https://lockqz.com/api/live?quiz=98765-54321", { headers: { "X-LOCKqz-Teacher": "admin-test-key" } }), env: env2 });
  const urls2 = seen.filter(u => /__lqz_cache\/live\//.test(u));
  check("another secret gives another tag", urls2.length >= 1 && urls2[0].split("/")[3] !== urls[0].split("/")[3] && /^[0-9a-f]{32}$/.test(urls2[0].split("/")[3]), urls2.join());
  // An answer found in the shared cache keeps its own age (it is never served for a second full period).
  { const api2 = (await import(pathToFileURL(join(tmp, "route.mjs")).href + "?fresh=1")).onRequest;   // a new server process: nothing in memory
    const key = urls[0], body0 = store.get(key);
    let hdrs = { "Content-Type": "application/json", "X-LQ-At": String(Date.now() - 3000) };
    globalThis.caches.default.match = async r => store.has(r.url) ? new Response(store.get(r.url), { headers: hdrs }) : undefined;
    const envA = makeEnv({ LIVE_CACHE_MS: "8000" });
    const ask = e => api2({ request: new Request("https://lockqz.com/api/live?quiz=98765-12345", { headers: { "X-LOCKqz-Teacher": "admin-test-key" } }), env: e });
    store.set(key, JSON.stringify({ marker: "from-cache" }));
    let a = await (await ask(envA)).json();
    check("a 3-second-old shared answer is used", a.marker === "from-cache", JSON.stringify(a).slice(0, 80));
    const api3 = (await import(pathToFileURL(join(tmp, "route.mjs")).href + "?fresh=2")).onRequest;
    hdrs = { "Content-Type": "application/json", "X-LQ-At": String(Date.now() - 9000) };
    a = await (await api3({ request: new Request("https://lockqz.com/api/live?quiz=98765-12345", { headers: { "X-LOCKqz-Teacher": "admin-test-key" } }), env: makeEnv({ LIVE_CACHE_MS: "8000" }) })).json();
    check("a 9-second-old one is not: the answer is worked out again", a.marker === undefined && Array.isArray(a.rows), JSON.stringify(a).slice(0, 80));
    store.set(key, body0); }
  delete globalThis.caches;
}
console.log("F. A whole class behind one campus address");
{ const sqlite = new DatabaseSync(":memory:"); sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
  const env = { ...makeEnv(), DB: d1(sqlite) };
  const IP = "198.51.100.77", hourKey = kind => `${kind}|${IP}|${Math.floor(Date.now() / 3600000)}`;
  const n = kind => (sqlite.prepare("SELECT n FROM rl WHERE k=?").get(hourKey(kind)) || {}).n || 0;
  const open = (i, ip = IP) => run(env, req("lockqz.com", "/pay/start", { method: "POST", body: { email: `student${i}@usc.edu` }, ip }));
  let st = []; for (let i = 0; i < 60; i++) st.push((await open(i)).status);
  check("60 students open the pay page from one address in a few minutes: all answered", st.every(c => c === 200), [...new Set(st)].join());
  check("counted in ONE row for that address and hour", n("pay_open") === 60 && sqlite.prepare("SELECT COUNT(*) AS c FROM rl WHERE k LIKE 'pay_open|%'").get().c === 1);
  check("the pay page writes no rate-limit rows into the activity log any more", sqlite.prepare("SELECT COUNT(*) AS c FROM events WHERE event IN ('pay_start','pay_code_new','pay_stripe')").get().c === 0);
  sqlite.prepare("UPDATE rl SET n=2999 WHERE k=?").run(hourKey("pay_open"));
  const a = await open(1000), b = await open(1001), c = await open(1002);
  check("the 3,000th in the hour is answered, the 3,001st is asked to wait", a.status === 200 && b.status === 429 && c.status === 429, [a.status, b.status, c.status].join());
  check("a refused call writes nothing (the counter stays at 3,000)", n("pay_open") === 3000);
  check("another address is not held", (await open(1003, "198.51.100.78")).status === 200);
  const reg = (i, ip = IP) => run(env, req("lockqz.pages.dev", "/register", { method: "POST", body: { device_id: "mac-test-" + i, key: String(i).padStart(64, "a"), platform: "macOS", version: "0.6.23" }, ip }));
  st = []; for (let i = 0; i < 60; i++) st.push((await reg(i)).status);
  check("60 installs from one address in a few minutes: all registered", st.every(c => c === 200) && sqlite.prepare("SELECT COUNT(*) AS c FROM devices").get().c === 60, [...new Set(st)].join());
  sqlite.prepare("UPDATE rl SET n=3000 WHERE k=?").run(hourKey("reg"));
  const r2 = await reg(5000);
  check("past 3,000 installs in an hour from one address: asked to wait", r2.status === 429 && sqlite.prepare("SELECT COUNT(*) AS c FROM devices").get().c === 60, String(r2.status));
  check("an install from another address goes through", (await reg(5001, "198.51.100.79")).status === 200);
  // A database without the counter table yet (the code is live a moment before the table): nobody is blocked.
  sqlite.exec("DROP TABLE rl");
  check("no counter table yet: the pay page and installs still answer", (await open(2000)).status === 200 && (await reg(6000)).status === 200);
  const api = readFileSync(join(CF, "functions", "api", "[[route]].js"), "utf8"), schema = readFileSync(join(CF, "schema.sql"), "utf8"), mig = readFileSync(join(CF, "migrate_043_rate.sql"), "utf8");
  check("limits: installs 3,000, pay page 3,000, card checkouts 2,000, new pay codes 2,000, email codes 1,000 per address per hour",
    /const IP_REG = 3000, IP_PAY_OPEN = 3000, IP_PAY_CARD = 2000, IP_PAY_CODE = 2000, IP_CODES = 1000;/.test(api));
  check("the counter table is in schema.sql and in its own migration, with the index its clean-up uses",
    [schema, mig].every(t => /CREATE TABLE IF NOT EXISTS rl \(k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL\);/.test(t) && /CREATE INDEX IF NOT EXISTS idx_rl_at ON rl\(at\);/.test(t)));
  check("old counters are cleared with the other short-lived rows", /DELETE FROM rl WHERE at<\?/.test(api));
}
console.log("G. Email codes: a class on one address");
{ const api = readFileSync(join(CF, "functions", "api", "[[route]].js"), "utf8");
  check("the per-address ceiling for codes is IP_CODES; per computer and per recipient limits are unchanged",
    /Number\(c\.dh\) >= 5 \|\| Number\(c\.dd\) >= 15 \|\| Number\(c\.eh\) >= 3 \|\| Number\(c\.ed\) >= 5 \|\| Number\(c\.ih\) >= IP_CODES/.test(api)); }
globalThis.fetch = realFetch;
console.log(`\nSweep 25: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
