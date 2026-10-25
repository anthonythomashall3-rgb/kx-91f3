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
TMP="$(mktemp -d)"; T=test-token-0123456789abcdef
printf %s "$T" > "$TMP/helper.token"   # the helper's per-install control token
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
printf '{"port":%s,"token":"%s","api_base":"","device_id":"test-dev","student":"test","max_minutes":5}' "$PORT" "$T" > "$TMP/config.json"
# exec: $DPID is the daemon itself, so the cleanup below really stops it; key file stays in $TMP
( cd "$MAC" && LOCKQZ_NO_DEVMODE=1 LOCKQZ_DRYRUN=1 LOCKQZ_CONFIG="$TMP/config.json" LOCKQZ_KEY_PATH="$TMP/device.key" LOCKQZ_LOCKFILE="$TMP/active_lock.json" LOCKQZ_TOKEN_FILE="$TMP/helper.token" LOCKQZ_TOKEN_DIR="$TMP/tokens" exec python3 lockqzd.py >"$TMP/daemon.log" 2>&1 ) &
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

start_daemon(){ ( cd "$MAC" && LOCKQZ_NO_DEVMODE=1 LOCKQZ_DRYRUN=1 LOCKQZ_CONFIG="$TMP/config.json" LOCKQZ_KEY_PATH="$TMP/device.key" LOCKQZ_LOCKFILE="$TMP/active_lock.json" LOCKQZ_TOKEN_FILE="$TMP/helper.token" LOCKQZ_TOKEN_DIR="$TMP/tokens" exec python3 lockqzd.py >>"$TMP/daemon.log" 2>&1 ) & DPID=$!
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


echo "T-cap a /lock can never ask for more than the configured cap (here 5 min; default 180)"
curl -s -X POST -H "X-LOCKqz-Token: $T" -d '{"quiz_id":"98765-12345","max_minutes":100000}' $B/lock >/dev/null
mm=$(curl -s -H "X-LOCKqz-Token: $T" $B/status | python3 -c 'import sys,json;print(json.load(sys.stdin)["max_minutes"])' 2>/dev/null)
[ "$mm" = "5" ] && ok "max_minutes 100000 capped to 5" || bad "max_minutes not capped (got $mm)"
mm=$(python3 -c "import json;print(json.load(open('$TMP/active_lock.json'))['max_minutes'])")
[ "$mm" = "5" ] && ok "saved lock record carries the capped value" || bad "lock record max_minutes $mm"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-LOCKqz-Token: $T" -d '{"quiz_id":"98765-12345","max_minutes":"lots"}' $B/lock)
[ "$c" = "200" ] && ok "garbage max_minutes does not crash the request" || bad "garbage max_minutes -> $c"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-LOCKqz-Token: $T" -d '{"quiz_id":"../../x"}' $B/lock)
[ "$c" = "400" ] && ok "malformed quiz id refused" || bad "malformed quiz id -> $c"
curl -s -X POST -H "X-LOCKqz-Token: $T" -d '{}' $B/unlock >/dev/null
kill -9 $DPID 2>/dev/null; wait $DPID 2>/dev/null
python3 -c "import json,time;json.dump({'quiz_id':'1-2','student':'x','locked_at':'old','locked_since':time.time()-60,'max_minutes':100000},open('$TMP/active_lock.json','w'))"
start_daemon
mm=$(curl -s -H "X-LOCKqz-Token: $T" $B/status | python3 -c 'import sys,json;print(json.load(sys.stdin)["max_minutes"])' 2>/dev/null)
[ "$mm" = "5" ] && ok "a saved record asking for 70 days resumes capped at 5 min" || bad "resumed record not capped ($mm)"
curl -s -X POST -H "X-LOCKqz-Token: $T" -d '{}' $B/unlock >/dev/null

echo "T-web a web page cannot drive the helper"
c=$(curl -s -o /dev/null -w '%{http_code}' -H "X-LOCKqz-Token: $T" -H "Origin: https://evil.example" $B/status)
[ "$c" = "401" ] && ok "request with a browser Origin refused" || bad "Origin request -> $c"
c=$(curl -s -o /dev/null -w '%{http_code}' -H "X-LOCKqz-Token: $T" -H "Host: evil.example:$PORT" $B/status)
[ "$c" = "401" ] && ok "DNS-rebinding Host refused" || bad "foreign Host -> $c"
h=$(curl -s -i -X OPTIONS -H "Origin: https://evil.example" $B/lock)
! echo "$h" | grep -qi 'access-control-allow' && ok "no CORS headers on a preflight" || bad "CORS preflight answered"
h=$(curl -s -i -H "X-LOCKqz-Token: $T" $B/status)
! echo "$h" | grep -qi 'access-control-allow' && ok "no CORS headers on normal replies" || bad "CORS header present"
c=$(curl -s -o /dev/null -w '%{http_code}' -H "X-LOCKqz-Token: lockqz-dev" $B/status)
[ "$c" = "401" ] && ok "old shared default token refused" || bad "default token accepted"

echo "T-pend an unlock the engine cannot finish keeps its record and is retried; a restart never re-locks"
E="$TMP/eng"; mkdir -p "$E"; cp "$MAC/lockqzd.py" "$E/"
cat > "$E/lockqz.sh" <<'SH'
#!/bin/bash
D="$(cd "$(dirname "$0")" && pwd)"
case "$1" in
  lock) touch "$D/locked";;
  unlock) [ -f "$D/fail_unlock" ] && exit 1; rm -f "$D/locked";;
  status) [ -f "$D/locked" ] && echo "LOCKqz: LOCKED" || echo "LOCKqz: unlocked";;
