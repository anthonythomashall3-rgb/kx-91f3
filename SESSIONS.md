# LOCKqz — sessions working on this repo (read before you start, update when you start/finish)

Several Claude sessions work on LOCKqz at the same time. They can't message each other, so this file
is how they stay in sync. **Every session: `git pull --rebase` first, read this file, claim what you
will touch (one line under "Working now", committed and pushed BEFORE you edit), and remove your line
when you push the finished work.** Do not edit files another session has claimed; if you must, add a
note under "Requests" instead. Stale claims (older than 3 hours with no commit) may be taken over.

## Working now
- 2026-10-31 06:22 PT — 01UUDg7Y: owner's 31 Oct list — VM detection (helpers + /password), D2L Lumi block, Firefox extension signed by Mozilla (AMO), professor fallbacks (let-in switch, backup card, keep-awake), Google sign-in (takes over 01UzHDaF's stale 27 Oct claim), Windows installed-apps uninstall entry + privacy line, Microsoft Store listing + automated Store uploads, HANDOFF.md out of the public repo. Touches: [[route]].js, dashboard.html, index.html, privacy.html, sync.js, app/extension-prof/*, mac/windows/linux helpers + agents, android Api.kt/MainActivity, blocklists + browser policies, .github/workflows/*, migrate_038, CLAUDE.md, HANDOFF.md, app/VERSION, tests.

## Recently finished
- 2026-10-31 06:20 PT — 01UUDg7b: "â€“" in the Brightspace Sync panel: scripts injected into Brightspace (sync.js, lq.js, extension content/popup scripts) are now pure ASCII (\uXXXX escapes); test in test_prof_zero_effort. Extension 1.0.2.
- 2026-10-29 16:05 PT — 01UUDg7b: no tax / fees lines anywhere (pay pages: one "LOCKqz <total>" line; PO mailto, bank-details + renew emails: amount only); shorter memo bubble; no renewal line under Card; welcome page = 3 plain instructions (no buttons/links); every logo is the lock (dashboard header + sign-in + status orb, extension popup + Brightspace notices; extension 1.0.1 to upload); store link no longer typed out under the Add button.
- 2026-10-29 15:50 PT — 01UUDg7b: emails use a white lock (public/icon-white.png, LOGO_URL) so it shows on the red header; Zelle first on both pay pages (Zelle, Venmo, Card, then bank/PO).
- 2026-10-29 14:30 PT — 01UUDg7b: Set up steps count in order: step 2 (Open Brightspace) checks off only after step 1 (extension); its button shows only after step 1 ('After step 1.'); step 3 only after step 2.
- 2026-10-29 14:40 PT — 01UUDg7b: owner's 29 Oct list. (1) invite email sent by LOCKqz with buttons (MAIL.invite, POST /invite/send, admin "Email it to ..."). (2) every email branded: sendVia wraps plain text in mailWrap (autoHtml: buttons for LOCKqz/Brightspace/store/pay links, big code box, signature); codes too (SMTP + SES). (4) no "LOCKqz paid · renews" email. (5) student pay page: Card, Venmo, Zelle order; red memo bubble with logo (Zelle + Venmo only, Zelle Memo box / Venmo note, no access without it); (6) tax line plain; (7) paid page shows the amount paid; (8) card payers: "LOCKqz will continue to be a service for you next semester." (/pay/start card_auto) + "LOCKqz renewed for <term>" email after each renewal charge. (9) phones: logo + "Open on your computer for access." (10) professor payment: Card/Venmo/Zelle order, red memo bubble, no "Processing" lock until they start paying, tax plain ($6,500 / card $6,700 = wrangler PROF_TOTAL/PROF_CARD_TOTAL, tested incl. Venmo $6,500 activates). (11-12) welcome page centered + much shorter. (13) setup cards: big green check per done step, block gone at 3/3. (14) extension popup 1.0.2: one-line next exam (name · date · n/m students ready), short exam-day line - upload dist/lockqz-prof-chromium.zip to the Chrome Web Store.
- 2026-10-29 13:40 PT — 01UUDg7b: dashboard Set up redesigned: 3 cards always shown (number top-left, centred title/one line/button, done = green check), step 3 = ONE Email students button for every class (/email/students ous[] -> one draft, deduped Bcc, mail_sent per class). lq.js: LOCKqz on red/dark backgrounds turns white (was red qz on red buttons); extension dist rebuilt (store package not re-uploaded).
- Older history: claude.ai Project LOCKqz, doc claude/LOCKqz-HANDOFF.md (private).

## Requests (for whichever session picks them up)
- (none)
