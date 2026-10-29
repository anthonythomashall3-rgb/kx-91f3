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
TOKEN="itest-token-0123456789abcdef"
BL_SUM="$(cksum < "$APP/mac/blocklist.txt")"   # the test must never write the repo's blocklist
pass=0; fail=0
ok(){ pass=$((pass+1)); echo "  ok: $1"; }
bad(){ fail=$((fail+1)); echo "  FAIL: $1"; }
cleanup(){ for p in ${DPID:-} ${MPID:-} ${DPID2:-} ${MPID2:-}; do kill "$p" 2>/dev/null; done; rm -rf "$TMP"; }
trap cleanup EXIT

# --- mock backend: verifies device signatures exactly like the real API, logs every POST ---
cat > "$TMP/mock.py" <<'PY'
import os, sys, json, time, hmac, hashlib, re
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
            if b.get("event") == "unlock":
                det = b.get("detail") if isinstance(b.get("detail"), dict) else {}
                try: why = open(LOG + ".unlock").read().strip()
                except Exception: why = ""
                if det.get("ask") and not why: return self.reply(200, {"ok": True, "hold": True, "beat_s": 30})   # gate on, nothing vouches
                LOCKS.pop((dev, b.get("quiz_id")), None)
            if b.get("event") in ("heartbeat", "lock"):
                try: why = open(LOG + ".unlock").read().strip()   # C9: the test says "this student submitted"
                except Exception: why = ""
                if why: return self.reply(200, {"ok": True, "unlock": True, "reason": why})
            return self.reply(200, {"ok": True})
        if path.endswith("/password"):
            u = b.get("url", ""); qi = re.search(r"[?&]qi=(\d+)", u); ou = re.search(r"[?&]ou=(\d+)", u)
            lid = "%s-%s" % (ou.group(1) if ou else "x", qi.group(1) if qi else "x")
            iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))
            if qi and qi.group(1) == "44444": return self.reply(403, {"reason": "other_school"})
            t = LOCKS.get((dev, lid))
            if t and now() - t < 60:
                if qi and qi.group(1) == "33333": return self.reply(403, {"reason": "not started", "start": iso(now() + 600)})
                LOCKS[(dev, lid)] = now()   # C1: a signed /password refreshes the lock row itself
                end = iso(now() - 7200) if qi and qi.group(1) == "22222" else iso(now() + 3600)
                if qi and qi.group(1) == "66666":   # an accommodation is added mid-quiz: the server stops naming an end
                    return self.reply(200, {"password": "LQ-TESTPASS", "lockId": lid, "end": None if os.path.exists(LOG + ".noend") else iso(now() + 600)})
                if qi and qi.group(1) == "55555":   # the professor allowed this student assistive tools
                    return self.reply(200, {"password": "LQ-TESTPASS", "lockId": lid, "end": end, "assist": ["readwrite", "equatio", "../evil", "abcdefghijklmnopabcdefghijklmnop"]})
                return self.reply(200, {"password": "LQ-TESTPASS", "lockId": lid, "end": end})
            return self.reply(403, {"password": None, "reason": "not locked"})
        if path.endswith("/verify"):
            if b.get("op") == "code":
                return self.reply(200, {"ok": True, "verified": True, "name": "Al Student"} if b.get("code") == "246810" else {"error": "wrong_code", "tries_left": 4})
            return self.reply(200, {"student": None, "verified": False, "codes": True})
        return self.reply(200, {"ok": True})
    def do_GET(self):
        if self.path.split("?")[0].endswith("/blocklist"):   # a SHORT server list + one new AI
            short = ["chatgpt.com", "claude.ai", "gemini.google.com"] + ["ai%d.example" % i for i in range(20)] + ["new-ai.example", "new-ai.example/chat"]
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
  cp "$APP/mac/blocklist.txt" "$5/blocklist.txt"; printf %s "$TOKEN" > "$5/helper.token"
  LOCKQZ_TOKEN_FILE="$5/helper.token" LOCKQZ_TOKEN_DIR="$5/tokens" LOCKQZ_LOCKFILE="$5/active_lock.json" LOCKQZ_NO_DEVMODE=1 LOCKQZ_DRYRUN=1 LOCKQZ_CONFIG="$5/config.json" LOCKQZ_KEY_PATH="$5/device.key" LOCKQZ_BLOCKLIST="$5/blocklist.txt" \
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
r=$(hpost /verify '{"op":"code","email":"al@usc.edu","code":"000000"}')
echo "$r" | grep -q '"wrong_code"' && echo "$r" | grep -q '"status": 200' && ok "email code forwarded by the helper (wrong code answered)" || bad "verify not forwarded: $r"
r=$(hpost /verify '{"op":"code","email":"al@usc.edu","code":"246810"}')
echo "$r" | grep -q '"verified": true' && ok "right code -> verified" || bad "verify code: $r"
grep '/api/verify' "$LOG" | grep -q 'signed=1' && ok "email setup request was signed with the device key" || bad "verify request not signed"
st=$(curl -s -H "X-LOCKqz-Token: $TOKEN" "http://127.0.0.1:$CTRL_PORT/status")
echo "$st" | grep -q '"student": "al@usc.edu"' && ok "helper now reports the confirmed email" || bad "helper student after verify: $st"
c=$(hcode /verify '{"op":"delete"}')
[ "$c" = "400" ] && ok "helper refuses unknown verify ops (400)" || bad "verify op allowlist missing (got $c)"
hpost /event '{"event":"quiz_left","quiz_id":"98765-12345","detail":"quiz_tab_closed"}' >/dev/null
grep '"event": "quiz_left"' "$LOG" | grep -q 'signed=1' && ok "quiz_left forwarded by the helper, signed" || bad "quiz_left not forwarded/signed"
c=$(hcode /event '{"event":"unlock"}')
[ "$c" = "400" ] && ok "helper refuses to forward other events (400)" || bad "event allowlist missing (got $c)"
hpost /unlock '{"quiz_id":"98765-12345"}' >/dev/null
c=$(hcode /password "{\"url\":\"$QURL\"}")
[ "$c" = "409" ] && ok "after unlock -> 409" || bad "after unlock answered $c"

