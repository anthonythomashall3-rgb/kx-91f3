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
                      "/password", "Set-Clipboard", "heartbeat", "quiz_left", "/student", "InputBox"])
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
ok("uninstall stops the agent via CIM") if "Get-CimInstance Win32_Process" in uni else bad("uninstall relies on Get-Process .CommandLine (PS5.1 null)")
ok("uninstall stops tasks before unlock") if uni.index("Unregister-ScheduledTask") < uni.index("lockqz.ps1") + uni[uni.index("lockqz.ps1"):].index("unlock") and uni.index("Unregister-ScheduledTask") < uni.index(" unlock") else bad("uninstall unlocks before stopping the watcher")
# #14: no path-style hosts entries written by the engine
ok("engine skips path-style blocklist entries") if '-like "*/*"' in eng_src else bad("engine may write invalid hosts lines with /")
# #5: single-object .Count guarded with @()
ok("agent guards .Count with @()") if "@($wins | Where-Object { Is-Leaving $_.Url }).Count" in open(agt, encoding="utf-8").read() else bad("agent .Count not wrapped in @() (PS5.1 single-object bug)")
# #13: installer reuses an existing token
ok("installer reuses existing token/device") if "keep the key the running helper already uses" in inst else bad("reinstall mints a new token the running helper won't accept")

print("")
print(f"RESULT: {passed} passed, {failed} failed")
sys.exit(0 if failed == 0 else 1)
