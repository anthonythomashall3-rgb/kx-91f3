#!/bin/bash
# LOCKqz email (Amazon SES) setup -- run by CI's deploy job before deploy.sh (idempotent; nothing to do by hand).
# Needs GitHub secrets SES_ACCESS_KEY_ID + SES_SECRET_ACCESS_KEY (an IAM user allowed ses:SendEmail only) and
# GitHub variables MAIL_FROM (e.g. no-reply@yourdomain.com, on a domain verified in SES), optional SES_REGION
# (default us-east-1) and SES_DAILY_MAX (your SES 24-hour sending quota). Copies them into the lockqz Pages
# project as secrets; the deploy that follows picks them up. Until they exist LOCKqz keeps sending through Gmail.
# Secrets are never printed.
set -e
[ -n "$SES_ACCESS_KEY_ID" ] && [ -n "$SES_SECRET_ACCESS_KEY" ] && [ -n "$MAIL_FROM" ] || { echo "mail: SES not configured -- skipped (Gmail keeps sending)"; exit 0; }
case "$MAIL_FROM" in *@*.*) ;; *) echo "::error::MAIL_FROM must be an email address on your SES-verified domain"; exit 1;; esac
cd "$(dirname "$0")/../cloudflare"
if [ -n "$W" ]; then :; elif [ -x node_modules/.bin/wrangler ]; then W="$(pwd)/node_modules/.bin/wrangler"; else W="npx wrangler"; fi
PROJECT="${PROJECT:-lockqz}"
put(){ printf '%s' "$2" | $W pages secret put "$1" --project-name "$PROJECT" >/dev/null; }
put SES_ACCESS_KEY_ID "$SES_ACCESS_KEY_ID"
put SES_SECRET_ACCESS_KEY "$SES_SECRET_ACCESS_KEY"
put MAIL_FROM "$MAIL_FROM"
put SES_REGION "${SES_REGION:-us-east-1}"
[ -n "$SES_DAILY_MAX" ] && put SES_DAILY_MAX "$SES_DAILY_MAX"
echo "mail: SES secrets set on $PROJECT (from ${MAIL_FROM#*@}, region ${SES_REGION:-us-east-1})"
