#!/bin/bash
# LOCKqz one-command deploy. Run AFTER you've logged into the target Cloudflare account:
#     npx wrangler logout && npx wrangler login     (sign in as the account you want)
# Usage:  bash deploy.sh
# Idempotent: creates the project + D1 if missing, loads schema, deploys, and prints the URL.
set -e
cd "$(dirname "$0")"
PROJECT=lockdownqz
DB=lockqz

echo "== who am I =="; npx wrangler whoami | tail -3

echo "== D1 database =="
if ! npx wrangler d1 list 2>/dev/null | grep -q "\b$DB\b"; then
  npx wrangler d1 create "$DB"
  echo ">>> paste the database_id printed above into wrangler.toml, then re-run deploy.sh"
  exit 1
fi

echo "== schema (idempotent; CREATE TABLE IF NOT EXISTS) =="
npx wrangler d1 execute "$DB" --remote --file=schema.sql

echo "== migrations (safe to re-run; 'duplicate column' = already applied) =="
for m in migrate_*.sql; do
  npx wrangler d1 execute "$DB" --remote --file="$m" >/dev/null 2>&1 && echo "  applied $m" || echo "  $m already applied"
done

echo "== pages project =="
npx wrangler pages project create "$PROJECT" --production-branch main 2>/dev/null || true

echo "== teacher key (set once; skip if already set) =="
echo "If you haven't set it yet, run:  npx wrangler pages secret put TEACHER_KEY --project-name $PROJECT"

echo "== deploy =="
npx wrangler pages deploy public --project-name "$PROJECT" --commit-dirty=true --branch main

echo ""
echo "Done. Site: https://$PROJECT.pages.dev   Dashboard: https://$PROJECT.pages.dev/dashboard.html"
echo "Remember: set api_base in mac/config.json + api in extension/config.js to the URL above."
