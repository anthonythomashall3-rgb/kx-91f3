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
# Here-strings, not `echo "$BLOCK" | grep -q`: the block is > 64 KB, so grep -q closing the pipe early
# makes echo die of SIGPIPE and pipefail turns a match into a failure (flaked on CI at 437+ hosts).
check "homework AI blackholed (gauthmath.com, chegg.com)" 'grep -qx "0.0.0.0 gauthmath.com" <<<"$BLOCK" && grep -qx "0.0.0.0 chegg.com" <<<"$BLOCK"'
check "coding AI API blackholed (api2.cursor.sh, api.githubcopilot.com)" 'grep -qx "0.0.0.0 api2.cursor.sh" <<<"$BLOCK" && grep -qx ":: api.githubcopilot.com" <<<"$BLOCK"'
check "every block line is '0.0.0.0|:: <host>' (no path entry, no junk)" '[ "$(grep -vxF "$MARK_START" <<<"$BLOCK" | grep -vxF "$MARK_END" | grep -cvE "^(0\.0\.0\.0|::) [a-z0-9-]+(\.[a-z0-9-]+)+$")" = 0 ]'
check "Microsoft 365 home (m365.cloud.microsoft) NOT blocked" '! grep -qE " (www\.)?m365\.cloud\.microsoft$" <<<"$BLOCK"'
check "notes hosts never blocked (docs.google.com, studocu.com, knowunity.com)" '! grep -qE " (www\.)?(docs\.google\.com|studocu\.com|knowunity\.com)$" <<<"$BLOCK"'

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

echo "T14 28 Oct: AirPlay Receiver off during the quiz (a mirrored phone), put back exactly at unlock"
AP="$TMP/ap"; mkdir -p "$AP"
run_ap() {   # run_ap <value before: 1|0|absent> [console user]  -> $AP/out: one line per step
  rm -rf "$AP"/*; mkdir -p "$AP/v"
  [ "$1" = absent ] || echo "$1" > "$AP/v/stu"
  echo "${2:-stu}" > "$AP/user"
  ( DRYRUN=0; STATE="$AP"; LOCKQZ_AIRPLAY_STATE="$AP/airplay.state"; LOCKQZ_AI_MDM="$AP/aa.plist"; LOCKQZ_AI_BACKUP="$AP/aa.bak"
    export LOCKQZ_AIRPLAY_STATE LOCKQZ_AI_MDM LOCKQZ_AI_BACKUP
    source "$HERE/../mac/extra-block.sh"
    pkill(){ :; }; killall(){ :; }   # never signal real processes from a test
    _cc_user() { cat "$AP/user"; }
    _cc_exists() { :; }
    _cc_get() { if [ -f "$AP/v/$1" ]; then cat "$AP/v/$1"; else echo absent; fi; }
    _cc_set() { if [ "$2" = absent ]; then rm -f "$AP/v/$1"; else echo "$2" > "$AP/v/$1"; fi; }
    _cc_restart() { echo "$1" >> "$AP/restarts"; }
    val() { if [ -f "$AP/v/stu" ]; then cat "$AP/v/stu"; else echo absent; fi; }
    n() { [ -f "$AP/restarts" ] && wc -l < "$AP/restarts" | tr -d ' ' || echo 0; }
    airplay_receiver_off; echo "lock rc=$? val=$(val) restarts=$(n)" >> "$AP/out"
    airplay_receiver_off; echo "relock val=$(val) restarts=$(n) saved=$(cat "$AP/airplay.state" 2>/dev/null | tr '\n' ' ')" >> "$AP/out"
    [ -f "$AP/v/stu" ] && [ "$(cat "$AP/v/stu")" = 0 ] && { echo 1 > "$AP/v/stu"; airplay_receiver_off; echo "switched-back-on val=$(val) saved=$(cat "$AP/airplay.state" | tr '\n' ' ')" >> "$AP/out"; }
    apple_intelligence_off >/dev/null 2>&1
    python3 -c "import plistlib,sys;d=plistlib.load(open('$AP/aa.plist','rb'));sys.exit(0 if d.get('allowAirPlayIncomingRequests') is False else 1)" 2>/dev/null && echo "restriction=off" >> "$AP/out"
    extra_unlock >/dev/null 2>&1; echo "unlock rc=$? val=$(val) state=$([ -e "$AP/airplay.state" ] && echo left || echo gone) aa=$([ -e "$AP/aa.plist" ] && echo left || echo gone)" >> "$AP/out"
  ) >/dev/null 2>&1
}
run_ap absent; O="$(cat "$AP/out")"
check "never set before: switched off at lock, ControlCenter restarted once" 'grep -qx "lock rc=0 val=0 restarts=1" <<<"$O"'
check "re-lock every few seconds: no second restart, the pre-quiz value is never overwritten" 'grep -qx "relock val=0 restarts=1 saved=stu|absent " <<<"$O"'
check "switched back on mid-quiz -> off again, saved value still the original" 'grep -qx "switched-back-on val=0 saved=stu|absent " <<<"$O"'
check "managed restriction allowAirPlayIncomingRequests=false with Apple Intelligence" 'grep -qx "restriction=off" <<<"$O"'
check "unlock: setting removed again (never set before), state + restriction file gone" 'grep -qx "unlock rc=0 val=absent state=gone aa=gone" <<<"$O"'
run_ap 1; O="$(cat "$AP/out")"
check "was ON -> off during the quiz -> ON again after" 'grep -qx "lock rc=0 val=0 restarts=1" <<<"$O" && grep -qx "unlock rc=0 val=1 state=gone aa=gone" <<<"$O"'
run_ap 0; O="$(cat "$AP/out")"
check "was already OFF -> left alone (no restart), still OFF after" 'grep -qx "lock rc=0 val=0 restarts=0" <<<"$O" && grep -qx "unlock rc=0 val=0 state=gone aa=gone" <<<"$O"'
run_ap 1 loginwindow; O="$(cat "$AP/out")"
check "nobody at the screen (login window): nothing changed, nothing saved" 'grep -qx "lock rc=0 val=1 restarts=0" <<<"$O" && grep -qx "unlock rc=0 val=1 state=gone aa=gone" <<<"$O"'
( DRYRUN=1; STATE="$AP"; LOCKQZ_AIRPLAY_STATE="$AP/dry.state"; export LOCKQZ_AIRPLAY_STATE
  source "$HERE/../mac/extra-block.sh"; _cc_user() { echo stu; }; _cc_set() { echo SET >> "$AP/dry.set"; }
  airplay_receiver_off ) > "$AP/dry.out" 2>&1
check "dry-run only previews (no write, no state)" 'grep -q "would turn AirPlay Receiver off" "$AP/dry.out" && [ ! -e "$AP/dry.set" ] && [ ! -e "$AP/dry.state" ]'

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
