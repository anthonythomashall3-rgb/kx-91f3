#!/bin/bash
# launchd entry point for the LOCKqz helper. Repairs python3 if a macOS upgrade removed Apple's
# tools, then runs the daemon. If python3 cannot be repaired, waits a minute so launchd's
# KeepAlive retries without spinning.
# Self-update rollback: a signed update leaves .pending (+ the replaced files in .prev/). The new
# helper removes .pending once its control server answers /status. If it still has not after 3
# starts, the update is put back to the previous files and that version is never installed again
# (.bad_version); the next release updates normally.
DEST="$(cd "$(dirname "$0")" && pwd)"
LQ_MAX_STARTS="${LQ_MAX_STARTS:-3}"

lq_rollback() {   # restore the files the last update replaced; remove the ones it added
  local prev="$DEST/.prev" to n f
  to="$(sed -n 's/^to=\([0-9A-Za-z.]*\)$/\1/p' "$DEST/.pending" 2>/dev/null | head -1)"
  if [ -d "$prev" ] && [ ! -L "$prev" ]; then
    if [ -f "$prev/.added" ]; then
      while IFS= read -r n; do
        [[ "$n" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$ ]] || continue
        rm -f "$DEST/$n"
      done < "$prev/.added"
    fi
    for f in "$prev"/*; do
      [ -f "$f" ] && [ ! -L "$f" ] || continue
      # copy + rename (a new file): this very script may be one of them, and bash is still reading it
      cp -p "$f" "$DEST/.rollback.tmp" && mv -f "$DEST/.rollback.tmp" "$DEST/$(basename "$f")"
    done
  fi
  [ -n "$to" ] && printf '%s\n' "$to" > "$DEST/.bad_version"
  rm -rf "$prev" "$DEST/.pending" "$DEST/.updated"
  echo "LOCKqz: update ${to:-?} did not start - rolled back to the previous version"
}

lq_count_start() {   # -> 0 when this start may run the new code, 1 when it must roll back first
  local p="$DEST/.pending" n
  [ -f "$p" ] && [ ! -L "$p" ] || return 0
  n="$(sed -n 's/^starts=\([0-9]*\)$/\1/p' "$p" | head -1)"; n=$(( ${n:-0} + 1 ))
  if [ "$n" -gt "$LQ_MAX_STARTS" ]; then return 1; fi
  { grep -v '^starts=' "$p"; echo "starts=$n"; } > "$p.tmp" && mv -f "$p.tmp" "$p"
  return 0
}

[ "${1:-}" = "--rollback-check" ] && { lq_count_start || lq_rollback; exit 0; }   # tests

# Only starts where python works count: a Mac whose tools vanished must not blame the update.
if bash "$DEST/ensure-python.sh"; then
  lq_count_start || lq_rollback
else
  sleep 60
fi
exec /usr/bin/python3 "$DEST/lockqzd.py"
