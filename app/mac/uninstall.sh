#!/bin/bash
# Remove LOCKqz from this Mac.   sudo bash uninstall.sh
[ "$(id -u)" = "0" ] || { echo "Run with sudo:  sudo bash uninstall.sh"; exit 1; }
DEST="${LOCKQZ_DEST:-/Library/Application Support/LOCKqz}"
PLIST="/Library/LaunchDaemons/com.lockqz.helper.plist"
AGENT="/Library/LaunchAgents/com.lockqz.agent.plist"

# STOP the watchers FIRST, so nothing re-locks after we strip the block.
CUID="$(stat -f %u /dev/console 2>/dev/null || echo 0)"
[ "$CUID" != "0" ] && launchctl bootout "gui/$CUID" "$AGENT" 2>/dev/null || true
launchctl bootout system "$PLIST" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
pkill -f "$DEST/lockqzd.py" 2>/dev/null || true
pkill -f "$DEST/lockqz-agent.py" 2>/dev/null || true
sleep 1
# Now nothing is running to fight us: restore everything.
# (unlock restores the browser policies and Apple Intelligence settings from their backups, so it
#  must run BEFORE the folder holding those backups is deleted; try twice.)
if ! { bash "$DEST/lockqz.sh" unlock 2>/dev/null || bash "$DEST/lockqz.sh" unlock; }; then
  # Keep the folder (it holds the backups of the student's own settings) and the helper, whose start
  # always finishes an unlock; only quiz detection (the agent) is removed, so nothing locks again.
  rm -f "$AGENT"
  launchctl bootstrap system "$PLIST" 2>/dev/null || launchctl load -w "$PLIST" 2>/dev/null || true
  echo "LOCKqz: some settings could not be restored yet. LOCKqz keeps trying by itself;"
  echo "        restart the Mac, then run this uninstaller again."
  exit 1
fi
# Remove our pf.conf anchor line (added at install).
if grep -q 'anchor "com.lockqz"' /etc/pf.conf 2>/dev/null; then
  T="$(mktemp)"   # private temp file (a fixed /tmp name could be a planted symlink)
  grep -v 'anchor "com.lockqz"' /etc/pf.conf > "$T" && cat "$T" > /etc/pf.conf; rm -f "$T"
  pfctl -f /etc/pf.conf 2>/dev/null || true
fi
# Per-user leftovers: the agent's log. student.json (the confirmed school email + its proof) is KEPT so a
# reinstall never asks again. Never through a symlinked folder.
for H in /Users/*; do
  U="$H/Library/Application Support/LOCKqz"
  if [ -d "$U" ] && [ ! -L "$U" ] && [ ! -L "$H/Library" ] && [ ! -L "$H/Library/Application Support" ]; then
    rmdir "$U" 2>/dev/null || true
  fi
  L="$H/Library/Logs"
  if [ -d "$L" ] && [ ! -L "$L" ] && [ ! -L "$H/Library" ]; then rm -f "$L/LOCKqz-agent.log" "$L/LOCKqz-agent.log.1"; fi
done
rm -f "$PLIST" "$AGENT"
rm -rf "$DEST"
pkgutil --forget com.lockqz.helper >/dev/null 2>&1 || true
echo "LOCKqz removed."
