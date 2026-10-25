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

# The Mac's own applicationaccess plist (e.g. from a real MDM profile) is backed up before we add our
# keys and put back byte-for-byte at unlock - never deleted. Backup lives in the root-only state dir.
AI_BACKUP="${LOCKQZ_AI_BACKUP:-${STATE:-/Library/Application Support/LOCKqz}/applicationaccess.backup.plist}"
AI_NONE="$AI_BACKUP.none"   # marker: there was no file before the quiz

apple_intelligence_off() {
  if [ "$DRYRUN" = "1" ]; then echo "    [dry-run] would write $AI_MDM (Apple Intelligence off)"; return 0; fi
  # Already applied? Just sweep any generative helpers (cheap) and return — do NOT rewrite the plist
  # or kill cfprefsd again (the watcher calls this every 5s).
  if [ -f "$AI_MDM" ] && /usr/bin/grep -q "$XB_MARK" "$AI_MDM" 2>/dev/null; then
    pkill -i -f "GenerativeExperiences|IntelligencePlatform|WritingTools|ImagePlayground|com.apple.generativeexperiencesd" 2>/dev/null || true
    return 0
  fi
  mkdir -p "$(dirname "$AI_MDM")" "$(dirname "$AI_BACKUP")" 2>/dev/null || true
  # Back up whatever is there now (it is not ours - checked above), so unlock restores it exactly.
  if [ -f "$AI_MDM" ]; then cp -p "$AI_MDM" "$AI_BACKUP" || return 1; rm -f "$AI_NONE"
  elif [ ! -e "$AI_BACKUP" ]; then : > "$AI_NONE" || return 1; fi
  /usr/bin/python3 - "$AI_MDM" "$XB_MARK" <<'PY' 2>/dev/null || return 1
import plistlib, os, sys
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
tmp = path + ".lockqz.tmp"
with open(tmp, "wb") as f: plistlib.dump(cur, f)
os.chmod(tmp, 0o644); os.replace(tmp, path)
PY
  # Nudge the OS to re-read managed prefs and stop any running generative helpers.
  killall cfprefsd 2>/dev/null || true
  pkill -i -f "GenerativeExperiences|IntelligencePlatform|WritingTools|ImagePlayground|com.apple.generativeexperiencesd" 2>/dev/null || true
  return 0
}

apple_intelligence_on() {
  if [ "$DRYRUN" = "1" ]; then echo "    [dry-run] would restore $AI_MDM as it was before the quiz"; return 0; fi
  if [ -f "$AI_MDM" ] && /usr/bin/grep -q "$XB_MARK" "$AI_MDM" 2>/dev/null; then
    # Ours: put back exactly what was there before, or remove it if nothing was.
    if [ -f "$AI_BACKUP" ]; then cp -p "$AI_BACKUP" "$AI_MDM.lockqz.tmp" && mv -f "$AI_MDM.lockqz.tmp" "$AI_MDM" || return 1
    else rm -f "$AI_MDM" || return 1; fi
    killall cfprefsd 2>/dev/null || true
  fi
  # Not ours (absent, or replaced by a real MDM mid-quiz): leave it alone. Either way the quiz is over.
  rm -f "$AI_BACKUP" "$AI_NONE"
  ! { [ -f "$AI_MDM" ] && /usr/bin/grep -q "$XB_MARK" "$AI_MDM" 2>/dev/null; }
}

# System proxies (Safari and every app that uses them) would resolve AI sites on the proxy, past
# the hosts block. Turn any that are on OFF during a quiz and remember them; restore after.
PROXY_STATE="${STATE:-/Library/Application Support/LOCKqz}/proxy.state"
PROXY_KINDS="webproxy securewebproxy socksfirewallproxy autoproxy"
proxies_off() {
  local px; px="$(scutil --proxy 2>/dev/null || true)"   # captured: no SIGPIPE false-negative under pipefail
  printf '%s\n' "$px" | grep -qE "(HTTPEnable|HTTPSEnable|SOCKSEnable|ProxyAutoConfigEnable) : 1" || return 0
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
  local line k
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    k="${line##*|}"
    case " $PROXY_KINDS " in *" $k "*) networksetup "-set${k}state" "${line%|*}" on 2>/dev/null || true ;; esac
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
  local rc=0
  apple_intelligence_off || rc=1
  proxies_off || true
  return $rc
}

extra_unlock() {
  # VPN/VM/remote/overlay/model apps are left for the student to reopen; only the
  # OS-level Apple Intelligence policy and the proxies must be actively restored.
  local rc=0
  apple_intelligence_on || rc=1
  proxies_restore || true
  return $rc
}
