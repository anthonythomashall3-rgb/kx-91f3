#!/usr/bin/env python3
# Structural lint for the Windows PowerShell scripts (no pwsh needed).
# Checks balanced braces/parens/brackets, balanced quotes per line outside comments,
# and that each required command/keyword is present. Catches the common real breakages.
import os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
WIN = os.path.join(HERE, "..", "windows")
passed = failed = 0
def ok(m):
    global passed; passed += 1; print("  ok:", m)
def bad(m):
    global failed; failed += 1; print("  FAIL:", m)

def balanced(path):
    # String-aware: ignore brackets inside '...'/"..." and after a real # comment.
    s = open(path, encoding="utf-8").read()
    i, n = 0, len(s)
    depth = {"{": 0, "(": 0, "[": 0}
    close = {"}": "{", ")": "(", "]": "["}
    instr = None
    while i < n:
        c = s[i]
        if instr:
            if c == instr:
                instr = None
            i += 1; continue
        if c in ("'", '"'):
            instr = c; i += 1; continue
        if c == "#":
            while i < n and s[i] != "\n":
                i += 1
            continue
        if c in depth:
            depth[c] += 1
        elif c in close:
            depth[close[c]] -= 1
        i += 1
    for k, v in depth.items():
        if v != 0:
            return f"unbalanced '{k}' (net {v})"
    return None

def required(path, needles):
    src = open(path, encoding="utf-8").read()
    return [n for n in needles if n not in src]

eng = os.path.join(WIN, "lockqz.ps1")
dmn = os.path.join(WIN, "lockqzd.ps1")

print("T1 lockqz.ps1 brackets balanced")
b = balanced(eng); ok("balanced") if not b else bad(b)

print("T2 lockqz.ps1 has the core blocking commands")
miss = required(eng, ["param(", "hosts", "LOCKqz START", "ipconfig /flushdns",
                      "New-NetFirewallRule", "Stop-Process", "browser-policy.ps1",
                      "Do-Lock", "Do-Unlock"])
ok("all core commands present") if not miss else bad("missing: " + ", ".join(miss))

print("T3 lockqz.ps1 handles all three verbs")
miss = required(eng, ['"lock"', '"unlock"', '"status"'])
ok("lock/unlock/status handled") if not miss else bad("missing verb(s): " + ", ".join(miss))

print("T4 lockqzd.ps1 brackets balanced")
b = balanced(dmn); ok("balanced") if not b else bad(b)

print("T5 lockqzd.ps1 has the control-server + watcher + safety")
miss = required(dmn, ["HttpListener", "X-LOCKqz-Token", "/lock", "/unlock", "/status",
                      "/heartbeat", "max_minutes", "locked_since", "Engine \"unlock\""])
ok("server + watcher + hard-max present") if not miss else bad("missing: " + ", ".join(miss))

agt = os.path.join(WIN, "lockqz-agent.ps1")
pol = os.path.join(WIN, "browser-policy.ps1")
print("T6a lockqz-agent.ps1 + browser-policy.ps1 brackets balanced")
b = balanced(agt); ok("agent balanced") if not b else bad("agent: " + b)
b = balanced(pol); ok("policy balanced") if not b else bad("policy: " + b)
print("T6b agent detects the quiz, locks, shows the password, unlocks, pings")
miss = required(agt, ["/d2l/lms/quizzing/user/", "UIAutomationClient", "TabItem", "/lock", "/unlock",
                      "/password", "Set-Clipboard", "heartbeat", "quiz_left", "/student", "Ask-Box", "Setup-Identity", "\"/verify\"", "param([switch]$Setup, [switch]$QuizOpen)"])
ok("agent complete") if not miss else bad("agent missing: " + ", ".join(miss))
print("T6c policy covers Chrome/Edge/Brave/Firefox, lock AND unlock")
miss = required(pol, ["Policies\\Google\\Chrome", "Policies\\Microsoft\\Edge", "Policies\\BraveSoftware\\Brave",
                      "Policies\\Mozilla\\Firefox", "URLBlocklist", "URLAllowlist", "udm=14", "Do-Lock", "Do-Unlock", "LOCKqzManaged"])
