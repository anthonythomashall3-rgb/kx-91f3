// Outside watch of the live site (16 Nov 2026). Real API (in-memory SQLite).
// GET /api/watch answers only yes / no: database read, database write, LOCKqz's clock (the Gmail script's /cron
// call) fresh, last email went out. The Server watch workflow asks it and names what stopped.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-watch-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js"), "utf8"));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch {} }
let noWrite = false, noDb = false;
const db = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
  const boom = () => { if (noDb || (noWrite && /^\s*(INSERT|UPDATE|DELETE)/i.test(sql))) throw new Error("D1_ERROR: too many rows written"); };
  const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
    first: async () => { boom(); return st.get(...args) ?? null; }, all: async () => { boom(); return { results: st.all(...args) }; },
    run: async () => { boom(); return { meta: { changes: Number(st.run(...args).changes) } }; }, _run() { boom(); st.run(...args); } }; return o; },
  async batch(sts) { for (const s of sts) s._run(); } };
const env = { DB: db, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1" };
const get = async (path, e = env) => { const res = await onRequest({ request: new Request("https://lockqz.pages.dev/api" + path, { headers: { "CF-Connecting-IP": "8.8.8.8" } }), env: e, waitUntil() {}, params: {} });
  let data = null; try { data = await res.json(); } catch {} return { status: res.status, data, res }; };
const ago = min => new Date(Date.now() - min * 60000).toISOString();
const clock = o => { sqlite.exec("DELETE FROM sync_nudges WHERE ou='clock'");
  for (const [k, v] of Object.entries(o)) sqlite.prepare("INSERT INTO sync_nudges (ou,qi,at) VALUES ('clock',?,?)").run(k, v); };

console.log("W1 nothing has ever called: the clock is reported, the database is fine");
let r = await get("/watch");
check("answers 200 without a sign-in", r.status === 200);
check("database read and write yes, clock no, ok no", r.data.db === true && r.data.write === true && r.data.clock === false && r.data.ok === false, JSON.stringify(r.data));
check("only yes / no leaves (6 keys, all true or false)", Object.keys(r.data).sort().join() === "clock,db,mail,ok,pay,write" && Object.values(r.data).every(v => typeof v === "boolean"));
check("never kept by a cache", /no-store/.test(r.res.headers.get("Cache-Control") || ""));
check("the watch call itself is kept (one row)", sqlite.prepare("SELECT COUNT(*) n FROM sync_nudges WHERE ou='clock' AND qi='watch'").get().n === 1);

console.log("W2 the Gmail script's clock");
clock({ cron: ago(9), tick: ago(50) }); r = await get("/watch");
check("called 9 minutes ago: all good", r.data.ok === true && r.data.clock === true, JSON.stringify(r.data));
clock({ cron: ago(50) }); r = await get("/watch");
check("silent for 50 minutes: clock no, ok no", r.data.clock === false && r.data.ok === false);
r = await get("/watch", { ...env, WATCH_CLOCK_MIN: "120" });
check("WATCH_CLOCK_MIN widens the room", r.data.clock === true && r.data.ok === true);
await get("/watch"); await get("/watch");
check("asking again never adds rows", sqlite.prepare("SELECT COUNT(*) n FROM sync_nudges WHERE ou='clock'").get().n === 2);

console.log("W3 email");
clock({ cron: ago(1), mail_ok: ago(120), mail_fail: ago(30) }); r = await get("/watch");
check("the last email failed 30 minutes ago, none since: mail no, ok no", r.data.mail === false && r.data.ok === false);
clock({ cron: ago(1), mail_ok: ago(120), mail_fail: ago(5) }); r = await get("/watch");
check("a failure 5 minutes ago still has room for a retry", r.data.mail === true && r.data.ok === true);
clock({ cron: ago(1), mail_ok: ago(10), mail_fail: ago(30) }); r = await get("/watch");
check("an email went out after the failure: fine", r.data.mail === true && r.data.ok === true);
clock({ cron: ago(1), mail_fail: ago(4 * 1440) }); r = await get("/watch");
check("a failure from 4 days ago is not reported for ever", r.data.mail === true);
clock({ cron: ago(1), mail_fail: ago(60) }); r = await get("/watch");
check("a failure with no email ever sent is reported", r.data.mail === false);

console.log("W4 the database");
clock({ cron: ago(1) }); noWrite = true; r = await get("/watch"); noWrite = false;
check("writes refused (daily limit): write no, ok no, still answers 200", r.status === 200 && r.data.db === true && r.data.write === false && r.data.ok === false, JSON.stringify(r.data));
noDb = true; r = await get("/watch"); noDb = false;
check("database down: db no, write no, ok no, still answers 200", r.status === 200 && r.data.db === false && r.data.write === false && r.data.ok === false, JSON.stringify(r.data));

console.log("W4b a payment waiting for the admin");
const payRow = (txn, code, amount, matched, days = 0) => sqlite.prepare("INSERT INTO payments (txn,code,amount,via,payer,note,term,received_at,matched) VALUES (?,?,?,?,?,?,?,?,?)").run(txn, code, amount, "zelle", "P", "", "20263", ago(days * 1440), matched);
const PRICES = { ...env, STUDENT_TOTAL: "200", STUDENT_OTHER_TOTAL: "210", PROF_TOTAL: "6500", PROF_ZELLE_TOTAL: "6300", PROF_BANK_TOTAL: "6500" };
clock({ cron: ago(1) });
payRow("t1", "LQSAAAAA", 200, null); payRow("t2", null, 488, null); payRow("t3", null, 0, "review"); payRow("t4", null, 200, "void");
r = await get("/watch", PRICES);
check("credited, personal ($488), unreadable noise and voided rows are not waiting", r.data.pay === true && r.data.ok === true, JSON.stringify(r.data));
payRow("t5", null, 200, null); r = await get("/watch", PRICES);
check("a student price with no memo is waiting: pay no, ok no", r.data.pay === false && r.data.ok === false);
sqlite.exec("UPDATE payments SET code='LQSBBBBB' WHERE txn='t5'"); r = await get("/watch", PRICES);
check("assigned: fine again", r.data.pay === true && r.data.ok === true);
payRow("t6", "LQSCCCCC", 0, "review"); r = await get("/watch", PRICES);
check("a memo code held for review is waiting", r.data.pay === false);
sqlite.exec("UPDATE payments SET matched='void' WHERE txn='t6'"); r = await get("/watch", PRICES);
check("voided: fine again", r.data.pay === true);
payRow("t7", null, 6300, null); r = await get("/watch", PRICES);
check("a professor price with no memo is waiting", r.data.pay === false);
sqlite.exec("DELETE FROM payments WHERE txn='t7'"); payRow("t8", null, 200, null, 30); r = await get("/watch", PRICES);
check("older than 3 weeks is not reported for ever", r.data.pay === true);
sqlite.exec("DELETE FROM payments");

console.log("W5 the workflow asks it");
const wf = readFileSync(join(HERE, "..", "..", ".github", "workflows", "server-watch.yml"), "utf8");
check("asks lockqz.com/api/watch and both sites", wf.includes("https://lockqz.com/api/watch") && wf.includes("https://lockqz.com/ ") && wf.includes("https://professor.lockqz.com/ "));
check("names each of db, write, clock, mail, pay", ["db)", "write)", "clock)", "mail)", "pay)"].every(k => wf.includes(k)) && wf.includes("for k in db write clock mail pay"));
check("a part it has no words for still counts (ok is asked too)", wf.includes(`grep -q '"ok":true' watch.json`));
check("the same trouble is reported again only after 6 hours", wf.includes("21600") && wf.includes("actions/cache/restore@v4") && wf.includes("actions/cache/save@v4"));
check("still watches the plain server", wf.includes("https://server.lockqz.com/api/version"));
check("runs every 15 minutes with no permissions", /cron: "7,22,37,52 \* \* \* \*"/.test(wf) && wf.includes("permissions: {}"));

console.log("W6 16 Nov additions are served to the helpers");
r = await get("/blocklist");
const need = ["manus.ai", "ai21.com", "sambanova.ai", "flowgpt.com", "heck.ai", "fiscal.ai", "fintool.com", "formulabot.com", "sheetai.app", "shortcut.ai", "gauth.com", "luzia.com"];
const missing = need.filter(d => !r.data.domains.includes(d));
check(`all ${need.length} served`, missing.length === 0, missing.join(", "));
check("no entry twice", new Set(r.data.domains).size === r.data.domains.length);
check("every new entry is a plain lowercase host", need.every(d => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
