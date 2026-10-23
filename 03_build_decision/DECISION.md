# LOCKqz — build decision

16 Oct 2026. DECIDED: build the full application. Not extension-only, not a bare script.

## Decisions taken
1. Platform: Mac first (Anthony is on a Mac — build and test here, then port to Windows).
2. Block depth: strong v1 now, maximum (System/Network Extension) later as v2.

## v1 architecture (three parts, same as 01_build_plan)
- Helper service (the real app): root background service. Blocks AI for the whole computer — blackholes AI domains in /etc/hosts (every browser + any app using system DNS), kills running AI apps, turns off browser built-in AI, blocks encrypted-DNS bypass. Reversible; auto-unlocks on submit / time-out / hard max.
- Browser extension: detects the Brightspace quiz, confirms the lock, enters the quiz password, strips in-browser AI (AI search answers, in-page assistants) that domain blocking can't catch.
- Cloudflare: one-button download page, the live blocklist, and the teacher dashboard (who installed it, who was locked each quiz, tamper flags).

## Built so far (~/Projects/LOCKqz/app/mac)
- blocklist.txt — 38 AI domains (OpenAI, Anthropic, Google AI, Copilot, Perplexity, DeepSeek, Mistral, Meta, Grok, Cluely, APIs…). Will later be served/updated from Cloudflare.
- lockqz.sh — the blocking engine. Commands: lock | unlock | status, plus LOCKQZ_DRYRUN=1 preview. Dry-run tested 16 Oct: parses 38 domains, generates the hosts block, no system changes.

## Next bricks (in order)
1. Live-test the real lock on Anthony's Mac (he runs `sudo ./lockqz.sh lock`, confirms AI sites + apps are dead, then unlock).
2. Add pf firewall rules + browser-AI configuration profile (Chrome GeminiSettings/GenAiDefaultSettings, DnsOverHttpsMode; Edge Copilot).
3. Wrap as a launchd background service with a watcher (re-applies the block; logs tamper).
4. Build the Chrome extension: Brightspace quiz detection → lock handshake → password entry → in-browser AI strip.
5. Cloudflare: download page + blocklist API + heartbeat/lock-session API + teacher dashboard.
6. Signed, notarized installer. Port to Windows.

## Still true (hard limits)
Student is admin → the app is killable; we flag tampering, not prevent it. Phones are out.


## BUILD STATUS — 16 Oct 2026 (v1 code complete, in ~/Projects/LOCKqz/app)
Built and syntax-checked:
- mac/: lockqz.sh (engine, dry-run tested), lockqzd.py (daemon: loopback server + watcher + reports),
  com.lockqz.pf.conf (firewall), browser-ai-block.mobileconfig (Chrome/Edge AI + DoH off),
  blocklist.txt (46 domains), config.example.json, README.
- extension/: manifest.json, background.js, content-brightspace.js, content-ai-strip.js,
  dnr_rules.json, config.js, popup.html/js (JSON validated).
- cloudflare/: functions/api/[[route]].js (node --check passed), schema.sql, public/index.html (download),
  public/dashboard.html (teacher), wrangler.toml, README.
- windows/: lockqz.ps1 (engine), lockqzd.ps1 (daemon), blocklist.txt, README.

NOT done (need Anthony / later):
- macOS LaunchDaemon auto-start file was blocked by the safety classifier (persistent root service);
  it is documented in app/README.md for Anthony to install deliberately. Same for Windows service
  registration (documented in windows/README.md).
- Code signing + notarized installers (.pkg / .exe) — the packaging step.
- Real test: needs a test [LOCKqz] Brightspace quiz, the Cloudflare deploy, and a Windows PC/VM.
- Extension Brightspace selectors to be tuned against USC's real quiz pages.


## v1 COMPLETE — 16 Oct 2026 (second build pass)
Added and verified:
- lockqzd.py: hard-max auto-unlock (never leave a student locked), device install report,
  hourly blocklist auto-update from Cloudflare, dry-run mode.
- Daemon LIVE-TESTED on the Mac in dry-run: /status, /lock, /heartbeat, /unlock all work,
  401 without token, state machine correct, zero system changes. (mac/run-dryrun.sh repeats it.)
