#!/bin/bash
# Sweep 28 (22 Nov 2026), engines (Mac + Linux): what else is closed during a quiz. Real engine functions against
# fake commands and folders; no root, no system changes, never a real process signalled.
#   V  every virtual machine made with Apple's Virtualization framework (any app) + more VM / emulator apps
#   R  a shell on another computer (ssh, mosh, Termius; port 22), more remote-desktop and cloud-PC clients
#   P  proxies and tunnels that look names up remotely (Proxifier, sing-box, cloudflared, ngrok ...)
#   M  a local model under any program name: its model file on the command line, or held open by a big program
#   S  Siri off for the quiz (its managed preference), put back exactly; a Mac's own file is never touched
#   W  more whole domains (translate.goog, github.dev, tunnels, AI demo hosts), the same on every platform
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MAC="$HERE/../mac"; WIN="$HERE/../windows"; LNX="$HERE/../linux"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

lists() { ( source "$MAC/lockqz-core.sh" 2>/dev/null; source "$MAC/extra-block.sh"
  printf 'VM\t%s\n' "${VM_APPS[@]}"; printf 'VMRE\t%s\n' "${VM_CMD_RES[@]}"; printf 'RE\t%s\n' "${REMOTE_APPS[@]}"
  printf 'VPN\t%s\n' "${VPN_APPS[@]}"; printf 'AI\t%s\n' "${APPLE_AI_APPS[@]}"; printf 'W\t%s\n' "${WILD_DOMAINS[@]}" ) > "$TMP/lists"; }
lists
has() { grep -qxF "$(printf '%s\t%s' "$1" "$2")" "$TMP/lists"; }

echo "V virtual machines and Android emulators"
for a in VirtualBuddy tart vfkit krunkit multipassd "Podman Desktop" podman "Rancher Desktop" BlueStacks; do check "Mac closes $a" "has VM '$a'"; done
check "every Virtualization-framework VM closed by its service's path (a name is cut at 16 characters)" "grep -q 'com\\\\.apple\\\\.Virtualization\\\\.VirtualMachine\\\\.xpc' '$TMP/lists'"
check "Linux closes waydroid / anbox / multipassd" 'grep -A1 "^VM_APPS=" "$LNX/lockqz.sh" | grep -q "waydroid anbox" && grep -A1 "^VM_APPS=" "$LNX/lockqz.sh" | grep -q multipassd'

echo "R a shell on another computer, more remote-desktop clients"
for a in ssh mosh-client Termius "Remote Desktop" "VNC Viewer" "Steam Link" "Citrix Workspace" "Amazon WorkSpaces"; do check "Mac closes $a" "has RE '$a'"; done
check "Mac pf drops SSH (port 22) during a quiz" 'grep -qx "block drop out proto tcp to any port 22" "$MAC/com.lockqz.pf.conf"'
check "Linux nftables and iptables drop SSH during a quiz" 'grep -q "^    tcp dport 22 drop$" "$LNX/lockqz.sh" && [ "$(grep -c -- "--dport 22 -j DROP" "$LNX/lockqz.sh")" = 2 ]'
check "Linux closes remmina, ssh, xfreerdp" 'grep -A3 "^REMOTE_APPS=" "$LNX/lockqz.sh" | grep -q remmina && grep -A3 "^REMOTE_APPS=" "$LNX/lockqz.sh" | grep -q " ssh " && grep -A3 "^REMOTE_APPS=" "$LNX/lockqz.sh" | grep -q xfreerdp'

echo "P proxies and tunnels"
for a in Proxifier Surge ShadowsocksX-NG cloudflared ngrok sing-box tailscaled sshuttle Lantern; do check "Mac closes $a" "has VPN '$a'"; done
check "Linux closes cloudflared / ngrok / sshuttle" 'grep -A3 "^VPN_APPS=" "$LNX/lockqz.sh" | grep -q "cloudflared ngrok" && grep -A3 "^VPN_APPS=" "$LNX/lockqz.sh" | grep -q sshuttle'

