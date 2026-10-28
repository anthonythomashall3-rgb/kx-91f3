#!/bin/bash
# LOCKqz extra blockers (macOS). Sourced by lockqz.sh. Everything here is applied ONLY while a
# quiz is locked and fully undone at unlock. It closes the non-browser routes to AI and to a human
# helper: VPNs, virtual machines, remote-desktop/screen-share tools, invisible-overlay cheat apps,
# local AI model servers, and Apple Intelligence (Writing Tools / Genmoji / Image Playground / Siri
# ChatGPT). Nothing is merely logged -- each route is closed. Honour LOCKQZ_DRYRUN=1 to preview.

# --- app/process kill lists (name-matched, case-insensitive) ---
VM_APPS=("Parallels Desktop" "prl_vm_app" "UTM" "VirtualBox" "VirtualBoxVM" "VBoxHeadless" \
         "VMware Fusion" "vmware-vmx" "qemu-system" "qemu-system-aarch64" "qemu-system-x86_64" \
         "Docker Desktop" "com.docker.backend" "OrbStack" "colima" "limactl")
REMOTE_APPS=("TeamViewer" "AnyDesk" "RustDesk" "remoting_host" "chrome_remote_desktop" \
             "ScreenConnect" "ConnectWiseControl" "LogMeIn" "Splashtop" "SplashtopStreamer" \
             "RealVNC" "vncserver" "TigerVNC" "jump" "Jump Desktop" "GoToMyPC" "Parsec" "Moonlight" \
             "Screen Sharing" "Microsoft Remote Desktop" "Windows App" "Chrome Remote Desktop Host" \
             "iPhone Mirroring" "Screens" "Screens 5" "NoMachine" "Zoho Assist" \
             "scrcpy" "Escrcpy" "QtScrcpy" "Vysor" "AirDroid" "AirDroid Cast" "ApowerMirror" "LetsView" "AirServer" "X-Mirage" "AnyViewer")   # iPhone Mirroring = the phone's apps (and its network) on the Mac screen
OVERLAY_APPS=("Cluely" "Interview Coder" "InterviewCoder" "LockedIn AI" "LockedInAI" "Final Round" \
              "FinalRound" "Ohmni" "Sensei" "Leetcode Wizard" "UltraCode" "ExamShield helper" "Pieces" \
              "Verve AI" "Parakeet AI" "Beyz AI" "Interview Solver")
LOCAL_MODEL_PROCS=("ollama" "llama-server" "llama-cli" "llama-run" "llama_cpp" "llamafile" "koboldcpp" \
                   "text-generation" "localai" "local-ai" "lm-studio-server" "jan-server" "gpt4all" "mlx_lm" "vllm" \
                   "lms" "ollama_llama_server" "llama-mtmd-cli" "cortex" "cortex-server" "open-webui" "mlc_llm" "lmdeploy" "sglang" "lemonade-server" "lemonade-app")
# Model tools that run as "python3 ..." (their process name is python3): matched on their own
# script/module name in the command line only (extended regex, pkill -f).
LOCAL_MODEL_CMD_RES=('/bin/mlx_lm[._][a-z_]+( |$)' ' -m mlx_lm([. ]|$)' '/bin/vllm( |$)' ' -m vllm[. ]' \
                     ' -m llama_cpp\.server( |$)' '/bin/open-webui( |$)' ' -m open_webui( |$)' ' -m sglang\.launch_server' '/bin/text-generation-launcher( |$)')
VPN_APPS=("NordVPN" "ExpressVPN" "Surfshark" "ProtonVPN" "Proton VPN" "Mullvad VPN" "Mullvad" \
          "Private Internet Access" "pia" "Cloudflare WARP" "Cloudflare_WARP" "Tunnelblick" \
          "OpenVPN Connect" "WireGuard" "Windscribe" "TunnelBear" "Hotspot Shield" "CyberGhost" \
          "Tailscale" "ZeroTier One" "Psiphon" "Hiddify" "V2RayX" "ClashX" "Clash Verge" "Shadowrocket" \
          "Tor Browser" "tor")   # Tor resolves names remotely, past /etc/hosts
# A name shared with a non-VPN app (Outline VPN vs the Outline wiki/notes app): closed only when the
# running app bundle carries a VPN network extension.
VPN_IF_TUNNEL=("Outline")
# Apple Intelligence that has no working switch on an unmanaged Mac: the Shortcuts "Use Model" action
# (on-device / Private Cloud / ChatGPT) and the Image Playground app.
APPLE_AI_APPS=("Shortcuts" "Image Playground")

