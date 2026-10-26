#!/bin/bash
# 26 Oct 2026 helper hardening (DRY-RUN, no root, no network):
#   F4 fast user switching: per-user tokens; only the console user drives the helper; another logged-in
#      account's lock can't be adopted or ended; a logged-out owner's lock can be taken over
#   F3 /unlock naming another quiz is refused; local unlocks are reported as local
#   F2 Windows safety cap needs the monotonic clock too (static)
#   F6 local-model apps/servers on the Mac + Windows close lists, no accessibility tools (static)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; MAC="$HERE/../mac"; WIN="$HERE/../windows"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ok: $1"; }
bad(){ FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
chk(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

TMP="$(mktemp -d)"; T=master-token-0123456789abcdef
printf %s "$T" > "$TMP/helper.token"
mkdir -p "$TMP/tokens"; printf %s "$T" > "$TMP/tokens/777"     # an old-style copy of the MASTER token
printf '{"console":501,"alive":[501,502]}' > "$TMP/sessions.json"
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
printf '{"port":%s,"api_base":"","device_id":"test-dev","student":"test","cap_minutes":5}' "$PORT" > "$TMP/config.json"
( cd "$MAC" && LOCKQZ_NO_DEVMODE=1 LOCKQZ_DRYRUN=1 LOCKQZ_TEST_SESSIONS="$TMP/sessions.json" LOCKQZ_CONFIG="$TMP/config.json" LOCKQZ_KEY_PATH="$TMP/device.key" \
  LOCKQZ_LOCKFILE="$TMP/active_lock.json" LOCKQZ_TOKEN_FILE="$TMP/helper.token" LOCKQZ_TOKEN_DIR="$TMP/tokens" exec python3 lockqzd.py >"$TMP/daemon.log" 2>&1 ) &
DPID=$!
trap 'kill $DPID 2>/dev/null; rm -rf "$TMP"' EXIT
B=http://127.0.0.1:$PORT
for i in $(seq 1 20); do [ -f "$TMP/tokens/501" ] && break; sleep 0.5; done
M="$(cat "$TMP/helper.token")"
utok(){ python3 -c 'import hmac,hashlib,sys; print(hmac.new(sys.argv[1].encode(), b"lockqz-uid:%d" % int(sys.argv[2]), hashlib.sha256).hexdigest())' "$M" "$1"; }
A="$(utok 501)"; U2="$(utok 502)"
code(){ curl -s -o /dev/null -w '%{http_code}' -H "X-LOCKqz-Token: $1" ${3:+-X POST -d "$3"} "$B$2"; }
body(){ curl -s -H "X-LOCKqz-Token: $1" ${3:+-X POST -d "$3"} "$B$2"; }
st(){ body "$M" /status | python3 -c 'import sys,json;print(json.load(sys.stdin)["state"])' 2>/dev/null; }
setsess(){ printf '%s' "$1" > "$TMP/sessions.json"; }

echo "F4 per-user tokens"
chk "old shared copy of the master token retired (master rotated, old copy gone)" '[ "$M" != "$T" ] && [ ! -e "$TMP/tokens/777" ]'
chk "console user 501 got ITS OWN token (not the master)" '[ "$(cat "$TMP/tokens/501")" = "$A" ] && [ "$A" != "$M" ]'
chk "the old master token no longer works" '[ "$(code "$T" /status)" = 401 ]'
chk "console user's token works" '[ "$(code "$A" /status)" = 200 ]'

echo "F4 fast user switching"
chk "501 (at the screen) locks" '[ "$(code "$A" /lock "{\"quiz_id\":\"98765-12345\"}")" = 200 ] && [ "$(st)" = locked ]'
setsess '{"console":502,"alive":[501,502]}'
chk "502 switched in: sees another account's lock as other_user (cannot adopt it)" '[ "$(body "$U2" /status | python3 -c "import sys,json;print(json.load(sys.stdin)[\"state\"])")" = other_user ]'
chk "502 cannot unlock 501's quiz" '[ "$(code "$U2" /unlock "{\"quiz_id\":\"98765-12345\"}")" = 409 ] && [ "$(st)" = locked ]'
chk "502 cannot start its own lock over it" '[ "$(code "$U2" /lock "{\"quiz_id\":\"1-2\"}")" = 409 ] && [ "$(st)" = locked ]'
chk "501 in the background cannot unlock either (its agent sees no browser)" '[ "$(code "$A" /unlock "{\"quiz_id\":\"98765-12345\"}")" = 409 ] && [ "$(st)" = locked ]'
chk "501 in the background cannot re-lock / change the quiz" '[ "$(code "$A" /lock "{\"quiz_id\":\"1-2\"}")" = 409 ]'
setsess '{"console":501,"alive":[501,502]}'
chk "501 back at the screen: /unlock naming ANOTHER quiz is refused" '[ "$(code "$A" /unlock "{\"quiz_id\":\"1-2\"}")" = 409 ] && [ "$(st)" = locked ]'
setsess '{"console":502,"alive":[502]}'
chk "501 logged out: 502 sees the lock and may end it (nobody is left blocked)" '[ "$(body "$U2" /status | python3 -c "import sys,json;print(json.load(sys.stdin)[\"state\"])")" = locked ] && [ "$(code "$U2" /unlock "{\"quiz_id\":\"98765-12345\"}")" = 200 ] && [ "$(st)" = unlocked ]'

echo "F3 local unlocks are reported as local (the server checks them)"
chk "unlock report carries local:true + before_end" 'grep -q "det = {\"reason\": reason, \"local\": True}" "$MAC/lockqzd.py" && grep -q "before_end=bool(before_end)" "$MAC/lockqzd.py"'

echo "F4 agent pauses while another account is at the screen"
python3 - "$MAC" <<'PY' && ok "agent: not at console -> forgets its lock view (never unlocks), back -> normal" || bad "agent console_step"
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("agent", os.path.join(sys.argv[1], "lockqz-agent.py"))
A = importlib.util.module_from_spec(spec); spec.loader.exec_module(A)
a = A.Agent.__new__(A.Agent); a.locked, a.quiz, a.url, a.missing_since, a.pending, a.last_check = True, "1-2", "u", None, ("1-2", "quiz_left"), 5.0
calls = []; a.helper = lambda *x, **k: calls.append(x)
assert a.console_step(False) is False and not a.locked and a.pending is None and a.quiz is None and not calls
assert a.console_step(True) is True
PY

echo "F2 Windows safety cap: wall clock AND monotonic clock"
chk "watcher requires the monotonic elapsed time too" 'grep -q "\$monoOk = " "$WIN/lockqzd.ps1" && grep -q -- "-ge \$capAt -and \$monoOk" "$WIN/lockqzd.ps1"'
chk "Stopwatch (works on PowerShell 5.1 and 7), set at lock and at resume" '[ "$(grep -c "Diagnostics.Stopwatch\]::GetTimestamp()" "$WIN/lockqzd.ps1")" -ge 3 ]'

echo "F6 local-model apps / servers closed during a lock"
for a in Ollama "LM Studio" GPT4All Jan Msty AnythingLLM "Private LLM" "Backyard AI"; do
  chk "Mac app list: $a" 'grep -A8 "^AI_APPS=" "$MAC/lockqz.sh" | grep -q "\"$a\""'; done
for p in ollama ollama_llama_server llama-server lms koboldcpp llamafile; do
  chk "Mac local-model processes: $p" 'grep -A3 "^LOCAL_MODEL_PROCS=" "$MAC/extra-block.sh" | grep -q "\"$p\""'; done
chk "Mac: llama.cpp python server matched by its module" 'grep -A2 "^LOCAL_MODEL_CMD_RES=" "$MAC/extra-block.sh" | grep -q "llama_cpp"'
for p in ollama ollama_llama_server "ollama app" llama-server lms lmstudio gpt4all jan msty koboldcpp; do
  chk "Windows close list: $p" 'grep -E "^\\\$(AiApps|ModelProcs) *=" -A3 "$WIN/lockqz.ps1" | grep -qi "\"$p\""'; done
LISTS="$(grep -A8 '^AI_APPS=' "$MAC/lockqz.sh"; grep -A3 '^LOCAL_MODEL_PROCS=' "$MAC/extra-block.sh"; grep -E '^\$(AiApps|ModelProcs) *=' -A3 "$WIN/lockqz.ps1")"
for x in VoiceOver "Voice Control" Dictation Narrator NVDA JAWS Dragon ZoomText Kurzweil "Read&Write" MacWhisper Magnifier; do
  chk "accessibility tool untouched: $x" '! printf "%s" "$LISTS" | grep -qi "\"$x\""'; done
chk "Mac kill lists still parse" 'bash -n "$MAC/lockqz.sh" && bash -n "$MAC/extra-block.sh"'

echo ""; echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
