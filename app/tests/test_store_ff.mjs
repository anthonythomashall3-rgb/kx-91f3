// Microsoft Store + Firefox (31 Oct): the download page offers the Store listing by itself once Microsoft has
// published it (/api/store, cached); every Windows release is submitted to the Store by CI when the Partner
// Center app credentials exist; the Firefox professor extension is signed by Mozilla in CI (AMO key) and the
// dashboard installs the signed .xpi; the site's extension packages are always the current build.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url)), APP = join(HERE, ".."), ROOT = join(APP, ".."), CF = join(APP, "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-store-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
const store = async live => { const r = await onRequest({ request: new Request("https://lockqz.test/api/store"), env: { DB: { prepare() { throw new Error("no db needed"); } }, STORE_LIVE_TEST: live } }); return r.json(); };

console.log("S1 /api/store");
check("not published yet -> no id (the page keeps the command + installer)", (await store("0")).id === null);
check("published -> the product id", (await store("1")).id === "9P7D1114N2LJ");
const idx = readFileSync(join(CF, "public", "index.html"), "utf8");
check("download page (Windows) asks /api/store and shows the Store button first", idx.includes('fetch("/api/store")') && idx.includes("showStore(d && d.id)") && idx.includes('"https://apps.microsoft.com/detail/" + id'));

console.log("S2 automatic Store submissions (CI)");
const rel = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
check("windows-store job knows whether the Store credentials exist", rel.includes("HAS_STORE: ${{ secrets.STORE_CLIENT_SECRET != '' }}"));
check("msstore reconfigure + publish of the built MSIX to 9P7D1114N2LJ, only with credentials", rel.includes("msstore reconfigure --tenantId $env:STORE_TENANT_ID") && rel.includes('msstore publish "$env:RUNNER_TEMP\\store\\lockqz-store.msix" -id 9P7D1114N2LJ') && (rel.match(/env\.HAS_STORE == 'true'/g) || []).length >= 2);
check("a failed Store submission never blocks the deploy", /Microsoft Store submission failed[^\n]*\n\s*exit 0/.test(rel));
check("deploy always serves the current extension packages (+ the signed .xpi when there)", rel.includes('cp app/extension-prof/dist/lockqz-prof-chromium.zip app/extension-prof/dist/lockqz-prof-firefox.zip "$d/"') && rel.includes("lockqz-prof-firefox.xpi"));

console.log("S3 Firefox: Mozilla-signed package");
const cws = readFileSync(join(ROOT, ".github", "workflows", "cws.yml"), "utf8");
check("firefox job: unlisted signing with web-ext + AMO key secrets, skipped without them", cws.includes("firefox:") && cws.includes("web-ext@8 sign") && cws.includes("--channel unlisted") && cws.includes("AMO_JWT_ISSUER") && cws.includes("Firefox signing skipped"));
check("signs the committed, tested package (no rebuild in CI) and keeps the .xpi in dist", cws.includes("unzip -q app/extension-prof/dist/lockqz-prof-firefox.zip") && cws.includes("cp \"$f\" app/extension-prof/dist/lockqz-prof-firefox.xpi"));
check("then starts the deploy that serves it", cws.includes("gh workflow run release.yml"));
const build = readFileSync(join(APP, "extension-prof", "build.sh"), "utf8");
check("build.sh keeps a signed .xpi (only the zips are rebuilt)", build.includes("rm -f dist/*.zip") && !/rm -rf build dist/.test(build));
const man = JSON.parse(readFileSync(join(APP, "extension-prof", "manifest.json"), "utf8"));
check("Firefox id set for Mozilla signing", man.browser_specific_settings?.gecko?.id === "prof@lockqz.app");
const dep = readFileSync(join(CF, "deploy.sh"), "utf8"), dash = readFileSync(join(CF, "public", "dashboard.html"), "utf8");
check("deploy.sh turns on the signed Firefox install when the .xpi is on the site", dep.includes("lockqz-prof-firefox.xpi") && dep.includes("s/const FF_XPI = false;/const FF_XPI = true;/"));
check("dashboard: Firefox button = the .xpi (Continue to Installation -> Add) when signed, else the zip", dash.includes("const FF_XPI = false;") && dash.includes('BROWSER === "firefox" && FF_XPI ? INSTALL + "/download/lockqz-prof-firefox.xpi"') && dash.includes("<b>Continue to Installation</b> → <b>Add</b>"));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
