# LOCKqz - Microsoft Store listing (copy-paste)

## Pricing and availability
- Price: Free
- Markets: United States (or all)

## Properties
- Category: Education
- Privacy policy URL: https://lockqz.pages.dev/privacy
- Website: https://lockqz.pages.dev
- Support contact: athall@usc.edu

## Age ratings
Answer the questionnaire: no violence, no user-generated content, no purchases. It collects the
student's school email and device id for the professor; answer "yes" to sharing personal info
only if the questionnaire asks about sending data to the app's own service.

## Store listing (English)
Description:
LOCKqz blocks AI apps and AI websites on your computer only while a Brightspace quiz is running, then turns them back on when the quiz ends. Your notes, files and other websites keep working.

Install once and forget it: open LOCKqz, click Yes on the Windows prompt, done. It starts with Windows and needs nothing else.

See it work any time: click "Test it now" and AI stays off for 2 minutes, exactly as during a quiz.

Your professor can see that LOCKqz is installed and running during their quiz.

To remove it: open LOCKqz and click "Remove LOCKqz", then uninstall the app.

Short description: Blocks AI only during Brightspace quizzes.
Screenshot: screenshot-1366x768.png (from the GitHub Actions "lockqz-store" artifact)
Logo (1:1, 300x300): StoreListing300.png

## Submission options -> Restricted capabilities (runFullTrust) - why it is needed
LOCKqz is a desktop app. At first launch it asks the user for administrator approval (a normal Windows UAC prompt) and installs a small helper (Windows PowerShell scripts in C:\ProgramData\LOCKqz plus two scheduled tasks). During a Brightspace quiz the helper blocks AI websites through the hosts file and Windows Firewall, closes AI desktop apps and sets browser policies; after the quiz it removes every block. This needs full trust.

## Notes for certification
LOCKqz turns AI off on a student's PC only while a Brightspace quiz is open, then turns it back on. No account is needed to test it:
1. Open LOCKqz and click Yes on the Windows prompt. The window shows "LOCKqz is on."
2. Click "Test it now". For 2 minutes AI websites (for example chatgpt.com, claude.ai, gemini.google.com) do not open in Edge or Chrome and AI desktop apps close, exactly as during a quiz; other websites and apps keep working. The window counts down, and after 2 minutes AI works again ("Stop test" ends it sooner).
Outside a test or a quiz LOCKqz changes nothing. A sign-in page or window for a school account may appear: it links the PC to the student's school account for real quizzes and can be closed for this test. "Remove LOCKqz" in the window undoes everything. All code ships inside the package; updates come only from new Store packages.
