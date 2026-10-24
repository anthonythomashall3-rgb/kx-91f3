#!/bin/bash
# LOCKqz master test runner. Runs every suite; one combined verdict.
# Safe: no root, no network required, no system changes (engine runs against fake hosts).
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
FAILED=0
run(){ echo ""; echo "######## $1 ########"; shift; "$@" || FAILED=1; }

run "1/16  Mac engine (block/unblock against fake hosts)"  bash   test_engine.sh
run "2/16  API enforcement logic (password gate)"          node   test_api_logic.mjs
run "3/16  Blocklist integrity (all AIs incl. Claude)"     node   test_blocklist.mjs
run "4/16  Mac daemon control plane (dry-run)"             bash   test_daemon.sh
run "5/16  Windows scripts structural lint"                python3 test_windows_lint.py
run "6/16  Edge cases (power loss, messy data, custom hosts)" bash test_edge_cases.sh
run "7/16  Brightspace URL parsing (all quiz URL shapes)"  node   test_url_parsing.mjs
run "8/16  Live quiz-monitor status + heartbeat logic"     node   test_live_status.mjs
run "9/16 Daemon reporting end-to-end (real HTTP, mock backend)" bash test_daemon_reporting.sh
run "10/16 Mac agent + browser policy (extension replacement)" python3 test_agent.py
run "11/16 Device authentication (real API, in-memory database)" node --no-warnings test_device_auth.mjs
if command -v pwsh >/dev/null 2>&1; then
  run "12/16 Windows device signing (real lockqzd.ps1 code)" pwsh -NoProfile -File test_windows_signing.ps1
else
  echo ""; echo "######## 12/14 Windows device signing ########"; echo "  skipped: PowerShell (pwsh) not installed here; runs on Windows CI"
fi
run "13/16 Access gate + teacher self-verify"               node   test_gate.mjs
run "14/16 Signed self-update (real daemon, mock release site)" bash test_update.sh
run "15/16 Professor Sync tab + quiz gate (real sync.js, simulated Brightspace)" node --no-warnings test_sync_gate.mjs
run "16/16 Security regressions (cross-course, D1 limits, auth, rate limits)" node --no-warnings test_security.mjs

echo ""
echo "================================================"
if [ "$FAILED" -eq 0 ]; then
  echo "ALL SUITES PASSED ✅"
else
  echo "SOME SUITES FAILED ❌"
fi
echo "================================================"
exit $FAILED
