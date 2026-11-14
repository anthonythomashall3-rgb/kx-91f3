#!/bin/bash
# Real-machine test of the macOS installer (GitHub macOS runner; passwordless sudo).
# Builds the .pkg, installs it, then checks: daemon up, token check, LOCK (hosts, DNS, pf,
# browser policy), status, no developer mode (a student machine ALWAYS locks), UNLOCK,
# backend reachable with the app's own user agent, and UNINSTALL. Exits 1 on any failure.
cd "$(dirname "$0")/../mac" || exit 1
FAIL=0
check() { if eval "$2" >/dev/null 2>&1; then echo "PASS  $1"; else echo "FAIL  $1"; FAIL=$((FAIL+1)); fi; }
DEST="/Library/Application Support/LOCKqz"
bash make-pkg.sh --api https://lockqz.pages.dev/api --out /tmp/lockqz-mac.pkg >/dev/null
check "pkg built" "[ -s /tmp/lockqz-mac.pkg ]"
sudo installer -pkg /tmp/lockqz-mac.pkg -target / >/tmp/install.log 2>&1
check "installer succeeded" "grep -q 'successful' /tmp/install.log"
for f in lockqz.sh lockqz-core.sh extra-block.sh lockqzd.py lockqz-agent.py browser-policy.py blocklist.txt config.json ensure-python.sh lockqz-boot.sh update.pub; do
  check "installed $f" "[ -f \"$DEST/$f\" ]"
done
check "device id set" "grep -q '\"mac-' \"$DEST/config.json\""
check "no control token in the world-readable config" "! grep -q '\"token\"' \"$DEST/config.json\""
check "control token is root-only (600)" "[ \"\$(stat -f %Lp \"$DEST/helper.token\")\" = 600 ] && [ \"\$(stat -f %Su \"$DEST/helper.token\")\" = root ]"
check "install folder is root's, not group/world writable" "[ \"\$(stat -f %Su \"$DEST\")\" = root ] && [ \"\$(stat -f %Lp \"$DEST\")\" = 755 ]"
TOK="$(sudo cat "$DEST/helper.token")"
check "daemon registered (launchd)" "sudo launchctl print system/com.lockqz.helper"

H="X-LOCKqz-Token: $TOK"; B=http://127.0.0.1:8787
UP=0; for i in $(seq 1 30); do if curl -sf -m 3 -H "$H" $B/status >/dev/null; then UP=1; break; fi; sleep 2; done
check "daemon answering" "[ $UP = 1 ]"
CU="$(stat -f %u /dev/console)"
[ "$CU" != 0 ] && check "console user got a read-only token copy" "[ \"\$(stat -f %Su:%Lp \"$DEST/tokens/$CU\")\" = \"\$(id -un $CU):400\" ]"
check "browser-origin request refused (no CORS)" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -H '$H' -H 'Origin: https://evil.example' $B/status)\" = 401 ]"
check "no CORS preflight answer" "! curl -s -i -X OPTIONS $B/lock | grep -qi 'access-control-allow'"
check "rejects wrong token" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'X-LOCKqz-Token: nope' $B/status)\" = 401 ]"
check "no developer mode on a student machine" "curl -s -H '$H' $B/status | grep -q '\"developer\": false'"

# This test drives the helper by hand (no quiz page is open). The student's agent would take such a lock over and,
# seeing it ended by someone else within its 30 s grace, put it back: keep it out of this lock / unlock.
for u in $(ps -axo uid=,args= | awk '/lockqz-agent\.py/ && !/awk/ {print $1}' | sort -u); do sudo launchctl bootout "gui/$u/com.lockqz.agent" 2>/dev/null || true; done
sudo pkill -f 'lockqz-agent\.py' 2>/dev/null || true
T0=$(python3 -c 'import time; print(time.time())')
curl -s -m 90 -X POST -H "$H" -H 'Content-Type: application/json' -d '{"quiz_id":"ci-test","student":"CI"}' $B/lock >/tmp/lock.json
echo "INFO  first lock took $(python3 -c "import time; print(round(time.time()-$T0, 1))") s"
check "lock accepted" "grep -q '\"locked\"' /tmp/lock.json"
check "hosts has block" "grep -q 'LOCKqz START' /etc/hosts"
for d in chatgpt.com claude.ai gemini.google.com perplexity.ai; do
  check "$d blocked" "dscacheutil -q host -a name $d | grep -q '0.0.0.0'"
done
check "pf anchor loaded" "sudo pfctl -a com.lockqz -sr | grep -q block"
check "Chrome AI policy on" "[ -f '/Library/Managed Preferences/com.google.Chrome.plist' ]"
check "status locked" "curl -s -H '$H' $B/status | grep -q '\"engine_locked\": true'"