echo "T5b OSAS: the professor's assistive-tool allowance reaches the browser policy, keys only, cleared at unlock"
AQ='https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?ou=98765&qi=55555'
hpost /lock '{"quiz_id":"98765-55555","student":"Test Student"}' >/dev/null
r=$(hpost /password "{\"url\":\"$AQ\"}")
echo "$r" | grep -q 'LQ-TESTPASS' && ok "password with an allowance" || bad "no password: $r"
AF="$TMP/a/assist.json"
if [ -f "$AF" ] && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d=={"quiz_id":"98765-55555","tools":["equatio","readwrite"]} else 1)' "$AF"; then
  ok "assist record = this quiz + the known keys only (unknown keys / ids dropped)"; else bad "assist record wrong: $(cat "$AF" 2>/dev/null)"; fi
amode=$(stat -c '%a' "$AF" 2>/dev/null || stat -f '%Lp' "$AF" 2>/dev/null)
[ "$amode" = "600" ] && ok "assist record is root-only (600)" || bad "assist record mode $amode"
LOCKQZ_ASSIST_FILE="$AF" LOCKQZ_POLICY_DIR="$TMP/a/pol" LOCKQZ_POLICY_BACKUP="$TMP/a/polbk" python3 - "$APP/mac/browser-policy.py" <<'PYA' && ok "browser policy lets Read&Write + Equatio run, nothing else extra" || bad "browser policy allowance wrong"
import importlib.util, sys
s = importlib.util.spec_from_file_location("bp", sys.argv[1]); P = importlib.util.module_from_spec(s); s.loader.exec_module(P)
al = P.chromium_policy("com.google.Chrome")["ExtensionInstallAllowlist"]
sys.exit(0 if al[:len(P.SAFE_EXTENSIONS)] == P.SAFE_EXTENSIONS and sorted(al[len(P.SAFE_EXTENSIONS):]) == ["hjngolefdpdnooamgdldlkjgmdcmcjnc", "inoeonmfapjbbkmdafoankkfajkcphgd"] else 1)
PYA
hpost /unlock '{"quiz_id":"98765-55555"}' >/dev/null
[ ! -f "$AF" ] && ok "unlock removes the allowance (never carries to another quiz)" || bad "assist record left after unlock"
hpost /lock '{"quiz_id":"98765-12345","student":"Test Student"}' >/dev/null
hpost /password "{\"url\":\"$QURL\"}" >/dev/null
[ ! -f "$AF" ] && ok "a quiz with no allowance writes none" || bad "assist record for a quiz without one"
hpost /unlock '{"quiz_id":"98765-12345"}' >/dev/null

