#!/bin/bash
# LOCKqz extra blockers (macOS). Sourced by lockqz.sh. Everything here is applied ONLY while a
# quiz is locked and fully undone at unlock. It closes the non-browser routes to AI and to a human
# helper: VPNs, virtual machines, remote-desktop/screen-share tools, invisible-overlay cheat apps,
# local AI model servers, and Apple Intelligence (Writing Tools / Genmoji / Image Playground / Siri
# ChatGPT). Nothing is merely logged -- each route is closed. Honour LOCKQZ_DRYRUN=1 to preview.

# --- app/process kill lists (name-matched, case-insensitive) ---
VM_APPS=("Parallels Desktop" "prl_vm_app" "UTM" "VirtualBox" "VirtualBoxVM" "VBoxHeadless" \
         "VMware Fusion" "vmware-vmx" "qemu-system" "qemu-system-aarch64" "qemu-system-x86_64" \
         "Docker Desktop" "com.docker.backend")
REMOTE_APPS=("TeamViewer" "AnyDesk" "RustDesk" "remoting_host" "chrome_remote_desktop" \
             "ScreenConnect" "ConnectWiseControl" "LogMeIn" "Splashtop" "SplashtopStreamer" \
             "RealVNC" "vncserver" "TigerVNC" "jump" "Jump Desktop" "GoToMyPC" "Parsec" "Moonlight" \
             "Screen Sharing" "Microsoft Remote Desktop" "Windows App" "Chrome Remote Desktop Host")
OVERLAY_APPS=("Cluely" "Interview Coder" "InterviewCoder" "LockedIn AI" "LockedInAI" "Final Round" \
              "FinalRound" "Ohmni" "Sensei" "Leetcode Wizard" "UltraCode" "ExamShield helper" "Pieces")
LOCAL_MODEL_PROCS=("ollama" "llama-server" "llama_cpp" "llamafile" "koboldcpp" "text-generation" \
                   "localai" "lm-studio-server" "jan-server" "gpt4all" "mlx_lm" "vllm")
VPN_APPS=("NordVPN" "ExpressVPN" "Surfshark" "ProtonVPN" "Proton VPN" "Mullvad VPN" "Mullvad" \
          "Private Internet Access" "pia" "Cloudflare WARP" "Cloudflare_WARP" "Tunnelblick" \
          "OpenVPN Connect" "WireGuard" "Windscribe" "TunnelBear" "Hotspot Shield" "CyberGhost" \
          "Tailscale" "ZeroTier One" "Psiphon" "Outline" "Hiddify" "V2RayX" "ClashX" "Clash Verge" "Shadowrocket")

# Managed-preferences plist that disables Apple Intelligence (same keys an MDM profile would set;
# honoured on an unmanaged Mac). Removed at unlock.
AI_MDM="${LOCKQZ_AI_MDM:-/Library/Managed Preferences/com.apple.applicationaccess.plist}"
XB_MARK="LOCKqzManaged"

xb_say() { echo "LOCKqz: $*"; }

type app_re >/dev/null 2>&1 || app_re() { printf '/%s\\.app/Contents/MacOS/' "$(printf '%s' "$1" | sed 's/[][\\.^$*+?(){}|]/\\&/g')"; }
_kill_list() {   # _kill_list "label" name...
  local label="$1"; shift
  local a
  for a in "$@"; do
    local re; re="$(app_re "$a")"
    if [ "$DRYRUN" = "1" ]; then
      { pgrep -ix -- "$a" || pgrep -if -- "$re"; } >/dev/null 2>&1 && echo "    [dry-run] would close ($label): $a"
      continue
    fi
    # exact process name or "<name>.app" only -- never a loose substring of a command line
    pgrep -if -- "$re" >/dev/null 2>&1 && osascript -e "tell application \"$a\" to quit" 2>/dev/null || true
    pkill -ix -- "$a" 2>/dev/null || true
    pkill -if -- "$re" 2>/dev/null || true
  done
}

