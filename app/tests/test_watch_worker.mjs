// The 5-minute watch Worker (app/watch/worker.js), with a fake site, mailbox and KV.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url)), W = join(HERE, "..", "watch");
const { look, run, default: worker } = await import(pathToFileURL(join(W, "worker.js")).href);
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };

let site = { page: 200, prof: 200, api: 200, watch: { ok: true, db: true, write: true, clock: true, mail: true, pay: true } };
let flaky = 0, mailDown = false;
const mails = [], kv = new Map(); let puts = 0, sleeps = 0;
const mk = (over = {}) => ({ SITE: "https://lockqz.example", PROF_SITE: "https://professor.lockqz.example", MAIL_FROM: "watch@lockqz.example", MAIL_TO: "owner@example.com",
  FETCH: async (url, init) => {
    if (flaky > 0) { flaky--; throw new Error("network"); }
    if (url === "https://lockqz.example/") return new Response("x", { status: site.page });
    if (url === "https://professor.lockqz.example/") return new Response("x", { status: site.prof });
    if (url === "https://lockqz.example/api/watch") return new Response(typeof site.watch === "string" ? site.watch : JSON.stringify(site.watch), { status: site.api });
    return new Response("?", { status: 404 }); },
  MAIL: { send: async m => { if (mailDown) throw new Error("mail down"); mails.push(m); } }, MAKE_EMAIL: async (from, to, raw) => ({ from, to, raw }),
  STATE: { get: async k => kv.get(k) ?? null, put: async (k, v) => { puts++; kv.set(k, v); } }, SLEEP: async () => { sleeps++; }, ...over });
const reset = () => { mails.length = 0; kv.clear(); puts = 0; sleeps = 0; flaky = 0; mailDown = false;
  site = { page: 200, prof: 200, api: 200, watch: { ok: true, db: true, write: true, clock: true, mail: true, pay: true } }; };

console.log("K1 looking");
check("all good = nothing to say", (await look(mk())) === "");
site.watch.clock = false; let t = await look(mk());
check("the stopped Gmail script is named", /Gmail payments script has stopped/.test(t), t);
site.watch = { ok: false, db: false, write: false, clock: true, mail: false }; t = await look(mk());
check("several parts are all named", /database does not answer/.test(t) && /refuses writes/.test(t) && /last LOCKqz email failed/.test(t) && t.split("; ").length === 3, t);
reset(); site.watch.pay = false; site.watch.ok = false; t = await look(mk());
check("a payment waiting for the admin is named", /waiting in Admin, Payments/.test(t) && t.split("; ").length === 1, t);
reset(); delete site.watch.mail; t = await look(mk());
check("a part the API does not send yet is not trouble", t === "", t);
reset(); site.watch.ok = false; site.watch.later = false; t = await look(mk());
check("a part with no words here still counts", /not all good/.test(t), t);
reset(); site.page = 522; site.prof = 500; site.api = 503; t = await look(mk());
check("sites and API that do not open are named with their code", /student site does not open \(522\)/.test(t) && /professor site does not open \(500\)/.test(t) && /API does not answer \(503\)/.test(t), t);
reset(); site.watch = "<html>limit</html>"; t = await look(mk());
check("an answer that is not JSON counts as no answer", /not JSON/.test(t), t);
reset(); flaky = 3; t = await look(mk());
check("no network = all three named, no throw", t.split("; ").length === 3 && /no answer/.test(t), t);

