#!/bin/bash
# Builds the teacher site (prof.lockdownqz.pages.dev): same API + data, dashboard as the home page.
cd "$(dirname "$0")"
rm -rf prof_site && mkdir prof_site && cp -R public/. prof_site/ && rm -f prof_site/_redirects
cp prof_site/dashboard.html prof_site/index.html
