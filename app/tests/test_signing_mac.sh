#!/bin/bash
# Apple Developer ID for the Mac installer: app/release/mac-sign.sh, its release.yml wiring, the download page.
# No Apple account needed: "sign" runs without secrets / without Apple's tools, "status" against a fake live
# site (file://). The real signing + notarization runs on the macOS CI runner once the secrets exist.
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"; S="$ROOT/app/release/mac-sign.sh"
R="$ROOT/.github/workflows/release.yml"; I="$ROOT/app/cloudflare/public/index.html"
pass=0; fail=0
check(){ local d="$1"; shift; if "$@"; then pass=$((pass+1)); echo "  ok   $d"; else fail=$((fail+1)); echo "  FAIL $d"; fi; }
has(){ grep -qF -- "$1" "$2"; }
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
printf 'xar!this-build' > "$T/new.pkg"
run(){ env -i PATH="$PATH" HOME="$T" "$@"; }

echo "M1 sign"
run GITHUB_OUTPUT="$T/o1" bash "$S" sign "$T/new.pkg" > "$T/l1" 2>&1; rc1=$?
c1(){ [ $rc1 = 0 ] && grep -qx "signed=false" "$T/o1" && [ "$(cat "$T/new.pkg")" = "xar!this-build" ]; }
check "no MAC_INSTALLER_P12 -> exit 0, signed=false, package untouched" c1
if ! command -v productsign >/dev/null 2>&1; then
  run GITHUB_OUTPUT="$T/o2" MAC_INSTALLER_P12="bm90LWEtcDEy" MAC_INSTALLER_P12_PASSWORD="pw-SECRET-123" NOTARY_KEY_P8="k-SECRET-456" bash "$S" sign "$T/new.pkg" > "$T/l2" 2>&1; rc2=$?
  c2(){ [ $rc2 = 0 ] && grep -qx "signed=false" "$T/o2" && grep -q "::warning::" "$T/l2" && [ "$(cat "$T/new.pkg")" = "xar!this-build" ]; }
  check "secrets set but no Apple tools -> warning, exit 0, signed=false (never blocks the release)" c2
  c3(){ ! grep -qE "pw-SECRET-123|k-SECRET-456|bm90LWEtcDEy" "$T/l1" "$T/l2"; }
  check "never prints a secret" c3
  run GITHUB_OUTPUT="$T/o5" MAC_SIGNING='{"p12": "bm90LWEtcDEy", "p12_password": "pw-SECRET-789", "notary_key_p8": "k-SECRET-012", "notary_key_id": "KEYID"}' bash "$S" sign "$T/new.pkg" > "$T/l5" 2>&1; rc5=$?
  c5(){ [ $rc5 = 0 ] && grep -qx "signed=false" "$T/o5" && grep -q "no productsign/xcrun here" "$T/l5" && ! grep -q "MAC_INSTALLER_P12 is not set" "$T/l5"; }
  check "one JSON secret (MAC_SIGNING) supplies the certificate + notary key" c5
  run GITHUB_OUTPUT="$T/o6" MAC_SIGNING='not json' bash "$S" sign "$T/new.pkg" > "$T/l6" 2>&1; rc6=$?
  c6(){ [ $rc6 = 0 ] && grep -qx "signed=false" "$T/o6" && grep -q "MAC_SIGNING is not a JSON object" "$T/l6"; }
  check "MAC_SIGNING not JSON -> warning, exit 0, signed=false" c6
  c7(){ ! grep -qE "pw-SECRET-789|k-SECRET-012|bm90LWEtcDEy|not json" "$T/l5" "$T/l6"; }
  check "MAC_SIGNING values are never printed" c7
else echo "  skipped: secrets-set cases (Apple's tools exist here; CI's Linux runner runs them)"; fi
c4(){ ! run bash "$S" sign "$T/nope.pkg" >/dev/null 2>&1; }
check "no package -> error" c4

echo "M2 status (which Mac package ships; fake live site)"
L="$T/live"; mkdir -p "$L/download"; D="$T/dl"; echo "0.7.0" > "$T/VERSION"
st(){ rm -rf "$D"; mkdir -p "$D"; cp "$T/new.pkg" "$D/lockqz-mac.pkg"
      run LOCKQZ_LIVE="file://$L" LOCKQZ_VERSION_FILE="$T/VERSION" MAC_BUILT="$1" MAC_SIGNED="$2" bash "$S" status "$D" > "$T/ls" 2>&1; }