echo "M a local model under any program name"
BIN="$TMP/bin"; mkdir -p "$BIN"
cat > "$BIN/ps" <<'EOF'
#!/bin/bash
printf '%s\n' "  555 40000 /Users/s/Downloads/notes-helper -m /Users/s/m/qwen2.5-7b-instruct-q4.gguf --port 9999" \
               "  556 40000 /Users/s/bin/thing --weights /Users/s/w/model.safetensors" \
               "  600 3000000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer" \
               "  601 2000000 /System/Library/CoreServices/mdworker -s x.gguf" \
               "  602 1000 /usr/bin/vim notes-about-gguf.txt" \
               "  777 3000000 /Users/s/.local/bin/renamed --serve" \
               "  779 2500000 /System/Library/Frameworks/x" "  780 500 /usr/bin/true"
EOF
cat > "$BIN/lsof" <<'EOF'
#!/bin/bash
case "$*" in
  *" 777 "*|*"-p 777"*) printf 'p777\nn/Users/s/.ollama/models/blobs/sha256-ab12\n' ;;
  *) printf 'p0\nn/Users/s/Library/Caches/x.db\n' ;;
esac
EOF
chmod +x "$BIN/ps" "$BIN/lsof"
( export PATH="$BIN:$PATH"; DRYRUN=1; STATE="$TMP/state"; mkdir -p "$STATE"; source "$MAC/lockqz-core.sh" 2>/dev/null; source "$MAC/extra-block.sh"
  models_by_file ) > "$TMP/m" 2>&1
check "a model file named on the command line (renamed llama.cpp / any name): closed" 'grep -q "local model by its files): 555$" "$TMP/m" && grep -q "local model by its files): 556$" "$TMP/m"'
check "a big program holding an Ollama model blob open: closed" 'grep -q "local model by its files): 777$" "$TMP/m"'
check "the browser, a system service and a text file that only mentions gguf: left alone" '! grep -qE "files\): (600|601|602|779|780)$" "$TMP/m"'
LP="$TMP/proc"; mkdir -p "$LP/4242" "$LP/4243"
printf '7f00 r--s 00000000 08:01 1 /home/s/.cache/lm-studio/models/a/b.gguf\n' > "$LP/4242/maps"; printf '7f00 r-xp 0 08:01 1 /usr/lib/libc.so.6\n' > "$LP/4243/maps"
cat > "$BIN/ps" <<'EOF'
#!/bin/bash
case "$*" in
  *args=*) printf '%s\n' " 4250 /home/s/llama/x -m /home/s/m/llama-3.gguf" " 4251 /usr/bin/bash" ;;
  *rss=*)  printf '%s\n' " 4242 2500000" " 4243 2600000" " 4251 100" ;;
esac
EOF
( export PATH="$BIN:$PATH"; DRYRUN=1; export LOCKQZ_PROC="$LP"
  sed -n '/^MODEL_FILE_RE=/,/^}/p' "$LNX/lockqz.sh" > "$TMP/lm.sh"; source "$TMP/lm.sh"; models_by_file ) > "$TMP/lm" 2>&1
check "Linux: a model named on the command line, and one mapped by a big program, are closed; others not" 'grep -q "files): 4250$" "$TMP/lm" && grep -q "files): 4242$" "$TMP/lm" && ! grep -qE "files\): (4243|4251)$" "$TMP/lm"'

echo "S Siri off for the quiz"
SM="$TMP/mp/com.apple.ironwood.support.plist"; mkdir -p "$TMP/mp"
( DRYRUN=0; STATE="$TMP/state"; LOCKQZ_SIRI_MDM="$SM"; source "$MAC/lockqz-core.sh" 2>/dev/null; source "$MAC/extra-block.sh"
  prefs_changed() { echo changed >> "$TMP/pc"; }
  siri_off; echo "off=$?" > "$TMP/s"
  python3 -c "import plistlib,sys; d=plistlib.load(open(sys.argv[1],'rb')); print('allowed=%s mark=%s' % (d.get('Ironwood Allowed'), d.get('LOCKqzManaged')))" "$SM" >> "$TMP/s"
  siri_off; siri_on; echo "on=$?" >> "$TMP/s"; [ -e "$SM" ] && echo still >> "$TMP/s"
  printf 'theirs\n' > "$SM"; siri_off; siri_on; cat "$SM" >> "$TMP/s" ) 2>&1
