# LOCKqz — Windows helper

Same design as macOS: a blocking engine + a SYSTEM daemon + a per-user agent (no extension).

## Files
- `blocklist.txt` — AI + DoH domains.
- `lockqz.ps1` — engine. `lock` / `unlock` / `status`. Blackholes domains in the hosts
  file, firewall-blocks DoT/DoH, kills AI apps, turns off Chrome/Edge/Windows Copilot AI.
- `lockqzd.ps1` — daemon: loopback control server on 127.0.0.1:8787 + tamper watcher.

## Test the engine by hand (elevated PowerShell)
```
powershell -ExecutionPolicy Bypass -File .\lockqz.ps1 lock
# try chatgpt.com and open the ChatGPT app — both dead
powershell -ExecutionPolicy Bypass -File .\lockqz.ps1 unlock
```

## Run as a background service — NEEDS ADMIN
`install.ps1` (elevated) registers two scheduled tasks: `LOCKqz` (SYSTEM daemon at boot) and
`LOCKqz Agent` (per-user quiz detector at logon). No extension, no domain join, no Web Store.

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

## 24 Oct 2026 - reliability fixes (Windows)
- **Policies are never destroyed.** `browser-policy.ps1` saves every value it will change to
  `%ProgramData%\LOCKqz\policy-backup.json` before the first change, merges list policies
  (URLBlocklist, ...) with what is already there, and at unlock puts every value back exactly,
  removing only what LOCKqz added. An unlock with no backup (every helper start) changes nothing.
  Windows Copilot / Recall / Click to Do values go through the same backup.
- **Firefox:** extensions are never touched (`installation_mode: blocked` uninstalls them).
  AI is turned off with the documented `GenerativeAI`, `AIControls\SidebarChatbot` and
  `Preferences` (one REG_MULTI_SZ JSON value) policies. Firefox reads policies only at start, so
  the agent closes Firefox-family browsers at lock unless the quiz is open in one (tabs come back
  on restart). Opera has no policy layer (Aria, built-in VPN): it is closed during the quiz unless
  the quiz is in it.
- **AI never stays blocked:** the agent retries an unlock the helper did not confirm, and takes
  over (then releases after the 30 s grace) any lock the helper resumed with no quiz open; the
  helper finishes any unlock that did not complete (hosts file busy, policy write failed).
- **Every unlock is reported** with `detail.reason`: `quiz_submitted`, `quiz_left`,
  `quiz_tab_closed` (agent), `cap` (3-hour auto-unlock), `local_request` (any other caller).
- No CORS on 127.0.0.1:8787; `max_minutes` is capped at 180; heartbeat every 120 s of wall time.
- SIDs instead of English account names (works on non-English Windows).
- Off-Windows logic tests: `pwsh tests/test_windows_logic.ps1`.