echo "T6 a blocklist refresh can only ADD domains (a short server list never shrinks the Mac's list)"
orig=$(grep -cvE '^\s*(#|$)' "$APP/mac/blocklist.txt"); now=$(grep -cvE '^\s*(#|$)' "$TMP/a/blocklist.txt")
[ "$now" -eq $((orig + 22)) ] && ok "list grew $orig -> $now (20 test domains + new-ai.example + its /chat path), nothing removed" || bad "list went $orig -> $now"
grep -qx 'new-ai.example/chat' "$TMP/a/blocklist.txt" && ok "server path entry kept (the browser policy enforces paths)" || bad "server path entry dropped"
grep -qx 'new-ai.example' "$TMP/a/blocklist.txt" && ok "new AI from the server added" || bad "server addition missing"
grep -qx 'chat.deepseek.com' "$TMP/a/blocklist.txt" && ok "shipped domains kept (chat.deepseek.com)" || bad "shipped domain dropped"
[ "$(cksum < "$APP/mac/blocklist.txt")" = "$BL_SUM" ] && ok "repo blocklist untouched by the test" || bad "test modified app/mac/blocklist.txt"

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
cp "$APP/mac/blocklist.txt" "$TMP/c/blocklist.txt"; printf %s "$TOKEN" > "$TMP/c/helper.token"
LOCKQZ_TOKEN_FILE="$TMP/c/helper.token" LOCKQZ_TOKEN_DIR="$TMP/c/tokens" LOCKQZ_LOCKFILE="$TMP/c/active_lock.json" LOCKQZ_DEV_KEY="$TMP/c/developer.key" LOCKQZ_DRYRUN=1 LOCKQZ_CONFIG="$TMP/c/config.json" LOCKQZ_KEY_PATH="$TMP/c/device.key" LOCKQZ_BLOCKLIST="$TMP/c/blocklist.txt" \
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


echo "T9 every unlock report says why: agent reasons pass through, anything else is local_request, the cap says cap"
hpost /lock '{"quiz_id":"98765-12345","student":"Test Student"}' >/dev/null
hpost /unlock '{"quiz_id":"98765-12345","reason":"quiz_submitted"}' >/dev/null; sleep 1
grep '"event": "unlock"' "$LOG" | grep -q '"reason": "quiz_submitted"' && ok "agent reason quiz_submitted reported" || bad "no quiz_submitted reason"
hpost /lock '{"quiz_id":"98765-12345","student":"Test Student"}' >/dev/null
hpost /unlock '{"quiz_id":"98765-12345","reason":"because I said so"}' >/dev/null; sleep 1
grep '"event": "unlock"' "$LOG" | grep -q '"reason": "local_request"' && ok "unknown caller reason -> local_request" || bad "no local_request reason"
LOG4="$TMP/reports4.log"; mkdir -p "$TMP/d"; CTRL1=$CTRL_PORT; CTRL_PORT=$(free_port); M4=$(free_port)
python3 "$TMP/mock.py" "$M4" "$LOG4" 0 & MPID4=$!
for i in $(seq 1 20); do curl -s -o /dev/null -m 1 "http://127.0.0.1:$M4/" && break; sleep 0.25; done
cat > "$TMP/d/config.json" <<CFG
{ "port": $CTRL_PORT, "api_base": "http://127.0.0.1:$M4", "device_id": "itest-cap", "student": "T", "max_minutes": 1, "beat_cycles": 1 }
CFG
cp "$APP/mac/blocklist.txt" "$TMP/d/blocklist.txt"; printf %s "$TOKEN" > "$TMP/d/helper.token"
python3 -c "import json,time;json.dump({'quiz_id':'98765-12345','student':'T','locked_at':'x','locked_since':time.time()-55,'max_minutes':1},open('$TMP/d/active_lock.json','w'))"
LOCKQZ_TOKEN_FILE="$TMP/d/helper.token" LOCKQZ_TOKEN_DIR="$TMP/d/tokens" LOCKQZ_LOCKFILE="$TMP/d/active_lock.json" LOCKQZ_NO_DEVMODE=1 LOCKQZ_DRYRUN=1 \
  LOCKQZ_CONFIG="$TMP/d/config.json" LOCKQZ_KEY_PATH="$TMP/d/device.key" LOCKQZ_BLOCKLIST="$TMP/d/blocklist.txt" \
  python3 "$APP/mac/lockqzd.py" >"$TMP/d/daemon.log" 2>&1 & DPID4=$!
