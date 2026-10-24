#!/bin/bash
# LOCKqz macOS installer. Installs the root helper (blocks AI) and the per-user agent
# (detects the Brightspace quiz). ONE install, no browser extension, no Web Store.
# Run from the mac/ folder:   sudo bash install.sh
# Reads token/api from mac/config.json if present, else from --token/--api or prompts.
# Uninstall any time:          sudo bash uninstall.sh
#
# ONE-LINE INSTALL (no download, no Gatekeeper warning - the $0 path):
#     curl -fsSL https://lockqz.pages.dev/install.sh | sudo bash
# With no files next to it, this script fetches the current release from the site, checks the
# release manifest's RSA signature against the key below and every file's SHA-256, then installs.
set -e
APP="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
DEST="/Library/Application Support/LOCKqz"
PLIST="/Library/LaunchDaemons/com.lockqz.helper.plist"
AGENT="/Library/LaunchAgents/com.lockqz.agent.plist"
STUDENT=""; TOKEN=""; API=""
SITE="${LOCKQZ_SITE:-https://lockqz.pages.dev}"
# LOCKqz release-signing public key (same as mac/update.pub). Releases are signed in CI.
read -r -d '' UPDATE_PUB <<'PEM' || true
-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEApiWuG94l1Cz1wYheWVdC
fgcSV3WVMDyacyssa/QBWs0OYVMxmjXhWWrBlJswqfVw2+BAyDhnAQ774tjJENkr
N8YP8hAc6CPPP+Nmz4PHhZZNT7kJdHeCSRAlWe+65YO/JN1KvKqjB4OZOp/zEjqT
tfVKTKltqVrewNAfqfdhnXp76k1839vLjsIyQGHjfWnTRUX8coRrWWcxEmXUhuBy
ZSaXloYjac0lr/za6P3lo95GHerqWWRwavLLqbIKUeClvRMv9mmts6ijdJRsWnYV
SCo0jlJ4RyE8FyFd7XA24wCCVUJv4xhxfvH11zkHwT05K6tb1HZAJvwF8MoCdSyX
P2ObtSW8EWt0NejK0KOkJhbiA4umfBpaJmcdECu1OTxGN0VNJHfUPpluDc5OK5qM
r4BD1aDvg2xUpWn+sRxdskQPvbL0fC59hhGmkM7dLRat9Q08h2TDdxnVnpcTDjms
/ewkWcV1hOiMr8LxliOQpaNDRucB6ZRIcookWq+pzpoLAgMBAAE=
-----END PUBLIC KEY-----
PEM

while [ $# -gt 0 ]; do case "$1" in
  --token) TOKEN="$2"; shift 2;;
  --api)   API="$2";   shift 2;;
  --student) STUDENT="$2"; shift 2;;
  --fetch-only) FETCH_ONLY="$2"; shift 2;;   # download + verify the release into a folder, install nothing (tests)
  *) shift;;
esac; done

[ -n "${FETCH_ONLY:-}" ] || [ "$(id -u)" = "0" ] || { echo "Run with sudo:  sudo bash install.sh"; exit 1; }

