#!/bin/bash
# End-to-end: run the REAL macOS daemon (dry-run) against a mock backend and prove the
# live-monitor reports actually go over HTTP — lock, a helper heartbeat while locked, and
# unlock. This exercises lockqzd.py's real network path, not a mirror of its logic.
# No root, no system changes (LOCKQZ_DRYRUN=1), no external network (mock is 127.0.0.1).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
TMP="$(mktemp -d)"
LOG="$TMP/reports.log"
MOCK_PORT=8911
CTRL_PORT=8912
TOKEN="itest-token"
pass=0; fail=0
ok(){ pass=$((pass+1)); echo "  ok: $1"; }
bad(){ fail=$((fail+1)); echo "  FAIL: $1"; }
cleanup(){ [ -n "${DPID:-}" ] && kill "$DPID" 2>/dev/null; [ -n "${MPID:-}" ] && kill "$MPID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

# --- mock backend: logs every POST body to a file, 200s everything ---
cat > "$TMP/mock.py" <<PY
import sys, json
from http.server import BaseHTTPRequestHandler, HTTPServer
LOG = sys.argv[2]
class H(BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_POST(self):
        n=int(self.headers.get("Content-Length",0) or 0)
        raw=self.rfile.read(n) if n else b"{}"
        try: b=json.loads(raw)
        except Exception: b={}
        open(LOG,"a").write(self.path+" "+json.dumps(b)+"\n")
        self.send_response(200); self.send_header("Content-Type","application/json")
        self.end_headers(); self.wfile.write(b'{"ok":true}')
    def do_GET(self):
        self.send_response(404); self.end_headers()
HTTPServer(("127.0.0.1",int(sys.argv[1])),H).serve_forever()
PY
python3 "$TMP/mock.py" "$MOCK_PORT" "$LOG" & MPID=$!
sleep 1

# --- isolated daemon config: points at the mock, fast heartbeat, own control port ---
cat > "$TMP/config.json" <<CFG
{ "port": $CTRL_PORT, "token": "$TOKEN", "api_base": "http://127.0.0.1:$MOCK_PORT",
  "device_id": "itest-dev", "student": "Test Student", "max_minutes": 180, "beat_cycles": 1 }
CFG

LOCKQZ_NO_DEVMODE=1 LOCKQZ_DRYRUN=1 LOCKQZ_CONFIG="$TMP/config.json" python3 "$APP/mac/lockqzd.py" >"$TMP/daemon.log" 2>&1 & DPID=$!
# wait for the control server to come up
for i in $(seq 1 20); do
  curl -s -m 2 -H "X-LOCKqz-Token: $TOKEN" "http://127.0.0.1:$CTRL_PORT/status" >/dev/null 2>&1 && break
  sleep 0.5
done

echo "T1 control server is up and authenticated"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "X-LOCKqz-Token: $TOKEN" "http://127.0.0.1:$CTRL_PORT/status")
[ "$code" = "200" ] && ok "status 200 with token" || bad "status not 200 (got $code)"
code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$CTRL_PORT/status")
[ "$code" = "401" ] && ok "status 401 without token" || bad "missing-token not rejected (got $code)"

echo "T2 lock -> heartbeat(helper) -> unlock all reported over HTTP"
curl -s -m 3 -X POST -H "X-LOCKqz-Token: $TOKEN" -H "Content-Type: application/json" \
  -d "{\"quiz_id\":\"98765-12345\",\"student\":\"Test Student\"}" \
  "http://127.0.0.1:$CTRL_PORT/lock" >/dev/null
sleep 7   # beat_cycles=1 -> a helper heartbeat within ~5s while locked
curl -s -m 3 -X POST -H "X-LOCKqz-Token: $TOKEN" -H "Content-Type: application/json" \
  -d "{\"quiz_id\":\"98765-12345\"}" "http://127.0.0.1:$CTRL_PORT/unlock" >/dev/null
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

echo ""
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
