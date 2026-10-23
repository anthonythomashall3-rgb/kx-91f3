# LOCKqz — build plan and timeline

16 Oct 2026. Status: proposal (no build decisions taken yet).

## Goal
While a designated Brightspace quiz is open, block every AI tool on the student's computer; notes, files and ordinary websites stay open. One-time install from a pages.dev link. The teacher can see who has it and whether it was on during each quiz.

## Design: three parts

1. Browser extension (Chrome and Edge)
   - Recognises a LOCKqz quiz in Brightspace. Before the attempt starts it tells the helper app to lock, waits for confirmation, then enters the quiz password.
   - Unlocks on submission, when the quiz time runs out, or at a hard maximum, so no student is ever left locked.
   - Blocks AI inside the browser at once: AI sites, AI answers in search results (Google AI Overviews, Bing Copilot), AI extensions.

2. Helper app (Mac and Windows; small background service, target under 10 MB)
   - Blocks AI for the whole computer during the quiz: AI web addresses for every browser and app; closes AI apps (ChatGPT, Claude, Copilot, Perplexity, Gemini, hidden-overlay "assistants", local models such as Ollama and LM Studio); switches off built-in browser AI and encrypted-DNS bypass through browser policies (Chrome GeminiSettings / GenAiDefaultSettings and DnsOverHttpsMode; Edge Copilot); switches off Windows Copilot.
   - Reports tampering: helper stopped, block removed, extension disabled, VPN switched on — the teacher sees a flag.
   - Updates itself and the AI list automatically.
   - Later option (v2): Apple Network Extension / Windows filtering driver instead of address blocking, for harder-to-bypass filtering.

3. Cloudflare (pages.dev site + Worker + D1 database)
   - Download page: one button that serves the Mac or Windows installer.
   - API: installs (student identity read from the Brightspace session — to verify in testing), heartbeats, quiz sessions, tamper events.
   - The AI blocklist lives here and updates without reinstalling.
   - Teacher dashboard: roster (installed, version, last seen); per quiz, who was locked, when, and any flags; quiz setup (paste the quiz link, receive the password to enter in Brightspace).

## Enforcement
Brightspace quizzes accept a password restriction. The teacher sets the password LOCKqz issues; only the LOCKqz extension types it, and only after the lock is confirmed. A student without LOCKqz cannot open the quiz. USC's Respondus setup relies on the same mechanism. Brightspace's own attempt logs give the teacher a second check against the dashboard.

## Why a helper app and not only an extension
Proctorio's extension-only version was bypassed by AI cheating tools; Proctorio moved to a desktop companion application. Honorlock likewise added a desktop app to block applications its browser layer cannot.

## Install, realistically
- Mac: Download → open the installer → admin password → approve one profile in System Settings (lets LOCKqz set Chrome/Edge policies and install the extension) → done.
- Windows: Download → open the installer → Yes on the admin prompt → done (Chrome extension force-installed from the Chrome Web Store; Edge from Edge Add-ons — forced installs from outside the stores need a domain-joined PC).
- About one minute, once. Code signing is required for this to be warning-free: macOS Sequoia removed the right-click bypass for unsigned apps; Windows SmartScreen warns on unsigned installers.

## Limits software cannot remove
- Phones and other devices.
- Students administer their own computers, so the tool cannot be made unkillable; it makes tampering visible instead.
- Apple Intelligence Writing Tools can only be force-disabled on school-managed (supervised) Macs; on personal Macs the helper detects it and flags it.
- New AI tools appear constantly; the blocklist needs regular upkeep.
- A home-built local model under a renamed program can evade name-based blocking.

## Existing tools
- Respondus LockDown Browser (in USC Brightspace): blocks other websites, files and apps — no open notes.
- Honorlock application: blocks all apps by default; administrators can allow chosen apps; paid proctoring service.
- Proctorio: desktop companion app with advanced program detection; paid proctoring service.
LOCKqz's niche: free, open-note, blocks AI only.

## Timeline (part-time, Anthony + Claude)
| Phase | Work | Time |
|---|---|---|
| 0 | Accounts; test Brightspace quiz | a few days (mostly waiting) |
| 1 | Extension + Cloudflare backend; demo on Anthony's Mac | ~1 week |
| 2 | Mac helper, signed and notarized installer, profile | ~1 week |
| 3 | Windows helper, signed installer | ~1–1.5 weeks |
| 4 | Teacher dashboard, password gate, break-it testing | ~1 week |
| 5 | Pilot with one class, fixes, store reviews | ~1 week |
| Total | | ~5 weeks (4–6) to pilot-ready; blocklist upkeep ongoing |

## Costs
Apple Developer Program $99/year; Chrome Web Store $5 once; Azure Artifact Signing $9.99/month; Edge Add-ons free; Cloudflare free tier.

## Needed from Anthony
1. A test Brightspace course with a test quiz (an instructor creates it; Anthony enrolled as a student).
2. Apple Developer, Chrome Web Store and Azure accounts (identity checks are his to complete).
3. A Windows PC or virtual machine for testing.
4. USC sign-off (IT and student-privacy review) before real classes.

## Sources
- USC Brightspace help, Respondus (instructors): https://brightspacehelp.usc.edu/?p=6269
- USC Brightspace help, Respondus (students): https://www.brightspacehelp.usc.edu/?p=11072
- SUNY Geneseo, Respondus blocks sites/files/apps: https://geneseo.atlassian.net/wiki/spaces/HELP/pages/76776491/Setting+up+the+Respondus+LockDown+Browser+for+a+Quiz
- Cornell CTI, LockDown Browser and other devices: https://teaching.cornell.edu/node/2253
- Purdue, Brightspace quiz password and IP restrictions: https://www.purdue.edu/brightspace/Docs/Quizzes/QuizRestrictionsIntegrity.php
- Arizona, Brightspace quiz attempt logs: https://d2lhelp.ucatt.arizona.edu/content/instructor-quiz-statistics-and-logs
- Temple, Proctorio extension bypassed; companion app: https://cphwiki.temple.edu/books/proctorio-internal/page/proctoring-exams-with-proctorio-draft/revisions/5793
- Honorlock application: https://honorlock.com/honorlock-application/
- Ohio State, Honorlock app scope and limits: https://it.osu.edu/news/2025/12/12/expanded-exam-monitoring-honorlock-app-now-option-instructors
- Azure Artifact Signing pricing (DevClass, Jan 2026): https://devclass.com/2026/01/14/code-signing-windows-apps-may-be-easier-and-more-secure-with-new-azure-artifact-service/
- macOS Sequoia Gatekeeper change (Macworld): https://www.macworld.com/article/2457844/what-to-do-when-you-cant-open-an-app-you-just-installed-in-macos-sequoia.html
- Apple restrictions table (Writing Tools = supervised only): https://support.apple.com/en-om/guide/deployment/dep739685973/web
- Chrome GenAiDefaultSettings kill switch: https://www.infortech.com/2026/03/24/google-thinks-its-okay-to-leave-your-barn-door-open-with-gemini-as-long-as-theyre-the-only-one-who-can-get-in/
- Chrome GeminiSettings policy: https://tecnobits.com/en/How-to-turn-off-Gemini/
- Chrome force-install rules (Windows): https://support.google.com/chrome/a/answer/7532015?hl=en
- Edge force-install rules: https://learn.microsoft.com/th-th/deployedge/microsoft-edge-browser-policies/extensioninstallforcelist
- Chrome policies on Mac via installed profile: https://gist.github.com/jamesmacwhite/c30a310e33e68842a6ab132aafd68be7
