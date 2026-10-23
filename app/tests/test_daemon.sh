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
TMP="$(mktemp -d)"; T=test-token; PORT=18787
printf '{"port":%s,"token":"%s","api_base":"","device_id":"test-dev","student":"test","max_minutes":5}' "$PORT" "$T" > "$TMP/config.json"
( cd "$MAC" && LOCKQZ_NO_DEVMODE=1 LOCKQZ_DRYRUN=1 LOCKQZ_CONFIG="$TMP/config.json" python3 lockqzd.py >/tmp/lockqz_test.log 2>&1 ) &
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

kill $DPID 2>/dev/null; pkill -f "LOCKQZ_CONFIG=$TMP" 2>/dev/null
echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
