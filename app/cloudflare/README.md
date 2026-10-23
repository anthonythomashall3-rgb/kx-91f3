# LOCKqz — Cloudflare backend

Cloudflare Pages site + Pages Function API + D1 database.

## Deploy
```
npm i -g wrangler
wrangler login
wrangler d1 create lockqz                 # paste the id into wrangler.toml
wrangler d1 execute lockqz --file=schema.sql --remote
wrangler pages secret put TEACHER_KEY     # set a teacher password
wrangler pages deploy public              # publishes to <project>.pages.dev
```

## Pages
- `/` — download page (one button, OS-detected).
- `/dashboard.html` — teacher dashboard (enter the teacher key).

## API (`/api/*`)
- `GET  /blocklist` — current AI domain list (the helper can pull updates).
- `POST /install` — register a device `{device_id, student, platform, version}`.
- `POST /report` — lock | unlock | heartbeat | tamper events from the helper/extension.
- `POST /quiz/:id/password` `{device_id}` — returns the quiz password **only** when a
  lock was reported for this device+quiz in the last 60s.
- Teacher (header `X-LOCKqz-Teacher`): `POST /quiz`, `GET /quizzes`, `GET /roster`, `GET /sessions?quiz=`.

## Teacher flow
Create a quiz in the dashboard → it returns a password and a `[LOCKqz] …` title tag →
set that password on the Brightspace quiz and put the tag in its title. Only a student
whose computer is locked by LOCKqz can get the password, so only they can open the quiz.

## Note
Put the real Mac/Windows installers at `public/download/lockqz-mac.pkg` and
`public/download/lockqz-win.exe` (built in the signing/installer step).
