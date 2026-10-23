#!/bin/bash
# LOCKqz edge-case hardening tests — the real-world situations that break exam tools.
# Runs the real core against fake hosts files. No root, no network, no system changes.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../mac/lockqz-core.sh"
BL="$HERE/../mac/blocklist.txt"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ok: $1"; }
bad(){ FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
chk(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

echo "E1 power-loss simulation: block left in hosts, then a fresh unlock cleans it"
H="$TMP/h1"; printf '127.0.0.1\tlocalhost\n' > "$H"; ORIG="$(cat "$H")"
hosts_add_block "$H" "$BL"          # quiz locked
# simulate crash: process dies here, block still in file. Next boot runs unlock (fail-safe).
hosts_remove_block "$H"
chk "hosts clean after crash+unlock" '[ "$ORIG" = "$(cat "$H")" ]'

echo "E2 messy blocklist (dupes, CRLF, spaces, blank lines, comments) -> clean block"
MBL="$TMP/messy.txt"
printf 'chatgpt.com\r\n chatgpt.com \n\n#comment\n  claude.ai  \nCLAUDE.AI\n' > "$MBL"
B="$(build_block_from "$MBL")"
chk "chatgpt present once-ish" 'echo "$B" | grep -q "0.0.0.0 chatgpt.com"'
chk "claude present" 'echo "$B" | grep -q "0.0.0.0 claude.ai"'
chk "no stray spaces in output" '! echo "$B" | grep -qE "0.0.0.0 .* "'
chk "no blank domain lines" '! echo "$B" | grep -qE "^0.0.0.0 $"'

echo "E3 student has a rich custom hosts file -> every custom line preserved"
H="$TMP/h3"
printf '127.0.0.1\tlocalhost\n10.0.0.2 devbox\n0.0.0.0 ads.example.com\n192.168.1.1 printer\n::1 localhost\n' > "$H"
ORIG="$(cat "$H")"
hosts_add_block "$H" "$BL"; hosts_remove_block "$H"
chk "devbox kept" 'grep -q "devbox" "$H"'
chk "their ad-block kept" 'grep -q "ads.example.com" "$H"'
chk "printer kept" 'grep -q "printer" "$H"'
chk "restored byte-for-byte" '[ "$ORIG" = "$(cat "$H")" ]'

echo "E4 100 lock/unlock cycles (two-quiz day, retries) -> zero drift"
H="$TMP/h4"; printf '127.0.0.1\tlocalhost\n' > "$H"; ORIG="$(cat "$H")"
for i in $(seq 1 100); do hosts_add_block "$H" "$BL"; hosts_remove_block "$H"; done
chk "no drift after 100 cycles" '[ "$ORIG" = "$(cat "$H")" ]'

echo "E5 lock called twice without unlock -> still exactly one block (no duplication)"
H="$TMP/h5"; printf '127.0.0.1\tlocalhost\n' > "$H"
hosts_add_block "$H" "$BL"; hosts_add_block "$H" "$BL"; hosts_add_block "$H" "$BL"
N=$(grep -c "LOCKqz START" "$H")
chk "exactly one block after triple-lock" "[ \"$N\" -eq 1 ]"
hosts_remove_block "$H"
chk "single unlock fully clears triple-lock" '! grep -q "LOCKqz" "$H"'

echo "E6 unlock on a file that was never locked -> no error, unchanged"
H="$TMP/h6"; printf 'nothing special\n' > "$H"; ORIG="$(cat "$H")"
hosts_remove_block "$H"
chk "untouched" '[ "$ORIG" = "$(cat "$H")" ]'

echo "E7 empty hosts file -> lock then unlock leaves it empty-clean"
H="$TMP/h7"; : > "$H"
hosts_add_block "$H" "$BL"; chk "locked on empty file" 'hosts_is_locked "$H"'
hosts_remove_block "$H"; chk "no LOCKqz residue" '! grep -q "LOCKqz" "$H"'

echo "E8 block contains the three biggest AIs every single time"
B="$(build_block_from "$BL")"
chk "chatgpt" 'echo "$B" | grep -q "0.0.0.0 chatgpt.com"'
chk "claude"  'echo "$B" | grep -q "0.0.0.0 claude.ai"'
chk "gemini"  'echo "$B" | grep -q "0.0.0.0 gemini.google.com"'

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
