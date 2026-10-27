#!/bin/bash
# app/payments/stripe-setup.sh against a fake Stripe (curl) and a fake wrangler: key check, secrets put,
# webhook made once (old one replaced), never printed.
HERE="$(cd "$(dirname "$0")" && pwd)"; SCRIPT="$HERE/../payments/stripe-setup.sh"
P=0; F=0; ok(){ P=$((P+1)); echo "  ok: $1"; }; bad(){ F=$((F+1)); echo "  FAIL: $1"; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; mkdir -p "$T/bin"
cat > "$T/bin/curl" <<'C'
#!/bin/bash
echo "$*" >> "$FAKE/curl.log"
case "$*" in
  *"-u bad:"*) exit 22;;
  *"-X DELETE"*) echo '{}';;
  *"webhook_endpoints?limit"*) echo '{"data":[{"id":"we_old","url":"https://lockqz.pages.dev/api/pay/stripe/webhook"},{"id":"we_other","url":"https://x.example/h"}]}';;
  *"webhook_endpoints "*|*"webhook_endpoints"*"-d url="*) echo '{"id":"we_new","secret":"whsec_FAKESECRET"}';;
  *"payment_method_configurations?limit"*) echo '{"data":[{"id":"pmc_1","is_default":true}]}';;
  *) echo '{}';;
esac
C
cat > "$T/bin/wrangler" <<'W'
#!/bin/bash
if [ "$1 $2 $3" = "pages secret put" ]; then v=$(cat); echo "$4=$v" >> "$FAKE/put.log"; touch "$FAKE/has_$4"; exit 0; fi
if [ "$1 $2 $3" = "pages secret list" ]; then for f in "$FAKE"/has_*; do [ -e "$f" ] && echo "  - ${f##*/has_}: Value Encrypted"; done; exit 0; fi
W
chmod +x "$T/bin/"*
run(){ ( export PATH="$T/bin:$PATH" FAKE="$T" W="$T/bin/wrangler" STRIPE_SECRET_KEY="$1"; bash "$SCRIPT" ) > "$T/out" 2>&1; echo $?; }
echo "S1 no key: skipped, nothing touched"
rc=$(run ""); [ "$rc" = 0 ] && grep -q skipped "$T/out" && [ ! -e "$T/put.log" ] && ok "skipped" || bad "$(cat "$T/out")"
echo "S2 bad key: stops"
rc=$(run "bad"); [ "$rc" != 0 ] && grep -q "refused" "$T/out" && [ ! -e "$T/put.log" ] && ok "refused, no secret stored" || bad "$(cat "$T/out")"
echo "S3 good key: key + webhook secret stored, old LOCKqz webhook replaced, ACH on"
rc=$(run "sk_live_GOOD")
[ "$rc" = 0 ] && grep -qx "STRIPE_SECRET_KEY=sk_live_GOOD" "$T/put.log" && grep -qx "STRIPE_WEBHOOK_SECRET=whsec_FAKESECRET" "$T/put.log" && ok "both secrets put" || bad "$(cat "$T/out"; cat "$T/put.log")"
grep -q "DELETE https://api.stripe.com/v1/webhook_endpoints/we_old" "$T/curl.log" && ! grep -q "we_other" "$T/curl.log" && ok "only the old LOCKqz webhook deleted" || bad "$(cat "$T/curl.log")"
grep -q "enabled_events\[\]=charge.refunded" "$T/curl.log" && grep -q "enabled_events\[\]=checkout.session.async_payment_succeeded" "$T/curl.log" && ok "webhook events include payments + cancellations" || bad "events"
grep -q "us_bank_account\[display_preference\]\[preference\]=off" "$T/curl.log" && grep -q "card\[display_preference\]\[preference\]=on" "$T/curl.log" && ok "card on, ACH off (ACH can be returned)" || bad "ACH"
! grep -q "sk_live_GOOD\|whsec_FAKESECRET" "$T/out" && ok "no secret printed" || bad "secret printed: $(cat "$T/out")"
echo "S4 second run: key refreshed, webhook not remade"
: > "$T/put.log"; : > "$T/curl.log"
rc=$(run "sk_live_NEW"); [ "$rc" = 0 ] && grep -qx "STRIPE_SECRET_KEY=sk_live_NEW" "$T/put.log" && ! grep -q WEBHOOK "$T/put.log" && ! grep -q "url=" "$T/curl.log" && ! grep -q "DELETE" "$T/curl.log" && ok "idempotent (no new webhook, same secret)" || bad "$(cat "$T/out")"
grep -q "webhook_endpoints/we_old .*enabled_events\[\]=payment_intent.succeeded" "$T/curl.log" && ! grep -q "we_other" "$T/curl.log" && ok "existing webhook gets the renewal event (payment_intent.succeeded)" || bad "$(cat "$T/curl.log")"
echo ""; echo "RESULT: $P passed, $F failed"; [ $F -eq 0 ]
