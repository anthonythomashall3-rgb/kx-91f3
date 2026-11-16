#!/usr/bin/env python3
"""A laptop that slept catches up by the clock (0.6.28): the helper counts 5 s cycles, which only count time awake,
so list additions (every 12 h) and the update check (every 6 h) are also due by clock time, 20 s after a wake.
Runs the real watch_once of app/mac/lockqzd.py with a fake clock; also checks the Windows helper's same rule."""
import importlib.util, os, sys, tempfile, re
HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="lqz-wake-")
import json
bl = os.path.join(TMP, "blocklist.txt"); open(bl, "w").write("chatgpt.com\nclaude.ai\n")
cfg = os.path.join(TMP, "config.json"); json.dump({"port": 18828, "api_base": "https://example.invalid/api", "device_id": "mac-wake"}, open(cfg, "w"))
os.environ.update(LOCKQZ_DRYRUN="1", LOCKQZ_CONFIG=cfg, LOCKQZ_BLOCKLIST=bl, LOCKQZ_LOCKFILE=os.path.join(TMP, "active_lock.json"),
                  LOCKQZ_TOKEN_FILE=os.path.join(TMP, "helper.token"), LOCKQZ_TOKEN_DIR=os.path.join(TMP, "tokens"), LOCKQZ_NO_DEVMODE="1")
spec = importlib.util.spec_from_file_location("lockqzd_wake", os.path.join(HERE, "..", "mac", "lockqzd.py"))
D = importlib.util.module_from_spec(spec); spec.loader.exec_module(D)
ok = bad = 0
def check(m, c, i=""):
    global ok, bad
    if c: ok += 1; print("  ok:", m)
    else: bad += 1; print("  FAIL:", m, ("(%s)" % i) if i else "")

calls = []
D.refresh_blocklist = lambda: calls.append("list")
D.check_update = lambda: calls.append("update")
D.report = lambda *a, **k: None
D.register = lambda *a, **k: None
D.rotate_log = lambda *a, **k: None
D.share_token = lambda *a, **k: None
D.developer_mode = lambda: False
clock = [1_800_000_000.0]
class T:
    def __getattr__(self, k): return getattr(REAL, k)
    def time(self): return clock[0]
import time as REAL
D.time = T()
def start():
    calls.clear(); D.STATE.update(state="unlocked", quiz_id=None, unlock_pending=False)
    for k in D.WALL: D.WALL[k] = clock[0]
def cycle(n, secs=5):
    clock[0] += secs; return D.watch_once(n, clock[0])

print("A1 awake all the time: the cycle counts decide, as before")
start()
for n in range(1, 40): cycle(n)
check("nothing in the first minutes", calls == [], calls)
cycle(D.UPDATE_EVERY); check("update check on its cycle", calls == ["update"], calls)
calls.clear(); cycle(8640); check("list and update on the 12 h cycle", sorted(calls) == ["list", "update"], calls)

print("A2 asleep for two days: both are asked for 20 s after the wake, once")
start(); cycle(1); cycle(2)
cycle(3, 2 * 86400); check("the first cycle after the wake waits for the network", calls == [], calls)
cycle(4); cycle(5); cycle(6); check("still inside the 20 s", calls == [], calls)
cycle(7); check("then list additions and the update check", sorted(calls) == ["list", "update"], calls)
calls.clear()
for n in range(8, 60): cycle(n)
check("not asked again", calls == [], calls)

print("A3 asleep for 7 hours: only the update check (6 h); the list waits for its 12 h")
start(); cycle(1); cycle(2, 7 * 3600)
for n in range(3, 9): cycle(n)
check("update only", calls == ["update"], calls)

print("A4 a wake into a quiz: no update check until the quiz is over, then at once")
start(); cycle(1); cycle(2, 86400)
D.STATE.update(state="locked", quiz_id="q1", locked_since=clock[0], cap_at=clock[0] + 3600, max_minutes=60, end_known=True, mono_since=None)
D.engine = lambda cmd: True
D.engine_locked = lambda: True
for n in range(3, 12): cycle(n)
check("no update check while locked (the list may refresh: it only adds)", "update" not in calls, calls)
D.STATE.update(state="unlocked", quiz_id=None)
cycle(12); check("update check on the first cycle after the quiz", "update" in calls, calls)

print("A5 the clock set back: one catch-up, no storm")
start(); cycle(1); cycle(2, -5 * 86400)
for n in range(3, 20): cycle(n)
check("each asked once", sorted(calls) == ["list", "update"], calls)

print("A6 Windows helper: the same rule")
w = open(os.path.join(HERE, "..", "windows", "lockqzd.ps1"), encoding="utf-8-sig").read()
check("wake = a gap of 60 s or more between cycles; due 20 s later", "($now - $wallCycle) -ge 60" in w and "$settled = ($now - $wallWoke) -ge 20" in w)
check("list additions late after 12 h by the clock, never during a quiz", "($now - $wallList) -ge 43200" in w and '($listLate -or ($cycles -eq 12) -or ($cycles % 8640 -eq 0)) -and ($State.state -eq "unlocked")' in w)
check("update check late after its interval by the clock, never during a quiz", '$updateLate = $settled -and ($State.state -eq "unlocked")' in w and "($every * 5)" in w and "-or $updateLate) { $wallUpdate = $now; WUpdate }" in w)
mv = re.search(r'VERSION = "([0-9.]+)"', open(os.path.join(HERE, "..", "mac", "lockqzd.py")).read()).group(1)
wv = re.search(r'\$Version\s*=\s*"([0-9.]+)"', w).group(1)
check("one version everywhere (%s)" % mv, mv == wv == open(os.path.join(HERE, "..", "VERSION")).read().strip())

print("\n%d passed, %d failed" % (ok, bad))
sys.exit(1 if bad else 0)
