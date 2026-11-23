// LOCKqz mail-in Email Worker (app/mailin/worker.js), no network: a Brightspace-style email (multipart, quoted-printable
// HTML with links, an encoded subject) goes in; the API gets the address it was sent to, the sender, the subject and
// the email's words with its links. A 5xx answer is tried again; a 4xx is not.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const W = await import(pathToFileURL(join(HERE, "..", "mailin", "worker.js")).href);
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

const RAW = [
  "From: Brightspace <noreply@d2l.com>",
  "To: Pat Prof <p@usc.edu>, quiz+700-1-0123456789ab@lockqz.com",
  "Subject: =?UTF-8?Q?Quiz_Submission:_Exam_1_=E2=80=93_Jos=C3=A9?=",
  "Date: Sun, 22 Nov 2026 20:05:00 +0000",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="b1"',
  "",
  "--b1",
  'Content-Type: text/plain; charset="utf-8"',
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Jos=C3=A9 Mu=C3=B1oz has completed the quiz Exam 1 in BUAD 306.=",
  "",
  "--b1",
  'Content-Type: text/html; charset="utf-8"',
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "<html><body><p>Jos=C3=A9 Mu=C3=B1oz has completed <b>Exam 1</b>.</p><a href=3D\"https://brightspace.usc.edu/d2l/lms/quizzing/admin/mark/quiz_mark_attempt.d2l?ou=3D700&amp;qi=3D1&amp;uid=3D9102\">View attempt</a></body></html>",
  "--b1--",
  ""].join("\r\n");