j(){ python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])), sort_keys=True))' "$D/mac.json" 2>/dev/null; }
pkg(){ cat "$D/lockqz-mac.pkg"; }
st success false; c(){ [ "$(j)" = '{"signed": false, "version": "0.7.0"}' ] && [ "$(pkg)" = "xar!this-build" ]; }
check "unsigned build, nothing live -> this build ships, signed false" c
st success true;  c(){ [ "$(j)" = '{"signed": true, "version": "0.7.0"}' ] && [ "$(pkg)" = "xar!this-build" ]; }
check "signed build -> signed true + version" c
st skipped "";    c(){ [ "$(j)" = '{"signed": false}' ]; }
check "not rebuilt, no live status -> signed false" c
printf 'xar!live-signed' > "$L/download/lockqz-mac.pkg"; printf '{"signed": true, "version": "0.6.20"}\n' > "$L/download/mac.json"
st success false; c(){ [ "$(pkg)" = "xar!live-signed" ] && [ "$(j)" = '{"signed": true, "version": "0.6.20"}' ] && grep -q "::warning::" "$T/ls"; }
check "unsigned build while a signed one is live -> the live signed package + its status stay (warned)" c
st skipped "";    c(){ [ "$(j)" = '{"signed": true, "version": "0.6.20"}' ]; }
check "not rebuilt -> live status reused" c
st success true;  c(){ [ "$(pkg)" = "xar!this-build" ] && [ "$(j)" = '{"signed": true, "version": "0.7.0"}' ]; }
check "new signed build replaces the live one" c
printf '<!doctype html><html>' > "$L/download/mac.json"
st success false; c(){ [ "$(pkg)" = "xar!this-build" ] && [ "$(j)" = '{"signed": false, "version": "0.7.0"}' ]; }
check "live mac.json is the site's HTML fallback -> not trusted, this build ships" c
printf '{"signed": true, "version": "0.6.20"}\n' > "$L/download/mac.json"; printf '<html>' > "$L/download/lockqz-mac.pkg"
st success false; c(){ [ "$(pkg)" = "xar!this-build" ] && [ "$(j)" = '{"signed": false, "version": "0.7.0"}' ] && grep -q "::warning::" "$T/ls" && [ ! -e "$D/lockqz-mac.pkg.live" ]; }
check "live 'signed' package is not a real .pkg -> this build ships (warned), no leftovers" c

echo "M3 release.yml + download page"
check "mac job: signs after the install test, before the upload; outputs signed" \
  awk '/test_mac_install.sh/{a=NR} /mac-sign.sh sign \/tmp\/lockqz-mac.pkg/{b=NR} /name: lockqz-mac$/{c=NR} END{exit !(a && a<b && b<c)}' "$R"
check "mac job output wired" has 'signed: ${{ steps.sign.outputs.signed }}' "$R"
c(){ for s in MAC_SIGNING MAC_INSTALLER_P12 MAC_INSTALLER_P12_PASSWORD NOTARY_KEY_P8 NOTARY_KEY_ID NOTARY_ISSUER_ID APPLE_ID APPLE_APP_PASSWORD APPLE_TEAM_ID; do has "$s: \${{ secrets.$s }}" "$R" || return 1; done; }
check "every signing secret reaches the sign step" c
check "deploy: status after the live installers are reused, before deploy.sh" \
  awk '/get lockqz-mac.pkg xar!/{a=NR} /mac-sign.sh status app\/cloudflare\/public\/download/{b=NR} /bash deploy.sh/{c=NR} END{exit !(a && a<b && b<c)}' "$R"
c(){ has 'MAC_BUILT: ${{ needs.mac.result }}' "$R" && has 'MAC_SIGNED: ${{ needs.mac.outputs.signed }}' "$R"; }
check "deploy: status gets the mac job's result + signed output" c
c(){ has 'MAC_SIGN: "${{ secrets.MAC_SIGNING != '"''"' || secrets.MAC_INSTALLER_P12 != ' "$R" && has 'download/mac.json 2>/dev/null | grep -qE' "$R" && has 'echo "mac=$mac" >> "$GITHUB_OUTPUT"' "$R"; }
check "secrets set + live installer not signed -> the Mac build runs by itself" c
check "live check reads mac.json" has 'download/mac.json | python3 -c' "$R"
check "Microsoft Store: a version it already has is not submitted again" has 'Microsoft Store already has $v - nothing to submit' "$R"
c(){ has 'fetch("/download/mac.json", { cache: "no-store" })' "$I" && has 'd.signed !== true' "$I" && has 'Click <b>Continue</b>, then <b>Install</b>. Enter your Mac password.' "$I" && ! has 'macalt' "$I" && has '.then(show, show)' "$I" && has '$("lead").parentNode.hidden = true; $("orline").hidden = true;' "$I"; }
check "page: signed Mac -> the download is the one way shown, command one click away" c
c(){ has 'Open Anyway' "$I" && has '/install.sh | sudo bash' "$I"; }
check "page: unsigned Mac keeps the command + installer as before" c
check "page: installer missing -> the command shows again" has 'if (mac) $("lead").parentNode.hidden = false;' "$I"
check "mac.json is generated by CI, never committed" grep -qx "app/cloudflare/public/download/mac.json" "$ROOT/.gitignore"
c(){ ! grep -nE 'set -x|echo[^|]*\$\{?(MAC_INSTALLER_P12|MAC_INSTALLER_P12_PASSWORD|NOTARY_KEY_P8|APPLE_APP_PASSWORD)\b' "$S"; }
check "script: no xtrace, never echoes a secret" c
check "script parses (bash -n)" bash -n "$S"

echo; echo "RESULT: $pass passed, $fail failed"
[ $fail = 0 ]
