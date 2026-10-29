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
const polMust = ["google.com/search?udm=14", "GeminiSettings", "GenAiDefaultSettings", "DnsOverHttpsMode",
              "ExtensionInstallBlocklist", "bing.com/search", "duckduckgo.com", "copilot.microsoft.com",
              "udm=14&q={searchTerms}", "WebsiteFilter", "browser.ml.chat.enabled",
              // round 2: Brave Tor/VPN, Firefox Smart Window + built-in VPN, safe-extension allowlist,
              // DuckDuckGo no-AI site, every blocklist host mirrored into the browsers' own filters
              "TorDisabled", "BraveVPNDisabled", "SmartWindow", "SidebarChatbot", "IPProtectionAvailable",
              "ExtensionInstallAllowlist", "noai.duckduckgo.com", "nngceckbapebfimnlniiiahkandclblb",
              // 27 Oct: more AI-answer engines blocked in the browsers' own filters (Safari relies on the agent rewrite)
              "baidu.com/s", "search.naver.com", "ask.com", "yep.com", "search.aol.com", "ecosia.org/chat", "yandex.ru/search"];
let polMiss = polMust.filter(m => !pyPol.includes(m));
polMiss.length === 0 ? ok("mac policy has every rule") : bad("mac policy missing: " + polMiss.join(", "));
polMiss = polMust.filter(m => !psPol.includes(m));
polMiss.length === 0 ? ok("windows policy has every rule") : bad("windows policy missing: " + polMiss.join(", "));
// bing.com / huggingface.co must never be whole-domain blocked (only their AI paths).
const over = ["\"bing.com\"", "\"huggingface.co\""].filter(d => pyPol.includes(d) || psPol.includes(d));
over.length === 0 ? ok("no whole-domain over-block of bing.com / huggingface.co") : bad("over-blocks: " + over.join(", "));

console.log("T7b Office Copilot + Notepad AI policies");
pyPol.includes("OfficeExperiencesAnalyzingContentPreference") && pyPol.includes('"com.microsoft.office"')
  ? ok("mac: Office 'experiences that analyze content' off (com.microsoft.office)") : bad("mac Office Copilot policy missing");
/office\\16\.0\\common\\privacy" "usercontentdisabled" 2/.test(psPol)
  ? ok("windows: per-user Office usercontentdisabled = 2") : bad("windows Office Copilot policy missing");
psPol.includes('"$PolicyRoot\\WindowsNotepad" "DisableAIFeatures" 1')
  ? ok("windows: Notepad DisableAIFeatures = 1") : bad("windows Notepad AI policy missing");
