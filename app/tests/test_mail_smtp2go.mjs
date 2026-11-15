// SMTP2GO as the second sender From lockqz.com (15 Nov 2026). Real API (in-memory SQLite), fake Resend + SMTP2GO.
// Checks: request shape (header key, sender, to, text/html, Reply-To header, key never in the body); Resend first,
// SMTP2GO when Resend's day is full or Resend refuses; a 200 answer with failed > 0 counts as a failure; its
// day and billing-month budgets; codes through SMTP2GO with RESEND_CODES = "1"; GMAIL_BACKUP = "0" never uses
// Gmail; lists go as Bcc in parts of 99; the billing month starts on SMTP2GO_CYCLE_DAY.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-s2g-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js"), "utf8") + "\nexport { smtp2goSend as __s2gSend, s2gCycle as __s2gCycle };\n");
const { onRequest, __s2gSend, __s2gCycle } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch {} }
const db = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
  const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
    first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
    run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } }; return o; },
  async batch(sts) { for (const s of sts) s._run(); } };
const people = ["ann", "bo", "cy", "di", "ed", "fay", "gus", "hal", "ida", "jo"].map(n => n + "@usc.edu");
for (const [i, e] of people.entries()) sqlite.prepare("INSERT INTO roster (ou,user_id,name,email) VALUES ('100',?,?,?)").run(String(i), "Student " + i, e);

const rs = [], s2 = [], gmail = []; let rStatus = 200, sReply = null;
const RS = { RESEND_API_KEY: "re_key", RESEND_FROM: "support@lockqz.example", RESEND_PAUSE: async () => {},
  RESEND_FETCH: async (url, init) => { rs.push(JSON.parse(init.body)); return new Response(rStatus === 200 ? '{"id":"e"}' : '{"message":"x"}', { status: rStatus }); } };
const S2 = { SMTP2GO_API_KEY: " s2g_key ", RESEND_FROM: "support@lockqz.example",
  SMTP2GO_FETCH: async (url, init) => { s2.push({ url, init, body: JSON.parse(init.body) });
    const [st, data] = sReply || [200, { succeeded: 1, failed: 0, failures: [] }]; return new Response(JSON.stringify({ request_id: "r", data }), { status: st }); } };
