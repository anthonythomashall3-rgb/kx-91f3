#!/bin/bash
# LOCKqz master test runner. Runs every suite; one combined verdict.
# Safe: no root, no network required, no system changes (engine runs against fake hosts).
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
FAILED=0
run(){ echo ""; echo "######## $1 ########"; shift; "$@" || FAILED=1; }

run "1/18  Mac engine (block/unblock against fake hosts)"  bash   test_engine.sh
run "2/18  API enforcement logic (password gate)"          node   test_api_logic.mjs
run "3/18  Blocklist integrity (all AIs incl. Claude)"     node   test_blocklist.mjs
run "4/18  Mac daemon control plane (dry-run)"             bash   test_daemon.sh
run "5/18  Windows scripts structural lint"                python3 test_windows_lint.py
run "6/18  Edge cases (power loss, messy data, custom hosts)" bash test_edge_cases.sh
run "7/18  Brightspace URL parsing (all quiz URL shapes)"  node   test_url_parsing.mjs
run "8/18  Live quiz-monitor status + heartbeat logic"     node   test_live_status.mjs
run "9/18 Daemon reporting end-to-end (real HTTP, mock backend)" bash test_daemon_reporting.sh
run "10/18 Mac agent + browser policy (extension replacement)" python3 test_agent.py
run "11/18 Device authentication (real API, in-memory database)" node --no-warnings test_device_auth.mjs
if command -v pwsh >/dev/null 2>&1; then
  run "12/18 Windows device signing (real lockqzd.ps1 code)" pwsh -NoProfile -File test_windows_signing.ps1
else
  echo ""; echo "######## 12/18 Windows device signing ########"; echo "  skipped: PowerShell (pwsh) not installed here; runs on Windows CI"
fi
run "13/18 Access gate + teacher self-verify"               node   test_gate.mjs
run "14/18 Signed self-update (real daemon, mock release site)" bash test_update.sh
run "15/18 Professor Sync tab + quiz gate (real sync.js, simulated Brightspace)" node --no-warnings test_sync_gate.mjs
run "Auto re-sync (zero LOCKqz requests when nothing changed) + new-quiz email" node --no-warnings test_sync_auto.mjs
run "Dashboard Sync now button (real Chromium: dashboard + Brightspace tabs)" node --no-warnings test_dashboard_sync_now.mjs
run "16/18 Security regressions (cross-course, D1 limits, auth, rate limits)" node --no-warnings test_security.mjs
run "17/18 Student email code (once per computer; real API + fake SMTP)" node --no-warnings test_email_verify.mjs
run "Per-section billing (\$1,000 per USC section, Venmo code)" node --no-warnings test_sections.mjs
run "Student fee + automatic Venmo/Zelle matching" node --no-warnings test_pay.mjs
run "Stripe card + bank (ACH): fee-inclusive prices, signed webhook, refunds void" node --no-warnings test_stripe.mjs
run "Income tax on top (25%), payments credited by how they came, bank details emailed" node --no-warnings test_tax.mjs
run "Stripe one-time setup script (fake Stripe + wrangler)" bash test_stripe_setup.sh
run "Gmail payment script parser (forged alerts refused)" node test_pay_script.mjs
run "API audit regressions (query/row budgets, auth, identity)" node --no-warnings test_api_audit.mjs
run "Round-2 API regressions (verify, FERPA, capacity, submissions, payments, deploy contracts)" node --no-warnings test_round2_api.mjs
run "Round-3 API regressions (email-code brute force, Sync-key scope, FERPA scope, big class lists, sign-up + mail caps)" node --no-warnings test_round3_api.mjs
run "Round-2 front-end regressions (Sync gate safety, saved settings, polling)" node --no-warnings test_round2_frontend.mjs
run "Deploy secrets check (Production + Preview, both projects)" bash test_deploy_secrets.sh
run "Front-end audit regressions (dashboard + Sync panel)" node --no-warnings test_frontend_fixes.mjs
if command -v xvfb-run >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then run "Real Chromium loads the quiz policy (AI refused, Web search + notes allowed, extensions off)" xvfb-run -a node --no-warnings test_chrome_policy_real.mjs; fi
if command -v pwsh >/dev/null 2>&1; then
  run "Windows agent/engine logic (titles, unlock retry, policy restore)" pwsh -NoProfile -File test_windows_logic.ps1
fi
if command -v pwsh >/dev/null 2>&1; then
  run "18/18 Windows email setup (real Setup-Identity, scripted dialogs)" pwsh -NoProfile -File test_windows_email_setup.ps1
else
  echo ""; echo "######## 18/18 Windows email setup ########"; echo "  skipped: PowerShell (pwsh) not installed here; runs on Windows CI"
fi

echo ""
echo "================================================"
if [ "$FAILED" -eq 0 ]; then
  echo "ALL SUITES PASSED ✅"
else
  echo "SOME SUITES FAILED ❌"
fi
echo "================================================"
exit $FAILED
