#!/usr/bin/env bash
# LOCKqz API on a plain server: set a fresh Ubuntu machine up (22.04 or 24.04, Arm or x86), or bring one
# that is already set up to the newest code.   sudo bash setup.sh
# Installs Node (from nodejs.org, checksum verified), a "lockqz" system user, the code in /opt/lockqz, and
# the lockqz-api service listening on 127.0.0.1 only. Opens no port. Safe to run again.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo: sudo bash setup.sh"; exit 1; }
REPO="${LOCKQZ_REPO:-https://github.com/anthonythomashall3-rgb/kx-91f3}"
DIR=/opt/lockqz; SRV="$DIR/app/server"; NODE_LINE=22
say(){ printf '\n== %s\n' "$*"; }

say "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y -q >/dev/null
apt-get install -y -q git curl ca-certificates xz-utils >/dev/null

say "Node $NODE_LINE"
have=0; if command -v /usr/local/bin/node >/dev/null; then /usr/local/bin/node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>$NODE_LINE||(a==$NODE_LINE&&b>=5)?0:1)" && have=1 || true; fi
if [ "$have" = 0 ]; then
  case "$(uname -m)" in aarch64|arm64) A=arm64;; x86_64) A=x64;; *) echo "unsupported processor: $(uname -m)"; exit 1;; esac
  T="$(mktemp -d)"; B="https://nodejs.org/dist/latest-v$NODE_LINE.x"
  curl -fsSL "$B/SHASUMS256.txt" -o "$T/sums"
  F="$(grep -o "node-v[0-9.]*-linux-$A\.tar\.xz" "$T/sums" | head -1)"; [ -n "$F" ] || { echo "no Node build found for linux-$A"; exit 1; }
  curl -fsSL "$B/$F" -o "$T/$F"
  ( cd "$T" && grep " $F\$" sums | sha256sum -c - >/dev/null ) || { echo "Node download does not match its checksum"; exit 1; }
  tar -xJf "$T/$F" -C /usr/local --strip-components=1 --no-same-owner
  rm -rf "$T"
fi
/usr/local/bin/node --version

say "user and code"
id lockqz >/dev/null 2>&1 || useradd --system --home-dir "$DIR" --shell /usr/sbin/nologin lockqz
if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch -q origin master && git -C "$DIR" reset -q --hard origin/master
else rm -rf "$DIR"; git clone -q --depth 1 "$REPO" "$DIR"; fi
git config --system --add safe.directory "$DIR" 2>/dev/null || true
echo "code: $(git -C "$DIR" log -1 --format='%h %s' | cut -c1-90)"
mkdir -p "$SRV/data"; chown -R lockqz:lockqz "$SRV/data"; chmod 700 "$SRV/data"
if [ ! -f "$SRV/lockqz.env" ]; then
  # Until the real settings file is put in place the server runs with test settings and no secrets.
  printf 'PORT=8787\nBIND=127.0.0.1\nTRUST_PROXY=1\nWORKERS=auto\nSNAPSHOT_MIN=15\nSNAPSHOT_KEEP=8\nREQUIRE_SIGNED=1\n' > "$SRV/lockqz.env"
  echo "lockqz.env: created with no secrets - the API answers 503 not_configured until they are filled in"
fi
chown root:lockqz "$SRV/lockqz.env"; chmod 640 "$SRV/lockqz.env"

# A small machine (1 GB) gets a swap file so a burst never runs it out of memory.
if [ "$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)" -lt 2000 ] && ! swapon --show | grep -q .; then
  say "swap"
  if fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile; then
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  else rm -f /swapfile; echo "no swap file (this disk does not take one); carrying on"; fi
fi

say "service"
install -m 644 "$SRV/lockqz-api.service" /etc/systemd/system/lockqz-api.service
systemctl daemon-reload
systemctl enable -q lockqz-api
systemctl restart lockqz-api
for i in $(seq 1 30); do sleep 1; if out="$(curl -fsS -m 3 http://127.0.0.1:8787/healthz 2>/dev/null)"; then echo "healthy: $out" | cut -c1-200; exit 0; fi; done
echo "the service did not answer; last lines:"; journalctl -u lockqz-api -n 30 --no-pager || true; exit 1
