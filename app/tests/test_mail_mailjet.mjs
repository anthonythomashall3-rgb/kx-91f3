// Mailjet as the third sender From lockqz.com (18 Nov 2026). Real API (in-memory SQLite), fake Resend + SMTP2GO + Mailjet.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-mj-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js"), "utf8") + "\nexport { mailjetSend as __mjSend };\n");
const { onRequest, __mjSend } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
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


const rs = [], s2 = [], mj = [], gmail = []; let rStatus = 200, sStatus = 200, mReply = null;
const RS = { RESEND_API_KEY: "re_key", RESEND_FROM: "support@lockqz.example", RESEND_PAUSE: async () => {},
  RESEND_FETCH: async (url, init) => { rs.push(JSON.parse(init.body)); return new Response(rStatus === 200 ? '{"id":"e"}' : '{"message":"x"}', { status: rStatus }); } };
const S2 = { SMTP2GO_API_KEY: "s2g_key", RESEND_FROM: "support@lockqz.example",
  SMTP2GO_FETCH: async (url, init) => { s2.push(JSON.parse(init.body)); return new Response(JSON.stringify({ data: { succeeded: sStatus === 200 ? 1 : 0, failed: 0, failures: [] } }), { status: sStatus }); } };
const MJ = { MAILJET_API_KEY: " mj_pub ", MAILJET_SECRET_KEY: " mj_sec ", RESEND_FROM: "support@lockqz.example",
  MAILJET_FETCH: async (url, init) => { const body = JSON.parse(init.body); mj.push({ url, init, body });
    const [st, data] = mReply || [200, { Messages: body.Messages.map(() => ({ Status: "success" })) }]; return new Response(JSON.stringify(data), { status: st }); } };
