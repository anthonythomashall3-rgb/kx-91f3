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

tmp = tempfile.mkdtemp(); os.environ["LOCKQZ_POLICY_DIR"] = tmp
os.environ["LOCKQZ_FF_IDS"] = "org.mozilla.firefox,org.mozilla.librewolf,net.waterfox.waterfox,one.ablaze.floorp,app.zen_browser.zen"
A = load("lockqz-agent.py"); P = load("browser-policy.py")

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
ok("Chrome: Web allowed beats search blocked") if "google.com/search" in ch["URLBlocklist"] and "google.com/search@udm=14" in ch["URLAllowlist"] else bad("url lists wrong")
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

print(""); print(f"RESULT: {passed} passed, {failed} failed"); sys.exit(0 if failed == 0 else 1)
