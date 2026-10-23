# LOCKqz — extension-only option (Chrome Web Store)

16 Oct 2026. Status: option under consideration; no decision taken.

## What it is
LOCKqz as one Chrome extension from the Chrome Web Store, plus the same Cloudflare site and teacher dashboard. No helper app, no installer, no code signing.

## How it would work
- Install: Add to Chrome from the pages.dev link, then turn on "Allow in Incognito" (the extension walks the student through it).
- Quiz runs in Incognito: the extension enters the Brightspace quiz password only in an Incognito window. Google states Gemini in Chrome is unavailable in Incognito and in Chrome profiles that are not signed in, so Chrome's built-in assistant cannot read the quiz.
- Inside Chrome during the quiz: blocks AI websites; removes AI answers from Google and Bing results; turns off AI extensions; removes the browser's on-device AI interfaces from pages (to test).
- Outside Chrome: cannot block. It records every time focus leaves the quiz's Incognito windows (other apps, other browsers, other Chrome profiles, normal Chrome windows), with time and duration; the teacher sees these flags.
- Notes: kept inside the Incognito quiz window (PDFs, Google Docs, web notes) to avoid flags. Native apps (Word, Preview, Notes) are not blocked, but switching to them is logged.
- Same password gate, roster and per-quiz report as the full plan.

## Cannot do (compared with the helper app)
- Block desktop AI apps or other browsers (it only flags switching to them).
- See or stop invisible overlay assistants that never take focus and hide from screen capture.
- Switch off Windows Copilot or Apple Intelligence.
- Phones (neither version can).

## Gains
- One-click install with no system-level approval; works on Mac, Windows and Chromebooks.
- Cost $5 once (Chrome Web Store) instead of about $219 a year plus $5.
- About 2–3 weeks to a pilot instead of about 5.

## Timeline
| Phase | Work | Time |
|---|---|---|
| 0 | Chrome Web Store account; test quiz | a few days |
| 1 | Extension + Cloudflare dashboard + password gate | ~1–1.5 weeks |
| 2 | Break-it tests; pilot with one class | ~1 week |
| — | Chrome Web Store review, in parallel; longer when powerful permissions are requested, so submit in week 1 | days to weeks |

## Recommendation
Build the extension-only version first. It is phase 1 of the full plan, so nothing is wasted. Pilot it, then add the helper app (about 3 more weeks) if the flags or overlay tools show it is needed.

## To test on day 1
- Gemini panel absent in Incognito for a signed-in profile.
- Focus-loss events on Mac and Windows for: another app, another browser, another Chrome profile, a normal Chrome window.
- Whether the extension can remove the browser's on-device AI interfaces from pages.

## Sources
- Google Help, Gemini in Chrome requirements (not in Incognito or signed-out profiles): https://support.google.com/chrome/answer/16283624
- Workspace Updates, Gemini in Chrome for personal accounts on ChromeOS, macOS and Windows (Mar 2026): https://workspaceupdates.googleblog.com/2026/03/gemini-in-chrome-expands-to-more-countries-and-languages.html?hl=en
- Android Authority, Gemini in Chrome works across open tabs (Jul 2026): https://androidauthority.com/gemini-chrome-ask-gemini-desktop-expansion-3687239
- Chrome Web Store review process (powerful capabilities take longer): https://developer.chrome.com/docs/webstore/review-process
- Chrome Web Store review updates (Aug 2026): https://developer.chrome.com/blog/cws-review-updates-2026
- Proctorio on overlay tools such as Cluely: https://proctorio.com/blog/how-proctorio-blocks-cluely
- Temple, Proctorio extension-only version bypassed: https://cphwiki.temple.edu/books/proctorio-internal/page/proctoring-exams-with-proctorio-draft/revisions/5793
