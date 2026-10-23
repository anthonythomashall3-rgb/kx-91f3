#!/bin/bash
# Remove LOCKqz from this Mac.   sudo bash uninstall.sh
set -e
[ "$(id -u)" = "0" ] || { echo "Run with sudo:  sudo bash uninstall.sh"; exit 1; }
DEST="/Library/Application Support/LOCKqz"
PLIST="/Library/LaunchDaemons/com.lockqz.helper.plist"
AGENT="/Library/LaunchAgents/com.lockqz.agent.plist"

# Make sure nothing is left blocked before we remove the engine (hosts, pf, browser policy).
bash "$DEST/lockqz.sh" unlock 2>/dev/null || true
/usr/bin/python3 "$DEST/browser-policy.py" unlock 2>/dev/null || true
CUID="$(stat -f %u /dev/console 2>/dev/null || echo 0)"
[ "$CUID" != "0" ] && launchctl bootout "gui/$CUID" "$AGENT" 2>/dev/null || true
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST" "$AGENT"
rm -rf "$DEST"
# leave /etc/pf.conf anchor line (harmless); remove it by hand if you want it gone.
echo "LOCKqz removed."