for i in $(seq 1 40); do grep -q '"reason": "cap"' "$LOG4" 2>/dev/null && break; sleep 0.5; done
grep '"event": "unlock"' "$LOG4" | grep '"reason": "cap"' | grep -q '"quiz_id": "98765-12345"' && ok "hard cap auto-unlock reported as unlock, reason cap" || bad "no cap unlock report: $(tail -3 "$LOG4")"
st=$(curl -s -H "X-LOCKqz-Token: $TOKEN" "http://127.0.0.1:$CTRL_PORT/status")
echo "$st" | grep -q '"state": "unlocked"' && echo "$st" | grep -q '"capped_quiz": "98765-12345"' && ok "status tells the agent which quiz the cap released" || bad "status after cap: $st"
[ ! -f "$TMP/d/active_lock.json" ] && ok "cap clears the lock record" || bad "lock record left after cap"
kill $DPID4 $MPID4 2>/dev/null
CTRL_PORT=$CTRL1

# ---------------- round 2 (0.4.1): contracts C1 C2 C6 C9 C10, config moves, log rotation ----------------
# run_d <dir> <ctrl port> [env...]: the real daemon on the config already in <dir>
run_d(){ local d="$1" p="$2"; shift 2
  env "$@" LOCKQZ_TOKEN_FILE="$d/helper.token" LOCKQZ_TOKEN_DIR="$d/tokens" LOCKQZ_LOCKFILE="$d/active_lock.json" LOCKQZ_NO_DEVMODE=1 LOCKQZ_DRYRUN=1 \
    LOCKQZ_CONFIG="$d/config.json" LOCKQZ_KEY_PATH="$d/device.key" LOCKQZ_BLOCKLIST="$d/blocklist.txt" LOCKQZ_UPDATE_DELAY=99999 \
    python3 "$APP/mac/lockqzd.py" >>"$d/daemon.log" 2>&1 & DPID_=$!
  for i in $(seq 1 20); do curl -s -m 2 -H "X-LOCKqz-Token: $TOKEN" "http://127.0.0.1:$p/status" >/dev/null 2>&1 && break; sleep 0.5; done; }
mk_d(){ mkdir -p "$1"; cp "$APP/mac/blocklist.txt" "$1/blocklist.txt"; printf %s "$TOKEN" > "$1/helper.token"
  printf '{ "port": %s, "api_base": "http://127.0.0.1:%s", "device_id": "%s", "student": "T", "beat_cycles": %s }\n' "$2" "$3" "$4" "$5" > "$1/config.json"; }
stj(){ curl -s -H "X-LOCKqz-Token: $TOKEN" "http://127.0.0.1:$CTRL_PORT/status" | python3 -c "import sys,json,time;s=json.load(sys.stdin);print($1)" 2>/dev/null; }
CTRL1=$CTRL_PORT; CTRL_PORT=$(free_port); M5=$(free_port); LOG5="$TMP/reports5.log"
python3 "$TMP/mock.py" "$M5" "$LOG5" 0 & MPID5=$!
for i in $(seq 1 20); do curl -s -o /dev/null -m 1 "http://127.0.0.1:$M5/" && break; sleep 0.25; done
mk_d "$TMP/e" "$CTRL_PORT" "$M5" itest-r2 60; run_d "$TMP/e" "$CTRL_PORT"; DPID5=$DPID_
sleep 2

echo "T10 C1: no separate heartbeat right before /password (the signed /password refreshes the lock)"
hpost /lock '{"quiz_id":"98765-12345","student":"T"}' >/dev/null
r=$(hpost /password "{\"url\":\"$QURL\"}")
echo "$r" | grep -q 'LQ-TESTPASS' && ok "password released right after the lock (lock report awaited, no race)" || bad "no password: $r"
prev=$(grep -B1 -m1 '^/api/password' "$LOG5" | head -1)
echo "$prev" | grep -q '"event": "heartbeat"' && bad "a heartbeat was sent right before /password: $prev" || ok "the line before /password is not a heartbeat"
n_hb=$(grep -c '"event": "heartbeat"' "$LOG5"); [ "$n_hb" -eq 0 ] && ok "no heartbeat at all for a lock + password (budget)" || bad "$n_hb heartbeat(s) sent"

