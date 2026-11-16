// LOCKqz watch: a small Cloudflare Worker with its own clock (every 5 minutes, Workers Free). It asks the live
// site what the Server watch workflow asks (both sites open; GET /api/watch: database read, database write, the
// Gmail script's clock, last email, a payment waiting for the admin) and tells the owner at once when something stops, again every 6 hours while
// it lasts, and once when it is fine again. The message does not go through LOCKqz's own email or database:
// Cloudflare Email Routing sends it (send_email binding) to MAIL_TO, the routing's verified address(es).
// What was last reported is kept in Workers KV (one small key).
// Deploy: cd app/watch && npx wrangler deploy     Secret: TEST_KEY (optional, for a test by hand).
const WORDS = {
  db: "the database does not answer",
  write: "the database refuses writes (daily limit?)",
  clock: "the Gmail payments script has stopped calling (payments by Zelle and Venmo, exam emails and renewals wait)",
  mail: "the last LOCKqz email failed and none has gone out since",
  pay: "a payment that looks like LOCKqz's is waiting in Admin, Payments: its memo matched nobody, so that person has no access yet (Assign or Void it)",
};

// "" = all good, else what stopped (several parts joined with "; ").
export async function look(env) {
  const f = env.FETCH || fetch, site = env.SITE || "https://lockqz.com", prof = env.PROF_SITE || "https://professor.lockqz.com";
  const get = async url => { try { return await f(url, { headers: { "User-Agent": "LOCKqz-watch" }, redirect: "follow", signal: AbortSignal.timeout(20000) }); } catch { return null; } };
  const out = [];
  const [a, b, w] = await Promise.all([get(site + "/"), get(prof + "/"), get(site + "/api/watch")]);
  if (!a || a.status !== 200) out.push(`the student site does not open (${a ? a.status : "no answer"})`);
  if (!b || b.status !== 200) out.push(`the professor site does not open (${b ? b.status : "no answer"})`);
  if (!w || w.status !== 200) out.push(`the API does not answer (${w ? w.status : "no answer"})`);
  else {
    let d = null; try { d = await w.json(); } catch {}
    if (!d || typeof d !== "object") out.push("the API does not answer (not JSON)");
    else {
      const n = out.length;
      for (const k of Object.keys(WORDS)) if (d[k] === false) out.push(WORDS[k]);
      if (out.length === n && d.ok !== true) out.push("the API's watch answer is not all good");   // a part this Worker has no words for yet
    }
  }
  return out.join("; ");
}

// One plain email to every address in MAIL_TO (each must be a verified Email Routing destination). true = at least one left.
async function tell(env, subject, text) {
  let sent = false;
  const make = env.MAKE_EMAIL || (async (from, to, body) => new (await import("cloudflare:email")).EmailMessage(from, to, body));
  for (const to of String(env.MAIL_TO || "").split(",").map(x => x.trim()).filter(Boolean)) {
    try {
      const raw = [`From: LOCKqz watch <${env.MAIL_FROM}>`, `To: <${to}>`, `Subject: ${subject.replace(/[^\x20-\x7e]/g, "-")}`,
        `Message-ID: <${crypto.randomUUID()}@${String(env.MAIL_FROM).split("@")[1]}>`, `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", text, ""].join("\r\n");
      await env.MAIL.send(await make(env.MAIL_FROM, to, raw)); sent = true;
    } catch (e) { console.log("mail to " + to + ": " + (e && e.message || e)); }
  }
  return sent;
}

const AGAIN_MS = 6 * 3600000;
export async function run(env) {
  let trouble = await look(env);
  if (trouble) { await (env.SLEEP || (ms => new Promise(r => setTimeout(r, ms))))(20000); trouble = await look(env); }   // one blip is not trouble
  let last = null; try { last = JSON.parse(await env.STATE.get("last") || "null"); } catch {}
  const was = last && last.trouble || "", now = Date.now();
  if (!trouble) {
    if (!was) return { trouble: "", told: null };
    const told = await tell(env, "LOCKqz is fine again", `Everything answers again.\n\nIt was: ${was}\nSince: ${new Date(last.since || last.at).toISOString()}`);
    if (told) await env.STATE.put("last", JSON.stringify({ trouble: "", at: now }));
    return { trouble: "", told };
  }
  if (trouble === was && now - Number(last.at || 0) < AGAIN_MS) return { trouble, told: null };   // already told
  const since = trouble === was ? (last.since || last.at) : now;
  const told = await tell(env, "LOCKqz: something stopped", `${trouble.split("; ").map(x => "- " + x).join("\n")}\n\nSince: ${new Date(since).toISOString()}\nChecked every 5 minutes; told again every 6 hours while it lasts.`);
  if (told) await env.STATE.put("last", JSON.stringify({ trouble, at: now, since }));   // not told = try again in 5 minutes
  return { trouble, told };
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(run(env)); },
  // By hand, with the TEST_KEY secret: GET /?send=1 sends one test message; GET / looks once.
  async fetch(request, env) {
    const key = String(env.TEST_KEY || ""), got = String(request.headers.get("X-Watch-Key") || "");
    if (key.length < 16 || got !== key) return new Response("not found", { status: 404 });
    const url = new URL(request.url);
    const body = url.searchParams.get("send") === "1" ? { told: await tell(env, "LOCKqz watch: test", "This is a test of the LOCKqz watch. Nothing is wrong.") } : { trouble: await look(env) };
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  },
};
