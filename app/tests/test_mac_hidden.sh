#!/bin/bash
# Programs that hide their windows from screen capture are closed during a quiz - for real, on a Mac with a signed-in
# user (GitHub's Mac runner; uses sudo). A tiny app whose window is hidden from capture is closed by the engine's own
# functions running as root; a normal window, Apple's own program and an app on the never-close list (by its bundle
# id, and by a name the server added) stay open. Not part of run_all (it needs a Mac screen).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; MAC="$HERE/../mac"
T="$(mktemp -d)"; PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
alive() { kill -0 "$1" 2>/dev/null; }

cat > "$T/w.swift" <<'SW'
import AppKit
// One window far off screen: hidden from screen capture (sharingType none), or a normal one ("shown"). Quits after 90 s.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let w = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 20, height: 20), styleMask: [.borderless], backing: .buffered, defer: false)
w.sharingType = CommandLine.arguments.contains("shown") ? .readOnly : .none
w.orderFront(nil)
DispatchQueue.main.asyncAfter(deadline: .now() + 90) { exit(0) }
app.run()
SW
swiftc -O -o "$T/LQHiddenTest" "$T/w.swift" || { echo "FAIL: swiftc"; exit 1; }
cp "$T/LQHiddenTest" "$T/LQShownTest"; cp "$T/LQHiddenTest" "$T/KeptByServer"
mkdir -p "$T/Zoomish.app/Contents/MacOS"; cp "$T/LQHiddenTest" "$T/Zoomish.app/Contents/MacOS/Zoomish"
cat > "$T/Zoomish.app/Contents/Info.plist" <<'PL'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>us.zoom.lqtest</string><key>CFBundleExecutable</key><string>Zoomish</string>
<key>CFBundleName</key><string>Zoomish</string><key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PL
codesign -s - --force "$T/Zoomish.app" >/dev/null 2>&1 || true
printf 'KeptByServer\n' > "$T/keep.txt"

"$T/LQHiddenTest" & H=$!
"$T/LQShownTest" shown & S=$!
"$T/KeptByServer" & K=$!
"$T/Zoomish.app/Contents/MacOS/Zoomish" & Z=$!
/usr/bin/osascript -l JavaScript -e 'ObjC.import("Cocoa"); var app = $.NSApplication.sharedApplication;
var w = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(-4000, -4000, 20, 20), 0, 2, false);
w.sharingType = 0; w.orderFront(null); delay(90);' & A=$!
sleep 4

# Without a screen session nothing can be shown (or hidden): say so and stop, never a false pass or fail.
user_view="$(source "$MAC/extra-block.sh"; /usr/bin/osascript -l JavaScript -e "$HW_JXA" 2>&1)"
if ! printf '%s\n' "$user_view" | grep -q "LQHiddenTest"; then
  echo "::warning::no window server session for this user (the test windows are not listed): hidden-window test skipped"
  printf '%s\n' "$user_view" | head -5
  kill "$H" "$S" "$K" "$Z" "$A" 2>/dev/null; rm -rf "$T"; exit 0
fi

# The engine's own functions, as root, exactly as a lock pass runs them (the window list is read in the user's session).
sudo env LOCKQZ_KEEP_FILE="$T/keep.txt" MAC="$MAC" bash -c '
  xb_say() { echo "LOCKqz: $*"; }
  source "$MAC/lockqz-core.sh" 2>/dev/null; source "$MAC/extra-block.sh"; DRYRUN=0
  echo "--- window list (as root, through the signed-in user):"; _hw_list; echo
  echo "--- hidden_close:"; time hidden_close' > "$T/out" 2>&1
sleep 1
cat "$T/out"

grep -q "	LQHiddenTest	" "$T/out" && ok "root sees the hidden window through the signed-in user's session" || bad "the window list (as root) has no LQHiddenTest"
grep -q "LQShownTest" "$T/out" && bad "a normal window was listed as hidden" || ok "a normal window is not listed"
! alive "$H" && ok "the program with a hidden window was closed" || bad "LQHiddenTest still running"
alive "$S" && ok "the program with a normal window stays" || bad "LQShownTest was closed"
alive "$K" && ok "a name the server added to the never-close list stays" || bad "KeptByServer was closed"
alive "$Z" && ok "an app whose bundle id is on the never-close list (us.zoom.) stays" || bad "Zoomish (us.zoom.lqtest) was closed"
alive "$A" && ok "Apple's own program (/usr/bin/osascript) stays" || bad "osascript was closed"
[ "$(grep -c "^LOCKqz: closed " "$T/out")" = 1 ] && ok "exactly one program closed, and said so in the log" || bad "closed count: $(grep -c "^LOCKqz: closed " "$T/out")"

kill "$H" "$S" "$K" "$Z" "$A" 2>/dev/null; wait 2>/dev/null; rm -rf "$T"
echo ""; echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
