// Email From an address on lockqz.com through Resend (14 Nov 2026). Real API (in-memory SQLite), fake Resend.
// Checks: the request Resend gets (From, To, subject, text, HTML, Reply-To, key in the header only); RESEND_TEST_TO
// limits it to the listed addresses; its own daily budget; GMAIL_BACKUP on / off when Resend refuses or is full;
// sign-in codes only with RESEND_CODES = "1"; lists go as Bcc in parts of 49; one retry on 429; no key = as before.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-resend-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js"), "utf8") + "\nexport { resendSend as __resendSend };\n");
const { onRequest, __resendSend } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
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

const rs = [], gmail = []; let status = 200, statuses = null, pauses = 0;
const RS = { RESEND_API_KEY: " re_test_key ", RESEND_FROM: "support@lockqz.example", RESEND_DAILY_MAX: "4", RESEND_PAUSE: async () => { pauses++; },
  RESEND_FETCH: async (url, init) => { const st = statuses && statuses.length ? statuses.shift() : status; rs.push({ url, init, body: JSON.parse(init.body), status: st });
    return new Response(st === 200 ? '{"id":"e1"}' : '{"message":"boom"}', { status: st }); } };
const base = { DB: db, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", MAIL_SINK: async m => { gmail.push(m); } };
let env = { ...base, ...RS }, ipN = 0;
const api = async (path, body) => { const res = await onRequest({ request: new Request("https://lockqz.pages.dev/api" + path, { method: "POST",
  headers: { "Content-Type": "application/json", "CF-Connecting-IP": `9.9.${++ipN}.1` }, body: JSON.stringify(body) }), env, waitUntil() {}, params: {} });
  let data = null; try { data = await res.json(); } catch {} return { status: res.status, data }; };
const sum = kind => Number(sqlite.prepare("SELECT COALESCE(SUM(n),0) AS n FROM mail_sent WHERE kind=?").get(kind).n);
const reset = () => { sqlite.exec("DELETE FROM mail_sent; DELETE FROM events"); rs.length = 0; gmail.length = 0; };

console.log("R1 support mail goes through Resend, From the lockqz.com address");
let r = await api("/support", { email: "bo@usc.edu", name: "Bo", message: "hello from the test" });
let q = rs.at(-1) || {};
check("API answered ok; one Resend call, none through Gmail", r.data?.ok === true && rs.length === 1 && gmail.length === 0, JSON.stringify(r) + ` rs=${rs.length} gmail=${gmail.length}`);
check("POST https://api.resend.com/emails with the key as a Bearer header (trimmed)", q.url === "https://api.resend.com/emails" && q.init?.method === "POST" && q.init?.headers?.Authorization === "Bearer re_test_key");
check("the key is nowhere in the body", !/re_test_key/.test(q.init?.body || ""));
check("From = LOCKqz <RESEND_FROM>, one To, Reply-To the sender, text + HTML", q.body?.from === "LOCKqz <support@lockqz.example>" && Array.isArray(q.body?.to) && q.body.to.length === 1
  && JSON.stringify(q.body?.reply_to) === '["bo@usc.edu"]' && /hello from the test/.test(q.body?.text || "") && typeof q.body?.html === "string" && q.body.html.length > 20 && !q.body.bcc, JSON.stringify(q.body).slice(0, 300));
check("links and logo stay on lockqz.com (same domain as the sender)", /https:\/\/lockqz\.com\/icon-white\.png/.test(q.body?.html || "") && !/lockqz\.pages\.dev/.test((q.body?.html || "") + (q.body?.text || "")), (q.body?.html || "").match(/https?:\/\/[a-z.]+/g)?.join(" "));
check("counted under Resend, not under Gmail", sum("resend") === 1 && sum("total") === 0, `resend=${sum("resend")} total=${sum("total")}`);

console.log("R2 sign-in codes stay on Gmail until RESEND_CODES = 1");
reset();
r = await api("/account", { op: "send", email: "ann@usc.edu" });
check("code sent through Gmail, no Resend call", r.data?.sent === true && rs.length === 0 && gmail.length === 1 && /^\d{6}$/.test(gmail[0].code || ""), JSON.stringify(r.data));
env = { ...base, ...RS, RESEND_CODES: "1" };
r = await api("/account", { op: "send", email: "bo@usc.edu" });
q = rs.at(-1) || {};
check("with RESEND_CODES = 1 the code goes through Resend", r.data?.sent === true && rs.length === 1 && gmail.length === 1 && JSON.stringify(q.body?.to) === '["bo@usc.edu"]'
  && /^Your LOCKqz code: \d{6}$/.test(q.body?.subject || "") && /Your LOCKqz sign-in code is \d{6}/.test(q.body?.text || ""), JSON.stringify(q.body).slice(0, 200));
const code = (q.body?.text || "").match(/\d{6}/)?.[0];
r = await api("/account", { op: "code", email: "bo@usc.edu", code });
check("that code signs the student in", r.status === 200 && !!r.data?.token, JSON.stringify(r.data));

console.log("R3 Resend refuses a send: Gmail carries it when GMAIL_BACKUP is on, nothing is sent when it is 0");
reset(); status = 500;
r = await api("/account", { op: "send", email: "cy@usc.edu" });
check("backup on: the code arrives through Gmail, failure logged", r.data?.sent === true && gmail.length === 1 && gmail[0].to === "cy@usc.edu" && !!sqlite.prepare("SELECT 1 FROM events WHERE event='resend_failed' AND detail LIKE 'resend 500%'").get(), JSON.stringify(r.data));
env = { ...base, ...RS, RESEND_CODES: "1", GMAIL_BACKUP: "0" };
r = await api("/account", { op: "send", email: "di@usc.edu" });
check("backup 0: send_failed, and nothing left through Gmail", r.status === 502 && r.data?.error === "send_failed" && gmail.length === 1, JSON.stringify(r));
r = await api("/support", { email: "ed@usc.edu", name: "Ed", message: "a longer support message" });
check("backup 0: other email is not sent from Gmail either", gmail.length === 1 && r.data?.ok !== true && r.status >= 500 && rs.at(-1)?.body?.reply_to?.[0] === "ed@usc.edu", JSON.stringify(r));
status = 200;

console.log("R4 the day's allowance (RESEND_DAILY_MAX = 4)");
reset(); env = { ...base, ...RS, RESEND_CODES: "1" };
for (const e of people.slice(0, 4)) await api("/account", { op: "send", email: e });
check("4 codes through Resend", rs.length === 4 && sum("resend") === 4 && gmail.length === 0, `rs=${rs.length} gmail=${gmail.length}`);
r = await api("/account", { op: "send", email: people[4] });
check("the 5th goes through Gmail while the backup is on", r.data?.sent === true && rs.length === 4 && gmail.length === 1, JSON.stringify(r.data));
env = { ...base, ...RS, RESEND_CODES: "1", GMAIL_BACKUP: "0" };
r = await api("/account", { op: "send", email: people[5] });
check("backup 0: the next is answered mail_busy, nothing sent anywhere", r.status === 503 && r.data?.error === "mail_busy" && rs.length === 4 && gmail.length === 1, JSON.stringify(r));

console.log("R5 RESEND_TEST_TO: only the listed addresses go through Resend");
reset(); env = { ...base, ...RS, RESEND_CODES: "1", GMAIL_BACKUP: "0", RESEND_TEST_TO: "Ann@usc.edu, gus@usc.edu" };
r = await api("/account", { op: "send", email: "ann@usc.edu" });
check("a listed address: Resend", r.data?.sent === true && rs.length === 1 && gmail.length === 0);
r = await api("/account", { op: "send", email: "hal@usc.edu" });
check("any other address: Gmail, exactly as before (GMAIL_BACKUP = 0 does not touch it)", r.data?.sent === true && rs.length === 1 && gmail.length === 1 && gmail[0].to === "hal@usc.edu");
r = await api("/support", { email: "hal@usc.edu", name: "Hal", message: "a message for the Gmail path" });
check("mail through Gmail still links through lockqz.pages.dev", gmail.length === 2 && /lockqz\.pages\.dev\/icon-white\.png/.test(gmail.at(-1).html || "") && !/https:\/\/lockqz\.com/.test(gmail.at(-1).html || ""), (gmail.at(-1).html || "").match(/https?:\/\/[a-z.]+/g)?.join(" "));

console.log("R6 no key or no From address = as before");
reset(); env = { ...base, ...RS, RESEND_API_KEY: "", RESEND_CODES: "1", GMAIL_BACKUP: "0" };
r = await api("/account", { op: "send", email: "ida@usc.edu" });
check("no key: Gmail sends the code", r.data?.sent === true && rs.length === 0 && gmail.length === 1);
env = { ...base, ...RS, RESEND_FROM: "", RESEND_CODES: "1", GMAIL_BACKUP: "0" };
r = await api("/support", { email: "jo@usc.edu", name: "Jo", message: "another support message" });
check("no RESEND_FROM: Gmail sends the support mail", r.data?.ok === true && rs.length === 0 && gmail.length === 2, JSON.stringify(r) + ` rs=${rs.length} gmail=${gmail.length}`);

console.log("R7 a list of 120 goes as 3 messages (49 + 49 + 22), all Bcc");
rs.length = 0; const list = Array.from({ length: 120 }, (_, i) => `s${i}@usc.edu`);
await __resendSend({ ...RS }, list, "Reminder", "text", { html: "<p>x</p>", replyTo: "prof@usc.edu" });
check("3 calls, Bcc 49/49/22, To = the From address only", rs.length === 3 && rs.map(c => c.body.bcc.length).join() === "49,49,22" && rs.every(c => JSON.stringify(c.body.to) === '["support@lockqz.example"]'), rs.map(c => c.body.bcc?.length).join());
check("every recipient exactly once; HTML + Reply-To kept", new Set(rs.flatMap(c => c.body.bcc)).size === 120 && rs.every(c => c.body.html === "<p>x</p>" && c.body.reply_to[0] === "prof@usc.edu"));

console.log("R8 429 is retried once; other errors are thrown with the status");
rs.length = 0; pauses = 0; statuses = [429, 200];
let ok = await __resendSend({ ...RS }, "x@usc.edu", "s", "t");
check("429 then 200: sent with one pause and two calls", ok === true && rs.length === 2 && pauses === 1);
statuses = [429, 429]; let threw = null; try { await __resendSend({ ...RS }, "x@usc.edu", "s", "t"); } catch (e) { threw = e; }
check("429 twice: thrown as 429", threw && threw.resend === 429);
statuses = null; status = 403; threw = null; try { await __resendSend({ ...RS }, "x@usc.edu", "s", "t"); } catch (e) { threw = e; } status = 200;
check("403: thrown with the status, the key not in the message", threw && threw.resend === 403 && !/re_test_key/.test(threw.message));

console.log("R9 settings");
const toml = readFileSync(join(CF, "wrangler.toml"), "utf8");
check("wrangler.toml: RESEND_FROM on lockqz.com; the key is not a var", /^RESEND_FROM = "[^"@]+@lockqz\.com"$/m.test(toml) && !/^RESEND_API_KEY\s*=/m.test(toml));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
