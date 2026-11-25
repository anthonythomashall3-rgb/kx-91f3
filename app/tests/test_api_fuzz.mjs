// Every API path, every way of calling it (no sign-in, admin, professor, student computer; GET and POST) and every
// kind of odd body (none, broken JSON, null, a list, a number, a string, and every field the API reads set to a
// wrong type, a huge string or SQL / HTML text): the API answers each with its own answer, never a crash (500)
// and never a stack trace. Outside addresses are never called (fetch answers 503 here).
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const CF = join(HERE, "..", "cloudflare");
const SRC = readFileSync(join(CF, "functions", "api", "[[route]].js"), "utf8");
const tmp = mkdtempSync(join(tmpdir(), "lqz-fuzz-"));
writeFileSync(join(tmp, "route.mjs"), SRC);
const outside = [];
globalThis.fetch = async (u) => { outside.push(String(u && u.url || u)); return new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } }); };
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
function d1(sqlite) {
  const mk = sql => { const st = sqlite.prepare(sql); let args = [];
    const s = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return s; },
      first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
      run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } };
    return s; };
  return { prepare: mk, async batch(sts) { sqlite.exec("BEGIN"); try { for (const s of sts) s._run(); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; } return []; } };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch {} }
const run = (sql, ...a) => sqlite.prepare(sql).run(...a);
const env = { DB: d1(sqlite), TEACHER_KEY: "admin-key-fz", REQUIRE_SIGNED: "1", ADMIN_EMAIL: "admin@usc.edu", ROT_SECRET: "rot-fz", LIVE_CACHE_MS: "0", PAID_CACHE_MS: "0",
  MAIL_SINK: async () => true };
const BASE = "https://lockqz.test";
const sign = (key, path, ts, raw) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(raw).digest("hex")}`).digest("hex");
let ipn = 0;
async function call(path, raw, { teacher = null, dev = null, method = "POST", admin = false } = {}) {
  ipn = (ipn + 1) % 60000;
  const h = { "Content-Type": "application/json", "CF-Connecting-IP": `10.${(ipn >> 8) & 255}.${ipn & 255}.7` };
  if (teacher) h["X-LOCKqz-Teacher"] = teacher;
  if (admin) h["X-LOCKqz-Teacher"] = env.TEACHER_KEY;
  const body = method === "GET" ? undefined : (raw ?? "");
  if (dev) { const ts = String(Math.floor(Date.now() / 1000)); h["X-LOCKqz-Device"] = dev.id; h["X-LOCKqz-Time"] = ts; h["X-LOCKqz-Sig"] = sign(dev.key, "/api" + path.replace(/\?.*/, ""), ts, body || ""); }
  let res;
  try { res = await onRequest({ request: new Request(BASE + "/api" + path, { method, headers: h, body }), env }); }
  catch (e) { return { status: "threw", text: String(e && e.stack || e) }; }
  return { status: res.status, text: await res.text().catch(() => "") };
}
const J = o => JSON.stringify(o);

// The people and computers the calls come from.
const ADMIN = JSON.parse((await call("/signup", J({ email: "admin@usc.edu", password: "adminpass1", name: "Anthony Hall" }))).text || "{}").token;
const roster = [{ id: "8001", name: "Pat Prof", email: "p@usc.edu", role: "Instructor" }, { id: "9101", name: "Stu One", email: "s1@usc.edu", role: "Student" }];
await call("/sync", J({ courses: [{ ou: "700", name: "BUAD 306", classlist: roster, quizzes: [] }] }), { teacher: ADMIN });
const code = JSON.parse((await call("/invite", J({ email: "p@usc.edu", until: "2099-12-31" }), { teacher: ADMIN })).text || "{}").code;
const P = JSON.parse((await call("/signup", J({ email: "p@usc.edu", password: "profpass12", name: "Pat Prof", invite: code }))).text || "{}").token;
const iso = ms => new Date(ms).toISOString();
await call("/sync", J({ whoami: { id: "8001" }, courses: [{ ou: "700", name: "BUAD 306", classlist: roster, quizzes: [{ qi: "1", name: "Exam 1", active: true, start: iso(Date.now() - 3600000), end: iso(Date.now() + 86400000) }] }] }), { teacher: P });
const dev = { id: "mac-fz-1", key: randomBytes(32).toString("hex") };
await call("/register", J({ device_id: dev.id, key: dev.key, platform: "mac", version: readFileSync(join(HERE, "..", "VERSION"), "utf8").trim() }));
run("UPDATE devices SET student='s1@usc.edu', student_verified=1 WHERE device_id=?", dev.id);
check("set up: admin, professor and a student's computer", !!ADMIN && !!P);

// Every path the API answers (read from its own code) and every field it reads from a body.
const paths = [...new Set([...SRC.matchAll(/p === "(\/[^"]*)"/g)].map(m => m[1]))].sort();
const fields = [...new Set([...SRC.matchAll(/body\.([a-zA-Z_]+)/g)].map(m => m[1]))];
check(`${paths.length} paths and ${fields.length} body fields found in the API's code`, paths.length > 50 && fields.length > 40);
const odd = [null, 0, -1, 3.5, true, [], [1, "a", null], {}, { a: { b: 1 } }, "", "x".repeat(200000), "' OR 1=1 --", "<script>alert(1)</script>", "../../etc/passwd", "\u0000￿\ud83d"];
const bodies = ["", "{", "null", "[]", "0", "\"x\"", "{}", "[{}]"];
for (const v of odd) bodies.push(J(Object.fromEntries(fields.map(f => [f, v]))));
bodies.push(J(Object.fromEntries(fields.map((f, i) => [f, odd[i % odd.length]]))));

const who = [["no sign-in", {}], ["admin", { teacher: ADMIN }], ["admin key", { admin: true }], ["professor", { teacher: P }], ["student computer", { dev }]];
const crashes = [], traces = [];
let calls = 0;
for (const p of paths) {
  for (const [wn, w] of who) {
    for (const method of ["GET", "POST"]) {
      for (const b of (method === "GET" ? [null] : bodies)) {
        const q = method === "GET" ? p + "?quiz=700-1&ou=700&qi=1&email=s1%40usc.edu&code=x&token=y&id=1&term=20263&n=5" : p;
        const r = await call(q, b, { ...w, method });
        calls++;
        if (r.status === "threw" || r.status === 500) crashes.push(`${method} ${p} as ${wn}, body ${String(b).slice(0, 60)}: ${String(r.text).slice(0, 200)}`);
        else if (/\n\s+at |TypeError|ReferenceError|SyntaxError: Unexpected|Cannot read properties/.test(r.text || "")) traces.push(`${method} ${p} as ${wn} (${r.status}): ${String(r.text).slice(0, 200)}`);
      }
    }
  }
}
const uniq = a => [...new Set(a.map(x => x.replace(/, body .*?:/, ":")))];
check(`${calls} calls: none crashed (500)`, crashes.length === 0, uniq(crashes).slice(0, 12).join("\n      "));
check("no answer carries a program error or stack trace", traces.length === 0, uniq(traces).slice(0, 8).join("\n      "));
console.log(`  (outside addresses asked: ${outside.length}${outside.length ? ", e.g. " + outside.slice(0, 3).join(", ") : ""})`);
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
