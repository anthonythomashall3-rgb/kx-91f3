#!/bin/bash
# Sweep 36 (24 Nov 2026), Mac engine: the lock pass repeats every 5 s during a quiz, and lsof (looking for a local model
# held open by a big program under any name) was its slow part on Intel Macs. A big program lsof found no model file
# in is looked at again only after a minute; one that holds a model file is still closed at once.
HERE="$(cd "$(dirname "$0")" && pwd)"; MAC="$HERE/../mac"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
check() { if eval "$2"; then pass=$((pass+1)); echo "  ok: $1"; else fail=$((fail+1)); echo "  FAIL: $1"; fi; }
BIN="$TMP/bin"; mkdir -p "$BIN" "$TMP/state"
cat > "$BIN/ps" <<'EOP'
#!/bin/bash
printf '%s\n' "  888 3000000 /Applications/Big Editor.app/Contents/MacOS/Big Editor" "  889 2500000 /Users/s/.local/bin/renamed --serve" "  890 500 /usr/bin/true"
EOP
cat > "$BIN/lsof" <<EOP
#!/bin/bash
echo "\$*" >> "$TMP/lsof.calls"
case "\$*" in *"-p 889"*) [ -f "$TMP/model" ] && { printf 'p889\nn/Users/s/.ollama/models/blobs/sha256-ab12\n'; exit 0; } ;; esac
printf 'p0\nn/Users/s/Library/Caches/x.db\n'
EOP
chmod +x "$BIN/ps" "$BIN/lsof"
run() { ( export PATH="$BIN:$PATH"; DRYRUN="${1:-0}"; STATE="$TMP/state"; source "$MAC/lockqz-core.sh" 2>/dev/null; source "$MAC/extra-block.sh"
          kill() { echo "killed $*" >> "$TMP/kills"; }; models_by_file ) >> "$TMP/out" 2>&1; }
echo "M big programs: lsof at most once a minute each"
run 0
check "first pass: lsof looks at both big programs" '[ "$(grep -c . "$TMP/lsof.calls")" = 2 ]'
check "... remembers them (pid and time)" 'grep -qE "^888 [0-9]+$" "$TMP/state/models.seen" && grep -qE "^889 [0-9]+$" "$TMP/state/models.seen"'
run 0; run 0
check "the next passes within the minute: no lsof" '[ "$(grep -c . "$TMP/lsof.calls")" = 2 ]'
sed -i.bak 's/^889 .*/889 1000/' "$TMP/state/models.seen"
run 0
check "a minute later: looked at again (only that one)" '[ "$(grep -c . "$TMP/lsof.calls")" = 3 ] && tail -1 "$TMP/lsof.calls" | grep -q -- "-p 889"'
touch "$TMP/model"; sed -i.bak 's/^889 .*/889 1000/' "$TMP/state/models.seen"
run 0
check "a big program that now holds a model file: closed" 'grep -q "^killed -9 889$" "$TMP/kills"'
check "... and not remembered as clean" '! grep -q "^889 " "$TMP/state/models.seen"'
check "the clean one stays remembered" 'grep -qE "^888 [0-9]+$" "$TMP/state/models.seen"'
rm -f "$TMP/state/models.seen" "$TMP/lsof.calls"; run 1
check "a dry run looks but writes nothing" '[ ! -e "$TMP/state/models.seen" ] && [ "$(grep -c . "$TMP/lsof.calls")" = 2 ]'
echo "H a repeat pass reads the hidden-window list beside the pass (it can take seconds) and acts on the newest one"
cp "$(command -v bash)" "$TMP/lqzhide"; "$TMP/lqzhide" -c 'sleep 300; :' >/dev/null 2>&1 & HP=$!   # a real program file named lqzhide (sleep can be a multi-call binary)
cat > "$TMP/hw.sh" <<EOP
_hw_list() { sleep 3; printf '%s\t%s\t%s\t%s\n' "$HP" "LQHide" "$TMP/lqzhide" ""; }
_hw_kill() { kill -TERM "\$1" 2>/dev/null; sleep 0.2; ! kill -0 "\$1" 2>/dev/null; }
xb_say() { echo "LOCKqz: \$*"; }
EOP
hw() { ( STATE="$TMP/state"; DRYRUN=0; source "$MAC/lockqz-core.sh" 2>/dev/null; source "$MAC/extra-block.sh"; source "$TMP/hw.sh"; KEEP_APPS=(); hidden_close "$@" ) >> "$TMP/hw.out" 2>&1; }
t0=$(date +%s); hw async; t1=$(date +%s)
check "repeat pass: returns at once (the list is read beside it)" '[ $((t1 - t0)) -lt 2 ] && kill -0 "$HP" 2>/dev/null'
sleep 4
check "... the list it started finished" '[ -s "$TMP/state/hidden.list.done" ]'
hw async
check "the next repeat pass closes the program that list named" '! kill -0 "$HP" 2>/dev/null && grep -q "closed LQHide" "$TMP/hw.out"'
"$TMP/lqzhide" -c 'sleep 300; :' >/dev/null 2>&1 & HP2=$!
printf '%s\t%s\t%s\t%s\n' "$HP2" "LQHide" "$TMP/other-program" "" > "$TMP/state/hidden.list.done"
hw async
check "a number that now belongs to another program is left alone" 'kill -0 "$HP2" 2>/dev/null'
kill "$HP2" 2>/dev/null
"$TMP/lqzhide" -c 'sleep 300; :' >/dev/null 2>&1 & HP3=$!
sed -i.bak "s/\"\$HP\"/\"$HP3\"/" "$TMP/hw.sh"; sed -i.bak "s/^_hw_list() { sleep 3; printf '%s\\\\t%s\\\\t%s\\\\t%s\\\\n' \"[0-9]*\"/_hw_list() { sleep 3; printf '%s\\\\t%s\\\\t%s\\\\t%s\\\\n' \"$HP3\"/" "$TMP/hw.sh"
rm -f "$TMP/state/hidden.list.done"; hw
check "the first pass of a quiz still reads the list and closes at once" '! kill -0 "$HP3" 2>/dev/null'
kill "$HP3" 2>/dev/null
check "unlock clears the list files" 'grep -q "\$HW_ASYNC.done\" \"\$HW_ASYNC.tmp\" \"\$HW_ASYNC.pid\"" "$MAC/extra-block.sh"'
check "extra_lock: the async read on repeat passes only (extra.applied), the first pass reads it at once" 'grep -q "if \[ -f \"\$XB_APPLIED\" \]; then hidden_close async; else hidden_close; fi" "$MAC/extra-block.sh"'
echo "T each step of the kill pass is timed (LOCKQZ_TIMING)"
check "x-list, x-cmds, x-models, x-kills laps in extra_lock" 'grep -q "xb_lap x-list" "$MAC/extra-block.sh" && grep -q "xb_lap x-cmds" "$MAC/extra-block.sh" && grep -q "xb_lap x-models" "$MAC/extra-block.sh"'
echo "RESULT: $pass passed, $fail failed"
[ "$fail" = 0 ]