const base = { DB: db, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", MAIL_SINK: async m => { gmail.push(m); } };
let env, ipN = 0;
const api = async (path, body) => { const res = await onRequest({ request: new Request("https://lockqz.pages.dev/api" + path, { method: "POST",
  headers: { "Content-Type": "application/json", "CF-Connecting-IP": `8.8.${++ipN}.1` }, body: JSON.stringify(body) }), env, waitUntil() {}, params: {} });
  let data = null; try { data = await res.json(); } catch {} return { status: res.status, data }; };
const sum = (kind, ou = "_all") => Number(sqlite.prepare("SELECT COALESCE(SUM(n),0) AS n FROM mail_sent WHERE kind=? AND ou=?").get(kind, ou).n);
const reset = () => { sqlite.exec("DELETE FROM mail_sent; DELETE FROM events"); rs.length = 0; s2.length = 0; gmail.length = 0; rStatus = 200; sReply = null; };

console.log("S1 SMTP2GO alone: support mail From the lockqz.com address");
reset(); env = { ...base, ...S2 };
let r = await api("/support", { email: "bo@usc.edu", name: "Bo", message: "hello from the smtp2go test" });
let q = s2.at(-1) || {};
check("sent through SMTP2GO, not Gmail", r.data?.ok === true && s2.length === 1 && gmail.length === 0, JSON.stringify(r));
check("POST https://api.smtp2go.com/v3/email/send with X-Smtp2go-Api-Key (trimmed)", q.url === "https://api.smtp2go.com/v3/email/send" && q.init?.headers?.["X-Smtp2go-Api-Key"] === "s2g_key");
check("the key is nowhere in the body", !/s2g_key/.test(q.init?.body || ""));
check("sender = LOCKqz <RESEND_FROM>, one To, Reply-To header, text + HTML", q.body?.sender === "LOCKqz <support@lockqz.example>" && q.body?.to?.length === 1 && !q.body?.bcc
  && JSON.stringify(q.body?.custom_headers) === '[{"header":"Reply-To","value":"bo@usc.edu"}]' && /hello from the smtp2go test/.test(q.body?.text_body || "") && (q.body?.html_body || "").length > 20, JSON.stringify(q.body).slice(0, 300));
check("links and logo stay on lockqz.com", /https:\/\/lockqz\.com\/icon-white\.png/.test(q.body?.html_body || "") && !/lockqz\.pages\.dev/.test(q.body?.html_body || ""));
check("counted for the day and the billing month", sum("smtp2go") === 1 && sum("smtp2go", "_month") === 1);

console.log("S2 Resend first; SMTP2GO when Resend's day is full");
reset(); env = { ...base, ...RS, ...S2, RESEND_DAILY_MAX: "2" };   // automatic mail may use 80% of a day: 1 of 2
await api("/support", { email: "cy@usc.edu", name: "Cy", message: "first support message" });
await api("/support", { email: "di@usc.edu", name: "Di", message: "second support message" });
check("1st through Resend, 2nd through SMTP2GO, none through Gmail", rs.length === 1 && s2.length === 1 && gmail.length === 0, `rs=${rs.length} s2=${s2.length} gmail=${gmail.length}`);

console.log("S3 Resend refuses: SMTP2GO carries it");
reset(); env = { ...base, ...RS, ...S2, GMAIL_BACKUP: "0" }; rStatus = 500;
r = await api("/support", { email: "ed@usc.edu", name: "Ed", message: "resend is down today" });
check("delivered by SMTP2GO; resend_failed logged", r.data?.ok === true && rs.length === 1 && s2.length === 1 && gmail.length === 0 && !!sqlite.prepare("SELECT 1 FROM events WHERE event='resend_failed'").get(), JSON.stringify(r));

console.log("S4 SMTP2GO answers 200 with failed > 0: a failure");
reset(); env = { ...base, ...S2, GMAIL_BACKUP: "0" }; sReply = [200, { succeeded: 0, failed: 1, failures: ["blocked"] }];
r = await api("/support", { email: "fay@usc.edu", name: "Fay", message: "smtp2go says failed" });
check("not ok, nothing through Gmail, smtp2go_failed logged, nothing counted", r.data?.ok !== true && r.status >= 500 && gmail.length === 0 && !!sqlite.prepare("SELECT 1 FROM events WHERE event='smtp2go_failed'").get() && sum("smtp2go") === 0, JSON.stringify(r));
env = { ...base, ...S2 };
r = await api("/support", { email: "gus@usc.edu", name: "Gus", message: "smtp2go says failed again" });
check("with GMAIL_BACKUP on, Gmail carries it", r.data?.ok === true && gmail.length === 1);

console.log("S5 sign-in codes through SMTP2GO with RESEND_CODES = 1 (Resend off), and the month budget");
reset(); env = { ...base, ...S2, RESEND_CODES: "1", GMAIL_BACKUP: "0", SMTP2GO_MONTHLY_MAX: "2" };
r = await api("/account", { op: "send", email: "hal@usc.edu" });
q = s2.at(-1) || {};
check("code sent through SMTP2GO", r.data?.sent === true && s2.length === 1 && gmail.length === 0 && /^Your LOCKqz code: \d{6}$/.test(q.body?.subject || ""), JSON.stringify(r.data));
const code = (q.body?.text_body || "").match(/\d{6}/)?.[0];
r = await api("/account", { op: "code", email: "hal@usc.edu", code });
check("that code signs the student in", r.status === 200 && !!r.data?.token, JSON.stringify(r.data));
await api("/account", { op: "send", email: "ida@usc.edu" });
r = await api("/account", { op: "send", email: "jo@usc.edu" });
check("3rd code in a month of 2: mail_busy, nothing sent anywhere", r.status === 503 && r.data?.error === "mail_busy" && s2.length === 2 && gmail.length === 0, JSON.stringify(r));
env = { ...base, ...RS, ...S2, RESEND_CODES: "1", GMAIL_BACKUP: "0", SMTP2GO_MONTHLY_MAX: "2" };
r = await api("/account", { op: "send", email: "jo@usc.edu" });
check("with Resend on as well, Resend takes it", r.data?.sent === true && rs.length === 1 && s2.length === 2);

console.log("S6 RESEND_TEST_TO applies to SMTP2GO too");
reset(); env = { ...base, ...S2, RESEND_CODES: "1", RESEND_TEST_TO: "ann@usc.edu" };
await api("/account", { op: "send", email: "ann@usc.edu" });
await api("/account", { op: "send", email: "bo@usc.edu" });
check("listed address via SMTP2GO, the other via Gmail", s2.length === 1 && s2[0].body.to[0] === "ann@usc.edu" && gmail.length === 1 && gmail[0].to === "bo@usc.edu");

console.log("S7 a list of 250 goes as 3 messages (99 + 99 + 52), all Bcc");
s2.length = 0; const list = Array.from({ length: 250 }, (_, i) => `s${i}@usc.edu`);
await __s2gSend({ ...S2 }, list, "Reminder", "text", { html: "<p>x</p>", replyTo: "prof@usc.edu" });
check("Bcc 99/99/52, To = the From address only", s2.length === 3 && s2.map(c => c.body.bcc.length).join() === "99,99,52" && s2.every(c => JSON.stringify(c.body.to) === '["support@lockqz.example"]'));
check("every recipient exactly once", new Set(s2.flatMap(c => c.body.bcc)).size === 250);

console.log("S8 billing month");
const e15 = { SMTP2GO_CYCLE_DAY: "15" };
check("10 Nov -> month from 15 Oct", __s2gCycle(e15, Date.parse("2026-11-10T12:00:00Z")) === "2026-10-15");
check("20 Nov -> month from 15 Nov", __s2gCycle(e15, Date.parse("2026-11-20T12:00:00Z")) === "2026-11-15");
check("5 Jan -> month from 15 Dec of the year before", __s2gCycle(e15, Date.parse("2027-01-05T12:00:00Z")) === "2026-12-15");
check("default day 1", __s2gCycle({}, Date.parse("2026-11-20T12:00:00Z")) === "2026-11-01");
const toml = readFileSync(join(CF, "wrangler.toml"), "utf8");
check("wrangler.toml: no SMTP2GO key as a var", !/^SMTP2GO_API_KEY\s*=/m.test(toml));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
