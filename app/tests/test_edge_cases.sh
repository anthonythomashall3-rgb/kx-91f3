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
chk "chatgpt present once-ish" 'grep -q "0.0.0.0 chatgpt.com" <<<"$B"'
chk "claude present" 'grep -q "0.0.0.0 claude.ai" <<<"$B"'
chk "no stray spaces in output" '! grep -qE "0.0.0.0 .* " <<<"$B"'
chk "no blank domain lines" '! grep -qE "^0.0.0.0 $" <<<"$B"'

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
chk "chatgpt" 'grep -q "0.0.0.0 chatgpt.com" <<<"$B"'
chk "claude"  'grep -q "0.0.0.0 claude.ai" <<<"$B"'
chk "gemini"  'grep -q "0.0.0.0 gemini.google.com" <<<"$B"'
chk "IPv6 too (AAAA lookups blocked)" 'grep -q "^:: chatgpt.com$" <<<"$B"'

echo "E9 closing AI apps matches ONLY that app (never a substring of some other process)"
chk "Dia app matched"          'echo "/Applications/Dia.app/Contents/MacOS/Dia" | grep -qiE "$(app_re Dia)"'
chk "mediaremoted NOT matched" '! echo "/usr/libexec/mediaremoted" | grep -qiE "$(app_re Dia)"'
chk "browser helper with Media flags NOT matched" '! echo "/Applications/Google Chrome.app/Contents/Frameworks/x/Google Chrome Helper --enable-features=MediaFoundation,Dia" | grep -qiE "$(app_re Dia)"'
chk "app with a space matched" 'echo "/Applications/LM Studio.app/Contents/MacOS/LM Studio" | grep -qiE "$(app_re "LM Studio")"'
chk "Opera does not hit CoreOperations" '! echo "/System/Library/CoreServices/CoreOperations.app/x" | grep -qiE "$(app_re Opera)"'


echo "E10 Apple Intelligence: an existing (MDM) applicationaccess plist is restored byte-for-byte, never deleted"
X="$TMP/x"; mkdir -p "$X"
( DRYRUN=0; STATE="$X"; LOCKQZ_AI_MDM="$X/com.apple.applicationaccess.plist"; LOCKQZ_AI_BACKUP="$X/ai.backup.plist"
  export LOCKQZ_AI_MDM LOCKQZ_AI_BACKUP
  source "$HERE/../mac/extra-block.sh"
  pkill(){ :; }; killall(){ :; }   # never signal real processes from a test
  python3 -c "import plistlib;plistlib.dump({'allowCamera':False,'forceSchoolSetting':True},open('$X/com.apple.applicationaccess.plist','wb'))"
  cp "$X/com.apple.applicationaccess.plist" "$X/orig.plist"
  apple_intelligence_off; echo "off=$?" > "$X/rc"
  python3 -c "import plistlib,sys;d=plistlib.load(open('$X/com.apple.applicationaccess.plist','rb'));sys.exit(0 if d.get('allowWritingTools') is False and d.get('forceSchoolSetting') else 1)" && echo merged >> "$X/rc"
  apple_intelligence_off   # watcher re-apply: must not overwrite the backup with our own file
  apple_intelligence_on; echo "on=$?" >> "$X/rc"
  cmp -s "$X/com.apple.applicationaccess.plist" "$X/orig.plist" && echo restored >> "$X/rc"
  rm -f "$X/com.apple.applicationaccess.plist"
  apple_intelligence_off; apple_intelligence_on
  [ ! -e "$X/com.apple.applicationaccess.plist" ] && echo absent >> "$X/rc"
) >/dev/null 2>&1
chk "lock merges our keys into theirs" 'grep -q merged "$X/rc"'
chk "unlock restores their file byte-for-byte" 'grep -q restored "$X/rc" && grep -q "on=0" "$X/rc"'
chk "no file before the quiz -> none after" 'grep -q absent "$X/rc"'
echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