check "lock: Siri's managed preference written (Ironwood Allowed false, LOCKqz's mark)" 'grep -q "^off=0" "$TMP/s" && grep -q "allowed=False mark=True" "$TMP/s"'
check "unlock: LOCKqz's file removed" 'grep -q "^on=0" "$TMP/s" && ! grep -q "^still" "$TMP/s"'
check "a Mac's own file (an MDM profile) is never written over nor removed" 'grep -qx "theirs" "$TMP/s"'
check "the Siri window itself is closed with the other Apple AI apps" "has AI Siri"

echo "W more whole domains, the same list everywhere"
for d in translate.goog github.dev gitpod.io csb.app mybinder.org devtunnels.ms gradio.live val.run streamlit.app; do check "Mac whole domain $d" "has W '$d'"; done
check "Windows NRPT list = Mac list" 'python3 - "$WIN/lockqz.ps1" "$TMP/lists" <<'"'"'PY'"'"'
import re,sys
s=open(sys.argv[1]).read(); w=set(re.findall(r"\"([^\"]+)\"", re.search(r"\$WildDomains = @\((.*?)\)", s, re.S).group(1)))
mac={l.split("\t",1)[1].strip() for l in open(sys.argv[2]) if l.startswith("W\t")}
sys.exit(0 if w==mac else 1)
PY'
check "Linux list = Mac list" 'python3 - "$LNX/lockqz.sh" "$TMP/lists" <<'"'"'PY'"'"'
import re,sys
l=set(re.search(r"WILD_DOMAINS=\(([^)]*)\)", open(sys.argv[1]).read()).group(1).replace("\\"," ").split())
mac={x.split("\t",1)[1].strip() for x in open(sys.argv[2]) if x.startswith("W\t")}
sys.exit(0 if l==mac else 1)
PY'
check "never pages.dev (LOCKqz itself)" '! grep -q "pages.dev" "$TMP/lists"'

echo "B Cloudflare's AI, chatbot builders' public pages, voice agents: listed on every computer and served"
for h in playground.ai.cloudflare.com gateway.ai.cloudflare.com api.cloudflare.com dash.cloudflare.com chatbase.co docsbot.ai \
         chatling.ai voiceflow.com general-runtime.voiceflow.com stack-ai.com mindstudio.ai agent.ai gumloop.com typebot.co \
         landbot.io zapier.app agents.zapier.com app.n8n.cloud customgpt.ai botsonic.com elevenlabs.io question.ai; do
  grep -qx "$h" "$MAC/blocklist.txt" && grep -qx "$h" "$WIN/blocklist.txt" && grep -qF "\"$h\"" "$HERE/../cloudflare/functions/api/[[route]].js" || { bad "$h missing"; MISS=1; }
done
[ -z "${MISS:-}" ] && ok "all 22 in both blocklist.txt and AI_DOMAINS (the rest of their pages: the browsers' filters cover every subdomain)"
check "Cloudflare itself (its sign-in check pages, its own site) stays open" '! grep -qxE "cloudflare.com|www.cloudflare.com|challenges.cloudflare.com" "$MAC/blocklist.txt"'

