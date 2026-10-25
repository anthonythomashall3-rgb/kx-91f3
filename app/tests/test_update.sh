#!/bin/bash
# Signed self-update, end to end: the REAL macOS daemon (dry-run) against a mock release site.
# Proves: a correctly signed newer release is downloaded, hash-checked, swapped in and the daemon
# restarts; a bad signature, a bad hash, a forbidden file name, an equal version, a quiz in
# progress, or a source checkout all leave the install untouched.
# No root, no system changes, no external network. Needs openssl (ships with macOS and Linux).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
TMP="$(mktemp -d)"
TOKEN="utest-token-0123456789abcdef"
pass=0; fail=0
ok(){ pass=$((pass+1)); echo "  ok: $1"; }
bad(){ fail=$((fail+1)); echo "  FAIL: $1"; }
PIDS=""
cleanup(){ for p in $PIDS; do kill "$p" 2>/dev/null; done; rm -rf "$TMP"; }
trap cleanup EXIT
free_port(){ python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
sha(){ python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }

# --- keys: the "real" release key and an attacker's key ---
openssl genrsa -out "$TMP/good.pem" 2048 2>/dev/null; openssl rsa -in "$TMP/good.pem" -pubout -out "$TMP/good.pub" 2>/dev/null
openssl genrsa -out "$TMP/evil.pem" 2048 2>/dev/null

# --- mock site: GET serves files under $SITE, every POST (register/report) answers ok ---
cat > "$TMP/mock.py" <<'PY'
import sys, json, os
from http.server import SimpleHTTPRequestHandler, HTTPServer
PORT, ROOT, LOG = int(sys.argv[1]), sys.argv[2], sys.argv[3]
class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0) or 0); raw = self.rfile.read(n) if n else b"{}"
        open(LOG, "a").write(self.path + " " + raw.decode("utf-8", "ignore") + "\n")
        b = b'{"ok": true}'
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
HTTPServer(("127.0.0.1", PORT), H).serve_forever()
PY
SITE="$TMP/site"; mkdir -p "$SITE/download/mac"
MOCK_PORT=$(free_port)
python3 "$TMP/mock.py" "$MOCK_PORT" "$SITE" "$TMP/posts.log" & PIDS="$PIDS $!"
for i in $(seq 1 20); do curl -s -o /dev/null -m 1 "http://127.0.0.1:$MOCK_PORT/" && break; sleep 0.25; done

