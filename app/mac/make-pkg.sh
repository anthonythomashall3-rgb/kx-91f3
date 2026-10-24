#!/bin/bash
# Build a distributable macOS installer package (for the download page).
#   bash make-pkg.sh --token <shared-token> --api https://<project>.pages.dev/api
# Produces lockqz-mac-unsigned.pkg. It installs and warning-free ONCE SIGNED (step 11):
#   productsign --sign "Developer ID Installer: <Name> (<TEAMID>)" lockqz-mac-unsigned.pkg lockqz-mac.pkg
#   xcrun notarytool submit lockqz-mac.pkg --apple-id <id> --team-id <TEAMID> --password <app-pw> --wait
#   xcrun stapler staple lockqz-mac.pkg
# Then copy lockqz-mac.pkg to cloudflare/public/download/.
set -e
APP="$(cd "$(dirname "$0")" && pwd)"
TOKEN=""; API=""; OUT="$APP/lockqz-mac-unsigned.pkg"
while [ $# -gt 0 ]; do case "$1" in
  --token) TOKEN="$2"; shift 2;; --api) API="$2"; shift 2;; --out) OUT="$2"; shift 2;; *) shift;;
esac; done
[ -n "$TOKEN" ] && [ -n "$API" ] || { echo "need --token and --api"; exit 1; }

ROOT="$(mktemp -d)"; SCRIPTS="$(mktemp -d)"
DESTREL="Library/Application Support/LOCKqz"
mkdir -p "$ROOT/$DESTREL"
cp "$APP/lockqz.sh" "$APP/lockqzd.py" "$APP/lockqz-agent.py" "$APP/browser-policy.py" "$APP/blocklist.txt" "$APP/com.lockqz.pf.conf" "$ROOT/$DESTREL/"
[ -f "$APP/lockqz-core.sh" ] && cp "$APP/lockqz-core.sh" "$ROOT/$DESTREL/" || true
cp "$APP/extra-block.sh" "$ROOT/$DESTREL/"   # VPN/VM/remote/overlay/model/Apple Intelligence blockers (sourced by lockqz.sh)
cp "$APP/ensure-python.sh" "$APP/lockqz-boot.sh" "$APP/update.pub" "$APP/install.sh" "$APP/uninstall.sh" "$ROOT/$DESTREL/"   # python repair, launchd entry, release key, (un)installer
chmod 755 "$ROOT/$DESTREL"/*.sh "$ROOT/$DESTREL"/*.py
VERSION="$(tr -d '[:space:]' < "$APP/../VERSION" 2>/dev/null || echo 0.0.0)"
/usr/bin/python3 - "$ROOT/$DESTREL/config.json" "$TOKEN" "$API" <<'PY'
import json,sys
json.dump({"port":8787,"token":sys.argv[2],"api_base":sys.argv[3],
          "device_id":"set-at-install","student":None,"max_minutes":180},
          open(sys.argv[1],"w"), indent=2)
PY

# postinstall: give this install a device id, register the daemon, load it.
cat > "$SCRIPTS/postinstall" <<'POST'
#!/bin/bash
DEST="/Library/Application Support/LOCKqz"
PLIST="/Library/LaunchDaemons/com.lockqz.helper.plist"
DEVICE="mac-$(/usr/bin/uuidgen | tr 'A-Z' 'a-z')"
bash "$DEST/ensure-python.sh" || true   # fresh Mac: install Apple's tools so python3 really runs (before we use it)
/usr/bin/python3 - "$DEST/config.json" "$DEVICE" <<'PY'
import json,sys
p=sys.argv[1]; c=json.load(open(p)); c["device_id"]=sys.argv[2]; json.dump(c,open(p,"w"),indent=2)
PY
chmod 644 "$DEST/config.json"
grep -q 'anchor "com.lockqz"' /etc/pf.conf || echo 'anchor "com.lockqz"' >> /etc/pf.conf
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.lockqz.helper</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$DEST/lockqz-boot.sh</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DEST/lockqzd.log</string>
  <key>StandardErrorPath</key><string>$DEST/lockqzd.log</string>
</dict></plist>
PL
chown root:wheel "$PLIST"; chmod 644 "$PLIST"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"
# Per-user agent (quiz detection + password + live monitor) — runs at every login.
AGENT="/Library/LaunchAgents/com.lockqz.agent.plist"
cat > "$AGENT" <<AG
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.lockqz.agent</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/python3</string><string>$DEST/lockqz-agent.py</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/lockqz-agent.log</string>
  <key>StandardErrorPath</key><string>/tmp/lockqz-agent.log</string>
</dict></plist>
AG
chown root:wheel "$AGENT"; chmod 644 "$AGENT"
CUID="$(stat -f %u /dev/console 2>/dev/null || echo 0)"
if [ "$CUID" != "0" ]; then
  launchctl bootout "gui/$CUID" "$AGENT" 2>/dev/null || true
  launchctl bootstrap "gui/$CUID" "$AGENT" 2>/dev/null || launchctl asuser "$CUID" launchctl load -w "$AGENT" 2>/dev/null || true
fi
exit 0
POST
chmod +x "$SCRIPTS/postinstall"

pkgbuild --root "$ROOT" --scripts "$SCRIPTS" --identifier com.lockqz.helper \
  --version "$VERSION" --install-location / "$OUT"
rm -rf "$ROOT" "$SCRIPTS"
echo "Built: $OUT  (unsigned — sign + notarize per the header before distributing)"
