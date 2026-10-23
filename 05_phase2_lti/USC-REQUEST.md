# Request to USC IT — register LOCKqz in Brightspace (draft)

Send to: USC Learning Environments / Brightspace administration (the team that manages LTI tools and
developer/API access). Adjust names as needed.

---

Subject: Request to register a classroom integrity tool (LOCKqz) in Brightspace

Hello,

I'm Anthony Hall, a student and researcher at USC Marshall. I've built a lightweight classroom-integrity
tool called LOCKqz and would like to register it in our Brightspace instance so it works seamlessly for
instructors and students.

What it does: while a designated Brightspace quiz is open, LOCKqz blocks AI assistants (ChatGPT, Claude,
Copilot, Gemini, and similar) on the student's own computer, then restores them when the quiz is submitted.
It is open-note by design — it does not block the student's notes, files, or the rest of the web, and it is
not a proctoring or recording tool (no camera, microphone, screen capture, or keystroke logging).

To make the experience as simple as possible, I'd like to register LOCKqz as an LTI 1.3 Advantage tool. It
would use:
1. LTI 1.3 launch — so an instructor can open LOCKqz from inside Brightspace with single sign-on (no separate
   account).
2. Names and Roles Provisioning Service (NRPS) — so an instructor can see which of their enrolled students
   have installed the tool (a simple installed / not-installed list for their own class).
3. (Optional, if permitted) Valence API access scoped to quizzing — so LOCKqz can set a quiz's access
   password automatically. Without this, instructors set the password by hand; with it, they do nothing.

Data handling: LOCKqz stores only a Brightspace user identifier, install status, and quiz lock/unlock
timestamps. It stores no quiz content, answers, keystrokes, screen, or recordings. Data resides in our own
Cloudflare instance. Students install the tool knowingly and can uninstall it at any time. I'm happy to
complete any security and student-privacy review USC requires.

To register the tool, Brightspace will generate a Client ID and Deployment ID and expose the OIDC
authentication, keyset (JWKS), and OAuth2 token endpoints; I will provide our redirect URL and public keyset
URL in return. For the optional API access, I'd follow USC's process for a scoped developer application.

Could we set up a short time to register the tool and, if possible, discuss scoped API access? I can provide
any documentation or a demo.

Thank you,
Anthony Hall
USC Marshall (FBE)
