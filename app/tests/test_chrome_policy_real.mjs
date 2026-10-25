// The REAL Chrome policy LOCKqz writes, loaded by a REAL Chromium (Playwright's, Linux machine policy).
// Checks Chromium accepts every policy (no unknown/invalid ones except features newer than this
// Chromium), that AI sites and Google AI search are refused, normal Google Web search and notes sites
// are not, and that installed (incl. unpacked) extensions are disabled. Skips if no Chromium/xvfb/root.
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url)), APP = join(HERE, "..");
let pass = 0, fail = 0; const ok = m => { pass++; console.log("  ok: " + m); }, bad = m => { fail++; console.log("  FAIL: " + m); };
import { createRequire } from "node:module";
let chromium; try { ({ chromium } = createRequire(import.meta.url)("playwright")); } catch { console.log("RESULT: 0 passed, 0 failed (skipped: no playwright)"); process.exit(0); }
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const hasX = !!process.env.DISPLAY;
if (!isRoot || !hasX || process.platform !== "linux") { console.log("RESULT: 0 passed, 0 failed (skipped: needs Linux root + a display, e.g. xvfb-run)"); process.exit(0); }
const pol = JSON.parse(execFileSync("python3", ["-c", `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('bp','${APP}/mac/browser-policy.py'); m=importlib.util.module_from_spec(spec); sys.argv=['x']; spec.loader.exec_module(m)
p=m.chromium_policy('com.google.Chrome'); p.pop(m.MARK,None)
p['URLBlocklist']=m._union(p['URLBlocklist'], m.path_entries()+m.host_entries())
print(json.dumps(p))`], { env: { ...process.env, LOCKQZ_BLOCKLIST: join(APP, "mac/blocklist.txt") } }).toString());
const DIRS = ["/etc/chromium/policies/managed", "/etc/opt/chrome/policies/managed", "/etc/opt/chrome_for_testing/policies/managed", "/etc/opt/chromium/policies/managed"];
const put = j => DIRS.forEach(d => { mkdirSync(d, { recursive: true }); writeFileSync(join(d, "lockqz-test.json"), JSON.stringify(j)); });
const ext = mkdtempSync(join(tmpdir(), "lqzext-"));
writeFileSync(join(ext, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "AI helper test", version: "1", background: { service_worker: "bg.js" } }));
writeFileSync(join(ext, "bg.js"), "");
console.log(`T1 Chromium loads LOCKqz's policy (${Object.keys(pol).length} policies, ${pol.URLBlocklist.length} blocked URL entries)`);
put({});
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "lqzprof-")), { headless: false, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
try {
  await new Promise(r => setTimeout(r, 1500));
  put(pol);
  const p = await ctx.newPage(); await p.goto("chrome://policy");
  const reload = p.getByText("Reload policies"); if (await reload.count()) await reload.first().click();
  await p.waitForTimeout(3500);
  const rows = await p.evaluate(() => { const out = []; const walk = n => { if (!n) return; if (n.shadowRoot) walk(n.shadowRoot); for (const c of n.children || []) walk(c); if (n.tagName && n.tagName.toLowerCase() === "policy-row") out.push((n.shadowRoot || n).textContent.replace(/\s+/g, " ").trim()); }; walk(document.body); return out; });
  const set = rows.filter(r => !/Not set\./.test(r));
  const name = r => r.split(" ")[0];
  // newer than this test Chromium, deprecated-and-overridden Lens ones, and the cloud-only default
  const tolerated = /^(GenAiDefaultSettings|AutofillGenAiSettings|TabOrganizerSettings|TryOnYouSettings|LensOverlaySettings|LensRegionSearchEnabled|LensDesktopNTPSearchEnabled|GeminiSparkSettings|GeminiChromeFileUploadSettings|ChromeSuggestionsSettings|SmartTabSharingSettings|ThirdPartyAiChatSettings|AutofillPredictionSettings|AIModeSettings|SearchContentSharingSettings|GeminiActOnWebSettings|ExtensionDeveloperModeSettings)$/;
  const errs = set.filter(r => /Error Error/.test(r) && !tolerated.test(name(r)));
  errs.length === 0 ? ok(`every policy accepted (${set.length} set)`) : bad("rejected: " + errs.map(r => r.slice(0, 120)).join(" | "));
  const must = ["GeminiSettings", "HelpMeWriteSettings", "HistorySearchSettings", "DevToolsGenAiSettings", "CreateThemesSettings", "TabCompareSettings", "BuiltInAIAPIsEnabled", "ExtensionInstallBlocklist", "URLBlocklist", "URLAllowlist", "BlockExternalExtensions"];
  const okRow = n => set.some(r => name(r) === n && /Status (OK|Restart required)/.test(r));
  const missing = must.filter(n => !okRow(n)); missing.length === 0 ? ok("core AI-off policies applied with status OK") : bad("not OK: " + missing.map(n => (set.find(r => name(r) === n) || n + " (not set)").slice(0, 200)).join(" | "));
  console.log("T2 what a student can and cannot open (blocked = refused by the browser itself, before any network)");
  const blocked = async u => { const q = await ctx.newPage(); const r = await q.goto(u, { timeout: 8000 }).then(() => false).catch(e => /ERR_BLOCKED_BY_ADMINISTRATOR/.test(e.message)); await q.close(); return r; };
  for (const u of ["https://chatgpt.com/", "https://gemini.google.com/app", "https://claude.ai/", "https://www.google.com/search?q=derivative+of+x2", "https://www.google.com/search?udm=50&q=x", "https://www.google.com/search?q=x&udm=50", "https://www.bing.com/chat", "https://copilot.microsoft.com/", "https://www.perplexity.ai/", "https://www.gauthmath.com/", "https://x.com/i/grok", "https://www.google.com/ai"])
    (await blocked(u)) ? ok("blocked: " + u) : bad("NOT blocked: " + u);
  for (const u of ["https://www.google.com/search?udm=14&q=derivative", "https://www.google.com/search?q=derivative&udm=14", "https://docs.google.com/document/u/0/", "https://drive.google.com/", "https://www.onenote.com/", "https://brightspace.usc.edu/d2l/home", "https://en.wikipedia.org/wiki/Derivative", "https://www.desmos.com/calculator"])
    (await blocked(u)) ? bad("over-blocked: " + u) : ok("allowed: " + u);
  console.log("T3 extensions");
  const em = await ctx.newPage(); await em.goto("chrome://extensions"); await em.waitForTimeout(1200);
  const list = await em.evaluate(() => new Promise(r => chrome.management.getAll(l => r(l.map(e => ({ n: e.name, en: e.enabled }))))));
  const t = list.find(e => e.n === "AI helper test");
  t && t.en === false ? ok("an installed unpacked AI extension is disabled during the quiz") : bad("extension state: " + JSON.stringify(list));
} finally { put({}); await ctx.close(); }
console.log(""); console.log(`RESULT: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