console.log("K2 telling: at once, not again for 6 hours, once when fine again");
reset(); let r = await run(mk());
check("all good: nothing sent, nothing written, no wait", r.trouble === "" && mails.length === 0 && puts === 0 && sleeps === 0);
flaky = 3; r = await run(mk());
check("one blip (fine 20 s later) is not trouble", r.trouble === "" && sleeps === 1 && mails.length === 0);
site.watch.clock = false; r = await run(mk());
check("new trouble: one email, kept", mails.length === 1 && puts === 1 && r.told === true && /stopped calling/.test(mails[0].raw), JSON.stringify(r));
check("the email is a plain message from the watch address to the owner", mails[0].from === "watch@lockqz.example" && mails[0].to === "owner@example.com" && /^From: LOCKqz watch <watch@lockqz\.example>\r\nTo: <owner@example\.com>\r\nSubject: LOCKqz: something stopped\r\nMessage-ID: <[0-9a-f-]+@lockqz\.example>\r\nDate: /.test(mails[0].raw) && mails[0].raw.includes("\r\n\r\n- the Gmail"));
r = await run(mk()); r = await run(mk());
check("the same trouble is not told again", mails.length === 1 && puts === 1 && r.told === null);
const old = JSON.parse(kv.get("last")); kv.set("last", JSON.stringify({ ...old, at: Date.now() - 6.1 * 3600000, since: old.since - 6.1 * 3600000 }));
r = await run(mk());
check("after 6 hours it is told again, with the first time kept", mails.length === 2 && JSON.parse(kv.get("last")).since < Date.now() - 6 * 3600000);
site.watch.db = false; r = await run(mk());
check("different trouble is told at once", mails.length === 3 && /database does not answer/.test(mails[2].raw));
site.watch = { ok: true, db: true, write: true, clock: true, mail: true }; r = await run(mk());
check("fine again: one email saying so", mails.length === 4 && /Subject: LOCKqz is fine again/.test(mails[3].raw) && /It was: /.test(mails[3].raw) && JSON.parse(kv.get("last")).trouble === "");
r = await run(mk());
check("and then quiet", mails.length === 4 && r.told === null);

console.log("K3 several addresses; a message that could not leave is tried again");
reset(); site.watch.write = false; r = await run(mk({ MAIL_TO: "owner@example.com, second@example.com" }));
check("one email to each address", r.told === true && mails.length === 2 && mails[1].to === "second@example.com" && /\r\nTo: <second@example\.com>\r\n/.test(mails[1].raw));
reset(); site.watch.write = false; mailDown = true; r = await run(mk());
check("nothing could leave: not kept, so the next look tells", puts === 0 && r.told === false);
mailDown = false; r = await run(mk());
check("next look: told", mails.length === 1 && puts === 1);

console.log("K4 by hand");
reset();
let res = await worker.fetch(new Request("https://w.example/?send=1"), mk({ TEST_KEY: "0123456789abcdef0123" }));
check("no key = not found, nothing sent", res.status === 404 && mails.length === 0);
res = await worker.fetch(new Request("https://w.example/?send=1", { headers: { "X-Watch-Key": "" } }), mk());
check("no TEST_KEY set = always not found", res.status === 404);
res = await worker.fetch(new Request("https://w.example/?send=1", { headers: { "X-Watch-Key": "0123456789abcdef0123" } }), mk({ TEST_KEY: "0123456789abcdef0123" }));
check("with the key: a test message leaves", res.status === 200 && mails.length === 1 && /Nothing is wrong/.test(mails[0].raw));
res = await worker.fetch(new Request("https://w.example/", { headers: { "X-Watch-Key": "0123456789abcdef0123" } }), mk({ TEST_KEY: "0123456789abcdef0123" }));
check("with the key: one look", (await res.json()).trouble === "");
let ran = null; await worker.scheduled({}, mk(), { waitUntil(p) { ran = p; } }); await ran;
check("the clock runs a look", ran instanceof Promise);

console.log("K5 settings");
const toml = readFileSync(join(W, "wrangler.toml"), "utf8");
check("every 5 minutes, one KV key, Email Routing", toml.includes('crons = ["*/5 * * * *"]') && toml.includes('binding = "STATE"') && toml.includes("[[send_email]]") && toml.includes('name = "MAIL"'));
check("asks the live sites", toml.includes('SITE = "https://lockqz.com"') && toml.includes('PROF_SITE = "https://professor.lockqz.com"'));
check("no secret in the file", !/TEST_KEY\s*=/.test(toml));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
