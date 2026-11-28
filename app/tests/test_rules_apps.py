#!/usr/bin/env python3
"""Exam rules on the Mac and Linux (27 Nov 2026): the professor's rules become this exam's lists.
  A  rules.py: a blocked row's programs and sites join the lists, an allowed row's own entries leave them (no other
     entry ever does), the professor's sites and programs (never the system, a browser, the exam or sign-in), all other
     websites blocked = only the open sites; unreadable rules = nothing written (the engine locks as before)
  B  browser policy (Mac file, used by Linux too): no web search, no translation, only the open sites ("*" in Chromium,
     <all_urls> in Firefox; a site with a blocked part is never an exception in Firefox)
  C  Linux policy files and the Linux engine (dry run) read this exam's lists
  D  the agent blanks what the exam does not open (Safari's block), keeps the quiz's own site, says what stays open
  E  the helper keeps the rules root-only, only known keys, and drops them at unlock / a new quiz
"""
import importlib.util, json, os, shutil, stat, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__)); APP = os.path.dirname(HERE)
MAC, LINUX = os.path.join(APP, "mac"), os.path.join(APP, "linux")
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
R = load(os.path.join(MAC, "rules.py"), "lq_rules")
cat = R.catalog()
base = open(os.path.join(MAC, "blocklist.txt")).readlines()
OFF = [k for k in cat["rows"] if cat["rows"][k]["default"] == "block"]
def rules_file(b, allow=(), block=(), label="Custom", host="usc.brightspace.com"):
    p = os.path.join(TMP, "rules-%d.json" % len(os.listdir(TMP)))
    json.dump({"quiz_id": "1-2", "rules": {"label": label, "b": list(b), "allow": list(allow), "block": list(block)}, "quiz_host": host}, open(p, "w"))
    return p
def built(b, allow=(), block=(), plat="mac", label="Custom", host="usc.brightspace.com"):
    out = os.path.join(TMP, "out-%d" % len(os.listdir(TMP))); os.makedirs(out)
    r = subprocess.run([sys.executable, os.path.join(MAC, "rules.py"), "build", rules_file(b, allow, block, label, host), os.path.join(MAC, "blocklist.txt"), out, plat], capture_output=True, text=True)
    if r.returncode: return r, None, None, None
    bl = open(os.path.join(out, "exam-blocklist.txt")).read().split()
    apps = [tuple(l.split("\t")) for l in open(os.path.join(out, "exam-apps.txt")).read().splitlines()]
    return r, bl, apps, json.load(open(os.path.join(out, "exam.json")))

print("A rules.py")
r, bl, apps, ex = built(OFF, label="Notes + internet")
ai = [l.strip().lower() for l in base if l.strip() and not l.startswith("#")]
check("default rules: every AI entry stays; Zoom, Gmail, iMessage-type sites added", r.returncode == 0 and set(ai) <= set(bl) and all(x in bl for x in ("zoom.us", "mail.google.com", "messages.google.com", "tiktok.com")), r.stderr)
check("default rules: Messages, Mail, zoom.us, Microsoft Teams closed; Word, Excel kept", ("close", "Messages") in apps and ("close", "Mail") in apps and ("close", "zoom.us") in apps
      and ("close", "Microsoft Teams") in apps and ("keep", "Microsoft Word") in apps and ("keep", "Microsoft Excel") in apps)
check("exam.json: search and translators per rows, no open-sites list while websites are open", ex == {"v": 1, "label": "Notes + internet", "b": sorted(OFF), "web": None, "search": True, "translate": False}, ex)
r, bl, apps, ex = built([k for k in OFF if k not in ("youtube", "homework", "chat")])
check("YouTube, homework help and chat apps allowed: exactly their own entries leave the list", not any(x in bl for x in ("youtube.com/watch", "quizlet.com", "chegg.com", "slack.com", "discord.com"))
      and all(x in bl for x in ("chatgpt.com", "claude.ai", "x.com/i/grok", "deepl.com/write", "translate.goog")) and len(set(ai) - set(bl)) == len([e for k in ("youtube", "homework", "chat") for e in cat["rows"][k]["hosts"] + cat["rows"][k]["paths"] if e in ai]), sorted(set(ai) - set(bl))[:12])
