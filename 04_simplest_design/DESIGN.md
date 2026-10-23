# LOCKqz — the simplest possible process (design)

16 Oct 2026. Goal: zero misunderstanding, zero technical difficulty, for both teachers and students.

## The end-state (the goal)
- Student: install once. Every quiz after that → AI auto-blocks → quiz opens. Nothing to do per quiz, ever.
- Teacher: sign in to the LOCKqz site with Brightspace (one click, SSO) → pick a class → see the roster:
  green dot = app installed, red dot = not. Quizzes are auto-protected; the teacher sets nothing per quiz.
  Red-dot students can't open the quiz.

## The ONE dependency for that end-state
USC's Brightspace admin registers LOCKqz once as an LTI 1.3 Advantage tool and grants Valence API access.
Verified this unlocks exactly the three things above:
- Brightspace SSO for teachers (launch LOCKqz from inside Brightspace, identity passed).
- Roster + enrollments via Names & Roles Provisioning Service (NRPS). It passes each student's Brightspace
  user id, so we match it to our "installed" records → the green/red dots.
- Auto-set the quiz password on the course's quizzes via the Valence API (it can update a quiz's config
  properties, and password is one) → the teacher never touches a password.
We build the whole LTI tool; USC just flips it on. This is an institutional yes, not a coding problem.

## Why a password must exist (it can't be fully removed)
Brightspace gives a teacher exactly one tool-controllable gate on a quiz: a password (or an IP restriction).
There is no "require this app" switch in Brightspace. So the gate is a password only LOCKqz knows and types
after it locks. Respondus and Proctorio rely on the same mechanism. We make the password INVISIBLE to the
teacher by auto-setting it (above) — that is the real "teacher does nothing," not deleting the password.

## How each of Anthony's ideas is handled
- "AI blocks with OR without the student typing the password": the extension locks on quiz-open regardless
  of who enters the password, so both ways work. But keep the password secret — sharing it lets a
  NON-installer in with AI un-blocked (installed students still get locked either way).
- "Can't access without the app": the password is released by our server only to a device that is locked;
  strongest once our system (not the teacher) sets the quiz password.
- "Roster + green/red dots + Brightspace sign-in": LTI NRPS (needs the USC registration).
- "All devices":
  - Mac + Windows: native helper, full system block (built).
  - Chromebook + Linux: extension-only — which is ENOUGH on ChromeOS, since you can't install desktop AI
    apps there; AI is browser-only, and the extension blocks it. Managed Chromebooks: admin force-installs it.
  - Phones / tablets (iOS, Android): no software — ours or anyone's — can system-block AI without MDM.
    That is an exam-setting problem (in-person / proctoring), not something an app can solve.

## Plan
Phase 1 — now, $0, no USC needed:
  - Student: install once, auto-lock + auto-password (done).
  - Teacher: ONE password per course (reused across that course's quizzes) + paste the course/quiz link once.
  - Extension auto-locks (blocks AI) on any Brightspace quiz-attempt page, so the AI blocking needs zero
    teacher setup; the password stays the optional enforcement gate for "can't skip the app."
Phase 2 — needs USC's yes:
  - Build the LOCKqz LTI 1.3 tool → SSO + roster dots + auto-password. This is the simplest possible
    teacher experience; after USC registers it once, the teacher's per-quiz effort is zero.

## Decision
Can Anthony get USC IT to register an LTI tool + grant API access? Yes → build Phase 2. Either way, ship the
Phase 1 simplification now.
