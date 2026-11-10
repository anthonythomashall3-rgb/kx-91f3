#!/bin/bash
# Apple Developer ID for the Mac installer (CI).
#
#   mac-sign.sh sign   <pkg>            sign + notarize + staple <pkg> in place  (mac job, macOS runner)
#   mac-sign.sh status <download-dir>   choose the Mac package that ships, write <dir>/mac.json  (deploy job)
#
# A signed + notarized package opens straight into the installer: no Terminal, no "Open Anyway".
# The download page reads download/mac.json: {"signed": true} = the download is the one way shown on a Mac.
#
# Repo secrets (Settings -> Secrets and variables -> Actions). Simplest: ONE secret, MAC_SIGNING = JSON
#   {"p12": "<base64 .p12>", "p12_password": "...", "notary_key_p8": "<.p8 text>", "notary_key_id": "...",
#    "notary_issuer_id": "..."}  (or "apple_id" / "apple_app_password" / "apple_team_id"); or the separate secrets:
#   MAC_INSTALLER_P12           base64 of a .p12 with the "Developer ID Installer" certificate + its private key
#   MAC_INSTALLER_P12_PASSWORD  the .p12 password
#   Apple notary login, one of:
#     NOTARY_KEY_P8 + NOTARY_KEY_ID (+ NOTARY_ISSUER_ID for a Team key)  App Store Connect API key (.p8 text or base64)
#     APPLE_ID + APPLE_APP_PASSWORD + APPLE_TEAM_ID                      Apple Account + app-specific password
# No MAC_INSTALLER_P12 = "sign" does nothing (signed=false) and the unsigned package ships as before.
# A signing or notarization failure never blocks the release: "status" then keeps the live signed package
# (installed helpers update themselves, so an older signed package still ends on the current release).
# Never prints a secret.
set -uo pipefail

