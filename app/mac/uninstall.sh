#!/bin/bash
# Remove LOCKqz from this Mac.   sudo bash uninstall.sh
set -e
[ "$(id -u)" = "0" ] || { echo "Run with sudo:  sudo bash uninstall.sh"; exit 1; }
DEST="/Library/Application Support/LOCKqz"
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
bash "$DEST/lockqz.sh" unlock 2>/dev/null || bash "$DEST/lockqz.sh" unlock || echo "LOCKqz: warning - some settings could not be restored"
/usr/bin/python3 "$DEST/browser-policy.py" unlock 2>/dev/null || true
# Remove our pf.conf anchor line (added at install).
if grep -q 'anchor "com.lockqz"' /etc/pf.conf 2>/dev/null; then
  T="$(mktemp)"   # private temp file (a fixed /tmp name could be a planted symlink)
  grep -v 'anchor "com.lockqz"' /etc/pf.conf > "$T" && cat "$T" > /etc/pf.conf; rm -f "$T"
  pfctl -f /etc/pf.conf 2>/dev/null || true
fi
rm -f "$PLIST" "$AGENT"
rm -rf "$DEST"
echo "LOCKqz removed."
