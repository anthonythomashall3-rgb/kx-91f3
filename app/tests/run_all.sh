#!/bin/bash
# LOCKqz master test runner. Runs every suite; one combined verdict.
# Safe: no root, no network required, no system changes (engine runs against fake hosts).
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
FAILED=0
run(){ echo ""; echo "######## $1 ########"; shift; "$@" || FAILED=1; }

run "1/10  Mac engine (block/unblock against fake hosts)"  bash   test_engine.sh
run "2/10  API enforcement logic (password gate)"          node   test_api_logic.mjs
run "3/10  Blocklist integrity (all AIs incl. Claude)"     node   test_blocklist.mjs
run "4/10  Mac daemon control plane (dry-run)"             bash   test_daemon.sh
run "5/10  Windows scripts structural lint"                python3 test_windows_lint.py
run "6/10  Edge cases (power loss, messy data, custom hosts)" bash test_edge_cases.sh
run "7/10  Brightspace URL parsing (all quiz URL shapes)"  node   test_url_parsing.mjs
run "8/10  Live quiz-monitor status + heartbeat logic"     node   test_live_status.mjs
run "9/10 Daemon reporting end-to-end (real HTTP, mock backend)" bash test_daemon_reporting.sh
run "10/10 Mac agent + browser policy (extension replacement)" python3 test_agent.py

echo ""
echo "================================================"
if [ "$FAILED" -eq 0 ]; then
  echo "ALL SUITES PASSED ✅"
else
  echo "SOME SUITES FAILED ❌"
fi
echo "================================================"
exit $FAILED
