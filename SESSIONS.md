# LOCKqz — sessions working on this repo (read before you start, update when you start/finish)

Several Claude sessions work on LOCKqz at the same time. They can't message each other, so this file
is how they stay in sync. **Every session: `git pull --rebase` first, read this file, claim what you
will touch (one line under "Working now", committed and pushed BEFORE you edit), and remove your line
when you push the finished work.** Do not edit files another session has claimed; if you must, add a
note under "Requests" instead. Stale claims (older than 3 hours with no commit) may be taken over.

## Working now
- 2026-10-25 16:35 PT — 01CsgBZK: Content-frame quizzes moved to their own page so submission is visible (Mac + Windows agents), Firefox frame URL from session store, v0.4.5. Files: app/mac/lockqz-agent.py, app/windows/lockqz-agent.ps1, tests/test_agent.py, VERSION + helper versions.

## Recently finished
- 2026-10-25 15:45 PT — 01CsgBZK: quizzes opened from Content/Lessons now lock (fullscreen ViewLocation ?location= decoded by Mac/Windows agents + server ids()); Brightspace's own AI chat widget chat.learnwise.ai blocked; v0.4.4. ONE deploy at 5 pm: 01CsgBZK has scheduled sessions at 17:10/17:12 PT that run release-local.sh + deploy.sh and SKIP if /api/version already shows HEAD's version (e.g. a Release workflow_dispatch ran first).
- 2026-10-25 13:55 PT — 01DfSvcn: student email typed ONCE ever (saved at once, no error popups, quiet retries; proof of confirmed email survives reinstall); D1 write-cap -> 503 server_busy; USC sections run capped at 3,000 rows. 5pm PT (D1 reset): mark real users' devices verified, run full Release (workflow_dispatch), restart Anthony's agent.
- 2026-10-25 14:00 PT — 01DTnJE2: USC sections refresh weekly outside registration/add-drop; events left as is (already minimal: heartbeats not logged, installs throttled, each of its 3 indexes is used by /password, /live or rate limits).
- 2026-10-25 12:59 PT — 01DTnJE2: student fee on, USC term dates, renewal emails (9d22c7a, 3d1081e).
- 2026-10-25 13:28 PT — 01DfSvcn: Windows/Mac clients, student email once, Chrome AI off (v0.4.3).

## Requests (for whichever session picks them up)
- (none)