const base = { DB: db, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", MAIL_SINK: async m => { gmail.push(m); } };
let env, ipN = 0;
const api = async (path, body) => { const res = await onRequest({ request: new Request("https://lockqz.pages.dev/api" + path, { method: "POST",
  headers: { "Content-Type": "application/json", "CF-Connecting-IP": `8.9.${++ipN}.1` }, body: JSON.stringify(body) }), env, waitUntil() {}, params: {} });
  let data = null; try { data = await res.json(); } catch {} return { status: res.status, data }; };
const sum = (kind, ou = "_all") => Number(sqlite.prepare("SELECT COALESCE(SUM(n),0) AS n FROM mail_sent WHERE kind=? AND ou=?").get(kind, ou).n);
const reset = () => { sqlite.exec("DELETE FROM mail_sent; DELETE FROM events"); rs.length = 0; s2.length = 0; mj.length = 0; gmail.length = 0; rStatus = 200; sStatus = 200; mReply = null; };

console.log("M1 Mailjet alone: support mail From the lockqz.com address");
reset(); env = { ...base, ...MJ };
let r = await api("/support", { email: "bo@usc.edu", name: "Bo", message: "hello from the mailjet test" });
let q = mj.at(-1) || {}, m0 = q.body?.Messages?.[0] || {};
check("sent through Mailjet, not Gmail", r.data?.ok === true && mj.length === 1 && gmail.length === 0, JSON.stringify(r));
check("POST https://api.mailjet.com/v3.1/send with Basic key:secret (trimmed)", q.url === "https://api.mailjet.com/v3.1/send" && q.init?.headers?.Authorization === "Basic " + btoa("mj_pub:mj_sec"));
check("the keys are nowhere in the body", !/mj_pub|mj_sec/.test(q.init?.body || ""));
check("From = LOCKqz <RESEND_FROM>, one To, Reply-To, text + HTML", m0.From?.Email === "support@lockqz.example" && m0.From?.Name === "LOCKqz" && m0.To?.length === 1 && m0.ReplyTo?.Email === "bo@usc.edu"
  && /hello from the mailjet test/.test(m0.TextPart || "") && (m0.HTMLPart || "").length > 20, JSON.stringify(m0).slice(0, 300));
check("links and logo stay on lockqz.com", /https:\/\/lockqz\.com\/icon-white\.png/.test(m0.HTMLPart || "") && !/lockqz\.pages\.dev/.test(m0.HTMLPart || ""));
check("counted for the day and the month", sum("mailjet") === 1 && sum("mailjet", "_month") === 1);

console.log("M2 Resend, then SMTP2GO, then Mailjet as each day fills");
reset(); env = { ...base, ...RS, ...S2, ...MJ, RESEND_DAILY_MAX: "2", SMTP2GO_DAILY_MAX: "2", GMAIL_BACKUP: "0" };   // automatic mail: 80% of a day = 1 each
for (const n of ["cy", "di", "ed"]) await api("/support", { email: n + "@usc.edu", name: n, message: "support message from " + n });
check("1st Resend, 2nd SMTP2GO, 3rd Mailjet, none through Gmail", rs.length === 1 && s2.length === 1 && mj.length === 1 && gmail.length === 0, `rs=${rs.length} s2=${s2.length} mj=${mj.length} gmail=${gmail.length}`);

console.log("M3 Resend and SMTP2GO refuse: Mailjet carries it");
reset(); env = { ...base, ...RS, ...S2, ...MJ, GMAIL_BACKUP: "0" }; rStatus = 500; sStatus = 500;
r = await api("/support", { email: "fay@usc.edu", name: "Fay", message: "both others are down today" });
check("delivered by Mailjet; both failures logged", r.data?.ok === true && mj.length === 1 && gmail.length === 0 && !!sqlite.prepare("SELECT 1 FROM events WHERE event='resend_failed'").get() && !!sqlite.prepare("SELECT 1 FROM events WHERE event='smtp2go_failed'").get(), JSON.stringify(r));

console.log("M4 a 200 answer with an error status is a failure; Gmail carries it when GMAIL_BACKUP is on");
reset(); env = { ...base, ...MJ, GMAIL_BACKUP: "1" }; mReply = [200, { Messages: [{ Status: "error", Errors: [{ ErrorMessage: "sender not validated" }] }] }];
r = await api("/support", { email: "gus@usc.edu", name: "Gus", message: "mailjet says error inside 200" });
check("Gmail sent it; mailjet_failed logged with the reason; not counted", r.data?.ok === true && gmail.length === 1 && /sender not validated/.test(sqlite.prepare("SELECT detail FROM events WHERE event='mailjet_failed'").get()?.detail || "") && sum("mailjet") === 0, JSON.stringify(r));
reset(); env = { ...base, ...MJ, GMAIL_BACKUP: "0" }; mReply = [401, { ErrorMessage: "bad key" }];
r = await api("/support", { email: "gus@usc.edu", name: "Gus", message: "mailjet refuses and gmail is off" });
check("GMAIL_BACKUP = 0: nothing sent from Gmail", gmail.length === 0 && r.data?.ok !== true, JSON.stringify(r));

console.log("M5 sign-in codes through Mailjet with RESEND_CODES = 1, and the month budget");
reset(); env = { ...base, ...MJ, RESEND_CODES: "1", GMAIL_BACKUP: "0", MAILJET_MONTHLY_MAX: "2" };
r = await api("/account", { op: "send", email: "hal@usc.edu" });
m0 = mj.at(-1)?.body?.Messages?.[0] || {};
check("code sent through Mailjet", r.data?.sent === true && mj.length === 1 && gmail.length === 0 && /^Your LOCKqz code: \d{6}$/.test(m0.Subject || ""), JSON.stringify(r.data));
const code = (m0.TextPart || "").match(/\d{6}/)?.[0];
r = await api("/account", { op: "code", email: "hal@usc.edu", code });
check("that code signs the student in", r.status === 200 && !!r.data?.token, JSON.stringify(r.data));
await api("/account", { op: "send", email: "ida@usc.edu" });
r = await api("/account", { op: "send", email: "jo@usc.edu" });
check("3rd code in a month of 2: mail_busy, nothing sent anywhere", r.status === 503 && r.data?.error === "mail_busy" && mj.length === 2 && gmail.length === 0, JSON.stringify(r));
reset(); env = { ...base, ...RS, ...S2, ...MJ, RESEND_CODES: "1", RESEND_DAILY_MAX: "1", SMTP2GO_DAILY_MAX: "1", MAILJET_DAILY_MAX: "1" };
for (const n of ["ann", "bo", "cy", "di"]) await api("/account", { op: "send", email: n + "@usc.edu" });
check("four codes: Resend, SMTP2GO, Mailjet, then Gmail", rs.length === 1 && s2.length === 1 && mj.length === 1 && gmail.length === 1, `rs=${rs.length} s2=${s2.length} mj=${mj.length} gmail=${gmail.length}`);

console.log("M6 a list of 120 goes as 3 calls (50 + 50 + 20), one message per person");
mj.length = 0; mReply = null; const list = Array.from({ length: 120 }, (_, i) => `s${i}@usc.edu`);
await __mjSend({ ...MJ }, list, "Reminder", "text", { html: "<p>x</p>", replyTo: "prof@usc.edu" });
check("50/50/20 messages, each with one To and the Reply-To", mj.length === 3 && mj.map(c => c.body.Messages.length).join() === "50,50,20" && mj.every(c => c.body.Messages.every(m => m.To.length === 1 && !m.Bcc && m.ReplyTo.Email === "prof@usc.edu")));
check("every recipient exactly once", new Set(mj.flatMap(c => c.body.Messages.map(m => m.To[0].Email))).size === 120);

console.log("M7 off without both keys");
reset(); env = { ...base, MAILJET_API_KEY: "only_one", RESEND_FROM: "support@lockqz.example" };
r = await api("/support", { email: "ida@usc.edu", name: "Ida", message: "one key is not enough" });
check("Gmail, as before", r.data?.ok === true && mj.length === 0 && gmail.length === 1);

console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
