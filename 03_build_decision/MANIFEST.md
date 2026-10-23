# MANIFEST — 03_build_decision

Created 16 Oct 2026. The decision to build the full app + the full v1 build.

| File | What it is |
|---|---|
| DECISION.md | Decisions (Mac first; strong v1), v1 architecture, next bricks, hard limits, and the BUILD STATUS of the whole v1 codebase |

The actual application lives in ~/Projects/LOCKqz/app/ :
- app/README.md — overview, architecture diagram, enforcement loop, full test guide, LaunchDaemon snippet.
- app/mac/ — helper (engine lockqz.sh, daemon lockqzd.py, pf.conf, browser-AI .mobileconfig, blocklist).
- app/extension/ — Chrome/Edge MV3 extension (quiz detect, password, in-browser AI strip, popup).
- app/cloudflare/ — Pages site + API (D1), download page, teacher dashboard, schema.
- app/windows/ — PowerShell engine + daemon.

All files syntax/JSON-checked on the Mac 16 Oct. Not signed, not deployed, not yet live-tested end-to-end.
Copy of app/README.md in the claude.ai LOCKqz project as claude/LOCKqz-app-README.md.
