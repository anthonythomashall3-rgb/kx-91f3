#!/bin/bash
# Sweep 25 (apps 0.6.24): the lock pass looks at the running programs ONCE for all its lists (it used to look once
# per name, several seconds on every pass, and the pass repeats every 5 s during a quiz), and the connections
# already open to AI addresses are cut several at a time. No root, nothing real is closed.
HERE="$(cd "$(dirname "$0")" && pwd)"; APP="$HERE/.."
TMP="$(mktemp -d)"; trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$TMP"' EXIT
pass=0; fail=0
check() { if eval "$2" >/dev/null 2>&1; then pass=$((pass+1)); echo "  ok: $1"; else fail=$((fail+1)); echo "  FAIL: $1"; fi; }

source "$APP/mac/lockqz-core.sh"
# Pretend programs (sleep under other names): an app with a space, an app, a plain program, a helper inside another app.
(exec -a "/Applications/LM Studio.app/Contents/MacOS/LM Studio" sleep 60) &
(exec -a "/Users/x/Apps/Cluely.app/Contents/MacOS/Cluely --hidden" sleep 60) &
(exec -a "/Applications/Google Chrome.app/Contents/Frameworks/x/Google Chrome Helper --enable-features=MediaFoundation,Dia" sleep 60) &
cp "$(command -v bash)" "$TMP/ollama"; "$TMP/ollama" -c 'sleep 60; :' &   # a real program file named ollama (sleep itself can be a multi-call binary)
sleep 0.6

echo "T1 running_named: which listed names are running"
OUT="$(running_named "ChatGPT" "lm studio" "Cluely" "Dia" "Media" "OLLAMA" "Google Chrome Helper" "Opera" | sort)"
check "an app launched from <name>.app is found, whatever the case" 'echo "$OUT" | grep -qx "app	lm studio"'
check "an app in any folder is found" 'echo "$OUT" | grep -qx "app	Cluely"'
check "a program with exactly that name is found, whatever the case" 'echo "$OUT" | grep -qx "proc	OLLAMA"'
check "a name that is only part of another command line is NOT found (Dia, Media)" '! echo "$OUT" | grep -qE "Dia|Media"'
check "a helper inside another app is not taken for that app" '! echo "$OUT" | grep -q "Google Chrome Helper"'
check "what is not running is not listed" '! echo "$OUT" | grep -qE "ChatGPT|Opera"'
check "nothing asked, nothing answered" '[ -z "$(running_named)" ]'
OUT2="$(running_named -s "Ollama" "ollama" "LM Studio" | sort)"
check "-s: exact case, process names only (Linux lists)" '[ "$OUT2" = "proc	ollama" ]'

echo "T2 one look for the whole list"
mkdir -p "$TMP/bin"; REAL_PS="$(command -v ps)"
printf '#!/bin/bash\necho x >> "%s/pscalls"\nexec "%s" "$@"\n' "$TMP" "$REAL_PS" > "$TMP/bin/ps"; chmod +x "$TMP/bin/ps"
NAMES=(); for i in $(seq 1 300); do NAMES+=("app$i"); done
S=$(date +%s%N); ( PATH="$TMP/bin:$PATH"; running_named "${NAMES[@]}" "ollama" > "$TMP/o3" ); E=$(date +%s%N)
check "300 names: the process table is read twice (names, command lines), not once per name" '[ "$(wc -l < "$TMP/pscalls")" = 2 ]'
check "300 names answered in under a second" '[ $(( (E - S) / 1000000 )) -lt 1000 ]'
check "and the running one among them is still found" 'grep -qx "proc	ollama" "$TMP/o3"'

echo "T3 Mac kill lists: only what is running is touched"
( STATE="$TMP/state"; DRYRUN=0; mkdir -p "$STATE"; source "$APP/mac/extra-block.sh"
  pkill() { echo "pkill $*" >> "$TMP/kills"; }; osascript() { echo "osascript $*" >> "$TMP/kills"; }; pgrep() { echo "pgrep $*" >> "$TMP/kills"; return 1; }
  _kill_list "overlay" "Cluely" "InterviewCoder" "Pieces" "LockedIn AI"; _kill_list "local-model" "ollama" "llama-server"; : )
check "the running app is asked to quit, then closed by name and by its .app path" 'grep -q "^osascript -e tell application \"Cluely\" to quit" "$TMP/kills" && grep -q "^pkill -ix -- Cluely$" "$TMP/kills" && grep -q "^pkill -if -- /Cluely" "$TMP/kills"'
check "the running program is closed by name (no quit request: it is not an app)" 'grep -q "^pkill -ix -- ollama$" "$TMP/kills" && ! grep -q "osascript.*ollama" "$TMP/kills"'
check "nothing is run for names that are not running" '! grep -qE "InterviewCoder|Pieces|LockedIn|llama-server" "$TMP/kills"'
check "no look per name any more (pgrep is not called)" '! grep -q "^pgrep" "$TMP/kills"'
( STATE="$TMP/state"; DRYRUN=1; source "$APP/mac/extra-block.sh"; _kill_list "overlay" "Cluely" "Pieces" > "$TMP/dry" )
check "dry run names the running one only" 'grep -q "would close (overlay): Cluely" "$TMP/dry" && ! grep -q Pieces "$TMP/dry"'

