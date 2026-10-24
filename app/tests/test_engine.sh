#!/bin/bash
# LOCKqz engine tests — run the real block/unblock logic against a FAKE hosts file.
# No root, no system changes. Exits non-zero on any failure.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CORE="$HERE/../mac/lockqz-core.sh"
BL="$HERE/../mac/blocklist.txt"
source "$CORE"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

ORIG="$TMP/hosts"
printf '127.0.0.1\tlocalhost\n255.255.255.255\tbroadcasthost\n::1\tlocalhost\n' > "$ORIG"
BEFORE="$(cat "$ORIG")"

echo "T1 clean hosts starts unlocked"
check "not locked initially" '! hosts_is_locked "$ORIG"'

echo "T2 lock adds the block"
hosts_add_block "$ORIG" "$BL"
check "locked after add" 'hosts_is_locked "$ORIG"'
check "chatgpt blackholed" 'grep -q "0.0.0.0 chatgpt.com" "$ORIG"'
check "claude.ai blackholed" 'grep -q "0.0.0.0 claude.ai" "$ORIG"'
check "IPv6 blackholed too" 'grep -q ":: chatgpt.com" "$ORIG"'
check "anthropic.com blackholed" 'grep -q "0.0.0.0 anthropic.com" "$ORIG"'
check "gemini blackholed" 'grep -q "0.0.0.0 gemini.google.com" "$ORIG"'
check "copilot blackholed" 'grep -q "0.0.0.0 copilot.microsoft.com" "$ORIG"'
check "original localhost line intact" 'grep -q "127.0.0.1" "$ORIG"'

echo "T3 double-lock is idempotent (no second block)"
hosts_add_block "$ORIG" "$BL"
N=$(grep -c "LOCKqz START" "$ORIG")
check "exactly one block marker" "[ \"$N\" -eq 1 ]"

echo "T4 unlock removes the block exactly"
hosts_remove_block "$ORIG"
check "not locked after remove" '! hosts_is_locked "$ORIG"'
check "no chatgpt line remains" '! grep -q "chatgpt.com" "$ORIG"'
check "no LOCKqz marker remains" '! grep -q "LOCKqz" "$ORIG"'

echo "T5 hosts restored byte-for-byte to original"
AFTER="$(cat "$ORIG")"
check "hosts identical to before" '[ "$BEFORE" = "$AFTER" ]'

echo "T6 double-unlock is safe (no error, no change)"
hosts_remove_block "$ORIG"
check "still unlocked, still intact" '[ "$BEFORE" = "$(cat "$ORIG")" ]'

echo "T7 lock/unlock survives 25 rapid cycles without drift"
for i in $(seq 1 25); do hosts_add_block "$ORIG" "$BL"; hosts_remove_block "$ORIG"; done
check "no drift after 25 cycles" '[ "$BEFORE" = "$(cat "$ORIG")" ]'

echo "T8 www. variants generated for bare domains, not for www.* ones"
BLOCK="$(build_block_from "$BL")"
check "www.chatgpt.com present" 'echo "$BLOCK" | grep -q "0.0.0.0 www.chatgpt.com"'
check "no www.www. doubling" '! echo "$BLOCK" | grep -q "www.www."'

echo "T9 comments and blanks in blocklist are ignored"
TBL="$TMP/bl.txt"; printf '# comment\n\n  \nexample-ai.com\n' > "$TBL"
D="$(domains_from "$TBL")"
check "only the real domain parsed" '[ "$D" = "example-ai.com" ]'

echo "T10 a hosts file with other content keeps that content"
printf '10.0.0.5 myserver.local\n192.168.1.1 router\n' > "$TMP/h2"
hosts_add_block "$TMP/h2" "$BL"; hosts_remove_block "$TMP/h2"
check "custom entries preserved" 'grep -q "myserver.local" "$TMP/h2" && grep -q "router" "$TMP/h2"'

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
