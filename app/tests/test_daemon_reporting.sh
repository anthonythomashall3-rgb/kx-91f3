#!/bin/bash
# End-to-end: run the REAL macOS daemon (dry-run) against a mock backend and prove the
# live-monitor reports actually go over HTTP — lock, a helper heartbeat while locked, and
# unlock. This exercises lockqzd.py's real network path, not a mirror of its logic.
# Since 23 Oct 2026 the mock also enforces device authentication like the real server:
# the daemon must register its key and sign every report; the quiz password comes only
# through the daemon, only while it is locked for that quiz; a wrong student clock is
# corrected from the server's time.
# No root, no system changes (LOCKQZ_DRYRUN=1), no external network (mock is 127.0.0.1).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
TMP="$(mktemp -d)"
LOG="$TMP/reports.log"
free_port(){ python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
# free ports picked at run time, so a second test run (or anything else) on this machine can't collide
MOCK_PORT=$(free_port)
CTRL_PORT=$(free_port)
TOKEN="itest-token"
pass=0; fail=0
ok(){ pass=$((pass+1)); echo "  ok: $1"; }
bad(){ fail=$((fail+1)); echo "  FAIL: $1"; }
cleanup(){ for p in ${DPID:-} ${MPID:-} ${DPID2:-} ${MPID2:-}; do kill "$p" 2>/dev/null; done; rm -rf "$TMP"; }
trap cleanup EXIT

# --- mock backend: verifies device signatures exactly like the real API, logs every POST ---
cat > "$TMP/mock.py" <<'PY'
import sys, json, time, hmac, hashlib, re
from http.server import BaseHTTPRequestHandler, HTTPServer
PORT, LOG, SKEW = int(sys.argv[1]), sys.argv[2], float(sys.argv[3])
KEYS, LOCKS = {}, {}
def now(): return time.time() + SKEW
def verify(h, path, raw):
    dev, ts, sig = h.get("X-LOCKqz-Device"), h.get("X-LOCKqz-Time"), h.get("X-LOCKqz-Sig")
    if not (dev and ts and sig): return None, "unsigned"
    if abs(now() - float(ts)) > 300: return None, "clock"
    k = KEYS.get(dev)
    if not k: return None, "unregistered"
    msg = "POST\n%s\n%s\n%s" % (path, ts, hashlib.sha256(raw).hexdigest())
    good = hmac.new(k.encode(), msg.encode(), hashlib.sha256).hexdigest()
    return (dev, "ok") if hmac.compare_digest(good, sig) else (None, "bad signature")
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def reply(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(n) if n else b""
        try: b = json.loads(raw or b"{}")
        except Exception: b = {}
        path = self.path.split("?")[0]
        if path.endswith("/register"):
            KEYS.setdefault(b.get("device_id"), b.get("key"))
            good = KEYS[b.get("device_id")] == b.get("key")
            open(LOG, "a").write("REGISTER %s keylen=%d ok=%s\n" % (b.get("device_id"), len(b.get("key") or ""), good))
            return self.reply(200 if good else 409, {"ok": good})
        dev, why = verify(self.headers, path, raw)
        open(LOG, "a").write("%s signed=%d why=%s %s\n" % (path, 1 if dev else 0, why, json.dumps(b)))
        if not dev: return self.reply(401, {"error": "unauthorized device", "why": why, "server_time": int(now())})
        if path.endswith("/report"):
            if b.get("event") == "lock" or (b.get("event") == "heartbeat" and b.get("source") == "helper"):
                LOCKS[(dev, b.get("quiz_id"))] = now()
            if b.get("event") == "unlock": LOCKS.pop((dev, b.get("quiz_id")), None)
            return self.reply(200, {"ok": True})
        if path.endswith("/password"):
            u = b.get("url", ""); qi = re.search(r"qi=(\d+)", u); ou = re.search(r"ou=(\d+)", u)
            lid = "%s-%s" % (ou.group(1) if ou else "x", qi.group(1) if qi else "x")
            t = LOCKS.get((dev, lid))
            if t and now() - t < 60: return self.reply(200, {"password": "LQ-TESTPASS", "lockId": lid})
            return self.reply(403, {"password": None, "reason": "not locked"})
        return self.reply(200, {"ok": True})
    def do_GET(self):
        if self.path.split("?")[0].endswith("/blocklist"):   # a SHORT server list + one new AI
            short = ["chatgpt.com", "claude.ai", "gemini.google.com"] + ["ai%d.example" % i for i in range(20)] + ["new-ai.example"]
            return self.reply(200, {"domains": short})
        self.send_response(404); self.end_headers()
HTTPServer(("127.0.0.1", PORT), H).serve_forever()
PY

start_daemon(){   # $1 mock port  $2 ctrl port  $3 log  $4 skew  $5 dir  -> sets MPID_/DPID_
  python3 "$TMP/mock.py" "$1" "$3" "$4" & MPID_=$!
  for i in $(seq 1 20); do curl -s -o /dev/null -m 1 "http://127.0.0.1:$1/" && break; sleep 0.25; done
  cat > "$5/config.json" <<CFG
{ "port": $2, "token": "$TOKEN", "api_base": "http://127.0.0.1:$1",
  "device_id": "itest-dev", "student": "Test Student", "max_minutes": 180, "beat_cycles": 1 }
CFG
  cp "$APP/mac/blocklist.txt" "$5/blocklist.txt"
  LOCKQZ_NO_DEVMODE=1 LOCKQZ_DRYRUN=1 LOCKQZ_CONFIG="$5/config.json" LOCKQZ_KEY_PATH="$5/device.key" LOCKQZ_BLOCKLIST="$5/blocklist.txt" \
    python3 "$APP/mac/lockqzd.py" >"$5/daemon.log" 2>&1 & DPID_=$!
  for i in $(seq 1 20); do
    curl -s -m 2 -H "X-LOCKqz-Token: $TOKEN" "http://127.0.0.1:$2/status" >/dev/null 2>&1 && break
    sleep 0.5
  done
}
hpost(){ curl -s -m 15 -X POST -H "X-LOCKqz-Token: $TOKEN" -H "Content-Type: application/json" -d "$2" "http://127.0.0.1:$CTRL_PORT$1"; }
hcode(){ curl -s -o /dev/null -w "%{http_code}" -m 15 -X POST -H "X-LOCKqz-Token: $TOKEN" -H "Content-Type: application/json" -d "$2" "http://127.0.0.1:$CTRL_PORT$1"; }
QURL='https://usc.brightspace.com/d2l/lms/quizzing/user/attempt/quiz_start_frame_auto.d2l?ou=98765&qi=12345'

mkdir -p "$TMP/a"
start_daemon "$MOCK_PORT" "$CTRL_PORT" "$LOG" 0 "$TMP/a"; MPID=$MPID_; DPID=$DPID_

echo "T1 control server is up and authenticated"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "X-LOCKqz-Token: $TOKEN" "http://127.0.0.1:$CTRL_PORT/status")
[ "$code" = "200" ] && ok "status 200 with token" || bad "status not 200 (got $code)"
code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$CTRL_PORT/status")
[ "$code" = "401" ] && ok "status 401 without token" || bad "missing-token not rejected (got $code)"

echo "T2 lock -> heartbeat(helper) -> unlock all reported over HTTP"
hpost /lock '{"quiz_id":"98765-12345","student":"Test Student"}' >/dev/null
sleep 7   # beat_cycles=1 -> a helper heartbeat within ~5s while locked
hpost /unlock '{"quiz_id":"98765-12345"}' >/dev/null
sleep 1

grep -q '"event": "lock"' "$LOG"   && ok "lock reported"   || bad "no lock report in backend log"
grep -q '"event": "unlock"' "$LOG" && ok "unlock reported" || bad "no unlock report in backend log"
if grep '"event": "heartbeat"' "$LOG" | grep -q '"source": "helper"'; then
  ok "helper heartbeat reported while locked (live monitor can see it)"
else
  bad "no helper heartbeat while locked"
fi
if grep '"event": "heartbeat"' "$LOG" | grep -q '"quiz_id": "98765-12345"'; then
  ok "heartbeat carries the quiz id"
else
  bad "heartbeat missing quiz id"
fi
grep -q '"event": "install"' "$LOG" && ok "install registered on startup" || bad "no install report on startup"
if grep '"event": "unlock"' "$LOG" | grep -q '"quiz_id": "98765-12345"'; then
  ok "unlock says which quiz ended (live monitor shows done, not went dark)"
else
  bad "unlock report has no quiz id"
fi

echo "T3 device key: created root-only, registered once"
K="$TMP/a/device.key"
if [ -f "$K" ] && grep -qE '^[0-9a-f]{64}$' "$K"; then ok "64-hex device key file created"; else bad "no valid device key file"; fi
mode=$(stat -c '%a' "$K" 2>/dev/null || stat -f '%Lp' "$K" 2>/dev/null)
[ "$mode" = "600" ] && ok "key file mode 600 (owner-only)" || bad "key file mode is $mode, want 600"
grep -q 'REGISTER itest-dev keylen=64 ok=True' "$LOG" && ok "key registered with the server" || bad "no registration"

echo "T4 every report is signed and verified by the server"
n_ok=$(grep -c 'signed=1' "$LOG"); n_bad=$(grep -c 'signed=0' "$LOG")
[ "$n_ok" -gt 0 ] && [ "$n_bad" -eq 0 ] && ok "$n_ok signed reports, 0 unverified" || bad "signed=$n_ok unverified=$n_bad"

echo "T5 the quiz password comes only from the helper, only while locked for that quiz"
c=$(hcode /password "{\"url\":\"$QURL\"}")
[ "$c" = "409" ] && ok "not locked -> 409, no password" || bad "unlocked helper answered $c"
hpost /lock '{"quiz_id":"98765-12345","student":"Test Student"}' >/dev/null
r=$(hpost /password "{\"url\":\"$QURL\"}")
echo "$r" | grep -q '"password": "LQ-TESTPASS"' && ok "locked for this quiz -> password (signed request)" || bad "no password while locked: $r"
c=$(hcode /password '{"url":"https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?ou=98765&qi=99999"}')
[ "$c" = "409" ] && ok "another quiz -> 409" || bad "other quiz answered $c"
grep '/api/password' "$LOG" | grep -q 'signed=1' && ok "password request was signed" || bad "password request not signed"
hpost /event '{"event":"quiz_left","quiz_id":"98765-12345","detail":"quiz_tab_closed"}' >/dev/null
grep '"event": "quiz_left"' "$LOG" | grep -q 'signed=1' && ok "quiz_left forwarded by the helper, signed" || bad "quiz_left not forwarded/signed"
c=$(hcode /event '{"event":"unlock"}')
[ "$c" = "400" ] && ok "helper refuses to forward other events (400)" || bad "event allowlist missing (got $c)"
hpost /unlock '{"quiz_id":"98765-12345"}' >/dev/null
c=$(hcode /password "{\"url\":\"$QURL\"}")
[ "$c" = "409" ] && ok "after unlock -> 409" || bad "after unlock answered $c"

echo "T6 a blocklist refresh can only ADD domains (a short server list never shrinks the Mac's list)"
orig=$(grep -cvE '^\s*(#|$)' "$APP/mac/blocklist.txt"); now=$(grep -cvE '^\s*(#|$)' "$TMP/a/blocklist.txt")
[ "$now" -eq $((orig + 21)) ] && ok "list grew $orig -> $now (20 test domains + new-ai.example), nothing removed" || bad "list went $orig -> $now"
grep -qx 'new-ai.example' "$TMP/a/blocklist.txt" && ok "new AI from the server added" || bad "server addition missing"
grep -qx 'chat.deepseek.com' "$TMP/a/blocklist.txt" && ok "shipped domains kept (chat.deepseek.com)" || bad "shipped domain dropped"
git -C "$APP" diff --quiet -- mac/blocklist.txt 2>/dev/null && ok "repo blocklist untouched by the test" || bad "test modified app/mac/blocklist.txt"

echo "T7 a student clock 15 minutes off is corrected from the server time"
LOG2="$TMP/reports2.log"; mkdir -p "$TMP/b"; CTRL1=$CTRL_PORT; CTRL_PORT=$(free_port)
start_daemon "$(free_port)" "$CTRL_PORT" "$LOG2" 900 "$TMP/b"; MPID2=$MPID_; DPID2=$DPID_
hpost /lock '{"quiz_id":"98765-12345","student":"Test Student"}' >/dev/null
sleep 2
grep -q 'why=clock' "$LOG2" && ok "server refused the skewed clock once" || bad "skew not exercised"
grep '"event": "lock"' "$LOG2" | grep -q 'signed=1' && ok "lock then accepted after correcting the clock" || bad "lock never verified with skewed clock"
r=$(hpost /password "{\"url\":\"$QURL\"}")
echo "$r" | grep -q 'LQ-TESTPASS' && ok "password still delivered with a skewed clock" || bad "skewed clock blocked the password: $r"
CTRL_PORT=$CTRL1

echo "T8 developer mode (admin only): AI NOT locked, but a signed developer lock keeps the quiz gate open"
LOG3="$TMP/reports3.log"; mkdir -p "$TMP/c"; CTRL1=$CTRL_PORT; CTRL_PORT=$(free_port); M3=$(free_port)
echo "test-dev-secret" > "$TMP/c/developer.key"
H3=$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read().strip()).hexdigest())' "$TMP/c/developer.key")
sed "s/^DEV_KEY_HASH = .*/DEV_KEY_HASH = \"$H3\"/" "$APP/mac/lockqzd.py" > "$TMP/c/lockqzd.py"   # test copy only
python3 "$TMP/mock.py" "$M3" "$LOG3" 0 & MPID3=$!
for i in $(seq 1 20); do curl -s -o /dev/null -m 1 "http://127.0.0.1:$M3/" && break; sleep 0.25; done
cat > "$TMP/c/config.json" <<CFG
{ "port": $CTRL_PORT, "token": "$TOKEN", "api_base": "http://127.0.0.1:$M3",
  "device_id": "itest-admin", "student": "Admin", "max_minutes": 180, "beat_cycles": 1 }