echo "T11 C2: the server's quiz end sets the safety cap to end + 15 min (no fixed 3 hours)"
v=$(stj 's["end_known"] and abs(s["cap_at"]-(time.time()+3600+900))<90')
[ "$v" = "True" ] && ok "cap = quiz end + 15 min" || bad "cap not from the end: $(stj 's.get("cap_at"),s.get("end_known")')"
v=$(python3 -c "import json,time;r=json.load(open('$TMP/e/active_lock.json'));print(r['end_known'] and abs(r['cap_at']-(time.time()+4500))<90)")
[ "$v" = "True" ] && ok "lock record carries the new cap (survives a restart)" || bad "lock record cap: $(cat "$TMP/e/active_lock.json")"
hpost /unlock '{"quiz_id":"98765-12345","reason":"quiz_submitted"}' >/dev/null
Q2='https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?ou=98765&qi=22222'
hpost /lock '{"quiz_id":"98765-22222","student":"T"}' >/dev/null; hpost /password "{\"url\":\"$Q2\"}" >/dev/null
v=$(stj '(not s["end_known"]) and abs(s["cap_at"]-(s["locked_since"]+6*3600))<5')
[ "$v" = "True" ] && ok "an end already over is ignored: unknown-end cap 6 h stays" || bad "past end changed the cap: $(stj 's.get("cap_at"),s.get("locked_since")')"
hpost /unlock '{"quiz_id":"98765-22222","reason":"quiz_submitted"}' >/dev/null

echo "T11b OSAS: an accommodation added mid-quiz (server stops naming an end) never leaves the short end-based cap"
Q6='https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?ou=98765&qi=66666'
hpost /lock '{"quiz_id":"98765-66666","student":"T"}' >/dev/null; hpost /password "{\"url\":\"$Q6\"}" >/dev/null
v=$(stj 's["end_known"] and abs(s["cap_at"]-(time.time()+600+900))<90')
[ "$v" = "True" ] && ok "first: cap = end + 15 min" || bad "cap not from the end: $(stj 's.get("cap_at"),s.get("end_known")')"
touch "$LOG5.noend"; hpost /password "{\"url\":\"$Q6\"}" >/dev/null; rm -f "$LOG5.noend"
v=$(stj '(not s["end_known"]) and abs(s["cap_at"]-(s["locked_since"]+6*3600))<5')
[ "$v" = "True" ] && ok "then end null: cap back to the 6 h unknown-end failsafe (never cut short)" || bad "cap stayed short: $(stj 's.get("cap_at"),s.get("locked_since"),s.get("end_known")')"
hpost /unlock '{"quiz_id":"98765-66666","reason":"quiz_submitted"}' >/dev/null

echo "T12 C2: 'not started' is passed to the agent with the seconds until the quiz opens"
Q3='https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?ou=98765&qi=33333'
hpost /lock '{"quiz_id":"98765-33333","student":"T"}' >/dev/null
c=$(hcode /password "{\"url\":\"$Q3\"}"); r=$(hpost /password "{\"url\":\"$Q3\"}")
[ "$c" = "200" ] && echo "$r" | grep -q '"reason": "not started"' && ok "not started -> 200 with reason (not a 502 failure)" || bad "not started answer: $c $r"
si=$(echo "$r" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("start_in"))')
[ "${si:-0}" -ge 540 ] 2>/dev/null && [ "$si" -le 610 ] && ok "start_in ~600 s ($si)" || bad "start_in $si"
hpost /unlock '{"quiz_id":"98765-33333","reason":"quiz_left"}' >/dev/null

