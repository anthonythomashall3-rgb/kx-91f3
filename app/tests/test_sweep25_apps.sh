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

echo "T4 open connections to AI addresses: one look at the state table, only the open ones are cut"
cat > "$TMP/bin/pfctl" <<P
#!/bin/bash
echo "\$*" >> "$TMP/pflog"
if [ "\$*" = "-ss" ]; then
  for i in 3 7 11; do echo "ALL tcp 10.0.0.5:5\${i}000 -> 198.51.100.\$i:443       ESTABLISHED:ESTABLISHED"; done
  echo "ALL tcp 10.0.0.5:52000 (203.0.113.9:52000) -> 198.51.100.20:443       ESTABLISHED:ESTABLISHED"
  echo "ALL tcp 2001:db8:1::5[53000] -> 2001:db8::4[443]       ESTABLISHED:ESTABLISHED"
  echo "ALL udp 10.0.0.5:54000 -> 192.0.2.77:443       MULTIPLE:MULTIPLE"
fi
P
chmod +x "$TMP/bin/pfctl"
for i in $(seq 1 1500); do echo "198.51.$((100 + i / 250)).$((i % 250))"; done > "$TMP/warm"; for i in $(seq 1 20); do echo "2001:db8::$i"; done >> "$TMP/warm"; echo >> "$TMP/warm"
S=$(date +%s%N); ( PATH="$TMP/bin:$PATH"; STATE="$TMP/state"; source "$APP/mac/extra-block.sh"; WARM_IPS="$TMP/warm"; warm_kill_states ); E=$(date +%s%N)
check "the state table is read once" '[ "$(grep -c "^-ss$" "$TMP/pflog")" = 1 ]'
check "the four listed IPv4 addresses with a state are killed, each once (one behind a translated address too)" '[ "$(grep -c "^-k 0.0.0.0/0 -k 198\.51\.100\.\(3\|7\|11\|20\)$" "$TMP/pflog")" = 4 ]'
check "the listed IPv6 address with a state is killed, in the IPv6 form" 'grep -q "^-k ::/0 -k 2001:db8::4$" "$TMP/pflog"'
check "nothing else: 1,520 listed addresses, 5 calls (an address not on the list is left alone)" '[ "$(grep -c "^-k" "$TMP/pflog")" = 5 ] && ! grep -q "192.0.2.77" "$TMP/pflog"'
check "done in well under a second" '[ $(( (E - S) / 1000000 )) -lt 1000 ]'
rm -f "$TMP/pflog"; printf '#!/bin/bash\necho "$*" >> "%s/pflog"\n' "$TMP" > "$TMP/bin/pfctl"
( PATH="$TMP/bin:$PATH"; STATE="$TMP/state"; source "$APP/mac/extra-block.sh"; WARM_IPS="$TMP/warm"; warm_kill_states )
check "no state to any listed address: one look, no kill calls" '[ "$(cat "$TMP/pflog")" = "-ss" ]'
# Linux: the same with ss
cat > "$TMP/bin/ss" <<P
#!/bin/bash
echo "\$*" >> "$TMP/sslog"
if [ "\$1" = "-Htn" ]; then
  echo "ESTAB 0      0      10.0.0.5:51000  198.51.100.9:443"
  echo "ESTAB 0      0      [2001:db8:1::5]:51001  [2001:db8::6]:443"
  echo "ESTAB 0      0      10.0.0.5:51002  192.0.2.77:443"
  echo "LISTEN 0     128    0.0.0.0:22  0.0.0.0:*"
fi
P
chmod +x "$TMP/bin/ss"
LNX="$(sed -n '/^warm_apply() {/,/^}/p' "$APP/linux/lockqz.sh")"
( PATH="$TMP/bin:$PATH"; STATE="$TMP/lstate"; mkdir -p "$STATE"; WARM_IPS="$TMP/warm"; NFT_TABLE=lockqz; nft() { :; }; _age() { echo 0; }; WARM_MAX_AGE=99999; eval "$LNX"; warm_apply ) >/dev/null 2>&1
check "Linux: open connections read once" '[ "$(grep -c "^-Htn$" "$TMP/sslog")" = 1 ]'
check "Linux: only the listed addresses with an open connection are cut (IPv6 bracketed)" '[ "$(grep -c "^-K" "$TMP/sslog")" = 2 ] && grep -q "^-K dst 198.51.100.9$" "$TMP/sslog" && grep -q "^-K dst \[2001:db8::6\]$" "$TMP/sslog"'

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

