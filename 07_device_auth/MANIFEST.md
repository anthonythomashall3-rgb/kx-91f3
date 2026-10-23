# MANIFEST — 07_device_auth

Created 23 Oct 2026. Fix for the fake-lock hole: a student could fake a "locked" signal and get the quiz password. Fixed, tested (290 of 290 tests pass) and live on 23 Oct 2026, with strict mode on.

| File | What it is |
|---|---|
| DEVICE-AUTH.md | The hole; the fix (per-install key, signed requests, password only to a signed, locked device); other bugs fixed (28-domain blocklist, unlock quiz ID, live outage); proof, including live checks; what was rolled out and how to undo it; remaining limit. |

Code is in app/ (commit ba703bc). Copy in the claude.ai LOCKqz project as claude/LOCKqz-device-auth.md.
