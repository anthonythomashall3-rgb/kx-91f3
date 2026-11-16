#!/bin/bash
# After the engine restarts the preferences service (the last step of a lock), macOS answers a settings read only
# when the service is back, up to 10 s later. The first repeat pass of a quiz comes 5 s after the lock: it must
# not wait for that answer just to look at the AirPlay Receiver switch it set a moment ago (0.6.29).
HERE="$(cd "$(dirname "$0")" && pwd)"; APP="$HERE/.."
PASS=0; FAIL=0
check() { if eval "$2"; then PASS=$((PASS+1)); echo "  ok: $1"; else FAIL=$((FAIL+1)); echo "  FAIL: $1"; fi; }
TMP="$(mktemp -d)"; mkdir -p "$TMP/state"
run() { ( DRYRUN=0; STATE="$TMP/state"; LOCKQZ_AIRPLAY_STATE="$TMP/state/airplay.state"; export LOCKQZ_PREFS_DIRTY="$TMP/state/prefs.dirty"
  source "$APP/mac/extra-block.sh"
  killall() { echo "killall $*" >> "$TMP/log"; }
  _cc_user() { echo stu; }; _cc_exists() { return 0; }
  _cc_get() { echo "read" >> "$TMP/log"; cat "$TMP/val" 2>/dev/null || echo absent; }
  _cc_set() { echo "set $2" >> "$TMP/log"; echo "$2" > "$TMP/val"; }
  _cc_restart() { echo "restart" >> "$TMP/log"; }
  "$@" ); }
n() { grep -c "^$1" "$TMP/log" 2>/dev/null || true; }
echo "S1 first pass of a quiz: the switch is read, saved, turned off"
echo 1 > "$TMP/val"; : > "$TMP/log"
run airplay_receiver_off
check "read once, set off, saved as it was (1)" '[ "$(n read)" = 1 ] && [ "$(cat "$TMP/val")" = 0 ] && grep -qx "stu|1" "$TMP/state/airplay.state"'
echo "S2 the engine's last step restarts the preferences service"
run prefs_changed; run prefs_flush
check "restarted once, the time is kept" '[ "$(n "killall cfprefsd")" = 1 ] && [ -f "$TMP/state/prefs.dirty.flushed" ]'
echo "S3 a pass in the next seconds does not ask the service"
: > "$TMP/log"; run airplay_receiver_off; rc=$?
check "no read, no write, success" '[ "$rc" = 0 ] && [ "$(n read)" = 0 ] && [ "$(n set)" = 0 ]'
echo "S4 12 s later the look is back, and a switch turned on again goes off again"
touch -t "$(date -d '-20 seconds' +%Y%m%d%H%M.%S 2>/dev/null || date -v-20S +%Y%m%d%H%M.%S)" "$TMP/state/prefs.dirty.flushed"
echo 1 > "$TMP/val"; : > "$TMP/log"; run airplay_receiver_off
check "read again, set off again, the saved value untouched" '[ "$(n read)" = 1 ] && [ "$(cat "$TMP/val")" = 0 ] && [ "$(grep -c "^stu|" "$TMP/state/airplay.state")" = 1 ] && grep -qx "stu|1" "$TMP/state/airplay.state"'
echo "S5 another user at the screen is never skipped (nothing recorded for them yet)"
: > "$TMP/state/prefs.dirty.flushed"; : > "$TMP/log"
( DRYRUN=0; STATE="$TMP/state"; LOCKQZ_AIRPLAY_STATE="$TMP/state/airplay.state"; export LOCKQZ_PREFS_DIRTY="$TMP/state/prefs.dirty"; source "$APP/mac/extra-block.sh"
  _cc_user() { echo other; }; _cc_exists() { return 0; }; _cc_get() { echo read >> "$TMP/log"; echo 1; }; _cc_set() { echo "set $2" >> "$TMP/log"; }; _cc_restart() { :; }
  airplay_receiver_off )
check "read and set for the new user" '[ "$(n read)" = 1 ] && [ "$(n set)" = 1 ] && grep -q "^other|1" "$TMP/state/airplay.state"'
echo "S6 outside the engine (no flag file named) nothing is skipped"
: > "$TMP/log"
( DRYRUN=0; STATE="$TMP/state"; LOCKQZ_AIRPLAY_STATE="$TMP/state/airplay.state"; unset LOCKQZ_PREFS_DIRTY; source "$APP/mac/extra-block.sh"
  _cc_user() { echo stu; }; _cc_exists() { return 0; }; _cc_get() { echo read >> "$TMP/log"; echo 0; }; _cc_set() { :; }; _cc_restart() { :; }
  airplay_receiver_off )
check "read" '[ "$(n read)" = 1 ]'
echo "S7 the engine prints its steps only when asked"
check "lap is silent without LOCKQZ_TIMING and extra-block works without it" '( source "$APP/mac/extra-block.sh"; [ -z "$(xb_lap x 2>&1)" ] )'
rm -rf "$TMP"
echo; echo "RESULT: $PASS passed, $FAIL failed"; [ "$FAIL" = 0 ]
