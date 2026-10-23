# LOCKqz device authentication (fake-lock fix)

23 Oct 2026. Fixed in code and tested. Not fully rolled out yet (see Rollout).

## The hole
The API trusted any request. A script on any computer, with no LOCKqz installed, could post a "lock" report for a quiz and then ask for that quiz's access password, and the server handed it over. The HECVAT disclosed this (START HERE, C27: "device reports to the API are not yet signed per device, so lock status is self-reported").

## The fix
- Each install makes a random 256-bit key that only the system-level helper can read: root on Mac (`/Library/Application Support/LOCKqz/device.key`, mode 600), SYSTEM and Administrators on Windows (`C:\ProgramData\LOCKqz\device.key`).
- The helper registers the key once (`/api/register`). A device ID can never get a different key, and the administrator can revoke a device (`/api/revoke-device`).
- Every helper request is signed: HMAC-SHA256 over the method, path, Unix time and SHA-256 of the body (headers `X-LOCKqz-Device`, `X-LOCKqz-Time`, `X-LOCKqz-Sig`). The time must be within 5 minutes of the server's; on a refusal the server sends its time, so a wrong student clock corrects itself.
- The quiz password goes only to a registered device whose signed helper reported the lock in the last 60 seconds. The per-user agent no longer asks the server; it asks the local helper, which forwards the request only while it is locked for that quiz with the block in place.
- Unsigned heartbeats can't keep a lock alive. Every release is logged (`password_released`, with a verified flag and IP address), and the live monitor shows whether each device is verified.
- Switch: with the Pages variable `REQUIRE_SIGNED` unset, old unsigned installs keep working, but a registered device can't be impersonated. With `REQUIRE_SIGNED=1`, unsigned requests are refused.

## Also fixed
- Blocklist: the server sent only 28 AI domains, and the Mac helper replaced its 99-domain list with the server's at startup and every 12 hours, so installed Macs blocked only 28 (live server confirmed at 28 on 23 Oct). The server now sends all 99, and a refresh can only add domains, never remove one.
- Unlock reports now carry the quiz ID, so the live monitor shows "done" instead of the device going dark.
- Live outage, 23 Oct: another chat deployed the new API before its database columns existed, so `/api/password` returned an error. Fixed by applying `migrate_009_device_auth.sql` to the live database; checked on lockqz.pages.dev and prof.lockqz.pages.dev.
- Tests: both daemon tests now pick free ports and stop their daemon (one used to leave a daemon running).

## Proof
248 tests across 12 suites pass (`bash tests/run_all.sh`). New: suite 11, device authentication (61 checks on the real API code), and suite 12, Windows signing (10 checks under PowerShell). Suite 9 grew to 26. The same checks fail on the old code, which handed the password to the fake lock. End to end with `wrangler pages dev` in strict mode and the real Mac and Windows helpers: fake lock and fake password refused, the real install got the password, impersonation refused, no password after unlock.

## Files (not yet committed)
`app/cloudflare/functions/api/[[route]].js`, `migrate_009_device_auth.sql`, `schema.sql`; `app/mac/lockqzd.py`, `lockqz-agent.py`; `app/windows/lockqzd.ps1`, `lockqz-agent.ps1`; `app/tests/` (`test_device_auth.mjs`, `test_windows_signing.ps1`, `test_daemon_reporting.sh`, `test_daemon.sh`, `test_blocklist.mjs`, `run_all.sh`); `app/TESTING.md`, `app/USC-REVIEW.md`.

## Rollout (this closes the hole for real)
1. Deploy: `cd app/cloudflare && bash deploy.sh`. This also restores the 99-domain list on installed Macs at their next refresh.
2. Commit and push, so CI builds the new Mac pkg and Windows exe; publish them on the download page.
3. Students reinstall once. The live monitor shows which devices are verified.
4. When every active device is verified: `npx wrangler pages secret put REQUIRE_SIGNED --project-name lockqz` (value `1`), then redeploy.
5. Check that an unsigned POST to `/api/password` returns 401.
6. Update the HECVAT (below).

## HECVAT text after step 4 (START HERE, C27)
Add after "...time-out or a hard maximum.": "Every request from the helper to the API is signed with a per-install key (HMAC-SHA256) that only the system-level helper can read, and a quiz password is released only to a registered device whose signed helper reported the lock in the last 60 seconds."

Replace "device reports to the API are not yet signed per device, so lock status is self-reported;" with "a student with administrator rights on their own computer could read that computer's key and sign requests as it (every password release is logged with the device and IP address);".

## Remaining limit
A student with administrator rights on their own computer can read that computer's key and forge requests as that one computer. They can't act as another student, and every release is logged. Closing this fully would need hardware attestation (Secure Enclave or TPM), which is out of scope for the pilot.

Copy on the Mac: `~/Projects/LOCKqz/07_device_auth/DEVICE-AUTH.md`.
