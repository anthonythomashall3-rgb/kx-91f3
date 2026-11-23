// LOCKqz mail-in: a small Cloudflare Email Worker (Workers Free). Email Routing on lockqz.com sends it every email to
// quiz@lockqz.com (subaddressing on), support@lockqz.com and the catch-all.
//  * quiz+<ou>-<qi>-<tok>@lockqz.com is the address the professor's Sync puts in each protected quiz's Notification
//    Email, so Brightspace writes to it the moment an attempt is submitted. Such an email is read (headers, plain text,
//    the text of its HTML with its links) and handed to the LOCKqz API (POST /api/mailin), which keeps it only for a real
//    quiz address.
//  * Every other email goes on to the mailbox (FORWARD_TO). When the mailbox turns it away for a while (Gmail slows
//    down mail that Cloudflare forwards to it), LOCKqz sends it on itself (POST /api/mailfwd with MAILIN_KEY, a secret
//    the Worker and the server share), so it is never lost and its sender is not left trying again for days. A mailbox
//    that says no for good (spam, no such address) is not argued with: the sender's server is told, as before.
// Nothing is stored. Deploy: cd app/mailin && npx wrangler deploy, and once: npx wrangler secret put MAILIN_KEY (the
// value of the Pages project's MAILIN_KEY). Email Routing: quiz@, support@ and the catch-all -> Worker lockqz-mailin.
const QUIZ_TO = /^(?:lqz-|[^+@\s]+\+)\d{1,12}-\d{1,12}-[0-9a-f]{12}@/i;
const RAW_MAX = 2000000;   // an email's words are read (to send it on if need be) when it is under 2 MB
const PERMANENT = /\bpermanent|\b5\d\d\b|\b5\.\d{1,3}\.\d{1,3}\b/i;   // "no" for good: 5xx, 5.x.x

export default {
  async email(message, env) {
    if (!QUIZ_TO.test(String(message.to || ""))) return onward(message, env);
    const raw = await new Response(message.raw).text();
    const mail = readMail(raw);
    await post(env, "/mailin", JSON.stringify({ to: message.to, from: message.from, subject: mail.subject, text: mail.text.slice(0, 8000), date: mail.date }));
  },
};

// Not a quiz's address: on to the mailbox. Its words are read first (Cloudflare's own examples read message.raw and
// then forward), so LOCKqz has them when the mailbox turns the forward away for a while.
async function onward(message, env) {
  if (!env.FORWARD_TO) return;
  let raw = null;
  try { if (!(Number(message.rawSize) > RAW_MAX)) raw = await new Response(message.raw).text(); } catch {}
  try { await message.forward(env.FORWARD_TO); return; }
  catch (e) {
    const why = String((e && e.message) || e || "").slice(0, 300);
    if (!env.MAILIN_KEY || PERMANENT.test(why)) throw e;
    const h = message.headers && typeof message.headers.get === "function" ? message.headers : new Headers();
    const mail = raw != null ? readMail(raw) : { subject: words(h.get("subject") || ""), date: h.get("date") || "", text: "", files: [] };
    const body = JSON.stringify({ to: message.to, from: message.from, subject: mail.subject, date: mail.date, text: mail.text.slice(0, 20000), files: mail.files.slice(0, 20), why });
    if (!(await post(env, "/mailfwd", body, { "X-LQZ-Key": String(env.MAILIN_KEY) }))) throw e;   // the sender's server tries again later
  }
}

// POST to the LOCKqz API. A busy API (5xx, no answer) is tried 3 times; true when it took the email (2xx).
async function post(env, path, body, extra = {}) {
  const f = env.FETCH || fetch, api = (env.API || "https://lockqz.pages.dev/api").replace(/\/$/, "");
  for (let i = 0; i < 3; i++) {
    try {
      const r = await f(api + path, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "LOCKqz-mailin", ...extra }, body });
      if (r.status < 500) return r.status < 300;
    } catch {}
    if (env.NO_WAIT !== true) await new Promise(r => setTimeout(r, 1500 * (i + 1)));
  }
  return false;
}

// ---- a small MIME reader: headers (folded lines, RFC 2047 words), multipart, quoted-printable, base64 ----
const dec = (bytes, cs) => { try { return new TextDecoder(cs || "utf-8").decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); } };
const latin = s => Uint8Array.from(s, c => c.charCodeAt(0) & 255);
function qp(s) {
  const t = s.replace(/=\r?\n/g, ""), out = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push(t.charCodeAt(i) & 255);
  }
  return Uint8Array.from(out);
}
function b64(s) { try { return latin(atob(s.replace(/[^A-Za-z0-9+/=]/g, ""))); } catch { return new Uint8Array(); } }
export function words(s) {   // =?utf-8?Q?Jos=C3=A9?= / =?UTF-8?B?Sm9zw6k=?=
  return String(s || "").replace(/\?=\s+=\?/g, "?==?").replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g, (_, cs, e, t) =>
    dec(e.toUpperCase() === "B" ? b64(t) : qp(t.replace(/_/g, " ")), cs));
}
function split(raw) {
  const m = /\r?\n\r?\n/.exec(raw);
  const head = m ? raw.slice(0, m.index) : raw, body = m ? raw.slice(m.index + m[0].length) : "";
  const h = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":"); if (i > 0) { const k = line.slice(0, i).trim().toLowerCase(); if (!(k in h)) h[k] = line.slice(i + 1).trim(); }
  }
  return { h, body };
}
const param = (v, k) => { const m = new RegExp("(?:^|;)\\s*" + k + "\\s*=\\s*(?:\"([^\"]*)\"|([^;\\s]*))", "i").exec(String(v || "")); return m ? (m[1] ?? m[2]) : ""; };
function parts(h, body, out, depth = 0) {
  const ct = String(h["content-type"] || "text/plain").toLowerCase(), te = String(h["content-transfer-encoding"] || "").toLowerCase();
  if (ct.startsWith("multipart/") && depth < 5) {
    const bd = param(h["content-type"], "boundary");
    if (!bd) return;
    for (const chunk of body.split("--" + bd).slice(1)) {
      if (chunk.startsWith("--")) break;
      const p = split(chunk.replace(/^\r?\n/, ""));
      parts(p.h, p.body, out, depth + 1);
    }
    return;
  }
  if (!ct.startsWith("text/") || /^\s*attachment/i.test(String(h["content-disposition"] || ""))) {   // an attachment: its name only
    const name = words(param(h["content-disposition"], "filename") || param(h["content-type"], "name"));
    if (name) out.files.push(name);
    return;
  }
  // 7bit / 8bit: the raw email was read as UTF-8 already; quoted-printable and base64 carry their own charset.
  const t = te === "base64" ? dec(b64(body), param(h["content-type"], "charset")) : te === "quoted-printable" ? dec(qp(body), param(h["content-type"], "charset")) : body;
  (ct.startsWith("text/html") ? out.html : out.text).push(t);
}
export function htmlText(h) {   // the words of an HTML part, with each link's address kept (a student's id may be in it)
  return String(h || "").replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi, " $1 ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"").replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
export function readMail(raw) {
  const { h, body } = split(String(raw || ""));
  const out = { text: [], html: [], files: [] };
  parts(h, body, out);
  const text = [...out.text, ...out.html.map(htmlText)].join("\n").replace(/\r/g, "");
  return { subject: words(h.subject || ""), date: h.date || "", text, files: out.files };
}