echo "T4 open connections to AI addresses are cut several at a time, each once"
printf '#!/bin/bash\necho "$*" >> "%s/pflog"\nsleep 0.05\n' "$TMP" > "$TMP/bin/pfctl"; chmod +x "$TMP/bin/pfctl"
for i in $(seq 1 40); do echo "198.51.100.$i"; done > "$TMP/warm"; for i in $(seq 1 20); do echo "2001:db8::$i"; done >> "$TMP/warm"; echo >> "$TMP/warm"
S=$(date +%s%N); ( PATH="$TMP/bin:$PATH"; STATE="$TMP/state"; source "$APP/mac/extra-block.sh"; WARM_IPS="$TMP/warm"; warm_kill_states ); E=$(date +%s%N)
check "every IPv4 address once" '[ "$(grep -c "^-k 0.0.0.0/0 -k 198\.51\.100\." "$TMP/pflog")" = 40 ] && [ "$(sort "$TMP/pflog" | uniq -d | wc -l)" = 0 ]'
check "every IPv6 address once, with the IPv6 form" '[ "$(grep -c "^-k ::/0 -k 2001:db8::" "$TMP/pflog")" = 20 ]'
check "the empty line is skipped" '[ "$(wc -l < "$TMP/pflog")" = 60 ]'
check "60 calls of 50 ms each finish in well under their 3 s in a row" '[ $(( (E - S) / 1000000 )) -lt 1800 ]'

echo "T4b Mac unlock: AI names answer again before the unlock is reported done"
printf 'chatgpt.com\nclaude.ai\n' > "$TMP/bl"
# A pretend macOS resolver that still gives the blocked answer for the first two looks.
printf '#!/bin/bash\necho "$*" >> "%s/dslog"\ncase "$1" in -q) n=$(grep -c "^-q" "%s/dslog"); if [ "$n" -le 2 ]; then echo "ip_address: 0.0.0.0"; else echo "ip_address: 104.18.32.47"; fi;; esac\n' "$TMP" "$TMP" > "$TMP/bin/dscacheutil"; chmod +x "$TMP/bin/dscacheutil"
( PATH="$TMP/bin:$PATH"; killall() { echo "killall $*" >> "$TMP/dslog"; }; dns_back "$TMP/bl" )
check "the first blocked name is asked for" 'grep -q "^-q host -a name chatgpt.com$" "$TMP/dslog"'
check "still the blocked answer: the name cache is cleared again (twice here), then it stops" '[ "$(grep -c "^-flushcache" "$TMP/dslog")" = 2 ] && [ "$(grep -c "^killall -HUP mDNSResponder" "$TMP/dslog")" = 2 ] && [ "$(grep -c "^-q" "$TMP/dslog")" = 3 ]'
rm -f "$TMP/dslog"; printf '#!/bin/bash\necho "$*" >> "%s/dslog"\necho "ip_address: 104.18.32.47"\n' "$TMP" > "$TMP/bin/dscacheutil"
( PATH="$TMP/bin:$PATH"; killall() { echo "killall $*" >> "$TMP/dslog"; }; dns_back "$TMP/bl" )
check "already answering: one look, nothing cleared" '[ "$(wc -l < "$TMP/dslog")" = 1 ]'
rm -f "$TMP/dslog"; printf '#!/bin/bash\necho "$*" >> "%s/dslog"\necho "ip_address: 0.0.0.0"\n' "$TMP" > "$TMP/bin/dscacheutil"
S=$(date +%s%N); ( PATH="$TMP/bin:$PATH"; killall() { :; }; dns_back "$TMP/bl" ); E=$(date +%s%N)
check "never answering: gives up after 6 looks (about 3 s), the unlock still completes" '[ "$(grep -c "^-q" "$TMP/dslog")" = 6 ] && [ $(( (E - S) / 1000000 )) -lt 5000 ]'
check "the Mac unlock calls it after every layer is off" 'grep -q "dns_back \"\$BLOCKLIST\" || true" "$APP/mac/lockqz.sh"'

echo "T5 every platform uses the one-look way"
check "Mac: AI apps closed from running_named" 'grep -q "running_named \"\${AI_APPS\[@\]}\"" "$APP/mac/lockqz.sh"'
check "Mac: no loop over every AI app name with pgrep" '! grep -q "pgrep -if -- \"\$(app_re \"\$a\")\" >/dev/null 2>&1 && osascript" "$APP/mac/lockqz.sh"'
check "Linux: kill lists from running_named -s" 'grep -q "running_named -s \"\$@\"" "$APP/linux/lockqz.sh"'
check "Linux: open connections cut several at a time" 'grep -q "xargs -P 8 -I{} ss -K dst {}" "$APP/linux/lockqz.sh"'
check "Windows: one Get-Process for the whole list, closed by process id" 'grep -q "foreach (\$p in @(Get-Process -ErrorAction SilentlyContinue))" "$APP/windows/lockqz.ps1" && grep -q "Stop-Process -Id \$p.Id -Force" "$APP/windows/lockqz.ps1" && ! grep -q "Stop-Process -Name \$a" "$APP/windows/lockqz.ps1"'
check "Windows: names compared without case" 'grep -q "StringComparer\]::OrdinalIgnoreCase" "$APP/windows/lockqz.ps1"'
V="$(cat "$APP/VERSION")"
check "version $V in both helpers" 'grep -q "^VERSION = \"$V\"" "$APP/mac/lockqzd.py" && grep -q "^\\\$Version = \"$V\"" "$APP/windows/lockqzd.ps1"'

echo ""; echo "Sweep 25 (apps): $pass passed, $fail failed"; [ "$fail" = 0 ]
