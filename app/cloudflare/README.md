# LOCKqz — Cloudflare backend

Cloudflare Pages site + Pages Function API + D1 database. Free plans only.

## Deploy (the only way: `deploy.sh`; CI's deploy job runs the same file)
```
npm ci
npx wrangler login
bash release-local.sh     # from a Mac: installers + signed update manifest + one-line installers into public/
bash deploy.sh            # schema + new migrations (once each) + the same build to lockqz AND lockdownqz
```
`deploy.sh` refuses to publish without real installers and a valid signed `update.json`, refuses
when the two Pages projects (lockqz, lockdownqz) have different secrets, and finishes by checking that
every address answers `GET /api/version` with the same version, build id and flags.

Never run `wrangler d1 execute --file`: D1's import path snapshots/restores the database and counts
every row as written (that exhausted the free 100k rows/day). Use `--command`, as deploy.sh does.
First-time setup: `npx wrangler d1 create lockqz` (paste the id into wrangler.toml), then
`npx wrangler pages secret put TEACHER_KEY --project-name lockqz` (and the same for `lockdownqz`).

## Pages
- `/` — download page (one button, OS-detected). `/pay` — student fee.
- `prof.lockqz.pages.dev` — professor dashboard. `/sync.js` — the Brightspace Sync panel.

## API (`/api/*`)
- `GET /version` — `{version, api, codes_on, strict, fee_on}` (no auth).
- `GET /blocklist` — current AI domain list (helpers refresh from it).
- Device (signed with the device key): `/register`, `/verify`, `/install`, `/report`, `/password`.
- Professor (`X-LOCKqz-Teacher` session or `X-LOCKqz-Sync` key): `/sync`, `/sync-result`, `/bs`,
  `/protect`, `/gate`, `/rotated`, `/submitted`, `/live`, `/sessions`, `/roster`, `/my-sections`.
- Admin: `/teachers`, `/activate`, `/invite`, `/reset`, `/reset-requests`, `/payments`, `/pay-assign`,
  `/pay-void`, `/forget`, `/revoke-device`.

## USC sections
`.github/workflows/usc-sections.yml` refreshes `usc_sections` daily, writing only changed rows
(`app/usc/build_sections.py fetch` + `diff`, loaded with `--command`).
