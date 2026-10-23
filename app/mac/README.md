# LOCKqz — macOS helper

The blocking service that runs on the student's Mac.

## Files
- `blocklist.txt` — AI + DoH domains (later pulled/updated from Cloudflare).
- `lockqz.sh` — engine. `lock` / `unlock` / `status` (+ `LOCKQZ_DRYRUN=1` preview).
  Blackholes domains in `/etc/hosts`, loads a pf firewall backup, flushes DNS, closes AI apps.
- `lockqzd.py` — daemon: loopback control server on 127.0.0.1:8787 + tamper watcher + reports.
- `com.lockqz.pf.conf` — firewall rules (block DoT/DoH so encrypted DNS can't bypass hosts).
- `browser-ai-block.mobileconfig` — turns off Chrome Gemini / Edge Copilot / browser DoH.
- `config.example.json` — copy to config.json; set the token (shared with the extension) and api_base.

## Test the engine by hand
```
cd ~/Projects/LOCKqz/app/mac
sudo ./lockqz.sh lock      # try chatgpt.com + the ChatGPT app — both dead
sudo ./lockqz.sh unlock
```

## Run as a background service — NEEDS your approval
These install the daemon to start at boot (a privileged background service) and the
browser-AI profile. Run them deliberately:
```
sudo mkdir -p "/Library/Application Support/LOCKqz"
sudo cp lockqz.sh lockqzd.py blocklist.txt com.lockqz.pf.conf "/Library/Application Support/LOCKqz/"
sudo cp config.example.json "/Library/Application Support/LOCKqz/config.json"   # edit token/api first

# add the pf anchor so the firewall layer is evaluated:
echo 'anchor "com.lockqz"' | sudo tee -a /etc/pf.conf

# browser built-in AI off (opens System Settings → approve the profile once):
open browser-ai-block.mobileconfig

# load the daemon at boot (LaunchDaemon):  [create com.lockqz.helper.plist in /Library/LaunchDaemons]
#   see the plist in the top-level README; this is the one step that needs your explicit OK.
sudo launchctl load -w /Library/LaunchDaemons/com.lockqz.helper.plist
```

## Notes
- Student is admin → the service is killable. The watcher re-applies the block and reports
  tampering; it doesn't claim to be unkillable.
- Signed + notarized installer comes in the packaging step so there are no Gatekeeper warnings.

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

## Developer mode (admin only — added 22 Oct 2026)
The admin (Anthony) can keep AI + Claude available during a quiz on his own Mac. Everyone
else is always locked and has no way to turn LOCKqz off.
- **Gate:** a secret that lives ONLY in `~/Library/Application Support/LOCKqz/developer.key`.
  The code ships with the key's SHA-256 only (`DEV_KEY_HASH`), so a student install has no
  key file and cannot forge one — `developer_mode()` is always False for them.
- **Effect when the key is present:** the per-user agent never locks and the root daemon
  refuses `/lock`; `/status` returns `"developer": true` / state `developer`, so the teacher
  monitor can tell admin-developer apart from tampering.
- **Never distributed:** `make-pkg.sh` / `install.sh` copy a fixed file list; the key is not
  in it and lives outside the app folder, so it is never in the student download.
- Same honest limit as the rest of LOCKqz: a student who is admin can still tamper (kill the
  daemon / edit code), which is detected and reported — developer mode does not weaken that.

Toggle on this Mac (no sudo needed):
```
lockqzdev            # show ON/OFF   (alias added to ~/.zshrc)
lockqzdev off        # lock during quizzes like everyone else
lockqzdev on         # keep AI available during quizzes
```
`off` moves the key to `developer.key.off` (recoverable); `on` moves it back. Without the
alias: `bash "/Library/Application Support/LOCKqz/lockqz.sh" devmode {on|off|status}`.
