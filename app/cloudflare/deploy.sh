#!/bin/bash
# LOCKqz one-command deploy -- the ONLY way LOCKqz is deployed (CI's deploy job runs this same file).
# Run AFTER you've logged into the target Cloudflare account:
#     npx wrangler logout && npx wrangler login     (sign in as the account you want)
# Usage:  bash deploy.sh        (from a Mac: run release-local.sh first; it fills public/ the way CI does)
# Idempotent: creates the project + D1 if missing, applies new migrations once, deploys ONE build to
# both addresses (lockqz.pages.dev and the old lockdownqz.pages.dev, which still serves installs made
# before the rename and shares the same database), then proves both answer with the same build.
set -e
cd "$(dirname "$0")"
PROJECT=lockqz
LEGACY=lockdownqz
DB=lockqz
if [ -x node_modules/.bin/wrangler ]; then W="$(pwd)/node_modules/.bin/wrangler"; else W="npx wrangler"; fi
VERSION=$(tr -d '[:space:]' < ../VERSION)
BUILD=$(git rev-parse --short HEAD 2>/dev/null || echo nogit)
# The API's own files changed since that commit -> mark the build as such (still one id for all hosts).
[ -n "$(git status --porcelain -- functions 2>/dev/null)" ] && BUILD="$BUILD-dirty$(date -u +%m%d%H%M)"

echo "== release files (E3: never publish a site without real installers + a valid signed update) =="
bad=0; d=public/download
miss(){ echo "  MISSING/BAD: $1"; bad=1; }
magic(){ [ -s "$1" ] && [ "$(head -c ${#2} "$1")" = "$2" ]; }
magic "$d/lockqz-mac.pkg" 'xar!' || miss "$d/lockqz-mac.pkg (not a real .pkg)"
magic "$d/lockqz-win.exe" 'MZ'   || miss "$d/lockqz-win.exe (not a real .exe)"
if [ -s "$d/update.json" ] && [ -s "$d/update.sig" ]; then
  t=$(mktemp); openssl base64 -d -A -in "$d/update.sig" -out "$t" 2>/dev/null || true
  openssl dgst -sha256 -verify ../mac/update.pub -signature "$t" "$d/update.json" >/dev/null 2>&1 || miss "$d/update.sig does not verify with mac/update.pub"
  rm -f "$t"
  mv=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version",""))' "$d/update.json" 2>/dev/null || true)
  [ "$mv" = "$VERSION" ] || miss "$d/update.json is version '$mv', app/VERSION is '$VERSION'"
  [ -d "$d/mac" ] && [ -d "$d/windows" ] || miss "$d/mac or $d/windows (helper files for self-update)"
else miss "$d/update.json + $d/update.sig (signed update manifest)"; fi
for f in mac/install.sh mac/uninstall.sh windows/install.ps1 windows/uninstall.ps1; do
  cmp -s "../$f" "public/$(basename "$f")" || miss "public/$(basename "$f") (missing or older than app/$f)"
done
if [ $bad -ne 0 ]; then echo "Refusing to deploy. Run:  bash release-local.sh   (or let CI build the release), then deploy again."; exit 1; fi
echo "  ok: pkg, exe, update.json signed (v$VERSION), one-line installers"
# The professor browser extension packages (dashboard "Add LOCKqz to Chrome" links them until the store
# listings are live; the welcome email too). Built from app/extension-prof + the site's own sync.js/lq.js.
if bash ../extension-prof/build.sh >/dev/null 2>&1; then cp ../extension-prof/dist/lockqz-prof-*.zip "$d/"; echo "  ok: professor extension zips in $d"; else echo "  warning: extension build failed (zip missing?); keeping the zips already in $d"; fi

echo "== who am I =="; $W whoami | tail -3

echo "== D1 database =="
if ! $W d1 list 2>/dev/null | grep -q "\b$DB\b"; then
  $W d1 create "$DB"
  echo ">>> paste the database_id printed above into wrangler.toml, then re-run deploy.sh"
  exit 1
fi

echo "== secrets (only $PROJECT production matters: every other LOCKqz address forwards its API calls there) =="
names(){ $W pages secret list --project-name "$1" ${2:+--env "$2"} 2>/dev/null | sed -n 's/^[[:space:]]*-[[:space:]]*\([A-Z0-9_]*\):.*/\1/p' | sort; }
A=$(names "$PROJECT"); echo "  $PROJECT (production): $(echo $A)"
missing=""
for s in REQUIRE_SIGNED ROT_SECRET MAIL_USER MAIL_APP_PASSWORD; do
  echo "$A" | grep -qx "$s" || { missing="$missing $s"; echo "  MISSING: $s   (npx wrangler pages secret put $s --project-name $PROJECT)"; }
done
echo "  optional: TEACHER_KEY (admin master key), PAY_SECRET (else derived from ROT_SECRET), PW_PEPPER (never remove once set), BS_HOSTS (default USC)"
if [ -n "$missing" ] && [ "${LQZ_ALLOW_SECRET_DIFF:-}" != "1" ]; then
  echo "  Set the missing secrets on $PROJECT production, then deploy again."; exit 1
fi

