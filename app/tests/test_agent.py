#!/usr/bin/env python3
# Mac agent (extension replacement) + browser policy: pure-logic tests, no root, no browser.
import importlib.util, json, os, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); MAC = os.path.join(HERE, "..", "mac")
passed = failed = 0
def ok(m):
    global passed; passed += 1; print("  ok:", m)
def bad(m):
    global failed; failed += 1; print("  FAIL:", m)
def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), os.path.join(MAC, name))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m

def _section(src):
    """Run one test section; a section that crashes (e.g. on older code) counts as a failure."""
    try: exec(src, globals())
    except Exception as e: bad("section crashed on this code: %r" % e)

tmp = tempfile.mkdtemp(); os.environ["LOCKQZ_POLICY_DIR"] = tmp
os.environ["LOCKQZ_POLICY_BACKUP"] = tempfile.mkdtemp()
HOME = tempfile.mkdtemp(); os.environ["HOME"] = HOME   # agent files + fake browser profiles live here
os.environ["LOCKQZ_FF_IDS"] = "org.mozilla.firefox,org.mozilla.librewolf,net.waterfox.waterfox,one.ablaze.floorp,app.zen_browser.zen"
A = load("lockqz-agent.py"); P = load("browser-policy.py")
P.PROXY_KEPT = os.path.join(tempfile.mkdtemp(), "proxy.kept")   # never a stray file on the test machine

print("T1 quiz detection: attempt pages lock, list/submission pages never do")
B = "https://brightspace.usc.edu"
yes = [B + "/d2l/lms/quizzing/user/attempt/quiz_start_frame_auto.d2l?ou=123&isprv=0&drc=0&qi=456&cfql=0&dnb=0",
       B + "/d2l/lms/quizzing/user/attempt/quiz_attempt_page.d2l?ou=123&qi=456&dnb=0",
       B + "/d2l/lms/quizzing/user/quiz_summary.d2l?qi=456&ou=123"]
no = [B + "/d2l/lms/quizzing/user/quizzes_list.d2l?ou=123", B + "/d2l/lms/quizzing/user/quiz_submissions.d2l?qi=456&ou=123",
      B + "/d2l/home/123", "https://www.google.com/search?q=qi=1", B + "/d2l/lms/quizzing/user/attempt/x.d2l?ou=123"]
ok("attempt pages lock") if all(A.is_quiz(u) for u in yes) else bad("an attempt page did not lock")
ok("non-attempt pages never lock") if not any(A.is_quiz(u) for u in no) else bad("a non-attempt page locked")
ok("lock id = ou-qi") if A.lock_id(yes[0]) == "123-456" else bad("lock id " + A.lock_id(yes[0]))
prv = [B + "/d2l/lms/quizzing/user/quiz_summary.d2l?qi=456&ou=123&isprv=1",
       B + "/d2l/lms/quizzing/admin/modify/quiz_preview.d2l?ou=123&qi=456"]
edit = [B + "/d2l/lms/quizzing/admin/modify/quiz_newedit_properties.d2l?ou=123&qi=456"]
ok("TA/staff Preview of a quiz locks too") if all(A.is_quiz(u) for u in prv) else bad("a preview page did not lock")
ok("quiz edit page (no preview) never locks") if not any(A.is_quiz(u) for u in edit) else bad("an edit page locked")
ok("real email accepted") if A.EMAIL_RE.match("you@usc.edu") else bad("email rejected")
ok("a name is not an email") if not A.EMAIL_RE.match("anthony") else bad("name accepted as email")

print("T2 search backstop: AI-answer searches are sent to Google Web; clean ones are left alone")
r = A.rewrite_search
ok("google All -> Web") if r("https://www.google.com/search?q=what+is+gdp") == "https://www.google.com/search?udm=14&q=what+is+gdp" else bad("google All not rewritten")
ok("AI Mode -> Web") if "udm=14" in (r("https://www.google.com/search?udm=50&q=gdp") or "") else bad("AI mode not rewritten")
ok("Web left alone") if r("https://www.google.com/search?udm=14&q=gdp") is None else bad("Web rewritten")
# 27 Oct: more engines that answer with AI -> Google Web (Safari's only layer); other pages on those hosts untouched
for u in ["https://www.ecosia.org/search?q=gdp", "https://www.ecosia.org/chat", "https://yandex.ru/search/?text=gdp", "https://ya.ru/search/?text=gdp",
          "https://www.baidu.com/s?wd=gdp", "https://search.naver.com/search.naver?query=gdp", "https://www.ask.com/web?q=gdp",
          "https://yep.com/web?q=gdp", "https://search.aol.com/aol/search?q=gdp", "https://www.sogou.com/web?query=gdp", "https://www.so.com/s?q=gdp"]:
    ok("AI-answer engine -> Web: " + u.split("/")[2]) if (r(u) or "").startswith("https://www.google.com/search?udm=14") else bad("not rewritten: " + u)
ok("ecosia.org home left alone") if r("https://www.ecosia.org/") is None else bad("ecosia home rewritten")
ok("baidu non-search page left alone") if r("https://www.baidu.com/about") is None else bad("baidu about rewritten")
ok("udm=14 plus a sneaked-in udm=50 -> Web") if "udm=14" in (r("https://www.google.com/search?udm=14&udm=50&q=gdp") or "") else bad("double udm not rewritten")
ok("google.co.uk AI Mode -> Web") if "udm=14" in (r("https://www.google.co.uk/search?udm=50&q=gdp") or "") else bad("co.uk AI mode not rewritten")
ok("Images left alone") if r("https://www.google.com/search?tbm=isch&q=gdp") is None else bad("Images rewritten")
ok("bing -> Web") if (r("https://www.bing.com/search?q=gdp") or "").startswith("https://www.google.com/search?udm=14") else bad("bing not rewritten")
ok("ddg -> Web") if r("https://duckduckgo.com/?q=gdp&ia=chat") else bad("ddg not rewritten")
ok("brightspace left alone") if r(yes[0]) is None else bad("brightspace rewritten")
ok("docs.google left alone") if r("https://docs.google.com/document/d/1") is None else bad("docs rewritten")

