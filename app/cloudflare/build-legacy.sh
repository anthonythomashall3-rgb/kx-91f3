#!/bin/bash
# Old address lockdownqz.pages.dev: pages forward to lockqz.pages.dev, but the API (/api/*, run by
# Functions, which _redirects never touch) keeps answering for apps installed before the rename.
cd "$(dirname "$0")"
rm -rf legacy_site legacy_prof && mkdir legacy_site legacy_prof
cp -R public/. legacy_site/ && cp -R public/. legacy_prof/
cat > legacy_site/_redirects <<R
/                 https://lockqz.pages.dev/                  301
/index.html       https://lockqz.pages.dev/                  301
/privacy.html     https://lockqz.pages.dev/privacy.html      301
/dashboard        https://prof.lockqz.pages.dev/             301
/dashboard.html   https://prof.lockqz.pages.dev/             301
/download/*       https://lockqz.pages.dev/download/:splat   302
R
cat > legacy_prof/_redirects <<R
/                 https://prof.lockqz.pages.dev/             301
/index.html       https://prof.lockqz.pages.dev/             301
/dashboard        https://prof.lockqz.pages.dev/             301
/dashboard.html   https://prof.lockqz.pages.dev/             301
R
