# LOCKqz for Professors — store listing (copy and paste)

Same text for the Chrome Web Store, Microsoft Edge Add-ons and Firefox Add-ons.

## Name
LOCKqz for Professors

## Summary (132 characters max)
Protects your Brightspace exams from AI. Syncs your classes by itself and runs each exam while Chrome is open.

## Description
LOCKqz blocks AI on your students' computers while your Brightspace exams are open. Notes, files and the rest of the web stay open, and AI comes back when they submit.

This extension is the professor side of LOCKqz. Add it once:
1. Open Brightspace in your browser and sign in. Your classes, class lists and exams appear on your LOCKqz dashboard by themselves, and every exam is protected.
2. On exam day, keep your browser open and signed in to Brightspace until the exam ends. LOCKqz runs the exam from there.

You never set or share an exam password. Students install the LOCKqz app once from lockqz.pages.dev; students without it cannot open a protected exam.

LOCKqz works only on USC Brightspace and only with your own Brightspace sign-in. It reads your classes, class lists and quizzes so it can protect them. It never sees quiz content, answers or grades, and never records your screen, camera or keystrokes.

Privacy policy: https://lockqz.pages.dev/privacy

## Category
Education

## Language
English

## Single purpose (Privacy practices tab)
Connects a professor's Brightspace courses to LOCKqz so their exams are protected from AI: it syncs the professor's classes, class lists and quiz schedule to their LOCKqz account and sets each protected exam's password.

## Permission justifications (Privacy practices tab)
- storage: Saves the professor's LOCKqz connection key and the time of the next protected exam on this computer.
- alarms: Checks once a minute whether a protected exam is about to start, so LOCKqz can open its Brightspace tab for that exam.
- notifications: Tells the professor when they need to sign in to Brightspace before an exam.
- Host permission brightspace.usc.edu / usc.brightspace.com: Reads the professor's own courses, class lists and quizzes from Brightspace and sets each protected exam's password, using the professor's own Brightspace sign-in.
- Host permission prof.lockqz.pages.dev / lockqz.pages.dev: Connects to the professor's LOCKqz dashboard and the LOCKqz service.

## Remote code
No, I am not using remote code. (All code is inside the package.)

## Data usage (check these boxes)
- Personally identifiable information (student names and USC emails from the professor's class lists)
- Website content (the professor's Brightspace course and quiz names and dates)

Then tick all three certifications:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

## Privacy policy URL
https://lockqz.pages.dev/privacy

## Visibility
Unlisted (only people with the link can install it; your dashboard and welcome email give professors the link).

## Files in this folder
- screenshot-1280x800.png — the store screenshot
- promo-small-440x280.png — Small promo tile
- promo-marquee-1400x560.png — Marquee promo tile (optional)
- the extension itself: ../dist/lockqz-prof-chromium.zip (Chrome and Edge), ../dist/lockqz-prof-firefox.zip (Firefox)
- icon: ../icon128.png
