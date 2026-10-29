#!/bin/bash
# LOCKqz Linux installer (Ubuntu / Debian / Fedora / Arch - anything with systemd and python3).
#   curl -fsSL https://lockqz.pages.dev/install-linux.sh | sudo bash
# Fetches the signed release (same key as the Mac), installs the root helper (lockqzd.service) and the
# per-user agent (lockqz-agent.service, a user unit enabled for every account), writes the device config,
# then opens the pay page. Re-running updates in place and keeps the device id.
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo /nonexistent)"
DEST="${LOCKQZ_DEST:-/usr/local/lib/lockqz}"
STATE="${LOCKQZ_STATE:-/var/lib/lockqz}"
SITE="${LOCKQZ_SITE:-https://lockqz.pages.dev}"
API=""; STUDENT=""; FETCH_ONLY=""
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
FILES=(lockqz.sh lockqz-core.sh lockqzd.py lockqz-agent.py agent-mac.py browser-policy.py policy-mac.py blocklist.txt install.sh uninstall.sh update.pub)

while [ $# -gt 0 ]; do case "$1" in
  --api) API="$2"; shift 2;; --student) STUDENT="$2"; shift 2;; --fetch-only) FETCH_ONLY="$2"; shift 2;; *) shift;;
esac; done
[ -n "$FETCH_ONLY" ] || [ "$(id -u)" = 0 ] || { echo "Run with sudo:  sudo bash install.sh"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "LOCKqz: python3 is needed (sudo apt install python3)."; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "LOCKqz: systemd is needed."; exit 1; }

# Remote mode: nothing next to this script -> fetch the signed release from the site.
# Local mode = a fetched release (lockqzd.py next to this script) or a source checkout (app/linux + app/mac).
if { [ ! -f "$APP/lockqzd.py" ] && [ ! -f "$APP/../mac/lockqzd.py" ]; } || [ -n "$FETCH_ONLY" ]; then
  echo "== fetching LOCKqz from $SITE =="
  WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
  printf '%s\n' "$UPDATE_PUB" > "$WORK/update.pub"
  curl -fsSL -o "$WORK/update.json" "$SITE/download/update.json"
  curl -fsSL "$SITE/download/update.sig" | base64 -d > "$WORK/update.sig"
  openssl dgst -sha256 -verify "$WORK/update.pub" -signature "$WORK/update.sig" "$WORK/update.json" >/dev/null 2>&1 \
    || { echo "LOCKqz: release signature is INVALID - not installing. Tell your professor."; exit 1; }
  mkdir -p "$WORK/files"
  python3 - "$WORK/update.json" > "$WORK/list" <<'PY'
