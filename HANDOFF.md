# LOCKqz — HANDOFF (28 Oct 2026) — start here

A new Claude account picks up from here. Read this file, then `SESSIONS.md`, then `CLAUDE.md` (the repo
rules: pull --rebase, claim in SESSIONS.md, `bash app/tests/run_all.sh` before every push, $0 plans only,
commit as `Claude <noreply@anthropic.com>`). The claude.ai Project "LOCKqz" has the same handoff
(`claude/LOCKqz-HANDOFF.md`) plus topic docs (`claude/LOCKqz-payments.md` and others).

## 28 Oct 2026 — scale audit (session 015umora)
- **Free-plan ceiling (the real limit today).** Workers/Pages Functions Free = 100,000 requests/day (over it: Error 1027
  until 00:00 UTC, i.e. students cannot get quiz passwords); D1 Free = 100,000 rows written/day, 5M rows read/day;
  10 ms CPU per request. LOCKqz traffic: idle student ~0 (blocklist/update are static files); one student-exam
  ~16 requests + ~16 rows written (password 1-2, lock 1, helper heartbeat every 5 min, unlock 1); one gated exam's
  professor tab ~6 requests/min (/live every 10 s, /rotating every 5 min) = ~900 per 2.5 h exam. => roughly
  **4,000-5,000 student exam sittings per day** on the free plan. A single university's finals week exceeds that.
  Workers Paid ($5/month: 10M requests/month included, D1 25B reads + 50M writes/month included, 30 s CPU) covers
  hundreds of thousands of students for a few dollars a month. Anthony's $0 rule blocks this — his call.
- **Email is the second ceiling:** one consumer Gmail = 500 messages/day (LOCKqz budget 480 essential / 250 auto).
  Every new student's email code uses one, so ~480 new students/day can confirm their email. Google sign-in (in
  progress, session 01UzHDaF) removes most codes; at real scale a transactional sender (SES / Postmark) is needed.
- **Third: Gmail script runtime.** Google gives free accounts 90 min/day of trigger runtime; the every-minute
  script used ~50 min/day. Bank-question search now runs every 5 min (payment alerts stay every minute). If it
  ever exceeds 90 min, Zelle matching + /cron (reminders, T-70, renewals) stop until the next day.
- **Fixed now:** migrate_037_scale_indexes.sql — 11 indexes for queries that read a whole table on hot paths
  (/register per-IP limit, /password class-coverage check, class lists' "who has LOCKqz", sign-in by email,
  dashboard quizzes, support limits, cleanups). New test test_scale_indexes.mjs plans every plain-string API query
  against schema + migrations and fails on any full scan of a big table (bounded/admin-only exceptions listed).
  Don't add these indexes to schema.sql (older-schema tests and fresh DBs build tables in migrations).
