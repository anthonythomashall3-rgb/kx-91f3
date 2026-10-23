#!/bin/bash
# LOCKqz master test runner. Runs every suite; one combined verdict.
# Safe: no root, no network required, no system changes (engine runs against fake hosts).
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
FAILED=0
run(){ echo ""; echo "######## $1 ########"; shift; "$@" || FAILED=1; }

run "1/12  Mac engine (block/unblock against fake hosts)"  bash   test_engine.sh
run "2/13  API enforcement logic (password gate)"          node   test_api_logic.mjs
run "13/13 Access gate + teacher self-verify"               node   test_gate.mjs
run "3/12  Blocklist integrity (all AIs incl. Claude)"     node   test_blocklist.mjs
run "4/12  Mac daemon control plane (dry-run)"             bash   test_daemon.sh
run "5/12  Windows scripts structural lint"                python3 test_windows_lint.py
run "6/12  Edge cases (power loss, messy data, custom hosts)" bash test_edge_cases.sh
run "7/12  Brightspace URL parsing (all quiz URL shapes)"  node   test_url_parsing.mjs
run "8/12  Live quiz-monitor status + heartbeat logic"     node   test_live_status.mjs
run "9/12 Daemon reporting end-to-end (real HTTP, mock backend)" bash test_daemon_reporting.sh
run "10/12 Mac agent + browser policy (extension replacement)" python3 test_agent.py
run "11/12 Device authentication (real API, in-memory database)" node --no-warnings test_device_auth.mjs
if command -v pwsh >/dev/null 2>&1; then
  run "12/12 Windows device signing (real lockqzd.ps1 code)" pwsh -NoProfile -File test_windows_signing.ps1
else
  echo ""; echo "######## 12/12 Windows device signing ########"; echo "  skipped: PowerShell (pwsh) not installed here; runs on Windows CI"
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