# One lock pass of the kind that repeats every 5 s during a quiz (the engine itself, timed).
T0=$(python3 -c 'import time; print(time.time())'); sudo bash "$DEST/lockqz.sh" lock >/dev/null 2>&1
PASS_S=$(python3 -c "import time; print(round(time.time()-$T0, 1))"); echo "INFO  repeat lock pass took $PASS_S s"
check "the repeat lock pass takes under 10 s on this test machine (it repeats every 5 s during a quiz)" "python3 -c 'import sys; sys.exit(0 if $PASS_S < 10 else 1)'"
T0=$(python3 -c 'import time; print(time.time())')
curl -s -m 90 -X POST -H "$H" -H 'Content-Type: application/json' -d '{"quiz_id":"ci-test"}' $B/unlock >/tmp/unlock.json
echo "INFO  unlock took $(python3 -c "import time; print(round(time.time()-$T0, 1))") s"
check "unlock accepted" "grep -q '\"unlocked\"' /tmp/unlock.json"
check "hosts clean" "! grep -q 'LOCKqz START' /etc/hosts"
check "chatgpt.com reachable again" "! dscacheutil -q host -a name chatgpt.com | grep -q '0.0.0.0'"
# How the name service answers in the seconds after the unlock (printed for the record).
for i in $(seq 0 25); do r="$(dscacheutil -q host -a name chatgpt.com 2>&1 | tr '\n' ' ')"; echo "INFO  t+${i}s chatgpt.com: $r"; echo "$r" | grep -q '0\.0\.0\.0' || break; sleep 1; done
echo "INFO  poe.com (never asked during the lock): $(dscacheutil -q host -a name poe.com 2>&1 | tr '\n' ' ')"
echo "INFO  hosts lines naming chatgpt: $(grep -c chatgpt /etc/hosts)   resolver files: $(ls /etc/resolver 2>/dev/null | wc -l | tr -d ' ')"
echo "INFO  hosts: $(wc -l < /etc/hosts | tr -d ' ') lines; LOCKqz/chatgpt lines:"; grep -n "LOCKqz\|chatgpt" /etc/hosts | head -12 | sed 's/^/INFO    /'
echo "INFO  hosts tail:"; tail -4 /etc/hosts | sed 's/^/INFO    /'
check "Chrome AI policy removed" "[ ! -f '/Library/Managed Preferences/com.google.Chrome.plist' ]"

# A lock that lasts a while, as a quiz does (several 5 s passes go by), then the unlock: timed through the helper.
curl -s -m 90 -X POST -H "$H" -H 'Content-Type: application/json' -d '{"quiz_id":"ci-test-2","student":"CI"}' $B/lock >/dev/null
sleep 14
T0=$(python3 -c 'import time; print(time.time())'); curl -s -m 10 -H "$H" $B/status >/dev/null
echo "INFO  status answer during the quiz took $(python3 -c "import time; print(round(time.time()-$T0, 1))") s"
T0=$(python3 -c 'import time; print(time.time())')
curl -s -m 90 -X POST -H "$H" -H 'Content-Type: application/json' -d '{"quiz_id":"ci-test-2"}' $B/unlock >/tmp/unlock2.json
echo "INFO  unlock after a 14 s quiz took $(python3 -c "import time; print(round(time.time()-$T0, 1))") s"
check "second unlock accepted, hosts clean" "grep -q '\"unlocked\"' /tmp/unlock2.json && ! grep -q 'LOCKqz START' /etc/hosts"

# Where a first lock and an unlock spend their seconds (the engine itself, traced; one line per second that passes).
lq_trace() { sudo bash -c 'PS4="+T\${SECONDS} "; set -x; source "$0" "$1"' "$DEST/lockqz.sh" "$1" 2>&1 | awk -v w="$1" '/^\++T[0-9]+ / { t=$1; gsub(/\+/,"",t); if (t != p && p != "") print "INFO  " w " until " t ": " substr(last, 1, 170); p = t; last = $0 } END { print "INFO  " w " ended at " p }'; }
lq_trace lock; lq_trace unlock
check "hosts clean after the traced unlock" "! grep -q 'LOCKqz START' /etc/hosts"

sleep 3
check "daemon reports reach the server (no 403 in log)" "! grep -q '403' \"$DEST/lockqzd.log\""
check "server reachable with app user agent" "/usr/bin/python3 -c \"import urllib.request,json;r=urllib.request.urlopen(urllib.request.Request('https://lockqz.pages.dev/api/blocklist',headers={'User-Agent':'LOCKqz/0.2.0 (macOS)'}),timeout=10);assert len(json.load(r)['domains'])>=20\""

sudo bash uninstall.sh >/dev/null 2>&1 || sudo bash "$DEST/../LOCKqz/uninstall.sh" >/dev/null 2>&1
check "uninstall removed daemon" "! sudo launchctl print system/com.lockqz.helper"
check "uninstall removed files" "[ ! -d \"$DEST\" ]"
check "hosts clean after uninstall" "! grep -q 'LOCKqz START' /etc/hosts"

echo; [ $FAIL -eq 0 ] && echo "ALL CHECKS PASSED" || { echo "$FAIL CHECK(S) FAILED"; tail -30 "$DEST/lockqzd.log" 2>/dev/null; exit 1; }
