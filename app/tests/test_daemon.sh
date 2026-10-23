#!/bin/bash
# LOCKqz daemon control-plane test (DRY-RUN, no root, no network, no system changes).
# Boots the daemon, drives the exact endpoints the extension uses, asserts each result.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MAC="$HERE/../mac"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ok: $1"; }
bad(){ FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# own config + own port so an installed daemon on 8787 is never touched
TMP="$(mktemp -d)"; T=test-token
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
printf '{"port":%s,"token":"%s","api_base":"","device_id":"test-dev","student":"test","max_minutes":5}' "$PORT" "$T" > "$TMP/config.json"
# exec: $DPID is the daemon itself, so the cleanup below really stops it; key file stays in $TMP
( cd "$MAC" && LOCKQZ_NO_DEVMODE=1 LOCKQZ_DRYRUN=1 LOCKQZ_CONFIG="$TMP/config.json" LOCKQZ_KEY_PATH="$TMP/device.key" LOCKQZ_LOCKFILE="$TMP/active_lock.json" exec python3 lockqzd.py >"$TMP/daemon.log" 2>&1 ) &
DPID=$!
# wait up to 8s for the server to come up
B=http://127.0.0.1:$PORT; up=""
for i in $(seq 1 16); do
  if curl -s -H "X-LOCKqz-Token: $T" $B/status >/dev/null 2>&1; then up=1; break; fi
  sleep 0.5
done
[ -n "$up" ] && ok "daemon came up within 8s (no network stall)" || bad "daemon did not start in time"

st(){ curl -s -H "X-LOCKqz-Token: $T" $B/status | python3 -c 'import sys,json;print(json.load(sys.stdin)["state"])' 2>/dev/null; }

[ "$(st)" = "unlocked" ] && ok "starts unlocked (fail-safe)" || bad "did not start unlocked"

curl -s -X POST -H "X-LOCKqz-Token: $T" -d '{"quiz_id":"98765-12345","student":"anthony"}' $B/lock >/dev/null
[ "$(st)" = "locked" ] && ok "lock -> locked" || bad "lock failed"

code=$(curl -s -o /dev/null -w '%{http_code}' $B/status)
[ "$code" = "401" ] && ok "no token -> 401" || bad "auth not enforced (got $code)"

curl -s -X POST -H "X-LOCKqz-Token: $T" -d '{"quiz_id":"98765-12345"}' $B/unlock >/dev/null
[ "$(st)" = "unlocked" ] && ok "unlock -> unlocked" || bad "unlock failed"

# heartbeat endpoint responds ok even with no API configured
hb=$(curl -s -X POST -H "X-LOCKqz-Token: $T" -d '{}' $B/heartbeat | python3 -c 'import sys,json;print(json.load(sys.stdin).get("ok"))' 2>/dev/null)
[ "$hb" = "True" ] && ok "heartbeat responds ok" || bad "heartbeat failed"

start_daemon(){ ( cd "$MAC" && LOCKQZ_NO_DEVMODE=1 LOCKQZ_DRYRUN=1 LOCKQZ_CONFIG="$TMP/config.json" LOCKQZ_KEY_PATH="$TMP/device.key" LOCKQZ_LOCKFILE="$TMP/active_lock.json" exec python3 lockqzd.py >>"$TMP/daemon.log" 2>&1 ) & DPID=$!
  for i in $(seq 1 16); do curl -s -H "X-LOCKqz-Token: $T" $B/status >/dev/null 2>&1 && return 0; sleep 0.5; done; return 1; }
qid(){ curl -s -H "X-LOCKqz-Token: $T" $B/status | python3 -c 'import sys,json;print(json.load(sys.stdin)["quiz_id"])' 2>/dev/null; }

# Killed mid-quiz (kill -9, as a student with admin rights could): launchd restarts it -> must RESUME the lock.
curl -s -X POST -H "X-LOCKqz-Token: $T" -d '{"quiz_id":"98765-12345","student":"anthony"}' $B/lock >/dev/null
[ -f "$TMP/active_lock.json" ] && ok "lock record saved" || bad "no lock record saved"
kill -9 $DPID 2>/dev/null; wait $DPID 2>/dev/null; sleep 0.5
start_daemon && ok "helper restarted after kill -9" || bad "helper did not restart"
[ "$(st)" = "locked" ] && [ "$(qid)" = "98765-12345" ] && ok "killed mid-quiz -> restarts STILL LOCKED for the same quiz" || bad "kill -9 + restart unlocked the quiz (got $(st))"
grep -q "resumed lock" "$TMP/daemon.log" && ok "restart logged as tamper" || bad "no tamper log on resume"

# A saved lock past its hard max must NOT keep anyone locked.
curl -s -X POST -H "X-LOCKqz-Token: $T" -d '{"quiz_id":"98765-12345"}' $B/unlock >/dev/null
[ ! -f "$TMP/active_lock.json" ] && ok "unlock clears the lock record" || bad "lock record left after unlock"
kill -9 $DPID 2>/dev/null; wait $DPID 2>/dev/null
python3 -c "import json,time;json.dump({'quiz_id':'1-2','student':'x','locked_at':'old','locked_since':time.time()-6*60,'max_minutes':5},open('$TMP/active_lock.json','w'))"
start_daemon
[ "$(st)" = "unlocked" ] && ok "expired lock record (past hard max) -> starts unlocked" || bad "expired lock kept the Mac locked"
[ ! -f "$TMP/active_lock.json" ] && ok "expired record discarded" || bad "expired record not discarded"

kill $DPID 2>/dev/null; pkill -f "LOCKQZ_CONFIG=$TMP" 2>/dev/null
echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