ok("policy complete") if not miss else bad("policy missing: " + ", ".join(miss))
print("T6d installer registers the agent task, no extension step")
inst = open(os.path.join(WIN, "install.ps1"), encoding="utf-8").read()
ok("agent task registered") if "LOCKqz Agent" in inst and "lockqz-agent.ps1" in inst else bad("agent task missing")
ok("no Web Store / extension step") if "ExtensionInstallForcelist" not in inst and "ExtId" not in inst else bad("extension step still present")

print("T6 engine + daemon share the same hosts marker")
eng_src = open(eng, encoding="utf-8").read()
if "LOCKqz START" in eng_src:
    ok("hosts marker consistent")
else:
    bad("hosts marker missing in engine")

print("T7 regression guards from the 25-Oct audit")
dmn = open(os.path.join(WIN, "lockqzd.ps1"), encoding="utf-8").read()
# #2: the engine-locked check must be case-SENSITIVE (so "unlocked" never matches "LOCKED")
ok("engine-locked check is case-sensitive") if '-match "LOCKED"' not in dmn and dmn.count('-cmatch "LOCKqz: LOCKED"') >= 2 else bad("engine-locked still uses case-insensitive -match")
# #19: no locale/DST-dependent unix time
ok("no Get-Date -UFormat %s (locale/DST safe time)") if "-UFormat %s" not in dmn else bad("still parses Get-Date -UFormat %s")
# #21: uninstall uses CIM (Get-Process has no CommandLine in PS 5.1) and stops tasks before unlock
uni = open(os.path.join(WIN, "uninstall.ps1"), encoding="utf-8").read()
# round-2 #7: the one-line remover (irm .../uninstall.ps1 | iex) self-elevates and never "exit"s inside iex
ok("uninstall self-elevates like install.ps1 (RunAs, irm | iex)") if "IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)" in uni and "-Verb RunAs" in uni and "irm $Site/uninstall.ps1 | iex" in uni else bad("uninstall.ps1 does not ask for administrator rights")
import re as _re2
_exits = [l for l in uni.splitlines() if _re2.search(r"\bexit\b", l) and not l.lstrip().startswith("#")]
ok("uninstall exits only through Fail (exit when run as a file, throw when pasted)") if _exits == ["  if ($FromFile) { exit 1 }"] and 'throw "LOCKqz was not removed.' in uni else bad("bare exit in uninstall.ps1: %r" % _exits)
ok("uninstall stops the agent via CIM") if "Get-CimInstance Win32_Process" in uni else bad("uninstall relies on Get-Process .CommandLine (PS5.1 null)")
ok("uninstall stops tasks before unlock") if uni.index("Unregister-ScheduledTask") < uni.index("lockqz.ps1") + uni[uni.index("lockqz.ps1"):].index("unlock") and uni.index("Unregister-ScheduledTask") < uni.index(" unlock") else bad("uninstall unlocks before stopping the watcher")
# #14: no path-style hosts entries written by the engine
ok("engine skips path-style blocklist entries") if '-like "*/*"' in eng_src else bad("engine may write invalid hosts lines with /")
# #5: single-object .Count guarded with @()
agt_src = open(agt, encoding="utf-8").read()
ok("agent wraps window lists in @()") if "$wins = @(Get-BrowserWindows)" in agt_src and "@($wins | Where-Object { Is-Leaving $_.Url })" in agt_src else bad("agent window list not wrapped in @() (PS5.1 single-object bug)")
# #13: installer reuses an existing token
ok("installer reuses existing token/device") if "keep the key the running helper already uses" in inst else bad("reinstall mints a new token the running helper won't accept")

