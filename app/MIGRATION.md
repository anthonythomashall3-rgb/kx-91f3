# LOCKqz — move to the new Cloudflare account (anthonyclaudehall@gmail.com)

Total separation from the Bristow-Hall account. ~5 minutes. Steps marked (you) need your
login/password — Claude can't create accounts, sign in as you, or hard-delete your data.
Steps marked (Claude) I run once you've logged in.

## 1. (you) Create the new Cloudflare account
Sign up at cloudflare.com with anthonyclaudehall@gmail.com (free).

## 2. (you) Point Wrangler at it
In Terminal:
    cd ~/Projects/LOCKqz/app/cloudflare
    npx wrangler logout
    npx wrangler login         # sign in with anthonyclaudehall@gmail.com, click Allow

## 3. (Claude) Deploy everything fresh
I run deploy.sh: creates the lockqz D1 + Pages project on the NEW account, loads the schema,
deploys the site + API, and sets a new teacher key. Then I rewire mac/config.json and
extension/config.js to the new URL. (New account = brand-new empty database; no data moves,
which is correct — there's nothing real in the old one yet.)

## 4. (you) Delete the old copy from the Bristow-Hall account (optional, for cleanliness)
In the anthonythomashall3 Cloudflare dashboard:
  - Workers & Pages -> lockqz -> Settings -> Delete project
  - Storage & Databases -> D1 -> lockqz -> Delete
Leaving them is harmless (they never touched Bristow-Hall), but this makes it spotless and
frees the lockdownqz.pages.dev name if you want it on the new account.

## 5. (you, before any university-wide finals use) Turn on the $5/mo Workers plan
On the NEW account only: Workers & Pages -> Plans -> Workers Paid ($5/mo). This lifts the
daily free caps so a 3,000-student finals session can never hit a limit mid-exam. Not needed
for a pilot or a single class's finals day (free tier ~20,000 student-exams/day).

## Why this guarantees zero Bristow-Hall interference
Cloudflare bills and rate-limits per ACCOUNT. On a separate account, LOCKqz usage draws on its
own budget entirely — even a worst-case LOCKqz spike cannot touch bhrrealtime's limits.

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