check("chat allowed: Slack and Discord kept open (they are on LOCKqz's own list)", ("keep", "Slack") in apps and ("keep", "Discord") in apps and ("close", "Slack") not in apps)
r, bl, apps, ex = built(OFF + ["search", "wiki", "web"], label="Notes only")
check("Notes only: web search engines added (google.com/search, bing.com), only the open sites listed",
      "google.com/search" in bl and "bing.com" in bl and isinstance(ex["web"], list) and ex["search"] is False)
check("Notes only: open = Brightspace, sign-in, LOCKqz, Docs, Drive, OneDrive, Desmos, a notebook on this computer, the quiz's site; not Wikipedia, not YouTube, not e-textbooks (AI inside)",
      all(x in ex["web"] for x in ("brightspace.com", "accounts.google.com", "lockqz.com", "docs.google.com/document", "docs.google.com", "drive.google.com", "sharepoint.com", "desmos.com", "localhost", "127.0.0.1"))
      and not any(x in ex["web"] for x in ("wikipedia.org", "en.wikipedia.org", "youtube.com/watch", "bookshelf.vitalsource.com", "plus.pearson.com")), ex["web"])
r, bl, apps, ex = built(OFF + ["web", "excel"], allow=["investopedia.com", "x.com", "m.facebook.com"], block=["Spotify", "khanacademy.org", "Finder", "brightspace.com", "google.com", "Safari.app", "chrome.exe", "Steam.app"])
check("typed sites: khanacademy.org blocked; brightspace.com and google.com never (exam, sign-in)", "khanacademy.org" in bl and "brightspace.com" not in bl and "google.com" not in bl)
check("typed programs: Spotify and Steam closed; Finder, Safari, Chrome never", ("typed", "Spotify") in apps and ("typed", "Steam") in apps and not any(a[1].lower() in ("finder", "safari", "chrome") for a in apps if a[0] == "typed"), apps[-6:])
check("Excel blocked: Microsoft Excel closed, its web addresses listed", ("close", "Microsoft Excel") in apps and "excel.officeapps.live.com" in bl)
check("open sites: investopedia.com yes; x.com and m.facebook.com (blocked social media) never", "investopedia.com" in ex["web"] and "x.com" not in ex["web"] and "m.facebook.com" not in ex["web"], ex["web"][-5:])
check("web search open (custom): search engines not added", "bing.com" not in bl and ex["search"] is True)
r, bl, apps, ex = built(OFF + ["web"], host="lms.otherschool.edu")
check("another school's quiz site stays open when all other websites are blocked", "lms.otherschool.edu" in ex["web"], ex["web"][-3:])
r, bl, apps, ex = built(OFF + ["chat", "bogus", "../../etc"], plat="linux")
check("Linux names; unknown keys ignored", ("close", "discord") in apps and "bogus" not in ex["b"] and "../../etc" not in ex["b"], ex["b"])
out = os.path.join(TMP, "bad"); os.makedirs(out); open(os.path.join(TMP, "bad.json"), "w").write("{not json")
r = subprocess.run([sys.executable, os.path.join(MAC, "rules.py"), "build", os.path.join(TMP, "bad.json"), os.path.join(MAC, "blocklist.txt"), out, "mac"], capture_output=True, text=True)
check("unreadable rules: exit 1, nothing written", r.returncode == 1 and os.listdir(out) == [], os.listdir(out))
check("rules.py compiles on python 3.9 syntax (Apple's Command Line Tools)", not load(os.path.join(APP, "release", "make-manifest.py"), "mm").py39_problems(open(os.path.join(MAC, "rules.py")).read(), "rules.py"))