echo "T13 C10: another school's Brightspace -> AI back at once, quiz not re-locked"
Q4='https://other.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?ou=98765&qi=44444'
hpost /lock '{"quiz_id":"98765-44444","student":"T"}' >/dev/null
r=$(hpost /password "{\"url\":\"$Q4\"}")
echo "$r" | grep -q '"reason": "other_school"' && ok "agent told other_school" || bad "other school: $r"
[ "$(stj 's["state"],s["capped_quiz"],s["capped_reason"]')" = "unlocked 98765-44444 other_school" ] && ok "helper unlocked and marks the quiz released" || bad "status: $(stj 's')"
sleep 1; grep '"event": "unlock"' "$LOG5" | grep -q '"reason": "other_school"' && ok "unlock reported, reason other_school" || bad "no other_school unlock report"

echo "T14 C6: the install report is sent only when the version/student changed or after 24 h"
n1=$(grep -c '"event": "install"' "$LOG5")
[ "$n1" -eq 1 ] && ok "first start: one install report" || bad "install reports at first start: $n1"
kill $DPID5; wait $DPID5 2>/dev/null; run_d "$TMP/e" "$CTRL_PORT"; DPID5=$DPID_; sleep 2
hpost /student '{"student":"T"}' >/dev/null; sleep 1
n2=$(grep -c '"event": "install"' "$LOG5")
[ "$n2" -eq 1 ] && ok "restart + same student: no new install report" || bad "install reports now $n2"
hpost /student '{"student":"new@usc.edu"}' >/dev/null; sleep 1
n3=$(grep -c '"event": "install"' "$LOG5")
[ "$n3" -eq 2 ] && ok "student changed: reported once" || bad "install reports after student change: $n3"
python3 -c "import json;r=json.load(open('$TMP/e/install_report.json'));r['at']-=90000;json.dump(r,open('$TMP/e/install_report.json','w'))"
hpost /student '{"student":"new@usc.edu"}' >/dev/null; sleep 1
[ "$(grep -c '"event": "install"' "$LOG5")" -eq 3 ] && ok "24 h later: reported again" || bad "no daily install report"
kill $DPID5 $MPID5 2>/dev/null

echo "T15 C9: the server says the student submitted -> the helper unlocks at once and never re-locks it"
M6=$(free_port); LOG6="$TMP/reports6.log"; CTRL_PORT=$(free_port)
python3 "$TMP/mock.py" "$M6" "$LOG6" 0 & MPID6=$!
for i in $(seq 1 20); do curl -s -o /dev/null -m 1 "http://127.0.0.1:$M6/" && break; sleep 0.25; done
mk_d "$TMP/f" "$CTRL_PORT" "$M6" itest-c9 1; run_d "$TMP/f" "$CTRL_PORT"; DPID6=$DPID_
hpost /lock '{"quiz_id":"98765-12345","student":"T"}' >/dev/null; sleep 1
[ "$(stj 's["state"]')" = "locked" ] && ok "locked" || bad "not locked"
echo quiz_submitted > "$LOG6.unlock"
for i in $(seq 1 30); do [ "$(stj 's["state"]')" = "unlocked" ] && break; sleep 0.5; done
[ "$(stj 's["state"],s["capped_quiz"],s["capped_reason"]')" = "unlocked 98765-12345 quiz_submitted" ] && ok "heartbeat reply unlock:true -> unlocked, quiz marked released" || bad "status: $(stj 's')"
[ ! -f "$TMP/f/active_lock.json" ] && ok "lock record cleared" || bad "lock record left"
grep '"event": "unlock"' "$LOG6" | grep -q '"reason": "quiz_submitted"' && ok "unlock reported with the server's reason" || bad "no quiz_submitted unlock report"
hpost /lock '{"quiz_id":"98765-12345","student":"T"}' >/dev/null
for i in $(seq 1 20); do [ "$(stj 's["state"]')" = "unlocked" ] && break; sleep 0.5; done
[ "$(stj 's["state"]')" = "unlocked" ] && ok "a lock for an already-submitted quiz is released from the lock report's answer" || bad "re-locked a submitted quiz"
echo maybe > "$LOG6.unlock"; rm -f "$LOG6.unlock"
echo "T15b round-2 #4: the agent's /uncap (page closed / new attempt) makes the released quiz lockable again"
[ "$(stj 's["capped_quiz"]')" = "98765-12345" ] && ok "precondition: quiz marked released" || bad "not marked: $(stj 's')"
hpost /uncap '{"quiz_id":"98765-12345"}' >/dev/null
[ "$(stj 's["capped_quiz"]')" = "None" ] && [ ! -f "$TMP/f/capped.json" ] && ok "/uncap: helper forgets the release (status + capped.json)" || bad "still released: $(stj 's') $(ls $TMP/f)"
hpost /lock '{"quiz_id":"98765-12345","student":"T"}' >/dev/null; sleep 1
[ "$(stj 's["state"]')" = "locked" ] && ok "... and a new attempt locks" || bad "new attempt not locked"
hpost /unlock '{"quiz_id":"98765-12345","reason":"quiz_submitted"}' >/dev/null
kill $DPID6 2>/dev/null; sleep 0.5
python3 -c "import json,time;json.dump({'quiz_id':'98765-12345','at':time.time()-120,'reason':'cap'},open('$TMP/f/capped.json','w'))"
run_d "$TMP/f" "$CTRL_PORT" LOCKQZ_CAP_FORGET=60; DPID6=$DPID_
[ "$(stj 's["capped_quiz"]')" = "None" ] && ok "a release older than the forget window (30 min; 60 s here) is not reported (was 24 h)" || bad "old release still reported: $(stj 's')"
kill $DPID6 2>/dev/null; sleep 0.5
python3 -c "import json,time;json.dump({'quiz_id':'98765-12345','at':time.time()-10,'reason':'cap'},open('$TMP/f/capped.json','w'))"
run_d "$TMP/f" "$CTRL_PORT" LOCKQZ_CAP_FORGET=60; DPID6=$DPID_
[ "$(stj 's["capped_quiz"]')" = "98765-12345" ] && ok "a fresh release survives a helper restart" || bad "fresh release lost: $(stj 's')"
kill $DPID6 $MPID6 2>/dev/null

