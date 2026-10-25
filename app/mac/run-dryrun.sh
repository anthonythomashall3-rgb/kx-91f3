#!/bin/bash
# Start the LOCKqz daemon in DRY-RUN (no system changes) and smoke-test the control
# plane the extension uses. No sudo needed. Ctrl-C to stop.
cd "$(dirname "$0")" || exit 1
pkill -f lockqzd.py 2>/dev/null; sleep 1
W="$(mktemp -d)"   # dry-run state + token live in a temp folder, never in /Library
T="dryrun-$(python3 -c 'import secrets;print(secrets.token_hex(16))')"; printf %s "$T" > "$W/helper.token"
LOCKQZ_DRYRUN=1 LOCKQZ_TOKEN_FILE="$W/helper.token" LOCKQZ_TOKEN_DIR="$W/tokens" LOCKQZ_LOCKFILE="$W/active_lock.json" \
  LOCKQZ_KEY_PATH="$W/device.key" python3 lockqzd.py & PID=$!
sleep 2
B=http://127.0.0.1:8787
echo "status:   $(curl -s -H "X-LOCKqz-Token: $T" $B/status)"
echo "lock:     $(curl -s -X POST -H "X-LOCKqz-Token: $T" -d '{"quiz_id":"QZTEST"}' $B/lock)"
echo "status:   $(curl -s -H "X-LOCKqz-Token: $T" $B/status)"
echo "unlock:   $(curl -s -X POST -H "X-LOCKqz-Token: $T" -d '{"quiz_id":"QZTEST"}' $B/unlock)"
echo "daemon running (pid $PID). Ctrl-C to stop."
wait $PID
