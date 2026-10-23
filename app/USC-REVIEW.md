# LOCKqz — security & student-privacy review packet

A one-page answer to the questions a university security / privacy review asks before a tool
touches real students. Hand this to USC IT and the student-privacy office alongside the
registration request. It describes the pilot path, which needs no privileged Brightspace
access.

## What LOCKqz is
A classroom-integrity tool for open-note quizzes that forbid AI. While a designated
Brightspace quiz is open, it blocks AI assistants (ChatGPT, Claude, Copilot, Gemini, and
similar) on the student's own computer, then restores them when the quiz is submitted. It is
not a proctoring tool: no camera, microphone, screen capture, keystroke logging, or recording
of any kind.

## What it is NOT
It does not block the student's notes, files, or the rest of the web — only AI. It does not
watch, record, or transmit anything the student does outside the AI block. It has no view into
quiz questions, answers, or grades.

## Data — collected, stored, retained
- Collected: a random device identifier generated at install, install status and app version,
  the student's Brightspace display name (so an instructor can match a device to their roster),
  and timestamps when a quiz locks, unlocks, or is tampered with.
- Not collected: quiz content, answers, grades, keystrokes, clipboard, browsing history, page
  contents, location, camera, microphone, or screen.
- Stored in the project's own Cloudflare instance (Cloudflare D1), not shared with third
  parties, never sold, never used for advertising or profiling.
- Retention: records exist only to run a quiz and show an instructor their own class's status;
  they can be deleted on request and are not needed after a term.
- FERPA posture: the only education-adjacent field is the student's name tied to an
  install/lock event for the instructor of that student's own course — the same visibility an
  instructor already has over their roster. No new academic record is created.

## Consent and control
Students install LOCKqz knowingly (they click to download and add it) and can uninstall it at
any time, which stops all collection immediately. It runs only while a designated quiz is open.

## Security posture
- The local helper listens only on loopback (127.0.0.1) and requires a shared token; it accepts
  no connections from the network.
- The per-user agent (no browser extension) loads no remote code — all logic ships in the package; it blocks a
  fixed AI domain list and talks only to the loopback helper and the project's own backend.
- Installers will be code-signed and notarized (Apple Developer ID; Azure for Windows) before
  any student install, so they pass Gatekeeper / SmartScreen without warnings.
- The backend stores no secret beyond a teacher key and the per-quiz passwords; teacher
  endpoints require that key.

## Tamper model (stated honestly)
LOCKqz does not claim to be unremovable — no tool on a computer whose owner has admin rights
can be. Instead it is tamper-evident and self-defeating to tamper with:
- The quiz password is released only while the student's machine reports locked, so removing
  LOCKqz means the quiz never opens.
- While locked, the helper re-applies the block every few seconds and flags any removal.
- If a student kills the helper mid-quiz, it stops reporting and the instructor's live monitor
  shows that student "went dark" — a visible flag, per student, in real time.
This is the same bar the paid proctoring tools hold, achieved without surveillance.

## What LOCKqz needs from USC
- Pilot path (proposed first): nothing privileged. Students install the tool; an instructor
  creates a normal password-protected quiz and uses the LOCKqz dashboard. No Brightspace
  integration required.
- Later, optional (for convenience, separate review): LTI 1.3 registration for single sign-on
  and an installed/not-installed roster view, and scoped quizzing API access to set the quiz
  password automatically. Details in the LTI registration request.

## Review support
Happy to complete any security questionnaire, provide the source for inspection, and run a
live demo. Privacy policy: <project>.pages.dev/privacy.html

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