CFG
cp "$APP/mac/blocklist.txt" "$TMP/c/blocklist.txt"
LOCKQZ_DEV_KEY="$TMP/c/developer.key" LOCKQZ_DRYRUN=1 LOCKQZ_CONFIG="$TMP/c/config.json" LOCKQZ_KEY_PATH="$TMP/c/device.key" LOCKQZ_BLOCKLIST="$TMP/c/blocklist.txt" \
  python3 "$TMP/c/lockqzd.py" >"$TMP/c/daemon.log" 2>&1 & DPID3=$!
for i in $(seq 1 20); do curl -s -m 2 -H "X-LOCKqz-Token: $TOKEN" "http://127.0.0.1:$CTRL_PORT/status" >/dev/null 2>&1 && break; sleep 0.5; done
st=$(curl -s -H "X-LOCKqz-Token: $TOKEN" "http://127.0.0.1:$CTRL_PORT/status")
echo "$st" | grep -q '"developer": true' && ok "daemon reports developer mode" || bad "developer mode not on: $st"
r=$(hpost /lock '{"quiz_id":"98765-12345","student":"Admin"}')
echo "$r" | grep -q '"state": "developer"' && ok "/lock answers developer (AI stays on)" || bad "lock in dev mode: $r"
st=$(curl -s -H "X-LOCKqz-Token: $TOKEN" "http://127.0.0.1:$CTRL_PORT/status")
echo "$st" | grep -q '"engine_locked": false' && ok "engine NOT locked in developer mode" || bad "engine locked in dev mode: $st"
grep '"event": "lock"' "$LOG3" | grep '"developer": true' | grep -q 'signed=1' && ok "signed lock flagged developer sent to server" || bad "no signed developer lock"
r=$(hpost /password "{\"url\":\"$QURL\"}")
echo "$r" | grep -q 'LQ-TESTPASS' && ok "admin gets the quiz password in developer mode" || bad "no password in dev mode: $r"
sleep 7
grep '"event": "heartbeat"' "$LOG3" | grep '"source": "helper"' | grep -q '98765-12345' && ok "helper heartbeats keep the admin's lock fresh" || bad "no dev heartbeat"
hpost /unlock '{"quiz_id":"98765-12345"}' >/dev/null; sleep 1
grep -q '"event": "unlock"' "$LOG3" && ok "unlock reported at quiz end" || bad "no unlock in dev mode"
kill $DPID3 $MPID3 2>/dev/null
CTRL_PORT=$CTRL1

echo ""
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