out(){ if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1" >> "$GITHUB_OUTPUT"; fi; return 0; }
warn(){ echo "::warning::$*"; }
b64d(){ python3 -c 'import base64,sys; sys.stdout.buffer.write(base64.b64decode(sys.stdin.read()))'; }
WORK=""; KC=""
cleanup(){ [ -n "$KC" ] && security delete-keychain "$KC" >/dev/null 2>&1; [ -n "$WORK" ] && rm -rf "$WORK"; return 0; }
trap cleanup EXIT
unsigned(){ warn "$1 - this build's Mac package is not Apple-signed"; out signed=false; exit 0; }

sign(){
  local pkg="$1" pw id st sid vars
  [ -s "$pkg" ] || { echo "::error::no package at $pkg"; exit 1; }
  if [ -n "${MAC_SIGNING:-}" ]; then   # one JSON secret -> the separate variables (a separate secret, if set, wins)
    vars="$(printf '%s' "$MAC_SIGNING" | python3 -c 'import json, shlex, sys
d = json.load(sys.stdin); assert isinstance(d, dict)
m = {"p12": "MAC_INSTALLER_P12", "p12_password": "MAC_INSTALLER_P12_PASSWORD", "notary_key_p8": "NOTARY_KEY_P8",
     "notary_key_id": "NOTARY_KEY_ID", "notary_issuer_id": "NOTARY_ISSUER_ID", "apple_id": "APPLE_ID",
     "apple_app_password": "APPLE_APP_PASSWORD", "apple_team_id": "APPLE_TEAM_ID"}
for k, v in m.items():
    if isinstance(d.get(k), str) and d[k]: print("[ -n \"${%s:-}\" ] || %s=%s" % (v, v, shlex.quote(d[k])))' 2>/dev/null)" \
      || unsigned "MAC_SIGNING is not a JSON object"
    eval "$vars"
  fi
  if [ -z "${MAC_INSTALLER_P12:-}" ]; then
    echo "Mac package not Apple-signed: secret MAC_INSTALLER_P12 is not set (the unsigned package ships)"; out signed=false; exit 0; fi
  command -v productsign >/dev/null 2>&1 && command -v xcrun >/dev/null 2>&1 || unsigned "no productsign/xcrun here (macOS runner needed)"
  WORK="$(mktemp -d)"; KC="$WORK/lockqz-sign.keychain-db"; pw="$(openssl rand -hex 24)"
  ( umask 077; printf '%s' "$MAC_INSTALLER_P12" | b64d > "$WORK/inst.p12" ) 2>/dev/null && [ -s "$WORK/inst.p12" ] || unsigned "MAC_INSTALLER_P12 is not base64"
  security create-keychain -p "$pw" "$KC" && security set-keychain-settings -lut 3600 "$KC" && security unlock-keychain -p "$pw" "$KC" \
    && security import "$WORK/inst.p12" -k "$KC" -P "${MAC_INSTALLER_P12_PASSWORD:-}" -T /usr/bin/productsign >/dev/null \
    && security set-key-partition-list -S apple-tool:,apple:,productsign: -s -k "$pw" "$KC" >/dev/null \
    || unsigned "the Developer ID Installer certificate did not load (wrong .p12 or password?)"
  rm -f "$WORK/inst.p12"
  # shellcheck disable=SC2046
  security list-keychains -d user -s "$KC" $(security list-keychains -d user | tr -d '"')
  id="$(security find-identity -v -p basic "$KC" | sed -n 's/.*"\(Developer ID Installer: [^"]*\)".*/\1/p' | head -1)"
  [ -n "$id" ] || unsigned "the .p12 holds no valid 'Developer ID Installer' identity"
  echo "signing with: $id"
  productsign --sign "$id" --keychain "$KC" --timestamp "$pkg" "$WORK/signed.pkg" || unsigned "productsign failed"
  pkgutil --check-signature "$WORK/signed.pkg" | head -8

  local auth=()
  if [ -n "${NOTARY_KEY_P8:-}" ] && [ -n "${NOTARY_KEY_ID:-}" ]; then
    if printf '%s' "$NOTARY_KEY_P8" | grep -q "BEGIN PRIVATE KEY"; then ( umask 077; printf '%s\n' "$NOTARY_KEY_P8" > "$WORK/key.p8" )
    else ( umask 077; printf '%s' "$NOTARY_KEY_P8" | b64d > "$WORK/key.p8" ) 2>/dev/null || unsigned "NOTARY_KEY_P8 is neither a .p8 key nor base64"; fi
    auth=(--key "$WORK/key.p8" --key-id "$NOTARY_KEY_ID"); [ -n "${NOTARY_ISSUER_ID:-}" ] && auth+=(--issuer "$NOTARY_ISSUER_ID")
  elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
    auth=(--apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" --team-id "$APPLE_TEAM_ID")
  else unsigned "no Apple notary login (NOTARY_KEY_P8 + NOTARY_KEY_ID, or APPLE_ID + APPLE_APP_PASSWORD + APPLE_TEAM_ID)"; fi

  xcrun notarytool submit "$WORK/signed.pkg" "${auth[@]}" --wait --timeout 45m --output-format json > "$WORK/n.json" 2> "$WORK/n.err"
  st="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status",""))' "$WORK/n.json" 2>/dev/null)"
  sid="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("id",""))' "$WORK/n.json" 2>/dev/null)"
  echo "notarization: ${st:-no answer} ${sid}"
  if [ "$st" != "Accepted" ]; then
    head -20 "$WORK/n.err"; [ -n "$sid" ] && xcrun notarytool log "$sid" "${auth[@]}" 2>&1 | head -60
    unsigned "Apple did not notarize the package (${st:-no answer}; an Apple agreement to accept at developer.apple.com is a common cause)"; fi
  xcrun stapler staple "$WORK/signed.pkg" && xcrun stapler validate "$WORK/signed.pkg" || unsigned "stapling the notarization ticket failed"
  spctl --assess --type install -vv "$WORK/signed.pkg" > "$WORK/gk.txt" 2>&1; cat "$WORK/gk.txt"   # "accepted / source=Notarized Developer ID"
  grep -q "rejected" "$WORK/gk.txt" && unsigned "Gatekeeper rejects the signed package"
  cp "$WORK/signed.pkg" "$pkg"
  out signed=true; echo "Mac package Apple-signed, notarized and stapled"
}

status(){
  local d="$1" live="${LOCKQZ_LIVE:-https://lockqz.pages.dev}" v lj
  v="$(tr -d '[:space:]' < "${LOCKQZ_VERSION_FILE:-app/VERSION}")"
  livejson(){ curl -fsS -m 20 -A "LOCKqz/ci" "$live/download/mac.json" 2>/dev/null \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); assert isinstance(d, dict) and isinstance(d.get("signed"), bool); print(json.dumps(d))' 2>/dev/null; }
  if [ "${MAC_BUILT:-}" = success ] && [ "${MAC_SIGNED:-}" = true ]; then
    printf '{"signed": true, "version": "%s"}\n' "$v" > "$d/mac.json"; echo "Mac installer: Apple-signed ($v, this build)"; return 0; fi
  lj="$(livejson || true)"
  if [ "${MAC_BUILT:-}" = success ]; then
    # This build's package is not Apple-signed. If a signed one is live, it stays: no Mac gets the detour back.
    if printf '%s' "$lj" | grep -q '"signed": true'; then
      if curl -fsS -m 300 -A "LOCKqz/ci" -o "$d/lockqz-mac.pkg.live" "$live/download/lockqz-mac.pkg" && [ "$(head -c 4 "$d/lockqz-mac.pkg.live")" = 'xar!' ]; then
        mv "$d/lockqz-mac.pkg.live" "$d/lockqz-mac.pkg"; printf '%s\n' "$lj" > "$d/mac.json"
        warn "this build's Mac package is not Apple-signed: kept the live signed one ($lj); it updates itself to $v after install"; return 0; fi
      rm -f "$d/lockqz-mac.pkg.live"; warn "could not fetch the live signed Mac package: this build's unsigned one ships"; fi
    printf '{"signed": false, "version": "%s"}\n' "$v" > "$d/mac.json"; echo "Mac installer: not Apple-signed ($v)"; return 0; fi
  # Not rebuilt: the live package was reused, and so is its status.
  if [ -n "$lj" ]; then printf '%s\n' "$lj" > "$d/mac.json"; echo "Mac installer: reused live ($lj)"
  else printf '{"signed": false}\n' > "$d/mac.json"; echo "Mac installer: reused live (no status yet = not Apple-signed)"; fi
}

case "${1:-}" in
  sign)   sign "${2:?usage: mac-sign.sh sign <pkg>}" ;;
  status) status "${2:?usage: mac-sign.sh status <download-dir>}" ;;
  *) echo "usage: mac-sign.sh sign <pkg> | status <download-dir>"; exit 2 ;;
esac
