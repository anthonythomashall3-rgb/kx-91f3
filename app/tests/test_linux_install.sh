#!/bin/bash
# Real-machine test of the Linux installer (GitHub ubuntu runner; passwordless sudo). Installs from the
# source checkout, then checks: helper up, token check, LOCK (hosts, DNS, nftables, Chrome + Firefox
# policies, warm list resolving), status, no developer mode, UNLOCK (everything restored), the agent's
# Chromium tab reading on a real Chromium session, and UNINSTALL. Exits 1 on any failure.
cd "$(dirname "$0")/../linux" || exit 1
FAIL=0
check() { if eval "$2" >/dev/null 2>&1; then echo "PASS  $1"; else echo "FAIL  $1"; FAIL=$((FAIL+1)); fi; }
DEST=/usr/local/lib/lockqz; STATE=/var/lib/lockqz
export LOCKQZ_NO_BROWSER=1
sudo -E bash install.sh --api https://lockqz.pages.dev/api > /tmp/install.log 2>&1
check "installer succeeded" "grep -q 'Installed. Device id: linux-' /tmp/install.log"
for f in lockqz.sh lockqz-core.sh lockqzd.py lockqz-agent.py agent-mac.py browser-policy.py policy-mac.py blocklist.txt config.json update.pub uninstall.sh; do
  check "installed $f" "[ -f $DEST/$f ]"
done
check "no control token in the world-readable config" "! grep -q '\"token\"' $DEST/config.json"
check "control token is root-only (600)" "[ \"\$(sudo stat -c %a $STATE/helper.token)\" = 600 ]"
check "install folder is root's, 755" "[ \"\$(stat -c %U:%a $DEST)\" = root:755 ]"
check "helper service enabled" "systemctl is-enabled lockqzd.service"
check "agent user unit enabled globally" "[ -L /etc/systemd/user/default.target.wants/lockqz-agent.service ]"
TOK="$(sudo cat $STATE/helper.token)"
H="X-LOCKqz-Token: $TOK"; B=http://127.0.0.1:8787
for i in $(seq 1 30); do curl -sf -m 2 -H "$H" $B/status >/dev/null && break; sleep 2; done
check "helper answering" "curl -sf -m 3 -H '$H' $B/status"
check "rejects wrong token" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'X-LOCKqz-Token: nope' $B/status)\" = 401 ]"
check "browser-origin request refused (no CORS)" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -H '$H' -H 'Origin: https://evil.example' $B/status)\" = 401 ]"
check "no developer mode on a student machine" "curl -s -H '$H' $B/status | grep -q '\"developer\": false'"

curl -s -m 90 -X POST -H "$H" -H 'Content-Type: application/json' -d '{"quiz_id":"ci-test","student":"CI"}' $B/lock > /tmp/lock.json
check "lock accepted" "grep -q '\"locked\"' /tmp/lock.json"
check "hosts has block" "grep -q 'LOCKqz START' /etc/hosts"
for d in chatgpt.com claude.ai gemini.google.com perplexity.ai web.whatsapp.com; do
  check "$d blocked (resolves to 0.0.0.0)" "getent ahosts $d | grep -q '^0.0.0.0'"
done
check "nftables table loaded (DoT, DoH, model ports, VPN, QUIC-to-AI sets)" "sudo nft list table inet lockqz | grep -q 'dport 853'"
check "Chrome AI policy on" "python3 -c \"import json;d=json.load(open('/etc/opt/chrome/policies/managed/zz-lockqz.json'));assert d['GenAiDefaultSettings']==2 and d['GeminiSettings']==1 and 'chatgpt.com' in d['URLBlocklist']\""
check "Firefox AI policy on" "python3 -c \"import json;d=json.load(open('/etc/firefox/policies/policies.json'))['policies'];assert d['LOCKqzManaged'] and d['DNSOverHTTPS']['Enabled'] is False\""
check "status locked" "curl -s -H '$H' $B/status | grep -q '\"engine_locked\": true'"
for i in $(seq 1 20); do [ -s $STATE/warm_ips ] && break; sleep 3; done
check "warm-connection list resolved past the hosts block (AI addresses, not 0.0.0.0)" "[ -s $STATE/warm_ips ] && ! grep -q '^0.0.0.0' $STATE/warm_ips && [ \"\$(wc -l < $STATE/warm_ips)\" -ge 50 ]"
curl -s -m 30 -X POST -H "$H" -H 'Content-Type: application/json' -d '{"quiz_id":"ci-test"}' $B/lock > /tmp/relock.json   # the 5-second re-lock pass
check "re-lock pass loads the AI addresses into the QUIC set" "sudo nft list set inet lockqz lq_warm4 | grep -qE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+'"

