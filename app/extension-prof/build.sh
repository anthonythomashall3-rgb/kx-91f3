#!/bin/bash
# Builds the two store packages from this folder + the live site's sync.js / lq.js (one copy of the code):
#   dist/lockqz-prof-chromium.zip  -> Microsoft Edge Add-ons (free) and the Chrome Web Store
#   dist/lockqz-prof-firefox.zip   -> Firefox Add-ons (addons.mozilla.org, free)
set -euo pipefail
cd "$(dirname "$0")"
PUB=../cloudflare/public
rm -rf build dist; mkdir -p build/chromium build/firefox dist
for b in chromium firefox; do
  cp background.js content-bs.js content-dash.js icon16.png icon48.png icon128.png "$PUB/sync.js" "$PUB/lq.js" "build/$b/"
done
python3 - <<'P'
import json
m = json.load(open("manifest.json"))
c = json.loads(json.dumps(m)); c["background"] = {"service_worker": "background.js"}; c.pop("browser_specific_settings", None)
f = json.loads(json.dumps(m)); f["background"] = {"scripts": ["background.js"]}
json.dump(c, open("build/chromium/manifest.json", "w"), indent=2)
json.dump(f, open("build/firefox/manifest.json", "w"), indent=2)
P
for b in chromium firefox; do (cd "build/$b" && zip -qX -r "../../dist/lockqz-prof-$b.zip" .); done
rm -rf build
ls -l dist
