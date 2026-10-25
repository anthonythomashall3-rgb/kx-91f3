#!/bin/bash
# deploy.sh's secrets check: every other LOCKqz address forwards its API calls to lockqz production, so
# only lockqz production's secrets matter, and the required ones must be there. Runs the REAL block from deploy.sh against a fake `wrangler pages secret list`.
HERE="$(cd "$(dirname "$0")" && pwd)"; DEPLOY="${LQZ_DEPLOY:-$HERE/../cloudflare/deploy.sh}"
P=0; F=0; ok(){ P=$((P+1)); echo "  ok: $1"; }; bad(){ F=$((F+1)); echo "  FAIL: $1"; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
# fake wrangler: secret names come from $T/<project>.<env> (one per line)
cat > "$T/wrangler" <<'W'
#!/bin/bash
proj=""; env=production
while [ $# -gt 0 ]; do case "$1" in --project-name) proj="$2"; shift;; --env) env="$2"; shift;; esac; shift; done
echo "The \"$env\" environment of your Pages project \"$proj\" has access to the following secrets:"
[ -f "$FAKE/$proj.$env" ] && sed 's/^/  - /; s/$/: Value Encrypted/' "$FAKE/$proj.$env"
exit 0
W
chmod +x "$T/wrangler"
awk '/^echo "== secrets/{on=1} /^# 25 Oct 2026: never use/{on=0} on' "$DEPLOY" > "$T/block.sh"
[ -s "$T/block.sh" ] || { echo "  FAIL: secrets block not found in deploy.sh"; exit 1; }
run(){ ( set -e; PROJECT=lockqz; LEGACY=lockdownqz; W="$T/wrangler"; FAKE="$T"; export FAKE; . "$T/block.sh"; echo "BLOCK-DONE" ) > "$T/out" 2>&1; echo $? > "$T/rc"; }
ALL="MAIL_APP_PASSWORD MAIL_USER REQUIRE_SIGNED ROT_SECRET TEACHER_KEY"
put(){ printf '%s\n' $2 > "$T/$1"; }
echo "S1 all required secrets on lockqz production (other addresses forward their API calls) -> passes"
put lockqz.production "$ALL"
run; [ "$(cat "$T/rc")" = 0 ] && grep -q BLOCK-DONE "$T/out" && ! grep -q "MISSING:" "$T/out" && ok "no MISSING lines, deploy continues" || bad "$(cat "$T/out")"
echo "S2 preview / legacy environments without secrets do not matter (they proxy) -> passes"
rm -f "$T/lockqz.preview" "$T/lockdownqz.production" "$T/lockdownqz.preview"
run; [ "$(cat "$T/rc")" = 0 ] && grep -q BLOCK-DONE "$T/out" && ok "deploy continues" || bad "$(cat "$T/out")"
echo "S3 ROT_SECRET missing on production (gate codes would use the public fallback) -> refused"
put lockqz.production "MAIL_APP_PASSWORD MAIL_USER REQUIRE_SIGNED"
run; [ "$(cat "$T/rc")" != 0 ] && ! grep -q BLOCK-DONE "$T/out" && grep -q "MISSING: ROT_SECRET" "$T/out" && ok "deploy stops before migrations and names ROT_SECRET" || bad "$(cat "$T/out")"
echo "S4 MAIL_* missing on production -> refused"
put lockqz.production "REQUIRE_SIGNED ROT_SECRET"
run; [ "$(cat "$T/rc")" != 0 ] && grep -q "MISSING: MAIL_USER" "$T/out" && ok "names MAIL_USER" || bad "$(cat "$T/out")"
echo ""; echo "RESULT: $P passed, $F failed"; [ $F -eq 0 ]
