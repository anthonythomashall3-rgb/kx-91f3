#!/bin/bash
# Real-machine test of the macOS installer (GitHub macOS runner; passwordless sudo).
# Builds the .pkg, installs it, then checks: daemon up, token check, LOCK (hosts, DNS, pf,
# browser policy), status, no developer mode (a student machine ALWAYS locks), UNLOCK,
# backend reachable with the app's own user agent, and UNINSTALL. Exits 1 on any failure.
cd "$(dirname "$0")/../mac" || exit 1
FAIL=0
check() { if eval "$2" >/dev/null 2>&1; then echo "PASS  $1"; else echo "FAIL  $1"; FAIL=$((FAIL+1)); fi; }
DEST="/Library/Application Support/LOCKqz"
TOK="lqz-ci-$RANDOM$RANDOM"

bash make-pkg.sh --token "$TOK" --api https://lockqz.pages.dev/api --out /tmp/lockqz-mac.pkg >/dev/null
check "pkg built" "[ -s /tmp/lockqz-mac.pkg ]"
sudo installer -pkg /tmp/lockqz-mac.pkg -target / >/tmp/install.log 2>&1
check "installer succeeded" "grep -q 'successful' /tmp/install.log"
for f in lockqz.sh lockqz-core.sh extra-block.sh lockqzd.py lockqz-agent.py browser-policy.py blocklist.txt config.json; do
  check "installed $f" "[ -f \"$DEST/$f\" ]"
done
check "device id set" "grep -q '\"mac-' \"$DEST/config.json\""
check "daemon registered (launchd)" "sudo launchctl print system/com.lockqz.helper"

H="X-LOCKqz-Token: $TOK"; B=http://127.0.0.1:8787
for i in $(seq 1 30); do curl -sf -m 2 -H "$H" $B/status >/dev/null && break; sleep 2; done
check "daemon answering" "curl -sf -m 3 -H '$H' $B/status"
check "rejects wrong token" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'X-LOCKqz-Token: nope' $B/status)\" = 401 ]"
check "no developer mode on a student machine" "curl -s -H '$H' $B/status | grep -q '\"developer\": false'"

curl -s -m 90 -X POST -H "$H" -H 'Content-Type: application/json' -d '{"quiz_id":"ci-test","student":"CI"}' $B/lock >/tmp/lock.json
check "lock accepted" "grep -q '\"locked\"' /tmp/lock.json"
check "hosts has block" "grep -q 'LOCKqz START' /etc/hosts"
for d in chatgpt.com claude.ai gemini.google.com perplexity.ai; do
  check "$d blocked" "dscacheutil -q host -a name $d | grep -q '0.0.0.0'"
done
check "pf anchor loaded" "sudo pfctl -a com.lockqz -sr | grep -q block"
check "Chrome AI policy on" "[ -f '/Library/Managed Preferences/com.google.Chrome.plist' ]"
check "status locked" "curl -s -H '$H' $B/status | grep -q '\"engine_locked\": true'"

curl -s -m 90 -X POST -H "$H" -H 'Content-Type: application/json' -d '{"quiz_id":"ci-test"}' $B/unlock >/tmp/unlock.json
check "unlock accepted" "grep -q '\"unlocked\"' /tmp/unlock.json"
check "hosts clean" "! grep -q 'LOCKqz START' /etc/hosts"
check "chatgpt.com reachable again" "! dscacheutil -q host -a name chatgpt.com | grep -q '0.0.0.0'"
check "Chrome AI policy removed" "[ ! -f '/Library/Managed Preferences/com.google.Chrome.plist' ]"

sleep 3
check "daemon reports reach the server (no 403 in log)" "! grep -q '403' \"$DEST/lockqzd.log\""
check "server reachable with app user agent" "/usr/bin/python3 -c \"import urllib.request,json;r=urllib.request.urlopen(urllib.request.Request('https://lockqz.pages.dev/api/blocklist',headers={'User-Agent':'LOCKqz/0.2.0 (macOS)'}),timeout=10);assert len(json.load(r)['domains'])>=20\""

sudo bash uninstall.sh >/dev/null 2>&1 || sudo bash "$DEST/../LOCKqz/uninstall.sh" >/dev/null 2>&1
check "uninstall removed daemon" "! sudo launchctl print system/com.lockqz.helper"
check "uninstall removed files" "[ ! -d \"$DEST\" ]"
check "hosts clean after uninstall" "! grep -q 'LOCKqz START' /etc/hosts"

echo; [ $FAIL -eq 0 ] && echo "ALL CHECKS PASSED" || { echo "$FAIL CHECK(S) FAILED"; tail -30 "$DEST/lockqzd.log" 2>/dev/null; exit 1; }