curl -s -m 90 -X POST -H "$H" -H 'Content-Type: application/json' -d '{"quiz_id":"ci-test"}' $B/unlock > /tmp/unlock.json
check "unlock accepted" "grep -q '\"unlocked\"' /tmp/unlock.json"
check "hosts clean" "! grep -q 'LOCKqz START' /etc/hosts"
check "chatgpt.com resolvable again" "! getent ahosts chatgpt.com | grep -q '^0.0.0.0'"
check "nftables table gone" "! sudo nft list table inet lockqz"
check "Chrome policy removed" "[ ! -f /etc/opt/chrome/policies/managed/zz-lockqz.json ]"
check "Firefox policy removed" "[ ! -f /etc/firefox/policies/policies.json ] || ! grep -q LOCKqzManaged /etc/firefox/policies/policies.json"

echo "-- agent: Chromium tab reading on a real Chromium session"
if node -e "require('playwright')" 2>/dev/null; then
  P=/tmp/lq-chromeprof; rm -rf $P
  node - <<'EOF' > /tmp/snss.out 2>&1
const {chromium}=require('playwright');const {spawn,execSync}=require('child_process');
(async()=>{const ch=spawn(chromium.executablePath(),['--headless=new','--no-sandbox','--user-data-dir=/tmp/lq-chromeprof','--remote-debugging-port=9333','--no-first-run','about:blank'],{stdio:'ignore'});
await new Promise(r=>setTimeout(r,3000));const b=await chromium.connectOverCDP('http://127.0.0.1:9333');const ctx=b.contexts()[0];
const p=await ctx.newPage();await p.goto('https://example.com/');await p.waitForTimeout(4000);
const py="import importlib.util,sys;sys.argv=['x'];s=importlib.util.spec_from_file_location('la','/usr/local/lib/lockqz/lockqz-agent.py');la=importlib.util.module_from_spec(s);s.loader.exec_module(la);f=la.chromium_session_file('/tmp/lq-chromeprof');print(la.snss_urls(open(f[1],'rb').read()))";
console.log('OPEN '+execSync('python3 -c "'+py+'"').toString().trim());
await p.close();await new Promise(r=>setTimeout(r,4000));
console.log('CLOSED '+execSync('python3 -c "'+py+'"').toString().trim());ch.kill();})().catch(e=>{console.log('ERR '+e);process.exit(1)});
EOF
  check "open Chromium tab seen" "grep -q \"OPEN .*example.com\" /tmp/snss.out"
  check "closed Chromium tab gone" "grep '^CLOSED' /tmp/snss.out | grep -vq example.com"
else
  echo "SKIP  Chromium tab reading (no playwright here)"
fi
check "agent imports the shared Mac logic and swaps the desktop pieces" "LOCKQZ_TOKEN_DIR=/tmp python3 -c \"import importlib.util,sys;sys.argv=['x'];s=importlib.util.spec_from_file_location('la','$DEST/lockqz-agent.py');la=importlib.util.module_from_spec(s);s.loader.exec_module(la);assert la.M.MacUI is la.LinuxUI and la.M.browser_tabs is la.browser_tabs and la.M.USER_DIR.endswith('.config/lockqz')\""

sudo bash uninstall.sh > /dev/null 2>&1
check "uninstall removed the helper service" "! systemctl is-enabled lockqzd.service"
check "uninstall removed files" "[ ! -d $DEST ] && [ ! -d $STATE ]"
check "hosts clean after uninstall" "! grep -q 'LOCKqz START' /etc/hosts"
echo; [ $FAIL -eq 0 ] && echo "ALL CHECKS PASSED" || { echo "$FAIL CHECK(S) FAILED"; sudo journalctl -u lockqzd --no-pager | tail -30; exit 1; }
