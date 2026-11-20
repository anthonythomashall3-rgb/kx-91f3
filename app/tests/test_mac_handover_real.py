"""Real-Mac test of the quiz password hand-over: real Google Chrome, LOCKqz's extension added by the
browser's managed list exactly as browser-policy.py adds it during a quiz (from the Chrome Web Store), a
stand-in Brightspace at brightspace.usc.edu (TLS, mapped to 127.0.0.1), and the agent's OWN browser_tabs()
and hand_step() talking to Chrome through Apple Events. Needs a Mac with Chrome, sudo (the managed list)
and Automation allowed for the shell (GitHub's Mac runners; a student's Mac asks once).

  python3 test_mac_handover_real.py
"""
import importlib.util, json, os, plistlib, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, "..", "mac", file))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
A = load("lqz_agent", "lockqz-agent.py"); P = load("lqz_policy", "browser-policy.py")
logs, msgs, clips = [], [], []
A.log = lambda m: logs.append(m); A.dialog = lambda m, *a, **k: msgs.append(m); A.clipboard = lambda t, *a, **k: clips.append(t)
fail = 0
def check(ok, what, got=""):
    global fail
    print(("  ok   " if ok else "  FAIL ") + what + ("" if ok or not got else "  -> %s" % (got,)), flush=True)
    if not ok: fail += 1

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
tmp = tempfile.mkdtemp(prefix="lqz-hand-")
HITS = os.path.join(tmp, "hits.log"); open(HITS, "w").close()
for c in (["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=brightspace.usc.edu", "-days", "1",
           "-keyout", os.path.join(tmp, "k.pem"), "-out", os.path.join(tmp, "c.pem")],):
    subprocess.run(c, check=True, capture_output=True)
import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); PORT = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable, os.path.join(HERE, "fake_content_server.py"), str(PORT), HITS, os.path.join(tmp, "c.pem"), os.path.join(tmp, "k.pem")])

# The managed list, as browser-policy.py writes it for a quiz (only the extension key here).
MP = "/Library/Managed Preferences/com.google.Chrome.plist"
pol = {"ExtensionInstallForcelist": P.chromium_policy("com.google.Chrome")["ExtensionInstallForcelist"]}
with open(os.path.join(tmp, "p.plist"), "wb") as f: plistlib.dump(pol, f)
subprocess.run(["sudo", "mkdir", "-p", "/Library/Managed Preferences"], check=True)
subprocess.run(["sudo", "cp", os.path.join(tmp, "p.plist"), MP], check=True); subprocess.run(["sudo", "chmod", "644", MP], check=True)
subprocess.run(["sudo", "killall", "cfprefsd"], capture_output=True); time.sleep(2)

START = "https://brightspace.usc.edu/d2l/lms/quizzing/user/quiz_start_frame_auto.d2l?ou=123&isprv=&qi=77&cfql=0&dnb=0"
prof = os.path.join(tmp, "profile")
chrome = subprocess.Popen([CHROME, "--user-data-dir=" + prof, "--no-first-run", "--no-default-browser-check", "--ignore-certificate-errors",
                           "--host-resolver-rules=MAP brightspace.usc.edu 127.0.0.1:%d" % PORT, START],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
def hits(): return open(HITS).read()
def ext_version():
    import glob
    d = glob.glob(os.path.join(prof, "*", "Extensions", P.PW_EXT, "*"))
    return os.path.basename(d[0]) if d else ""
try:
    t0 = time.time()
    while time.time() - t0 < 60 and "document /d2l/lms/quizzing/user/quiz_start" not in hits(): time.sleep(1)
    check("document /d2l/lms/quizzing/user/quiz_start" in hits(), "the quiz's start page loaded in real Chrome (before the extension is there)")
    # Apple Events: the agent's own tab list.
    tabs = []
    t0 = time.time()
    while time.time() - t0 < 30:
        tabs = [t for t in A.browser_tabs() if "quiz_start_frame_auto" in t[3]]
        if tabs: break
        time.sleep(1)
    if not tabs:
        try: print("  osa says: %r" % A.osa('JSON.stringify(Application("Google Chrome").windows().map(w=>w.tabs().map(t=>t.url())))'), flush=True)
        except Exception as e: print("  osa error: %s" % e, flush=True)
        print("  running apps: %r" % sorted(A.running_apps())[:40], flush=True)
    check(bool(tabs), "the agent sees the quiz tab through Apple Events", repr(A.browser_tabs())[:300] + " " + repr(logs[-3:]))
    PW = "LQ-AB12CD34"
    g = A.Agent(); g.locked, g.quiz, g.quiz_app = True, A.lock_id(START), "Google Chrome"
    g.hand = {"pw": PW, "since": time.time(), "sent": 0.0, "got": False, "in": False, "told": False}
    t0 = time.time(); seen = set()
    while time.time() - t0 < 100 and not g.hand["in"] and not g.hand["told"]:
        tabs = [(a, w, t, A.inner_url(u)) for (a, w, t, u) in A.browser_tabs()]
        for (_, _, _, u) in tabs:
            if A.hand_fragment(u): seen.add(A.hand_fragment(u).split("=")[0])
        g.hand_step(tabs, time.time())
        time.sleep(1)
    took = int(time.time() - t0)
    v = ext_version()
    print("  extension from the store: %r; answers seen in the address: %s; %d s" % (v, sorted(seen), took), flush=True)
    check(bool(v), "Chrome added LOCKqz's extension from its managed list (no click)", v)
    vt = tuple(int(x) for x in (v.split("_")[0].split(".") if v else ["0"]))
    if vt < (1, 0, 13):
        print("  NOTE: the store still has %s (1.0.13 is in review): this version cannot enter a password." % (v or "nothing"), flush=True)
        check(g.hand["told"] and clips == [PW] and any(PW in m for m in msgs), "an older extension: after 30 s the password is shown and copied, as before", repr((g.hand, clips)))
        check("#lqz=" not in "".join(u for (_, _, _, u) in A.browser_tabs()), "... and it is taken out of the address", repr(A.browser_tabs())[:300])
    else:
        check(g.hand["in"], "the extension answered #lqz-in: the password is in the page's box (%d s after the lock)" % took, repr(g.hand))
        time.sleep(3); h = hits()
        check(("/pwlog?pw=" + PW) in h or ("/pwlog?poll=" + PW) in h, "the page really holds the password", h[-400:])
        check("/pwlog?text=" not in h, "the other box on the page is untouched")
        check(not clips and not any(PW in m for m in msgs), "nothing was shown or copied", repr((msgs, clips)))
        check("#lqz=" not in "".join(u for (_, _, _, u) in A.browser_tabs()), "the password is no longer in the address", repr(A.browser_tabs())[:300])
        check(not any("professor.lockqz.com" in u for (_, _, _, u) in A.browser_tabs()), "no dashboard tab was opened on the student's browser", repr(A.browser_tabs())[:300])
finally:
    chrome.terminate(); srv.terminate()
    subprocess.run(["sudo", "rm", "-f", MP], capture_output=True); subprocess.run(["sudo", "killall", "cfprefsd"], capture_output=True)
print("%d check(s) FAILED" % fail if fail else "all checks passed", flush=True)
sys.exit(1 if fail else 0)
