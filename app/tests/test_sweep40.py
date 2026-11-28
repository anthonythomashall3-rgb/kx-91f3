#!/usr/bin/env python3
"""Bug sweep 40 (28 Nov 2026), the Mac and Linux apps.
  N  "Notes only" with Python and Jupyter open: a notebook on this computer (localhost, 127.0.0.1) opens in Chromium,
     Firefox and Safari (the agent); with the row blocked it does not. An open row's sign-in pages open with it.
  Q  "Also block" never takes the quiz's own site, whatever the school's Brightspace is called.
  H  the rules again with a heartbeat: applied (the lock runs again) only for the quiz the helper holds rules for, only
     while it is locked for it, with the quiz's own site kept; the same rules again change nothing.
"""
import importlib.util, json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__)); APP = os.path.dirname(HERE); MAC = os.path.join(APP, "mac")
P = F = 0
def check(m, c, info=""):
    global P, F
    if c: P += 1; print("  ok:", m)
    else: F += 1; print("  FAIL:", m, ("(%s)" % str(info)[:400]) if info else "")

def load(path, name, env=None):
    old = dict(os.environ)
    if env: os.environ.update(env)
    try:
        spec = importlib.util.spec_from_file_location(name, path); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    finally:
        os.environ.clear(); os.environ.update(old)
    return mod

