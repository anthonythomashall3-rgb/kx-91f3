#!/usr/bin/env python3
"""Sweep 28 (22 Nov 2026), Mac / Linux agent and helper, no root, no network:
  E  what the agent saw of the exam's attempt goes with its unlock: sub = the exam's turned-in page took the
     place of its attempt page in the same tab, on the same Brightspace host; attempt = an attempt page was seen
     (False only from live tab lists, never for an adopted lock or a session file); kept when the student comes
     back to the exam; a tab keeps its key while windows are reordered; the hold note says what to do.
  F  the exam's own Firefox, already running when the lock began, is restarted once (it reads the quiz policies
     only when it starts); its page being gone meanwhile ends nothing.
  K  the helper passes the agent's view on (booleans only); an unlock that cannot reach LOCKqz while this
     computer is offline is held and not counted toward the 10 minutes after which it stands.
"""
import importlib.util, json, os, sys, tempfile, threading, time, http.client
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__)); MAC = os.path.join(HERE, "..", "mac")
PASS = FAIL = 0
def check(m, c, extra=""):
    global PASS, FAIL
    if c: PASS += 1; print("  ok:", m)
    else: FAIL += 1; print("  FAIL:", m, extra)
def load(name, as_name):
    spec = importlib.util.spec_from_file_location(as_name, os.path.join(MAC, name))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m

os.environ["HOME"] = tempfile.mkdtemp()
A = load("lockqz-agent.py", "lockqz_agent_s28")
MSGS = []
A.dialog = lambda text, *a, **k: MSGS.append(text); A.clipboard = lambda *a, **k: None
A.set_tab_url = lambda *a, **k: False; A.osa = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no osascript here"))
A.ps_procs = lambda: []

class FakeHelper:
    def __init__(self): self.calls, self.status, self.hold = [], {"state": "unlocked"}, False
    def __call__(self, path, body=None, timeout=90):
        self.calls.append((path, body))
        if path == "/lock": self.status = {"state": "locked", "quiz_id": body["quiz_id"]}; return {"ok": True, "state": "locked"}
        if path == "/unlock":
            if self.hold: return {"ok": False, "state": "locked", "pending": "brightspace"}
            self.status = {"state": "unlocked"}; return {"ok": True, "state": "unlocked"}
        if path == "/password": return {"password": "PW"}
        if path == "/status": return dict(self.status)
        return {"ok": True}
def agent():
    g = A.Agent(); h = FakeHelper(); g.helper = h; g.verified = True; g.ready_told = True
    return g, h
def T(g, tabs, keys=None):
    A.browser_tabs = lambda: list(tabs); A.developer_mode = lambda: False
    A.TAB_KEYS.clear(); A.TAB_KEYS.update(keys or {})
    g.tick()
def unlocks(h): return [b for (p, b) in h.calls if p == "/unlock"]
B = "https://brightspace.usc.edu"
SUMM = B + "/d2l/lms/quizzing/user/quiz_summary.d2l?qi=456&ou=123"
ATT = B + "/d2l/lms/quizzing/user/attempt/quiz_start_frame_auto.d2l?ou=123&isprv=0&drc=0&qi=456&cfql=0&dnb=0"
SUBM = B + "/d2l/lms/quizzing/user/quiz_submissions_attempt.d2l?qi=456&ou=123&ai=9"
LIST = B + "/d2l/lms/quizzing/user/quizzes_list.d2l?ou=123"
GC = "Google Chrome"

print("E what the agent saw of the attempt goes with its unlock")
g, h = agent()
T(g, [(GC, 0, 0, SUMM)]); T(g, [(GC, 0, 0, ATT)]); T(g, [(GC, 0, 0, SUBM)])
u = unlocks(h)
check("start page, attempt, then the turned-in page in the same tab -> 'submitted' with sub + attempt",
      not g.locked and u and u[-1]["reason"] == "quiz_submitted" and u[-1]["seen"] == {"sub": True, "attempt": True}, str(u[-1:]))
g, h = agent()
T(g, [(GC, 0, 0, ATT)]); T(g, [(GC, 0, 0, "https://docs.google.com/x")])
g.missing_since = time.time() - A.GRACE - 1; T(g, [(GC, 0, 0, "https://docs.google.com/x")])
u = unlocks(h)
check("attempt, then the exam gone -> its unlock says an attempt was seen, not turned in",
      u and u[-1]["seen"] == {"sub": False, "attempt": True} and u[-1]["reason"] in ("quiz_left", "quiz_tab_closed"), str(u[-1:]))
