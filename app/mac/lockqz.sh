#!/bin/bash
# LOCKqz Mac blocking engine (strong v1).
# Usage: sudo ./lockqz.sh {lock|unlock|status}
#   LOCKQZ_DRYRUN=1 ./lockqz.sh lock   -> preview only, touches nothing.
# Blocks AI system-wide: blackholes AI + DoH domains in /etc/hosts (every browser +
# any app using system DNS), loads a pf firewall backup layer, flushes DNS, and
# closes running AI apps, and switches browser policy (built-in AI off, AI search answers
# off, extensions off) on for the quiz only. Fully reversible. No extension, no profile.

set -euo pipefail

HOSTS=/etc/hosts
STATE="/Library/Application Support/LOCKqz"
BACKUP="$STATE/hosts.backup"
STATUS="$STATE/status.json"
MARK_START="# LOCKqz START - do not edit"
MARK_END="# LOCKqz END"
HERE="$(cd "$(dirname "$0")" && pwd)"
BLOCKLIST="$HERE/blocklist.txt"
PFCONF="$HERE/com.lockqz.pf.conf"
POLICY="$HERE/browser-policy.py"
PF_ANCHOR="com.lockqz"
DRYRUN="${LOCKQZ_DRYRUN:-0}"
DEV_KEY_HASH="4695a520432e105e967dd2703366c24c039fe0a850fe35db03b73b6b9506aecd"

# Shared, unit-tested block/unblock core (see tests/test_engine.sh).
source "$HERE/lockqz-core.sh"
if [ -f "$HERE/extra-block.sh" ]; then source "$HERE/extra-block.sh"   # VPN/VM/remote-desktop/overlay/local-model/Apple Intelligence blockers
else extra_lock(){ :; }; extra_unlock(){ :; }; fi   # core lock still works if the file is missing

# Raycast stays on the list: its AI chat is built into the same app (no separate process to close).
# Not MacWhisper: on-device speech-to-text only, not an answer tool.
AI_APPS=("ChatGPT" "Claude" "Copilot" "Perplexity" "Ollama" "LM Studio" \
         "GPT4All" "Msty" "Cluely" "Google Gemini" "Jan" "Pieces" "MacGPT" \
         "Dia" "Comet" "ChatGPT Atlas" "Atlas" "Raycast" "Notion AI" \
         "Grammarly" "GrammarlyDesktop" "DeepSeek" "Poe" "Mistral" "Le Chat" "Sider" \
         "AnythingLLM" "Chatbox" "Cherry Studio" "Enchanted" "Ollamac" "BoltAI" "MindMac" \
         "Private LLM" "Backyard AI" "Faraday" "LlamaChat" "FreeChat" "Sanctum" "Msty Studio" \
         "Open WebUI" "Pinokio" "Witsy" "Reor")   # local-model chat apps (their servers: extra-block.sh)

say() { echo "LOCKqz: $*"; }

need_root() {
  [ "$DRYRUN" = "1" ] && return
  if [ "$(id -u)" -ne 0 ]; then
    echo "LOCKqz: must run with sudo (or LOCKQZ_DRYRUN=1 to preview)." >&2; exit 1
  fi
}

# Thin wrappers over the shared core (tests/test_engine.sh exercises the core directly).
domains()     { domains_from "$BLOCKLIST"; }
build_block() { build_block_from "$BLOCKLIST"; }
is_locked()   { hosts_is_locked "$HOSTS"; }

write_status() {  # write_status <locked|unlocked>
  mkdir -p "$STATE"
  printf '{"state":"%s","at":"%s","host":"%s"}\n' \
    "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(scutil --get LocalHostName 2>/dev/null || hostname)" > "$STATUS"
}

load_pf() {
  [ -f "$PFCONF" ] || return 0
  local rules info
  # Make sure the main ruleset actually references our anchor; if not, reload /etc/pf.conf (which the
  # installer appended `anchor "com.lockqz"` to). Without this the anchor rules are never evaluated.
  # (Output is captured first: with pipefail, `cmd | grep -q` can fail on SIGPIPE.)
  rules="$(pfctl -sr 2>/dev/null || true)"
  case "$rules" in *"anchor \"$PF_ANCHOR\""*) ;; *) pfctl -f /etc/pf.conf 2>/dev/null || true ;; esac
  pfctl -a "$PF_ANCHOR" -f "$PFCONF" 2>/dev/null || return 1
  # Enable pf and remember whether WE enabled it, so we can leave it as we found it on unlock.
  info="$(pfctl -s info 2>/dev/null || true)"
  if printf '%s\n' "$info" | grep -qi "Status: Disabled"; then
    if pfctl -E 2>/dev/null; then touch "$STATE/pf.enabled"; fi
  fi
  return 0
}
unload_pf() {
  pfctl -a "$PF_ANCHOR" -F all 2>/dev/null || true   # empty our anchor
  if [ -f "$STATE/pf.enabled" ]; then pfctl -d 2>/dev/null || true; rm -f "$STATE/pf.enabled"; fi
  # Verify: our anchor must hold no rules any more.
  [ -z "$(pfctl -a "$PF_ANCHOR" -sr 2>/dev/null || true)" ]
}
policy() {
  [ -f "$POLICY" ] || return 0
  /usr/bin/python3 "$POLICY" "$1" 2>/dev/null
}

# Kill ONLY the named app or program: an exact process name, or a process running from "<name>.app".
# (Never a loose substring of a command line: "Dia" would match every "media" process, incl. the
# browser's own helpers, and this runs every 5s during a quiz.)
kill_named() {
  pkill -ix -- "$1" 2>/dev/null || true
  pkill -if -- "$(app_re "$1")" 2>/dev/null || true
}
close_ai_apps() {
  for a in "${AI_APPS[@]}"; do
    pgrep -if -- "$(app_re "$a")" >/dev/null 2>&1 && osascript -e "tell application \"$a\" to quit" 2>/dev/null || true
    kill_named "$a"
  done
}