!/"Default"\s*:\s*\{/.test(pyPol) && !/AIControls\\Default/.test(psPol)
  ? ok("Firefox AIControls never uses Default (it deletes on-device models)") : bad("AIControls Default used");

console.log("T9 every hosts entry is a valid host name; path entries are host/path");
const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const hostsE = mac.filter(d => !d.includes("/")), pathsE = mac.filter(d => d.includes("/"));
const badHost = hostsE.filter(d => !HOST.test(d) || /^[0-9.]+$/.test(d));
badHost.length === 0 ? ok(`all ${hostsE.length} hosts entries are valid lowercase host names`) : bad("invalid host entries: " + badHost.join(", "));
// the exact filters the engines and policies use (Mac core sed/grep, browser-policy.py path regex)
const MAC_HOSTS = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/, PY_PATH = /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/[A-Za-z0-9._~%\/-]*$/;
const lost = hostsE.filter(d => !MAC_HOSTS.test(d));
lost.length === 0 ? ok("every host entry reaches the Mac hosts block") : bad("dropped by the Mac hosts filter: " + lost.join(", "));
const badPath = pathsE.filter(d => !PY_PATH.test(d) || !HOST.test(d.split("/")[0]));
badPath.length === 0 ? ok(`all ${pathsE.length} path entries are routed to the browser policies (${pathsE.join(", ")})`)
  : bad("path entries the policies would drop: " + badPath.join(", "));

console.log("T10 open-note resources are never blocked (hosts entries also match subdomains in Chromium)");
const notes = ["docs.google.com", "drive.google.com", "www.google.com", "studocu.com", "www.studocu.com",
  "knowunity.com", "onedrive.live.com", "www.office.com", "m365.cloud.microsoft", "www.onenote.com", "github.com",
  "huggingface.co", "www.bing.com", "x.com", "brightspace.usc.edu", "usc.brightspace.com", "www.khanacademy.org",
  "www.desmos.com", "en.wikipedia.org", "outlook.office.com", "www.icloud.com", "superhuman.com"];
const hits = notes.filter(n => hostsE.some(e => n === e || n.endsWith("." + e)));
hits.length === 0 ? ok(`none of ${notes.length} notes/Brightspace hosts is blocked`) : bad("over-block: " + hits.join(", "));
!hostsE.includes("m365.cloud.microsoft") && pathsE.includes("m365.cloud.microsoft/chat")
  ? ok("Microsoft 365 home stays open; only its Copilot Chat page is blocked") : bad("m365.cloud.microsoft handling wrong");

console.log("T11 round-2 coverage present (homework AI, coding AI, regional, model APIs, remote web clients, DoH)");
const need2 = ["gauthmath.com","questionai.com","studyx.ai","brainly.com","chegg.com","coursehero.com","genspark.ai",
  "lumo.proton.me","yuanbao.tencent.com","qianwen.com","dola.com","api2.cursor.sh","api.githubcopilot.com","github.com/copilot",
  "windsurf.com","cloudcode-pa.googleapis.com","dashscope.aliyuncs.com","api.fireworks.ai","router.huggingface.co",
  "chat.webllm.ai","remotedesktop.google.com","sider.ai","harpa.ai","google.com/ai","google.com/aimode",
  "edgeservices.bing.com","mask.icloud.com","dns.adguard-dns.com","doh.mullvad.net"];
const miss2 = need2.filter(d => !mac.includes(d));
miss2.length === 0 ? ok(`all ${need2.length} round-2 entries present`) : bad("missing: " + miss2.join(", "));

console.log("T13 27 Oct audit: AI inside other apps (Office Copilot back end, editor AIs, cloud model endpoints), more solvers / writers / extension back ends");
const need3 = ["augloop.office.com","bing.com/copilotsearch","duckduckgo.com/aichat","ai-chat.bsg.brave.com","llm.zed.dev","tabnine.com",
  "codewhisperer.us-east-1.amazonaws.com","openai.azure.com","aiplatform.googleapis.com","bedrock-runtime.us-east-1.amazonaws.com",
  "api-inference.huggingface.co","backend.raycast.com","wolframalpha.com","numerade.com","deepl.com/write","humbot.ai","base44.com","wiseone.io"];
const miss3 = need3.filter(d => !mac.includes(d));
miss3.length === 0 ? ok(`all ${need3.length} 27-Oct entries present`) : bad("missing: " + miss3.join(", "));
// the engines close a phone's screen shown on the computer (its apps and its network bypass the hosts block)
const macXb = readFileSync(join(DIR, "../mac/extra-block.sh"), "utf8"), winEng = readFileSync(join(DIR, "../windows/lockqz.ps1"), "utf8");
macXb.includes('"iPhone Mirroring"') ? ok("mac closes iPhone Mirroring during a quiz") : bad("mac: iPhone Mirroring not in REMOTE_APPS");
winEng.includes('"PhoneExperienceHost"') ? ok("windows closes Phone Link during a quiz") : bad("windows: PhoneExperienceHost not in RemoteApps");
const macAi = readFileSync(join(DIR, "../mac/lockqz.sh"), "utf8");
['"Grok"','"Kimi"','"Qwen"','"Microsoft 365 Copilot"'].every(a => macAi.includes(a)) ? ok("mac closes the Grok / Kimi / Qwen / M365 Copilot apps") : bad("mac AI_APPS missing a 27-Oct app");

console.log("T12 browser filters stay under their 1000-entry limits (Chromium URLBlocklist, Firefox WebsiteFilter)");
const est = hostsE.length + 2 * pathsE.length + 20;
est < 900 ? ok(`~${est} entries per browser list (limit 1000, room left for a school's own)`) : bad(`~${est} entries: too close to 1000`);

console.log("T8 the server sends the full list (helpers refresh from it every 12 h)");
const route = readFileSync(join(DIR, "../cloudflare/functions/api/[[route]].js"), "utf8");
const apiList = [...(route.match(/const AI_DOMAINS = \[([\s\S]*?)\];/) || [, ""])[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
// deploy.sh JSON.parses the array literal verbatim: no comments, no trailing comma, nothing but strings
let deployParse = null; try { deployParse = JSON.parse((route.match(/const AI_DOMAINS = (\[[\s\S]*?\]);/) || [])[1]); } catch (e) { deployParse = e; }
Array.isArray(deployParse) && deployParse.length === apiList.length ? ok("AI_DOMAINS is plain JSON (deploy.sh JSON.parses it)") : bad("AI_DOMAINS is not JSON.parse-able as deploy.sh does: " + (deployParse && deployParse.message));
const notServed = mac.filter(d => !apiList.includes(d));
notServed.length === 0 ? ok(`API serves all ${mac.length} domains (${apiList.length} total)`)
  : bad(`API list is missing ${notServed.length}: ${notServed.slice(0, 8).join(", ")}...`);

console.log("");
console.log("T14 28 Oct audit: quiz-answer tools (SmartSolve/Homeworkify; Quizlet/Studocu stay open), coding agents (Replit/Devin/Augment/Qodo), AI portals, more writers/humanizers, ChatGPT wrappers");
const need4 = ["smartsolve.ai","homeworkify.st","mathsolver.microsoft.com","replit.com","devin.ai","augmentcode.com","qodo.ai",
  "firebase.studio","ai.azure.com","copilotstudio.microsoft.com","nova.amazon.com","chat.com","languagetool.org","walterwrites.ai","chatgot.io"];
const miss4 = need4.filter(d => !mac.includes(d));
miss4.length === 0 ? ok(`all ${need4.length} 28-Oct entries present`) : bad("missing: " + miss4.join(", "));
// the served list (AI_DOMAINS) must equal blocklist.txt exactly, in order, and parse as JSON (deploy.sh builds blocklist.json from it)
const routeSrc = readFileSync(join(DIR, "../cloudflare/functions/api/[[route]].js"), "utf8");
const aiM = routeSrc.match(/const AI_DOMAINS = (\[[\s\S]*?\]);/);
let served = null; try { served = JSON.parse(aiM[1]); } catch (e) {}
served ? ok("AI_DOMAINS parses as plain JSON (no comments inside the array)") : bad("AI_DOMAINS is not plain JSON - deploy.sh would fail to build blocklist.json");
served && JSON.stringify(served) === JSON.stringify(mac) ? ok(`AI_DOMAINS == blocklist.txt (${served.length} entries)`) : bad("AI_DOMAINS and blocklist.txt differ");

console.log("T15 28 Oct audit 2: LMS quiz-solver back ends, interview copilots, AI browsers, writers/humanizers, coding agents, model gateways, regional Vertex/Bedrock");
const need5 = ["examclutch.com","getquizsolve.com","getanswerlyai.com","upstudy.ai","finalroundai.com","lockedinai.com","fellou.ai","alexa.com",
  "scribbr.com/paraphrasing-tool","stealthwriter.ai","cline.bot","opencode.ai","integrate.api.nvidia.com","ai-gateway.vercel.sh","open.bigmodel.cn",
  "us-central1-aiplatform.googleapis.com","bedrock-runtime.eu-west-1.amazonaws.com"];
const miss5 = need5.filter(d => !mac.includes(d));
miss5.length === 0 ? ok(`all ${need5.length} 28-Oct audit-2 entries present`) : bad("missing: " + miss5.join(", "));
// scribbr.com / ahrefs.com stay open (citation guides, notes); only their AI tool pages are blocked
!hostsE.includes("scribbr.com") && !hostsE.includes("ahrefs.com") ? ok("scribbr.com / ahrefs.com not whole-host blocked") : bad("scribbr.com or ahrefs.com over-blocked");
const macAi2 = readFileSync(join(DIR, "../mac/lockqz.sh"), "utf8"), macXb2 = readFileSync(join(DIR, "../mac/extra-block.sh"), "utf8");
const winEng2 = readFileSync(join(DIR, "../windows/lockqz.ps1"), "utf8");
['"Codex"','"Doubao"','"QuillBot"','"Fellou"','"Opera Neon"'].every(a => macAi2.includes(a)) ? ok("mac closes Codex / Doubao / QuillBot / Fellou / Opera Neon") : bad("mac AI_APPS missing an audit-2 app");
['"codex"','"doubao"','"quillbot"','"fellou"','"raycast"'].every(a => winEng2.includes(a)) ? ok("windows closes codex / doubao / quillbot / fellou / raycast") : bad("windows AiApps missing an audit-2 app");
['"scrcpy"','"Vysor"','"AirDroid"','"LetsView"','"lemonade-server"'].every(a => macXb2.includes(a) && winEng2.includes(a)) ? ok("both close phone-mirroring apps (scrcpy / Vysor / AirDroid / LetsView) and Lemonade Server") : bad("phone mirroring / Lemonade missing on a platform");

console.log("T16 28 Oct in-app AI: AI-only back ends of kept-open notes apps (Acrobat AI Assistant), never the notes hosts themselves");
const need6 = ["senseicore.adobe.io","senseicore-ue1.adobe.io","dc-genai-access-provisioning-api.adobe.io","dc-genai-persistence.adobe.io","dc-genai-content-platform.adobe.io"];
const miss6 = need6.filter(d => !mac.includes(d) || !win.includes(d) || !(served || []).includes(d));
miss6.length === 0 ? ok(`all ${need6.length} in-app AI hosts in both blocklists + AI_DOMAINS`) : bad("missing: " + miss6.join(", "));
// whole-host entries match subdomains in Chromium: none may cover a notes / editor host
const notes2 = ["docs.google.com", "drive.google.com", "mail.google.com", "classroom.google.com",
  "office.com", "www.office.com", "m365.cloud.microsoft", "onedrive.live.com", "www.onenote.com", "acrobat.adobe.com", "adobe.com", "adobe.io", "dc-api.adobe.io", "sensei.adobe.io"];
const hits2 = notes2.filter(n => hostsE.some(e => n === e || n.endsWith("." + e)));
hits2.length === 0 ? ok(`none of ${notes2.length} notes hosts (Docs, Drive, Gmail, Classroom, Office, OneDrive, OneNote, Acrobat web) is blocked`) : bad("over-block: " + hits2.join(", "));
const pyPol2 = readFileSync(join(DIR, "../mac/browser-policy.py"), "utf8");
pyPol2.includes('"bEnableGentech": False') && pyPol2.includes('"com.adobe.Acrobat.Pro", "com.adobe.Reader"') ? ok("mac: Acrobat/Reader FeatureLockdown bEnableGentech off during the quiz") : bad("mac Acrobat policy missing");
psPol.includes('"bEnableGentech" 0') ? ok("windows: Acrobat/Reader FeatureLockDown bEnableGentech = 0") : bad("windows Acrobat policy missing");
const macXb3 = readFileSync(join(DIR, "../mac/extra-block.sh"), "utf8");
macXb3.includes("AirplayRecieverEnabled") && macXb3.includes('"allowAirPlayIncomingRequests": False') && macXb3.includes("airplay_receiver_restore || rc=1")
  ? ok("mac: AirPlay Receiver off during the quiz and restored at unlock") : bad("mac AirPlay Receiver handling missing");

console.log("T17 owner decision 28 Oct: Notion, Canva, Quizlet, Slack, Evernote, Goodnotes blocked during quizzes (their AI cannot be separated from the notes)");
const need7 = ["notion.so","www.notion.so","notion.com","api.notion.com","canva.com","www.canva.com","quizlet.com","www.quizlet.com","slack.com","app.slack.com","slack-edge.com","evernote.com","www.evernote.com","goodnotes.com","web.goodnotes.com"];
const miss7 = need7.filter(d => !mac.includes(d) || !win.includes(d) || !(served || []).includes(d));
miss7.length === 0 ? ok(`all ${need7.length} hosts in both blocklists + AI_DOMAINS`) : bad("missing: " + miss7.join(", "));
const macApps7 = readFileSync(join(DIR, "../mac/lockqz.sh"), "utf8"), winApps7 = readFileSync(join(DIR, "../windows/lockqz.ps1"), "utf8");
['"Notion"','"Canva"','"Slack"','"Evernote"','"Goodnotes"'].every(a => macApps7.includes(a)) ? ok("mac closes the Notion / Canva / Slack / Evernote / Goodnotes apps") : bad("mac AI_APPS missing a notes app");
['"Notion"','"Canva"','"slack"','"Evernote"','"GoodNotes"'].every(a => winApps7.includes(a)) ? ok("windows closes the Notion / Canva / Slack / Evernote / Goodnotes apps") : bad("windows $AiApps missing a notes app");

console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