echo "T4c Mac: the preferences service is restarted once per lock / unlock, as the last step"
rm -f "$TMP/klog"
( STATE="$TMP/state"; source "$APP/mac/extra-block.sh"; killall() { echo "killall $*" >> "$TMP/klog"; }
  export LOCKQZ_PREFS_DIRTY="$TMP/prefs.dirty"
  prefs_changed; prefs_changed; [ -f "$TMP/prefs.dirty" ] && echo flagged >> "$TMP/klog"
  prefs_flush; prefs_flush; [ -f "$TMP/prefs.dirty" ] || echo cleared >> "$TMP/klog" )
check "two settings changes inside a lock: no restart yet, a flag is left" '[ "$(sed -n 1p "$TMP/klog")" = flagged ]'
check "the last step restarts it exactly once and clears the flag (a second call does nothing)" '[ "$(grep -c "^killall cfprefsd$" "$TMP/klog")" = 1 ] && grep -q "^cleared$" "$TMP/klog"'
rm -f "$TMP/klog"
( STATE="$TMP/state"; source "$APP/mac/extra-block.sh"; killall() { echo "killall $*" >> "$TMP/klog"; }; unset LOCKQZ_PREFS_DIRTY; prefs_changed; prefs_flush )
check "outside the engine: restarted at once, nothing left for later" '[ "$(cat "$TMP/klog")" = "killall cfprefsd" ]'
check "nothing changed in a pass: no restart" '( STATE="$TMP/state"; source "$APP/mac/extra-block.sh"; killall() { echo x >> "$TMP/klog2"; }; export LOCKQZ_PREFS_DIRTY="$TMP/none.dirty"; prefs_flush; [ ! -f "$TMP/klog2" ] )'
check "the browser policy leaves the flag instead of restarting, when the engine asks" 'grep -q "flag = os.environ.get(\"LOCKQZ_PREFS_DIRTY\")" "$APP/mac/browser-policy.py"'
check "lock and unlock: the flag is named first, the restart is the last step" '[ "$(grep -c "export LOCKQZ_PREFS_DIRTY=" "$APP/mac/lockqz.sh")" = 2 ] && [ "$(grep -c "^  prefs_flush || true" "$APP/mac/lockqz.sh")" = 2 ] && ! grep -q "killall cfprefsd" "$APP/mac/lockqz.sh"'
check "no other restart of the preferences service is left in the engine" '[ "$(grep -c "killall cfprefsd" "$APP/mac/extra-block.sh")" = 2 ]'

echo "T5 every platform uses the one-look way"
check "Mac: AI apps closed from running_named" 'grep -q "running_named \"\${AI_APPS\[@\]}\"" "$APP/mac/lockqz.sh"'
check "Mac: no loop over every AI app name with pgrep" '! grep -q "pgrep -if -- \"\$(app_re \"\$a\")\" >/dev/null 2>&1 && osascript" "$APP/mac/lockqz.sh"'
check "Linux: kill lists from running_named -s" 'grep -q "running_named -s \"\$@\"" "$APP/linux/lockqz.sh"'
check "Linux: open connections looked at once (ss -Htn)" 'grep -q "ss -Htn" "$APP/linux/lockqz.sh"'
check "Windows: one Get-Process for the whole list, closed by process id" 'grep -q "foreach (\$p in @(Get-Process -ErrorAction SilentlyContinue))" "$APP/windows/lockqz.ps1" && grep -q "Stop-Process -Id \$p.Id -Force" "$APP/windows/lockqz.ps1" && ! grep -q "Stop-Process -Name \$a" "$APP/windows/lockqz.ps1"'
check "Windows: names compared without case" 'grep -q "StringComparer\]::OrdinalIgnoreCase" "$APP/windows/lockqz.ps1"'
V="$(cat "$APP/VERSION")"
check "version $V in both helpers" 'grep -q "^VERSION = \"$V\"" "$APP/mac/lockqzd.py" && grep -q "^\\\$Version = \"$V\"" "$APP/windows/lockqzd.ps1"'

echo ""; echo "Sweep 25 (apps): $pass passed, $fail failed"; [ "$fail" = 0 ]
