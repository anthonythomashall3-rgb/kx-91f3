// High-volume email through Amazon SES (28 Oct 2026), Gmail as the fallback. Real API (in-memory SQLite), fake SES.
// Checks: our AWS Signature V4 reference matches AWS's own test vector (get-vanilla); every SES request the API
// sends carries a correct signature; codes + support mail go through SES (From = MAIL_FROM, Reply-To kept);
// SES refusing a send falls back to Gmail and is logged; SES's own daily budget then Gmail's; no SES keys = Gmail only.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash } from "node:crypto";
const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-ses-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js"), "utf8") + "\nexport { sesSend as __sesSend };\n");
const { onRequest, __sesSend } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

// Independent SigV4 (node:crypto), checked against AWS's published test vector first.
const sha = s => createHash("sha256").update(s).digest("hex");
const hm = (k, d) => createHmac("sha256", k).update(d).digest();
function sigv4ref({ method, host, path, query = "", headers = {}, body = "", region, service, secret, amzDate }) {
  const h = { host, "x-amz-date": amzDate }; for (const [n, v] of Object.entries(headers)) h[n.toLowerCase()] = v;
  const names = Object.keys(h).sort();
  const creq = [method, path, query, names.map(n => `${n}:${String(h[n]).trim()}\n`).join(""), names.join(";"), sha(body)].join("\n");
  const day = amzDate.slice(0, 8), scope = `${day}/${region}/${service}/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", amzDate, scope, sha(creq)].join("\n");
  let k = hm("AWS4" + secret, day); for (const p of [region, service, "aws4_request"]) k = hm(k, p);
  return createHmac("sha256", k).update(sts).digest("hex");
}
console.log("S1 SigV4 reference = AWS test vector get-vanilla");
check("signature 5fa00fa3...fbf31", sigv4ref({ method: "GET", host: "example.amazonaws.com", path: "/", region: "us-east-1", service: "service",
  secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", amzDate: "20150830T123600Z" }) === "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch {} }
const db = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
  const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
    first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
    run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } }; return o; },
  async batch(sts) { for (const s of sts) s._run(); } };
for (const [i, e] of ["ann@usc.edu", "bo@usc.edu", "cy@usc.edu", "di@usc.edu", "ed@usc.edu", "fay@usc.edu"].entries())
  sqlite.prepare("INSERT INTO roster (ou,user_id,name,email) VALUES ('100',?,?,?)").run(String(i), "Student " + i, e);

const ses = [], gmail = []; let sesStatus = 200;
const SES = { SES_ACCESS_KEY_ID: "AKIDTEST", SES_SECRET_ACCESS_KEY: "secret/test+key", MAIL_FROM: "no-reply@lockqz.example", SES_REGION: "us-west-2", SES_DAILY_MAX: "4",
  SES_FETCH: async (url, init) => { ses.push({ url, init, body: JSON.parse(init.body) }); return new Response(sesStatus === 200 ? '{"MessageId":"m1"}' : '{"message":"boom"}', { status: sesStatus }); } };
const base = { DB: db, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", MAIL_SINK: async m => { gmail.push(m); } };
let env = { ...base, ...SES };
const api = async (path, body, ip = "1.1.1.1") => { const res = await onRequest({ request: new Request("https://lockqz.pages.dev/api" + path, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify(body) }), env }); return { status: res.status, data: await res.json().catch(() => null) }; };

console.log("S2 a sign-in code goes through SES, signed correctly");
let r = await api("/account", { op: "send", email: "ann@usc.edu" });
const q = ses.at(-1) || {};
check("API answered ok", r.status === 200 && r.data?.sent === true, JSON.stringify(r));
check("one SES call, none through Gmail", ses.length === 1 && gmail.length === 0, `ses=${ses.length} gmail=${gmail.length}`);
check("SES v2 endpoint in SES_REGION", q.url === "https://email.us-west-2.amazonaws.com/v2/email/outbound-emails" && q.init?.method === "POST", q.url);
check("From = LOCKqz <MAIL_FROM>, To = the student, code in the text", q.body?.FromEmailAddress === "LOCKqz <no-reply@lockqz.example>" && JSON.stringify(q.body?.Destination) === '{"ToAddresses":["ann@usc.edu"]}'
  && /Your LOCKqz sign-in code is \d{6}/.test(q.body?.Content?.Simple?.Body?.Text?.Data || "") && /^Your LOCKqz code: \d{6}$/.test(q.body?.Content?.Simple?.Subject?.Data || ""), JSON.stringify(q.body));
const auth = q.init?.headers?.Authorization || "", amz = q.init?.headers?.["X-Amz-Date"] || "";
const want = sigv4ref({ method: "POST", host: "email.us-west-2.amazonaws.com", path: "/v2/email/outbound-emails", headers: { "content-type": "application/json" },
  body: q.init?.body || "", region: "us-west-2", service: "ses", secret: "secret/test+key", amzDate: amz });
check("Authorization: credential scope + signed headers + signature match the reference", auth === `AWS4-HMAC-SHA256 Credential=AKIDTEST/${amz.slice(0, 8)}/us-west-2/ses/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=${want}`, auth);
check("X-Amz-Date is the current UTC time (yyyymmddThhmmssZ)", /^\d{8}T\d{6}Z$/.test(amz) && Math.abs(Date.parse(amz.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, "$1-$2-$3T$4:$5:$6Z")) - Date.now()) < 120000, amz);
const code = (q.body?.Content?.Simple?.Body?.Text?.Data || "").match(/\d{6}/)?.[0];
r = await api("/account", { op: "code", email: "ann@usc.edu", code });
check("the emailed code signs the student in", r.status === 200 && !!r.data?.token, JSON.stringify(r.data));

console.log("S3 support form through SES keeps Reply-To");
r = await api("/support", { email: "bo@usc.edu", name: "Bo", message: "LOCKqz says mail_busy" }, "2.2.2.2");
const sq = ses.at(-1)?.body || {};
check("sent via SES to the support inbox, Reply-To the sender", r.data?.ok === true && JSON.stringify(sq.ReplyToAddresses) === '["bo@usc.edu"]' && /mail_busy/.test(sq.Content?.Simple?.Body?.Text?.Data || ""), JSON.stringify(sq));

console.log("S4 SES refuses -> Gmail sends it, failure logged");
sesStatus = 500; const g0 = gmail.length;
r = await api("/account", { op: "send", email: "cy@usc.edu" }, "3.3.3.3");
check("code still delivered (through Gmail)", r.data?.sent === true && gmail.length === g0 + 1 && gmail.at(-1).to === "cy@usc.edu" && /^\d{6}$/.test(gmail.at(-1).code || ""), JSON.stringify(r.data));
check("ses_failed event recorded with the status", !!sqlite.prepare("SELECT 1 FROM events WHERE event='ses_failed' AND detail LIKE 'ses 500%'").get());
sesStatus = 200;

console.log("S5 SES daily budget (SES_DAILY_MAX=4): when it is used up, Gmail carries on");
r = await api("/account", { op: "send", email: "di@usc.edu" }, "4.4.4.4");   // SES #3
r = await api("/account", { op: "send", email: "ed@usc.edu" }, "5.5.5.5");   // SES #4 (budget full now)
const sesN = ses.length, gN = gmail.length;
r = await api("/account", { op: "send", email: "fay@usc.edu" }, "6.6.6.6");
check("5th send skips SES (budget) and goes through Gmail", r.data?.sent === true && ses.length === sesN && gmail.length === gN + 1 && gmail.at(-1).to === "fay@usc.edu", `ses ${sesN}->${ses.length} gmail ${gN}->${gmail.length}`);
check("SES sends counted separately from Gmail's", Number(sqlite.prepare("SELECT SUM(n) AS n FROM mail_sent WHERE kind='ses'").get().n) === 4 && Number(sqlite.prepare("SELECT SUM(n) AS n FROM mail_sent WHERE kind='total'").get().n) === 2);

console.log("S6 no SES keys -> Gmail only, exactly as before");
env = { ...base, SES_FETCH: SES.SES_FETCH }; const s0 = ses.length;
sqlite.exec("DELETE FROM events");
r = await api("/account", { op: "send", email: "ann@usc.edu" }, "7.7.7.7");
check("no SES call; Gmail sent the code", r.data?.sent === true && ses.length === s0 && gmail.at(-1).to === "ann@usc.edu");
env = { ...base, ...SES, MAIL_FROM: "" };
r = await api("/account", { op: "send", email: "bo@usc.edu" }, "8.8.8.8");
check("keys without MAIL_FROM = SES off (Gmail)", r.data?.sent === true && ses.length === s0 && gmail.at(-1).to === "bo@usc.edu");

console.log("S8 a list of 120 goes as 3 SES messages (50 + 50 + 20), all Bcc, nobody sees another address");
ses.length = 0; const list = Array.from({ length: 120 }, (_, i) => `s${i}@usc.edu`);
await __sesSend({ ...SES }, list, "Reminder", "text", { html: "<p>x</p>", replyTo: "prof@usc.edu" });
check("3 calls with 50/50/20 Bcc, To = MAIL_FROM only", ses.length === 3 && ses.map(c => c.body.Destination.BccAddresses.length).join() === "50,50,20" && ses.every(c => JSON.stringify(c.body.Destination.ToAddresses) === '["no-reply@lockqz.example"]'), ses.map(c => JSON.stringify(c.body.Destination).slice(0, 80)).join(" | "));
check("every recipient exactly once; HTML + Reply-To kept", new Set(ses.flatMap(c => c.body.Destination.BccAddresses)).size === 120 && ses.every(c => c.body.Content.Simple.Body.Html.Data === "<p>x</p>" && c.body.ReplyToAddresses[0] === "prof@usc.edu"));
sesStatus = 400; let threw = null; try { await __sesSend({ ...SES }, "x@usc.edu", "s", "t"); } catch (e) { threw = e; } sesStatus = 200;
check("an SES error is thrown (so the caller falls back), with the status", threw && threw.ses === 400);

console.log("S7 deploy wiring");
const wf = readFileSync(join(HERE, "..", "..", ".github", "workflows", "release.yml"), "utf8"), ms = readFileSync(join(HERE, "..", "payments", "mail-setup.sh"), "utf8");
check("CI step passes SES_* secrets + MAIL_FROM to mail-setup.sh", /SES_ACCESS_KEY_ID: \$\{\{ secrets\.SES_ACCESS_KEY_ID \}\}/.test(wf) && /MAIL_FROM: \$\{\{ vars\.MAIL_FROM \}\}/.test(wf) && /bash \.\.\/payments\/mail-setup\.sh/.test(wf));
check("mail-setup.sh: skips cleanly when not configured, never echoes a secret", /SES not configured -- skipped/.test(ms) && !/echo[^\n]*\$SES_SECRET_ACCESS_KEY/.test(ms) && !/echo[^\n]*\$SES_ACCESS_KEY_ID/.test(ms));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
