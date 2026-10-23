// LOCKqz blocklist integrity test. Guards the ONE part that needs upkeep.
//  - no duplicate domains
//  - every major AI (incl. Claude) is present
//  - every entry is a well-formed host (or host/path), no spaces, has a dot
//  - mac and windows blocklists are identical
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const DIR = dirname(fileURLToPath(import.meta.url));
const macF = join(DIR, "../mac/blocklist.txt");
const winF = join(DIR, "../windows/blocklist.txt");

let pass = 0, fail = 0;
const ok = m => { pass++; console.log("  ok:", m); };
const bad = m => { fail++; console.log("  FAIL:", m); };

const parse = f => readFileSync(f, "utf8").split("\n")
  .map(l => l.trim()).filter(l => l && !l.startsWith("#"));

const mac = parse(macF);
const win = parse(winF);

console.log("T1 no duplicate domains (mac)");
const seen = new Set(), dups = [];
for (const d of mac) { if (seen.has(d)) dups.push(d); seen.add(d); }
dups.length === 0 ? ok(`all ${mac.length} unique`) : bad(`duplicates: ${dups.join(", ")}`);

console.log("T2 every major AI present");
const must = ["openai.com","chatgpt.com","anthropic.com","claude.ai","gemini.google.com",
  "copilot.microsoft.com","perplexity.ai","grok.com","deepseek.com","mistral.ai","meta.ai",
  "qwen.ai","kimi.com","poe.com","character.ai","you.com","huggingface.co/chat","groq.com",
  "cluely.com","openrouter.ai","api.openai.com","api.anthropic.com"];
const missing = must.filter(d => !mac.includes(d));
missing.length === 0 ? ok(`all ${must.length} key AIs covered`) : bad(`missing: ${missing.join(", ")}`);

console.log("T3 Claude specifically is blocked (user requirement)");
["claude.ai","anthropic.com","claude.com"].every(d => mac.includes(d))
  ? ok("claude.ai + anthropic.com + claude.com all present")
  : bad("a Claude domain is missing");

console.log("T4 every entry is a well-formed host");
const badvals = mac.filter(d => /\s/.test(d) || !d.includes(".") || d.includes("://") || d.startsWith(".") || d.endsWith("."));
badvals.length === 0 ? ok("all entries well-formed") : bad(`malformed: ${badvals.join(", ")}`);

console.log("T5 DoH resolvers included (anti-bypass)");
["cloudflare-dns.com","dns.google"].every(d => mac.includes(d))
  ? ok("DoH endpoints present") : bad("a DoH endpoint is missing");

console.log("T6 mac and windows blocklists identical");
JSON.stringify(mac) === JSON.stringify(win)
  ? ok(`both platforms identical (${mac.length} domains)`)
  : bad("mac and windows blocklists differ");

console.log("T7 browser policy (no extension) pins search to Google Web + blocks AI-answer search engines, Mac and Windows alike");
const pyPol = readFileSync(join(DIR, "../mac/browser-policy.py"), "utf8");
const psPol = readFileSync(join(DIR, "../windows/browser-policy.ps1"), "utf8");
const polMust = ["google.com/search@udm=14", "GeminiSettings", "GenAiDefaultSettings", "DnsOverHttpsMode",
              "ExtensionInstallBlocklist", "bing.com/search", "duckduckgo.com", "copilot.microsoft.com",
              "udm=14&q={searchTerms}", "WebsiteFilter", "browser.ml.chat.enabled"];
let polMiss = polMust.filter(m => !pyPol.includes(m));
polMiss.length === 0 ? ok("mac policy has every rule") : bad("mac policy missing: " + polMiss.join(", "));
polMiss = polMust.filter(m => !psPol.includes(m));
polMiss.length === 0 ? ok("windows policy has every rule") : bad("windows policy missing: " + polMiss.join(", "));
// bing.com / huggingface.co must never be whole-domain blocked (only their AI paths).
const over = ["\"bing.com\"", "\"huggingface.co\""].filter(d => pyPol.includes(d) || psPol.includes(d));
over.length === 0 ? ok("no whole-domain over-block of bing.com / huggingface.co") : bad("over-blocks: " + over.join(", "));

console.log("T8 the server sends the full list (helpers refresh from it every 12 h)");
const route = readFileSync(join(DIR, "../cloudflare/functions/api/[[route]].js"), "utf8");
const apiList = [...(route.match(/const AI_DOMAINS = \[([\s\S]*?)\];/) || [, ""])[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
const notServed = mac.filter(d => !apiList.includes(d));
notServed.length === 0 ? ok(`API serves all ${mac.length} domains (${apiList.length} total)`)
  : bad(`API list is missing ${notServed.length}: ${notServed.slice(0, 8).join(", ")}...`);

console.log("");
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
