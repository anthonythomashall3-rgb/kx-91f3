#!/bin/bash
# Start the LOCKqz daemon in DRY-RUN (no system changes) and smoke-test the control
# plane the extension uses. No sudo needed. Ctrl-C to stop.
cd "$(dirname "$0")"
pkill -f lockqzd.py 2>/dev/null; sleep 1
LOCKQZ_DRYRUN=1 python3 lockqzd.py & PID=$!
sleep 2
T=$(python3 -c "import json;print(json.load(open('config.json'))['token'])")
B=http://127.0.0.1:8787
echo "status:   $(curl -s -H "X-LOCKqz-Token: $T" $B/status)"
echo "lock:     $(curl -s -X POST -H "X-LOCKqz-Token: $T" -d '{"quiz_id":"QZTEST"}' $B/lock)"
echo "status:   $(curl -s -H "X-LOCKqz-Token: $T" $B/status)"
echo "unlock:   $(curl -s -X POST -H "X-LOCKqz-Token: $T" -d '{"quiz_id":"QZTEST"}' $B/unlock)"
echo "daemon running (pid $PID). Ctrl-C to stop."
wait $PID
