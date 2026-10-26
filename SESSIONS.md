# LOCKqz — sessions working on this repo (read before you start, update when you start/finish)

Several Claude sessions work on LOCKqz at the same time. They can't message each other, so this file
is how they stay in sync. **Every session: `git pull --rebase` first, read this file, claim what you
will touch (one line under "Working now", committed and pushed BEFORE you edit), and remove your line
when you push the finished work.** Do not edit files another session has claimed; if you must, add a
note under "Requests" instead. Stale claims (older than 3 hours with no commit) may be taken over.

## Working now
- 2026-10-26 03:50 PT — 01S7QxVq: auto-gate every protected quiz (sync.js), no password for an ungated protected quiz (REQUIRE_GATE) + professor email, agent text gate_off. Claims sync.js, functions/api, agents, tests.

## Recently finished
- 2026-10-25 23:59 PT — 01S7QxVq: v0.4.8. Trial testers (FEE_EXEMPT: Bristow x2, Huu) never pay + test-run welcome (dashboard, once; code email); public/lq.js = LOCK black/qz red everywhere + red lock loaders (ETA + fun fact) on dashboard, pay page, Sync panel; no uninstall option on the download page; privacy contact lockqz.app@gmail.com; owner's name removed from every page; gate never admits unpaid students.
- 2026-10-25 22:30 PT — 01S7QxVq: students pay $180 (STUDENT_FEE), Zelle + bank transfer only (Venmo off unless STUDENT_VENMO=1; ZELLE_BUSINESS_TO replaces personal Zelle when the business account opens); fee on = confirmed email always; a paid email cannot be in a quiz on 2 computers at once or on >2 computers (402 in_use / too_many_devices, agents explain); Gmail script every 1 min, amount never read from the memo, bank deposits with a memo -> admin review. Mac/Windows agent text needs the next release. Known pre-existing fail: test_daemon_reporting 'no signed developer lock'.
- 2026-10-25 21:00 PT — 01CsgBZK: dashboard "Sync now" button: asks the open Sync tab in Brightspace to sync (postMessage, no extra LOCKqz requests); no tab -> opens Brightspace for one bookmark click; tested in real Chromium (test_dashboard_sync_now.mjs).
- 2026-10-25 18:45 PT — 01CsgBZK: v0.4.6. Content-quiz move tested in REAL browsers (Windows CI: Chrome, Edge, Firefox via test_windows_content_move.ps1 in release.yml; Mac: Safari + Chrome via test_safari_content_move.py, real Mac only). Fixed: Windows agent never read Firefox's address bar (ComboBox urlbar-input); Mac move throttled 10 s. Sync panel auto re-syncs every 15 min while open (0 LOCKqz requests when Brightspace is unchanged; forced hourly); professor emailed once when a student opens a quiz newer than the last Sync (migrate_026 sync_nudges).
- 2026-10-25 17:15 PT — 01DfSvcn: D1 reset done: typed-email devices verified (Anthony's 2 Macs), full Release 40247705357 green, v0.4.5 live; Anthony's agent back on, verified, no dialog.
- 2026-10-25 16:45 PT — 01CsgBZK: quizzes opened from Content/Lessons are moved out of the frame to their own page (Mac AppleScript / Windows address bar), so submission shows and AI returns at once; Firefox reads the frame's URL from the session store; v0.4.5.
- 2026-10-25 15:45 PT — 01CsgBZK: quizzes opened from Content/Lessons now lock (fullscreen ViewLocation ?location= decoded by Mac/Windows agents + server ids()); Brightspace's own AI chat widget chat.learnwise.ai blocked; v0.4.4. ONE deploy at 5 pm: 01CsgBZK has scheduled sessions at 17:10/17:12 PT that run release-local.sh + deploy.sh and SKIP if /api/version already shows HEAD's version (e.g. a Release workflow_dispatch ran first).
- 2026-10-25 13:55 PT — 01DfSvcn: student email typed ONCE ever (saved at once, no error popups, quiet retries; proof of confirmed email survives reinstall); D1 write-cap -> 503 server_busy; USC sections run capped at 3,000 rows. 5pm PT (D1 reset): mark real users' devices verified, run full Release (workflow_dispatch), restart Anthony's agent.
- 2026-10-25 14:00 PT — 01DTnJE2: USC sections refresh weekly outside registration/add-drop; events left as is (already minimal: heartbeats not logged, installs throttled, each of its 3 indexes is used by /password, /live or rate limits).
- 2026-10-25 12:59 PT — 01DTnJE2: student fee on, USC term dates, renewal emails (9d22c7a, 3d1081e).
- 2026-10-25 13:28 PT — 01DfSvcn: Windows/Mac clients, student email once, Chrome AI off (v0.4.3).

## Requests (for whichever session picks them up)
- (none)
