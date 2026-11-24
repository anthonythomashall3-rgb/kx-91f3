#!/usr/bin/env python3
"""Sweep 36 (24 Nov 2026): web search during a quiz in Firefox (Mac, Linux) and in every Linux browser. Firefox takes a
default-search policy only in its ESR edition, so a search typed in its address bar opens Google's usual results page,
which the quiz policy refuses; LOCKqz cannot send a Firefox tab anywhere from outside, so the AI-free results (Google
Web, udm=14) open in a new tab of that browser, once per search. Firefox writes its open tabs every 2 s during a quiz."""
import importlib.util, json, os, shutil, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); APP = os.path.join(HERE, ".."); MAC = os.path.join(APP, "mac")
ok_n = bad_n = 0
def check(m, c, i=""):
    global ok_n, bad_n
    if c: ok_n += 1; print("  ok:", m)
    else: bad_n += 1; print("  FAIL:", m, ("(%s)" % i) if i else "")
def load(path, name, env=None):
    old = dict(os.environ)
    if env: os.environ.update(env)
    try:
        spec = importlib.util.spec_from_file_location(name, path); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    finally:
        os.environ.clear(); os.environ.update(old)
    return mod
os.environ["HOME"] = tempfile.mkdtemp()
A = load(os.path.join(MAC, "lockqz-agent.py"), "agent_s36")
W = "https://www.google.com/search?udm=14&q="

print("F1 which searches are new (Mac rules)")
s = "https://www.google.com/search?client=firefox-b-d&q=photosynthesis"
tabs = [("Firefox", -1, -1, s), ("Firefox", -1, -1, W + "gdp"), ("Firefox", -1, -1, "https://brightspace.usc.edu/d2l/home"),
        ("Google Chrome", 0, 0, "https://www.google.com/search?q=x")]
got = A.new_gecko_searches(tabs, set(), lambda u: False)
check("a Firefox Google search -> Web results, once", got == [("Firefox", W + "photosynthesis")], got)
check("... not again on the next look (the same tab is still there)", A.new_gecko_searches(tabs, set((a, u) for (a, wi, _, u) in tabs if wi < 0), lambda u: False) == [])
check("Web results, Brightspace and scriptable browsers' tabs (sent on in place) are left alone", all(n[1] != W + "gdp" for n in got) and len(got) == 1)
check("a tab on a blocked AI site is not reopened as a search", A.new_gecko_searches([("Firefox", -1, -1, "https://duckduckgo.com/?q=x")], set(), lambda u: True) == [])
check("DuckDuckGo / Bing in Firefox -> Web", A.new_gecko_searches([("Zen", -1, -1, "https://duckduckgo.com/?q=gdp"), ("Zen", -1, -1, "https://www.bing.com/search?q=gdp")], set(), lambda u: False) == [("Zen", W + "gdp"), ("Zen", W + "gdp")])

print("F2 the browser it opens in (Mac)")
procs = [(11, 50, "/Applications/Firefox Nightly.app/Contents/MacOS/firefox"), (12, 40, "/Applications/Zen.app/Contents/MacOS/zen"),
         (13, 30, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")]
check("Firefox (any channel) -> its running app", A.gecko_app(procs, "Firefox") == "/Applications/Firefox Nightly.app")
check("Zen -> Zen.app", A.gecko_app(procs, "Zen") == "/Applications/Zen.app")
check("not running -> nothing", A.gecko_app(procs, "LibreWolf") is None)
ran = []
class R:
    def __init__(self, rc): self.returncode = rc
real = A.subprocess.run
A.subprocess.run = lambda cmd, **k: (ran.append(cmd), R(0))[1]
check("opened with `open -a <app> <url>` (a new tab of the running browser)", A.open_search(procs, "Firefox", W + "x") and ran[-1] == ["/usr/bin/open", "-a", "/Applications/Firefox Nightly.app", W + "x"], ran)
check("a browser that is not running is never started", A.open_search(procs, "LibreWolf", W + "x") is False and len(ran) == 1)
A.subprocess.run = real

print("F3 Linux: every browser's tabs come from its files; the results open in that browser")
TMP = tempfile.mkdtemp(); STAGE = os.path.join(TMP, "stage"); os.makedirs(STAGE)
mm = load(os.path.join(APP, "release", "make-manifest.py"), "mm36")
for n, rel in mm.LINUX_FILES.items(): shutil.copy2(os.path.join(APP, rel), os.path.join(STAGE, n))
L = load(os.path.join(STAGE, "lockqz-agent.py"), "la36", {"LOCKQZ_TOKEN_DIR": TMP, "LOCKQZ_CONFIG": os.path.join(TMP, "none.json")})
check("the Linux agent puts its own open_search in the shared logic", L.M.open_search is L.open_search)
pop = []
L.subprocess.Popen = lambda cmd, **k: pop.append(cmd)
L._which = lambda b: b in ("firefox", "google-chrome")
check("Firefox -> `firefox --new-tab <url>`", L.open_search([], "Firefox", W + "x") and pop[-1] == ["firefox", "--new-tab", W + "x"], pop)
check("Chrome -> opened in Chrome", L.open_search([], "Google Chrome", W + "x") and pop[-1] == ["google-chrome", W + "x"], pop)
L._which = lambda b: b == "flatpak"
check("a Firefox from Flathub -> `flatpak run org.mozilla.firefox --new-tab <url>`", L.open_search([], "Firefox", W + "x") and pop[-1] == ["flatpak", "run", "org.mozilla.firefox", "--new-tab", W + "x"], pop)
L._which = lambda b: False
check("no such browser here -> nothing", L.open_search([], "Floorp", W + "x") is False)

print("F4 Firefox writes its open tabs every 2 s during a quiz (policy prefs)")
os.environ["LOCKQZ_POLICY_DIR"] = tempfile.mkdtemp(); os.environ["LOCKQZ_POLICY_BACKUP"] = tempfile.mkdtemp()
P = load(os.path.join(MAC, "browser-policy.py"), "bp36")
pref = P.firefox_policy()["Preferences"].get("browser.sessionstore.interval")
check("browser.sessionstore.interval = 2000, locked", pref == {"Value": 2000, "Status": "locked"}, pref)

print("\n%d passed, %d failed" % (ok_n, bad_n))
raise SystemExit(1 if bad_n else 0)
