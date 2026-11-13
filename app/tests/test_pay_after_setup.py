#!/usr/bin/env python3
"""The pay page opens by itself right after setup (13 Nov 2026), on Mac, Linux and Windows. No root, no browser.
  A1 Mac / Linux agent: setup just finished and the fee is unpaid -> the student's own pay page is opened, once;
     paid, no fee, no answer, or an address that is not LOCKqz's -> nothing opens;
  A2 a student who was already set up is never shown it again by a later check (it comes at the exam instead);
  A3 Linux opens it with the desktop's own opener; Windows does the same steps in its setup window.
"""
import importlib.util, os, re, sys, tempfile, time
HERE = os.path.dirname(os.path.abspath(__file__)); APP = os.path.join(HERE, "..")
PASS = FAIL = 0
def check(m, c, extra=""):
    global PASS, FAIL
    if c: PASS += 1; print("  ok:", m)
    else: FAIL += 1; print("  FAIL:", m, extra)
os.environ["HOME"] = tempfile.mkdtemp()
spec = importlib.util.spec_from_file_location("lockqz_agent_pas", os.path.join(APP, "mac", "lockqz-agent.py"))
A = importlib.util.module_from_spec(spec); spec.loader.exec_module(A)
A.USER_DIR = os.path.join(os.environ["HOME"], "lq"); os.makedirs(A.USER_DIR, exist_ok=True); A.USER_CONF = os.path.join(A.USER_DIR, "student.json")

def agent(status, verified=False):
    a = object.__new__(A.Agent)
    a.student, a.verified, a.quiz = None, verified, None
    a.id_busy, a.id_tried, a.id_next, a.id_fails, a.id_state = False, 0.0, 0.0, 0, {}
    a.opened = []; a.open_page = lambda u: a.opened.append(u)
    a.verify_call = lambda op, **k: dict(status) if op == "status" else {}
    a.helper = lambda path, body=None, timeout=90: {}
    return a
LINK = "https://lockqz.com/pay?email=al%40usc.edu&t=" + "a" * 32
UNPAID = {"status": 200, "student": "al@usc.edu", "verified": True, "paid": False, "pay_url": LINK}

print("A1 right after setup")
a = agent(UNPAID); a.pay_after_setup()
check("fee unpaid: the student's own pay page is opened", a.opened == [LINK], str(a.opened))
for label, st in [("paid", dict(UNPAID, paid=True, pay_url=None)), ("no answer from the server", {}), ("not confirmed", dict(UNPAID, verified=False)),
                  ("an address that is not LOCKqz's", dict(UNPAID, pay_url="https://lockqz.com.evil.example/pay")), ("a plain http address", dict(UNPAID, pay_url="http://lockqz.com/pay"))]:
    a = agent(st); a.pay_after_setup()
    check("%s: nothing opens" % label, a.opened == [], str(a.opened))
def boom(u): raise OSError("no browser")
a = agent(UNPAID); a.open_page = boom; a.pay_after_setup()
check("a browser that cannot be opened never stops the agent", True)

print("A2 the setup flow")
def run_setup(a, got):
    A.setup_identity = lambda call, ui, saved="", save=None, state=None: got
    A.MacUI = lambda: None
    a.ensure_identity(force=True)
    for _ in range(100):
        if not a.id_busy: break
        time.sleep(0.02)
a = agent(UNPAID); run_setup(a, ("al@usc.edu", True))
check("the email was just confirmed: the pay page opens, once", a.verified and a.opened == [LINK], str(a.opened))
run_setup(a, ("al@usc.edu", True))
check("a later check of a student who is already set up opens nothing more", a.opened == [LINK], str(a.opened))
a = agent(UNPAID); run_setup(a, ("al@usc.edu", False))
check("an email that is not confirmed yet opens nothing", a.opened == [], str(a.opened))
a = agent(UNPAID); run_setup(a, None)
check("a closed setup window opens nothing", a.opened == [], str(a.opened))

print("A3 Linux and Windows")
lx = open(os.path.join(APP, "linux", "lockqz-agent.py")).read()
check("Linux: the same flow (it is the Mac agent's), opened with xdg-open", re.search(r'class Agent\(M\.Agent\):', lx) is not None and re.search(r'def open_page\(self, u\):\n\s+subprocess\.run\(\["xdg-open", u\]', lx) is not None and "def ensure_identity" not in lx and "def pay_after_setup" not in lx)
mac = open(os.path.join(APP, "mac", "lockqz-agent.py")).read()
check("Mac: opened with the system's opener; the exam-time pay page uses the same opener", re.search(r'def open_page\(self, u\):\n\s+subprocess\.run\(\["open", u\], timeout=10\)', mac) is not None and "try: self.open_page(u)" in mac)
ps = open(os.path.join(APP, "windows", "lockqz-agent.ps1"), encoding="utf-8-sig").read()
check("Windows: setup just finished and unpaid -> Start-Process on the student's LOCKqz pay page only",
      re.search(r'function Open-PayAfterSetup \{.*?\$st = Verify "status" \$null.*?\(\$st\.paid -is \[bool\]\) -and \(-not \$st\.paid\) -and \$st\.pay_url.*?\$u\.StartsWith\("https://lockqz\.com/"\) -or \$u\.StartsWith\("https://lockqz\.pages\.dev/"\)\) \{ Start-Process \$u', ps, re.S) is not None
      and 'if ($got.verified -and (-not $wasVerified)) { Open-PayAfterSetup }' in ps and '$wasVerified = $false; try { $wasVerified = [bool]$sj.verified } catch {}' in ps)
print("\nRESULT: %d passed, %d failed" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
