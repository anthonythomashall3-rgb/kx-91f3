#!/bin/bash
# Old address lockdownqz.pages.dev: pages forward to lockqz.pages.dev, but the API (/api/*, run by
# Functions, which _redirects never touch) keeps answering for apps installed before the rename.
cd "$(dirname "$0")"
rm -rf legacy_site legacy_prof && mkdir legacy_site legacy_prof
# Only the pages are copied: installers, scripts and the update manifest are served (and kept current)
# by lockqz.pages.dev alone -- the old address forwards every one of them there.
cp -R public/. legacy_site/ && cp -R public/. legacy_prof/
rm -rf legacy_site/download legacy_prof/download
rm -f legacy_site/install.sh legacy_site/install.ps1 legacy_site/uninstall.sh legacy_site/uninstall.ps1 legacy_prof/install.sh legacy_prof/install.ps1 legacy_prof/uninstall.sh legacy_prof/uninstall.ps1
cat > legacy_site/_redirects <<R
/                 https://lockqz.pages.dev/                  301
/index.html       https://lockqz.pages.dev/                  301
/privacy.html     https://lockqz.pages.dev/privacy.html      301
/dashboard        https://prof.lockqz.pages.dev/             301
/dashboard.html   https://prof.lockqz.pages.dev/             301
/download/*       https://lockqz.pages.dev/download/:splat   302
/install.sh       https://lockqz.pages.dev/install.sh        302
/install.ps1      https://lockqz.pages.dev/install.ps1       302
/uninstall.sh     https://lockqz.pages.dev/uninstall.sh      302
/uninstall.ps1    https://lockqz.pages.dev/uninstall.ps1     302
/pay              https://lockqz.pages.dev/pay               302
/pay.html         https://lockqz.pages.dev/pay.html          302
R
cat > legacy_prof/_redirects <<R
/                 https://prof.lockqz.pages.dev/             301
/index.html       https://prof.lockqz.pages.dev/             301
/dashboard        https://prof.lockqz.pages.dev/             301
/dashboard.html   https://prof.lockqz.pages.dev/             301
R
