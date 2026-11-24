#!/usr/bin/env python3
"""Sweep 36 (24 Nov 2026): a computer that runs for weeks without a restart or an app update still tells LOCKqz it is
there, so the professor's page keeps it "ready" (seen in the last 30 days): the 12-hour round of the real watch_once
in app/mac/lockqzd.py (Mac and Linux) also sends the install report when the last one is a week old."""
import importlib.util, os, tempfile, json, threading, time as REAL
HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="lqz-s36-")
bl = os.path.join(TMP, "blocklist.txt"); open(bl, "w").write("chatgpt.com\nclaude.ai\n")
cfg = os.path.join(TMP, "config.json"); json.dump({"port": 18836, "api_base": "https://example.invalid/api", "device_id": "mac-s36"}, open(cfg, "w"))
os.environ.update(LOCKQZ_DRYRUN="1", LOCKQZ_CONFIG=cfg, LOCKQZ_BLOCKLIST=bl, LOCKQZ_LOCKFILE=os.path.join(TMP, "active_lock.json"),
                  LOCKQZ_TOKEN_FILE=os.path.join(TMP, "helper.token"), LOCKQZ_TOKEN_DIR=os.path.join(TMP, "tokens"), LOCKQZ_NO_DEVMODE="1")
spec = importlib.util.spec_from_file_location("lockqzd_s36", os.path.join(HERE, "..", "mac", "lockqzd.py"))
D = importlib.util.module_from_spec(spec); spec.loader.exec_module(D)
ok = bad = 0
def check(m, c, i=""):
    global ok, bad
    if c: ok += 1; print("  ok:", m)
    else: bad += 1; print("  FAIL:", m, ("(%s)" % i) if i else "")

sent = []
def fake_report(event, extra=None):
    sent.append(event); return 200, {"ok": True}
D.report = fake_report
D.refresh_blocklist = lambda: None
D.check_update = lambda: None
D.register = lambda *a, **k: None
D.rotate_log = lambda *a, **k: None
D.share_token = lambda *a, **k: None
D.developer_mode = lambda: False
D.INSTFILE = os.path.join(TMP, "install_report.json")
clock = [1_800_000_000.0]
class T:
    def __getattr__(self, k): return getattr(REAL, k)
    def time(self): return clock[0]
D.time = T()
D._write_private = lambda p, s: open(p, "w").write(s)

def settle():
    for t in threading.enumerate():
        if t is not threading.current_thread() and t.daemon and t.name != "MainThread": t.join(2)

print("W1 the rule")
rec = {"version": D.VERSION, "student": "a@usc.edu", "at": clock[0]}
check("a day later: no report by the 24 h rule's week", not D.install_due(rec, D.VERSION, "a@usc.edu", clock[0] + 86400, D.SEEN_EVERY))
check("a week later: report", D.install_due(rec, D.VERSION, "a@usc.edu", clock[0] + D.SEEN_EVERY, D.SEEN_EVERY))
check("the start / student rule is unchanged (24 h)", D.install_due(rec, D.VERSION, "a@usc.edu", clock[0] + 86400) and not D.install_due(rec, D.VERSION, "a@usc.edu", clock[0] + 3600))
check("a week is well inside the professor's 30 days", D.SEEN_EVERY <= 10 * 86400)

print("W2 the 12-hour round of a helper that never restarts")
D.STATE.update(state="unlocked", quiz_id=None, unlock_pending=False, student="a@usc.edu")
json.dump({"version": D.VERSION, "student": "a@usc.edu", "at": clock[0]}, open(D.INSTFILE, "w"))
for k in D.WALL: D.WALL[k] = clock[0]
sent.clear()
clock[0] += 5; D.watch_once(8640, clock[0]); settle()
check("12 h after the last report: nothing sent", "install" not in sent, sent)
clock[0] += 8 * 86400; D.watch_once(8641, clock[0]); clock[0] += 25; D.watch_once(8642, clock[0]); settle()
check("8 days later (12-hour round due by the clock): the report is sent", sent.count("install") == 1, sent)
rec2 = json.load(open(D.INSTFILE))
check("... and recorded, so the next week starts now", abs(float(rec2.get("at", 0)) - clock[0]) < 60, rec2)
sent.clear(); clock[0] += 13 * 3600; D.watch_once(8643, clock[0]); settle()
check("the next 12-hour round: nothing (a week not passed)", "install" not in sent, sent)

print("W3 never in the way")
D.report_install = lambda: None   # an older stub that takes no argument (other suites do this)
check("report_seen never raises", D.report_seen() is False)

print("\n%d passed, %d failed" % (ok, bad))
raise SystemExit(1 if bad else 0)