apple_intelligence_off() {
  if [ "$DRYRUN" = "1" ]; then echo "    [dry-run] would write $AI_MDM (Apple Intelligence off)"; return 0; fi
  mkdir -p "$(dirname "$AI_MDM")" 2>/dev/null || true
  /usr/bin/python3 - "$AI_MDM" "$XB_MARK" <<'PY' 2>/dev/null || true
import plistlib, sys
path, mark = sys.argv[1], sys.argv[2]
keys = {"allowAppleIntelligenceReport": False, "allowGenmoji": False, "allowImagePlayground": False,
        "allowImageWand": False, "allowWritingTools": False, "allowExternalIntelligenceIntegrations": False,
        "allowMailSummary": False, "allowNotificationsSummary": False, mark: True}
try:
    with open(path, "rb") as f: cur = plistlib.load(f)
    if not isinstance(cur, dict): cur = {}
except Exception:
    cur = {}
cur.update(keys)
with open(path, "wb") as f: plistlib.dump(cur, f)
PY
  # Nudge the OS to re-read managed prefs and stop any running generative helpers.
  killall cfprefsd 2>/dev/null || true
  pkill -i -f "GenerativeExperiences|IntelligencePlatform|WritingTools|ImagePlayground|com.apple.generativeexperiencesd" 2>/dev/null || true
}

apple_intelligence_on() {
  if [ "$DRYRUN" = "1" ]; then echo "    [dry-run] would remove LOCKqz keys from $AI_MDM"; return 0; fi
  [ -f "$AI_MDM" ] || return 0
  # Only touch the file if WE wrote it (carries our mark); never clobber a real MDM profile.
  /usr/bin/python3 - "$AI_MDM" "$XB_MARK" <<'PY' 2>/dev/null || true
import plistlib, os, sys
path, mark = sys.argv[1], sys.argv[2]
try:
    with open(path, "rb") as f: cur = plistlib.load(f)
except Exception:
    sys.exit(0)
if not isinstance(cur, dict) or mark not in cur:
    sys.exit(0)   # not ours -- leave it alone
os.remove(path)
PY
  killall cfprefsd 2>/dev/null || true
}

# System proxies (Safari and every app that uses them) would resolve AI sites on the proxy, past
# the hosts block. Turn any that are on OFF during a quiz and remember them; restore after.
PROXY_STATE="${STATE:-/Library/Application Support/LOCKqz}/proxy.state"
PROXY_KINDS="webproxy securewebproxy socksfirewallproxy autoproxy"
proxies_off() {
  scutil --proxy 2>/dev/null | grep -qE "(HTTPEnable|HTTPSEnable|SOCKSEnable|ProxyAutoConfigEnable) : 1" || return 0
  if [ "$DRYRUN" = "1" ]; then echo "    [dry-run] would turn system proxies off"; return 0; fi
  local svc k
  networksetup -listallnetworkservices 2>/dev/null | tail -n +2 | sed 's/^\*//' | while IFS= read -r svc; do
    for k in $PROXY_KINDS; do
      local get="-get$k"; [ "$k" = "autoproxy" ] && get="-getautoproxyurl"
      if networksetup "$get" "$svc" 2>/dev/null | grep -q "^Enabled: Yes"; then
        grep -qxF "$svc|$k" "$PROXY_STATE" 2>/dev/null || echo "$svc|$k" >> "$PROXY_STATE"
        networksetup "-set${k}state" "$svc" off 2>/dev/null || true
      fi
    done
  done
}
proxies_restore() {
  [ -f "$PROXY_STATE" ] || return 0
  if [ "$DRYRUN" = "1" ]; then echo "    [dry-run] would restore system proxies"; return 0; fi
  local line
  while IFS= read -r line; do
    [ -n "$line" ] && networksetup "-set${line##*|}state" "${line%|*}" on 2>/dev/null || true
  done < "$PROXY_STATE"
  rm -f "$PROXY_STATE"
}

extra_lock() {
  if [ "$DRYRUN" = "1" ]; then
    xb_say "[dry-run] extra blockers:"
    _kill_list "VPN" "${VPN_APPS[@]}"; _kill_list "VM" "${VM_APPS[@]}"
    _kill_list "remote-desktop" "${REMOTE_APPS[@]}"; _kill_list "overlay" "${OVERLAY_APPS[@]}"
    _kill_list "local-model" "${LOCAL_MODEL_PROCS[@]}"
    apple_intelligence_off; proxies_off
    echo "    [dry-run] pf already blocks local-model + VPN ports (com.lockqz.pf.conf)"
    return 0
  fi
  _kill_list "VPN" "${VPN_APPS[@]}"
  _kill_list "VM" "${VM_APPS[@]}"
  _kill_list "remote-desktop" "${REMOTE_APPS[@]}"
  _kill_list "overlay" "${OVERLAY_APPS[@]}"
  _kill_list "local-model" "${LOCAL_MODEL_PROCS[@]}"
  apple_intelligence_off
  proxies_off
}

extra_unlock() {
  # VPN/VM/remote/overlay/model apps are left for the student to reopen; only the
  # OS-level Apple Intelligence policy must be actively restored.
  apple_intelligence_on
  proxies_restore
}
