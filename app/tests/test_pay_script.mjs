// The Gmail payment script's parser (app/payments/LOCKqz-payments.gs): real alerts accepted, forged
// or outgoing ones refused. Runs the real .gs file in a sandbox with fake Gmail messages.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "payments", "LOCKqz-payments.gs"), "utf8");
const ctx = {}; vm.createContext(ctx); vm.runInContext(src + "\nthis.parse = parse;", ctx);
let pass = 0, fail = 0; const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m, i); } };
const msg = (auth, subject, body, id = "m1") => ({ getRawContent: () => `Authentication-Results: mx.google.com;\r\n       ${auth}\r\nFrom: x\r\nSubject: ${subject}\r\n\r\n${body}`, getSubject: () => subject, getPlainBody: () => body, getId: () => id });
const VENMO_OK = "dkim=pass header.i=@venmo.com header.s=x header.b=y; spf=pass";
let p = ctx.parse(msg(VENMO_OK, "Al Student paid you $5.00", "Al Student paid you $5.00\nLQS4M8TX\nTransaction ID 123"));
check("real Venmo alert parsed", p && p.amount === 5 && p.note === "LQS4M8TX" && p.via === "venmo" && p.payer === "Al Student" && p.txn === "gmail:m1", JSON.stringify(p));
p = ctx.parse(msg("dkim=fail header.i=@venmo.com", "Al paid you $5.00", "LQS4M8TX"));
check("failed DKIM refused", p === null);
p = ctx.parse(msg("dkim=pass header.i=@evil-venmo.com", "Al paid you $5.00", "LQS4M8TX"));
check("look-alike domain refused", p === null);
p = ctx.parse(msg("dkim=pass header.i=@gmail.com", "Al paid you $5.00", "LQS4M8TX"));
check("forwarded/forged from gmail refused", p === null);
p = ctx.parse(msg(VENMO_OK, "You paid Bob $5.00", "LQS4M8TX"));
check("outgoing payment ignored", p === null);
p = ctx.parse(msg(VENMO_OK, "Bob requests $5.00", "LQS4M8TX"));
check("payment request ignored", p === null);
p = ctx.parse(msg("dkim=pass header.d=chase.com header.s=x", "You received money with Zelle", "Duke Bristow sent you $2,500.00\nMemo: LQ7K3PXA x\n"));
check("Chase Zelle alert parsed (comma amount)", p && p.amount === 2500 && p.via === "zelle", JSON.stringify(p));
p = ctx.parse(msg("dkim=pass header.i=@alerts.bankofamerica.com", "Zelle payment received", "You received $5.00 from Cy. Memo: for cy@usc.edu"));
check("BofA subdomain + email memo", p && p.amount === 5 && /cy@usc.edu/.test(p.note), JSON.stringify(p));
console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
