#!/bin/bash
# launchd entry point for the LOCKqz helper. Repairs python3 if a macOS upgrade removed Apple's
# tools, then runs the daemon. If python3 cannot be repaired, waits a minute so launchd's
# KeepAlive retries without spinning.
DEST="$(cd "$(dirname "$0")" && pwd)"
bash "$DEST/ensure-python.sh" || sleep 60
exec /usr/bin/python3 "$DEST/lockqzd.py"