console.log("W1 the email is read");
{
  const m = W.readMail(RAW);
  check("subject: encoded words decoded", m.subject === "Quiz Submission: Exam 1 – José", m.subject);
  check("plain text: quoted-printable, UTF-8", m.text.includes("José Muñoz has completed the quiz Exam 1"), m.text.slice(0, 120));
  check("HTML: its words and its link's address (with the student's id)", /has completed Exam 1/.test(m.text) && /uid=9102/.test(m.text), m.text);
  check("date kept", m.date === "Sun, 22 Nov 2026 20:05:00 +0000");
  const b64 = ["Subject: =?utf-8?B?UXVpeiBzdWJtaXNzaW9u?=", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", Buffer.from("Ava Kim (akim) submitted Exam 2").toString("base64"), ""].join("\n");
  const b = W.readMail(b64);
  check("base64 body and B-encoded subject", b.subject === "Quiz submission" && b.text.includes("Ava Kim (akim) submitted Exam 2"), JSON.stringify(b));
  check("8bit UTF-8 body as is", W.readMail("Subject: x\nContent-Type: text/plain; charset=utf-8\n\nNoé Durand finished").text.includes("Noé Durand"));
  check("HTML entities and line breaks", W.htmlText("<p>A&amp;B<br>C&nbsp;D &#233;</p>").includes("A&B\nC D é"));
}

console.log("W2 handed to the API");
{
  const calls = [];
  let status = [503, 200];
  const env = { API: "https://lockqz.test/api", NO_WAIT: true, FETCH: async (u, o) => { calls.push({ u, o }); return new Response("{}", { status: status.shift() ?? 200 }); } };
  const message = { to: "quiz+700-1-0123456789ab@lockqz.com", from: "noreply@d2l.com", raw: new Blob([RAW]).stream(), headers: new Headers() };
  await W.default.email(message, env);
  const b = JSON.parse(calls[calls.length - 1].o.body);
  check("POST /api/mailin with the address it was sent to (the envelope's, not the To line)", calls[0].u === "https://lockqz.test/api/mailin" && calls[0].o.method === "POST" && b.to === "quiz+700-1-0123456789ab@lockqz.com");
  check("... the sender, the subject and the words", b.from === "noreply@d2l.com" && /Exam 1/.test(b.subject) && /Muñoz/.test(b.text) && /uid=9102/.test(b.text));
  check("a busy API (5xx) is tried again", calls.length === 2);
  calls.length = 0; status = [404];
  await W.default.email({ ...message, raw: new Blob([RAW]).stream() }, env);
  check("not a quiz address (4xx): not tried again", calls.length === 1);
  calls.length = 0; status = [];
  const big = RAW.replace("has completed the quiz", "x".repeat(20000) + " has completed the quiz");
  await W.default.email({ ...message, raw: new Blob([big]).stream() }, env);
  check("at most 8,000 characters of text are sent", JSON.parse(calls[0].o.body).text.length <= 8000);
  calls.length = 0; const fwd = [];
  await W.default.email({ to: "quiz@lockqz.com", from: "x@example.com", raw: new Blob(["Subject: hi\n\nhello"]).stream(), headers: new Headers(), forward: async a => fwd.push(a) }, { ...env, FORWARD_TO: "lockqz.app@gmail.com" });
  check("an email to quiz@ itself (no quiz in the address): forwarded to the mailbox, nothing sent to the API", fwd.length === 1 && fwd[0] === "lockqz.app@gmail.com" && calls.length === 0);
  await W.default.email({ to: "lqz-700-1-0123456789ab@lockqz.com", from: "noreply@d2l.com", raw: new Blob([RAW]).stream(), headers: new Headers(), forward: async a => fwd.push(a) }, { ...env, FORWARD_TO: "lockqz.app@gmail.com" });
  check("a quiz address without the plus (lqz-...): to the API too, not forwarded", calls.length === 1 && fwd.length === 1);
  const wt = readFileSync(join(HERE, "..", "mailin", "wrangler.toml"), "utf8");
  check("Workers Free, no storage, no public address; anything else goes on to the mailbox", /name = "lockqz-mailin"/.test(wt) && !/kv_namespaces|d1_databases|r2_buckets/.test(wt) && /workers_dev = false/.test(wt) && /FORWARD_TO = "lockqz\.app@gmail\.com"/.test(wt));
}

console.log("W3 an email that is not a quiz's: on to the mailbox; sent on by LOCKqz when the mailbox turns it away for a while");
{
  const calls = []; let status = [];
  const KEY = "k".repeat(64);
  const base = { API: "https://lockqz.test/api", NO_WAIT: true, FORWARD_TO: "lockqz.app@gmail.com", MAILIN_KEY: KEY, FETCH: async (u, o) => { calls.push({ u, o }); return new Response("{}", { status: status.shift() ?? 200 }); } };
  const SUP = ["From: Ana Ruiz <ana@usc.edu>", "To: support@lockqz.com", "Subject: =?UTF-8?Q?Can=E2=80=99t_install?=", "Date: Mon, 23 Nov 2026 10:00:00 +0000", "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="m1"', "", "--m1", "Content-Type: text/plain; charset=utf-8", "", "The installer stops at step 2.", "--m1",
    'Content-Type: image/png; name="shot.png"', 'Content-Disposition: attachment; filename="shot.png"', "Content-Transfer-Encoding: base64", "", "iVBORw0KGgo=", "--m1--", ""].join("\r\n");
  const msg = (forward, extra = {}) => ({ to: "support@lockqz.com", from: "ana@usc.edu", raw: new Blob([SUP]).stream(), headers: new Headers({ subject: "Can't install" }), forward, ...extra });
  const TEMP = "upstream (gmail-smtp-in.l.google.com.) temporary error: Unknown error: transient error (421): 4.7.28 Gmail has detected an unusual rate of unsolicited mail. To protect our users from spam, mail has been temporarily rate limited. d75a77b69052e-55d66c706cdsi25588961cf.236 - gsmtp";
  const fwd = [];
  await W.default.email(msg(async a => fwd.push(a)), base);
  check("the mailbox takes it: forwarded, nothing else", fwd.length === 1 && fwd[0] === "lockqz.app@gmail.com" && calls.length === 0);
  await W.default.email(msg(async () => { throw new Error(TEMP); }), base);
  const b = calls.length ? JSON.parse(calls[0].o.body) : {};
  check("Gmail's 'unusual rate' (421, for a while): LOCKqz sends it on (POST /api/mailfwd with the Worker's key)", calls.length === 1 && calls[0].u === "https://lockqz.test/api/mailfwd" && calls[0].o.headers["X-LQZ-Key"] === KEY);
  check("... who wrote, to which address, the subject, the date and the words; an attachment by its name only", b.from === "ana@usc.edu" && b.to === "support@lockqz.com" && b.subject === "Can’t install" && /Mon, 23 Nov 2026/.test(b.date) && /stops at step 2/.test(b.text) && !/iVBOR/.test(b.text) && JSON.stringify(b.files) === '["shot.png"]' && /4\.7\.28/.test(b.why), JSON.stringify(b));
  calls.length = 0;
  let threw = null;
  try { await W.default.email(msg(async () => { throw new Error("upstream (gmail-smtp-in.l.google.com.) permanent error: (550): 5.7.1 message rejected as spam"); }), base); } catch (e) { threw = e; }
  check("a 'no' for good (550, spam): not sent on; the sender's server is told, as before", !!threw && calls.length === 0);
  threw = null; status = [502, 502, 502];
  try { await W.default.email(msg(async () => { throw new Error(TEMP); }), base); } catch (e) { threw = e; }
  check("LOCKqz busy too (3 tries): the sender's server tries again later", !!threw && calls.length === 3);
  calls.length = 0; threw = null; status = [429];
  try { await W.default.email(msg(async () => { throw new Error(TEMP); }), base); } catch (e) { threw = e; }
  check("LOCKqz refuses it (too many today, a wrong key): tried once, the sender's server tries again later", !!threw && calls.length === 1);
  calls.length = 0; threw = null; status = [];
  try { await W.default.email(msg(async () => { throw new Error(TEMP); }), { ...base, MAILIN_KEY: "" }); } catch (e) { threw = e; }
  check("no key set: as before (the sender's server tries again later)", !!threw && calls.length === 0);
  await W.default.email(msg(async () => { throw new Error(TEMP); }, { raw: new Blob(["Subject: x\n\nhuge"]).stream(), rawSize: 30000000 }), base);
  const b2 = calls.length ? JSON.parse(calls[0].o.body) : {};
  check("a very large email: sent on with its subject (its words are not read)", calls.length === 1 && b2.subject === "Can't install" && b2.text === "", JSON.stringify(b2));
  const wt = readFileSync(join(HERE, "..", "mailin", "wrangler.toml"), "utf8");
  check("the key is a secret, never in the repo", !/^\s*MAILIN_KEY\s*=/m.test(wt) && /wrangler secret put/.test(wt));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