esac
SH
kill $DPID 2>/dev/null; wait $DPID 2>/dev/null; rm -f "$TMP/active_lock.json"
start_fake(){ ( cd "$E" && LOCKQZ_NO_DEVMODE=1 LOCKQZ_DRYRUN=0 LOCKQZ_CONFIG="$TMP/config.json" LOCKQZ_KEY_PATH="$TMP/device.key" LOCKQZ_LOCKFILE="$TMP/active_lock.json" LOCKQZ_TOKEN_FILE="$TMP/helper.token" LOCKQZ_TOKEN_DIR="$TMP/tokens" exec python3 lockqzd.py >>"$TMP/daemon.log" 2>&1 ) & DPID=$!
  for i in $(seq 1 16); do curl -s -H "X-LOCKqz-Token: $T" $B/status >/dev/null 2>&1 && return 0; sleep 0.5; done; return 1; }
start_fake
curl -s -X POST -H "X-LOCKqz-Token: $T" -d '{"quiz_id":"98765-12345"}' $B/lock >/dev/null
touch "$E/fail_unlock"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-LOCKqz-Token: $T" -d '{"quiz_id":"98765-12345"}' $B/unlock)
[ "$c" = "500" ] && ok "failed unlock is reported to the agent (not a fake success)" || bad "failed unlock answered $c"
python3 -c "import json,sys;sys.exit(0 if json.load(open('$TMP/active_lock.json')).get('unlock_pending') else 1)" && ok "lock record kept, marked unlock_pending" || bad "record cleared after a failed unlock"
kill -9 $DPID 2>/dev/null; wait $DPID 2>/dev/null
start_fake
[ "$(st)" = "unlocked" ] && ok "restart with a pending unlock does NOT re-lock" || bad "restart re-locked a finished quiz"
rm -f "$E/fail_unlock"; sleep 6
[ ! -f "$E/locked" ] && [ ! -f "$TMP/active_lock.json" ] && ok "watcher retried: block gone, record cleared" || bad "pending unlock never completed"
kill $DPID 2>/dev/null; pkill -f "LOCKQZ_CONFIG=$TMP" 2>/dev/null
echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
