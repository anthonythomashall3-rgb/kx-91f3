// LOCKqz URL parsing — every Brightspace quiz URL shape, run through the REAL client code:
//   Mac agent  (mac/lockqz-agent.py: is_quiz, is_leaving, lock_id) and Mac helper (mac/lockqzd.py: lock_id)
//   Windows agent (windows/lockqz-agent.ps1: Is-Quiz, Is-Leaving, Lock-Id) and helper (windows/lockqzd.ps1: Lock-Id)
// Python always runs; the PowerShell side runs when pwsh is installed (as on the test machines).
// If any of them disagree with the expected answer, a quiz would not lock, would unlock mid-attempt,
// or the helper would refuse the password - so every shape is checked on every implementation.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAC = join(HERE, "..", "mac"), WIN = join(HERE, "..", "windows");
let pass = 0, fail = 0;
const ok = m => { pass++; console.log("  ok:", m); };
const bad = m => { fail++; console.log("  FAIL:", m); };

const B = "https://usc.brightspace.com";
// [description, url, lock id, is a quiz page that locks, is a leaving (after-the-quiz) page]
const cases = [
  ["classic quiz summary", `${B}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=12345&ou=98765`, "98765-12345", true, false],
  ["params reversed order", `${B}/d2l/lms/quizzing/user/quiz_summary.d2l?ou=98765&qi=12345`, "98765-12345", true, false],
  ["extra params present", `${B}/d2l/lms/quizzing/user/attempt/start.d2l?ou=98765&qi=12345&cfql=1&d2l_body_type=3`, "98765-12345", true, false],
  ["attempt in progress", `${B}/d2l/lms/quizzing/user/attempt/attempt.d2l?qi=777&ou=111&ai=999`, "111-777", true, false],
  ["trailing hash", `${B}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=321&ou=654#top`, "654-321", true, false],
  ["uppercase host", "HTTPS://USC.BRIGHTSPACE.COM/d2l/lms/quizzing/user/quiz_summary.d2l?qi=9&ou=8", "8-9", true, false],
  ["big realistic ids", `${B}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=2048576&ou=1099988`, "1099988-2048576", true, false],
  ["address bar without https://", "usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=5&ou=6", "6-5", true, false],
  ["staff preview (isprv=1)", `${B}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=456&ou=123&isprv=1`, "123-456", true, false],
  ["staff preview page", `${B}/d2l/lms/quizzing/admin/modify/quiz_preview.d2l?ou=123&qi=456`, "123-456", true, false],
  ["quiz edit page (no preview)", `${B}/d2l/lms/quizzing/admin/modify/quiz_newedit_properties.d2l?ou=123&qi=456`, "123-456", false, false],
  ["submitted page", `${B}/d2l/lms/quizzing/user/quiz_submissions_attempt.d2l?qi=456&ou=123&ai=9`, "123-456", false, true],
  ["quizzes list", `${B}/d2l/lms/quizzing/user/quizzes_list.d2l?ou=98765`, "98765-x", false, true],
  ["course home (no quiz)", `${B}/d2l/home/98765`, "x-x", false, false],
  ["no ids at all", `${B}/d2l/le/content/123/Home`, "x-x", false, false],
  // F14: each rule looks at its own part of the URL only
  ["attempt whose query mentions 'submission'/'feedback'", `${B}/d2l/lms/quizzing/user/attempt/quiz_attempt_page.d2l?ou=123&qi=456&returnUrl=%2Fd2l%2Fquiz_submissions%3Ffeedback%3D1`, "123-456", true, false],
  ["attempt whose query says 'results'", `${B}/d2l/lms/quizzing/user/attempt/quiz_attempt_page.d2l?ou=123&qi=456&from=results`, "123-456", true, false],
  ["a quiz path quoted in another page's query", `${B}/d2l/le/content/123/viewContent/9/View?url=/d2l/lms/quizzing/user/quiz_summary.d2l%3Fqi%3D456`, "x-x", false, false],
  ["preview word only in the query", `${B}/d2l/lms/quizzing/admin/modify/quiz_newedit_properties.d2l?ou=123&qi=456&from=preview`, "123-456", false, false],
  ["look-alike parameters (xqi=, abou=)", `${B}/d2l/lms/quizzing/user/quiz_summary.d2l?xqi=1&abou=7&qi=456&ou=123`, "123-456", true, false],
  ["Google search for qi=1", "https://www.google.com/search?q=qi=1", "x-x", false, false],
  ["empty", "", "x-x", false, false],
];

