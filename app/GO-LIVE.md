# LOCKqz — go-live checklist

The whole app is built and the Mac helper's control plane is verified. Everything left to
reach a live pilot needs YOUR accounts/hardware — it isn't code. Do these in order.

## Built 21-22 Oct 2026 (code complete, 132 automated tests passing across 9 suites)
- Live quiz monitor: the helper AND the extension ping every ~45s while a quiz is open, so
  the teacher dashboard shows each student live — 🟢 locked / 🔴 tamper or helper-killed or
  went-dark / 🟠 browser-closed / ⚪ done. Killing the helper mid-quiz now lights up a flag.
  (New API /live endpoint; UPDATE-only writes, safe at finals scale.)
- Student names now show on the roster + live monitor: the extension asks Brightspace's own
  whoami API same-origin, so the teacher sees who is locked instead of "—".
- One-command installers: mac/install.sh + uninstall.sh (and make-pkg.sh for a signed .pkg
  later); windows/install.ps1 + uninstall.ps1 (and installer.iss for a signed .exe later).
  The Windows helper is fully built here on the Mac; only the live lock test needs a PC.
- Download page is now a complete 2-step setup (app + extension) with a privacy link, not
  a helper-only half-install.
- Submission assets: cloudflare/public/privacy.html (required for the Web Store + USC review)
  and store-listing.md (listing text + exact permission justifications).
- Fixed a deploy-blocker: schema.sql was missing the courses table and the qi column.
- Added an end-to-end test that runs the real daemon against a mock backend over HTTP and
  proves lock / helper-heartbeat / unlock actually report (suite 9).
- Built the actual installable artifacts (no account needed): cloudflare/public/download/
  lockqz-mac-unsigned.pkg (works today via right-click→Open; sign later to drop the warning)
  and lockqz-extension.zip (the exact Chrome Web Store upload / sideload package).
- Browser block now covers the FULL 96-domain list (was 27): the extension blocks all AI
  in-browser even if the helper is killed. bing.com / huggingface.co correctly NOT over-blocked.
  A new test keeps the DNR and the master blocklist in sync.
- Security & student-privacy review packet written (USC-REVIEW.md) — hand to USC IT alongside
  the LTI request; the pilot path it describes needs no privileged Brightspace access.

## 1. Deploy the backend (Cloudflare account — free)
```
cd cloudflare
npm i -g wrangler && wrangler login
wrangler d1 create lockqz                 # paste the id into wrangler.toml
wrangler d1 execute lockqz --file=schema.sql --remote
wrangler pages secret put TEACHER_KEY     # choose a teacher password
wrangler pages deploy public              # note the <project>.pages.dev URL
```
Then set that URL as `api_base` in `mac/config.json` (and the installer config).

## 2. (gone) — there is no extension. The app installs the per-user agent itself.

## 3. Make a test quiz (needs a Brightspace course you can edit)
Dashboard (`<project>.pages.dev/dashboard.html`) → enter teacher key → Create a quiz →
it gives a password + a `[LOCKqz]` tag → on a Brightspace test quiz, set that password and
put the tag in the title. Enrol yourself as a student to test.

## 4. Install the helper on your Mac (background service — your explicit OK)
One command now does it all (copies files, writes config, installs + loads the LaunchDaemon):
```
cd mac && sudo bash install.sh        # reads token/api from config.json, or pass --token/--api
```
Then open the test quiz → the agent asks your name once → it locks, shows + copies the
password, blocks all AI (hosts + pf + browser policy) → submit → unlock. Check
`chrome://policy` while locked: URLBlocklist / GeminiSettings should show as LOCKqz's.
If macOS asks "python3 wants to control Google Chrome" → Allow (one time). Dashboard shows the lock, the
live status, and any tamper flag. Remove any time: `sudo bash uninstall.sh`.

## 5. Sign the installers (paid accounts — removes security warnings)
Installers already built — these just sign them so they open without warnings.
- macOS: Apple Developer Program ($99/yr). `bash mac/make-pkg.sh --token <t> --api <url>`
  builds the `.pkg`; then `productsign` + `notarytool` + `stapler` (commands in make-pkg.sh
  header). Put the signed file at `cloudflare/public/download/lockqz-mac.pkg`.
- Windows: Azure Artifact Signing ($9.99/mo). Compile `windows/installer.iss` with Inno Setup
  (one command in its header), sign the `.exe`, put at `cloudflare/public/download/lockqz-win.exe`.
- Chrome Web Store: NOT needed (no extension). $0.

## 6. Windows test (needs a Windows PC/VM)
`powershell -ExecutionPolicy Bypass -File windows\lockqz.ps1 lock` to confirm blocking, then
`windows\install.ps1` elevated for the full service install (details in `windows/README.md`).

## 7. USC sign-off
IT + student-privacy review before any real class.

---
Status 22 Oct 2026: code complete incl. live monitor + student names + installers + built
artifacts (.pkg + extension.zip) + full 96-domain browser block + privacy/listing + USC review
packet; 132 tests across 9 suites pass; Mac daemon reporting verified over real HTTP. Not yet:
Cloudflare deploy, real lock test, signing, Windows run, end-to-end quiz test — all above, all
yours.

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
