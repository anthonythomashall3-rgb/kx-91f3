# Several schools on the Cloudflare site

Each school has its own D1 database, so one school's classes, exams, students and payments are never in the same
tables as another's. `functions/api/_middleware.js` picks the school for each request (by the school's
Brightspace address, the professor's sign-in, the student's computer, or the email domain) and hands the request
to the API with that school's database and settings. With no `SCHOOLS` setting the site is one school and the
middleware does nothing.

## Add a school

    cd app/cloudflare
    python3 add-school.py --name "State University" --brightspace learn.stateu.edu --domain stateu.edu
    git add wrangler.toml && git commit -m "School: State University" && git push

The script checks that the address answers as a Brightspace, creates the database `lockqz-<id>`, and writes the
binding `DB_<ID>` and the `SCHOOLS` setting into `wrangler.toml`. The release (`deploy.sh`) then creates the
tables in every database listed in `wrangler.toml` and applies new migrations to each.

## Per-school settings

In `SCHOOLS`, a school's `"env": { ... }` overrides any setting for that school only, for example its term
dates (`TERM_DATES`) or prices. Its Brightspace addresses, the address the emails name, and its Google sign-in
domain come from the school's entry by themselves.

## The clock

`/api/cron` and `/api/pay/tick` reach every school in one call. With many schools, call them once per school
with the header `X-LOCKqz-School: <id>`.

## Limits

Cloudflare's free plan allows 10 D1 databases per account and shares its daily request and write allowance
across all schools. `test_cf_schools.mjs` checks the routing; `app/server/schools.mjs` is the same logic for the
plain server.