_kill_cmd_res() {   # _kill_cmd_res regex...  (python-run model tools)
  local re
  for re in "$@"; do
    if [ "$DRYRUN" = "1" ]; then pgrep -f -- "$re" >/dev/null 2>&1 && echo "    [dry-run] would close (local-model): $re"; continue; fi
    pkill -f -- "$re" 2>/dev/null || true
  done
}
_kill_if_tunnel() {   # _kill_if_tunnel name...
  local a pid exe app f tun
  for a in "$@"; do
    for pid in $(pgrep -if -- "$(app_re "$a")" 2>/dev/null); do
      exe="$(ps -o comm= -p "$pid" 2>/dev/null || true)"
      case "$exe" in *.app/Contents/*) app="${exe%%.app/Contents/*}.app" ;; *) continue ;; esac
      tun=0
      for f in "$app"/Contents/PlugIns/*.appex "$app"/Contents/Library/SystemExtensions/*.systemextension; do
        [ -e "$f" ] && tun=1
      done
      [ "$tun" = 1 ] || continue
      if [ "$DRYRUN" = "1" ]; then echo "    [dry-run] would close (VPN): $a"; continue; fi
      kill "$pid" 2>/dev/null || true
    done
  done
}

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
        "allowExternalIntelligenceIntegrationsSignIn": False, "allowMailSummary": False,
        "allowMailSmartReplies": False, "allowSafariSummary": False, "allowNotesTranscriptionSummary": False,
        "allowNotificationsSummary": False, mark: True}
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
# Exception: when the internet does not answer WITHOUT the proxy (a campus / workplace network that
# only works through its proxy), the proxies are put back for the quiz and PROXY_KEPT tells
# browser-policy.py to leave the browsers' proxy setting alone too - otherwise Brightspace itself
# would not load.
PROXY_STATE="${STATE:-/Library/Application Support/LOCKqz}/proxy.state"
PROXY_KEPT="${LOCKQZ_PROXY_KEPT:-${STATE:-/Library/Application Support/LOCKqz}/proxy.kept}"
PROXY_KINDS="webproxy securewebproxy socksfirewallproxy autoproxy"
direct_internet_ok() {   # any HTTP answer without a proxy counts
  curl -s -o /dev/null -m 6 --noproxy '*' http://www.gstatic.com/generate_204 >/dev/null 2>&1
}
proxies_off() {
  [ -f "$PROXY_KEPT" ] && return 0   # this quiz already found the network needs its proxy
  local px; px="$(scutil --proxy 2>/dev/null || true)"   # captured: no SIGPIPE false-negative under pipefail
  printf '%s\n' "$px" | grep -qE "(HTTPEnable|HTTPSEnable|SOCKSEnable|ProxyAutoConfigEnable) : 1" || return 0
  if [ "$DRYRUN" = "1" ]; then echo "    [dry-run] would turn system proxies off"; return 0; fi
  local svc k had=0
  [ -f "$PROXY_STATE" ] && had=1
  networksetup -listallnetworkservices 2>/dev/null | tail -n +2 | sed 's/^\*//' | while IFS= read -r svc; do
    for k in $PROXY_KINDS; do
      local get="-get$k"; [ "$k" = "autoproxy" ] && get="-getautoproxyurl"
      if networksetup "$get" "$svc" 2>/dev/null | grep -q "^Enabled: Yes"; then
        grep -qxF "$svc|$k" "$PROXY_STATE" 2>/dev/null || echo "$svc|$k" >> "$PROXY_STATE"
        networksetup "-set${k}state" "$svc" off 2>/dev/null || true
      fi
    done
  done
  if [ "$had" = 0 ] && [ -f "$PROXY_STATE" ] && ! direct_internet_ok; then
    proxies_restore; : > "$PROXY_KEPT" 2>/dev/null || true
    xb_say "this network only works through its proxy - proxy kept so the quiz can load"
  fi
  return 0
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
    _kill_list "local-model" "${LOCAL_MODEL_PROCS[@]}"; _kill_cmd_res "${LOCAL_MODEL_CMD_RES[@]}"
    _kill_if_tunnel "${VPN_IF_TUNNEL[@]}"; _kill_list "Apple Intelligence" "${APPLE_AI_APPS[@]}"
    apple_intelligence_off; proxies_off
    echo "    [dry-run] pf already blocks local-model + VPN ports (com.lockqz.pf.conf)"
    return 0
  fi
  _kill_list "VPN" "${VPN_APPS[@]}"
  _kill_list "VM" "${VM_APPS[@]}"
  _kill_list "remote-desktop" "${REMOTE_APPS[@]}"
  _kill_list "overlay" "${OVERLAY_APPS[@]}"
  _kill_list "local-model" "${LOCAL_MODEL_PROCS[@]}"
  _kill_cmd_res "${LOCAL_MODEL_CMD_RES[@]}"
  _kill_if_tunnel "${VPN_IF_TUNNEL[@]}"
  _kill_list "Apple Intelligence" "${APPLE_AI_APPS[@]}"
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
  rm -f "$PROXY_KEPT" 2>/dev/null || true
  return $rc
}
