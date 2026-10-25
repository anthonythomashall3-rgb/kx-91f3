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

echo "T11 round-2 blocklist in the hosts block: every line valid, path entries and notes hosts never in it"
BLOCK="$(build_block_from "$BL")"
check "homework AI blackholed (gauthmath.com, chegg.com)" 'echo "$BLOCK" | grep -qx "0.0.0.0 gauthmath.com" && echo "$BLOCK" | grep -qx "0.0.0.0 chegg.com"'
check "coding AI API blackholed (api2.cursor.sh, api.githubcopilot.com)" 'echo "$BLOCK" | grep -qx "0.0.0.0 api2.cursor.sh" && echo "$BLOCK" | grep -qx ":: api.githubcopilot.com"'
check "every block line is '0.0.0.0|:: <host>' (no path entry, no junk)" '! echo "$BLOCK" | grep -vxF "$MARK_START" | grep -vxF "$MARK_END" | grep -vqE "^(0\.0\.0\.0|::) [a-z0-9-]+(\.[a-z0-9-]+)+$"'
check "Microsoft 365 home (m365.cloud.microsoft) NOT blocked" '! echo "$BLOCK" | grep -qE " (www\.)?m365\.cloud\.microsoft$"'
check "notes hosts never blocked (docs.google.com, quizlet.com, studocu.com, knowunity.com)" '! echo "$BLOCK" | grep -qE " (www\.)?(docs\.google\.com|quizlet\.com|studocu\.com|knowunity\.com)$"'

echo "T12 proxies: forced off for the quiz, but KEPT when the network only works through its proxy"
PX="$TMP/px"; mkdir -p "$PX"
run_px() {   # run_px <direct internet ok: 0|1>  -> leaves $PX/log, $PX/kept
  rm -f "$PX"/*
  ( DRYRUN=0; STATE="$PX"; LOCKQZ_PROXY_KEPT="$PX/proxy.kept"; LOCKQZ_AI_MDM="$PX/aa.plist"; export LOCKQZ_PROXY_KEPT LOCKQZ_AI_MDM
    source "$HERE/../mac/extra-block.sh"
    scutil() { echo "  HTTPEnable : 1"; }
    networksetup() {
      case "$1" in
        -listallnetworkservices) printf 'An asterisk (*) denotes that a network service is disabled.\nWi-Fi\n' ;;
        -getwebproxy) [ -f "$PX/off" ] && echo "Enabled: No" || echo "Enabled: Yes" ;;
        -setwebproxystate) echo "$*" >> "$PX/log"; [ "$3" = off ] && : > "$PX/off"; [ "$3" = on ] && rm -f "$PX/off" ;;
        *) echo "Enabled: No" ;;
      esac; }
    curl() { [ "$DIRECT" = 1 ]; }
    DIRECT="$1"; proxies_off; proxies_off; [ -f "$LOCKQZ_PROXY_KEPT" ] && echo kept > "$PX/kept.txt"
    [ -f "$PX/off" ] && echo off > "$PX/state.txt"
    extra_unlock >/dev/null 2>&1 || true; [ -f "$LOCKQZ_PROXY_KEPT" ] && echo leftover >> "$PX/kept.txt"
  ) >/dev/null 2>&1
}
run_px 1
check "direct internet works -> proxy switched off for the quiz, not kept" '[ -f "$PX/state.txt" ] && [ ! -f "$PX/kept.txt" ]'
run_px 0
check "network needs its proxy -> proxy put back + proxy.kept for the browsers" 'grep -q "Wi-Fi on" "$PX/log" && grep -qx kept "$PX/kept.txt" && [ ! -f "$PX/state.txt" ]'
check "... and unlock clears proxy.kept" '! grep -q leftover "$PX/kept.txt"'

echo "T13 kill lists: Tor + VM tools on the Mac, MacWhisper no longer closed"
( source "$HERE/../mac/extra-block.sh"; printf '%s\n' "${VPN_APPS[@]}" "${VM_APPS[@]}" "${LOCAL_MODEL_PROCS[@]}" ) > "$TMP/kl"
check "Tor Browser + tor closed" 'grep -qx "Tor Browser" "$TMP/kl" && grep -qx "tor" "$TMP/kl"'
check "OrbStack / colima / limactl closed" 'grep -qx OrbStack "$TMP/kl" && grep -qx colima "$TMP/kl" && grep -qx limactl "$TMP/kl"'
check "llama-cli / llama-run / local-ai closed" 'grep -qx llama-cli "$TMP/kl" && grep -qx llama-run "$TMP/kl" && grep -qx local-ai "$TMP/kl"'
check "Outline only closed when it is the VPN (not in the plain kill list)" '! grep -qx Outline "$TMP/kl"'
check "MacWhisper not on the AI app list" '! sed -n "/^AI_APPS=(/,/)\$/p" "$HERE/../mac/lockqz.sh" | grep -q MacWhisper'
( source "$HERE/../mac/extra-block.sh"; for r in "${LOCAL_MODEL_CMD_RES[@]}"; do printf '%s\n' "$r"; done ) > "$TMP/cr"
check "python-run model tools matched by command line" 'echo "/opt/homebrew/bin/python3 /opt/homebrew/bin/mlx_lm.chat --model x" | grep -qEf "$TMP/cr" && echo "python3 -m vllm.entrypoints.openai.api_server" | grep -qEf "$TMP/cr"'
check "... but not an unrelated python program" '! echo "python3 /Users/s/notes/mlx_notes.py" | grep -qEf "$TMP/cr"'

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