# --- a "new release": the real files with the version bumped, plus one brand-new file ---
NEW="$TMP/new"; mkdir -p "$NEW"
sed 's/^VERSION = ".*"/VERSION = "9.9.9"/' "$APP/mac/lockqzd.py" > "$NEW/lockqzd.py"
cp "$APP/mac/lockqz-agent.py" "$NEW/lockqz-agent.py"
printf '#!/bin/bash\necho new helper file\n' > "$NEW/new-tool.sh"
publish(){   # $1 version  $2 signing key  $3 "" | "badhash" | "forbidden"
  rm -rf "$SITE/download/mac"; mkdir -p "$SITE/download/mac"; cp "$NEW"/* "$SITE/download/mac/"
  python3 - "$1" "$SITE" "$3" <<'PY'
import sys, json, hashlib, os
ver, site, mode = sys.argv[1:4]
files = {}
for n in sorted(os.listdir(site + "/download/mac")):
    files[n] = hashlib.sha256(open(site + "/download/mac/" + n, "rb").read()).hexdigest()
if mode == "badhash": files["lockqzd.py"] = "0" * 64
if mode == "forbidden": files["config.json"] = "1" * 64
m = {"version": ver, "mac": {"files": files}, "windows": {"files": {}}}
open(site + "/download/update.json", "w").write(json.dumps(m, sort_keys=True))
PY
  openssl dgst -sha256 -sign "$2" -out "$TMP/sig.bin" "$SITE/download/update.json"
  base64 < "$TMP/sig.bin" | tr -d '\n' > "$SITE/download/update.sig"
}

# --- an "installed" helper: a copy of the real files in its own folder ---
fresh_install(){   # $1 dir
  rm -rf "$1"; mkdir -p "$1"; cp "$APP/mac/"*.py "$APP/mac/"*.sh "$APP/mac/blocklist.txt" "$1/"
  cp "$TMP/good.pub" "$1/update.pub"; printf %s "$TOKEN" > "$1/helper.token"
  cat > "$1/config.json" <<CFG
{ "port": $2, "token": "$TOKEN", "api_base": "http://127.0.0.1:$MOCK_PORT", "device_id": "utest-dev", "student": "T", "max_minutes": 180 }
CFG
}
start_daemon(){   # $1 install dir  $2 ctrl port  [$3 extra env]  -> DPID_
  env LOCKQZ_TOKEN_FILE="$1/helper.token" LOCKQZ_TOKEN_DIR="$1/tokens" LOCKQZ_NO_DEVMODE=1 LOCKQZ_DRYRUN=1 LOCKQZ_CONFIG="$1/config.json" LOCKQZ_KEY_PATH="$1/device.key" \
      LOCKQZ_LOCKFILE="$1/active_lock.json" LOCKQZ_BLOCKLIST="$1/blocklist.txt" LOCKQZ_UPDATE_DELAY=1 \
      LOCKQZ_UPDATE_DIR="$1" LOCKQZ_UPDATE_PUB="$1/update.pub" ${3:-} \
      python3 "$1/lockqzd.py" >"$1/daemon.log" 2>&1 & DPID_=$!
  PIDS="$PIDS $DPID_"
  for i in $(seq 1 20); do curl -s -m 2 -H "X-LOCKqz-Token: $TOKEN" "http://127.0.0.1:$2/status" >/dev/null 2>&1 && break; sleep 0.5; done
}
wait_log(){ for i in $(seq 1 40); do grep -q "$2" "$1/daemon.log" 2>/dev/null && return 0; sleep 0.25; done; return 1; }
unchanged(){ cmp -s "$1/lockqzd.py" "$APP/mac/lockqzd.py" && [ ! -f "$1/new-tool.sh" ] && [ ! -d "$1/.update" ]; }

echo "T1 a correctly signed newer release is installed, verified, and the helper restarts"
publish 9.9.9 "$TMP/good.pem" ""
D="$TMP/i1"; P=$(free_port); fresh_install "$D" "$P"; start_daemon "$D" "$P"
wait_log "$D" "installed (3 files)" && ok "update applied (log)" || bad "no 'installed' line: $(tail -3 "$D/daemon.log")"
grep -q '^VERSION = "9.9.9"' "$D/lockqzd.py" && ok "lockqzd.py replaced by the new version" || bad "lockqzd.py not replaced"
[ -x "$D/new-tool.sh" ] && ok "new file added and executable" || bad "new file missing or not executable"
[ ! -d "$D/.update" ] && ok "staging folder cleaned" || bad "staging folder left behind"
grep -q "would restart" "$D/daemon.log" && ok "restart requested (dry-run)" || bad "no restart"
grep -q '"event": "update"' "$TMP/posts.log" && ok "update reported to the server" || bad "update not reported"
grep -q '"to": "9.9.9"' "$TMP/posts.log" && ok "report names the new version" || bad "report lacks new version"
grep -q '"device_id": "utest-dev"' "$D/config.json" && [ -f "$D/device.key" ] && ok "config and device key untouched" || bad "identity files changed"
kill $DPID_ 2>/dev/null

echo "T2 a release signed with the WRONG key is ignored"
publish 9.9.9 "$TMP/evil.pem" ""
D="$TMP/i2"; P=$(free_port); fresh_install "$D" "$P"; start_daemon "$D" "$P"
wait_log "$D" "signature INVALID" && ok "bad signature detected" || bad "bad signature not detected"
unchanged "$D" && ok "install untouched after bad signature" || bad "install CHANGED after bad signature"
kill $DPID_ 2>/dev/null

echo "T3 a signed manifest whose file hash does not match the download is ignored"
publish 9.9.9 "$TMP/good.pem" badhash
D="$TMP/i3"; P=$(free_port); fresh_install "$D" "$P"; start_daemon "$D" "$P"
wait_log "$D" "SHA-256 mismatch" && ok "hash mismatch detected" || bad "hash mismatch not detected"
unchanged "$D" && ok "install untouched after hash mismatch" || bad "install CHANGED after hash mismatch"
kill $DPID_ 2>/dev/null

echo "T4 a manifest that tries to replace config.json is refused whole"
publish 9.9.9 "$TMP/good.pem" forbidden
D="$TMP/i4"; P=$(free_port); fresh_install "$D" "$P"; start_daemon "$D" "$P"
wait_log "$D" "refusing file entry" && ok "forbidden file name refused" || bad "forbidden name accepted"
unchanged "$D" && ok "install untouched" || bad "install CHANGED"
kill $DPID_ 2>/dev/null

echo "T5 same or older version: nothing happens"
publish 0.0.1 "$TMP/good.pem" ""
D="$TMP/i5"; P=$(free_port); fresh_install "$D" "$P"; start_daemon "$D" "$P"
sleep 3
unchanged "$D" && ok "older release not installed" || bad "older release installed (downgrade!)"
! grep -q "update:" "$D/daemon.log" && ok "no update noise in the log" || bad "unexpected update log lines"
kill $DPID_ 2>/dev/null

echo "T6 a quiz in progress defers the update; the student is never interrupted"
publish 9.9.9 "$TMP/good.pem" ""
D="$TMP/i6"; P=$(free_port); fresh_install "$D" "$P"; start_daemon "$D" "$P" "LOCKQZ_UPDATE_DELAY=3"
curl -s -m 10 -X POST -H "X-LOCKqz-Token: $TOKEN" -H "Content-Type: application/json" -d '{"quiz_id":"1-2","student":"T"}' "http://127.0.0.1:$P/lock" >/dev/null
wait_log "$D" "quiz in progress - deferred" && ok "update deferred during the quiz" || bad "not deferred: $(tail -3 "$D/daemon.log")"
unchanged "$D" && ok "install untouched during the quiz" || bad "install CHANGED during a quiz"
curl -s -m 10 -H "X-LOCKqz-Token: $TOKEN" "http://127.0.0.1:$P/status" | grep -q '"state": "locked"' && ok "still locked" || bad "lock lost"
kill $DPID_ 2>/dev/null

echo "T7 a daemon run from a source checkout never updates the checkout"
publish 9.9.9 "$TMP/good.pem" ""
P=$(free_port); mkdir -p "$TMP/i7"
cat > "$TMP/i7/config.json" <<CFG
{ "port": $P, "token": "$TOKEN", "api_base": "http://127.0.0.1:$MOCK_PORT", "device_id": "utest-dev7", "max_minutes": 180 }
CFG
cp "$APP/mac/blocklist.txt" "$TMP/i7/blocklist.txt"; cp "$APP/mac/lockqzd.py" "$TMP/i7/orig.py"
printf %s "$TOKEN" > "$TMP/i7/helper.token"
env LOCKQZ_TOKEN_FILE="$TMP/i7/helper.token" LOCKQZ_TOKEN_DIR="$TMP/i7/tokens" LOCKQZ_NO_DEVMODE=1 LOCKQZ_DRYRUN=1 LOCKQZ_CONFIG="$TMP/i7/config.json" LOCKQZ_KEY_PATH="$TMP/i7/device.key" \
    LOCKQZ_LOCKFILE="$TMP/i7/active_lock.json" LOCKQZ_BLOCKLIST="$TMP/i7/blocklist.txt" LOCKQZ_UPDATE_DELAY=1 \
    LOCKQZ_UPDATE_PUB="$TMP/good.pub" python3 "$APP/mac/lockqzd.py" >"$TMP/i7/daemon.log" 2>&1 & DPID_=$!; PIDS="$PIDS $DPID_"
sleep 4
cmp -s "$TMP/i7/orig.py" "$APP/mac/lockqzd.py" && [ ! -f "$APP/mac/new-tool.sh" ] && ok "source checkout untouched" || bad "SOURCE CHECKOUT MODIFIED"
rm -f "$APP/mac/new-tool.sh"
kill $DPID_ 2>/dev/null

echo "T8 the real release builder + the one-line installer's fetch path (signature + hashes)"
rm -rf "$SITE/download"; mkdir -p "$SITE/download"
MACSRC="$TMP/macsrc"; rm -rf "$MACSRC"; cp -R "$APP/mac" "$MACSRC"; cp "$TMP/good.pub" "$MACSRC/update.pub"
python3 "$APP/release/make-manifest.py" --key "$TMP/good.pem" --pub "$TMP/good.pub" --out "$SITE/download" --mac "$MACSRC" --version 9.9.9 >/dev/null \
  && ok "release built and self-verified" || bad "make-manifest failed"
[ -s "$SITE/download/update.json" ] && [ -s "$SITE/download/update.sig" ] && [ -f "$SITE/download/mac/lockqzd.py" ] && [ -f "$SITE/download/windows/lockqzd.ps1" ] \
  && ok "manifest, signature, mac + windows files published" || bad "release files missing"
! grep -q ' ' "$SITE/download/update.json" && ok "manifest is compact JSON (the installer's parser relies on it)" || bad "manifest has spaces"
# The installer embeds the production key; for this test, swap in the test key so the signature matches.
python3 - "$APP/mac/install.sh" "$TMP/good.pub" "$TMP/install-test.sh" <<'PYX'
import sys,re
src,pub,out=sys.argv[1:4]
s=open(src).read(); k=open(pub).read().strip()
s2=re.sub(r"-----BEGIN PUBLIC KEY-----.*?-----END PUBLIC KEY-----", k, s, count=1, flags=re.S)
assert s2!=s; open(out,"w").write(s2)
PYX
FETCHED="$TMP/fetched"
if LOCKQZ_SITE="http://127.0.0.1:$MOCK_PORT" bash "$TMP/install-test.sh" --fetch-only "$FETCHED" >"$TMP/fetch.log" 2>&1; then
  ok "install.sh fetched and verified the release"
else
  bad "install.sh fetch failed: $(cat "$TMP/fetch.log")"
fi
[ -f "$FETCHED/lockqzd.py" ] && [ -f "$FETCHED/ensure-python.sh" ] && [ -f "$FETCHED/update.pub" ] && ok "all helper files present" || bad "files missing after fetch"
cmp -s "$FETCHED/lockqzd.py" "$MACSRC/lockqzd.py" && ok "fetched lockqzd.py is byte-identical" || bad "fetched file differs"
# tamper: flip one byte of a served file -> install must refuse
printf '#' >> "$SITE/download/mac/blocklist.txt"
if LOCKQZ_SITE="http://127.0.0.1:$MOCK_PORT" bash "$TMP/install-test.sh" --fetch-only "$TMP/fetched2" >"$TMP/fetch2.log" 2>&1; then
  bad "install.sh accepted a tampered file"
else
  grep -q "integrity check" "$TMP/fetch2.log" && ok "tampered file refused with a clear message" || bad "refused for the wrong reason: $(cat "$TMP/fetch2.log")"
fi
# the embedded key in install.sh must be the real release key
diff <(sed -n '/-----BEGIN PUBLIC KEY-----/,/-----END PUBLIC KEY-----/p' "$APP/mac/install.sh") "$APP/mac/update.pub" >/dev/null \
  && ok "install.sh embeds the same key as mac/update.pub" || bad "install.sh key differs from mac/update.pub"
python3 - "$APP/windows/install.ps1" "$APP/windows/update.pub.xml" <<'PYX' && ok "install.ps1 embeds the same key as windows/update.pub.xml" || bad "install.ps1 key differs"
import sys; s=open(sys.argv[1]).read(); k=open(sys.argv[2]).read().strip(); assert k in s
PYX

echo ""
echo "update: $pass passed, $fail failed"
[ $fail -eq 0 ]