- **Not built for nationwide yet (product scope, not tuning):** USC Brightspace only (host permissions, URL
  parsing, USC terms/sections, USC roster trust); Mac + Windows only (K-12 is mostly Chromebooks/iPads — the
  hosts-file approach cannot run there; needs managed Chrome policy via the school's Google Admin); Canvas /
  Schoology / Google Classroom / Moodle need their own connectors; one D1 database (single writer) — at hundreds
  of thousands of simultaneous exam starts, shard per institution.

## 28 Oct 2026 — health audit (session 015umora)
- **Deploys were silently failing.** Release #90-#92 (20b217f, c097c45, 042702e) died in "Build the signed update
  manifest": the agents (`lockqz-agent.py` / `lockqz-agent.ps1`, status-truth ready notice) changed while the version
  stayed 0.5.3, so `make-manifest.py` E10 refused to sign and the live site stayed on 50b1676. Fixed by bumping to
  **v0.5.4** (app/VERSION + both daemons). Rule of thumb: ANY change under app/mac or app/windows needs a version bump
  in the same push, or nothing deploys (not even the API). Check `curl https://lockqz.pages.dev/api/version` after a push.
- `bash app/tests/run_all.sh` all green at 042702e (~2,100 checks; pwsh suites run on Windows CI).
- Blocklist: +88 hosts (blocklist.txt x2 + AI_DOMAINS; test_blocklist T14): quiz-answer tools (SmartSolve, Homeworkify,
  Quizard, QuizGecko, Microsoft Math Solver, Cymath, CameraMath, MathGPT, TurboLearn, Mindgrasp, Coconote, Scholarcy,
  ExplainPaper, Gizmo), coding agents (Replit, Sourcegraph/Cody, Devin, Augment, Qodo, Bito, Warp AI, Continue, PearAI,
  CodeGPT, Firebase Studio / IDX, Google Opal + Stitch), portals + gateways (chat.com, Azure AI Foundry portal, Azure OpenAI
  Studio, Copilot Studio, Amazon Nova, Ernie, Yandex Alice, Naver CLOVA X, Kilo Code, Requesty, Glama, NanoGPT, Portkey,
  Chutes, Featherless, Lambda, Exa, Morphic), writers/humanizers (LanguageTool, ProWritingAid, Hemingway, Wordvice,
  Paraphrasingtool.ai, Editpad, essay writers, Textero, Samwell, Yomu, Writefull, Trinka, Walter Writes, Phrasly, Ryne,
  Twixify, AIHumanizer, HumanizeAI.io), ChatGPT wrappers. Quizlet / Studocu / Knowt deliberately stay open (notes +
  flashcards, test T10). AI_DOMAINS must stay plain JSON (no comments inside the array): deploy.sh JSON.parses it.
- **Chrome Web Store:** "LOCKqz for Professors" item `bidlfpkdggdpmfbfkpjcnbjhfkfligkk` submitted 28 Oct, Unlisted, **pending review**.
  Branch `cws-live` (tests green) points the dashboard's Chrome + Edge buttons and the welcome email at
  https://chromewebstore.google.com/detail/bidlfpkdggdpmfbfkpjcnbjhfkfligkk — merge it to master ONLY once that page
  is live (before approval the link is a dead page). Edge installs from the Chrome Web Store, so no Edge listing is needed.
- **Support:** gear → Contact support opens lockqz.pages.dev/support; messages arrive in lockqz.app@gmail.com (Reply-To = the sender, so just hit Reply). 'Email me my receipts' is gone from the gear.
- **AI audit 2 (v0.5.5):** +101 hosts and Mac/Windows app additions (see SESSIONS.md). Gaps host/app blocking can't
  close: per-customer subdomains (<resource>.openai.azure.com, *.workers.dev / *.vercel.app / *.hf.space proxies) for
  CLIs and desktop apps (browsers already block subdomains) - needs a local wildcard DNS resolver; Cloudflare Workers AI
  (api.cloudflare.com, shared); AI inside kept-open notes apps (Notion, Canva, Acrobat, Slack, Goodnotes); the Mac's
  built-in AirPlay receiver (a phone mirrored to the Mac has no process to kill - candidate: turn the receiver off
  during the quiz, not yet checked).
- Reminder: /etc/hosts entries are exact names (+www.); subdomains are covered only inside Chromium/Firefox (URLBlocklist)
  and by the agent. Known gaps list below (27 Oct) still stands.

## 27 Oct 2026 — AI inside other apps + student workarounds audit (session 01UzHDaF)
- **How an in-app AI is stopped** (Claude for Excel, Copilot in Word/Excel/PowerPoint/Outlook, editor assistants,
  Raycast AI, any add-in): it must reach its provider over the network, and the hosts block (IPv4 + IPv6) routes
  those hosts nowhere during a quiz. 59 hosts added (blocklist.txt x2 + AI_DOMAINS in [[route]].js; test T13):
  Office Copilot's back end `augloop.office.com`, Bing Copilot Search, DuckDuckGo / Kagi AI pages, Brave Leo,
  Zed / Tabnine / Supermaven / JetBrains / Amazon Q back ends, cloud model endpoints (Azure OpenAI + AI Foundry,
  Vertex AI, Bedrock, HF inference, SiliconFlow, Volcano Ark, RunPod, Modal, Baseten, Nebius, Friendli, Lepton,
  llama-api), Raycast, more chat/PDF AIs, solvers (WolframAlpha, Numerade, Bartleby, Socratic), writers /
  humanizers, app builders, extension back ends. `substrate.office.com` deliberately NOT blocked (Outlook search).
- **Phone screen on the computer:** iPhone Mirroring (Mac) and Phone Link (Windows) show the phone's own AI apps on
  the laptop screen over the phone's network, past every block -> now closed at lock (REMOTE_APPS / $RemoteApps),
  with Screens, NoMachine, Zoho Assist. Grok / Kimi / Qwen / Microsoft 365 Copilot desktop apps added to AI_APPS.
- **Already covered (verified this audit, no change needed):** Google AI Mode (`udm=50`) is rewritten to plain web
  results by the agent + Chromium/Firefox policies; AI Overviews cannot be removed without blocking Google search
  (left open by design); DoH/DoT, Tor, VPNs, system proxies, VMs, remote desktop, overlays, local models (apps +
  ports), Apple Intelligence, Gemini in Workspace (`appsgenaiserver-pa.*` blocked).
- **Known narrow gaps (honest list):**
  1. *Warm connection:* an app LOCKqz does not close (Office, Notion, Slack ...) that already holds an open
     keep-alive HTTPS connection to an AI host when the quiz opens can reuse it until the server idles it out
     (minutes). Browsers' AI tabs are blanked and AI apps killed, so this only applies to AI embedded in a kept-open
     app, and only if the student pre-warmed it right before opening the quiz. Blocking the resolved IPs is NOT an
     option (Cloudflare/Google anycast = would black out half the web incl. Brightspace/LOCKqz); killing Office's
     WebKit networking helpers was judged too risky for a live exam. Accepted.
  2. *AI in a host we cannot isolate:* Notion AI (notion.so), Google AI Overviews on ordinary search, AI replies
     inside messaging apps (WhatsApp / Telegram / Discord bots) - blocking the host would block the notes / search /
     app itself. Human help over messaging is out of scope by design (LOCKqz blocks AI, not people).
  3. *An SSH `-D` SOCKS tunnel* set as a per-app proxy (CLI-level): system/browser proxies are forced off, so only a
     hand-configured tool is affected; outbound 22 is not blocked (would break git/ssh). Admin-equivalent effort.
  4. The inherent ones: admin on their own laptop, a second device / phone, booting another OS. Only managed
     laptops or live proctoring close these (stated on the professor side).
- Tests: test_blocklist T13 (new hosts + the phone-mirroring kills), test_windows_lint; test_update.sh now waits for
  its two async lines instead of racing them (it flaked only under full-suite load).

## 27 Oct 2026 — student card auto-renew + download-page gear (session 01UzHDaF)
- **Card renews EVERY term (Fall, Spring AND Summer).** Student Checkout saves the card (Customer +
  `setup_future_usage=off_session`, no Stripe Billing). Table `card_renew` (migrate_033). `/pay/tick` (Gmail script,
  hourly) arms each saved card for the term and charges off-session on the first day a payment counts for it
  (term start − 42 days: ~30 Nov for Spring, ~7 Apr for Summer, ~13 Jul for Fall), idempotency key per
  email+term+try. **No reminder email before the charge** (Anthony 27 Oct — not required). A confirmation email is
  still sent after the first card payment. Declined = student emailed the pay link once, retried once a day (3 tries;
  never when the bank asks to confirm). Refund/dispute voids it and turns auto-renew off. Off switch:
  `STUDENT_AUTORENEW="0"`. Professors stay one-time.
- Pay page: button "Pay $280 by card · renews each semester" + one normal line "Renews automatically each semester
  at $280. Cancel anytime: gear icon → Account." (amounts computed).
- **Gear icon (top right of lockqz.pages.dev, `public/account.js`)**: Account (sign in with an emailed 6-digit code,
  same limits as the app's codes; 30-day signed token) → paid / not paid + Pay link, **Cancel subscription**
  (stops auto-renew ONLY; the current term's access stays; a refund of the current term is the student's bank, not
  LOCKqz) / Turn auto-renew on, your computers (READ-ONLY — no remove; freeing a computer is admin-only via
  lockqz.app@gmail.com), Sign out. Settings: Email me my receipts (10 min), Privacy, Support.
  API: `POST /api/account` ops send | code | status | renew | receipts (no `remove`).
- CI's Stripe step now also adds `payment_intent.succeeded` to the existing webhook (same secret).
- Tests: test_autorenew.mjs (57), test_account_menu.mjs (real Chromium, 38; skipped without Playwright).

## 26 Oct 2026 06:30 PT — income tax on top, Venmo, bank auto-email, professor tour (session 01359vfr)
- **Whole-number prices with "Tax & fees" = 25% of the total** (Anthony, 26 Oct 06:05; TAX_LABEL, STUDENT_TOTAL, STUDENT_OTHER_TOTAL, PROF_TOTAL, PROF_CARD_TOTAL):
  totals are set; base = 75% of the total so Anthony keeps the base after setting aside income tax. Vars: TAX_RATE="0.25",
  TAX_FROM="2026-10-26T13:00:00Z" (empty = off). Payments before TAX_FROM count 1:1.
  | Student | base | total |  | Professor | base | total |
  |---|---|---|---|---|---|---|
  | Zelle / bank transfer | $180 | $240 | | Zelle / bank / Venmo / PO | $4,875 | $6,500 |
  | Venmo / card / PO | $202.50 | $270 | | Card | $5,025 | $6,700 |
  A payment counts by how it came: credit = amount × fee ÷ that way's total (SQL `CREDIT()` in [[route]].js).
  Pay page + dashboard: Zelle first; each way shows its base; tapping one opens its steps, the big price jumps
  to the total and a "LOCKqz $180 / Tax & fees (25%) + $60 / Total $240" (pages advertise the total) box shows.
- **Venmo on for students** (STUDENT_VENMO="1"). Note: personal Venmo's terms forbid business use; a Venmo
  business profile is the safe version.
- **Bank transfer is automatic now:** "Email me the bank details" (pay page + dashboard) → POST /api/pay/bank →
  LOCKqz emails the payer the bank details, amount with tax, and memo (once per 10 min per address). The Gmail
  script also answers any email mentioning "lockqz" + bank transfer/ACH/wire by calling /pay/bank for the
  sender. Bank deposits with a LQ memo are now matched automatically (via "bank"), no admin review.
  **Needs Pages secret BANK_DETAILS** (bank, account holder, routing, account number); until then the payer is
  told details follow and the admin (ADMIN_EMAIL) is emailed to send them. The new Gmail script must be pasted
  into script.google.com (replace the old code) for the email answers + bank auto-match.
- **Professor tour:** first visit to the dashboard home → spotlight + speech bubbles + arrows over status,
  switch, Sync now, class, tiles, install reminder, Watch live, menu (connect page gets a setup version).
  Once per professor per browser (localStorage); "Take the tour" in the name menu re-runs it.
- **CA sales tax:** SB 122 makes SaaS taxable in California from 1 Jan 2027. Anthony needs a (free) CDTFA
  seller's permit and a real "Sales tax" line for Spring 2027 payments — NOT done yet.
- Tests: test_tax.mjs (31). Known pre-existing local fail: test_daemon_reporting "no signed developer lock".

## What LOCKqz is
Blocks ALL AI on a student's Mac/PC only while a Brightspace (USC) quiz runs, then restores it. One-click
install from https://lockqz.pages.dev. Professors: https://prof.lockqz.pages.dev (invite-only).
Admin = athall@usc.edu (Anthony). Owner contact on pages: lockqz.app@gmail.com.

## Where things are
- Repo: github.com/anthonythomashall3-rgb/kx-91f3 (branch master). Mac copy: ~/Projects/LOCKqz.
- Every push to master runs `.github/workflows/release.yml`: all tests, builds the Mac/Windows installers
  only when their files change, then deploys to Cloudflare Pages (`app/cloudflare/deploy.sh`, applies new
  `migrate_*.sql`). Check the live build: `curl https://lockqz.pages.dev/api/version` -> `api` = commit,
  `stripe` = true/false.
- API: `app/cloudflare/functions/api/[[route]].js`. Student pay page: `public/pay.html`. Professor
  dashboard: `public/dashboard.html`. Sync bookmark script: `public/sync.js`. Shared look + loaders:
  `public/lq.js`. Gmail payment script: `app/payments/LOCKqz-payments.gs`.
- Cloudflare: account anthonyclaudehall@gmail.com, Pages project `lockqz`, D1 `lockqz`. CI holds
  CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / LOCKQZ_UPDATE_KEY as GitHub secrets.

## Payments — current state (live, commit 0b668ca)
Prices: students $180/semester, professors $5,000/semester.

| Way | Student | Professor | Who it is matched to | Can the payer pull it back? |
|---|---|---|---|---|
| Zelle | $180 + memo (copy/paste steps) | $5,000 + memo | the memo | No (Zelle is final) |
| Bank transfer (ACH/wire the payer sends) | $180 + memo (invoice by email) | $5,000 + memo | admin one-click Assign | No (pushed money is final) |
| Purchase order (PO) | email link | email link | admin | — |
| Card (Stripe) | $200 (nets $193.90) | $5,150 (nets $5,000.05) | automatic (code in Stripe metadata) | Only by a bank chargeback (law; cannot be blocked) |
| Bank account (Stripe ACH) | OFF (`STRIPE_BANK="0"`) | OFF | automatic | Yes, up to 60 days, so it stays off |
| Venmo | off for students (`STUDENT_VENMO`) | on | memo prefilled | — |

- **Zelle = $180 + memo (Anthony's choice, 26 Oct):** clicking Zelle on the pay page opens 6 steps:
  Copy memo (one tap, copies the student's LQS code) → open bank app → Zelle → Send → To (with Copy) →
  Amount $180 → paste the memo into the Memo/Note box → Send; warning "No memo = LOCKqz can't tell the
  payment is yours." A Zelle with no memo lands in Admin → Payments for one-click Assign (payer name shown).
  The unique-amount scheme ($180.01–$189.99, no memo) is built but OFF (`ZELLE_UNIQUE="1"` turns it on).
  Stripe card payments carry the code by themselves.
- **Who paid / who didn't:** Admin → Payments lists every payment with the student/professor it went to
  (no-memo payments wait there for Assign). Unpaid students get no quiz password; the app opens
  the pay page.
- **Stripe = automatic access:** card → webhook in seconds → access (the app re-checks every 15 s).
  Professors' accounts turn on by themselves at $5,000.
- **No cancelling:** there is no cancel/refund control anywhere in LOCKqz (only the admin can void).
  No final-sale text is shown on any page (Anthony's call, 26 Oct). If money is
  pulled back anyway (card chargeback, refund, failed/returned payment), the Stripe webhook voids the
  payment: students lose access at once, a professor's payment-given activation is turned off.
  Same when the admin voids a Zelle/bank payment by hand.
- Partial payments add up; Stripe charges only what is still owed (plus its fee).

### Stripe — the one thing left to turn on (Anthony gives the key; Claude does the rest)
Code is deployed and inert until the key exists. Anthony makes the Stripe account himself (identity, bank
for payouts). Then he pastes the **secret key** (sk_live_...; or a restricted rk_live_... key with write
access to Checkout Sessions, Webhook Endpoints, Payment Method Configurations) to the next Claude, who:
1. Adds it as GitHub Actions secret `STRIPE_SECRET_KEY` on anthonythomashall3-rgb/kx-91f3:
   - on the Mac with gh signed in: `gh secret set STRIPE_SECRET_KEY -R anthonythomashall3-rgb/kx-91f3`
     (paste the key at the prompt), or
   - in Anthony's Chrome: github.com/anthonythomashall3-rgb/kx-91f3 → Settings → Secrets and variables →
     Actions → New repository secret.
2. Runs the deploy: `gh workflow run release.yml -R anthonythomashall3-rgb/kx-91f3` (or Actions → Release
   → Run workflow, or any push). The deploy's "Stripe" step (`app/payments/stripe-setup.sh`) checks the
   key, stores it in Cloudflare, creates the webhook https://lockqz.pages.dev/api/pay/stripe/webhook,
   stores its signing secret, sets card on / ACH off. Idempotent; never prints secrets.
3. Verifies: `curl https://lockqz.pages.dev/api/version` shows `"stripe":true`; the pay page shows
   "Card $200"; one real $200 card payment unlocks a test student within seconds (refund it in Stripe
   afterwards — the refund voids the access, which is expected).
4. Never commit the key. After it is stored, tell Anthony he can delete the chat message.
- New key later: update the GitHub secret, run the workflow again. New webhook: set GitHub variable
  STRIPE_RESET_WEBHOOK=1 for one run.
- Prices: STUDENT_CARD_PRICE / PROF_CARD_PRICE in `app/cloudflare/wrangler.toml` (Stripe 2.9% + 30¢;
  international cards +1.5%).

### Other payment to-dos (Anthony)
1. Bank of America: Zelle "money received" email alert on, sent to anthonythomashall3@gmail.com (the
   Gmail script "LOCKqz payments" there runs every minute). No BofA alert has ever arrived yet.
2. One $180 test Zelle with the memo pasted in the note → should show paid within a minute.
3. Business checking (free) with Zelle for business → set `ZELLE_BUSINESS_TO` in wrangler.toml.
4. The Mac/Windows unpaid dialog shows "Memo: LQS…" and opens the pay page (matches the memo flow).

## Brightspace Sync — state and answers
- Brightspace has no LTI for LOCKqz yet, so the professor's own Brightspace tab does the syncing: the
  **LOCKqz Sync** bookmark runs `sync.js` inside Brightspace. While that tab is open it re-syncs by itself
  every 15 minutes (new quizzes, added students; 0 LOCKqz requests when nothing changed), gates every
  protected quiz from 1 h before start (`REQUIRE_GATE=1`), and the dashboard's **Sync now** asks it to sync.
- Fixed today: when Brightspace doesn't answer, Sync now shows the 3 steps right there — press
  ⌘ Shift B / Ctrl Shift B to show the bookmarks bar, drag the red **LOCKqz Sync** button (shown inline)
  onto it, click it in the Brightspace tab and leave that tab open. The Brightspace-connection page shows
  the same steps.
- If no Sync tab is open: a student opening a quiz LOCKqz hasn't seen emails the professor; an ungated
  protected quiz gets no password until it ends and the professor is emailed hourly to open Sync.
- **Fully automatic sync with no tab open** (server watches Brightspace for new quizzes) needs USC's
  Brightspace API (Valence) credentials for LOCKqz. The request email is drafted (Gmail draft
  r2050661244054872974 in athall@usc.edu → choueiti@usc.edu, cc dbristow@usc.edu; attach the 4 files in
  ~/Projects/LOCKqz/06_usc_forms). Until USC grants it, the open-tab Sync is the ceiling.

## Rules Anthony set (keep)
- Chat replies: as few words as possible. Pages: no explanatory sentences unless asked. No fun facts on
  loaders (removed 26 Oct).
- $0 forever (free plans). Maximize profit; as many ways to pay as possible; payments final.
- Finish tasks fully; search the repo/Project/online before saying something can't be done.
- Trust model: admin = athall@usc.edu only; a professor is verified only as INSTRUCTOR on a trusted
  roster; TAs never. Never weaken device auth (REQUIRE_SIGNED=1).
- Security: no Duo/MFA auto-approval, no storing USC credentials, no fabricated compliance answers, no
  look-alike login pages.

## Tests
`bash app/tests/run_all.sh` (all green at 0b668ca). Payment suites: `test_pay.mjs`, `test_stripe.mjs`
(card/ACH, webhook signature, refunds/disputes/failed = void, professors deactivated, unique Zelle
amounts behind ZELLE_UNIQUE, Zelle memo steps, ACH default off), `test_stripe_setup.sh`, `test_pay_script.mjs`.