print("B browser policy")
_, bl, _, ex = built(OFF + ["search", "wiki", "web"], allow=["investopedia.com"], label="Notes only")
exf = os.path.join(TMP, "exam-notes.json"); json.dump(ex, open(exf, "w")); os.chmod(exf, 0o644)
blf = os.path.join(TMP, "exam-notes.txt"); open(blf, "w").write("\n".join(bl) + "\n")
pd = os.path.join(TMP, "pol"); os.makedirs(pd)
BP = load(os.path.join(MAC, "browser-policy.py"), "lq_bp", {"LOCKQZ_EXAM": exf, "LOCKQZ_BLOCKLIST": blf, "LOCKQZ_POLICY_DIR": pd, "LOCKQZ_POLICY_BACKUP": os.path.join(TMP, "pb")})
BP.EXAM_FILE = exf
if os.geteuid() == 0: os.chown(exf, 0, 0)
c = BP.chromium_policy("com.google.Chrome"); c["URLBlocklist"] = BP._union(c["URLBlocklist"], BP.path_entries() + BP.host_entries()); BP.exam_chromium(c, BP.exam())
check("Chromium: '*' blocked, the open sites and local files allowed, no Google 'Web' results, translation off",
      c["URLBlocklist"][0] == "*" and "chatgpt.com" in c["URLBlocklist"] and "brightspace.com" in c["URLAllowlist"] and "investopedia.com" in c["URLAllowlist"]
      and "file://*" in c["URLAllowlist"] and not any("udm=14" in x for x in c["URLAllowlist"]) and c.get("TranslateEnabled") is False, c["URLAllowlist"][:8])
check("Chromium: the AI pages under an open site stay blocked by the more specific entry (m365.cloud.microsoft/chat)", "m365.cloud.microsoft/chat" in c["URLBlocklist"] and "m365.cloud.microsoft" in c["URLAllowlist"])
check("Chromium: within the 1,000-entry limit", len(c["URLBlocklist"]) <= 1000 and len(c["URLAllowlist"]) <= 1000, (len(c["URLBlocklist"]), len(c["URLAllowlist"])))
f = BP.firefox_policy(); f["WebsiteFilter"]["Block"] = BP._union(f["WebsiteFilter"]["Block"], BP.firefox_blocks(BP.path_entries(), BP.host_entries())); BP.exam_firefox(f, BP.exam(), BP.all_entries())
exc = f["WebsiteFilter"]["Exceptions"]
check("Firefox: <all_urls> blocked, open sites as exceptions, local files open, translations off",
      f["WebsiteFilter"]["Block"][0] == "<all_urls>" and "*://*.brightspace.com/*" in exc and "*://*.investopedia.com/*" in exc and "file:///*" in exc
      and f["Preferences"]["browser.translations.enable"]["Value"] is False and not any("udm=14" in x for x in exc), exc[:6])
check("Firefox: a site with a blocked part is not an exception (m365.cloud.microsoft has /chat), a path is exact (docs.google.com/document)",
      not any("m365.cloud.microsoft" in x for x in exc) and "*://*.docs.google.com/document*" in exc, [x for x in exc if "google" in x or "m365" in x])
BP.EXAM_FILE = ""
c0 = BP.chromium_policy("com.google.Chrome"); BP.exam_chromium(c0, BP.exam())
check("no rules: the policy is unchanged (Google 'Web' results, no '*')", "*" not in c0["URLBlocklist"] and any("udm=14" in x for x in c0["URLAllowlist"]) and "TranslateEnabled" not in c0)
_, bl2, _, ex2 = built(OFF + ["search"])
exf2 = os.path.join(TMP, "exam-nosearch.json"); json.dump(ex2, open(exf2, "w")); BP.EXAM_FILE = exf2
if os.geteuid() == 0: os.chown(exf2, 0, 0)
c2 = BP.chromium_policy("com.google.Chrome"); BP.exam_chromium(c2, BP.exam())
f2 = BP.firefox_policy(); BP.exam_firefox(f2, BP.exam(), [])
check("web search blocked, websites open: no Google 'Web' results exception, no '*'", not any("udm" in x for x in c2["URLAllowlist"]) and "*" not in c2["URLBlocklist"]
      and f2["WebsiteFilter"]["Exceptions"] == [] and "<all_urls>" not in f2["WebsiteFilter"]["Block"])
if os.geteuid() == 0:
    os.chmod(exf2, 0o666); BP.EXAM_FILE = exf2
    check("an exam file anyone can write is ignored (root)", BP.exam() == {})

