#!/usr/bin/env python3
"""Sweep 24 (apps): an unpaid student at an exam gets the quiz password within seconds of paying.
  A1 Mac / Linux agent: while unpaid, /password is asked again at the server's pace (recheck, 2..15 s) for the
     first 10 minutes after the pay page opened, then every 15 s; an older server (no recheck) = 15 s;
  A2 the pace starts over with each quiz; the password answer still follows its own schedule;
  A3 Windows agent does the same steps.
"""
import importlib.util, os, re, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); APP = os.path.join(HERE, "..")
PASS = FAIL = 0
def check(m, c, extra=""):
    global PASS, FAIL
    if c: PASS += 1; print("  ok:", m)
    else: FAIL += 1; print("  FAIL:", m, extra)
os.environ["HOME"] = tempfile.mkdtemp()
spec = importlib.util.spec_from_file_location("lockqz_agent_s24", os.path.join(APP, "mac", "lockqz-agent.py"))
A = importlib.util.module_from_spec(spec); spec.loader.exec_module(A)
said = []; A.dialog = lambda t, *a, **k: said.append(t); A.clipboard = lambda t: None; A.developer_mode = lambda: False

def agent():
    a = object.__new__(A.Agent)
    a.pw, a.pw_next, a.start_told, a.quiz, a.busy_n = None, 0.0, None, "1-2", 0
    a.pay_shown, a.pay_since = False, 0
    a.opened = []; a.open_page = lambda u: a.opened.append(u)
    return a
PAY = {"url": "https://lockqz.com/pay?email=al%40usc.edu&t=" + "a" * 32, "line": "$200 by Zelle, or $210 by card or Venmo", "code": "LQSAB12C", "zelle": "x"}
UNPAID = {"password": None, "status": 402, "pay": PAY, "recheck": 3}

print("A1 unpaid at the exam")
a = agent(); T = 1000.0
check("first answer: pay page opened once, asked again in 3 s", a.pw_reply(dict(UNPAID), T, first=True) == "pay" and a.opened == [PAY["url"]] and a.pw_next == T + 3, str(a.pw_next - T))
a.pw_reply(dict(UNPAID), T + 3)
check("still unpaid: 3 s again, the page is not opened twice", a.pw_next == T + 6 and len(a.opened) == 1)
a.pw_reply(dict(UNPAID), T + A.PAY_FAST - 1)
check("just under 10 minutes: still fast", a.pw_next == T + A.PAY_FAST - 1 + 3)
a.pw_reply(dict(UNPAID), T + A.PAY_FAST + 1)
check("after 10 minutes: every 15 s", a.pw_next == T + A.PAY_FAST + 1 + 15)
for label, rc, want in [("an older server (no recheck)", None, 15), ("recheck 1 -> at least 2 s", 1, 2), ("recheck 60 -> at most 15 s", 60, 15), ("recheck true (not a number)", True, 15), ("recheck text", "3", 15)]:
    b = agent(); r = dict(UNPAID); r.pop("recheck"); 
    if rc is not None: r["recheck"] = rc
    b.pw_reply(r, T)
    check("%s: %d s" % (label, want), b.pw_next == T + want, str(b.pw_next - T))

print("A2 the payment lands")
n = len(said)
check("the next answer carries the password: shown, copied", a.pw_reply({"password": "LQ-PW1", "status": 200}, T + 700) == "pw" and a.pw == "LQ-PW1" and len(said) == n + 1 and "LQ-PW1" in said[-1])
check("password answers keep their own 15 s schedule", a.pw_next == T + 715)
src = open(os.path.join(APP, "mac", "lockqz-agent.py"), encoding="utf-8").read()
check("each new quiz starts the fast pace over", "self.pw, self.pay_shown, self.pay_since, res = None, False, 0, None" in src)
L = open(os.path.join(APP, "linux", "lockqz-agent.py"), encoding="utf-8").read()
check("Linux uses the Mac agent's schedule (no pw_reply of its own)", "def pw_reply" not in L)

print("A3 Windows")
W = open(os.path.join(APP, "windows", "lockqz-agent.ps1"), encoding="utf-8").read()
m = re.search(r"if \(Show-Pay \$pr\) \{(.*?)return \"pay\"\s*\}", W, re.S)
blk = m.group(1) if m else ""
check("unpaid: the server's pace, 2..15 s, for the first 600 s", "$pr.recheck" in blk and "[Math]::Max(2, [Math]::Min(15, $prn))" in blk and "-lt 600" in blk and "$script:PwNext = $now.AddSeconds($prc)" in blk, blk[:200])
check("no recheck / after 10 minutes: 15 s", "$prc = 15" in blk)
check("each new quiz starts the fast pace over", "$script:PayShown = $false; $script:PaySince = $null" in W)
H = open(os.path.join(APP, "windows", "lockqzd.ps1"), encoding="utf-8").read(); P = open(os.path.join(APP, "mac", "lockqzd.py"), encoding="utf-8").read()
check("both helpers hand the server's recheck to the agent", '$out.recheck = $r.data.recheck' in H and 'out["recheck"] = j["recheck"]' in P)

print("\nSweep 24 (apps): %d passed, %d failed" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