echo "T16 E1/E6: an old lockdownqz api_base and a placeholder device id are fixed once; nothing else changes"
CTRL_PORT=$(free_port); mkdir -p "$TMP/g"; cp "$APP/mac/blocklist.txt" "$TMP/g/"; printf %s "$TOKEN" > "$TMP/g/helper.token"
printf '{ "port": %s, "api_base": "http://lockdownqz.pages.dev.invalid/api", "device_id": "set-at-install", "student": "S", "keep": "me" }\n' "$CTRL_PORT" > "$TMP/g/config.json"
run_d "$TMP/g" "$CTRL_PORT"; DPID7=$DPID_
v=$(python3 -c "import json,re;c=json.load(open('$TMP/g/config.json'));print(c['api_base']=='http://lockqz.pages.dev.invalid/api' and bool(re.fullmatch(r'mac-[0-9a-f-]{36}',c['device_id'])) and c['keep']=='me' and c['student']=='S' and c['port']==$CTRL_PORT)")
[ "$v" = "True" ] && ok "api_base -> lockqz.pages.dev, device id -> mac-<uuid>, other keys kept" || bad "config: $(cat "$TMP/g/config.json")"
d1=$(python3 -c "import json;print(json.load(open('$TMP/g/config.json'))['device_id'])")
kill $DPID7; wait $DPID7 2>/dev/null; run_d "$TMP/g" "$CTRL_PORT"; DPID7=$DPID_
[ "$(python3 -c "import json;print(json.load(open('$TMP/g/config.json'))['device_id'])")" = "$d1" ] && ok "the new device id is kept on the next start" || bad "device id changed again"
kill $DPID7 2>/dev/null

echo "T17 the helper log is rotated at its size limit (never fills the disk)"
CTRL_PORT=$(free_port); mkdir -p "$TMP/h"; cp "$APP/mac/blocklist.txt" "$TMP/h/"; printf %s "$TOKEN" > "$TMP/h/helper.token"
printf '{ "port": %s, "api_base": "", "device_id": "itest-log" }\n' "$CTRL_PORT" > "$TMP/h/config.json"
head -c 5000 /dev/zero | tr '\0' 'x' > "$TMP/h/daemon.log"
run_d "$TMP/h" "$CTRL_PORT" LOCKQZ_LOG="$TMP/h/daemon.log" LOCKQZ_LOG_MAX=2000; DPID8=$DPID_; sleep 1
[ -f "$TMP/h/daemon.log.1" ] && [ "$(wc -c < "$TMP/h/daemon.log")" -lt 2000 ] && grep -q "log rotated" "$TMP/h/daemon.log" && ok "old log moved to .1, new lines go to a fresh file" || bad "not rotated: $(ls -la "$TMP/h")"
kill $DPID8 2>/dev/null