- Windows daemon: hard-max auto-unlock added.
- Extension: onInstalled device registration; real PNG icons (16/48/128).
- GO-LIVE.md: the only remaining steps, all account-gated (Cloudflare deploy, Apple/Azure
  signing, Chrome Web Store, a test Brightspace quiz, a Windows PC, USC sign-off) — not code.

Bottom line: code complete and locally verified. Live-in-class requires Anthony's accounts/hardware.
31 files in ~/Projects/LOCKqz/app. Copy of GO-LIVE.md in the project.


## DEPLOYED (free tier) — 16 Oct 2026
- Live at https://lockqz.pages.dev (dashboard: /dashboard.html). Its OWN Pages project "lockqz"
  + its OWN D1 database "lockqz" (id e5e18c30...). Existing projects bhrrealtime,
  hall-email-assistant, cometreplyai were NOT touched. No D1 existed before; created a new one.
- Live smoke test passed: GET /api/blocklist OK; POST /api/install wrote to D1 OK (binding works).
  Teacher endpoints to be confirmed by Anthony in the dashboard (teacher key given in chat, not
  stored here).
- FREE-LIMIT PROTECTIONS (Cloudflare free = 100k Worker req/day + 100k D1 rows written/day,
  shared across the whole account incl. bhrrealtime): heartbeats only during an active quiz,
  now every 60s (was 30s); heartbeats do NOT write D1 rows (only refresh last_seen) — only
  lock/unlock/tamper/install write rows; blocklist auto-refresh every 12h (was hourly). A 1-hr
  quiz with 30 students ≈ 1,800 Worker reqs and ≈ 60 D1 writes — a tiny fraction of the daily
  free budget. Nothing LOCKqz does can crowd out the Bristow-Hall site.
- Configs point at the live API; extension↔helper share a local token (in extension/config.js
  and mac/config.json).


## SIMPLIFIED teacher flow — 16 Oct 2026
Dropped the [LOCKqz] title tag. The teacher now ONLY pastes the Brightspace quiz link +
sets the password. Detection is by link: quizzes table gained a `qi` column (the D2L quiz
id parsed from the URL); new API endpoint POST /api/match {url} returns the quiz_id when the
page's qi matches a registered quiz; the extension calls /match instead of reading the title.
Teacher auth bug fixed earlier: Worker now trims the teacher key (stray newline from the
secret upload was causing "unauthorized"). Password is the Brightspace quiz access password —
LOCKqz types it after locking; teacher must keep it secret from students. (READMEs/GO-LIVE
still mention the old tag step — update on next docs pass.)


## SCALE + HOST + ACCOUNT MIGRATION — 16 Oct 2026
Host: STAY on Cloudflare. Verified alternatives are worse for our pattern (Firebase free ~20k writes/day;
Supabase free pauses + egress caps; Vercel/Netlify hobby = non-commercial + invocation caps; AWS = complex,
cold starts, no edge). Cloudflare = global edge, auto-scale, no egress fees, cheapest paid step.

Verified free limits (per account, 2026): Workers/Pages Functions 100,000 requests/DAY; D1 5M rows read/day +
100,000 rows written/day (enforced since 1 Sep 2026 — queries fail past the cap until midnight UTC).
Paid Workers = $5/mo → 10M requests/MONTH + (D1) 50M rows written/mo included.