echo "H programs that hide their windows from screen capture (22 Nov 2026): closed, whatever their name"
hw_run() {   # hw_run dryrun -> closed pids in $TMP/hw.killed, output in $TMP/hw.out (window list: $TMP/hw.list)
  : > "$TMP/hw.killed"
  ( STATE="$TMP/hwstate"; mkdir -p "$STATE"; HERE="$TMP/hwhere"; mkdir -p "$HERE"
    source "$MAC/lockqz-core.sh" 2>/dev/null; source "$MAC/extra-block.sh"
    DRYRUN="$1"
    xb_say() { echo "LOCKqz: $*"; }
    _hw_list() { cat "$TMP/hw.list"; }
    _hw_path() { echo "/Users/s/Downloads/FromLsof"; }
    _hw_bundle_id() { case "$1" in */zoom.us.app) echo us.zoom.xos ;; */Fake.app) echo com.apple.Terminal ;; */Glimp.app) echo com.glimp.desktop ;;
                        */Keynote.app) echo com.apple.iWork.Keynote ;; *) : ;; esac; }
    _hw_apple() { case "$1" in */Keynote.app) return 0 ;; *) return 1 ;; esac; }
    _hw_kill() { echo "$1" >> "$TMP/hw.killed"; }
    hidden_close ) > "$TMP/hw.out" 2>&1
}
T=$'\t'
{ echo "101${T}Glimp${T}/Applications/Glimp.app/Contents/MacOS/Glimp${T}"
  echo "102${T}zoom.us${T}/Applications/zoom.us.app/Contents/MacOS/zoom.us${T}us.zoom.xos"
  echo "103${T}Control Center${T}/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter${T}com.apple.controlcenter"
  echo "104${T}Terminal${T}/Applications/Fake.app/Contents/MacOS/Terminal${T}"
  echo "105${T}Keynote${T}/Applications/Keynote.app/Contents/MacOS/Keynote${T}"
  echo "106${T}helper${T}${T}"
  echo "107${T}KeptByServer${T}/private/tmp/x/KeptByServer${T}"
  echo "108${T}1Password${T}/Applications/1Password.app/Contents/MacOS/1Password${T}com.1password.1password"
  echo "109${T}Google Chrome${T}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome${T}com.google.Chrome"
  echo "110${T}OBS${T}/Applications/OBS.app/Contents/MacOS/OBS${T}com.obsproject.obs-studio"
  echo "111${T}SAFE EXAM BROWSER${T}/Applications/Safe Exam Browser.app/Contents/MacOS/Safe Exam Browser${T}org.safeexambrowser.SafeExamBrowser"
  echo "1${T}launchd${T}/sbin/launchd${T}"
  echo "abc${T}junk${T}/x${T}"; } > "$TMP/hw.list"
mkdir -p "$TMP/hwhere"; printf 'KeptByServer\nGlimp; rm -rf /\n# a note\n' > "$TMP/hwhere/keep.txt"
hw_run 0
check "an overlay app closed whatever its name (Glimp), and a program found only by its file (lsof)" 'grep -qx 101 "$TMP/hw.killed" && grep -qx 106 "$TMP/hw.killed"'
check "a program calling itself Terminal with a fake Apple bundle id (not signed by Apple) is closed" 'grep -qx 104 "$TMP/hw.killed"'
check "exactly those three closed (Zoom, Apple's own, Apple-signed Keynote, the server's addition, 1Password, Chrome, OBS, Safe Exam Browser stay)" '[ "$(sort -n "$TMP/hw.killed" | tr "\n" " ")" = "101 104 106 " ]'
check "a bad line in keep.txt keeps nothing (Glimp still closed), the log names what was closed" 'grep -q "closed Glimp (/Applications/Glimp.app/Contents/MacOS/Glimp): it hides its windows from screen capture" "$TMP/hw.out"'
hw_run 1
check "the preview only says what it would close" '[ ! -s "$TMP/hw.killed" ] && [ "$(grep -c "would close (hides its windows from screen capture)" "$TMP/hw.out")" = 3 ]'
: > "$TMP/hw.list"; hw_run 0
check "nothing hidden: nothing closed, nothing said" '[ ! -s "$TMP/hw.killed" ] && [ ! -s "$TMP/hw.out" ]'
check "the window list is read in the signed-in user's session (the engine runs as root), with no permission prompt" 'grep -q "launchctl asuser \"\$uid\" sudo -n -u \"#\$uid\" /usr/bin/osascript -l JavaScript" "$MAC/extra-block.sh" && grep -q "kCGWindowSharingState === 0" "$MAC/extra-block.sh"'
check "the program file comes from the window list or lsof, never ps (it shows ./name)" 'grep -q "runningApplicationWithProcessIdentifier" "$MAC/extra-block.sh" && grep -q "^_hw_path() { lsof " "$MAC/extra-block.sh"'
check "the helper saves the server's never-close list beside the AI list (keep.txt)" 'grep -q "def save_keep" "$MAC/lockqzd.py" && grep -q "save_keep(keep)" "$MAC/lockqzd.py" && grep -q "KEEP_FILE=\"\${LOCKQZ_KEEP_FILE:-\${HERE:-" "$MAC/extra-block.sh"'

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
