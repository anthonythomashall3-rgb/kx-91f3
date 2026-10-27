#!/bin/bash
# LOCKqz Stripe setup -- run by CI's deploy job before deploy.sh (idempotent; nothing to do by hand).
# Needs: STRIPE_SECRET_KEY (GitHub secret; sk_live_... or a restricted rk_live_... key with write access
# to Checkout Sessions, Webhook Endpoints and Payment Method Configurations) + the Cloudflare token CI has.
#  1. checks the key works
#  2. puts it into the lockqz Pages secret STRIPE_SECRET_KEY (every run, so a new key replaces the old)
#  3. if lockqz has no STRIPE_WEBHOOK_SECRET yet (or STRIPE_RESET_WEBHOOK=1): deletes any old LOCKqz webhook,
#     creates https://lockqz.pages.dev/api/pay/stripe/webhook with the events the API handles, stores its secret
#  4. card on; US bank account (ACH) on only if STRIPE_BANK=1 (best effort)
# The deploy that follows picks the secrets up. Secrets are never printed.
set -e
[ -n "$STRIPE_SECRET_KEY" ] || { echo "stripe: no STRIPE_SECRET_KEY secret -- skipped (card/bank stay hidden)"; exit 0; }
cd "$(dirname "$0")/../cloudflare"
if [ -n "$W" ]; then :; elif [ -x node_modules/.bin/wrangler ]; then W="$(pwd)/node_modules/.bin/wrangler"; else W="npx wrangler"; fi
PROJECT="${PROJECT:-lockqz}"
HOOK="${STRIPE_HOOK_URL:-https://lockqz.pages.dev/api/pay/stripe/webhook}"
API=https://api.stripe.com/v1
s(){ curl -fsS -u "$STRIPE_SECRET_KEY:" "$@"; }
list=$(s "$API/webhook_endpoints?limit=100") || { echo "::error::Stripe refused STRIPE_SECRET_KEY (wrong key, or a restricted key without Webhook Endpoints access)"; exit 1; }
printf '%s' "$STRIPE_SECRET_KEY" | $W pages secret put STRIPE_SECRET_KEY --project-name "$PROJECT" >/dev/null
echo "stripe: STRIPE_SECRET_KEY set on $PROJECT"
have=$($W pages secret list --project-name "$PROJECT" 2>/dev/null | grep -c "STRIPE_WEBHOOK_SECRET" || true)
# The events the API handles (payment_intent.succeeded = student card renewals, 27 Oct 2026).
EVENTS=(-d "enabled_events[]=checkout.session.completed" -d "enabled_events[]=checkout.session.async_payment_succeeded"
  -d "enabled_events[]=charge.refunded" -d "enabled_events[]=charge.dispute.created" -d "enabled_events[]=charge.failed"
  -d "enabled_events[]=payment_intent.payment_failed" -d "enabled_events[]=payment_intent.canceled" -d "enabled_events[]=payment_intent.succeeded")
if [ "$have" = 0 ] || [ "$STRIPE_RESET_WEBHOOK" = 1 ]; then
  for id in $(printf '%s' "$list" | python3 -c 'import sys,json; [print(e["id"]) for e in json.load(sys.stdin).get("data",[]) if e.get("url")==sys.argv[1]]' "$HOOK"); do
    s -X DELETE "$API/webhook_endpoints/$id" >/dev/null && echo "stripe: removed old webhook $id"
  done
  made=$(s "$API/webhook_endpoints" -d "url=$HOOK" -d "description=LOCKqz payments" "${EVENTS[@]}")
  whsec=$(printf '%s' "$made" | python3 -c 'import sys,json; print(json.load(sys.stdin)["secret"])')
  [ -n "$whsec" ] || { echo "::error::Stripe did not return a webhook secret"; exit 1; }
  printf '%s' "$whsec" | $W pages secret put STRIPE_WEBHOOK_SECRET --project-name "$PROJECT" >/dev/null
  echo "stripe: webhook created -> $HOOK; STRIPE_WEBHOOK_SECRET set on $PROJECT"
else
  echo "stripe: webhook secret already set (STRIPE_RESET_WEBHOOK=1 makes a new one)"
  # Same endpoint, same secret: keep its event list up to date (adds events new code handles).
  for id in $(printf '%s' "$list" | python3 -c 'import sys,json; [print(e["id"]) for e in json.load(sys.stdin).get("data",[]) if e.get("url")==sys.argv[1]]' "$HOOK"); do
    s "$API/webhook_endpoints/$id" "${EVENTS[@]}" >/dev/null && echo "stripe: webhook $id events updated" || echo "::warning::could not update the Stripe webhook events"
  done
fi
pmc=$(s "$API/payment_method_configurations?limit=20" 2>/dev/null | python3 -c 'import sys,json
d=json.load(sys.stdin).get("data",[]); x=[c for c in d if c.get("is_default")] or d; print(x[0]["id"] if x else "")' 2>/dev/null || true)
if [ -n "$pmc" ]; then
  # ACH only when STRIPE_BANK=1 (wrangler.toml): ACH debits can be returned for 60 days.
  if [ "$STRIPE_BANK" = 1 ]; then ach=on; else ach=off; fi
  s "$API/payment_method_configurations/$pmc" -d "card[display_preference][preference]=on" -d "us_bank_account[display_preference][preference]=$ach" >/dev/null 2>&1 \
    && echo "stripe: card on, bank account (ACH) $ach" || echo "::warning::could not set Stripe payment methods automatically (Stripe Dashboard -> Settings -> Payment methods)"
fi
