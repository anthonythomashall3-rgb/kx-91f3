#!/bin/bash
# LOCKqz gaps pass (28 Oct 2026): messaging AI bots, warm AI connections, wildcard AI domains, pay
# page after install. Real engine functions against fake dirs/commands. No root, no system changes.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MAC="$HERE/../mac"; WIN="$HERE/../windows"; API="$HERE/../cloudflare/functions/api/[[route]].js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

echo "G1 messaging apps whose AI bots cannot be separated: closed + their web hosts blocked (Mac, Windows, served list)"
for a in WhatsApp Telegram Discord Messenger; do
  check "Mac closes $a" 'grep -A12 "^AI_APPS=" "$MAC/lockqz.sh" | grep -q "\"$a\""'
  check "Windows closes $a" 'grep -A8 "^\$AiApps *=" "$WIN/lockqz.ps1" | grep -qi "\"$a\""'
done
for h in web.whatsapp.com web.telegram.org discord.com messenger.com; do
  check "$h in mac blocklist" 'grep -qx "$h" "$MAC/blocklist.txt"'
  check "$h in windows blocklist" 'grep -qx "$h" "$WIN/blocklist.txt"'
  check "$h in the served AI_DOMAINS" 'grep -q "\"$h\"" "$API"'
done

echo "G2 wildcard AI domains (Mac resolver files): written at lock, removed at unlock, a student's own file untouched, never pages.dev"
RD="$TMP/resolver"; mkdir -p "$RD"; printf 'nameserver 10.0.0.1\n' > "$RD/workers.dev"   # the student's own
( STATE="$TMP/state"; BLOCKLIST="$MAC/blocklist.txt"; PF_ANCHOR=t; RESOLVER_DIR="$RD"; mkdir -p "$STATE"
  source "$MAC/lockqz-core.sh"; source "$MAC/extra-block.sh"
  wild_block_on; echo "rc_on=$?" > "$TMP/g2"
  ls "$RD" | wc -l | tr -d ' ' >> "$TMP/g2"
  cat "$RD/openai.azure.com" >> "$TMP/g2"
  cat "$RD/workers.dev" >> "$TMP/g2"
  wild_block_off; echo "rc_off=$?" >> "$TMP/g2"
  ls "$RD" >> "$TMP/g2"
  printf '%s\n' "${WILD_DOMAINS[@]}" > "$TMP/wild" )
check "lock wrote a resolver file per domain (rc 0)" 'grep -q "^rc_on=0" "$TMP/g2"'
check "every wildcard domain has a file" '[ "$(sed -n 2p "$TMP/g2")" = "$(wc -l < "$TMP/wild" | tr -d " ")" ]'
check "resolver file sends lookups to 127.0.0.1 port 1 (nothing answers: fails at once)" 'grep -q "^nameserver 127.0.0.1" "$TMP/g2" && grep -q "^port 1" "$TMP/g2"'
check "the student's own resolver file is not overwritten" 'grep -q "^nameserver 10.0.0.1" "$TMP/g2"'
check "unlock removed LOCKqz's files (rc 0) and left the student's" 'grep -q "^rc_off=0" "$TMP/g2" && [ "$(ls "$RD")" = "workers.dev" ]'
check "pages.dev (LOCKqz itself) is never a wildcard domain" '! grep -q "pages.dev" "$TMP/wild"'
check "Azure OpenAI, workers.dev, hf.space, modal, vercel, ngrok, trycloudflare, loca.lt are covered" 'for d in openai.azure.com workers.dev hf.space modal.run vercel.app ngrok.io trycloudflare.com loca.lt; do grep -qx "$d" "$TMP/wild" || exit 1; done'
check "Windows NRPT list = the Mac list" 'python3 - "$WIN/lockqz.ps1" "$TMP/wild" <<'"'"'PY'"'"'
import re,sys
s=open(sys.argv[1]).read(); m=re.search(r"\$WildDomains = @\((.*?)\)", s, re.S)
w=set(re.findall(r"\"([^\"]+)\"", m.group(1))); mac=set(open(sys.argv[2]).read().split())
sys.exit(0 if w==mac else 1)
PY'
check "Windows adds one NRPT rule per domain to a dead nameserver and removes only its own" 'grep -q "Add-DnsClientNrptRule -Namespace \".\$d\" -NameServers \"127.0.0.1\" -Comment \$WildTag" "$WIN/lockqz.ps1" && grep -q "Comment -eq \$WildTag } | Remove-DnsClientNrptRule" "$WIN/lockqz.ps1"'
check "Windows lock calls Wild-On + Warm-Apply (first lock and every re-lock), unlock Wild-Off + Warm-Clear" '[ "$(grep -c "Wild-On; Warm-Apply" "$WIN/lockqz.ps1")" = 2 ] && grep -q "Wild-Off; Warm-Clear" "$WIN/lockqz.ps1"'

