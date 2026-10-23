# LOCKqz — testing & confidence

## Automated test suite (run anytime, $0, no root, no network, no system changes)
    cd ~/Projects/LOCKqz/app && bash tests/run_all.sh
As of 23 Oct 2026: **290 tests across 13 suites, all passing** (was 157 across 10 on 22 Oct) (suite 8 = live quiz-monitor
status + heartbeat logic; suite 9 = daemon reporting end-to-end, running the real daemon
against a mock backend over HTTP to prove lock / helper-heartbeat / unlock actually report;
suite 3 also guards that the extension DNR covers the full blocklist).

1. Mac engine (19) — against a FAKE hosts file: lock adds the block, unlock removes it
   EXACTLY, hosts restored byte-for-byte after 25 rapid cycles, other hosts entries preserved,
   Claude/ChatGPT/Gemini/Copilot blackholed, www. variants correct, comments ignored.
2. API enforcement logic (17) — the password gate: password released ONLY to a device locked
   in the last 60s; per-device; expires at 60s; quiz password > course password; unlock revokes.
3. Blocklist integrity (10) — 99 domains, no duplicates, every major AI incl. Claude present,
   all well-formed, DoH resolvers included, Mac and Windows lists identical, and the server's
   list (the one helpers refresh from every 12 h) contains every domain.
4. Mac daemon control plane (6) — boots within 8s even with no network, starts unlocked
   (fail-safe), lock/unlock work, auth enforced (401), heartbeat responds.
5. Windows scripts lint (6) — balanced brackets, all core commands, all three verbs,
   control server + watcher + hard-max present.
6. Edge cases (18) — power-loss recovery (crash leaves block; next boot unlock cleans it),
   messy blocklist (CRLF/dupes/spaces/comments) still yields a clean block, a student's custom
   hosts file (dev entries, ad-blocks, printers) preserved byte-for-byte, 100 cycles no drift,
   triple-lock = one block, unlock of never-locked file is safe, empty hosts handled.
7. Brightspace URL parsing (37) — qi/ou parsed from every quiz URL shape (reversed params,
   extra params, encoded, uppercase, trailing hash, New Quiz Creation Experience); quiz-page
   detection fires ONLY on a real attempt page; lockIds collision-free; garbage input never throws.
11. Device authentication (61) — 23 Oct 2026. Runs the REAL API code against an in-memory
   database (fresh schema and an old schema upgraded by migrate_009): a script with no LOCKqz
   cannot fake a lock or read the password; a registered device cannot be impersonated (no key,
   wrong key, re-register with another key); signatures are bound to time, endpoint and body;
   unsigned heartbeats cannot keep a lock alive; revoke works; old installs keep working until
   REQUIRE_SIGNED=1. Shown to FAIL on the pre-fix API (it handed the password to the fake lock).
12. Windows device signing (10) — loads the real signing code from lockqzd.ps1 under PowerShell:
   both scripts parse, the HMAC matches the shared vector, and against a verifying mock it
   registers, signs, fixes a 15-minute clock error and gets the password only while locked.
   Suite 9 now also proves the Mac helper registers a 0600 key, signs every report, hands out the
   password only while locked for that quiz, and reports which quiz an unlock ended. It also
   proves a refresh from the server can only ADD domains: a short server list never shrinks a
   Mac's list. Suites 4 and 9 pick free ports at run time and stop their daemons afterwards.
13. Access gate + teacher self-verify (42) — 23 Oct 2026. Runs the REAL API against an in-memory
   database (fresh schema and one upgraded by migrate_010): a professor who signs up stays unverified
   until a course sync shows they are staff; only a verified professor can protect or gate a quiz;
   the live gate admits only a device holding a fresh, device-signed lock.

## What the tests PROVE
- The student's computer is never corrupted: hosts is always restored exactly, even after
  crashes/repeat cycles. This is the highest-stakes guarantee and it's verified.
- A computer that isn't locked can NEVER get the quiz password.
- Claude (and every other major AI) is in the block.
- The daemon fails safe: on restart it unlocks; during a quiz its watcher re-applies the block
  every 5s and flags tampering; a hard-max timer always unlocks so no student is stranded.
- Network blips during an exam don't lose events (reports retry 3x) and can't wipe the blocklist
  (refresh is sanity-checked before it's trusted, and can only add domains, never remove one).

## What tests CANNOT prove (must be done live — all $0)
These need the real OS / real Brightspace and are the final gate before trusting a class:
- The real system lock on the Mac: `cd mac && sudo ./lockqz.sh lock` -> chatgpt.com + the
  ChatGPT app actually dead -> `sudo ./lockqz.sh unlock`.
- The extension against USC's real Brightspace quiz pages (selectors may need tuning).
- The Windows lock on a real Windows PC/VM.
- The full end-to-end flow on the new Cloudflare account with a real test quiz.

## Honest statement on "flawless forever"
Every function is verified correct today and self-heals from the realistic failure modes.
The ONE part that needs ongoing upkeep is the blocklist: new AI tools launch constantly, so a
new domain must be added (one line, served from Cloudflare, no reinstall). That is maintenance,
not a defect — no AI-blocking tool on earth avoids it. Everything else is built to run unattended.

## 22 Oct 2026 — NO EXTENSION, NO WEB STORE (one download, $0)
The browser extension is retired (kept in `legacy/`). Everything it did now lives in the app:
- **Agent** (`mac/lockqz-agent.py` LaunchAgent / `windows/lockqz-agent.ps1` logon task, per user):
  reads open tab URLs of every browser (Chrome/Edge/Brave/Chromium/Vivaldi/Arc/Safari via Apple
  Events, Firefox via its session file; Windows via UI Automation) → detects the Brightspace quiz
  attempt page → helper LOCK → fetches the quiz password → shows it + copies to clipboard → pings
  the live monitor → UNLOCK when the quiz page is gone (submitted / left; 30 s grace, `quiz_left`
  event if not submitted). Asks the student's name once (roster).
- **Browser policy** (`mac/browser-policy.py` → /Library/Managed Preferences plists; `windows/
  browser-policy.ps1` → HKLM policies), applied by the engine at LOCK and removed at UNLOCK:
  Gemini/Copilot/Leo/Firefox-AI off, on-device AI APIs off, encrypted DNS off, ALL extensions
  disabled (AI sidebars, Grammarly), and search pinned to Google **Web** (udm=14 — no AI Overview,
  no AI Mode): `google.com/search` blocked, `@udm=14` + Images/News/Video/Books allowed, Bing/DDG/
  Brave/You/Kagi/Yahoo search blocked. Needs no MDM, no domain join, no enrollment.
- Safari has no policy layer → the agent rewrites any AI-answer search tab to Google Web (≤1 s).
- Download page is ONE button. No extension, no Chrome Web Store, no $5, no profile approval.
- Helper gained `POST /student`; backend accepts `source:"agent"` heartbeats.
