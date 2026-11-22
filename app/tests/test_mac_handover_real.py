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
        # The quiz open in a second tab, and a new password (the old tab still says #lqz-in for the first one):
        # both tabs are handed the new password and each answers for it.
        subprocess.Popen([CHROME, "--user-data-dir=" + prof, START], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        t0 = time.time()
        while time.time() - t0 < 30 and len([t for t in A.browser_tabs() if "quiz_start_frame_auto" in t[3]]) < 2: time.sleep(1)
        qt = [t for t in A.browser_tabs() if "quiz_start_frame_auto" in t[3]]
        check(len(qt) == 2, "the quiz is open in two tabs", repr(qt)[:300])
        PW2 = "LQ-ZZ99YY88"
        g.hand = {"pw": PW2, "since": time.time(), "sent": 0.0, "got": False, "in": False, "told": False}
        t0 = time.time()
        while time.time() - t0 < 60 and not g.hand["in"] and not g.hand["told"]:
            g.hand_step([(a, w, t, A.inner_url(u)) for (a, w, t, u) in A.browser_tabs()], time.time()); time.sleep(1)
        qt = [t for t in A.browser_tabs() if "quiz_start_frame_auto" in t[3]]
        time.sleep(3); h = hits()
        check(g.hand["in"] and len(qt) == 2 and all(u.endswith("#lqz-in") for (_, _, _, u) in qt), "a new password reaches both tabs, each answers #lqz-in for it (%d s)" % int(time.time() - t0), repr((g.hand, qt))[:400])
        check(("/pwlog?pw=" + PW2) in h or ("/pwlog?poll=" + PW2) in h, "the pages hold the new password", h[-300:])
        check(not clips and not any(PW2 in m for m in msgs), "still nothing shown or copied", repr((msgs, clips)))
        # A tab is changed only while it still shows the page that was read: another window comes to the front
        # between the read and the change, and the tab now at that place is left alone.
        OTHER = "https://brightspace.usc.edu/d2l/lms/quizzing/admin/other.d2l"
        subprocess.Popen([CHROME, "--user-data-dir=" + prof, "--new-window", OTHER], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        t0 = time.time()
        while time.time() - t0 < 30 and not any(u.startswith(OTHER) for (_, _, _, u) in A.browser_tabs()): time.sleep(1)
        time.sleep(1)
        before = A.browser_tabs(); oth = [x for x in before if x[3].startswith(OTHER)]
        check(len(oth) == 1, "a second window shows another page", repr(before)[:300])
        if oth:
            _, ow, ot, ou = oth[0]
            try: A.osa('var c=Application("Google Chrome"); var w=c.windows(); for (var i=0;i<w.length;i++){ if (w[i].tabs().some(function(t){return String(t.url()).indexOf("quiz_start_frame_auto")>=0;})) { w[i].index = 1; break; } } "ok"')
            except Exception as e: print("  could not reorder the windows: %s" % e, flush=True)
            time.sleep(1); after = A.browser_tabs()
            at = [x for x in after if x[1] == ow and x[2] == ot]
            if at and not at[0][3].startswith(OTHER):
                r = A.set_tab_url("Google Chrome", ow, ot, "about:blank", ou)
                now_tabs = A.browser_tabs()
                check(r is False and not any(u == "about:blank" for (_, _, _, u) in now_tabs) and any(u.startswith(OTHER) for (_, _, _, u) in now_tabs),
                      "windows reordered since the read: the tab now at that place is left alone", repr((r, now_tabs))[:400])
                nw = [x for x in now_tabs if x[3].startswith(OTHER)][0]
                r2 = A.set_tab_url("Google Chrome", nw[1], nw[2], "about:blank", ou)
                time.sleep(1)
                check(r2 is True and any(u == "about:blank" for (_, _, _, u) in A.browser_tabs()), "... and the page that was read is changed at its own place", repr((r2, A.browser_tabs()))[:400])
            else:
                print("  NOTE: the window order did not change here (%r) -- the reorder check is skipped" % (after,), flush=True)
        # Chrome quits and reopens during the quiz with its tabs restored: the restored quiz pages still say
        # #lqz-in in their address, but they are new pages with an empty box (and the extension's memory is
        # gone with the old browser). The agent sees the page gone and back (tick marks the hand "lost").
        chrome.terminate()
        try: chrome.wait(30)
        except Exception: chrome.kill()
        time.sleep(3)
        mark = len(hits())
        chrome = subprocess.Popen([CHROME, "--user-data-dir=" + prof, "--no-first-run", "--no-default-browser-check", "--ignore-certificate-errors",
                                   "--host-resolver-rules=MAP brightspace.usc.edu 127.0.0.1:%d" % PORT, "--restore-last-session"],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        t0 = time.time()
        while time.time() - t0 < 60 and not [t for t in A.browser_tabs() if "quiz_start_frame_auto" in t[3]]: time.sleep(1)
        time.sleep(6)
        qt = [t for t in A.browser_tabs() if "quiz_start_frame_auto" in t[3]]
        empty = ("poll=" + PW2) not in hits()[mark:] and ("pw=" + PW2) not in hits()[mark:]
        print("  after the restart: %d quiz tab(s) %r; their box %s" % (len(qt), [u[-12:] for (_, _, _, u) in qt], "is empty" if empty else "still holds the password"), flush=True)
        check(bool(qt), "Chrome restored the quiz tabs", repr(A.browser_tabs())[:300])
        g.hand["lost"] = True
        t0 = time.time()
        while time.time() - t0 < 60 and (g.hand.get("lost") or not g.hand["in"]) and not g.hand["told"]:
            g.hand_step([(a, w, t, A.inner_url(u)) for (a, w, t, u) in A.browser_tabs()], time.time()); time.sleep(1)
        time.sleep(3); h2 = hits()[mark:]
        check(g.hand["in"] and (("poll=" + PW2) in h2 or ("pw=" + PW2) in h2), "after the restart the restored quiz pages get the password again (%d s)" % int(time.time() - t0), repr((g.hand, h2[-300:]))[:500])
        check(not clips and not any(PW2 in m for m in msgs), "... and nothing is shown or copied", repr((msgs, clips)))
finally:
    chrome.terminate(); srv.terminate()
    subprocess.run(["sudo", "rm", "-f", MP], capture_output=True); subprocess.run(["sudo", "killall", "cfprefsd"], capture_output=True)
print("%d check(s) FAILED" % fail if fail else "all checks passed", flush=True)
sys.exit(1 if fail else 0)