hosts_writable() { chflags nouchg,noschg "$HOSTS" 2>/dev/null || true; }   # a user immutable flag must not stop lock/unlock

# Every layer is attempted even if another one fails (set -e would otherwise stop at the first
# error and leave the rest unapplied). Exit 1 if any layer failed.
do_lock() {
  need_root
  if [ "$DRYRUN" = "1" ]; then
    say "[dry-run] would blackhole $(domains | wc -l | tr -d ' ') domains, load pf, flush DNS, close AI apps."
    extra_lock
    build_block | sed 's/^/    /' | head -10 || true; echo "    ..."; return 0
  fi
  local already=0 rc=0; is_locked && already=1
  mkdir -p "$STATE"; [ -f "$BACKUP" ] || cp "$HOSTS" "$BACKUP" 2>/dev/null || true
  hosts_writable
  hosts_add_block "$HOSTS" "$BLOCKLIST" || rc=1   # idempotent
  is_locked || rc=1
  load_pf || rc=1                                 # reasserts the anchor if it was cleared
  policy lock || rc=1                             # idempotent; browser policy
  if [ "$already" = 0 ]; then
    dscacheutil -flushcache 2>/dev/null || true
    killall -HUP mDNSResponder 2>/dev/null || true
  fi
  close_ai_apps || true   # ALWAYS: close AI apps reopened mid-quiz
  extra_lock || rc=1      # ALWAYS: re-close VPN/VM/remote/overlay/local-model, keep Apple Intelligence off
  write_status locked || true
  [ "$already" = 1 ] || say "LOCKED. AI domains blackholed; firewall up (incl. local-model + VPN ports); browser AI off; AI apps, VPNs, VMs, remote-desktop and overlay tools closed; Apple Intelligence off."
  return $rc
}

# Unlock never stops part-way, and reports failure (exit 1) unless every layer is verifiably gone,
# so the helper keeps its record and retries instead of believing AI is back.
do_unlock() {
  need_root
  if [ "$DRYRUN" = "1" ]; then say "[dry-run] would strip LOCKqz block, flush pf, flush DNS, restore Apple Intelligence."; extra_unlock; return 0; fi
  local rc=0
  if is_locked; then
    hosts_writable
    hosts_remove_block "$HOSTS" || rc=1
    dscacheutil -flushcache 2>/dev/null || true
    killall -HUP mDNSResponder 2>/dev/null || true
  fi
  is_locked && { say "hosts block could not be removed"; rc=1; }
  unload_pf || { say "firewall anchor could not be emptied"; rc=1; }
  policy unlock || { say "browser policy could not be fully restored"; rc=1; }
  extra_unlock || { say "Apple Intelligence / proxy settings could not be fully restored"; rc=1; }
  write_status unlocked || true
  if [ "$rc" = 0 ]; then say "UNLOCKED. AI access restored."; else say "UNLOCK INCOMPLETE - the helper will retry."; fi
  return $rc
}

do_status() {
  # LOCKED only when the hosts block is complete: a hand-edited block reads as tamper and is re-applied.
  if hosts_block_intact "$HOSTS" "$BLOCKLIST"; then echo "LOCKqz: LOCKED"; else echo "LOCKqz: unlocked"; fi
}

# --- Admin developer mode (no sudo needed; acts on the admin's own key file) ---
# ON  = AI stays available during quizzes on THIS Mac only. Gated by a secret only the
# admin holds; the student app ships with its HASH only and has no key file, so students
# can never turn LOCKqz off this way.
dev_dir()  { echo "$HOME/Library/Application Support/LOCKqz"; }
dev_hash() { /usr/bin/python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read().strip()).hexdigest())' "$1" 2>/dev/null; }

do_devmode() {
  local sub="${1:-status}" dir key off
  # Acts on the admin's own files: never as root (root must not follow paths inside a user's home).
  if [ "$(id -u)" = "0" ]; then echo "LOCKqz: run devmode WITHOUT sudo (it only touches your own key file)." >&2; return 1; fi
  dir="$(dev_dir)"; key="$dir/developer.key"; off="$dir/developer.key.off"
  case "$sub" in
    on)
      if [ -f "$key" ] && [ "$(dev_hash "$key")" = "$DEV_KEY_HASH" ]; then say "developer mode already ON."; return; fi
      if [ -f "$off" ] && [ "$(dev_hash "$off")" = "$DEV_KEY_HASH" ]; then
        mv "$off" "$key"; chmod 600 "$key"
        say "developer mode ON — AI stays available during quizzes on this Mac."; return
      fi
      say "no valid developer key on this Mac — only the admin key can turn developer mode on."; return 1 ;;
    off)
      if [ -f "$key" ]; then mv "$key" "$off"; say "developer mode OFF — this Mac now locks during quizzes like everyone else."
      else say "developer mode already OFF."; fi ;;
    status|"")
      if [ -f "$key" ] && [ "$(dev_hash "$key")" = "$DEV_KEY_HASH" ]; then echo "LOCKqz: developer mode ON"
      else echo "LOCKqz: developer mode OFF"; fi ;;
    *) echo "Usage: $0 devmode {on|off|status}"; return 2 ;;
  esac
}

case "${1:-}" in
  lock)   do_lock || exit 1 ;;
  unlock) do_unlock || exit 1 ;;
  status) do_status ;;
  devmode) do_devmode "${2:-status}" ;;
  *) echo "Usage: sudo $0 {lock|unlock|status}  |  $0 devmode {on|off|status}  (LOCKQZ_DRYRUN=1 to preview)"; exit 2 ;;
esac
