#!/usr/bin/env python3
"""Bug sweep 22 (13 Nov 2026), the Mac / Linux helper under load (lockqzd.py), no root, no network:
  R1 an unlock that is still waiting for the server's answer never ends ANOTHER quiz locked meanwhile;
  R2 the helper's watcher keeps running after a cycle that failed (full disk, a broken file): the block is still
     re-applied, the safety cap still ends a lock, heartbeats continue;
  R3 300 mixed control requests from 12 callers at once: every one is answered, the helper's state and the block
     always agree at the end, the lock record on disk matches.
"""
import importlib.util, json, os, sys, tempfile, threading, time, random, http.client
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__)); MAC = os.path.join(HERE, "..", "mac")
PASS = FAIL = 0
def check(m, c, extra=""):
    global PASS, FAIL
    if c: PASS += 1; print("  ok:", m)
    else: FAIL += 1; print("  FAIL:", m, extra)

TMP = tempfile.mkdtemp()
bl = os.path.join(TMP, "blocklist.txt"); open(bl, "w").write("chatgpt.com\nclaude.ai\n")
cfg = os.path.join(TMP, "config.json"); json.dump({"port": 18822, "api_base": "https://example.invalid/api", "device_id": "mac-sweep22"}, open(cfg, "w"))
LOCKFILE = os.path.join(TMP, "active_lock.json")
os.environ.update(LOCKQZ_DRYRUN="1", LOCKQZ_CONFIG=cfg, LOCKQZ_BLOCKLIST=bl, LOCKQZ_LOCKFILE=LOCKFILE,
                  LOCKQZ_TOKEN_FILE=os.path.join(TMP, "helper.token"), LOCKQZ_TOKEN_DIR=os.path.join(TMP, "tokens"), LOCKQZ_NO_DEVMODE="1")
spec = importlib.util.spec_from_file_location("lockqzd_s22", os.path.join(MAC, "lockqzd.py"))
D = importlib.util.module_from_spec(spec); spec.loader.exec_module(D)

# a pretend engine that is the block: "lock" puts it up, "unlock" takes it down, and it notes every run
ENG = {"up": False, "runs": [], "overlap": 0, "busy": 0}
def fake_engine(cmd):
    ENG["busy"] += 1
    if ENG["busy"] > 1: ENG["overlap"] += 1          # two engine runs at once would corrupt the hosts file
    time.sleep(0.002)
    if cmd == "lock": ENG["up"] = True
    elif cmd == "unlock": ENG["up"] = False
    ENG["runs"].append(cmd); ENG["busy"] -= 1
    return True
D.engine = fake_engine; D.engine_locked = lambda: ENG["up"]; D.engine_ok = lambda: ENG["up"]
D.developer_mode = lambda: False; D.covered = lambda url: True; D.vm_guest = lambda: None
UID = 501; D.console_uid = lambda: UID; D.session_alive = lambda u: True; D.share_token = lambda u: None
SERVER = {"delay": 0.0, "answer": {"ok": True}, "seen": []}
def fake_report(event, extra=None):
    SERVER["seen"].append((event, (extra or {}).get("quiz_id")))
    if event == "unlock" and ((extra or {}).get("detail") or {}).get("ask"): time.sleep(SERVER["delay"])
    return 200, dict(SERVER["answer"])
D.report = fake_report; D.report_lock_async = lambda *a, **k: None; D.report_async = lambda *a, **k: None; D.report_install = lambda: None
D.ensure_lock_reported = lambda q: None

srv = ThreadingHTTPServer(("127.0.0.1", 0), D.H); port = srv.server_address[1]; D.PORT = port
threading.Thread(target=srv.serve_forever, daemon=True).start()
TOK = D.uid_token(UID)
def req(path, body=None, method="POST"):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    c.request(method, path, body=json.dumps(body or {}) if method == "POST" else None, headers={"X-LOCKqz-Token": TOK, "Content-Type": "application/json"})
    r = c.getresponse(); data = r.read(); c.close()
    try: return r.status, json.loads(data)
    except Exception: return r.status, {}

print("R1 a slow unlock answer and a new quiz")
s, j = req("/lock", {"quiz_id": "500-1"})
check("quiz 500-1 is locked", s == 200 and D.STATE["state"] == "locked" and ENG["up"])
SERVER["delay"] = 0.8; out = {}
t = threading.Thread(target=lambda: out.update(r=req("/unlock", {"quiz_id": "500-1", "reason": "quiz_submitted"}))); t.start()
time.sleep(0.25)
s2, j2 = req("/lock", {"quiz_id": "500-2"})          # the next quiz starts while the server is still being asked about the first
t.join(); SERVER["delay"] = 0.0
check("the late answer about 500-1 does not end 500-2: it stays locked with its block up, and the caller is told",
      s2 == 200 and D.STATE["state"] == "locked" and D.STATE["quiz_id"] == "500-2" and ENG["up"] and out["r"][0] == 409 and out["r"][1].get("error") == "not_this_quiz"
      and not D.STATE.get("release_pending"), "%s %s %s" % (D.STATE["state"], D.STATE["quiz_id"], out.get("r")))
