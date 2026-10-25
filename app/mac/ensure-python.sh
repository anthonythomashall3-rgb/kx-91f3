#!/bin/bash
# Makes sure /usr/bin/python3 really works before the helper starts.
# On a Mac without Apple's Command Line Tools, /usr/bin/python3 is only a stub that pops up an
# "install the developer tools?" dialog - a helper started by launchd would never run. This
# installs the tools headlessly with Apple's own softwareupdate (no Xcode, no Apple account,
# nothing to click; one time, ~5-15 min). A macOS upgrade can remove the tools again, so the
# helper's boot script runs this on every start and repairs itself.
python_ok(){ /usr/bin/python3 -c 'import json,hashlib,hmac,ssl,urllib.request,http.server' >/dev/null 2>&1; }
python_ok && exit 0
[ "$(id -u)" = 0 ] || { echo "LOCKqz: python3 is not usable and this is not root - run with sudo"; exit 1; }
echo "LOCKqz: installing Apple's Command Line Tools (one time, several minutes)..."
FLAG=/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
[ -L "$FLAG" ] && rm -f "$FLAG"   # never follow a planted symlink as root
touch "$FLAG"
# softwareupdate lists it as "* Label: Command Line Tools for Xcode-16.0" (older macOS: without "Label:").
LABEL="$(softwareupdate -l 2>/dev/null | grep -E '\* (Label: )?Command Line Tools' \
         | sed -E 's/^.*(Command Line Tools[^,]*).*$/\1/' | sort -V | tail -1)"
if [ -n "$LABEL" ]; then
  echo "LOCKqz: downloading '$LABEL' from Apple (keep the Mac on and online)..."
  softwareupdate -i "$LABEL" --verbose > /tmp/.lockqz-clt.$$ 2>&1 & SU=$!
  M=0
  while kill -0 "$SU" 2>/dev/null; do sleep 30; M=$((M+1)); [ $((M % 2)) = 0 ] && echo "LOCKqz: still installing Apple's tools ($((M/2)) min)..."; done
  wait "$SU"; tail -3 /tmp/.lockqz-clt.$$; rm -f /tmp/.lockqz-clt.$$
fi
rm -f "$FLAG"
python_ok && { echo "LOCKqz: python3 ready"; exit 0; }
echo "LOCKqz: python3 is still not usable (softwareupdate found: '${LABEL:-nothing}')"
echo "LOCKqz: next step: run  xcode-select --install  (click Install), then install LOCKqz again."
exit 1
