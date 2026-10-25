#!/bin/bash
# LOCKqz one-command deploy. Run AFTER you've logged into the target Cloudflare account:
#     npx wrangler logout && npx wrangler login     (sign in as the account you want)
# Usage:  bash deploy.sh
# Idempotent: creates the project + D1 if missing, loads schema, deploys, and prints the URL.
set -e
cd "$(dirname "$0")"
PROJECT=lockqz
DB=lockqz

echo "== who am I =="; npx wrangler whoami | tail -3

echo "== D1 database =="
if ! npx wrangler d1 list 2>/dev/null | grep -q "\b$DB\b"; then
  npx wrangler d1 create "$DB"
  echo ">>> paste the database_id printed above into wrangler.toml, then re-run deploy.sh"
  exit 1
fi

# 25 Oct 2026: never use `d1 execute --file` here. --file goes through D1's IMPORT path: every run
# snapshots the database and a failing file ("duplicate column" = already applied) RESTORES it, which
# counts every row as written. 17 files x every deploy exhausted the free 100k rows/day limit and froze
# all LOCKqz writes (locks, codes). Use the query path (--command) and run each migration only once.
q(){ npx wrangler d1 execute "$DB" --remote --json --command "$1" 2>/dev/null; }
echo "== schema (idempotent; CREATE TABLE IF NOT EXISTS; query path) =="
q "$(grep -v '^[[:space:]]*--' schema.sql)" >/dev/null && echo "  schema ok" || echo "  schema: check manually"
q "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, at TEXT)" >/dev/null
done_list=$(q "SELECT name FROM _migrations" | python3 -c 'import sys,json
try: print("\n".join(r["name"] for r in json.load(sys.stdin)[0]["results"]))
except Exception: pass')
echo "== new migrations only =="
for m in migrate_*.sql; do
  if printf '%s\n' "$done_list" | grep -qx "$m"; then continue; fi
  out=$(npx wrangler d1 execute "$DB" --remote --command "$(grep -v '^[[:space:]]*--' "$m")" 2>&1); rc=$?
  if [ $rc -eq 0 ] || printf '%s' "$out" | grep -qiE "duplicate column|already exists"; then
    q "INSERT OR IGNORE INTO _migrations (name, at) VALUES ('$m', datetime('now'))" >/dev/null
    [ $rc -eq 0 ] && echo "  applied $m" || echo "  $m was already in place"
  else
    echo "  FAILED $m (will retry next deploy):"; printf '%s\n' "$out" | tail -3; exit 1
  fi
done

echo "== pages project =="
npx wrangler pages project create "$PROJECT" --production-branch main 2>/dev/null || true

echo "== teacher key (set once; skip if already set) =="
echo "If you haven't set it yet, run:  npx wrangler pages secret put TEACHER_KEY --project-name $PROJECT"

echo "== deploy =="
npx wrangler pages deploy public --project-name "$PROJECT" --commit-dirty=true --branch main

echo "== teacher site (prof.$PROJECT.pages.dev) =="
bash build-prof.sh
npx wrangler pages deploy prof_site --project-name "$PROJECT" --commit-dirty=true --branch prof

echo "== old address lockdownqz.pages.dev: pages forward here; its API keeps serving apps installed before the rename =="
bash build-legacy.sh
npx wrangler pages deploy legacy_site --project-name lockdownqz --commit-dirty=true --branch main
npx wrangler pages deploy legacy_prof --project-name lockdownqz --commit-dirty=true --branch prof

echo ""
echo "Done. Site: https://$PROJECT.pages.dev   Teachers: https://prof.$PROJECT.pages.dev"
echo "Remember: set api_base in mac/config.json + api in extension/config.js to the URL above."

# Optional (recommended): a dedicated secret for rotating-code derivation. Falls back to TEACHER_KEY.
#   npx wrangler pages secret put ROT_SECRET --project-name "$PROJECT"