print("T3 Firefox session decode (mozlz4 block decompressor + tab URL extraction)")
raw = b'{"windows":[{"tabs":[{"index":1,"entries":[{"url":"' + yes[0].encode() + b'"}]}]}]}'
# hand-build an LZ4 block: one literal run (no matches) — valid per the LZ4 block format
lit = len(raw); tok = bytes([0xF0]) + bytes([255] * ((lit - 15) // 255)) + bytes([(lit - 15) % 255]) if lit >= 15 else bytes([lit << 4])
ok("lz4 literal block decodes") if A.lz4_block(tok + raw) == raw else bad("lz4 decode mismatch")
# a block with a back-reference: "abcd" + copy 4 bytes from offset 4 -> "abcdabcd"
blk = bytes([0x40]) + b"abcd" + bytes([4, 0]) + bytes([0x00])
ok("lz4 match copy decodes") if A.lz4_block(blk).startswith(b"abcdabcd") else bad("lz4 match copy " + repr(A.lz4_block(blk)))
ok("firefox tab urls extracted") if A.firefox_urls(json.loads(raw)) == [yes[0]] else bad("firefox urls " + str(A.firefox_urls(json.loads(raw))))

print("T4 browser policy: lock writes every browser, unlock removes only ours, nothing else touched")
import plistlib
with open(os.path.join(tmp, "com.apple.Other.plist"), "wb") as f: plistlib.dump({"x": 1}, f)
P.lock()
written = [f for f in os.listdir(tmp) if f.endswith(".plist")]
nonours = [f for f in written if f == "com.apple.Other.plist"]
ours = [f for f in written if f != "com.apple.Other.plist"]
ok("every managed browser channel written (>=15) + foreign file untouched") if len(ours) >= 15 and len(nonours) == 1 else bad("files: " + str(sorted(written)))
ok("all channels of Chrome/Edge/Brave covered") if all(x in ours for x in ["com.google.Chrome.plist","com.google.Chrome.beta.plist","com.microsoft.Edge.plist","com.microsoft.Edge.Dev.plist","com.brave.Browser.plist","com.brave.Browser.nightly.plist","com.operasoftware.OperaGX.plist"]) else bad("missing a channel: " + str(sorted(ours)))
with open(os.path.join(tmp, "com.google.Chrome.plist"), "rb") as f: ch = plistlib.load(f)
ok("Chrome: AI off + Web search pinned") if ch["GeminiSettings"] == 1 and ch["GenAiDefaultSettings"] == 2 and "udm=14" in ch["DefaultSearchProviderSearchURL"] else bad("chrome policy wrong")
ok("Chrome: Web allowed beats search blocked") if "google.com/search" in ch["URLBlocklist"] and "google.com/search?udm=14" in ch["URLAllowlist"] else bad("url lists wrong")
with open(os.path.join(tmp, "org.mozilla.firefox.plist"), "rb") as f: ff = plistlib.load(f)
ok("Firefox: filter + AI chat off") if ff["WebsiteFilter"]["Block"] and ff["Preferences"]["browser.ml.chat.enabled"]["Value"] is False else bad("firefox policy wrong")
for fork in ["org.mozilla.librewolf","net.waterfox.waterfox","one.ablaze.floorp","app.zen_browser.zen"]:
    pth = os.path.join(tmp, fork + ".plist")
    okfork = os.path.exists(pth) and plistlib.load(open(pth,"rb"))["WebsiteFilter"]["Block"]
    ok("Firefox fork policed: " + fork) if okfork else bad("fork not policed: " + fork)
P.unlock()
ok("unlock leaves only the foreign file") if os.listdir(tmp) == ["com.apple.Other.plist"] else bad("after unlock: " + str(os.listdir(tmp)))

print("T9 student email: asked once, confirmed by an emailed code (scripted dialogs + fake server)")
class FakeUI:
    def __init__(self, answers): self.answers, self.shown = list(answers), []
    def ask(self, msg, buttons, default="", answer=True):
        self.shown.append(msg)
        return self.answers.pop(0) if self.answers else (None, None)
    def say(self, msg): self.shown.append(msg)
class FakeServer:
    def __init__(self, codes=True, verified=None):
        self.codes, self.verified, self.code, self.calls, self.expire_next = codes, verified, "246810", [], False
    def __call__(self, op, **kw):
        self.calls.append((op, kw))
        if op == "status": return {"status": 200, "student": self.verified, "verified": bool(self.verified), "codes": self.codes}
        if op == "check": return {"status": 200, "name": {"al@usc.edu": "Al Student"}.get(kw["email"])}
        if op == "send": return {"status": 200, "bound": True} if not self.codes else {"status": 200, "sent": True}
        if op == "code":
            if self.expire_next: self.expire_next = False; return {"status": 200, "error": "expired", "resent": True}
            return {"status": 200, "verified": True} if kw["code"] == self.code else {"status": 200, "error": "wrong_code", "tries_left": 4}
S = FakeServer(verified="al@usc.edu"); U = FakeUI([])
r = A.setup_identity(S, U)
ok("already confirmed on the server: no dialog at all") if r == ("al@usc.edu", True) and not U.shown else bad("re-asked: %r %r" % (r, U.shown))
S = FakeServer(); U = FakeUI([])
ok("offline / dialog closed: nothing saved (asks again later)") if A.setup_identity(lambda op, **k: {}, U) is None and not U.shown else bad("offline")
S = FakeServer(); U = FakeUI([("OK", "AL@usc.edu "), ("Yes", ""), ("OK", "000000"), ("OK", "246810")])
r = A.setup_identity(S, U)
ok("typed -> 'Is this you? Al Student' -> wrong code -> right code -> confirmed") if r == ("al@usc.edu", True) and any("Al Student" in m for m in U.shown) and any("wrong" in m for m in U.shown) else bad("happy path %r %r" % (r, U.shown))
S = FakeServer(); U = FakeUI([("OK", "al@usc.eud"), ("Retype", ""), ("OK", "al@usc.edu"), ("Yes", ""), ("OK", "246810")])
r = A.setup_identity(S, U)
ok("typo: 'not on a class list' -> Retype -> right email -> confirmed") if r == ("al@usc.edu", True) and any("not on a LOCKqz class list" in m for m in U.shown) else bad("typo %r" % (r,))
S = FakeServer(); U = FakeUI([("OK", "bo@usc.edu"), ("Use it", ""), ("Change email", ""), ("OK", "al@usc.edu"), ("Yes", ""), ("OK", "246810")])
r = A.setup_identity(S, U)
ok("code never arrives -> Change email -> fixed -> confirmed") if r == ("al@usc.edu", True) else bad("change email %r" % (r,))
S = FakeServer(); S.expire_next = True; U = FakeUI([("OK", "al@usc.edu"), ("Yes", ""), ("OK", "246810"), ("OK", "246810")])
r = A.setup_identity(S, U)
ok("expired code: new one sent automatically, email NOT retyped") if r == ("al@usc.edu", True) and any("expired" in m for m in U.shown) and [c for c in S.calls if c[0] == "check"].__len__() == 1 else bad("expired %r %r" % (r, U.shown))
S = FakeServer(); U = FakeUI([("OK", "al@usc.edu"), ("Yes", ""), ("Send new code", ""), ("OK", "246810")])
r = A.setup_identity(S, U)
ok("Send new code button resends") if r == ("al@usc.edu", True) and [c[0] for c in S.calls].count("send") == 2 else bad("resend %r" % (S.calls,))
S = FakeServer(); U = FakeUI([("OK", "not-an-email"), ("OK", "al@usc.edu"), ("Yes", ""), ("OK", "246810")])
ok("non-email re-asked") if A.setup_identity(S, U) == ("al@usc.edu", True) and "not an email" in U.shown[1] else bad("non-email")
# 25 Oct 2026: the email is asked ONCE; server trouble never pops up a dialog.
saved = []; st = {}
S = FakeServer(); U = FakeUI([("OK", "al@usc.edu"), ("Yes", "")])
S_send = S.__call__
def S500(op, **kw):
    if op == "send": return {"status": 500, "error": "Error: D1_ERROR: daily row write limit"}
    return S_send(op, **kw)
r = A.setup_identity(S500, U, "", saved.append, st)
ok("server error after the email: saved at once, NO error popup, quiet retry") if r is None and saved == ["al@usc.edu"] and st.get("r") == "server" and not any("wrong" in m.lower() or "later" in m.lower() for m in U.shown) else bad("500: %r %r %r" % (r, saved, U.shown))
U = FakeUI([("OK", "246810")])
r = A.setup_identity(S, U, "al@usc.edu", saved.append, st)
ok("retry with the saved email: straight to the code, email NOT asked again") if r == ("al@usc.edu", True) and len(U.shown) == 2 and "6-digit" in U.shown[0] else bad("retry %r %r" % (r, U.shown))
S = FakeServer(); S.calls = []; U = FakeUI([]); st = {}
S_status = S.__call__
def Spend(op, **kw):
    if op == "status": return {"status": 200, "student": "al@usc.edu", "verified": False, "codes": True}
    return S_status(op, **kw)
r = A.setup_identity(Spend, U, "", None, st)
ok("server already holds the (unconfirmed) email: no email dialog, code only") if r is None and st.get("r") == "closed" and len(U.shown) == 1 and "6-digit" in U.shown[0] else bad("server email %r" % (U.shown,))
n_send = [c[0] for c in S.calls].count("send"); U = FakeUI([("OK", "246810")])
r = A.setup_identity(Spend, U, "", None, st)
ok("code still fresh: not resent on the next try") if r == ("al@usc.edu", True) and [c[0] for c in S.calls].count("send") == n_send else bad("resent %r" % (S.calls,))
U = FakeUI([("OK", "al@usc.edu")]); st = {}
r = A.setup_identity(lambda op, **k: {"status": 200, "codes": True} if op == "status" else {}, U, "", saved.append, st)
ok("check unreachable after typing: email kept, no popup") if r is None and saved[-1] == "al@usc.edu" and len(U.shown) == 1 else bad("check down %r %r" % (saved, U.shown))
# Reinstall: the saved proof of a confirmed email confirms the new install - nothing typed at all.
st = {}
r = A.setup_identity(lambda op, **k: {"status": 200, "student": "al@usc.edu", "verified": True, "codes": True, "vtoken": "ab" * 20} if op == "status" else {}, FakeUI([]), "", None, st)
ok("verified status: proof kept") if r == ("al@usc.edu", True) and st.get("vtoken") == "ab" * 20 else bad("vtoken %r" % st)
calls = []
def Srein(op, **kw):
    calls.append(op)
    if op == "status": return {"status": 200, "student": None, "verified": False, "codes": True}
    if op == "token": return {"status": 200, "verified": True, "vtoken": kw["vtoken"]} if kw["vtoken"] == "ab" * 20 and kw["email"] == "al@usc.edu" else {"status": 403, "error": "bad_token"}
    return {"status": 200, "sent": True}
U = FakeUI([])
r = A.setup_identity(Srein, U, "al@usc.edu", None, {"vtoken": "ab" * 20})
ok("reinstall + saved proof: confirmed with NO dialog, no code") if r == ("al@usc.edu", True) and not U.shown and "send" not in calls else bad("reinstall %r %r %r" % (r, U.shown, calls))
st = {"vtoken": "cd" * 20}; U = FakeUI([])
r = A.setup_identity(Srein, U, "al@usc.edu", None, st)
ok("bad proof: dropped, falls back to the code (email still not asked)") if r is None and "vtoken" not in st and len(U.shown) == 1 and "6-digit" in U.shown[0] else bad("bad proof %r %r" % (st, U.shown))
S = FakeServer(codes=False); U = FakeUI([("OK", "al@usc.edu"), ("Yes", "")])
ok("server codes off: roster check only, saved unconfirmed") if A.setup_identity(S, U) == ("al@usc.edu", False) else bad("codes off")
import shutil, subprocess as _sp
if shutil.which("osacompile"):   # macOS only: the real dialog AppleScript must compile
    caught = []
    class _R: returncode = 0; stdout = ""
    real = A.subprocess.run
    A.subprocess.run = lambda args, **kw: (caught.append(args), _R())[1]
    ui = A.MacUI(); ui.ask('Is this you?\n\nAl "Q" Student', ["No, retype", "Yes"], answer=False); ui.ask("Email — é:", ["OK"], "x@usc.edu"); ui.ask("code", ["Change email", "Send new code", "OK"])
    A.subprocess.run = real
    errs = [r.stderr for r in (_sp.run(["osacompile", "-e", a[4], "-o", os.path.join(tmp, "d%d.scpt" % i)], capture_output=True, text=True) for i, a in enumerate(caught)) if r.returncode]
    ok("dialog AppleScript compiles") if len(caught) == 3 and not errs else bad("AppleScript: %r" % errs)
    ok("dialog text passed as arguments, never inside the script") if all('Al "Q"' not in a[4] for a in caught) and caught[0][5:] == ['Is this you?\n\nAl "Q" Student', "", "0", "No, retype", "Yes"] else bad("args: %r" % caught[0][5:])
else:
    print("  skipped: AppleScript compile check (not macOS)")


_section(r'''
print("T10 stale Firefox recovery file: never read unless that browser is running and wrote it since it started")
import time as _t
now = _t.time()
prof = os.path.join(HOME, "Library/Application Support/Firefox/Profiles/abc.default/sessionstore-backups")
os.makedirs(prof, exist_ok=True)
rec = os.path.join(prof, "recovery.jsonlz4")
quiz_session = {"windows": [{"tabs": [{"index": 1, "entries": [{"url": yes[0]}]}]}]}
rawq = json.dumps(quiz_session).encode()
litq = len(rawq)
tokq = bytes([0xF0]) + bytes([255] * ((litq - 15) // 255)) + bytes([(litq - 15) % 255])
with open(rec, "wb") as f: f.write(b"mozLz40\0" + litq.to_bytes(4, "little") + tokq + rawq)
os.utime(rec, (now - 3600, now - 3600))     # left behind by a crash an hour ago
ok("ps etime parsed") if A._etime("01-02:03:04") == 93784 and A._etime("05:06") == 306 else bad("etime parse")
run_none = A.gecko_running(["  10:00 /Applications/Safari.app/Contents/MacOS/Safari"], now)
ok("Firefox not running -> no profile read") if A.gecko_session_files(run_none, lambda b: [rec], os.path.getmtime) == [] else bad("read a profile of a browser that is not running")
run_new = A.gecko_running(["   00:30 /Applications/Firefox.app/Contents/MacOS/firefox"], now)
ok("Firefox running, but this profile is older than the browser -> ignored") if A.gecko_session_files(run_new, lambda b: [rec] if b == "Firefox" else [], os.path.getmtime) == [] else bad("stale profile read")
run_old = A.gecko_running(["01:00:00 /Applications/Firefox.app/Contents/MacOS/firefox"], now)
ok("Firefox running and wrote the file since it started -> read") if A.gecko_session_files(run_old, lambda b: [rec] if b == "Firefox" else [], os.path.getmtime) == [("Firefox", rec)] else bad("live profile not read")
ok("a firefox binary outside an app bundle does not count") if A.gecko_running(["01:00:00 /tmp/firefox"], now) == {} else bad("non-app firefox counted")
ok("a bare process name (ps without paths) still counts") if "Firefox" in A.gecko_running(["01:00:00 firefox"], now) else bad("bare firefox name missed")
class _PS: returncode = 0; stdout = "  4242   00:30 /Applications/Firefox.app/Contents/MacOS/firefox\n"; stderr = ""   # ps -o pid=,etime=,comm=
_real_run, _real_apps = A.subprocess.run, A.running_apps
A.subprocess.run = lambda *a, **k: _PS(); A.running_apps = lambda *a: set()
ok("end to end: crash-left recovery file -> no quiz tab seen") if not [t for t in A.browser_tabs() if A.is_quiz(t[3])] else bad("stale recovery file produced a quiz tab")
os.utime(rec, None)   # the running browser just wrote it
ok("end to end: live Firefox session -> quiz tab seen") if [t for t in A.browser_tabs() if A.is_quiz(t[3])] else bad("live Firefox quiz not seen")
A.subprocess.run, A.running_apps = _real_run, _real_apps
''')

_section(r'''
print("T11 leaving is evaluated before present")
SUMM = B + "/d2l/lms/quizzing/user/quiz_summary.d2l?qi=456&ou=123"
SUBM = B + "/d2l/lms/quizzing/user/quiz_submissions_attempt.d2l?qi=456&ou=123&ai=9"
ATT = yes[0]
pres, left = A.classify([SUMM, SUBM])
ok("summary page + submission page -> quiz has been LEFT (not present)") if "123-456" not in pres and "123-456" in left else bad("classify %r %r" % (pres, left))
pres, left = A.classify([ATT, SUBM])
ok("open ATTEMPT + an old submission tab -> still present (no unlock mid-attempt)") if "123-456" in pres and not left else bad("attempt not present %r %r" % (pres, left))
pres, left = A.classify([SUMM])
ok("summary page alone -> present") if pres.get("123-456") == SUMM else bad("summary not present")

''')
_section(r'''
A.dialog = lambda *a, **k: None; A.clipboard = lambda *a, **k: None
class FakeHelper:
    """Stands in for the root helper: records calls, scripted failures, scripted status."""
    def __init__(self): self.calls, self.fail_unlock, self.status = [], 0, {"state": "unlocked"}
    def __call__(self, path, body=None, timeout=90):
        self.calls.append((path, body))
        if path == "/lock": self.status = {"state": "locked", "quiz_id": body["quiz_id"]}; return {"ok": True, "state": "locked"}
        if path == "/unlock":
            if self.fail_unlock: self.fail_unlock -= 1; raise OSError("helper busy")
            self.status = {"state": "unlocked"}; return {"ok": True, "state": "unlocked"}
        if path == "/password": return {"password": "PW"}
        if path == "/status": return dict(self.status)
        return {"ok": True}
def agent():
    g = A.Agent(); h = FakeHelper(); g.helper = h; g.verified = True
    g.ready_told = True   # the one-time ready notice asks the helper for /verify status: kept out of these call logs
    return g, h
tab = lambda u: ("Google Chrome", 0, 0, u)
def T(g, tabs):
    """One agent tick with the given open tabs (works with any Agent.tick signature)."""
    A.browser_tabs = lambda: list(tabs); A.developer_mode = lambda: False
    g.tick()

''')
_section(r'''
SUMM = B + "/d2l/lms/quizzing/user/quiz_summary.d2l?qi=456&ou=123"
SUBM = B + "/d2l/lms/quizzing/user/quiz_submissions_attempt.d2l?qi=456&ou=123&ai=9"
ATT = yes[0]; import time as _t
g, h = agent()
T(g, [tab(ATT)])
ok("attempt page -> locked") if g.locked and g.quiz == "123-456" else bad("did not lock")
T(g, [tab(SUMM), tab(SUBM)])
unl = [b for (p, b) in h.calls if p == "/unlock"]
ok("submission page shows (summary tab still open) -> unlocked at once, reason quiz_submitted") if not g.locked and unl and unl[-1]["reason"] == "quiz_submitted" else bad("still locked after submit: %r" % (h.calls[-3:],))
n = len(h.calls); T(g, [tab(SUMM), tab(SUBM)])
ok("no re-lock flapping while the submission page stays open") if not any(p == "/lock" for (p, _) in h.calls[n:]) else bad("re-locked after submit")
''')

_section(r'''
print("T12 a failed unlock is retried until the helper confirms")
g, h = agent()
T(g, [tab(ATT)])
h.fail_unlock = 1
T(g, [tab(SUBM)])
ok("unlock failed -> kept as pending") if not g.locked and g.pending == ("123-456", "quiz_submitted") else bad("pending not kept: %r" % (g.pending,))
g.pending_try = 0; T(g, [])
ok("next try succeeds -> pending cleared, helper unlocked") if g.pending is None and h.status["state"] == "unlocked" else bad("pending not retried: %r %r" % (g.pending, h.status))
g, h = agent()
h.status = {"state": "locked", "quiz_id": "123-456"}   # helper still locked, agent thinks it is not
g.last_check = 0; T(g, [])
ok("unlocked agent sees a locked helper -> adopts the lock") if g.locked and g.quiz == "123-456" else bad("did not adopt")
g.missing_since = _t.time() - A.GRACE - 1; T(g, [("Google Chrome", 0, 0, "https://example.com/")])
ok("no quiz open -> helper unlocked after the grace period (reason quiz_left)") if not g.locked and h.status["state"] == "unlocked" and h.calls[-2][1]["reason"] in ("quiz_left",) else bad("adopted lock not released: %r" % (h.calls[-3:],))
''')

_section(r'''
print("T13 3-hour cap: the agent never re-locks the quiz the cap released")
g, h = agent()
T(g, [tab(ATT)])
h.status = {"state": "unlocked", "capped_quiz": "123-456"}   # helper hit its hard max
g.last_check = 0; T(g, [tab(ATT)])
ok("cap seen -> agent unlocked, no /lock sent") if not g.locked and not any(p == "/lock" for (p, _) in h.calls[1:]) else bad("re-locked after cap: %r" % (h.calls,))
for _ in range(3): g.last_check = 0; T(g, [tab(ATT)])
ok("quiz still open after the cap -> stays unlocked") if not g.locked and sum(1 for (p, _) in h.calls if p == "/lock") == 1 else bad("cap re-lock")
g.capped["123-456"] = _t.time() - A.GRACE - 1; h.status = {"state": "unlocked"}
T(g, []); T(g, [tab(ATT)])
ok("after the quiz page is gone, a new attempt locks normally") if g.locked else bad("never locks again after a cap")
''')

_section(r'''
print("T14 browser policy keeps the student's/MDM's own policies and blocks AI paths")
pd, bk = tempfile.mkdtemp(), tempfile.mkdtemp()
P.DIR, P.BACKUP = pd, bk
mine = {"HomepageLocation": "https://usc.edu", "URLBlocklist": ["badsite.example"], "ExtensionInstallForcelist": ["abc;https://x"],
        "ExtensionInstallAllowlist": ["aiextension"]}
with open(os.path.join(pd, "com.google.Chrome.plist"), "wb") as f: plistlib.dump(mine, f)
orig = open(os.path.join(pd, "com.google.Chrome.plist"), "rb").read()
P.lock()
ch = plistlib.load(open(os.path.join(pd, "com.google.Chrome.plist"), "rb"))
ok("their keys kept during the quiz, ours added") if ch.get("HomepageLocation") == "https://usc.edu" and ch.get("GeminiSettings") == 1 and "badsite.example" in ch["URLBlocklist"] and "google.com/search" in ch["URLBlocklist"] else bad("merge wrong: %r" % ch)
ok("force-installed extensions untouched (never uninstalled); their allowlist replaced by the fixed safe list for the quiz only") if ch.get("ExtensionInstallForcelist") == ["abc;https://x"] and ch.get("ExtensionInstallAllowlist") == P.SAFE_EXTENSIONS and "aiextension" not in ch["ExtensionInstallAllowlist"] else bad("extension keys wrong")
ok("blocklist path entries enforced in Chrome (huggingface.co/chat)") if "huggingface.co/chat" in ch["URLBlocklist"] else bad("path entry missing")
ff = plistlib.load(open(os.path.join(pd, "org.mozilla.firefox.plist"), "rb"))
ok("... and in Firefox") if "*://huggingface.co/chat*" in ff["WebsiteFilter"]["Block"] else bad("firefox path entry missing")
ok("Firefox never gets ExtensionSettings '*' blocked (it would uninstall every add-on)") if "ExtensionSettings" not in ff else bad("Firefox ExtensionSettings set")
m1 = os.path.getmtime(os.path.join(pd, "com.google.Chrome.plist")); _t.sleep(0.05); P.lock()
ok("re-applying an unchanged policy does not rewrite the file") if os.path.getmtime(os.path.join(pd, "com.google.Chrome.plist")) == m1 else bad("rewrote unchanged policy")
ok("unlock succeeds") if P.unlock() else bad("unlock reported failure")
ok("their Chrome policy restored byte-for-byte") if open(os.path.join(pd, "com.google.Chrome.plist"), "rb").read() == orig else bad("their policy not restored")
ok("nothing of ours left, backups cleaned") if os.listdir(pd) == ["com.google.Chrome.plist"] and (not os.path.exists(bk) or os.listdir(bk) == []) else bad("left: %r %r" % (os.listdir(pd), os.listdir(bk) if os.path.exists(bk) else None))
os.environ.pop("LOCKQZ_FF_IDS", None)
apps = os.path.join(HOME, "Applications", "Evil.app", "Contents"); os.makedirs(os.path.join(apps, "MacOS"), exist_ok=True)
open(os.path.join(apps, "MacOS", "firefox"), "w").close()
with open(os.path.join(apps, "Info.plist"), "wb") as f: plistlib.dump({"CFBundleIdentifier": "../../../../tmp/lockqz-pwn"}, f)
ids = P.firefox_family_ids()
ok("bundle ids come from the fixed list only (a planted app cannot steer root's writes)") if ids == sorted(P.GECKO) else bad("ids: %r" % ids)
ok("a path-like id is never accepted") if not P.ID_RE.fullmatch("../../etc/x") and not P.ID_RE.fullmatch("a/b.c") else bad("ID_RE too loose")
''')

_section(r'''
print("T15 round-2 coverage: blocklist mirrored into the browsers, Brave Tor/VPN, Firefox Smart Window + VPN, Office Copilot")
pd, bk = tempfile.mkdtemp(), tempfile.mkdtemp()
P.DIR, P.BACKUP = pd, bk
os.environ["LOCKQZ_FF_IDS"] = "org.mozilla.firefox"
hosts = P.host_entries(); paths = P.path_entries()
ok("blocklist read: %d hosts + %d path entries" % (len(hosts), len(paths))) if len(hosts) > 250 and "gauthmath.com" in hosts and "github.com/copilot" in paths else bad("host/path split wrong: %d %r" % (len(hosts), paths))
ok("no path entry and no comment in the host list") if not [h for h in hosts if "/" in h or h.startswith("#")] else bad("bad host entries")
theirs_ff = {"AIControls": {"Translations": {"Value": "blocked", "Locked": True}}, "DisableTelemetry": True}
with open(os.path.join(pd, "org.mozilla.firefox.plist"), "wb") as f: plistlib.dump(theirs_ff, f)
theirs_off = {"OfficeAutoSignIn": True, "OfficeExperiencesAnalyzingContentPreference": True}
with open(os.path.join(pd, "com.microsoft.office.plist"), "wb") as f: plistlib.dump(theirs_off, f)
ff_orig = open(os.path.join(pd, "org.mozilla.firefox.plist"), "rb").read(); off_orig = open(os.path.join(pd, "com.microsoft.office.plist"), "rb").read()
ok("lock succeeds") if P.lock() else bad("lock failed")
ch = plistlib.load(open(os.path.join(pd, "com.google.Chrome.plist"), "rb"))
ok("Chrome URLBlocklist: every blocklist host + path, under the 1000 limit") if all(h in ch["URLBlocklist"] for h in hosts) and all(x in ch["URLBlocklist"] for x in paths) and len(ch["URLBlocklist"]) <= 1000 else bad("URLBlocklist incomplete (%d)" % len(ch["URLBlocklist"]))
ok("Chrome: no notes host blocked (docs.google.com, quizlet.com, m365.cloud.microsoft)") if not [x for x in ch["URLBlocklist"] if x in ("google.com", "docs.google.com", "quizlet.com", "studocu.com", "knowunity.com", "m365.cloud.microsoft", "github.com", "office.com")] else bad("notes host in URLBlocklist")
ok("Chrome: only the fixed safe extensions stay on (password managers, Docs Offline, Zotero)") if ch["ExtensionInstallAllowlist"] == P.SAFE_EXTENSIONS and ch["ExtensionInstallBlocklist"] == ["*"] else bad("extension allowlist wrong: %r" % ch.get("ExtensionInstallAllowlist"))
ok("Chrome: DuckDuckGo no-AI site allowed, AI Mode links blocked") if "noai.duckduckgo.com" in ch["URLAllowlist"] and "google.com/ai" in ch["URLBlocklist"] and "duckduckgo.com" in ch["URLBlocklist"] else bad("ddg/ai-mode lists wrong")
ok("Chrome: proxy forced direct (network works without it)") if ch.get("ProxyMode") == "direct" else bad("ProxyMode missing")
br = plistlib.load(open(os.path.join(pd, "com.brave.Browser.plist"), "rb"))
ok("Brave: Leo, Tor windows and Brave VPN off") if br.get("BraveAIChatEnabled") is False and br.get("TorDisabled") is True and br.get("BraveVPNDisabled") is True else bad("brave policy wrong")
ok("Chrome gets no Brave-only keys") if "TorDisabled" not in ch else bad("TorDisabled on Chrome")
ff = plistlib.load(open(os.path.join(pd, "org.mozilla.firefox.plist"), "rb"))
ok("Firefox: chatbot + Smart Window blocked (AIControls), never Default") if ff["AIControls"]["SidebarChatbot"] == {"Value": "blocked", "Locked": True} and ff["AIControls"]["SmartWindow"]["Value"] == "blocked" and "Default" not in ff["AIControls"] else bad("AIControls wrong: %r" % ff.get("AIControls"))
ok("Firefox: the school's own AIControls entry kept during the quiz") if ff["AIControls"].get("Translations") == {"Value": "blocked", "Locked": True} and ff.get("DisableTelemetry") is True else bad("their AIControls lost")
ok("Firefox: GenerativeAI off incl. SmartWindow (for 144-148), built-in VPN off") if ff["GenerativeAI"]["Chatbot"] is False and ff["GenerativeAI"]["SmartWindow"] is False and ff["GenerativeAI"]["Locked"] is True and ff["IPProtectionAvailable"] is False else bad("GenerativeAI/IPProtection wrong")
ok("Firefox: browser.smartwindow.enabled locked off") if ff["Preferences"]["browser.smartwindow.enabled"] == {"Value": False, "Status": "locked"} else bad("smartwindow pref missing")
blk = ff["WebsiteFilter"]["Block"]
ok("Firefox WebsiteFilter: every blocklist host (*://*.host/*), under the 1000 limit") if all("*://*.%s/*" % h in blk for h in hosts) and len(blk) <= 1000 else bad("WebsiteFilter incomplete (%d)" % len(blk))
of = plistlib.load(open(os.path.join(pd, "com.microsoft.office.plist"), "rb"))
ok("Office: 'connected experiences that analyze content' off (Copilot off), their keys kept") if of["OfficeExperiencesAnalyzingContentPreference"] is False and of.get("OfficeAutoSignIn") is True else bad("office policy wrong: %r" % of)
ok("unlock succeeds") if P.unlock() else bad("unlock failed")
ok("Firefox + Office files restored byte-for-byte") if open(os.path.join(pd, "org.mozilla.firefox.plist"), "rb").read() == ff_orig and open(os.path.join(pd, "com.microsoft.office.plist"), "rb").read() == off_orig else bad("not restored")
ok("nothing else left") if sorted(os.listdir(pd)) == ["com.microsoft.office.plist", "org.mozilla.firefox.plist"] else bad("left: %r" % os.listdir(pd))
open(P.PROXY_KEPT, "w").close()   # extra-block.sh found the network only works through its proxy
P.lock()
ch = plistlib.load(open(os.path.join(pd, "com.google.Chrome.plist"), "rb")); ff = plistlib.load(open(os.path.join(pd, "org.mozilla.firefox.plist"), "rb"))
ok("proxy-only network: browsers keep their proxy (no ProxyMode / Proxy policy), rest still applied") if "ProxyMode" not in ch and "Proxy" not in ff and ch.get("GenAiDefaultSettings") == 2 and ff["DNSOverHTTPS"]["Enabled"] is False else bad("proxy kept wrong")
os.remove(P.PROXY_KEPT); P.unlock()
os.environ.pop("LOCKQZ_FF_IDS", None)
''')

_section(r"""
print("T15 F14: URL rules look at one part of the URL only")
SUB = B + "/d2l/lms/quizzing/user/attempt/quiz_attempt_page.d2l?ou=123&qi=456&returnUrl=%2Fd2l%2Flms%2Fquizzing%2Fuser%2Fquiz_submissions.d2l%3Ffeedback%3D1"
ok("attempt page whose query mentions 'submission'/'feedback' still locks") if A.is_quiz(SUB) and not A.is_leaving(SUB) else bad("query words decided the page")
pres, left = A.classify([SUB]); ok("... and is present, not left") if "123-456" in pres and not left else bad("classify %r %r" % (pres, left))
FAKE = B + "/d2l/le/content/123/viewContent/9/View?url=/d2l/lms/quizzing/user/quiz_summary.d2l%3Fqi=456"
ok("a quiz path quoted in another page's query never locks") if not A.is_quiz(FAKE) else bad("content page locked")
ok("lock id from the quiz's own ?ou=&qi= (not 'xqi=')") if A.lock_id(B + "/d2l/lms/quizzing/user/quiz_summary.d2l?xqi=1&qi=456&abou=7&ou=123") == "123-456" else bad("lock id %s" % A.lock_id(B + "/d2l/lms/quizzing/user/quiz_summary.d2l?xqi=1&qi=456&abou=7&ou=123"))
ok("address-bar text without https:// still parsed") if A.is_quiz("brightspace.usc.edu/d2l/lms/quizzing/user/quiz_summary.d2l?qi=456&ou=123") else bad("scheme-less URL missed")
ok("garbage never throws") if A.lock_id(None) == "x-x" and not A.is_quiz(None) and not A.is_quiz("http://[bad") else bad("garbage")
""")
_section(r"""
print("T16 E5: running browsers found with ps, never through System Events")
procs = [(1, 10, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
         (2, 10, "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper"),
         (3, 10, "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari"),
         (4, 10, "/Applications/Opera GX.app/Contents/MacOS/Opera")]
apps = A.running_apps(procs)
ok("Chrome, Safari, Opera GX found from their app bundles") if {"Google Chrome", "Safari", "Opera GX"} <= apps else bad("apps %r" % apps)
ok("a Chrome helper alone never counts as Chrome running") if "Google Chrome" not in A.running_apps(procs[1:2]) else bad("helper counted as the browser")
called = []
A2 = load("lockqz-agent.py")   # a fresh copy: earlier sections replaced A.browser_tabs
A2.osa = lambda script, *a, **k: called.append(script) or "[]"
A2.ps_procs = lambda: procs
A2.browser_tabs()
ok("no System Events call at all") if not any("System Events" in c for c in called) else bad("System Events used")
ok("tabs asked only of running browsers") if any("Google Chrome" in c for c in called) and not any("Microsoft Edge" in c for c in called) else bad("calls %r" % called)
shown = []
_real_osa2, _real_thr = A.osa, A.threading.Thread
class _T:
    def __init__(self, target=None, daemon=None): self.t = target
    def start(self): shown.append(1)
A.threading.Thread = _T; A._hinted.clear()
A.permission_hint("Safari", now=1000, front="Safari")
A.permission_hint("Safari", now=1100, front="Safari")
A.permission_hint("Safari", now=1000 + A.HINT_EVERY + 1, front="Google Chrome")
A.permission_hint("Safari", now=1000 + A.HINT_EVERY + 2, front="Safari")
A.threading.Thread = _real_thr
ok("permission hint at once, then again only when that browser is in front (>= 10 min apart)") if len(shown) == 2 else bad("hints shown %d" % len(shown))
""")
_section(r"""
print("T17 G15: AI search pages go to plain Google web results, even without q")
W = "https://www.google.com/search?udm=14&q="
ok("AI Mode (udm=50) without q") if A.rewrite_search("https://www.google.com/search?udm=50") == W else bad(A.rewrite_search("https://www.google.com/search?udm=50"))
ok("AI Mode home ?udm=50 on /") if A.rewrite_search("https://www.google.com/?udm=50") == W else bad("udm on /")
ok("Google Lens") if A.rewrite_search("https://lens.google.com/search?p=abc") else bad("lens kept")
ok("google.com/ai") if A.rewrite_search("https://www.google.com/ai?q=x") else bad("/ai kept")
ok("plain web/images results left alone") if A.rewrite_search(W + "x") is None and A.rewrite_search("https://www.google.com/search?tbm=isch&q=x") is None else bad("web rewritten")
ok("Google home page left alone") if A.rewrite_search("https://www.google.com/") is None else bad("home rewritten")
""")
_section(r"""
print("T18 G11: open AI tabs are sent to about:blank at lock")
hosts, paths = A.parse_blocklist(["# c", "chatgpt.com", "bing.com/chat", "huggingface.co/chat", "x.com/i/grok"])
bt = lambda u: A.blocked_tab(u, hosts, paths)
ok("chatgpt.com and its subdomains") if bt("https://chatgpt.com/c/1") and bt("https://www.chatgpt.com/") and bt("https://ab.chatgpt.com/x") else bad("chatgpt kept")
ok("path entries (bing.com/chat, huggingface.co/chat, x.com/i/grok)") if bt("https://www.bing.com/chat?q=1") and bt("https://huggingface.co/chat/") and bt("https://x.com/i/grok") else bad("path entry kept")
ok("not: Brightspace, bing search, huggingface models, x.com, Google search, notchatgpt.com") if not any(bt(u) for u in [B + "/d2l/home/1", "https://www.bing.com/search?q=1", "https://huggingface.co/models", "https://x.com/home", "https://www.google.com/search?q=1", "https://notchatgpt.com/"]) else bad("over-blank")
g, h = agent()
sets = []; A.set_tab_url = lambda app, wi, ti, url: sets.append((ti, url))
g.blocklist = lambda: (hosts, paths)
A.ps_procs = lambda: []
T(g, [tab(ATT), ("Google Chrome", 0, 1, "https://chatgpt.com/c/1"), ("Google Chrome", 0, 2, "https://docs.google.com/x"), ("Firefox", -1, -1, "https://claude.ai/")])
T(g, [tab(ATT), ("Google Chrome", 0, 1, "https://chatgpt.com/c/1"), ("Google Chrome", 0, 2, "https://docs.google.com/x")])
ok("locked: the ChatGPT tab is blanked, notes and the quiz are not") if (1, "about:blank") in sets and not any(t in (0, 2) for (t, _) in sets) else bad("sets %r" % sets)
""")
_section(r"""
print("T19 C2 / C10 / verify: the password answer drives what the agent does next")
ok("not started: every 5 min until 90 s before it opens") if A.next_password_check(0, 3600) == 300 and A.next_password_check(3200, 3600) == 3500 else bad("schedule %r" % [A.next_password_check(0, 3600), A.next_password_check(3200, 3600)])
ok("... then every 15 s; unknown start -> 5 min") if A.next_password_check(3550, 3600) == 3565 and A.next_password_check(0, None) == 300 else bad("late schedule")
msgs = []; A.dialog = lambda m, *a, **k: msgs.append(m)
class H2(FakeHelper):
    def __init__(self, reply): FakeHelper.__init__(self); self.reply = reply
    def __call__(self, path, body=None, timeout=90):
        if path == "/password": self.calls.append((path, body)); return dict(self.reply)
        return FakeHelper.__call__(self, path, body, timeout)
g = A.Agent(); g.verified = True; h = H2({"password": None, "status": 403, "reason": "not started", "start_in": 1200}); g.helper = h
T(g, [tab(SUMM)])
n = sum(1 for (p, _) in h.calls if p == "/password")
ok("locked, one password ask, 'opens at' shown once") if g.locked and n == 1 and sum("opens at" in m for m in msgs) == 1 else bad("n=%d msgs=%r" % (n, msgs))
for _ in range(5): T(g, [tab(SUMM)])
ok("no re-ask every 15 s while the quiz has not opened (C2 budget)") if sum(1 for (p, _) in h.calls if p == "/password") == 1 else bad("asked %d times" % sum(1 for (p, _) in h.calls if p == "/password"))
g.pw_next = 0; h.reply = {"password": "PW2", "status": 200}; T(g, [tab(SUMM)])
ok("when it opens the password is shown") if g.pw == "PW2" and any("PW2" in m for m in msgs) else bad("pw %r" % g.pw)
g = A.Agent(); g.verified = True; h = H2({"password": None, "status": 403, "reason": "other_school"}); g.helper = h; msgs[:] = []
T(g, [tab(SUMM)])
ok("other school: told once, agent not locked") if not g.locked and any("not set up for this school" in m for m in msgs) else bad("locked=%r msgs=%r" % (g.locked, msgs))
for _ in range(3): T(g, [tab(SUMM)])
ok("... and never re-locked while the page stays open") if sum(1 for (p, _) in h.calls if p == "/lock") == 1 else bad("re-locked")
g = A.Agent(); g.verified = True; h = H2({"password": None, "status": 402, "reason": "verify"}); g.helper = h
asked = []; g.ensure_identity = lambda force=False: asked.append(force)
T(g, [tab(SUMM)])
ok("server needs the email confirmed -> setup asked") if asked and asked[0] is True else bad("no setup on verify")
""")
_section(r"""
print("T20 G3/G4: Firefox and the Opera family are closed at lock unless the quiz is in them")
procs = [(11, 5, "/Applications/Firefox.app/Contents/MacOS/firefox"), (12, 5, "/Applications/Opera.app/Contents/MacOS/Opera"),
         (13, 5, "/Applications/Opera GX.app/Contents/MacOS/Opera"), (14, 5, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
         (15, 5, "/Applications/Tor Browser.app/Contents/MacOS/firefox")]
ok("quiz in Chrome: Firefox (incl. Tor Browser) + every Opera closed, Chrome kept") if sorted(p for p, _ in A.gecko_pids(procs, "Google Chrome") + A.no_policy_pids(procs, "Google Chrome")) == [11, 12, 13, 15] else bad("pids")
ok("quiz in Firefox: Firefox kept") if not [p for p, _ in A.gecko_pids(procs, "Firefox") if p == 11] else bad("closed the quiz browser")
ok("quiz in Opera GX: Opera GX kept, Opera closed") if [p for p, _ in A.no_policy_pids(procs, "Opera GX")] == [12] else bad("opera gx")
killed, msgs = [], []
A.dialog = lambda m, *a, **k: msgs.append(m); A.close_pids = lambda pids: killed.extend(pids) or bool(pids)
A.ps_procs = lambda: procs
g, h = agent(); T(g, [tab(ATT)])
ok("lock message says Firefox and Opera were closed") if any("Firefox and Opera were closed" in m for m in msgs) and {p for p, _ in killed} >= {11, 12, 13} else bad("msgs %r killed %r" % (msgs, killed))
g, h = agent(); msgs[:] = []; T(g, [("Opera", 0, 0, ATT)])
ok("quiz in Opera: student told to use another browser") if any("Please take this quiz in" in m for m in msgs) else bad("no Opera warning: %r" % msgs)
""")
_section(r"""
print("T21 C9: a quiz the server released (submitted) is never re-locked; UA from the release version")
g, h = agent(); T(g, [tab(ATT)])
h.status = {"state": "unlocked", "capped_quiz": "123-456", "capped_reason": "quiz_submitted"}
g.last_check = 0; T(g, [tab(ATT)])
for _ in range(3): g.last_check = 0; T(g, [tab(ATT)])
ok("helper released it -> agent unlocked, no re-lock") if not g.locked and sum(1 for (p, _) in h.calls if p == "/lock") == 1 else bad("calls %r" % h.calls)
import re as _re
ok("agent User-Agent version = the helper's VERSION") if A.VERSION == _re.search(r'^VERSION = "([^"]+)"', open(os.path.join(MAC, "lockqzd.py")).read(), _re.M).group(1) else bad("UA version %s" % A.VERSION)
lg = os.path.join(tempfile.mkdtemp(), "a.log"); A._LOGF, A.LOG_MAX = lg, 100
for i in range(20): A.log("line %d" % i)
ok("agent log rotated at its size limit") if os.path.exists(lg + ".1") and os.path.getsize(lg) < 200 else bad("agent log not rotated")
""")

_section(r"""
print("T22 round-2 #4: a released quiz locks again for a NEW attempt or once its page was closed (no 24 h re-add)")
g, h = agent(); T(g, [tab(ATT)])
h.status = {"state": "unlocked", "capped_quiz": "123-456", "capped_reason": "quiz_submitted", "capped_at": _t.time()}
g.last_check = 0; T(g, [tab(ATT)])
ok("released mid-attempt -> stays unlocked while on the attempt page") if not g.locked else bad("re-locked mid-attempt")
T(g, [tab(SUMM)]); g.last_check = 0; T(g, [tab(SUMM)])
ok("back on the quiz summary -> still unlocked (the release holds while its page is open)") if not g.locked else bad("re-locked on the summary page")
n0 = sum(1 for (p, _) in h.calls if p == "/lock")
T(g, [tab(ATT)])
ok("a NEW attempt after the summary page -> locks again, helper told /uncap") if g.locked and sum(1 for (p, _) in h.calls if p == "/lock") == n0 + 1 and any(p == "/uncap" for (p, _) in h.calls) else bad("new attempt not locked: %r" % h.calls[-4:])
g, h = agent(); T(g, [tab(ATT)])
rel = _t.time() - 5
h.status = {"state": "unlocked", "capped_quiz": "123-456", "capped_reason": "cap", "capped_at": rel}
g.last_check = 0; T(g, [tab(ATT)])
g.capped["123-456"] = _t.time() - A.GRACE - 1; T(g, [])        # page closed for the grace period -> forgotten
for _ in range(3): g.last_check = 0; T(g, [])                   # helper still reports the old release
ok("page closed: the helper's old release is not re-added") if "123-456" not in g.capped else bad("re-added from /status: %r" % g.capped)
T(g, [tab(ATT)])
ok("... and opening the quiz again locks") if g.locked else bad("never locks again after the release")
g, h = agent(); T(g, [tab(ATT)])
h.status = {"state": "unlocked", "capped_quiz": "123-456", "capped_at": _t.time()}
g.last_check = 0; T(g, [tab(ATT)]); g.capped["123-456"] = _t.time() - A.GRACE - 1; T(g, [])
h.status = {"state": "unlocked", "capped_quiz": "123-456", "capped_at": _t.time() + 1}   # a NEW release later
g.last_check = 0; T(g, [])
ok("a later release of the same quiz is honored again") if "123-456" in g.capped else bad("new release ignored")
print("T23 a quiz opened from Brightspace Content (quiz in a frame) is moved to its own page, so submitting shows")
CV = B + "/d2l/le/content/123/fullscreen/77/ViewLocation?title=Q&location=%2fd2l%2flms%2fquizzing%2fuser%2fquiz_summary.d2l%3fqi%3d456%26ou%3d123"
moved = []; _st = A.set_tab_url; A.set_tab_url = lambda a, w, t, u: moved.append((a, w, t, u))
try:
    g, h = agent(); T(g, [tab(CV)])
finally: A.set_tab_url = _st
ok("Content view tab -> its tab is sent to the quiz's own page") if any(u == SUMM for (_, _, _, u) in moved) else bad("not moved: %r" % moved)
ok("... and the quiz locks at once (same lock id)") if g.locked and any(p == "/lock" and b.get("quiz_id") == "123-456" for (p, b) in h.calls) else bad("not locked: %r" % h.calls)
moved = []; A.set_tab_url = lambda a, w, t, u: moved.append(u)
try: g, h = agent(); T(g, [tab(B + "/d2l/le/content/123/fullscreen/77/ViewLocation?location=%2fcontent%2fnotes.pdf")])
finally: A.set_tab_url = _st
ok("a Content view of a file is left alone") if not moved and not g.locked else bad("moved/locked a file view: %r" % moved)
fx = {"windows": [{"tabs": [{"index": 1, "entries": [{"url": CV, "children": [{"url": SUBM}]}]}]}]}
A._moved.clear(); got = []; tb = [("Safari", 0, 0, CV)]
A.move_content_quizzes(tb, now=1000.0, setter=lambda a, w, t, u: got.append(u))
A.move_content_quizzes(tb, now=1005.0, setter=lambda a, w, t, u: got.append(u))
ok("a page still loading is not sent there again within 10 s (no reload loop)") if got == [SUMM] else bad("moves: %r" % got)
A.move_content_quizzes(tb, now=1011.0, setter=lambda a, w, t, u: got.append(u))
ok("... but is retried after 10 s if the move did not take") if got == [SUMM, SUMM] else bad("moves: %r" % got)
A.move_content_quizzes([("Firefox", -1, -1, CV)], now=2000.0, setter=lambda a, w, t, u: got.append(u))
ok("a tab read from Firefox's session file is never moved (no address to set)") if len(got) == 2 else bad("moves: %r" % got)
A._moved.clear()
ok("Firefox: the frame's current page (submitted) is read from the session store") if A.firefox_urls(fx) == [SUBM] else bad("firefox: %r" % A.firefox_urls(fx))
""")

print(""); print(f"RESULT: {passed} passed, {failed} failed"); sys.exit(0 if failed == 0 else 1)