g, h = agent()
T(g, [(GC, 0, 0, ATT)]); T(g, [(GC, 0, 1, SUBM)])
u = unlocks(h)
check("the attempt tab closed and a turned-in page of the exam open in ANOTHER tab -> not sub", u and u[-1]["seen"]["sub"] is False, str(u[-1:]))
g, h = agent()
T(g, [(GC, 0, 0, ATT)]); T(g, [(GC, 0, 0, "https://lookalike.example.com/d2l/lms/quizzing/user/quiz_submissions_attempt.d2l?qi=456&ou=123&ai=9")])
g.missing_since = time.time() - A.GRACE - 1; T(g, [(GC, 0, 0, "https://lookalike.example.com/")])
u = unlocks(h)
check("a turned-in page on another host in the same tab -> not sub", u and u[-1]["seen"]["sub"] is False, str(u[-1:]))
g, h = agent()
T(g, [(GC, 0, 0, SUMM)]); T(g, [(GC, 0, 0, LIST)])
u = unlocks(h)
check("start page only, then the quiz list -> no attempt seen (live tab list)", u and u[-1]["seen"] == {"sub": False, "attempt": False}, str(u[-1:]))
g, h = agent()
T(g, [("Firefox", -1, -1, SUMM)]); T(g, [("Firefox", -1, -1, LIST)])
u = unlocks(h)
check("seen only in a session file (Firefox / Linux) -> attempt unknown (None), never False", u and u[-1]["seen"]["attempt"] is None, str(u[-1:]))
g, h = agent()
h.status = {"state": "locked", "quiz_id": "123-456"}; g.last_check = 0; T(g, [])
check("set-up: an existing helper lock is adopted", g.locked and g.quiz == "123-456")
g.missing_since = time.time() - A.GRACE - 1; T(g, [(GC, 0, 0, "https://example.com/")])
u = unlocks(h)
check("an adopted lock never says 'no attempt' (it did not watch the whole lock)", u and u[-1]["seen"]["attempt"] is None, str(u[-1:]))

print("E2 a student who steps out of the exam and comes back")
g, h = agent(); h.hold = True; MSGS.clear()
T(g, [(GC, 0, 0, ATT)]); T(g, [(GC, 0, 0, LIST)])
check("left mid-attempt and LOCKqz holds it: the agent keeps the unlock pending and says what to do",
      g.pending and g.pending[0] == "123-456" and any("submit it" in m for m in MSGS), "%r %r" % (g.pending, MSGS[-1:]))
check("... the note is the new one (go back and submit)", any(m.startswith("AI stays off: this exam was not turned in") for m in MSGS))
T(g, [(GC, 0, 0, SUMM)])
check("back on the exam's start page: locked again, the pending unlock dropped", g.locked and g.pending is None)
T(g, [(GC, 0, 0, LIST)])
u = unlocks(h)
check("... leaving again from the start page still says an attempt was seen (kept for this exam)", u and u[-1]["seen"]["attempt"] is True, str(u[-1:]))
h.hold = False; T(g, [(GC, 0, 0, SUMM)]); T(g, [(GC, 0, 0, ATT)]); T(g, [(GC, 0, 0, SUBM)])
u = unlocks(h)
check("... then submitted for real in the attempt's tab -> sub", u and u[-1]["seen"] == {"sub": True, "attempt": True}, str(u[-1:]))

print("E3 a tab keeps its key when windows are reordered")
g, h = agent()
NOTES = "https://docs.google.com/document/d/n"
T(g, [(GC, 0, 0, NOTES), (GC, 1, 0, ATT)], {(GC, 0, 0): (GC, 12, 3), (GC, 1, 0): (GC, 77, 5)})
T(g, [(GC, 0, 0, SUBM), (GC, 1, 0, NOTES)], {(GC, 0, 0): (GC, 77, 5), (GC, 1, 0): (GC, 12, 3)})
u = unlocks(h)
check("the attempt's window came to the front before it was turned in: still the same tab -> sub", u and u[-1]["seen"]["sub"] is True, str(u[-1:]))
g, h = agent()
T(g, [(GC, 0, 0, NOTES), (GC, 1, 0, ATT)], {(GC, 0, 0): (GC, 12, 3), (GC, 1, 0): (GC, 77, 5)})
T(g, [(GC, 0, 0, SUBM), (GC, 1, 0, NOTES)], {(GC, 0, 0): (GC, 12, 3), (GC, 1, 0): (GC, 77, 5)})
u = unlocks(h)
check("a turned-in page in the notes tab (another tab id) -> not sub, even at the attempt's old place", u and u[-1]["seen"]["sub"] is False, str(u[-1:]))

