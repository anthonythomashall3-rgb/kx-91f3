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
written = sorted(os.listdir(tmp))
ok("7 browsers + untouched file present") if len(written) == 8 else bad("files: " + str(written))
with open(os.path.join(tmp, "com.google.Chrome.plist"), "rb") as f: ch = plistlib.load(f)
ok("Chrome: AI off + Web search pinned") if ch["GeminiSettings"] == 1 and ch["GenAiDefaultSettings"] == 2 and "udm=14" in ch["DefaultSearchProviderSearchURL"] else bad("chrome policy wrong")
ok("Chrome: Web allowed beats search blocked") if "google.com/search" in ch["URLBlocklist"] and "google.com/search@udm=14" in ch["URLAllowlist"] else bad("url lists wrong")
with open(os.path.join(tmp, "org.mozilla.firefox.plist"), "rb") as f: ff = plistlib.load(f)
ok("Firefox: filter + AI chat off") if ff["WebsiteFilter"]["Block"] and ff["Preferences"]["browser.ml.chat.enabled"]["Value"] is False else bad("firefox policy wrong")
P.unlock()
ok("unlock leaves only the foreign file") if os.listdir(tmp) == ["com.apple.Other.plist"] else bad("after unlock: " + str(os.listdir(tmp)))

print(""); print(f"RESULT: {passed} passed, {failed} failed"); sys.exit(0 if failed == 0 else 1)