echo "T18 (29 Oct) a student-token /unlock is HELD until the server vouches for the quiz end; the master token still unlocks"
CTRL_PORT=$(free_port); M9=$(free_port); LOG9="$TMP/reports9.log"; mkdir -p "$TMP/i"; cp "$APP/mac/blocklist.txt" "$TMP/i/"; printf %s "$TOKEN" > "$TMP/i/helper.token"
printf '{ "port": %s, "api_base": "http://127.0.0.1:%s/api", "device_id": "itest-hold" }\n' "$CTRL_PORT" "$M9" > "$TMP/i/config.json"
SUID=$(( $(id -u) > 0 ? $(id -u) : 501 ))   # root runs the tests in CI: a pretend console user then
echo "{\"console\": $SUID, \"alive\": [$SUID]}" > "$TMP/i/sessions.json"
python3 "$TMP/mock.py" "$M9" "$LOG9" 0 & MPID9=$!
run_d "$TMP/i" "$CTRL_PORT" LOCKQZ_TEST_SESSIONS="$TMP/i/sessions.json"; DPID9=$DPID_
sleep 6   # the watcher shares the console user's token
UTOK="$(cat "$TMP/i/tokens/$SUID" 2>/dev/null)"
[ -n "$UTOK" ] && ok "console user got a per-user token" || bad "no per-user token in $TMP/i/tokens"
UH="X-LOCKqz-Token: $UTOK"
curl -s -X POST -H "$UH" -H 'Content-Type: application/json' -d '{"quiz_id":"98765-12345","student":"Al"}' "http://127.0.0.1:$CTRL_PORT/lock" >/dev/null; sleep 2
code=$(curl -s -o "$TMP/i/u1.json" -w '%{http_code}' -X POST -H "$UH" -H 'Content-Type: application/json' -d '{"quiz_id":"98765-12345","reason":"quiz_submitted"}' "http://127.0.0.1:$CTRL_PORT/unlock")
[ "$code" = 202 ] && grep -q '"pending": "brightspace"' "$TMP/i/u1.json" && ok "student token + 'quiz_submitted' nobody can confirm -> 202 pending, not unlocked" || bad "unlock answered $code: $(cat "$TMP/i/u1.json")"
curl -s -H "$UH" "http://127.0.0.1:$CTRL_PORT/status" | grep -q '"state": "locked"' && ok "helper still locked" || bad "helper unlocked on the student's word"
grep -q '"ask": true' "$LOG9" && ok "the server was asked (local unlock with ask)" || bad "server not asked: $(tail -3 "$LOG9")"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$UH" -H 'Content-Type: application/json' -d '{"quiz_id":"98765-12345","reason":"quiz_left"}' "http://127.0.0.1:$CTRL_PORT/unlock")
n=$(grep -c '"event": "unlock"' "$LOG9")
[ "$code" = 202 ] && [ "$n" = 1 ] && ok "a retry within 30 s is answered from the hold, not re-asked (agent retries every 5 s)" || bad "retry: code $code, asks=$n"
echo "quiz_submitted" > "$LOG9.unlock"    # Brightspace's submission reaches the server
sleep 32                                   # the helper beats every 30 s while a release is pending
curl -s -H "$UH" "http://127.0.0.1:$CTRL_PORT/status" | grep -q '"state": "unlocked"' && ok "released by the server's next beat (unlock:true quiz_submitted) within 30 s" || bad "still locked after the submission: $(curl -s -H "$UH" "http://127.0.0.1:$CTRL_PORT/status")"
rm -f "$LOG9.unlock"
curl -s -X POST -H "$UH" -H 'Content-Type: application/json' -d '{"quiz_id":"98765-12345","student":"Al"}' "http://127.0.0.1:$CTRL_PORT/lock" >/dev/null; sleep 2
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-LOCKqz-Token: $TOKEN" -H 'Content-Type: application/json' -d '{"quiz_id":"98765-12345"}' "http://127.0.0.1:$CTRL_PORT/unlock")
[ "$code" = 200 ] && ok "master (root) token unlocks at once (installer tests, admin)" || bad "root unlock answered $code"
kill $DPID9 $MPID9 2>/dev/null
CTRL_PORT=$CTRL1
echo ""
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
