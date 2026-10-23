#!/bin/bash
# LOCKqz macOS installer. Installs the root helper (blocks AI) and the per-user agent
# (detects the Brightspace quiz). ONE install, no browser extension, no Web Store.
# Run from the mac/ folder:   sudo bash install.sh
# Reads token/api from mac/config.json if present, else from --token/--api or prompts.
# Uninstall any time:          sudo bash uninstall.sh
set -e
APP="$(cd "$(dirname "$0")" && pwd)"
DEST="/Library/Application Support/LOCKqz"
PLIST="/Library/LaunchDaemons/com.lockqz.helper.plist"
AGENT="/Library/LaunchAgents/com.lockqz.agent.plist"
STUDENT=""; TOKEN=""; API=""

while [ $# -gt 0 ]; do case "$1" in
  --token) TOKEN="$2"; shift 2;;
  --api)   API="$2";   shift 2;;
  --student) STUDENT="$2"; shift 2;;
  *) shift;;
esac; done

[ "$(id -u)" = "0" ] || { echo "Run with sudo:  sudo bash install.sh"; exit 1; }

# Pull defaults from an existing config.json next to this script.
CFG="$APP/config.json"
if [ -z "$TOKEN" ] && [ -f "$CFG" ]; then TOKEN="$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("token",""))' "$CFG" 2>/dev/null || true)"; fi
if [ -z "$API" ]   && [ -f "$CFG" ]; then API="$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("api_base",""))' "$CFG" 2>/dev/null || true)"; fi
[ -n "$TOKEN" ] || { read -r -p "Shared token: " TOKEN; }
[ -n "$API" ]   || { read -r -p "API base (e.g. https://<project>.pages.dev/api): " API; }

DEVICE="mac-$(/usr/bin/uuidgen | tr 'A-Z' 'a-z')"
echo "== installing LOCKqz helper =="

mkdir -p "$DEST"
cp "$APP/lockqz.sh" "$APP/lockqz-core.sh" "$APP/extra-block.sh" "$APP/lockqzd.py" "$APP/lockqz-agent.py" "$APP/browser-policy.py" \
   "$APP/blocklist.txt" "$APP/com.lockqz.pf.conf" "$DEST/"
chmod +x "$DEST/lockqz.sh" 2>/dev/null || true

# Write the device config (merge token/api/device into the example shape).
/usr/bin/python3 - "$DEST/config.json" "$TOKEN" "$API" "$DEVICE" "$STUDENT" <<'PY'
import json,sys
path,token,api,dev,student=sys.argv[1:6]
json.dump({"port":8787,"token":token,"api_base":api,"device_id":dev,
          "student":student or None,"max_minutes":180}, open(path,"w"), indent=2)
PY
chmod 644 "$DEST/config.json"   # the per-user agent reads it (loopback token only)

# Firewall anchor so the pf (encrypted-DNS) layer is evaluated.
grep -q 'anchor "com.lockqz"' /etc/pf.conf || echo 'anchor "com.lockqz"' >> /etc/pf.conf

# LaunchDaemon: start the helper at boot as root.
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.lockqz.helper</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/python3</string><string>$DEST/lockqzd.py</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DEST/lockqzd.log</string>
  <key>StandardErrorPath</key><string>$DEST/lockqzd.log</string>
</dict></plist>
PLISTEOF
chown root:wheel "$PLIST"; chmod 644 "$PLIST"

# (Re)load the daemon.
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"

# Per-user agent: quiz detection + password + live monitor. Runs at every login.
cat > "$AGENT" <<AGENTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.lockqz.agent</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/python3</string><string>$DEST/lockqz-agent.py</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/lockqz-agent.log</string>
  <key>StandardErrorPath</key><string>/tmp/lockqz-agent.log</string>
</dict></plist>
AGENTEOF
chown root:wheel "$AGENT"; chmod 644 "$AGENT"
CUID="$(stat -f %u /dev/console 2>/dev/null || echo 0)"
if [ "$CUID" != "0" ]; then
  launchctl bootout "gui/$CUID" "$AGENT" 2>/dev/null || true
  launchctl bootstrap "gui/$CUID" "$AGENT" 2>/dev/null || launchctl asuser "$CUID" launchctl load -w "$AGENT" 2>/dev/null || true
fi

sleep 2
echo ""
echo "Installed. Device id: $DEVICE"
echo "Helper status:"; curl -s -m 4 -H "X-LOCKqz-Token: $TOKEN" http://127.0.0.1:8787/status || echo "  (daemon still starting — check $DEST/lockqzd.log)"
echo ""
echo "Done. Open a Brightspace quiz — the agent asks your name once, then locks AI automatically."