# 25 Oct 2026: never use `d1 execute --file` here. --file goes through D1's IMPORT path: every run
# snapshots the database and a failing file ("duplicate column" = already applied) RESTORES it, which
# counts every row as written. 17 files x every deploy exhausted the free 100k rows/day limit and froze
# all LOCKqz writes (locks, codes). Use the query path (--command) and run each migration only once.
q(){ $W d1 execute "$DB" --remote --json --command "$1" 2>/dev/null; }
echo "== schema (idempotent; CREATE TABLE IF NOT EXISTS; query path) =="
q "$(grep -v '^[[:space:]]*--' schema.sql)" >/dev/null && echo "  schema ok" || echo "  schema: check manually"
q "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, at TEXT)" >/dev/null
done_list=$(q "SELECT name FROM _migrations" | python3 -c 'import sys,json
try: print("\n".join(r["name"] for r in json.load(sys.stdin)[0]["results"]))
except Exception: pass')
echo "== new migrations only =="
applied=0
for m in migrate_*.sql; do
  if printf '%s\n' "$done_list" | grep -qx "$m"; then continue; fi
  # "|| rc=$?" keeps set -e from aborting on an already-applied migration ("duplicate column").
  rc=0; out=$($W d1 execute "$DB" --remote --command "$(grep -v '^[[:space:]]*--' "$m")" 2>&1) || rc=$?
  if [ $rc -eq 0 ] || printf '%s' "$out" | grep -qiE "duplicate column|already exists"; then
    q "INSERT OR IGNORE INTO _migrations (name, at) VALUES ('$m', datetime('now'))" >/dev/null
    [ $rc -eq 0 ] && echo "  applied $m" || echo "  $m was already in place"; applied=1
  else
    echo "  FAILED $m (will retry next deploy):"; printf '%s\n' "$out" | tail -3; exit 1
  fi
done
# New indexes: let SQLite's planner learn them (cheap; reads a sample of each index).
[ $applied -eq 1 ] && { q "PRAGMA optimize" >/dev/null && echo "  PRAGMA optimize ok" || echo "  PRAGMA optimize: skipped"; }

echo "== one build for every address (version $VERSION, build $BUILD) =="
bash build-prof.sh
bash build-legacy.sh
STAGE=.deploy
rm -rf "$STAGE" && mkdir -p "$STAGE"
cp -R functions wrangler.toml "$STAGE"/
cp -R public prof_site legacy_site legacy_prof "$STAGE"/
# Firefox: a Mozilla-signed professor package is on the site -> the dashboard's Firefox button installs it.
if [ -s public/download/lockqz-prof-firefox.xpi ]; then
  for f in "$STAGE/public/dashboard.html" "$STAGE/prof_site/dashboard.html" "$STAGE/prof_site/index.html"; do
    [ -f "$f" ] && sed -i.bak 's/const FF_XPI = false;/const FF_XPI = true;/' "$f" && rm -f "$f.bak"
  done
fi
ROUTE="$STAGE/functions/api/[[route]].js"
# Static copy of the AI blocklist: agents read it 2-3 times a day, and static files never count against
# the free plan's 100,000 Functions requests/day (/api/blocklist stays for older installs).
node -e 'const fs=require("fs"); const m=fs.readFileSync(process.argv[1],"utf8").match(/const AI_DOMAINS = (\[[\s\S]*?\]);/); const d=JSON.parse(m[1]); if(d.length<90) process.exit(1); fs.writeFileSync(process.argv[2], JSON.stringify({domains:d}));' "$ROUTE" "$STAGE/public/blocklist.json"
python3 - "$ROUTE" "$VERSION" "$BUILD" <<'PY'
import sys
p, v, b = sys.argv[1:4]
s = open(p).read()
assert '"__LQZ_VERSION__"' in s and '"__LQZ_BUILD__"' in s, "build placeholders missing in the API"
open(p, "w").write(s.replace('"__LQZ_VERSION__"', '"%s"' % v).replace('"__LQZ_BUILD__"', '"%s"' % b))
PY
dep(){ (cd "$STAGE" && $W pages deploy "$1" --project-name "$2" --commit-dirty=true --branch "$3"); }

echo "== pages projects =="
$W pages project create "$PROJECT" --production-branch main 2>/dev/null || true

echo "== deploy: lockqz.pages.dev, prof.lockqz.pages.dev =="
dep public "$PROJECT" main
dep prof_site "$PROJECT" prof
echo "== deploy: old address lockdownqz.pages.dev (pages forward to lockqz; same API for old installs) =="
dep legacy_site "$LEGACY" main
dep legacy_prof "$LEGACY" prof

echo "== check: every address serves this build with the same flags (C7) =="
ref=""; fail=0
for h in "$PROJECT.pages.dev" "prof.$PROJECT.pages.dev" "$LEGACY.pages.dev" "prof.$LEGACY.pages.dev"; do
  got=""
  for i in $(seq 1 12); do
    got=$(curl -fsS -A "LOCKqz/deploy" "https://$h/api/version" 2>/dev/null | python3 -c 'import sys,json
d=json.load(sys.stdin); print(d.get("version"), d.get("api"), "codes_on=%s" % d.get("codes_on"), "strict=%s" % d.get("strict"), "fee_on=%s" % d.get("fee_on"))' 2>/dev/null || true)
    case "$got" in "$VERSION $BUILD "*) break;; esac
    sleep 5
  done
  echo "  $h: ${got:-no answer}"
  case "$got" in "$VERSION $BUILD "*) ;; *) fail=1;; esac
  [ -z "$ref" ] && ref="$got"
  [ "$got" = "$ref" ] || fail=1
done
rm -rf "$STAGE"
if [ $fail -ne 0 ]; then echo "DEPLOY CHECK FAILED: the addresses above do not all serve version $VERSION build $BUILD with the same flags."; exit 1; fi

echo ""
echo "Done. Site: https://$PROJECT.pages.dev   Teachers: https://prof.$PROJECT.pages.dev   (old: https://$LEGACY.pages.dev)"
