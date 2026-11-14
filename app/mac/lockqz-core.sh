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

# hosts_block_intact <hosts-file> <blocklist-file> : our block is there AND line-for-line complete
# (an admin who deletes the chatgpt.com lines but keeps the markers must not pass as "locked").
hosts_block_intact() {
  hosts_is_locked "$1" || return 1
  [ "$(sed -n "/$MARK_START/,/$MARK_END/p" "$1" 2>/dev/null)" = "$(build_block_from "$2")" ]
}

# hosts_add_block <hosts-file> <blocklist-file> : idempotent — never double-adds; repairs an edited block.
hosts_add_block() {
  local hosts="$1" bl="$2"
  hosts_block_intact "$hosts" "$bl" && return 0
  hosts_remove_block "$hosts"
  { echo ""; build_block_from "$bl"; } >> "$hosts"
}

# hosts_remove_block <hosts-file> : removes exactly our block, leaves the rest intact.
hosts_remove_block() {
  local hosts="$1"
  hosts_is_locked "$hosts" || return 0
  # A block whose END line was edited away is closed again first, right after its last LOCKqz line, so only
  # LOCKqz's own lines are ever removed (never the rest of the file).
  if ! grep -qF "$MARK_END" "$hosts"; then
    awk -v s="$MARK_START" -v e="$MARK_END" '
      { line[NR] = $0 }
      index($0, s) { st = NR; last = NR; inb = 1; next }
      inb && ($0 ~ /^(0\.0\.0\.0|::) [^ ]+$/) { last = NR; next }
      { inb = 0 }
      END { for (i = 1; i <= NR; i++) { print line[i]; if (i == last) print e } }' "$hosts" > "$hosts.lqz.$$" \
      && cat "$hosts.lqz.$$" > "$hosts"
    rm -f "$hosts.lqz.$$"
  fi
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

# dns_back <blocklist-file> : AI is really back - a blocked name no longer answers 0.0.0.0. macOS can keep the
# old answer for a moment after the hosts file changed: the name cache is cleared again until the answer is gone
# (about 3 s at most; one quick look when it already is). Not on Linux (no dscacheutil).
dns_back() {
  command -v dscacheutil >/dev/null 2>&1 || return 0
  local d i; d="$(domains_from "$1" 2>/dev/null | sed -n 1p || true)"; [ -n "$d" ] || return 0
  for i in 1 2 3 4 5 6; do
    dscacheutil -q host -a name "$d" 2>/dev/null | grep '0\.0\.0\.0' >/dev/null || return 0
    dscacheutil -flushcache 2>/dev/null || true
    killall -HUP mDNSResponder 2>/dev/null || true
    sleep 0.5
  done
  return 0
}

# running_named [-s] name... -> which of the given names are running now, one per line: "app<TAB>name" (a process
# launched from "<name>.app") or "proc<TAB>name" (a process with exactly that name). ONE look at the process table
# for the whole list, however long it is: the lock pass runs every few seconds during a quiz and must stay light.
# Names compare without case, as pkill -i does; -s = exact case, process names only (Linux: pkill -x).
running_named() {
  local cs=0; [ "${1:-}" = "-s" ] && { cs=1; shift; }
  [ $# -gt 0 ] || return 0
  { printf '%s\n' "$@"; echo "==LQ=="; ps -axww -o comm= 2>/dev/null; echo "==LQ=="; [ "$cs" = 1 ] || ps -axww -o args= 2>/dev/null; } | awk -v cs="$cs" '
    function key(s) { return cs ? s : tolower(s) }
    $0 == "==LQ==" { sec++; next }
    sec == 0 { if ($0 != "") want[key($0)] = $0; next }
    sec == 1 { b = $0; sub(/[ \t]+$/, "", b); if (substr(b, 1, 1) == "/") sub(/^.*\//, "", b); b = key(b)
               if ((b in want) && !(b in hit)) hit[b] = "proc"; next }
    { s = tolower($0)
      while (match(s, /\/[^\/]+\.app\/contents\/macos\//)) {
        x = substr(s, RSTART + 1, RLENGTH - 21); if (x in want) hit[x] = "app"
        s = substr(s, RSTART + RLENGTH - 1) } }
    END { for (k in hit) printf "%s\t%s\n", hit[k], want[k] }'
}
