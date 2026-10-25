#!/bin/bash
# Fill public/ with the release files exactly like CI's deploy job does, from your own Mac (when CI
# minutes are out). deploy.sh refuses to publish without them.
#   1. installers: keeps public/download/lockqz-mac.pkg / lockqz-win.exe if you put new ones there,
#      else reuses the live ones from lockqz.pages.dev; either way checks they are real (magic bytes)
#   2. the signed self-update manifest (update.json + update.sig + helper files) for app/VERSION,
#      signed with the release key and checked against app/mac/update.pub
#   3. the one-line installers / uninstallers at the site root
# Usage:  bash release-local.sh   [LQZ_UPDATE_KEY=<pem>]     then:  bash deploy.sh
set -e
cd "$(dirname "$0")"
KEY="${LQZ_UPDATE_KEY:-$HOME/Projects/LOCKqz/.secrets/update_key.pem}"
[ -r "$KEY" ] || { echo "Release-signing key not found: $KEY  (set LQZ_UPDATE_KEY=<path>)"; exit 1; }
d=public/download; mkdir -p "$d"
get(){ local f="$1" m="$2"
  if [ ! -s "$d/$f" ]; then
    curl -fsSL -A "LOCKqz/release-local" -o "$d/$f.part" "https://lockqz.pages.dev/download/$f" && mv "$d/$f.part" "$d/$f"
    echo "  reused the live $f"
  else echo "  using public/download/$f"; fi
  [ "$(head -c ${#m} "$d/$f")" = "$m" ] || { echo "  $d/$f is not a real installer (got $(head -c 16 "$d/$f" | od -An -c | tr -s ' '))"; rm -f "$d/$f"; exit 1; }
}
echo "== installers =="
get lockqz-mac.pkg 'xar!'
get lockqz-win.exe 'MZ'
echo "== signed update manifest =="
python3 ../release/make-manifest.py --key "$KEY" --out "$d"
t=$(mktemp); openssl base64 -d -A -in "$d/update.sig" -out "$t"
openssl dgst -sha256 -verify ../mac/update.pub -signature "$t" "$d/update.json" >/dev/null || { rm -f "$t"; echo "update.sig does not verify with mac/update.pub"; exit 1; }
rm -f "$t"
echo "== one-line installers =="
cp ../mac/install.sh ../mac/uninstall.sh ../windows/install.ps1 ../windows/uninstall.ps1 public/
echo "Release v$(tr -d '[:space:]' < ../VERSION) ready in public/. Next: bash deploy.sh"