import json,sys,re
m=json.load(open(sys.argv[1])); f=(m.get("linux") or {}).get("files") or {}
for n,h in sorted(f.items()):
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,80}",n) and re.fullmatch(r"[0-9a-f]{64}",h): print(n,h)
PY
  grep -q '^lockqzd.py ' "$WORK/list" || { echo "LOCKqz: release manifest has no Linux helper - not installing."; exit 1; }
  while read -r NAME WANT; do
    curl -fsSL -o "$WORK/files/$NAME" "$SITE/download/linux/$NAME"
    GOT="$(sha256sum "$WORK/files/$NAME" | cut -d' ' -f1)"
    [ "$GOT" = "$WANT" ] || { echo "LOCKqz: $NAME failed its integrity check - not installing."; exit 1; }
  done < "$WORK/list"
  cp "$WORK/update.pub" "$WORK/files/update.pub"
  if [ -n "$FETCH_ONLY" ]; then mkdir -p "$FETCH_ONLY"; cp "$WORK/files"/* "$FETCH_ONLY/"; echo "fetched $(wc -l < "$WORK/list") files (signature + hashes OK)"; exit 0; fi
  APP="$WORK/files"
fi
[ -n "$API" ] || API="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("api_base",""))' "$DEST/config.json" 2>/dev/null || true)"
[ -n "$API" ] || API="$SITE/api"

DEVICE="linux-$(cat /proc/sys/kernel/random/uuid)"
OLD_DEV="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("device_id",""))' "$DEST/config.json" 2>/dev/null || true)"
case "$OLD_DEV" in linux-*) DEVICE="$OLD_DEV";; esac   # a reinstall keeps this computer's device id
echo "== installing LOCKqz helper =="
systemctl stop lockqzd.service 2>/dev/null || true
[ -L "$DEST" ] && rm -f "$DEST"
mkdir -p "$DEST" "$STATE" "$STATE/tokens"; chown root:root "$DEST" "$STATE" "$STATE/tokens"; chmod 755 "$DEST" "$STATE" "$STATE/tokens"
for f in "${FILES[@]}"; do [ -f "$APP/$f" ] && cp "$APP/$f" "$DEST/$f"; done
# A source checkout (app/linux) keeps the shared files in app/mac: copy them under their installed names.
[ -f "$DEST/agent-mac.py" ]  || cp "$APP/../mac/lockqz-agent.py" "$DEST/agent-mac.py"
[ -f "$DEST/policy-mac.py" ] || cp "$APP/../mac/browser-policy.py" "$DEST/policy-mac.py"
[ -f "$DEST/lockqzd.py" ]    || cp "$APP/../mac/lockqzd.py" "$DEST/lockqzd.py"
[ -f "$DEST/lockqz-core.sh" ] || cp "$APP/../mac/lockqz-core.sh" "$DEST/lockqz-core.sh"
[ -f "$DEST/blocklist.txt" ] || cp "$APP/../mac/blocklist.txt" "$DEST/blocklist.txt"
[ -f "$DEST/update.pub" ]    || cp "$APP/../mac/update.pub" "$DEST/update.pub"
chown -R root:root "$DEST"; chmod -R go-w "$DEST"; chmod 755 "$DEST"/*.sh "$DEST"/*.py
python3 - "$DEST/config.json" "$API" "$DEVICE" "$STUDENT" <<'PY'
import json,sys
path,api,dev,student=sys.argv[1:5]
json.dump({"port":8787,"api_base":api,"device_id":dev,"student":student or None}, open(path,"w"), indent=2)
PY
chmod 644 "$DEST/config.json"
[ -s "$STATE/helper.token" ] || ( umask 077; openssl rand -hex 32 > "$STATE/helper.token" )
chown root:root "$STATE/helper.token"; chmod 600 "$STATE/helper.token"
TOKEN="$(cat "$STATE/helper.token")"

# Desktop helpers for the agent's dialogs (best effort, never fatal).
if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y -qq zenity libnotify-bin wl-clipboard xclip >/dev/null 2>&1 || true
elif command -v dnf >/dev/null 2>&1; then dnf install -y -q zenity libnotify wl-clipboard xclip >/dev/null 2>&1 || true
elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm --needed zenity libnotify wl-clipboard xclip >/dev/null 2>&1 || true; fi

cat > /etc/systemd/system/lockqzd.service <<EOF
[Unit]
Description=LOCKqz helper (locks AI during Brightspace quizzes)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/env python3 $DEST/lockqzd.py
Restart=always
RestartSec=3
Environment=LOCKQZ_PLATFORM=linux
Environment=LOCKQZ_CONFIG=$DEST/config.json
Environment=LOCKQZ_KEY_PATH=$STATE/device.key
Environment=LOCKQZ_LOCKFILE=$STATE/active_lock.json
Environment=LOCKQZ_TOKEN_FILE=$STATE/helper.token
Environment=LOCKQZ_TOKEN_DIR=$STATE/tokens
Environment=STATE=$STATE
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF
mkdir -p /etc/systemd/user
cat > /etc/systemd/user/lockqz-agent.service <<EOF
[Unit]
Description=LOCKqz agent (quiz detection + password)
After=graphical-session.target

[Service]
Type=simple
ExecStart=/usr/bin/env python3 $DEST/lockqz-agent.py
Restart=always
RestartSec=5
Environment=LOCKQZ_CONFIG=$DEST/config.json
Environment=LOCKQZ_TOKEN_DIR=$STATE/tokens
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=default.target
EOF
systemctl daemon-reload
systemctl enable --now lockqzd.service >/dev/null 2>&1 || systemctl restart lockqzd.service
systemctl --global enable lockqz-agent.service >/dev/null 2>&1 || true
# Start the agent for everyone logged in now.
for uid in $(loginctl list-users --no-legend 2>/dev/null | awk '{print $1}'); do
  [ "$uid" -ge 1000 ] 2>/dev/null || continue
  systemctl --machine="$uid@" --user restart lockqz-agent.service >/dev/null 2>&1 \
    || su -s /bin/sh "$(id -nu "$uid")" -c "XDG_RUNTIME_DIR=/run/user/$uid systemctl --user restart lockqz-agent.service" >/dev/null 2>&1 || true
done
sleep 2
echo ""
echo "Installed. Device id: $DEVICE"
echo "Helper status:"; curl -s -m 4 -H "X-LOCKqz-Token: $TOKEN" http://127.0.0.1:8787/status || echo "  (helper still starting - journalctl -u lockqzd)"
echo ""
echo "Done. Open a Brightspace quiz - LOCKqz asks your school email once, then locks AI automatically."
# Last step: the semester fee page (it says "nothing to pay" when no fee is on). LOCKQZ_NO_BROWSER=1 skips it (CI).
if [ -z "${LOCKQZ_NO_BROWSER:-}" ]; then
  U="$(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $3}' | head -1)"
  case "$U" in ""|root) ;; *) su -s /bin/sh "$U" -c "DISPLAY=\${DISPLAY:-:0} xdg-open '$SITE/pay'" >/dev/null 2>&1 & ;; esac
fi