print("T8 regression guards from the 24-Oct Windows audit")
pol_src = open(pol, encoding="utf-8").read()
eng_lines = [l for l in eng_src.splitlines() if not l.lstrip().startswith("#")]
# no CORS on the loopback helper: web pages must never be able to call it
ok("helper sends no CORS headers, has no OPTIONS path") if "Access-Control" not in dmn and '"OPTIONS"' not in dmn else bad("helper still answers CORS / OPTIONS")
ok("helper refuses browser (Origin) requests") if 'Headers["Origin"]' in dmn else bad("helper accepts requests from web pages")
ok("safety cap: quiz end + 15 min / 6 h unknown, never above 24 h") if "Clamp-Minutes" in dmn and "$CapCeilMin = 1440" in dmn and "$CapMin = 360" in dmn and "LQ-CapForEnd" in dmn else bad("safety cap missing")
ok("heartbeat on wall clock, not cycle count") if "% 36" not in dmn and "LQ-Due $lastBeat" in dmn else bad("heartbeat still counts watcher cycles")
ok("watcher tamper check under the engine mutex") if '"locking"' in dmn and "$State.applied" in dmn else bad("watcher can flag a lock in progress as tampering")
ok("every unlock reported with a reason (incl. the safety cap)") if "LQ-UnlockReason" in dmn and 'WRelease $State.quiz_id "cap"' in dmn else bad("unlock reasons missing")
ok("unlocks that did not finish are retried (stray block sweep)") if "WEngine \"unlock\"" in dmn and "policy-backup.json" in dmn else bad("failed unlock not retried")
ok("no localized account names in icacls / task principals") if all(x not in inst + dmn for x in ['"SYSTEM:', '"Administrators:', '"Users:', 'BUILTIN\\Users']) and "S-1-5-32-545" in inst else bad("English account names still used (fail on non-English Windows)")
ok("icacls result checked") if "$LASTEXITCODE" in inst else bad("icacls failures ignored")
ok("helper task also repeats from install time") if "-Trigger @($trigger, $tNow)" in inst else bad("5-min repetition only after the next boot")
# Firefox: extensions never blocked (installation_mode blocked uninstalls them), documented Preferences form
ok("Firefox extensions never blocked") if "ExtensionSettings" not in pol_src and 'installation_mode' not in pol_src else bad("Firefox ExtensionSettings still used (uninstalls extensions)")
ok("Firefox Preferences as one REG_MULTI_SZ JSON value") if '"MultiString"' in pol_src and 'Set-Val "$Firefox\\Preferences"' not in pol_src else bad("deprecated Firefox Preferences subkey form")
ok("policy values backed up and restored, lists merged") if "New-PolicyBackup" in pol_src and "Restore-Backup" in pol_src and "Remove-Item -Path $path -Recurse" not in pol_src else bad("policy unlock can destroy existing policy")
ok("engine no longer touches WindowsAI values itself") if not any("WindowsAI" in l for l in eng_lines) else bad("engine still writes/deletes WindowsAI values")
ok("policies.json written without BOM") if "UTF8Encoding $false" in pol_src and "Set-Content -Path $pj" not in pol_src else bad("policies.json written with a BOM")
ok("engine checks its hosts write") if "LOCK FAILED" in eng_src and "UNLOCK FAILED" in eng_src else bad("engine reports LOCKED without checking")
ok("agent never sends an unsigned quiz_left report") if 'event = "quiz_left"; quiz_id = $Quiz; student' not in agt_src else bad("agent still posts unsigned quiz_left (401)")
ok("agent retries unconfirmed unlocks") if "$Pending" in agt_src and "Send-Unlock" in agt_src else bad("agent drops a failed unlock")
# DST: local time jumps back an hour on 1 Nov 2026; every agent timer must run on UTC.
_gd = [l.strip() for l in agt_src.splitlines() if "Get-Date" in l and not l.lstrip().startswith("#")
       and not re.search(r"Get-Date -Format|Get-Date \"2000-01-01\"", l)]