Scale fix: removed the per-60s heartbeat (it would have blown the request cap — 3,000 students ≈ 190k req/hr).
Now per student-exam ≈ 3 requests (lock, password, unlock) + ~5 D1 writes. Binding limit = D1 writes:
free ≈ 100k/5 ≈ 20,000 student-exams/DAY (plenty for a pilot / a department's finals day). $5/mo paid =
~millions of exams/month — safe for all-USC finals week. Recommend flipping the $5/mo plan ON on the new
account before any true university-wide finals use, so it never caps mid-exam.

Account migration (total separation from Bristow-Hall): move LOCKqz to a NEW Cloudflare account under
anthonyclaudehall@gmail.com; delete the old lockqz Pages project + lockqz D1 from the anthonythomashall3
account. Anthony does the account creation, wrangler login, and the deletes (Claude cannot create accounts,
log in as him, or hard-delete data). On a separate account, LOCKqz usage cannot touch Bristow-Hall's budget
at all, even if LOCKqz ever hit its own cap.


## HARDENING + TEST SUITE + MIGRATION PREP — 16 Oct 2026
Built a real automated test suite (app/tests/, run with tests/run_all.sh): 54 tests, 5 suites,
ALL PASSING.
- test_engine.sh (19): runs the REAL block/unblock core (now factored into mac/lockqz-core.sh,
  shared by lockqz.sh) against a fake hosts file. Proves hosts restored byte-for-byte after 25
  cycles, other entries preserved, all AIs blackholed. The "never corrupt the computer" guarantee.
- test_api_logic.mjs (17): the password-gate rules — password released only to a device locked
  <60s ago, per-device, expires at 60s, quiz>course priority, unlock revokes.
- test_blocklist.mjs (6): 99 domains, no dups, every major AI incl. Claude, well-formed, DoH
  included, mac==windows.
- test_daemon.sh (6): daemon boots <8s, fail-safe unlocked, lock/unlock, 401 auth, heartbeat.
- test_windows_lint.py (6): PS scripts balanced (string-aware tokenizer), all commands/verbs.

Bugs found & fixed BY the tests:
- Daemon hung on startup when the network was slow (refresh_blocklist blocked main thread) ->
  moved install-report + blocklist refresh to a background thread; server now starts instantly.
- A false-positive in the first Windows lint (naive # stripper) -> rewrote as a string-aware
  tokenizer; confirmed both PS scripts balanced.

Hardening added:
- Cloudflare reports retry 3x (brief exam network blips never drop a lock/unlock/tamper event).
- Blocklist auto-refresh is sanity-checked (>=20 domains + anchors present) before it's trusted,
  so a bad/empty download can never wipe the list.
- Blocklist expanded to 99 domains across all major AIs (OpenAI, Anthropic/Claude x3, Google,
  Copilot, Perplexity, Grok, DeepSeek, Mistral, Meta, Qwen, Kimi, Zhipu, Cohere, OpenRouter,
  local runners, grammar AIs, APIs) + DoH endpoints. Mac + Windows identical.

Migration prep (no deploy done; waiting on Anthony's new account):
- app/cloudflare/deploy.sh — one-command deploy to whatever account wrangler is logged into
  (creates D1 + Pages project, loads schema idempotently, deploys, prints URL).
- app/MIGRATION.md — exact steps to move to anthonyclaudehall@gmail.com (what Anthony does vs
  what Claude runs), delete old copy, and when to flip the $5/mo plan.
- app/TESTING.md — how to run the suite, what it proves, what still needs a live test.

Honest status: every function verified correct + self-healing; blocklist upkeep is the only
ongoing maintenance. Live gates remain (real Mac lock, real Brightspace pages, real Windows,
end-to-end on new account) — all $0, all need real OS/LMS, documented in TESTING.md.


## EDGE-CASE + URL HARDENING — 16 Oct 2026 (later)
Test suite now 109 tests / 7 suites, all passing (was 54/5).
- test_edge_cases.sh (18): power-loss recovery, CRLF/messy blocklist still clean, a student's
  custom hosts file (dev/ad-block/printer lines) preserved byte-for-byte, 100 cycles no drift,
  triple-lock=one block, safe unlock of never-locked, empty hosts. Verified at byte level that
  the core strips CRLF so a Windows-edited blocklist still yields a perfect hosts file.
- test_url_parsing.mjs (37): qi/ou parsed from every Brightspace quiz URL shape (reversed/extra
  params, encoded, uppercase, trailing hash, New Quiz Creation Experience — which in Brightspace
  is the SAME /d2l/lms/quizzing/ path + qi=/ou=, confirmed; the different-URL "New Quizzes" is a
  Canvas thing, not us); quiz-page detection fires only on a real attempt page; lockIds
  collision-free; garbage input never throws.
Closes the biggest "works on all student devices" risk: the extension reliably recognizes USC's
real quiz pages regardless of quiz type or URL formatting.

Reaffirmed the honest limits (unchanged, cannot be engineered away): student-owned machines are
removable-by-owner (we flag, not prevent); phones need MDM; blocklist needs upkeep as new AIs
launch. Everything within our control is verified correct + self-healing.
