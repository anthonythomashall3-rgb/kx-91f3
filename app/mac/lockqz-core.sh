#!/bin/bash
# LOCKqz core block/unblock logic, isolated so it can be unit-tested against a fake
# hosts file with no root and no system changes. lockqz.sh sources this.
# Override these before sourcing to test:  HOSTS, BLOCKLIST, STATE.
: "${HOSTS:=/etc/hosts}"
: "${MARK_START:=# LOCKqz START - do not edit}"
: "${MARK_END:=# LOCKqz END}"

# domains_from <blocklist-file>  -> clean domain list (no comments/blanks/spaces)
# (host/path entries such as huggingface.co/chat are enforced by the browser policy instead; only
#  plain host names - subdomains included, e.g. chat.z.ai - can go in hosts.)
domains_from() { grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$1" | sed 's/[[:space:]]//g' | grep -E '^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$' || true; }

# build_block_from <blocklist-file>  -> the exact text block we add to hosts
build_block_from() {
  echo "$MARK_START"
  local d
  while read -r d; do
    [ -z "$d" ] && continue
    echo "0.0.0.0 $d"; echo ":: $d"            # IPv4 AND IPv6, so an AAAA lookup can't reach it
    case "$d" in *.*) [[ "$d" == www.* ]] || { echo "0.0.0.0 www.$d"; echo ":: www.$d"; };; esac
  done < <(domains_from "$1")
  echo "$MARK_END"
}

hosts_is_locked() { grep -qF "$MARK_START" "$1" 2>/dev/null; }

# hosts_add_block <hosts-file> <blocklist-file> : idempotent — never double-adds.
hosts_add_block() {
  local hosts="$1" bl="$2"
  hosts_is_locked "$hosts" && return 0
  { echo ""; build_block_from "$bl"; } >> "$hosts"
}

# hosts_remove_block <hosts-file> : removes exactly our block, leaves the rest intact.
hosts_remove_block() {
  local hosts="$1"
  hosts_is_locked "$hosts" || return 0
  # portable sed in-place (works on BSD/macOS and GNU)
  if sed --version >/dev/null 2>&1; then
    sed -i "/$MARK_START/,/$MARK_END/d" "$hosts"
  else
    sed -i '' "/$MARK_START/,/$MARK_END/d" "$hosts"
  fi
  # collapse trailing blank lines to a single newline
  perl -0pi -e 's/\n+\z/\n/' "$hosts" 2>/dev/null || true
}

# app_re <name> -> regex matching ONLY a process launched from "<name>.app" (used with pkill -f).
app_re() { printf '/%s\\.app/Contents/MacOS/' "$(printf '%s' "$1" | sed 's/[][\\.^$*+?(){}|]/\\&/g')"; }
