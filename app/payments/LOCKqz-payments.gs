/**
 * LOCKqz payments — runs in the Gmail that receives your Venmo and Zelle alerts (Google Apps Script,
 * free, on Google's servers; your computer can be off). Every minute (Google's fastest) it reads only the payment
 * alerts that arrived since its last run, checks they really came from Venmo / your bank (DKIM-signed)
 * and were really sent TO this mailbox, and sends amount + memo to LOCKqz, which matches the memo code
 * and turns the student (or professor) on.
 *
 * Setup (once): script.google.com → New project → paste this file → Project Settings → Script
 * properties:
 *   PAY_SECRET    = the key shown in LOCKqz Admin → Payments
 *   OWNER_EMAILS  = the address(es) the alerts are sent to, comma-separated (default: this Gmail)
 *   ZELLEPAY_OK   = 1 only if your Zelle alerts really come from zellepay.com (else they wait for review)
 * Then run `setup` once and allow access.
 *
 * It also answers bank-transfer emails: anyone who emails this mailbox about paying by bank transfer / ACH /
 * wire gets LOCKqz's bank details, their amount (income tax included) and their memo within a minute
 * (LOCKqz sends that email; set the BANK_DETAILS secret in Cloudflare).
 *
 * Gmail quota: one search per run over only new mail (after the last run), already-sent alerts are
 * labelled and skipped, so a quiet mailbox costs one cheap search a minute.
 */
const API = "https://lockqz.pages.dev/api/pay/notify";
const DONE = "LOCKqz/processed";
// Senders whose alerts count as real payments (the DKIM signing domain must match one of these).
const SENDERS = {
  "venmo.com":            "venmo",
  "chase.com":            "zelle",
  "bankofamerica.com":    "zelle",
  "wellsfargo.com":       "zelle",
  "notify.wellsfargo.com":"zelle",
  "citi.com":             "zelle",
  "usbank.com":           "zelle",
  "capitalone.com":       "zelle",
  "pnc.com":              "zelle",
};
// Signed, but not known to be a RECEIVING alert for this account: posted for the admin's review only.
const REVIEW_SENDERS = { "zellepay.com": "zelle" };
const WORDS = '("paid you" OR "sent you" OR "received" OR "deposited" OR "deposit")';
const ASKED = "LOCKqz/bank-answered";
// Emails about LOCKqz asking how to pay by bank transfer (not from banks / payment services, not from this
// mailbox). "lockqz" must appear, so a personal Gmail's other mail is never answered.
const ASK_QUERY = 'lockqz ("bank transfer" OR "ACH" OR "wire transfer" OR "wire" OR "bank details" OR "routing number" OR "account number")';

function setup() {
  GmailApp.getUserLabelByName(DONE) || GmailApp.createLabel(DONE);
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("run").timeBased().everyMinutes(1).create();
  check();
  run();
}

// Proves PAY_SECRET matches LOCKqz (Admin -> Payments). Throws if not, so a wrong key is never silent.
function check() {
  const secret = PropertiesService.getScriptProperties().getProperty("PAY_SECRET") || "";
  const r = UrlFetchApp.fetch(API.replace("/notify", "/tick"), { method: "post", contentType: "application/json", muteHttpExceptions: true, headers: { "X-LOCKqz-Pay": secret }, payload: "{}" });
  if (r.getResponseCode() !== 200) throw new Error("PAY_SECRET is wrong: LOCKqz said " + r.getResponseCode());
  Logger.log("LOCKqz key OK");
}

function owners_(props) {
  const list = String(props.getProperty("OWNER_EMAILS") || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) { try { const me = Session.getEffectiveUser().getEmail(); if (me) list.push(me.toLowerCase()); } catch (e) {} }
  return list;
}

