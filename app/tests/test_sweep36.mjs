// Sweep 36 (24 Nov 2026), real API on in-memory SQLite, and checks that every kind of computer is tested.
//   A  the live view: a student who only looked at an exam's start page (no attempt, or never given the exam's
//      password) is not red, before or after taking the exam with LOCKqz; an unlock the server did not expect during a
//      LATER attempt is red at once (not only after that attempt's completion arrives)
//   B  what the server writes into an unlock's record (began, ended, expected, unexpected, held) is never taken from
//      the computer's own report
//   C  every kind of computer is installed and tested for real by the Release (Intel and Apple silicon Macs, Windows on
//      x64, on Arm and of the Windows 10 generation, Linux on x64 and Arm); the Store app explains S mode; Windows' own
//      on-device AI for other apps and Microsoft's local model runners are off during a quiz; a computer that runs for
//      weeks without a restart still reports itself (the professor's "ready")
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const CF = join(HERE, "..", "cloudflare"), PUB = join(CF, "public");
const tmp = mkdtempSync(join(tmpdir(), "lqz-sweep36-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
function d1(sqlite) {
  const mk = sql => { const st = sqlite.prepare(sql); let args = [];
    const s = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return s; },
      first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
      run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } };
    return s; };
  return { prepare: mk, async batch(sts) { sqlite.exec("BEGIN"); try { for (const s of sts) s._run(); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; } return []; } };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch {} }
const one = (sql, ...a) => sqlite.prepare(sql).get(...a);
const run = (sql, ...a) => sqlite.prepare(sql).run(...a);
const env = { DB: d1(sqlite), TEACHER_KEY: "admin-key-s36", REQUIRE_SIGNED: "1", ADMIN_EMAIL: "admin@usc.edu", ROT_SECRET: "rot-s36", LIVE_CACHE_MS: "0", PAID_CACHE_MS: "0",
  MAIL_SINK: async () => true };
