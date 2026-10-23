# LOCKqz

Blocks all AI on a student's computer while a designated Brightspace quiz is open, then
restores it when the quiz ends. Open-note: files, notes and ordinary websites stay available.

Built 16 Oct 2026. v1 = strong-pragmatic, Mac-first (Windows ported). Not yet signed; not yet deployed.

## How the pieces fit
```
Student computer                                   Cloudflare
┌─────────────────────────────┐                   ┌──────────────────────┐
│  Per-user agent (no ext.)    │  lock/unlock      │  Pages: download page │
│  - detects [LOCKqz] quiz     │◄───127.0.0.1────► │  Pages: teacher dash  │
│  - enters quiz password      │   (helper)        │  API (Pages Function) │
│  - strips in-browser AI      │                   │  D1 database          │
│         │ reports            │                   │  - blocklist          │
│         ▼                    │   heartbeat/      │  - installs / events  │
│  Helper service (root)       │───tamper/lock────►│  - quiz passwords     │
│  - hosts blackhole (all AI)  │                   └──────────────────────┘
│  - pf firewall backup        │
│  - kills AI apps             │
│  - browser/OS AI off (policy)│
└─────────────────────────────┘
```

## The enforcement loop
1. Teacher creates the quiz in the dashboard → gets a password + a `[LOCKqz]` title tag →
   sets that password on the Brightspace quiz and puts the tag in its title.
2. Student (LOCKqz installed) opens the quiz. The agent sees the quiz URL, tells the helper
   to lock, and the helper blacks out all AI on the whole computer.
3. Only once the helper confirms the lock does the API hand the agent the password,
   which it types in — so a computer that isn't locked can't open the quiz.
4. On submit / time-out / hard-max, the helper unlocks. AI returns.
Tampering (block removed, helper killed) is re-applied by the watcher and flagged to the teacher.

## Folders
- `mac/` — helper (engine, daemon, firewall, browser-AI profile). See mac/README.md.
- `windows/` — helper ported to PowerShell. See windows/README.md.
- `legacy/extension/` — the retired Chrome extension (not used; no Web Store needed).
- `cloudflare/` — Pages site + API + D1 schema. See cloudflare/README.md.

## The LaunchDaemon (macOS auto-start) — needs Anthony's explicit OK
The helper runs as a root background service so it can re-apply the block during a quiz.
That auto-start file was intentionally NOT written to disk yet. To install it, create
`/Library/LaunchDaemons/com.lockqz.helper.plist` with:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.lockqz.helper</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/python3</string><string>/Library/Application Support/LOCKqz/lockqzd.py</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Library/Application Support/LOCKqz/lockqz.log</string>
  <key>StandardErrorPath</key><string>/Library/Application Support/LOCKqz/lockqz.log</string>
</dict></plist>
```
then `sudo launchctl load -w /Library/LaunchDaemons/com.lockqz.helper.plist`.

## Test the whole thing (local, no deploy needed for steps 1–3)
1. Engine: `cd mac && sudo ./lockqz.sh lock` → chatgpt.com + ChatGPT app die → `sudo ./lockqz.sh unlock`.
2. Daemon: copy files per mac/README.md, start it, then `curl -H "X-LOCKqz-Token: <token>" 127.0.0.1:8787/status`.
3. Open a Brightspace quiz — the agent (installed with the app) locks automatically.
4. Full loop (after Cloudflare deploy + a test [LOCKqz] Brightspace quiz): open the quiz → it should lock,
   auto-fill the password, block AI; submit → it unlocks. Dashboard shows the lock + any tamper flags.

## Known v1 limits
- Student is admin → killable; we flag tampering, not prevent it. Phones are out.
- Browser-AI-off uses a config profile (one approval on Mac) / registry policy (Windows).
- Quiz detection is by URL (`/d2l/lms/quizzing/user/…qi=`); the password is shown + copied, not auto-filled.
- Next hardening (v2): Mac System/Network Extension + Windows filter driver = much harder to bypass.

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