echo "G3 warm connections (Mac): addresses resolved past the hosts block, private/loopback dropped, pf table loaded, states killed once, refresh in the background"
FB="$TMP/bin"; mkdir -p "$FB"
cat > "$FB/dig" <<'D'
#!/bin/bash
# fake dig: +short A/AAAA for a few names; CNAME noise and junk for the rest
name="${@: -1}"; type="${@: -2:1}"
case "$name" in
  chatgpt.com) [ "$type" = A ] && printf '104.18.32.47\n172.64.155.209\n' || printf '2606:4700:4400::ac40:9bd1\n' ;;
  claude.ai)   [ "$type" = A ] && printf 'cname.example.net.\n160.79.104.10\n' || true ;;
  *) [ "$type" = A ] && printf '127.0.0.1\n10.1.2.3\n0.0.0.0\n' || printf '::1\nfe80::1\n' ;;
esac
D
chmod +x "$FB/dig"
cat > "$FB/pfctl" <<'P'
#!/bin/bash
echo "$*" >> "$PFLOG"
P
chmod +x "$FB/pfctl"
printf 'chatgpt.com\nclaude.ai\nother.example\n' > "$TMP/bl"
( export PATH="$FB:$PATH" PFLOG="$TMP/pflog"; STATE="$TMP/state"; BLOCKLIST="$TMP/bl"; PF_ANCHOR=com.lockqz; mkdir -p "$STATE"
  source "$MAC/lockqz-core.sh"; source "$MAC/extra-block.sh"
  warm_resolve; echo "rc=$?" > "$TMP/g3"; cat "$WARM_IPS" >> "$TMP/g3"
  warm_apply; warm_apply; cp "$PFLOG" "$TMP/pflog1"
  warm_clear; cp "$PFLOG" "$TMP/pflog2" )
