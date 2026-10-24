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

AI_APPS=("ChatGPT" "Claude" "Copilot" "Perplexity" "Ollama" "LM Studio" \
         "GPT4All" "Msty" "Cluely" "Google Gemini" "Jan" "Pieces" "MacGPT" \
         "Dia" "Comet" "ChatGPT Atlas" "Atlas" "Opera" "Raycast" "Notion AI" \
         "Grammarly" "GrammarlyDesktop" "DeepSeek" "Poe" "Mistral" "Le Chat" "Sider" "MacWhisper")

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
  pfctl -a "$PF_ANCHOR" -f "$PFCONF" 2>/dev/null || true
  pfctl -E 2>/dev/null || true
}
unload_pf() { pfctl -a "$PF_ANCHOR" -F all 2>/dev/null || true; }
policy() { [ -f "$POLICY" ] && /usr/bin/python3 "$POLICY" "$1" 2>/dev/null || true; }

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

do_lock() {
  need_root
  if is_locked; then say "already locked."; return; fi
  if [ "$DRYRUN" = "1" ]; then
    say "[dry-run] would blackhole $(domains | wc -l | tr -d ' ') domains, load pf, flush DNS, close AI apps."
    extra_lock
    build_block | sed 's/^/    /' | head -10 || true; echo "    ..."; return
  fi
  mkdir -p "$STATE"; [ -f "$BACKUP" ] || cp "$HOSTS" "$BACKUP"
  hosts_add_block "$HOSTS" "$BLOCKLIST"
  load_pf
  policy lock
  dscacheutil -flushcache 2>/dev/null || true
  killall -HUP mDNSResponder 2>/dev/null || true
  close_ai_apps
  extra_lock
  write_status locked
  say "LOCKED. AI domains blackholed; firewall up (incl. local-model + VPN ports); browser AI off; AI apps, VPNs, VMs, remote-desktop and overlay tools closed; Apple Intelligence off."
}

do_unlock() {
  need_root
  if [ "$DRYRUN" = "1" ]; then say "[dry-run] would strip LOCKqz block, flush pf, flush DNS, restore Apple Intelligence."; extra_unlock; return; fi
  if is_locked; then
    hosts_remove_block "$HOSTS"
    dscacheutil -flushcache 2>/dev/null || true
    killall -HUP mDNSResponder 2>/dev/null || true
  fi
  unload_pf
  policy unlock
  extra_unlock
  write_status unlocked
  say "UNLOCKED. AI access restored."
}

do_status() {
  if is_locked; then echo "LOCKqz: LOCKED"; else echo "LOCKqz: unlocked"; fi
}

# --- Admin developer mode (no sudo needed; acts on the admin's own key file) ---
# ON  = AI stays available during quizzes on THIS Mac only. Gated by a secret only the
# admin holds; the student app ships with its HASH only and has no key file, so students
# can never turn LOCKqz off this way.
dev_user() { echo "${SUDO_USER:-$(stat -f %Su /dev/console 2>/dev/null)}"; }
dev_dir()  { echo "/Users/$(dev_user)/Library/Application Support/LOCKqz"; }
dev_hash() { /usr/bin/python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read().strip()).hexdigest())' "$1" 2>/dev/null; }

do_devmode() {
  local sub="${1:-status}" dir key off
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
  lock)   do_lock ;;
  unlock) do_unlock ;;
  status) do_status ;;
  devmode) do_devmode "${2:-status}" ;;
  *) echo "Usage: sudo $0 {lock|unlock|status}  |  $0 devmode {on|off|status}  (LOCKQZ_DRYRUN=1 to preview)"; exit 2 ;;
esac