const BASE = "https://lockqz.test";
const sign = (key, path, ts, raw) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(raw).digest("hex")}`).digest("hex");
async function call(path, body, { teacher = null, dev = null, get = false, ip = "10.0.36.9" } = {}) {
  const raw = JSON.stringify(body ?? {});
  const h = { "Content-Type": "application/json", "CF-Connecting-IP": ip };
  if (teacher) h["X-LOCKqz-Teacher"] = teacher;
  if (dev) { const ts = String(Math.floor(Date.now() / 1000)); h["X-LOCKqz-Device"] = dev.id; h["X-LOCKqz-Time"] = ts; h["X-LOCKqz-Sig"] = sign(dev.key, "/api" + path.replace(/\?.*/, ""), ts, raw); }
  const res = await onRequest({ request: new Request(BASE + "/api" + path, { method: get ? "GET" : "POST", headers: h, body: get ? undefined : raw }), env });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const iso = ms => new Date(ms).toISOString();
const H = 3600000;

// One class, one professor, five students; quiz 1 protected (LOCKqz password), not gated.
const ADMIN = (await call("/signup", { email: "admin@usc.edu", password: "adminpass1", name: "Anthony Hall" })).data?.token;
const roster = [{ id: "8001", name: "Pat Prof", email: "p@usc.edu", role: "Instructor" },
  ...[1, 2, 3, 4, 5, 6, 7].map(i => ({ id: String(9100 + i), name: "Stu " + i, email: `s${i}@usc.edu`, role: "Student" }))];
await call("/sync", { courses: [{ ou: "700", name: "BUAD 306", classlist: roster, quizzes: [] }] }, { teacher: ADMIN });
const code = (await call("/invite", { email: "p@usc.edu", until: "2099-12-31" }, { teacher: ADMIN })).data?.code;
const P = (await call("/signup", { email: "p@usc.edu", password: "profpass12", name: "Pat Prof", invite: code })).data?.token;
const quizzes = [{ qi: "1", name: "Exam 1", active: true, start: iso(Date.now() - 2 * H), end: iso(Date.now() + 48 * H) },
                 { qi: "2", name: "Exam 2", active: true, start: iso(Date.now() - 2 * H), end: iso(Date.now() + 48 * H) }];
await call("/sync", { whoami: { id: "8001" }, courses: [{ ou: "700", name: "BUAD 306", classlist: roster, quizzes }] }, { teacher: P });
if (!one("SELECT 1 FROM quizzes WHERE ou='700' AND qi='1' AND password IS NOT NULL")) run("INSERT OR REPLACE INTO quizzes (ou, qi, quiz_id, password, gated) VALUES ('700','1','700-1','LQ-ABCDEFGHJK',0)");
run("UPDATE quizzes SET gated=0 WHERE ou='700'");
run("UPDATE bs_quizzes SET prot_at=?, unprot_at=NULL, bs_password_is_ours=1, bs_has_password=1 WHERE ou='700'", iso(Date.now() - H));

let n = 0;
const device = async (student) => {
  const d = { id: "mac-s36-" + (++n), key: randomBytes(32).toString("hex") };
  await call("/register", { device_id: d.id, key: d.key, platform: "mac", version: "0.6.43" }, { ip: "10.9.36." + n });
  if (student) run("UPDATE devices SET student=?, student_verified=1 WHERE device_id=?", student, d.id);
  return d;
};
const lock = (d, q = "700-1") => call("/report", { event: "lock", quiz_id: q }, { dev: d });
const gotPw = (d, q = "700-1") => run("INSERT INTO events (device_id, student, quiz_id, event, detail, ts) VALUES (?, NULL, ?, 'password_released', '{}', ?)", d.id, q, iso(Date.now() - 60000));
const ask = (d, reason, extra = {}, q = "700-1") => call("/report", { event: "unlock", quiz_id: q, detail: { reason, local: true, ask: true, before_end: true, held_s: 120, uid: 501, ...extra } }, { dev: d });
const locked = (d, q = "700-1") => !!one("SELECT 1 FROM locks WHERE device_id=? AND quiz_id=?", d.id, q);

const M = 60000;
const T0 = Date.now();
const rowOf = async d => ((await call("/live?quiz=700-1", null, { teacher: P, get: true })).data?.rows || []).find(r => r.device_id === d.id);
const evs = d => sqlite.prepare("SELECT id, event, ts, detail FROM events WHERE device_id=? AND event IN ('lock','unlock') ORDER BY id").all(d.id);
const lastUnlock = d => evs(d).filter(e => e.event === "unlock").pop();
// One attempt with LOCKqz: locked `from` minutes ago, unlocked with `reason` `to` minutes ago (times as they happened).
async function attempt(d, from, to, reason = "quiz_submitted", extra = { seen: { sub: true, attempt: true } }) {
  await lock(d);
  run("UPDATE locks SET locked_at=?, last_lock=? WHERE device_id=? AND quiz_id='700-1'", iso(T0 - from * M), iso(T0 - from * M), d.id);
  run("UPDATE events SET ts=? WHERE id=(SELECT MAX(id) FROM events WHERE device_id=? AND event='lock')", iso(T0 - from * M), d.id);
  const r = await ask(d, reason, extra);
  const u = lastUnlock(d); if (u) run("UPDATE events SET ts=? WHERE id=?", iso(T0 - to * M), u.id);
  return r;
}
const subRow = u => one("SELECT at, ats FROM submissions WHERE ou='700' AND qi='1' AND user_id=?", u);

console.log("A a look at the exam's start page is not 'AI unblocked before submitting'");
{
  const d = await device("s6@usc.edu");
  await attempt(d, 60, 58, "quiz_left", { seen: { sub: false, attempt: false } });   // no password yet, no attempt page
  check("set-up: AI came back at once (no attempt, recorded as ended)", /"ended":"no_(attempt|password)"/.test(lastUnlock(d)?.detail || ""), lastUnlock(d)?.detail);
  let row = await rowOf(d);
  check("after the look: not red", row && row.status !== "left_early", JSON.stringify(row));
  gotPw(d);
  await attempt(d, 30, 20);
  await call("/submitted", { ou: "700", qi: "1", users: [{ id: "9106", completed: iso(T0 - 20 * M - 10000), all: [iso(T0 - 20 * M - 10000)] }] }, { teacher: P });
  row = await rowOf(d);
  check("after the exam taken with LOCKqz: done, not red", row?.status === "done" && !row.flagged_at, JSON.stringify(row));
}
{
  const d = await device("s7@usc.edu"); gotPw(d);
  await attempt(d, 50, 48, "quiz_left", { seen: { sub: false, attempt: false } });   // given the password, no attempt page
  check("an exam page left with no attempt page seen: not red", (await rowOf(d))?.status !== "left_early", JSON.stringify(await rowOf(d)));
}
console.log("A an unlock the server did not expect, in a later attempt, is red at once");
{
  const d = await device("s3@usc.edu"); gotPw(d);
  run("DELETE FROM submissions WHERE user_id='9103'");
  await attempt(d, 30, 20);
  await call("/submitted", { ou: "700", qi: "1", users: [{ id: "9103", completed: iso(T0 - 20 * M - 10000), all: [iso(T0 - 20 * M - 10000)] }] }, { teacher: P });
  check("set-up: attempt 1 done", (await rowOf(d))?.status === "done", JSON.stringify(await rowOf(d)));
  await lock(d); run("UPDATE locks SET locked_at=?, last_lock=? WHERE device_id=? AND quiz_id='700-1'", iso(T0 - 10 * M), iso(T0 - 10 * M), d.id);
  const r = await call("/report", { event: "unlock", quiz_id: "700-1", detail: { reason: "quiz_left" } }, { dev: d });   // not asked: not held
  check("set-up: the unlock stands (an unlock that does not ask)", r.status === 200 && !r.data?.hold, JSON.stringify(r.data));
  run("UPDATE events SET ts=? WHERE id=?", iso(T0 - 8 * M), lastUnlock(d).id);   // 2 minutes into attempt 2
  const row = await rowOf(d);
  check("attempt 2 still running in Brightspace: red now", row?.status === "left_early", JSON.stringify(row));
  await call("/submitted", { ou: "700", qi: "1", users: [{ id: "9103", completed: iso(T0 - 2 * M), all: [iso(T0 - 20 * M - 10000), iso(T0 - 2 * M)] }] }, { teacher: P });
  check("... and still red once attempt 2's completion arrives", (await rowOf(d))?.status === "left_early", JSON.stringify(await rowOf(d)));
}
console.log("B the server's own words in an unlock's record");
{
  const d = await device("s5@usc.edu"); gotPw(d);
  await lock(d); run("UPDATE locks SET locked_at=? WHERE device_id=? AND quiz_id='700-1'", iso(T0 - 9 * M), d.id);
  await call("/report", { event: "unlock", quiz_id: "700-1", detail: { reason: "quiz_left", began: iso(T0 - 300 * M), ended: "no_attempt", expected: "quiz_submitted", held: false } }, { dev: d });
  const det = JSON.parse(lastUnlock(d)?.detail || "{}");
  check("a computer's own began / ended / expected / held are dropped", det.began === iso(T0 - 9 * M) && !("ended" in det) && !("expected" in det) && !("held" in det) && det.unexpected === true, JSON.stringify(det));
  check("... so its unlock is red (no attempt completed)", (await rowOf(d))?.status === "left_early", JSON.stringify(await rowOf(d)));
}

const REPO = join(HERE, "..", "..");
const read = f => readFileSync(join(REPO, f), "utf8");
console.log("C every kind of computer is installed and tested by the Release");
{
  const wf = read(".github/workflows/release.yml");
  check("Intel Mac: the package is installed and tested on macos-15-intel", /mac_intel:[\s\S]*?runs-on: macos-15-intel[\s\S]*?test_mac_install\.sh[\s\S]*?test_mac_hidden\.sh/.test(wf));
  check("the Mac build falls back to an Intel Mac on a re-run (no Apple silicon machine free)", /runs-on: \$\{\{ github\.run_attempt == 1 && 'macos-latest' \|\| 'macos-15-intel' \}\}/.test(wf));
  check("no runner label GitHub does not have (macos-26-intel)", !/macos-26-intel/.test(wf));
  check("Windows: x64, Windows 11 on Arm and the Windows 10 generation", /runner: windows-latest/.test(wf) && /runner: windows-11-arm/.test(wf) && /runner: windows-2022/.test(wf));
  const st = wf.slice(wf.indexOf("  windows-store:"), wf.indexOf("\n  deploy:"));
  check("Windows on Arm also installs and uses the Store package, on a machine of its own", /runner: windows-11-arm/.test(st) && /test_windows_store\.ps1/.test(st));
  check("... and only x64 builds, keeps and sends the Store package", (st.match(/matrix\.runner == 'windows-latest'/g) || []).length === 5);
  check("the Arm machine's two browser-focus checks report without holding the release", (wf.match(/continue-on-error: \$\{\{ matrix\.runner == 'windows-11-arm' \}\}/g) || []).length === 2);
  check("only the x64 installer is the release", /- uses: actions\/upload-artifact@v4\n\s+if: matrix\.runner == 'windows-latest'\n\s+with:\n\s+name: lockqz-win/.test(wf));
  check("Linux: x64 and Arm", /runner: ubuntu-latest, arch: x64/.test(wf) && /runner: ubuntu-24\.04-arm/.test(wf));
  check("nothing deploys unless the Intel Mac passed (or had nothing to test)", /needs: \[test, mac, mac_intel, windows, linux, android\]/.test(wf) && /needs\.mac_intel\.result == 'success' \|\| needs\.mac_intel\.result == 'skipped'/.test(wf));
  check("every Windows leg also checks web search in real Chrome, Edge and Firefox", /test_windows_search\.ps1/.test(wf));
  const msix = read("app/windows/store/build-msix.ps1");
  check("the Store package builds on Windows on Arm (compiler and makeappx found)", /FrameworkArm64/.test(msix) && /arm64\\makeappx\.exe/.test(msix));
}
console.log("C S mode, on-device AI, local model runners, the weekly report");
{
  const cs = read("app/windows/store/LOCKqz.cs");
  check("Store app: S mode is found (SkuPolicyRequired) and the free switch opens", /SkuPolicyRequired/.test(cs) && /productid=BF712690PMLF/.test(cs) && /if \(SMode\(\)\) \{ ShowAll\("smode"\); return; \}/.test(cs));
  check("Store app: a refused start is not shown as 'click Yes' (only error 1223 is the prompt answered No)", /NativeErrorCode == 1223 \? -2 : -3/.test(cs));
  const inst = read("app/windows/install.ps1"), iss = read("app/windows/installer.iss");
  check("setup stops at once with code 7 when Windows runs scripts in restricted mode (Smart App Control / App Control)", /if \(\$ExecutionContext\.SessionState\.LanguageMode -ne "FullLanguage"\) \{[\s\S]{0,300}exit 7/.test(inst) && inst.indexOf("LanguageMode") < inst.indexOf("[Security.Principal.WindowsPrincipal]"));
  check("... and the Store app and the installer say so", /r == 7 \|\| SacOn\(\)/.test(cs) && /VerifiedAndReputablePolicyState/.test(cs) && /if R = 7 then/.test(iss));
  const pol = read("app/windows/browser-policy.ps1");
  check("Windows: other apps' use of Windows' on-device text and image generation force-denied", /AppPrivacy" "LetAppsAccessSystemAIModels" 2/.test(pol) && /AppPrivacy" "LetAppsAccessGenerativeAI" 2/.test(pol));
  const eng = read("app/windows/lockqz.ps1"), mac = read("app/mac/extra-block.sh"), lin = read("app/linux/lockqz.sh");
  check("Foundry Local closed on Windows, Mac and Linux", ['"foundry"', '"Inference.Service.Agent"'].every(x => eng.includes(x) && mac.includes(x)) && /foundry Inference\.Service\.Agent/.test(lin));
  check("Windows: AI Dev Gallery closed", eng.includes('"AIDevGallery"'));
  const py = read("app/mac/lockqzd.py"), ps = read("app/windows/lockqzd.ps1");
  check("Mac / Linux helper: the 12-hour round also sends the weekly report", /SEEN_EVERY = 7 \* 86400/.test(py) && /refresh_blocklist\(\)\n\s+threading\.Thread\(target=report_seen, daemon=True\)\.start\(\)/.test(py));
  check("Windows helper: the same", /Report-Install 604800/.test(ps) && /LQ-InstallDue \$rec \$Version \$State\.student \$now \$every/.test(ps));
  const un = read("app/windows/uninstall.ps1"), ins = read("app/windows/install.ps1"), ti = read("app/tests/test_windows_install.ps1");
  const sw = un.indexOf("LQ-StopAll\nStart-Sleep"), dis = un.indexOf('Disable-ScheduledTask -TaskName "LOCKqz"'), stp = un.indexOf('Stop-ScheduledTask -TaskName "LOCKqz"\n');
  check("Windows remover: the helper's task is switched off before it is stopped (no trigger or restart starts it again)", dis > 0 && stp > dis && sw > stp);
  check("... switched back on only when the restore failed and the helper must finish it", /Enable-ScheduledTask -TaskName "LOCKqz" \| Out-Null\n  Start-ScheduledTask -TaskName "LOCKqz"\n  Fail/.test(un));
  check("... and a last sweep once the task is gone", /Unregister-ScheduledTask -TaskName "LOCKqz" -Confirm:\$false\nLQ-StopAll/.test(un));
  check("remover stops every PowerShell running a LOCKqz script (5.1 or 7)", /Name='powershell\.exe' OR Name='pwsh\.exe'/.test(un) && /lockqz-boot\.ps1\*" -or \$c -like "\*lockqz-agent\.ps1\*"/.test(un) && !/netsh http/.test(un) && !/netsh http/.test(ins));
  check("a new install stops a LOCKqz helper or agent left from a removed copy", /\$Fresh = -not \(Test-Path "\$Dest\\config\.json"\)/.test(ins) && ins.indexOf("if ($Fresh) {") > 0 && ins.indexOf("if ($Fresh) {") < ins.indexOf('Start-ScheduledTask -TaskName "LOCKqz"'));
  const ag = read("app/windows/lockqz-agent.ps1");
  check("helper and agent stop by themselves once LOCKqz's files are gone (never during a quiz; 30 s)", /\$State\.state -ne "locked"\) -and -not \(Test-Path -LiteralPath \(Join-Path \$Here "lockqzd\.ps1"\)\) -and -not \(Test-Path -LiteralPath \(Join-Path \$Here "lockqz\.ps1"\)\)/.test(ps) && /\$goneSeen -ge 6/.test(ps) && /\(-not \$Locked\) -and \$PSCommandPath -and/.test(ag) && /TotalSeconds -ge 30\) \{ Log "LOCKqz was removed/.test(ag));
  const v = read("app/VERSION").trim();
  check("versions agree (" + v + ")", py.includes('VERSION = "' + v + '"') && ps.includes('$Version = "' + v + '"'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