check "warm_resolve succeeded" 'grep -q "^rc=0" "$TMP/g3"'
check "public A + AAAA addresses kept" 'grep -q "^104.18.32.47$" "$TMP/g3" && grep -q "^172.64.155.209$" "$TMP/g3" && grep -q "^2606:4700:4400::ac40:9bd1$" "$TMP/g3" && grep -q "^160.79.104.10$" "$TMP/g3"'
check "CNAME noise, loopback, private, 0.0.0.0, link-local dropped" '! grep -qE "cname|^127\.|^10\.|^0\.0\.0\.0|^::1$|^fe80" "$TMP/g3"'
check "table <lq_warm> replaced from the file on every pass (ruleset reloads empty it)" '[ "$(grep -c "^-a com.lockqz -t lq_warm -T replace" "$TMP/pflog1")" = 2 ]'
check "states to each address killed ONCE (not every 5 s)" '[ "$(grep -c "^-k 0.0.0.0/0 -k 104.18.32.47$" "$TMP/pflog1")" = 1 ] && [ "$(grep -c "^-k ::/0 -k 2606:4700:4400::ac40:9bd1$" "$TMP/pflog1")" = 1 ]'
check "unlock flushes the table" 'grep -q "^-a com.lockqz -t lq_warm -T flush" "$TMP/pflog2"'
check "pf conf: table + pass-new-TCP(SYN) + drop untracked TCP + drop QUIC, all quick" 'grep -q "^table <lq_warm> persist" "$MAC/com.lockqz.pf.conf" && grep -q "^pass out quick proto tcp to <lq_warm> flags S/SA keep state" "$MAC/com.lockqz.pf.conf" && grep -q "^block drop out quick proto tcp to <lq_warm>$" "$MAC/com.lockqz.pf.conf" && grep -q "^block drop out quick proto udp to <lq_warm> port 443" "$MAC/com.lockqz.pf.conf"'
check "pass rule comes before the block rules (quick: first match decides)" '[ "$(grep -n "to <lq_warm>" "$MAC/com.lockqz.pf.conf" | head -1 | cut -d: -f2 | cut -c1-4)" = "pass" ]'
check "extra_lock applies both, extra_unlock undoes both" 'grep -A28 "^extra_lock()" "$MAC/extra-block.sh" | grep -q "wild_block_on" && grep -A28 "^extra_lock()" "$MAC/extra-block.sh" | grep -q "warm_apply" && grep -A10 "^extra_unlock()" "$MAC/extra-block.sh" | grep -q "wild_block_off" && grep -A10 "^extra_unlock()" "$MAC/extra-block.sh" | grep -q "warm_clear"'
echo "G3b warm connections (Windows)"
check "resolves past the hosts file (Resolve-DnsName -NoHostsFile)" 'grep -q "Resolve-DnsName -Name \$d -Type \$t -NoHostsFile" "$WIN/lockqz.ps1"'
check "kills established TCP connections with SetTcpEntry (DELETE_TCB = 12), ports in network order" 'grep -q "SetTcpEntry(ref MIB_TCPROW row)" "$WIN/lockqz.ps1" && grep -q "dwState = 12" "$WIN/lockqz.ps1" && grep -q "band 0xff) -shl 8" "$WIN/lockqz.ps1"'
check "QUIC to those addresses blocked (UDP 443), rule removed with the other LOCKqz rules at unlock" 'grep -q "\$FwTag-warm-quic\" -Direction Outbound -Action Block -Protocol UDP -RemotePort 443 -RemoteAddress \$ips" "$WIN/lockqz.ps1" && grep -q "Get-NetFirewallRule -DisplayName \"\$FwTag-\*\"" "$WIN/lockqz.ps1"'
check "refresh runs detached (lockqz.ps1 warm) at most every 12 h" 'grep -q "\$WarmMaxAge = 43200" "$WIN/lockqz.ps1" && grep -q "\"warm\"   { try { Warm-Resolve }" "$WIN/lockqz.ps1" && grep -q "ValidateSet(\"lock\",\"unlock\",\"status\",\"warm\")" "$WIN/lockqz.ps1"'

echo "G4 installers end on the pay page (the page itself says 'nothing to pay' when no fee is on)"
check "Mac install.sh opens /pay as the console user" 'grep -q "sudo -u \"\$CONSOLE_USER\" open \"\$SITE/pay\"" "$MAC/install.sh"'
check "Mac .pkg postinstall opens /pay" 'grep -q "open \"https://lockqz.pages.dev/pay\"" "$MAC/make-pkg.sh"'
check "Windows install.ps1 opens /pay through explorer.exe (not a child of the installer), skipped under LOCKQZ_NO_BROWSER" 'grep -q "Start-Process \"explorer.exe\" -ArgumentList \"\$Site/pay\"" "$WIN/install.ps1" && grep -q "LOCKQZ_NO_BROWSER" "$WIN/install.ps1" && grep -q "LOCKQZ_NO_BROWSER" "$HERE/test_windows_install.ps1"'
check "never as root/loginwindow" 'grep -q "\"\"|root|loginwindow|_\*) ;;" "$MAC/install.sh"'

echo ""; echo "RESULT: $PASS passed, $FAIL failed"; [ "$FAIL" = 0 ]
