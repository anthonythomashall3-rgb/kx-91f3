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

## 24 Oct 2026 — runs itself: signed self-update, CI deploy, python repair, one-line install ($0)

What changed (all code, all tested: 14 suites; Windows updater proven under PowerShell 7 and on CI under 5.1):
- **Signed self-update.** Every installed helper (Mac `lockqzd.py`, Windows `lockqzd.ps1`) checks
  `https://lockqz.pages.dev/download/update.json` about 90 s after it starts and every 6 hours. The
  manifest is signed in CI with an RSA key; the helper verifies the signature with the public key
  shipped inside the install (`update.pub` / `update.pub.xml`), checks every file's SHA-256, swaps the
  files in atomically and restarts itself and the agent. It never updates during a quiz, never
  downgrades, never touches `config.json`, `device.key` or the active lock, and anything wrong
  (signature, hash, bad name, network) leaves the install exactly as it was. A daemon started from
  a source checkout never updates the checkout. Students never reinstall again.
- **CI deploys on every push to `main`** (`.github/workflows/release.yml`): all suites on Linux ->
  build + install-test the `.pkg` on a real Mac runner and the `.exe` on a real Windows runner ->
  build the signed manifest (`app/release/make-manifest.py`) -> `deploy.sh` (schema, migrations,
  site, API, teacher site, legacy forwarders) -> live checks. Until the three secrets below exist,
  the deploy step prints what is missing and does nothing.
- **Fresh Macs work.** `/usr/bin/python3` is only a stub until Apple's Command Line Tools exist, so
  a LaunchDaemon would never have started on a brand-new Mac. `mac/ensure-python.sh` installs the
  tools headlessly with `softwareupdate` (no Xcode, no Apple ID, nothing to click), and the daemon
  now starts through `mac/lockqz-boot.sh`, which repairs python on every boot (macOS upgrades
  remove the tools). The installer, the pkg and the daemon all use it.
- **One-line install, no Gatekeeper / SmartScreen prompt, no Apple or Microsoft account:**
  Mac `curl -fsSL https://lockqz.pages.dev/install.sh | sudo bash`, Windows (elevated PowerShell)
  `irm https://lockqz.pages.dev/install.ps1 | iex`. Both fetch the current release, verify the
  manifest signature against the key embedded in the script and every file's hash, then install.
  The download page shows the line under the Download button for the visitor's OS.
- Windows daemon task now restarts itself if it ever stops (`RestartCount 999`); the uninstaller
  and installer ship inside every install; `app/VERSION` is the single release version
  (`make-manifest.py` refuses to build if a daemon's VERSION constant disagrees).

### Your one-time steps (about 10 minutes, all free)
1. Copy the release private key: in Terminal run
   `cat ~/Projects/LOCKqz/.secrets/update_key.pem` and copy everything from `-----BEGIN` to `-----END ... KEY-----`.
   Keep this file; it is gitignored. If it is ever lost, generate a new pair, replace
   `app/mac/update.pub` + `app/windows/update.pub.xml` + the key embedded in `app/mac/install.sh`
   and `app/windows/install.ps1`, and students must reinstall once.
2. Open https://github.com/anthonythomashall3-rgb/LOCKqz/settings/secrets/actions and click
   **New repository secret**. Name: `LOCKQZ_UPDATE_KEY`. Secret: the key from step 1. Click **Add secret**.
3. Open https://dash.cloudflare.com/profile/api-tokens and click **Create Token**, then
   **Create Custom Token** (bottom). Name it `lockqz-ci`. Permissions: **Account** · **Cloudflare Pages** · **Edit**;
   add a second row **Account** · **D1** · **Edit**. Click **Continue to summary**, then **Create Token**, then **Copy**.
4. Back on the GitHub secrets page: **New repository secret**, Name `CLOUDFLARE_API_TOKEN`, Secret = the token. **Add secret**.
5. Open https://dash.cloudflare.com, click **Workers & Pages**; the **Account ID** is in the right-hand column. Copy it.
   GitHub: **New repository secret**, Name `CLOUDFLARE_ACCOUNT_ID`, Secret = that id. **Add secret**.
6. Make sure everything you want live is committed on `main` (CI deploys the committed tree, not your
   working folder — the dashboard redesign in progress on 23 Oct is still uncommitted).
7. Open https://github.com/anthonythomashall3-rgb/LOCKqz/actions/workflows/release.yml and click
   **Run workflow** → **Run workflow**. Green = live. From now on every push to `main` does this by itself.
8. GitHub Actions minutes: a public repository has unlimited free minutes; a private one has 2,000/month
   and the macOS runner counts 10x. If you keep it private, expect roughly 60-80 charged minutes per push.
   Making the repo public costs nothing and removes that limit (the private key is not in the repo).

### What still cannot be automated away (be honest with professors)
- A professor must click the **LOCKqz Sync** bookmark once per term (and after adding a quiz) so LOCKqz
  can read their courses and set quiz passwords. It runs inside their own Brightspace login; nothing
  else is possible without USC registering an LTI tool (see 05_phase2_lti) or storing their USC
  credentials, which LOCKqz will not do.
- A student installs once (download, or the one-line command). After that: nothing, ever.
- Apple Developer Program ($99/yr) is the only way to make the `.pkg` open with no warning on macOS;
  Azure Trusted Signing (~$10/mo) does the same for the `.exe`. The one-line installs avoid both at $0.
  The Microsoft Store and Mac App Store are not needed and could not host a system-level helper anyway.