print("E4 the browser tab list with tab keys (while locked) and without (old shape)")
real_bt = A.browser_tabs
A.browser_tabs = A.__dict__.get("_bt_real") or real_bt
spec = importlib.util.spec_from_file_location("lockqz_agent_s28b", os.path.join(MAC, "lockqz-agent.py"))
A2 = importlib.util.module_from_spec(spec); spec.loader.exec_module(A2)
A2.ps_procs = lambda: [(10, 100, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")]
A2.osa = lambda js, *a, **k: json.dumps([{"u": [SUMM, NOTES], "w": 77, "t": [5, 6]}, {"u": [ATT], "w": None, "t": None}]) if "w.id()" in js else json.dumps([[SUMM, NOTES], [ATT]])
A2.WANT_KEYS[0] = True; tabs = A2.browser_tabs()
check("locked: tabs read with window and tab ids", tabs == [(GC, 0, 0, SUMM), (GC, 0, 1, NOTES), (GC, 1, 0, ATT)] and A2.TAB_KEYS[(GC, 0, 1)] == (GC, 77, 6) and A2.TAB_KEYS[(GC, 1, 0)] == (GC, "w1", "#0"), str(A2.TAB_KEYS))
A2.WANT_KEYS[0] = False; tabs = A2.browser_tabs()
check("not locked: the plain list, as before (no keys)", tabs == [(GC, 0, 0, SUMM), (GC, 0, 1, NOTES), (GC, 1, 0, ATT)] and not A2.TAB_KEYS)

print("F the exam's own Firefox, open before the lock, is restarted once")
KILLS, RUNS = [], []
A.os.kill = lambda pid, sig: KILLS.append((pid, sig))
real_run = A.subprocess.run
A.subprocess.run = lambda cmd, *a, **k: RUNS.append(cmd)
A.ps_procs = lambda: [(4321, 600, "/Applications/Firefox.app/Contents/MacOS/firefox"), (99, 600, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")]
g, h = agent(); MSGS.clear()
T(g, [("Firefox", -1, -1, SUMM)])
time.sleep(2.6)
import signal
check("quiz open in a Firefox that was running before the lock: it is closed at once (forced: its tabs come back)", (4321, signal.SIGKILL) in KILLS and not any(p == 99 for p, _ in KILLS), str(KILLS))
check("... and opened again", ["open", "-a", "/Applications/Firefox.app"] in RUNS, str(RUNS))
check("... the student is told", any("Firefox was restarted for the exam" in m for m in MSGS), str(MSGS[-1:]))
T(g, [(GC, 0, 0, NOTES)]); g.missing_since = time.time() - A.GRACE - 1; T(g, [(GC, 0, 0, NOTES)])
check("while it restarts its exam page is gone: nothing ends (no unlock)", g.locked and not unlocks(h), str(unlocks(h)))
g.restart_wait = time.time() - 1; T(g, [(GC, 0, 0, NOTES)]); g.missing_since = time.time() - A.GRACE - 1; T(g, [(GC, 0, 0, NOTES)])
check("after the wait: the normal rule again (gone -> unlock asked)", not g.locked and unlocks(h))
KILLS.clear(); RUNS.clear()
A.ps_procs = lambda: [(4321, 0, "/Applications/Firefox.app/Contents/MacOS/firefox")]
g, h = agent(); T(g, [("Firefox", -1, -1, SUMM)]); time.sleep(0.3)
check("a Firefox started after the lock (it read the quiz policies) is left alone", not KILLS and not [r for r in RUNS if r[:1] == ["open"]], str(KILLS))
A.ps_procs = lambda: [(4321, 600, "/Applications/Firefox.app/Contents/MacOS/firefox")]
g, h = agent(); T(g, [(GC, 0, 0, SUMM)]); time.sleep(0.3)
check("quiz in Chrome: the exam's browser is not Firefox, nothing restarted here (Firefox is closed as before)", not [r for r in RUNS if r[:1] == ["open"]], str(RUNS))
A.subprocess.run = real_run; A.ps_procs = lambda: []

print("K the helper passes the agent's view on; offline never counts toward the 10 minutes")
TMP = tempfile.mkdtemp()
bl = os.path.join(TMP, "blocklist.txt"); open(bl, "w").write("chatgpt.com\n")
cfg = os.path.join(TMP, "config.json"); json.dump({"port": 18828, "api_base": "https://example.invalid/api", "device_id": "mac-s28"}, open(cfg, "w"))
os.environ.update(LOCKQZ_DRYRUN="1", LOCKQZ_CONFIG=cfg, LOCKQZ_BLOCKLIST=bl, LOCKQZ_LOCKFILE=os.path.join(TMP, "active_lock.json"),
                  LOCKQZ_TOKEN_FILE=os.path.join(TMP, "helper.token"), LOCKQZ_TOKEN_DIR=os.path.join(TMP, "tokens"), LOCKQZ_NO_DEVMODE="1")
D = load("lockqzd.py", "lockqzd_s28")
ENG = {"up": False}
D.engine = lambda cmd: ENG.update(up=(cmd == "lock")) or True
D.engine_locked = lambda: ENG["up"]; D.engine_ok = lambda: ENG["up"]
D.developer_mode = lambda: False; D.covered = lambda url: True; D.vm_guest = lambda: None
UID = 501; D.console_uid = lambda: UID; D.session_alive = lambda u: True; D.share_token = lambda u: None
SRV = {"answer": (200, {"ok": True}), "seen": []}
def fake_report(event, extra=None):
    SRV["seen"].append((event, extra)); return SRV["answer"]
D.report = fake_report; D.report_lock_async = lambda *a, **k: None; D.report_async = lambda *a, **k: None; D.report_install = lambda: None
D.ensure_lock_reported = lambda q: None
NET = {"up": True}; D.online = lambda: NET["up"]
srv = ThreadingHTTPServer(("127.0.0.1", 0), D.H); port = srv.server_address[1]; D.PORT = port
threading.Thread(target=srv.serve_forever, daemon=True).start()
TOK = D.uid_token(UID)
def req(path, body=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    c.request("POST", path, body=json.dumps(body or {}), headers={"X-LOCKqz-Token": TOK, "Content-Type": "application/json"})
    r = c.getresponse(); data = r.read(); c.close()
    try: return r.status, json.loads(data)
    except Exception: return r.status, {}
def last_ask():
    return [x for (e, x) in SRV["seen"] if e == "unlock" and ((x or {}).get("detail") or {}).get("ask")][-1]["detail"]
req("/lock", {"quiz_id": "500-1"})
s, j = req("/unlock", {"quiz_id": "500-1", "reason": "quiz_submitted", "seen": {"sub": True, "attempt": False, "extra": 1}})
check("the agent's view goes with the ask: booleans only", last_ask().get("seen") == {"sub": True, "attempt": False} and s == 200, str(last_ask()))
req("/lock", {"quiz_id": "500-1"})
req("/unlock", {"quiz_id": "500-1", "reason": "quiz_left", "seen": {"sub": "yes", "attempt": "no"}})
check("anything else in it is not passed as true", last_ask().get("seen") == {"sub": False, "attempt": None}, str(last_ask()))
req("/lock", {"quiz_id": "500-1"})
req("/unlock", {"quiz_id": "500-1", "reason": "quiz_left"})
check("an agent that sends nothing: no seen (the server keeps the older rule for it)", "seen" not in last_ask(), str(last_ask()))

req("/lock", {"quiz_id": "500-2"}); SRV["answer"] = (0, None); NET["up"] = False
s, j = req("/unlock", {"quiz_id": "500-2", "reason": "quiz_left"})
check("LOCKqz unreachable and this computer offline: held (202), the 10 minutes not started",
      s == 202 and D.STATE["state"] == "locked" and "ask_fail_since" not in D.STATE, "%s %s" % (s, {k: D.STATE.get(k) for k in ("state", "ask_fail_since")}))
D.STATE["ask_fail_since"] = time.time() - 3600; D.STATE.pop("hold_until", None)
s, j = req("/unlock", {"quiz_id": "500-2", "reason": "quiz_left"})
check("... even an hour of trying while offline never lets it stand", s == 202 and D.STATE["state"] == "locked" and "ask_fail_since" not in D.STATE, str(s))
NET["up"] = True; D.STATE.pop("hold_until", None)
s, j = req("/unlock", {"quiz_id": "500-2", "reason": "quiz_left"})
check("online, LOCKqz still not answering: held, the 10 minutes start now", s == 202 and D.STATE.get("ask_fail_since"), str(s))
D.STATE["ask_fail_since"] = time.time() - 601; D.STATE.pop("hold_until", None)
s, j = req("/unlock", {"quiz_id": "500-2", "reason": "quiz_left"})
check("... 10 minutes online with no answer from LOCKqz: it stands (unchanged)", s == 200 and D.STATE["state"] == "unlocked", str((s, j)))
SRV["answer"] = (200, {"ok": True})
check("seen_of: a non-dict is nothing", D.seen_of("x") is None and D.seen_of(None) is None)

srv.shutdown()
print("\nRESULT: %d passed, %d failed" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
