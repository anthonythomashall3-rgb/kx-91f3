#!/bin/bash
# LOCKqz Linux uninstaller: unlocks first (hosts, firewall, browser policies restored), then removes
# the services, the code and the state.   sudo bash uninstall.sh
set -uo pipefail
DEST="${LOCKQZ_DEST:-/usr/local/lib/lockqz}"
STATE="${LOCKQZ_STATE:-/var/lib/lockqz}"
[ "$(id -u)" = 0 ] || { echo "Run with sudo:  sudo bash uninstall.sh"; exit 1; }
[ -f "$DEST/lockqz.sh" ] && STATE="$STATE" bash "$DEST/lockqz.sh" unlock || true
for uid in $(loginctl list-users --no-legend 2>/dev/null | awk '{print $1}'); do
  systemctl --machine="$uid@" --user stop lockqz-agent.service >/dev/null 2>&1 || true
done
systemctl --global disable lockqz-agent.service >/dev/null 2>&1 || true
systemctl disable --now lockqzd.service >/dev/null 2>&1 || true
rm -f /etc/systemd/system/lockqzd.service /etc/systemd/user/lockqz-agent.service
systemctl daemon-reload
rm -rf "$DEST" "$STATE"
echo "LOCKqz removed."