# Remote mode: nothing next to this script -> fetch the signed release from the site.
if [ ! -f "$APP/lockqzd.py" ] || [ -n "${FETCH_ONLY:-}" ]; then
  echo "== fetching LOCKqz from $SITE =="
  WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
  printf '%s\n' "$UPDATE_PUB" > "$WORK/update.pub"
  curl -fsSL -o "$WORK/update.json" "$SITE/download/update.json"
  curl -fsSL "$SITE/download/update.sig" | base64 -d > "$WORK/update.sig"
  openssl dgst -sha256 -verify "$WORK/update.pub" -signature "$WORK/update.sig" "$WORK/update.json" >/dev/null 2>&1 \
    || { echo "LOCKqz: release signature is INVALID - not installing. Tell your professor."; exit 1; }
  mkdir -p "$WORK/files"
  # Parse the manifest without python (python may not work yet on a fresh Mac).
  /usr/bin/sed -E 's/.*"mac":\{"files":\{([^}]*)\}.*/\1/' "$WORK/update.json" | tr ',' '\n' \
    | /usr/bin/grep -E '^"[A-Za-z0-9][A-Za-z0-9._-]{0,80}":"[0-9a-f]{64}"$' \
    | /usr/bin/sed -E 's/^"([^"]+)":"([0-9a-f]{64})"$/\1 \2/' > "$WORK/list"
  grep -q '^lockqzd.py ' "$WORK/list" || { echo "LOCKqz: release manifest has no Mac helper - not installing."; exit 1; }
  while read -r NAME WANT; do
    curl -fsSL -o "$WORK/files/$NAME" "$SITE/download/mac/$NAME"
    GOT="$(shasum -a 256 "$WORK/files/$NAME" | cut -d' ' -f1)"
    [ "$GOT" = "$WANT" ] || { echo "LOCKqz: $NAME failed its integrity check - not installing."; exit 1; }
  done < "$WORK/list"
  cp "$WORK/update.pub" "$WORK/files/update.pub"
  if [ -n "${FETCH_ONLY:-}" ]; then mkdir -p "$FETCH_ONLY"; cp "$WORK/files"/* "$FETCH_ONLY/"; echo "fetched $(wc -l < "$WORK/list") files (signature + hashes OK)"; exit 0; fi
  APP="$WORK/files"; REMOTE=1
  [ -n "$API" ] || API="$SITE/api"
  [ -n "$TOKEN" ] || TOKEN="lqz-$(/usr/bin/uuidgen | tr 'A-Z' 'a-z' | tr -d '-' | cut -c1-20)"
fi

# Pull defaults from an existing config.json next to this script.
CFG="$APP/config.json"
if [ -z "$TOKEN" ] && [ -f "$CFG" ]; then TOKEN="$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("token",""))' "$CFG" 2>/dev/null || true)"; fi
if [ -z "$API" ]   && [ -f "$CFG" ]; then API="$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("api_base",""))' "$CFG" 2>/dev/null || true)"; fi
[ -n "$TOKEN" ] || { read -r -p "Shared token: " TOKEN; }
[ -n "$API" ]   || { read -r -p "API base (e.g. https://<project>.pages.dev/api): " API; }

DEVICE="mac-$(/usr/bin/uuidgen | tr 'A-Z' 'a-z')"
echo "== installing LOCKqz helper =="

mkdir -p "$DEST"
if [ -n "${REMOTE:-}" ]; then
  cp "$APP"/* "$DEST/"
else
  cp "$APP/lockqz.sh" "$APP/lockqz-core.sh" "$APP/extra-block.sh" "$APP/lockqzd.py" "$APP/lockqz-agent.py" "$APP/browser-policy.py" \
     "$APP/blocklist.txt" "$APP/com.lockqz.pf.conf" "$APP/ensure-python.sh" "$APP/lockqz-boot.sh" "$APP/update.pub" "$APP/install.sh" "$APP/uninstall.sh" "$DEST/"
fi
chmod 755 "$DEST"/*.sh "$DEST"/*.py 2>/dev/null || true
# python3 must really work (fresh Macs ship only a stub until Apple's tools are installed).
bash "$DEST/ensure-python.sh"

# Write the device config (merge token/api/device into the example shape).
/usr/bin/python3 - "$DEST/config.json" "$TOKEN" "$API" "$DEVICE" "$STUDENT" <<'PY'
import json,sys
path,token,api,dev,student=sys.argv[1:6]
json.dump({"port":8787,"token":token,"api_base":api,"device_id":dev,
          "student":student or None,"max_minutes":180}, open(path,"w"), indent=2)
PY
chmod 644 "$DEST/config.json"   # the per-user agent reads it (loopback token only)

# Firewall anchor so the pf (encrypted-DNS) layer is evaluated.
if ! grep -q 'anchor "com.lockqz"' /etc/pf.conf; then
  [ -n "$(tail -c1 /etc/pf.conf 2>/dev/null)" ] && echo "" >> /etc/pf.conf   # ensure a trailing newline first
  echo 'anchor "com.lockqz"' >> /etc/pf.conf
  pfctl -f /etc/pf.conf 2>/dev/null || true                                  # make the anchor live now
fi

# LaunchDaemon: start the helper at boot as root.
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.lockqz.helper</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$DEST/lockqz-boot.sh</string></array>
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
