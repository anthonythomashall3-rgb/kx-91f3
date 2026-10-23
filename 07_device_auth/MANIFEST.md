# MANIFEST — 07_device_auth

Created 23 Oct 2026. Fix for the fake-lock hole: a student could fake a "locked" signal and get the quiz password. Fixed in code and tested (248 of 248 tests pass); rollout pending.

| File | What it is |
|---|---|
| DEVICE-AUTH.md | The hole; the fix (per-install key, signed requests, password only to a signed, locked device); other bugs fixed (28-domain blocklist, unlock quiz ID, live outage); proof; rollout steps; HECVAT replacement text; remaining limit. |

Code changes are in app/ (listed in DEVICE-AUTH.md). Copy in the claude.ai LOCKqz project as claude/LOCKqz-device-auth.md.