print("C Linux")
stage = os.path.join(TMP, "lx"); os.makedirs(stage)
mm = load(os.path.join(APP, "release", "make-manifest.py"), "mm2")
for n, rel in mm.LINUX_FILES.items(): shutil.copy2(os.path.join(APP, rel), os.path.join(stage, n))
check("the release carries rules.py and the catalog on every platform", "rules.py" in mm.LINUX_FILES and "rules-catalog.json" in mm.LINUX_FILES and "rules.py" in mm.MAC_FILES
      and "rules-catalog.json" in mm.MAC_FILES and "rules-catalog.json" in mm.WIN_FILES)
root = os.path.join(TMP, "lroot")
LP = load(os.path.join(stage, "browser-policy.py"), "lq_lp", {"LOCKQZ_POLICY_ROOT": root, "LOCKQZ_STATE": os.path.join(TMP, "lst"), "LOCKQZ_EXAM": exf, "LOCKQZ_BLOCKLIST": blf})
if os.geteuid() == 0: os.chown(exf, 0, 0)
old = dict(os.environ); os.environ.update({"LOCKQZ_EXAM": exf, "LOCKQZ_BLOCKLIST": blf})
try: ok = LP.lock()
finally: os.environ.clear(); os.environ.update(old)
cj = json.load(open(os.path.join(root, "etc/opt/chrome/policies/managed/zz-lockqz.json")))
check("Linux Chrome policy: only the open sites", ok and cj["URLBlocklist"][0] == "*" and "brightspace.com" in cj["URLAllowlist"] and cj.get("TranslateEnabled") is False, cj.get("URLAllowlist", [])[:5])
st = os.path.join(TMP, "lst5"); os.makedirs(st); hosts = os.path.join(TMP, "hosts5"); open(hosts, "w").write("127.0.0.1 localhost\n")
rf = rules_file(OFF + ["web"], block=["Spotify"])
shutil.copy2(rf, os.path.join(st, "rules.json"))
env = dict(os.environ, LOCKQZ_DRYRUN="1", HOSTS=hosts, STATE=st, LOCKQZ_NO_KILL="0")
subprocess.run([sys.executable, os.path.join(stage, "rules.py"), "build", os.path.join(st, "rules.json"), os.path.join(stage, "blocklist.txt"), st, "linux"], check=True)
r = subprocess.run(["bash", os.path.join(stage, "lockqz.sh"), "lock"], capture_output=True, text=True, env=env)
n_base = len([l for l in base if l.strip() and not l.startswith("#") and "/" not in l])
check("Linux engine (dry run) blackholes this exam's list (the AI list + the blocked rows' hosts)", r.returncode == 0 and "would blackhole" in r.stdout and int(r.stdout.split("blackhole ")[1].split()[0]) > n_base, r.stdout[:300] + r.stderr[:300])
eng = open(os.path.join(LINUX, "lockqz.sh")).read(); meng = open(os.path.join(MAC, "lockqz.sh")).read()
check("both engines build the exam's lists before every layer, read them in status, clear them at unlock",
      all(x in e for e in (eng, meng) for x in ("exam_rules build", "exam_rules   # this exam's list", "exam_clear")))
check("both engines keep an allowed row's programs open and close the blocked rows' and the professor's",
      "EX_KEEP" in eng and "close_typed" in eng and 'keep="$keep' in meng and "close_typed" in meng and "/System/Library/CoreServices/$a.app" in meng)

print("D agent")
AG = load(os.path.join(MAC, "lockqz-agent.py"), "lq_ag", {"LOCKQZ_EXAM_DIR": TMP})
h, p = AG.parse_blocklist(bl)
v = AG.exam_view(ex, "https://lms.otherschool.edu/d2l/lms/quizzing/user/quiz_summary.d2l?qi=1&ou=2")
bt = lambda u: AG.blocked_tab(u, h, p, v)
check("all other websites blocked: an article is blanked, Brightspace / Docs / the quiz's own site are not",
      bt("https://www.nytimes.com/x") and not bt("https://usc.brightspace.com/d2l/home") and not bt("https://docs.google.com/document/d/1")
      and not bt("https://lms.otherschool.edu/d2l/lms/quizzing/user/attempt") and not bt("file:///Users/s/notes.pdf"))