s, j = req("/unlock", {"quiz_id": "500-2", "reason": "quiz_submitted"})
check("500-2 itself still ends normally", s == 200 and D.STATE["state"] == "unlocked" and not ENG["up"], str((s, j)))
SERVER["answer"] = {"ok": True, "hold": True}; req("/lock", {"quiz_id": "500-3"}); SERVER["delay"] = 0.6; out.clear()
t = threading.Thread(target=lambda: out.update(r=req("/unlock", {"quiz_id": "500-3"}))); t.start(); time.sleep(0.2)
D.server_release("500-3", "quiz_ended"); req("/lock", {"quiz_id": "500-4"}); t.join(); SERVER["delay"] = 0.0; SERVER["answer"] = {"ok": True}
check("a late HOLD about a finished quiz marks nothing on the next one", D.STATE["quiz_id"] == "500-4" and not D.STATE.get("release_pending") and not D.STATE.get("hold_until"), str({k: D.STATE.get(k) for k in ("quiz_id", "release_pending", "hold_until")}))
req("/unlock", {"quiz_id": "500-4"})

print("R2 the watcher survives a bad cycle")
real_sleep = time.sleep; ticks = {"n": 0}
class Stop(BaseException): pass
def fast_sleep(s):
    if s == 5:
        ticks["n"] += 1
        if ticks["n"] > 6: raise Stop()
        return
    real_sleep(s)
req("/lock", {"quiz_id": "500-9"}); ENG["up"] = False; ENG["runs"].clear()   # the block was taken away behind the helper's back
boom = {"n": 0}; real_locked = D.engine_locked
def flaky_locked():
    boom["n"] += 1
    if boom["n"] == 1: raise OSError(28, "No space left on device")
    return ENG["up"]
D.engine_locked = flaky_locked; D.time.sleep = fast_sleep
try: D.watcher()
except Stop: pass
D.time.sleep = real_sleep; D.engine_locked = real_locked
check("after a cycle that failed, the next cycles still run: the block is put back and the helper stays locked",
      boom["n"] >= 2 and ENG["up"] and "lock" in ENG["runs"] and D.STATE["state"] == "locked", "cycles %d runs %s" % (boom["n"], ENG["runs"][:6]))
req("/unlock", {"quiz_id": "500-9"})

print("R3 12 callers, 300 requests")
random.seed(22); errs = []; done = []
def worker(k):
    rnd = random.Random(k)
    for i in range(25):
        q = "600-%d" % rnd.randint(1, 3)
        op = rnd.choice(["lock", "lock", "unlock", "status", "password", "uncap", "heartbeat", "student"])
        try:
            if op == "status": s, j = req("/status", method="GET")
            elif op == "password": s, j = req("/password", {"url": "https://x.example/d2l/lms/quizzing/user/quiz_summary.d2l?ou=600&qi=%s" % q.split("-")[1]})
            elif op == "student": s, j = req("/student", {"student": "s%d@usc.edu" % k})
            else: s, j = req("/" + op, {"quiz_id": q, "reason": "quiz_submitted"})
            done.append((op, s))
            if s >= 500 and not (op == "password" and s == 502): errs.append((op, s, j))
        except Exception as e: errs.append((op, "no answer", str(e)))
D.call = lambda path, body, signed=True: (200, {"password": "pw", "end": None})
ths = [threading.Thread(target=worker, args=(k,)) for k in range(12)]
[t.start() for t in ths]; [t.join() for t in ths]
st = dict(D.STATE)
rec = json.load(open(LOCKFILE)) if os.path.exists(LOCKFILE) else None
check("all 300 requests were answered, none with a server error", len(done) == 300 and not errs, "%d answered, errors %s" % (len(done), errs[:3]))
check("the engine never ran twice at the same time", ENG["overlap"] == 0, str(ENG["overlap"]))
check("at the end the helper's state, the block and the lock record on disk agree",
      (st["state"] == "locked") == ENG["up"] and ((rec is not None and rec.get("quiz_id") == st["quiz_id"]) if st["state"] == "locked" else rec is None),
      "state %s quiz %s block %s record %s" % (st["state"], st["quiz_id"], ENG["up"], rec))
srv.shutdown()
print("\nRESULT: %d passed, %d failed" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
