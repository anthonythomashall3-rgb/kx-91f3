# LOCKqz — Chrome Web Store listing

Paste these fields into the Web Store developer console. The permission justifications are
the part reviewers read most carefully for a blocking extension, so keep them exact.

## Name
LOCKqz

## Summary (132 characters max)
Blocks AI assistants during a designated Brightspace quiz, then restores them when the quiz ends. Open-note, no proctoring.

## Category
Education

## Detailed description
LOCKqz helps instructors run open-note, no-AI quizzes in Brightspace. While a designated
quiz is open, LOCKqz blocks AI assistants — AI websites, AI answers inside search results,
and the browser's built-in AI — so students can use their notes and the open web but not an
AI assistant. When the quiz is submitted, times out, or reaches a hard maximum, everything is
restored automatically, so no student is ever left blocked.

LOCKqz is not a proctoring tool. It does not use your camera, microphone, screen, or
keystrokes, and it does not read your quiz questions or answers. It pairs with a small helper
app that extends the same AI block to the rest of the computer during the quiz; the extension
handles the browser and confirms the lock before a quiz can open.

What it stores: a random device id, install status, and quiz lock/unlock timestamps. Full
privacy policy: https://<project>.pages.dev/privacy.html

## Single purpose (required field)
Block AI assistants in the browser for the duration of a designated Brightspace quiz, and
restore them when the quiz ends.

## Permission justifications

- **declarativeNetRequest / declarativeNetRequestFeedback** — Blocks a defined list of AI
  service domains while a quiz is active. The ruleset is disabled at all other times. Feedback
  is used only to confirm the block is in effect during a quiz.
- **scripting** — Removes AI answer panels (e.g. AI overviews, in-page assistant widgets) from
  the allowed search sites while a quiz is active, since those are served from sites students
  still need for notes and cannot be blocked by domain alone.
- **storage** — Stores a random device id and the id of the currently active quiz, so the
  extension knows when a quiz is running.
- **tabs** — Detects when the active tab is the designated Brightspace quiz page, which is what
  starts and ends the lock.
- **alarms** — Sends a periodic liveness ping while a quiz is open so an instructor's dashboard
  can show that the student's protection is still running. No content is sent.

## Host permission justifications

- **\*://\*/d2l/\*** — Brightspace (D2L) is hosted on each school's own domain, so the match
  must cover any host. Used to detect the quiz page and enter the quiz password after the lock
  is confirmed.
- **\*://www.google.com/\*, \*://www.bing.com/\*** — Removes AI answers from search results on
  these two engines while a quiz is active (students may still use them for notes).
- **http://127.0.0.1:8787/\*** — Talks to the local LOCKqz helper app on the same machine to
  start and end the full-computer AI block. Loopback only; nothing leaves the device.

## Remote code
None. All code is contained in the extension package. No remote scripts are loaded or executed.

## Data usage disclosures (console checkboxes)
- Does the extension collect: a user activity identifier (the random device id) and quiz
  lock/unlock timestamps — YES to "user activity" only, for the integrity feature.
- Does NOT collect: personally identifiable information, health, financial, authentication,
  personal communications, location, web history, or the contents of web pages.
- Not sold to third parties. Not used or transferred for purposes unrelated to the single
  purpose. Not used for creditworthiness or lending.

## Notes for review
LOCKqz is used only on a quiz the instructor designates and the student installs knowingly;
it is open-note and runs no proctoring. Submit early — extensions requesting blocking and
broad host match are reviewed more slowly.