check("web search blocked: a Google search is blanked (not sent to Web results)", bt("https://www.google.com/search?q=bond+duration"))
check("AI still blanked; without rules the old behavior (articles open, Google search left to Web results)", bt("https://chatgpt.com/") and not AG.blocked_tab("https://www.nytimes.com/x", h, p)
      and not AG.blocked_tab("https://www.google.com/search?q=x", h, p))
check("the lock note says what stays open", "Messaging apps are closed" in AG.EXAM_NOTE["Notes + internet"] and "Only Brightspace" in AG.EXAM_NOTE["Notes only"])
d = os.path.join(TMP, "agx"); os.makedirs(d)
open(os.path.join(d, "exam-blocklist.txt"), "w").write("\n".join(bl) + "\n"); json.dump(ex, open(os.path.join(d, "exam.json"), "w"))
for n in ("exam-blocklist.txt", "exam.json"): os.chmod(os.path.join(d, n), 0o644)
AG.EXAM_DIR, AG.EXAM_OWNER = d, os.getuid()
class Fake: pass
a = Fake(); a.bl, a.bl_mtime, a.url = (set(), [], None), None, "https://usc.brightspace.com/d2l/lms/quizzing/user/attempt?qi=1&ou=2"
got = AG.Agent.blocklist(a)
check("the agent reads this exam's lists from the engine's folder (root-owned files only)", got[2] is not None and got[2]["search"] is False and "khanacademy.org" not in got[0] and "chatgpt.com" in got[0])
os.chmod(os.path.join(d, "exam.json"), 0o666); a.bl_mtime = None
got = AG.Agent.blocklist(a)
check("an exam file anyone can write: the AI list instead", got[2] is None)

print("E helper")
lf = os.path.join(TMP, "hl"); os.makedirs(lf)
H = load(os.path.join(MAC, "lockqzd.py"), "lq_h", {"LOCKQZ_LOCKFILE": os.path.join(lf, "active_lock.json"), "LOCKQZ_DRYRUN": "1", "LOCKQZ_TOKEN_FILE": os.path.join(lf, "t"), "LOCKQZ_TOKEN_DIR": os.path.join(lf, "td"), "LOCKQZ_KEY_PATH": os.path.join(lf, "k")})
got = H.set_rules("1-2", {"v": 1, "label": "Notes only", "b": ["web", "search", "BAD KEY", 5], "allow": ["investopedia.com", 7], "block": ["Spotify"]}, "https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=2&ou=1")
rec = json.load(open(H.RULES_FILE)); mode = stat.S_IMODE(os.stat(H.RULES_FILE).st_mode)
check("rules saved root-only with known-shape keys only and the quiz's site", got and rec["rules"]["b"] == ["web", "search"] and rec["rules"]["allow"] == ["investopedia.com"] and rec["quiz_host"] == "usc.brightspace.com" and mode & 0o077 == 0, (rec, oct(mode)))
check("the same rules again: no change (no extra lock pass)", H.set_rules("1-2", {"v": 1, "label": "Notes only", "b": ["web", "search"], "allow": ["investopedia.com"], "block": ["Spotify"]}, "https://usc.brightspace.com/x") is False)
check("no rules in the answer (server without them): the file goes, LOCKqz locks as before", H.set_rules("1-2", None) is True and not os.path.exists(H.RULES_FILE) and H.set_rules("1-2", None) is False)
src = open(os.path.join(MAC, "lockqzd.py")).read()
check("rules end at every unlock and a new quiz; a change re-runs the lock at once", "set_assist(None, [])\n    set_rules(None, None)" in src and "set_rules(None, None)   # another quiz's" in src
      and 'ch = set_rules(qid, j.get("rules"), url) or ch' in src and 'out["exam"] = rl["label"][:40]' in src)

print("\n%d passed, %d failed" % (P, F))
sys.exit(1 if F else 0)