// ---- Python: the Mac agent and helper, imported from their files ----
const tmp = mkdtempSync(join(tmpdir(), "lqz-url-"));
const py = `
import importlib.util, json, os, sys
def load(n, f):
    s = importlib.util.spec_from_file_location(n, os.path.join(sys.argv[1], f)); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
A = load("agent", "lockqz-agent.py"); D = load("helperd", "lockqzd.py")
urls = json.load(open(sys.argv[2]))
print(json.dumps([[A.lock_id(u), A.is_quiz(u), A.is_leaving(u), D.lock_id(u)] for u in urls]))
`;
writeFileSync(join(tmp, "urls.json"), JSON.stringify(cases.map(c => c[1])));
writeFileSync(join(tmp, "t.py"), py);
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", HOME: tmp, LOCKQZ_DRYRUN: "1", LOCKQZ_CONFIG: join(tmp, "none.json"),
  LOCKQZ_KEY_PATH: join(tmp, "device.key"), LOCKQZ_TOKEN_FILE: join(tmp, "helper.token"), LOCKQZ_LOCKFILE: join(tmp, "active_lock.json") };
const macRes = JSON.parse(execFileSync("python3", [join(tmp, "t.py"), MAC, join(tmp, "urls.json")], { env }).toString());

console.log("T1 Mac agent + helper (real lockqz-agent.py / lockqzd.py)");
cases.forEach(([d, , id, quiz, leave], i) => {
  const [aid, aq, al, did] = macRes[i];
  (aid === id) ? ok(`agent lock id: ${d}`) : bad(`agent lock id: ${d} (got ${aid}, want ${id})`);
  (did === id) ? ok(`helper lock id: ${d}`) : bad(`helper lock id: ${d} (got ${did}, want ${id})`);
  (aq === quiz) ? ok(`agent locks=${quiz}: ${d}`) : bad(`agent locks: ${d} (got ${aq}, want ${quiz})`);
  (al === leave) ? ok(`agent leaving=${leave}: ${d}`) : bad(`agent leaving: ${d} (got ${al}, want ${leave})`);
});

// ---- PowerShell: the Windows agent and helper functions, loaded by AST (nothing else in them runs) ----
let pwsh = null;
for (const c of ["pwsh", "/tmp/auditD/pwsh/pwsh"]) { try { execFileSync(c, ["-NoProfile", "-Command", "1"], { stdio: "ignore" }); pwsh = c; break; } catch {} }
if (pwsh) {
  const ps = `
$ErrorActionPreference = "Stop"
$want = @("Url-Path","Url-Query","Is-QuizPath","Is-Quiz","Is-Leaving","Lock-Id")
$a = [System.Management.Automation.Language.Parser]::ParseFile('${join(WIN, "lockqz-agent.ps1").replace(/'/g, "''")}', [ref]$null, [ref]$null)
foreach ($f in @($a.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $want -contains $_.Name })) { . ([scriptblock]::Create($f.Extent.Text)) }
$d = [System.Management.Automation.Language.Parser]::ParseFile('${join(WIN, "lockqzd.ps1").replace(/'/g, "''")}', [ref]$null, [ref]$null)
$dl = @($d.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq "Lock-Id" })[0]
$dsb = [scriptblock]::Create($dl.Extent.Text.Replace("function Lock-Id", "function Helper-LockId"))
. $dsb
$urls = Get-Content '${join(tmp, "urls.json").replace(/'/g, "''")}' -Raw | ConvertFrom-Json
$out = foreach ($u in @($urls)) { ,@((Lock-Id $u), [bool](Is-Quiz $u), [bool](Is-Leaving $u), (Helper-LockId $u)) }
ConvertTo-Json -InputObject @($out) -Compress -Depth 3
`;
  writeFileSync(join(tmp, "t.ps1"), ps);
  const winRes = JSON.parse(execFileSync(pwsh, ["-NoProfile", "-File", join(tmp, "t.ps1")]).toString());
  console.log("T2 Windows agent + helper (real lockqz-agent.ps1 / lockqzd.ps1)");
  cases.forEach(([d, , id, quiz, leave], i) => {
    const [aid, aq, al, did] = winRes[i];
    (aid === id) ? ok(`agent lock id: ${d}`) : bad(`agent lock id: ${d} (got ${aid}, want ${id})`);
    (did === id) ? ok(`helper lock id: ${d}`) : bad(`helper lock id: ${d} (got ${did}, want ${id})`);
    (aq === quiz) ? ok(`agent locks=${quiz}: ${d}`) : bad(`agent locks: ${d} (got ${aq}, want ${quiz})`);
    (al === leave) ? ok(`agent leaving=${leave}: ${d}`) : bad(`agent leaving: ${d} (got ${al}, want ${leave})`);
  });
} else {
  console.log("T2 Windows agent + helper: skipped (pwsh not installed here; runs on the Windows test machine)");
}

console.log("T3 lock ids stay collision-free for different quizzes");
const ids = macRes.slice(0, 3).map(r => r[0]);
(new Set(["100-1", "100-2", "200-1"]).size === 3) && ids[0] === ids[1] ? ok("same quiz in different shapes -> same id") : bad("ids differ for the same quiz");

console.log("");
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
