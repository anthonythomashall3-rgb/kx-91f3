# LOCKqz API on a plain server

The same API file Cloudflare runs (`../cloudflare/functions/api/[[route]].js`), served by Node on one
machine with one SQLite file as the database. A machine has no per-day request allowance, so exam-day
traffic (locks, passwords, heartbeats, unlocks) is limited only by the machine.

- `server.mjs` - the HTTP server. `GET /healthz` reports health; everything under `/api/` is the API.
- `d1.mjs` - the database layer: the calls the API makes on Cloudflare D1, answered from SQLite; sets the
  database up from `schema.sql` + every `migrate_*.sql` (each once, recorded in `_migrations`).
- `import.mjs` - turns a SQL export of the Cloudflare database into the server's file.
- `loadtest.mjs` - an exam day against a real listening server: `node loadtest.mjs 50000 300`.
- `loadtest-full.mjs` - the same with a full-size database (fee on, class lists, payments, a term of
  earlier events), professors watching live and the admin on the admin pages; lists the database
  statements that cost most and any that read a whole big table:
  `node loadtest-full.mjs 100000 20000 200 1000 600000 100`.
- `lockqz.env.example` - the settings file. `lockqz-api.service` - the systemd unit.

Needs Node 22.5 or newer. No packages to install.

## A fresh machine

    curl -fsSL https://raw.githubusercontent.com/anthonythomashall3-rgb/kx-91f3/master/app/server/setup.sh | sudo bash

Installs Node, the code in `/opt/lockqz` and the `lockqz-api` service (127.0.0.1:8787, no open port).
Running it again brings the machine to the newest code and restarts the service.

## Run

    cp lockqz.env.example lockqz.env && chmod 600 lockqz.env    # fill in the secrets
                                                                # until ROT_SECRET or TEACHER_KEY is set the API answers 503 not_configured
    node --no-warnings server.mjs

The server listens on 127.0.0.1 only. Put Cloudflare in front of it with a Tunnel (`cloudflared`), so the
machine has no open port and students' addresses arrive in `CF-Connecting-IP`.

## Every processor

`WORKERS=auto` (or a number) in `lockqz.env` runs that many server processes on the one port and the one
database file. A slow request (a professor's 300-student class list) then never holds up the students, and
a process that stops is started again by itself. Only the first process makes the database copies.

## Moving the data

    npx wrangler d1 export lockqz --remote --output lockqz-export.sql
    node import.mjs lockqz-export.sql data/lockqz.db

## Copies of the database

`SNAPSHOT_MIN=15` writes a whole copy to `data/snapshots/` every 15 minutes (the newest
`SNAPSHOT_KEEP` are kept). Copy that folder off the machine.

## Tests

`node --no-warnings ../tests/test_server.mjs` (part of `run_all.sh`).

## Several schools

Put a `schools.json` in the data folder and each school gets its own database file
(`data/schools/<id>.db`) and its own settings. Brightspace numbers courses and quizzes per school, so
schools are never kept in the same tables.

    { "default": "usc",
      "schools": [
        { "id": "usc",   "name": "USC",   "brightspace": ["brightspace.usc.edu", "usc.brightspace.com"], "domains": ["usc.edu"] },
        { "id": "state", "name": "State", "brightspace": ["learn.state.edu"], "domains": ["state.edu"],
          "env": { "ADMIN_EMAIL": "admin@state.edu" } } ] }

A request is handed to its school by, in this order: the `X-LOCKqz-School` header; the Brightspace
address in it (a quiz's address, or the Sync's); the professor sign-in or Sync key that made it; the
computer that signed it; the email domain in it; otherwise the default school. The clock calls (`/cron`,
`/pay/tick`) run for every school. `schools.mjs` holds the rules; `test_server_schools.mjs` checks them.
Without a `schools.json` the server is one school with one database (`data/lockqz.db`).

### Adding a school while the server runs

    sudo -u lockqz node add-school.mjs --name "State University" --brightspace learn.stateu.edu --domain stateu.edu
    sudo systemctl reload lockqz-api

`add-school.mjs` checks that the address answers as a Brightspace, refuses an id, address or email domain
another school already has, and writes `data/schools.json`. The reload reads the settings again and replaces
the server processes one at a time (each only once its replacement answers), so no request is lost. On a
server that had one school so far, that school is written down first and its database becomes
`data/schools/usc.db`. A `schools.json` that does not load leaves the running server as it is.
`test_server_add_school.mjs` checks all of this.