ok("agent timers on UTC (no local Get-Date: a DST change never freezes password checks or unlocks)") if not _gd else bad("local Get-Date timers left: %r" % _gd[:3])
ok("agent shows the quiz opening time in the student's own zone") if "$opens.ToLocalTime()" in agt_src else bad("opens-at shown in UTC")
# OSAS: assistive tools a professor allowed one student keep working (fixed key -> id map, cleared at unlock)
ok("browser policy: allowed assistive extensions join the fixed safe list (key -> fixed id)") if "$AssistExtensions" in pol_src and "Get-AssistExtensions" in pol_src and '(@($SafeExtensions) + @(Get-AssistExtensions))' in pol_src and "inoeonmfapjbbkmdafoankkfajkcphgd" in pol_src else bad("assistive allowance missing from browser policy")
ok("browser policy: Dark Reader / High Contrast / OpenDyslexic always allowed") if all(i in pol_src for i in ["eimadpbcbfnmbkopoojfekhnkhdbieeh", "djcfdncoelnlbldjfhinnjlhdjlikmph", "cdnapgfjopgaggbmfgbiinmmbdcglnam"]) else bad("display aids not in the safe list")
ok("helper writes only known keys from /password, re-applies the policy, clears on a new quiz") if "Set-Assist $State.quiz_id $r.data.assist" in dmn and "Policy-Relock" in dmn and "Set-Assist $null @()" in dmn and '$AssistKeys = @("readwrite","equatio","cowriter","snapread","readaloud")' in dmn else bad("helper assist handling missing")
ok("helper: no end from the server any more (accommodation added) -> cap never below the 6 h failsafe") if "elseif (($null -eq $r.data.end) -and $State.end_known" in dmn and "[Math]::Max([int64]$State.cap_at" in dmn else bad("end-null cap reset missing")
ok("engine unlock removes the allowance") if 'Remove-Item -LiteralPath "$StateDir\\assist.json"' in eng_src else bad("allowance survives unlock")
# 28 Oct in-app AI: Acrobat / Reader AI Assistant off through the backed-up plan (V op = saved + restored exactly)
ok("browser policy: Acrobat + Reader FeatureLockDown bEnableGentech = 0 via the restorable plan") if 'foreach ($prod in @("Adobe Acrobat","Acrobat Reader")) { V "$PolicyRoot\\Adobe\\$prod\\DC\\FeatureLockDown" "bEnableGentech" 0 }' in pol_src else bad("Acrobat AI Assistant policy missing / not in the plan")
for f in sorted(os.listdir(WIN)):
    if f.endswith(".ps1"):
        b = open(os.path.join(WIN, f), "rb").read()
        ok(f"{f} is plain ASCII") if all(c < 128 for c in b) else bad(f"{f} has non-ASCII bytes (PS 5.1 misreads them)")

# 31 Oct: LOCKqz is listed in Settings > Apps > Installed apps with a working Uninstall (one-line install too),
# and the privacy page says how to uninstall on every system.
inst = open(os.path.join(WIN, "install.ps1")).read(); unin = open(os.path.join(WIN, "uninstall.ps1")).read()
priv = open(os.path.join(WIN, "..", "cloudflare", "public", "privacy.html")).read()
ok("install.ps1 adds the Installed apps entry (skipped for Store + .exe installs, which have their own)") if ("CurrentVersion\\Uninstall\\LOCKqz" in inst and "UninstallString" in inst and "LOCKqz_is1" in inst and "-not $StorePackage" in inst) else bad("Installed apps entry missing in install.ps1")
ok("uninstall.ps1 removes the Installed apps entry") if "CurrentVersion\\Uninstall\\LOCKqz" in unin else bad("uninstall.ps1 leaves the Installed apps entry")
ok("privacy page: uninstall steps for Windows, Mac, Linux, Android") if all(x in priv for x in ("Installed apps", "uninstall.sh | sudo bash", "uninstall-linux.sh | sudo bash", "Android")) else bad("privacy page uninstall steps missing")

print("")
print(f"RESULT: {passed} passed, {failed} failed")
sys.exit(0 if failed == 0 else 1)
