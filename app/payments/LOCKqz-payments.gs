/**
 * LOCKqz payments — runs in the Gmail that receives your Venmo and Zelle alerts (Google Apps Script,
 * free, on Google's servers; your computer can be off). Every minute it finds new payment alerts,
 * checks they really came from Venmo / your bank (DKIM-signed), and sends amount + memo to LOCKqz,
 * which matches the memo code and turns the student (or professor) on.
 *
 * Setup (once): script.google.com → New project → paste this file → Project Settings → Script
 * properties: PAY_SECRET = the same secret set in Cloudflare. Then run `setup` once and allow access.
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
  "zellepay.com":         "zelle",
};
// Re-sending an alert is harmless (LOCKqz ignores a payment it has seen), so no state is kept here.
const QUERY = 'newer_than:3d (from:venmo.com OR zelle) ("paid you" OR "sent you" OR "received" OR "deposited")';

function setup() {
  GmailApp.getUserLabelByName(DONE) || GmailApp.createLabel(DONE);
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("run").timeBased().everyMinutes(1).create();
  run();
}

function run() {
  const secret = PropertiesService.getScriptProperties().getProperty("PAY_SECRET");
  if (!secret) throw new Error("Set PAY_SECRET in Project Settings → Script properties");
  const label = GmailApp.getUserLabelByName(DONE) || GmailApp.createLabel(DONE);
  const threads = GmailApp.search(QUERY, 0, 50);
  const out = [], seen = [];
  threads.forEach(th => th.getMessages().forEach(m => {
    const p = parse(m);
    if (p) out.push(p);
  }));
  if (out.length) {
    const r = UrlFetchApp.fetch(API, { method: "post", contentType: "application/json", muteHttpExceptions: true,
      headers: { "X-LOCKqz-Pay": secret }, payload: JSON.stringify({ payments: out }) });
    if (r.getResponseCode() !== 200) throw new Error("LOCKqz said " + r.getResponseCode() + ": " + r.getContentText().slice(0, 200));
  }
  threads.forEach(th => th.addLabel(label));
}

function parse(m) {
  const raw = m.getRawContent();
  const head = raw.slice(0, raw.search(/\r?\n\r?\n/));
  // Gmail's own verdict on the signature: "dkim=pass header.i=@venmo.com" (or header.d=venmo.com).
  const auth = (head.match(/^Authentication-Results:[\s\S]*?(?=\r?\n\S)/mi) || [""])[0];
  const dk = auth.match(/dkim=pass[^;]*?header\.(?:i=[^@\s;]*@|d=)([A-Za-z0-9.-]+)/i);
  if (!dk) return null;
  const dom = dk[1].toLowerCase();
  const via = Object.keys(SENDERS).find(d => dom === d || dom.endsWith("." + d));
  if (!via) return null;
  const subject = m.getSubject() || "", body = m.getPlainBody() || "";
  if (/you paid|you sent|request|charged|refund/i.test(subject)) return null;       // money out, requests, refunds
  const amt = (subject.match(/\$\s?([0-9][0-9,]*\.?[0-9]{0,2})/) || body.match(/\$\s?([0-9][0-9,]*\.[0-9]{2})/) || [])[1];
  if (!amt) return null;
  const memo = (body.match(/LQS?[A-Z0-9]{5}/i) || [""])[0] || (body.match(/(?:memo|note|message)[:\s]+(.{1,140})/i) || ["", ""])[1];
  const payer = (subject.match(/^(.+?)\s+(?:paid|sent)\s+you/i) || ["", ""])[1];
  return { txn: "gmail:" + m.getId(), amount: Number(amt.replace(/,/g, "")), note: memo, subject: subject, payer: payer, via: SENDERS[via] };
}