TMP = tempfile.mkdtemp()
cat = json.load(open(os.path.join(MAC, "rules-catalog.json")))
OFF = [k for k in cat["rows"] if cat["rows"][k]["default"] == "block"]
NOTES = OFF + ["search", "wiki", "web"]
def built(b, block=(), host="brightspace.usc.edu", plat="mac"):
    out = tempfile.mkdtemp(dir=TMP); rf = os.path.join(out, "rules.json")
    json.dump({"quiz_id": "1-2", "rules": {"label": "Custom", "b": list(b), "allow": [], "block": list(block)}, "quiz_host": host}, open(rf, "w"))
    r = subprocess.run([sys.executable, os.path.join(MAC, "rules.py"), "build", rf, os.path.join(MAC, "blocklist.txt"), out, plat], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return out, open(os.path.join(out, "exam-blocklist.txt")).read().split(), json.load(open(os.path.join(out, "exam.json")))

print("N Notes only: a notebook on this computer, the open rows' sign-in pages")
d1, bl1, ex1 = built(NOTES)
check("Python and Jupyter open: localhost and 127.0.0.1 are open sites", "localhost" in ex1["web"] and "127.0.0.1" in ex1["web"], ex1["web"][-6:])
check("never in the hosts list (the helper itself answers on 127.0.0.1)", "localhost" not in bl1 and "127.0.0.1" not in bl1)
d2, bl2, ex2 = built(NOTES + ["python"])
check("Python and Jupyter blocked: no localhost", "localhost" not in ex2["web"] and "127.0.0.1" not in ex2["web"])
d3, bl3, ex3 = built([k for k in NOTES if k not in ("ebooks", "matlab")])
check("e-textbooks and MATLAB allowed: their sites and sign-in pages open (Pearson, VitalSource, Cengage, Kindle's, MathWorks')",
      all(x in ex3["web"] for x in ("plus.pearson.com", "login.pearson.com", "login.vitalsource.com", "login.cengage.com", "amazon.com/ap", "matlab.mathworks.com", "login.mathworks.com")), ex3["web"][-14:])
check("e-textbooks and MATLAB blocked (the default): none of it open", not any(x in ex1["web"] for x in ("plus.pearson.com", "login.pearson.com", "login.mathworks.com", "matlab.mathworks.com")))
check("e-textbooks blocked (the default): their sites are on this exam's list", all(x in bl1 for x in ("plus.pearson.com", "bookshelf.vitalsource.com", "ng.cengage.com", "learning.mheducation.com")))

def policy(d):
    exf, blf = os.path.join(d, "exam.json"), os.path.join(d, "exam-blocklist.txt")
    BP = load(os.path.join(MAC, "browser-policy.py"), "bp%d" % len(os.listdir(TMP)), {"LOCKQZ_EXAM": exf, "LOCKQZ_BLOCKLIST": blf, "LOCKQZ_POLICY_DIR": tempfile.mkdtemp(dir=TMP), "LOCKQZ_POLICY_BACKUP": os.path.join(TMP, "pb")})
    BP.EXAM_FILE = exf
    if os.geteuid() == 0: os.chown(exf, 0, 0)
    c = BP.chromium_policy("com.google.Chrome"); c["URLBlocklist"] = BP._union(c["URLBlocklist"], BP.path_entries() + BP.host_entries()); BP.exam_chromium(c, BP.exam())
    f = BP.firefox_policy(); f["WebsiteFilter"]["Block"] = BP._union(f["WebsiteFilter"]["Block"], BP.firefox_blocks(BP.path_entries(), BP.host_entries())); BP.exam_firefox(f, BP.exam(), BP.all_entries())
    return c, f
c1, f1 = policy(d1)
check("Chromium: localhost and 127.0.0.1 allowed (every port: the filter names no port)", "localhost" in c1["URLAllowlist"] and "127.0.0.1" in c1["URLAllowlist"] and c1["URLBlocklist"][0] == "*")
exc = f1["WebsiteFilter"]["Exceptions"]
check("Firefox: exactly localhost and 127.0.0.1 (no '*.' in front)", "*://localhost/*" in exc and "*://127.0.0.1/*" in exc and "*://*.localhost/*" not in exc and "*://*.127.0.0.1/*" not in exc, [x for x in exc if "local" in x or "127" in x])
c2, f2 = policy(d2)
check("Python blocked: neither browser opens localhost", "localhost" not in c2["URLAllowlist"] and not any("localhost" in x for x in f2["WebsiteFilter"]["Exceptions"]))

AG = load(os.path.join(MAC, "lockqz-agent.py"), "lq_ag40", {"LOCKQZ_EXAM_DIR": TMP})
h, p = AG.parse_blocklist(bl1)
v1 = AG.exam_view(ex1, "https://brightspace.usc.edu/d2l/lms/quizzing/user/quiz_summary.d2l?qi=2&ou=1")
check("Safari (the agent): a Jupyter tab on localhost or 127.0.0.1 is left open; an article is blanked",
      not AG.blocked_tab("http://localhost:8888/tree?token=x", h, p, v1) and not AG.blocked_tab("http://127.0.0.1:8889/lab", h, p, v1)
      and AG.blocked_tab("https://www.nytimes.com/x", h, p, v1) and not AG.blocked_tab("https://brightspace.usc.edu/d2l/home", h, p, v1))
h2, p2 = AG.parse_blocklist(bl2)
v2 = AG.exam_view(ex2, "https://brightspace.usc.edu/d2l/home")
check("Safari with Python blocked: the localhost tab is blanked", AG.blocked_tab("http://localhost:8888/tree", h2, p2, v2))

print("Q 'Also block' never takes the quiz's own site")
_, blq, exq = built(OFF + ["web"], block=["brightspace.usc.edu", "usc.edu", "khanacademy.org"], host="brightspace.usc.edu")
check("the quiz's own site and its parent domain never join the list; an ordinary site does", "brightspace.usc.edu" not in blq and "usc.edu" not in blq and "khanacademy.org" in blq)
check("and the quiz's own site stays an open site", "brightspace.usc.edu" in exq["web"])
_, blo, _ = built(OFF, block=["lms.other.edu"], host="lms.other.edu")
check("another school's Brightspace (the quiz's host) the same", "lms.other.edu" not in blo)

print("H the rules again with a heartbeat")
lf = tempfile.mkdtemp(dir=TMP)
H = load(os.path.join(MAC, "lockqzd.py"), "lq_h40", {"LOCKQZ_LOCKFILE": os.path.join(lf, "active_lock.json"), "LOCKQZ_DRYRUN": "1", "LOCKQZ_TOKEN_FILE": os.path.join(lf, "t"),
                                                    "LOCKQZ_TOKEN_DIR": os.path.join(lf, "td"), "LOCKQZ_KEY_PATH": os.path.join(lf, "k")})
runs = []
H.engine = lambda c: runs.append(c) or True
R1 = {"v": 1, "label": "Notes + internet", "b": OFF, "allow": [], "block": []}
R2 = {"v": 1, "label": "Custom", "b": [k for k in OFF if k != "calls"], "allow": [], "block": []}
H.STATE.update(state="locked", quiz_id="1-2")
check("no rules held yet (no password for this quiz): a heartbeat's rules are not taken", H.beat_rules("1-2", R1) is False and not os.path.exists(H.RULES_FILE) and runs == [])
H.set_rules("1-2", R1, "https://brightspace.usc.edu/d2l/lms/quizzing/user/quiz_summary.d2l?qi=2&ou=1")
check("the same rules again: nothing done", H.beat_rules("1-2", R1) is False and runs == [])
check("changed during the exam (video calls allowed): saved, the lock runs again at once", H.beat_rules("1-2", R2) is True and runs == ["lock"]
      and "calls" not in json.load(open(H.RULES_FILE))["rules"]["b"])
check("the quiz's own site is kept", json.load(open(H.RULES_FILE))["quiz_host"] == "brightspace.usc.edu")
check("rules for another quiz: ignored", H.beat_rules("9-9", R1) is False and runs == ["lock"])
H.STATE.update(state="unlocked")
check("not locked any more: ignored", H.beat_rules("1-2", R1) is False and runs == ["lock"])
H.STATE.update(state="locked")
check("bad rules (no list of rows): ignored, the held rules stay", H.beat_rules("1-2", {"label": "x"}) is False and "calls" not in json.load(open(H.RULES_FILE))["rules"]["b"])
src = open(os.path.join(MAC, "lockqzd.py")).read()
check("the heartbeat's answer is read for rules (never an unlock answer's)", 'elif event == "heartbeat" and isinstance(j, dict) and isinstance(j.get("rules"), dict):' in src)
ps = open(os.path.join(APP, "windows", "lockqzd.ps1")).read()
lib = ps[ps.index("$SignLib = @'"):ps.index("'@\n. ([ScriptBlock]::Create($SignLib))")]
check("Windows: the same (LQ-BeatRules in the code the watcher loads, the lists then the browser policy run again)",
      "function LQ-BeatRules" in lib and "function LQ-RulesRecord" in lib and "LQ-BeatRules $hq $hr.data.rules $rulesFile" in ps and 'WEngine "lock"' in ps)

print("\n%d passed, %d failed" % (P, F))
sys.exit(1 if F else 0)
