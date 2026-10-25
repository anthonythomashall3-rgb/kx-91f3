#!/bin/bash
# Build a distributable macOS installer package (for the download page).
#   bash make-pkg.sh --api https://<project>.pages.dev/api
# (The helper's control token is generated on each Mac at install; --token is accepted and ignored,
#  so one package never carries a token shared by every student.)
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
[ -n "$API" ] || { echo "need --api"; exit 1; }
: "$TOKEN"   # ignored (kept for old build commands)

ROOT="$(mktemp -d)"; SCRIPTS="$(mktemp -d)"
DESTREL="Library/Application Support/LOCKqz"
mkdir -p "$ROOT/$DESTREL"
cp "$APP/lockqz.sh" "$APP/lockqzd.py" "$APP/lockqz-agent.py" "$APP/browser-policy.py" "$APP/blocklist.txt" "$APP/com.lockqz.pf.conf" "$ROOT/$DESTREL/"
[ -f "$APP/lockqz-core.sh" ] && cp "$APP/lockqz-core.sh" "$ROOT/$DESTREL/" || true
cp "$APP/extra-block.sh" "$ROOT/$DESTREL/"   # VPN/VM/remote/overlay/model/Apple Intelligence blockers (sourced by lockqz.sh)
cp "$APP/ensure-python.sh" "$APP/lockqz-boot.sh" "$APP/update.pub" "$APP/install.sh" "$APP/uninstall.sh" "$ROOT/$DESTREL/"   # python repair, launchd entry, release key, (un)installer
chmod 755 "$ROOT/$DESTREL"/*.sh "$ROOT/$DESTREL"/*.py
VERSION="$(tr -d '[:space:]' < "$APP/../VERSION" 2>/dev/null || echo 0.0.0)"
/usr/bin/python3 - "$ROOT/$DESTREL/config.json" "$API" <<'PY'
import json,sys
json.dump({"port":8787,"api_base":sys.argv[2],
          "device_id":"set-at-install","student":None},
          open(sys.argv[1],"w"), indent=2)
PY

# postinstall: give this install a device id, register the daemon, load it.
cat > "$SCRIPTS/postinstall" <<'POST'
#!/bin/bash
DEST="/Library/Application Support/LOCKqz"
PLIST="/Library/LaunchDaemons/com.lockqz.helper.plist"
DEVICE="mac-$(/usr/bin/uuidgen | tr 'A-Z' 'a-z')"
# Code in here runs as root: the folder and every file must be root's and not writable by others.
chown -R root:wheel "$DEST"; chmod 755 "$DEST"; chmod -R go-w "$DEST"
rm -rf "$DEST/.prev" "$DEST/.pending" "$DEST/.bad_version"   # never inherit an old update's rollback state
# Fresh Mac: install Apple's tools so python3 really runs. If that fails the helper is still set up (its
# boot script retries, and it gives itself a device id), but the installer reports the failure.
PY_OK=1; bash "$DEST/ensure-python.sh" || PY_OK=0
# Keep an existing device id on a reinstall/upgrade (its key is registered with the server).
/usr/bin/python3 - "$DEST/config.json" "$DEVICE" "$DEST/config.prev.json" <<'PY'
import json,sys
p=sys.argv[1]; c=json.load(open(p))
try: prev=json.load(open(sys.argv[3])).get("device_id","")
except Exception: prev=""
c["device_id"]=prev if str(prev).startswith("mac-") else sys.argv[2]
c.pop("token", None)
json.dump(c,open(p,"w"),indent=2)
PY
chmod 644 "$DEST/config.json"; rm -f "$DEST/config.prev.json"
# Loopback control token: random per install, root-only (the helper shares a read-only copy with the
# logged-in user). Never in the package.
[ -s "$DEST/helper.token" ] || ( umask 077; /usr/bin/openssl rand -hex 32 > "$DEST/helper.token" )
chown root:wheel "$DEST/helper.token"; chmod 600 "$DEST/helper.token"
if ! grep -q 'anchor "com.lockqz"' /etc/pf.conf; then
  [ -n "$(tail -c1 /etc/pf.conf 2>/dev/null)" ] && echo "" >> /etc/pf.conf   # ensure a trailing newline first
  echo 'anchor "com.lockqz"' >> /etc/pf.conf
  pfctl -f /etc/pf.conf 2>/dev/null || true
fi
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
</dict></plist>
AG
chown root:wheel "$AGENT"; chmod 644 "$AGENT"
CUID="$(stat -f %u /dev/console 2>/dev/null || echo 0)"
if [ "$CUID" != "0" ]; then
  launchctl bootout "gui/$CUID" "$AGENT" 2>/dev/null || true
  launchctl bootstrap "gui/$CUID" "$AGENT" 2>/dev/null || launchctl asuser "$CUID" launchctl load -w "$AGENT" 2>/dev/null || true
fi
if [ "$PY_OK" = 0 ]; then
  echo "LOCKqz: Apple's Command Line Tools could not be installed. Run: xcode-select --install, then this installer again."
  exit 1
fi
exit 0
POST
chmod +x "$SCRIPTS/postinstall"
# preinstall: the payload replaces config.json, so keep the old one for postinstall (an upgrade keeps
# this Mac's device id, whose key the server already knows).
cat > "$SCRIPTS/preinstall" <<'PRE'
#!/bin/bash
DEST="/Library/Application Support/LOCKqz"
[ -f "$DEST/config.json" ] && [ ! -L "$DEST/config.json" ] && cp -p "$DEST/config.json" "$DEST/config.prev.json"
exit 0
PRE
chmod +x "$SCRIPTS/preinstall"

pkgbuild --root "$ROOT" --scripts "$SCRIPTS" --identifier com.lockqz.helper \
  --version "$VERSION" --install-location / "$OUT"
rm -rf "$ROOT" "$SCRIPTS"
echo "Built: $OUT  (unsigned — sign + notarize per the header before distributing)"