function run() {
  const props = PropertiesService.getScriptProperties();
  const secret = props.getProperty("PAY_SECRET");
  if (!secret) throw new Error("Set PAY_SECRET in Project Settings → Script properties");
  const label = GmailApp.getUserLabelByName(DONE) || GmailApp.createLabel(DONE);
  const started = Math.floor(Date.now() / 1000);
  // Only mail since the last successful run (10 minutes of overlap), never the same alert twice.
  const last = Number(props.getProperty("LAST_RUN") || 0) || (started - 3 * 86400);
  const since = last - 600;
  const query = "after:" + since + " -label:" + DONE.replace(/\//g, "-") + " (zelle OR " + Object.keys(SENDERS).map(d => "from:" + d).join(" OR ") + ") " + WORDS;
  const threads = GmailApp.search(query, 0, 50);
  const own = owners_(props), opts = { owners: own, zellepayOk: props.getProperty("ZELLEPAY_OK") === "1",
    accountMarks: String(props.getProperty("ACCOUNT_MARKS") || "").split(",").map(s => s.trim()).filter(Boolean) };
  const out = [];
  threads.forEach(th => th.getMessages().forEach(m => {
    if (m.getDate && m.getDate().getTime() / 1000 < since) return;     // older message in the thread
    const p = parse(m, opts);
    if (p) out.push(p);
  }));
  for (let i = 0; i < out.length; i += 100) {
    const r = UrlFetchApp.fetch(API, { method: "post", contentType: "application/json", muteHttpExceptions: true,
      headers: { "X-LOCKqz-Pay": secret }, payload: JSON.stringify({ payments: out.slice(i, i + 100) }) });
    if (r.getResponseCode() !== 200) throw new Error("LOCKqz said " + r.getResponseCode() + ": " + r.getContentText().slice(0, 200));
  }
  threads.forEach(th => th.addLabel(label));
  props.setProperty("LAST_RUN", String(started));
  // Bank-transfer questions every ~5 min (a second Gmail search every minute would spend Google's 90 min/day
  // trigger-runtime allowance for free accounts; payment alerts above stay every minute).
  if (started - Number(props.getProperty("LAST_ASK") || 0) > 4 * 60) {
    props.setProperty("LAST_ASK", String(started));
    try { answerBankAsks_(secret, own); } catch (e) { Logger.log("bank answers: " + e); }
  }
  // Every ~10 min: LOCKqz's exam emails (reminders 48 h / 3 h before an exam to students without LOCKqz,
  // the professor's T-70 check-in). Pages has no cron, so this script is LOCKqz's clock ($0).
  if (started - Number(props.getProperty("LAST_CRON") || 0) > 9 * 60) {
    props.setProperty("LAST_CRON", String(started));
    try { UrlFetchApp.fetch(API.replace("/pay/notify", "/cron"), { method: "post", contentType: "application/json", muteHttpExceptions: true, headers: { "X-LOCKqz-Pay": secret }, payload: "{}" }); } catch (e) { Logger.log("cron: " + e); }
  }
  // About once an hour: let LOCKqz send any due renewal emails (it does nothing outside renewal time).
  if (started - Number(props.getProperty("LAST_TICK") || 0) > 55 * 60) {
    props.setProperty("LAST_TICK", String(started));
    UrlFetchApp.fetch(API.replace("/notify", "/tick"), { method: "post", contentType: "application/json", muteHttpExceptions: true, headers: { "X-LOCKqz-Pay": secret }, payload: "{}" });
  }
}

// Someone emailed LOCKqz asking to pay by bank transfer: LOCKqz emails them the details (once per thread).
function answerBankAsks_(secret, owners) {
  const label = GmailApp.getUserLabelByName(ASKED) || GmailApp.createLabel(ASKED);
  const notFrom = Object.keys(SENDERS).concat(Object.keys(REVIEW_SENDERS), ["zelle.com", "venmo.com", "stripe.com", "paypal.com"]).map(d => "-from:" + d).join(" ");
  const threads = GmailApp.search("in:inbox newer_than:2d -label:" + ASKED.replace(/\//g, "-") + " " + notFrom + " " + ASK_QUERY, 0, 20);
  threads.forEach(th => {
    const m = th.getMessages()[0];
    const from = ((m.getFrom() || "").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [""])[0].toLowerCase();
    if (from && owners.indexOf(from) < 0 && !/no-?reply|mailer-daemon|notifications?@/.test(from)) {
      const r = UrlFetchApp.fetch(API.replace("/notify", "/bank"), { method: "post", contentType: "application/json", muteHttpExceptions: true,
        headers: { "X-LOCKqz-Pay": secret }, payload: JSON.stringify({ email: from }) });
      if (r.getResponseCode() >= 500) return;            // try again next minute
    }
    th.addLabel(label);
  });
}

// One header (with folded continuation lines), or "".
function header_(head, name) {
  const m = head.match(new RegExp("^" + name + ":[\\s\\S]*?(?=\\r?\\n\\S|(?![\\s\\S]))", "mi"));
  return m ? m[0].replace(/\r?\n[ \t]+/g, " ") : "";
}

// opts: { owners: [addresses this mailbox receives alerts at], zellepayOk: bool }
function parse(m, opts) {
  opts = opts || {};
  const raw = m.getRawContent();
  const cut = raw.search(/\r?\n\r?\n/);
  const head = cut < 0 ? raw : raw.slice(0, cut);
  // Gmail's own verdict on the signature: "dkim=pass header.i=@venmo.com" (or header.d=venmo.com).
  const auth = header_(head, "Authentication-Results");
  const dk = auth.match(/dkim=pass[^;]*?header\.(?:i=[^@\s;]*@|d=)([A-Za-z0-9.-]+)/i);
  if (!dk) return null;
  const dom = dk[1].toLowerCase();
  const pick = list => Object.keys(list).find(d => dom === d || dom.endsWith("." + d));
  const known = pick(SENDERS), revDom = known ? null : pick(REVIEW_SENDERS);
  if (!known && !revDom) return null;
  let via = known ? SENDERS[known] : REVIEW_SENDERS[revDom];
  const subject = m.getSubject() || "", body = m.getPlainBody() || "";
  if (/you paid|you sent|request|charged|refund/i.test(subject)) return null;       // money out, requests, refunds
  // Transfers to/from the bank and deposit notices are not payments to LOCKqz.
  // A bank transfer (ACH) INTO the account with a LOCKqz memo waits for the admin's one-click Assign
  // (bank deposit alerts do not prove who sent it); any other transfer / deposit is not a payment.
  const bankIn = /\btransfer(?:red)?\b|deposit|ach\b/i.test(subject) && !/zelle|paid you|sent you/i.test(subject);
  if (bankIn && (/withdraw|cash ?out|to your bank|from your/i.test(subject) || !/(?:^|[^A-Za-z0-9])LQ[\s-]?S?[\s-]?[A-Za-z0-9]{5}(?![A-Za-z0-9])/i.test(body))) return null;
  const reasons = [];
  if (bankIn) via = "bank";            // ACH / wire the payer sent: matched by its memo like a Zelle
  if (revDom && !opts.zellepayOk) reasons.push("sender " + revDom + " not confirmed as a receiving alert");
  // Replay of someone else's real alert: the signed To: must be THIS mailbox, and "to" must be among
  // the headers the sender's DKIM signature covers.
  const to = (header_(head, "To") + " " + header_(head, "Delivered-To")).toLowerCase();
  const sigs = (head.match(/^DKIM-Signature:[\s\S]*?(?=\r?\n\S|(?![\s\S]))/gmi) || []).map(s => s.replace(/\s+/g, " "));
  const mine = sigs.find(s => { const d = (s.match(/\bd=([A-Za-z0-9.-]+)/) || [])[1]; return d && (dom === d.toLowerCase() || dom.endsWith("." + d.toLowerCase())); });
  const signedTo = !!mine && /\bh=[^;]*\bto\b/i.test(mine);
  const owners = opts.owners || [];
  // Exact addresses only: "x" + owner, owner + ".evil.com" or a display name holding the owner address must not pass.
  const addrs = s => (s.replace(/^[^:]*:/, "").replace(/"[^"]*"/g, "").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map(x => x.toLowerCase());
  const toAddrs = addrs(header_(head, "To")), anyAddrs = toAddrs.concat(addrs(header_(head, "Delivered-To")));
  if (!owners.length) reasons.push("owner address unknown (set OWNER_EMAILS)");
  else if (!owners.some(o => toAddrs.indexOf(o) >= 0)) {
    if (owners.some(o => anyAddrs.indexOf(o) >= 0)) reasons.push("To: is not this mailbox (forwarded?)");
    else return null;                                   // not sent to us at all
  }
  // An alert email proves money reached SOME account, not LOCKqz's: anyone can point their own bank's alerts at
  // this Gmail. Require LOCKqz's receiving account (last 4 digits / Zelle token, Script property ACCOUNT_MARKS,
  // comma-separated) in the bank's text outside the payer's memo; otherwise the payment waits for review.
  const marks = (opts.accountMarks || []).filter(Boolean);
  const bodyNoMemoAcct = body.replace(/(?:memo|note|message)\s*[:\-][^\n]*/gi, "");
  // Venmo alerts come from Venmo to the account's own verified email and name no bank account: not needed there.
  if (via === "venmo") {}
  else if (!marks.length) reasons.push("receiving account unknown (set ACCOUNT_MARKS)");
  else if (!marks.some(k => bodyNoMemoAcct.toLowerCase().indexOf(String(k).toLowerCase()) >= 0)) reasons.push("receiving account not named in the alert");
  if (owners.length && !signedTo) reasons.push("To: not covered by the DKIM signature");
  // The amount comes from the bank's own text, never from what the payer typed in the memo
  // (a memo of "$180" on a $1 payment must not count as $180).
  const AMT = /\$\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)/;
  const bodyNoMemo = body.replace(/(?:memo|note|message)\s*[:\-][^\n]*/gi, "").replace(/LQ[\s-]?S?[\s-]?[A-Za-z0-9]{5}[^\n]*/gi, "");
  const amts = (bodyNoMemo.match(/amount[^$\n]{0,20}\$\s?[0-9][0-9,]*(?:\.[0-9]{1,2})?/i) || [""])[0];
  const amt = (subject.match(AMT) || amts.match(AMT) || bodyNoMemo.match(AMT) || [])[1];
  if (!amt) reasons.push("no amount found");
  // Memo codes as people type them: "LQS4M8TX", "lqs-4m8tx", "LQ S 4M8TX", professor "LQ7K3PXA".
  const code = (body.match(/(?:^|[^A-Za-z0-9])(LQ[\s-]?S?[\s-]?[A-Za-z0-9]{5})(?![A-Za-z0-9])/i) || [])[1];
  const memo = code ? code.toUpperCase().replace(/[\s-]/g, "") : (body.match(/(?:memo|note|message)[:\s]+(.{1,140})/i) || ["", ""])[1];
  const payer = (subject.match(/^(.+?)\s+(?:paid|sent)\s+you/i) || body.match(/^(.+?)\s+(?:paid|sent)\s+you/im) || ["", ""])[1];
  // The provider's own transaction id makes a re-sent or forwarded copy of the same alert a duplicate.
  const pid = (body.match(/(?:transaction|payment)\s*(?:id|#|number)\s*[:#]?\s*([A-Za-z0-9-]{4,40})/i)
            || body.match(/(?:confirmation|reference)\s*(?:number|code|#|id)?\s*[:#]?\s*([A-Za-z0-9-]{4,40})/i) || [])[1];
  const out = { txn: pid ? via + ":" + pid : "gmail:" + m.getId(), msg: m.getId(), amount: amt ? Number(amt.replace(/,/g, "")) : 0,
                note: memo, subject: subject, payer: payer, via: via };
  if (reasons.length) { out.needs_review = true; out.review_reason = reasons.join("; ").slice(0, 120); }
  return out;
}
