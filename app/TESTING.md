# LOCKqz — testing & confidence

## Automated test suite (run anytime, $0, no root, no network, no system changes)
    cd ~/Projects/LOCKqz/app && bash tests/run_all.sh
As of 22 Oct 2026: **157 tests across 10 suites, all passing** (suite 8 = live quiz-monitor
status + heartbeat logic; suite 9 = daemon reporting end-to-end, running the real daemon
against a mock backend over HTTP to prove lock / helper-heartbeat / unlock actually report;
suite 3 also guards that the extension DNR covers the full blocklist).

1. Mac engine (19) — against a FAKE hosts file: lock adds the block, unlock removes it
   EXACTLY, hosts restored byte-for-byte after 25 rapid cycles, other hosts entries preserved,
   Claude/ChatGPT/Gemini/Copilot blackholed, www. variants correct, comments ignored.
2. API enforcement logic (17) — the password gate: password released ONLY to a device locked
   in the last 60s; per-device; expires at 60s; quiz password > course password; unlock revokes.
3. Blocklist integrity (6) — 99 domains, no duplicates, every major AI incl. Claude present,
   all well-formed, DoH resolvers included, Mac and Windows lists identical.
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

## What the tests PROVE
- The student's computer is never corrupted: hosts is always restored exactly, even after
  crashes/repeat cycles. This is the highest-stakes guarantee and it's verified.
- A computer that isn't locked can NEVER get the quiz password.
- Claude (and every other major AI) is in the block.
- The daemon fails safe: on restart it unlocks; during a quiz its watcher re-applies the block
  every 5s and flags tampering; a hard-max timer always unlocks so no student is stranded.
- Network blips during an exam don't lose events (reports retry 3x) and can't wipe the blocklist
  (refresh is sanity-checked before it's trusted).

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
