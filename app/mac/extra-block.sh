#!/bin/bash
# LOCKqz extra blockers (macOS). Sourced by lockqz.sh. Everything here is applied ONLY while a
# quiz is locked and fully undone at unlock. It closes the non-browser routes to AI and to a human
# helper: VPNs, virtual machines, remote-desktop/screen-share tools, invisible-overlay cheat apps,
# local AI model servers, Apple Intelligence (Writing Tools / Genmoji / Image Playground / Siri
# ChatGPT), the Mac's built-in AirPlay Receiver (a phone mirrored to the Mac has no process to
# kill), wildcard AI domains (resolver files) and connections already open to AI hosts (pf table). Nothing is merely logged -- each route is closed. Honour LOCKQZ_DRYRUN=1 to preview.

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
        "allowNotificationsSummary": False,
        # AirPlay Receiver (an iPhone's screen mirrored onto the Mac): same restriction the CIS / DISA
        # STIG macOS benchmarks set (com.apple.applicationaccess allowAirPlayIncomingRequests = false).
        "allowAirPlayIncomingRequests": False, mark: True}
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

# AirPlay Receiver (macOS 12+): a phone mirrored onto the Mac shows the phone's AI apps (over the
# phone's own network) on the quiz screen, and there is no process to close - the receiver runs inside
# ControlCenter. During a quiz the console user's own switch (System Settings > General > AirDrop &
# Handoff > AirPlay Receiver = the per-host pref com.apple.controlcenter AirplayRecieverEnabled - Apple's
# spelling, as in the CIS benchmark) is turned off and ControlCenter is restarted (launchd relaunches it at
# once; a running mirror session ends). The value it had - true, false or never set - is saved per user
# and put back exactly at unlock. Re-checked on every lock pass, so switching it back on mid-quiz is undone.
AIRPLAY_STATE="${LOCKQZ_AIRPLAY_STATE:-${STATE:-/Library/Application Support/LOCKqz}/airplay.state}"
_cc_user() { [ "$(uname)" = Darwin ] && stat -f %Su /dev/console 2>/dev/null; }   # tests replace the _cc_* functions
_cc_exists() { id -u "$1" >/dev/null 2>&1; }
_cc_get() {   # _cc_get user -> 1 | 0 | absent
  local v; v="$(sudo -u "$1" /usr/bin/defaults -currentHost read com.apple.controlcenter AirplayRecieverEnabled 2>/dev/null)" || { echo absent; return 0; }
  case "$v" in 1|true|YES) echo 1 ;; 0|false|NO) echo 0 ;; *) echo absent ;; esac
}
_cc_set() {   # _cc_set user 1|0|absent
  case "$2" in
    absent) sudo -u "$1" /usr/bin/defaults -currentHost delete com.apple.controlcenter AirplayRecieverEnabled 2>/dev/null || true ;;
    1) sudo -u "$1" /usr/bin/defaults -currentHost write com.apple.controlcenter AirplayRecieverEnabled -bool true ;;
    *) sudo -u "$1" /usr/bin/defaults -currentHost write com.apple.controlcenter AirplayRecieverEnabled -bool false ;;
  esac
}
_cc_restart() { killall -u "$1" ControlCenter 2>/dev/null || true; }
_cc_ok_user() { case "$1" in ""|root|loginwindow|_*) return 1 ;; *[!A-Za-z0-9._-]*) return 1 ;; esac; return 0; }
airplay_receiver_off() {
  local u cur
  u="$(_cc_user)"; _cc_ok_user "$u" || return 0   # nobody signed in at the screen: nothing to mirror to
  if [ "$DRYRUN" = "1" ]; then echo "    [dry-run] would turn AirPlay Receiver off for $u (restored at unlock)"; return 0; fi
  cur="$(_cc_get "$u")"
  mkdir -p "$(dirname "$AIRPLAY_STATE")" 2>/dev/null || true
  # Remember the value from BEFORE the quiz, once per user (a re-run must never save our own "0").
  grep -q "^$u|" "$AIRPLAY_STATE" 2>/dev/null || echo "$u|$cur" >> "$AIRPLAY_STATE" || return 1
  [ "$cur" = 0 ] && return 0   # already off: no restart (this runs every few seconds)
  _cc_set "$u" 0 || return 1
  _cc_restart "$u"
  return 0
}
airplay_receiver_restore() {
  [ -f "$AIRPLAY_STATE" ] || return 0
  if [ "$DRYRUN" = "1" ]; then echo "    [dry-run] would put AirPlay Receiver back as it was"; return 0; fi
  local line u prev rc=0
  while IFS= read -r line; do
    u="${line%%|*}"; prev="${line#*|}"
    _cc_ok_user "$u" && _cc_exists "$u" || continue   # an account deleted mid-quiz has nothing to restore
    case "$prev" in 1|0|absent) ;; *) continue ;; esac
    if [ "$(_cc_get "$u")" != "$prev" ]; then
      _cc_set "$u" "$prev" || { rc=1; continue; }
      _cc_restart "$u"
    fi
  done < "$AIRPLAY_STATE"
  [ "$rc" = 0 ] && rm -f "$AIRPLAY_STATE"
  return $rc
}

# --- Wildcard AI domains (28 Oct 2026) ---
# /etc/hosts cannot block a whole domain, so a per-customer AI endpoint (<name>.openai.azure.com, a
# chat proxy on *.workers.dev / *.hf.space / *.vercel.app, a tunnel to a model at home) used by a CLI
# or desktop app stayed open. While locked, one resolver file per domain (resolver(5)) sends every name
# under it to 127.0.0.1 port 1, where nothing answers: the lookup fails at once for every program
# that uses the system resolver. Browsers never needed this (their policies block the subdomains).
# Never pages.dev (LOCKqz itself lives there). A resolver file the student made is never touched.
WILD_DOMAINS=(openai.azure.com cognitiveservices.azure.com services.ai.azure.com inference.ai.azure.com ai.azure.com \
              workers.dev hf.space modal.run vercel.app fly.dev replit.dev replit.app repl.co \
              ngrok.io ngrok-free.app ngrok.app ngrok.dev ngrok-free.dev trycloudflare.com loca.lt serveo.net \
              localhost.run pinggy.link pinggy.io zrok.io)
RESOLVER_DIR="${RESOLVER_DIR:-/etc/resolver}"
WILD_MARK="# LOCKqz quiz lock - removed at unlock"
wild_block_on() {
  local d rc=0 new=0
  mkdir -p "$RESOLVER_DIR" 2>/dev/null || return 1
  for d in "${WILD_DOMAINS[@]}"; do
    case "$d" in pages.dev|*.pages.dev) continue ;; esac
    if [ -f "$RESOLVER_DIR/$d" ] && ! grep -q "^$WILD_MARK" "$RESOLVER_DIR/$d" 2>/dev/null; then continue; fi
    [ -f "$RESOLVER_DIR/$d" ] && continue
    printf '%s\nnameserver 127.0.0.1\nport 1\n' "$WILD_MARK" > "$RESOLVER_DIR/$d" 2>/dev/null && new=1 || rc=1
  done
  [ "$new" = 1 ] && killall -HUP mDNSResponder 2>/dev/null   # pick the new resolver files up now
  return $rc
}
wild_block_off() {
  local d rc=0 gone=0
  for d in "${WILD_DOMAINS[@]}"; do
    [ -f "$RESOLVER_DIR/$d" ] || continue
    grep -q "^$WILD_MARK" "$RESOLVER_DIR/$d" 2>/dev/null || continue
    rm -f "$RESOLVER_DIR/$d" 2>/dev/null && gone=1 || rc=1
  done
  [ "$gone" = 1 ] && killall -HUP mDNSResponder 2>/dev/null
  for d in "${WILD_DOMAINS[@]}"; do [ -f "$RESOLVER_DIR/$d" ] && grep -q "^$WILD_MARK" "$RESOLVER_DIR/$d" 2>/dev/null && rc=1; done
  return $rc
}

# --- Warm connections to AI hosts (28 Oct 2026) ---
# An app LOCKqz does not close (Office, a PDF reader ...) that already held an open keep-alive
# connection to an AI host when the quiz opened could keep using it: /etc/hosts only stops NEW name
# lookups. Closed here: the blocklist's hosts are resolved (A + AAAA, straight to the real DNS servers,
# so it works after the hosts block too) into $WARM_IPS, loaded into the pf table <lq_warm>
# (com.lockqz.pf.conf): a packet of a TCP connection pf has no state for (= opened before the lock) is
# dropped, QUIC to those addresses is dropped (browsers fall back to TCP), and the states pf does hold
# are killed once. New TCP connections still pass - a shared CDN address also serves Brightspace or
# LOCKqz, and a new connection needs a name lookup, which the hosts block already refuses.
# The address list is refreshed in the background at most every 12 h; the first lock on a Mac
# protects from the first refresh on (seconds), re-applied by the 5-second lock loop.
: "${STATE:=/Library/Application Support/LOCKqz}"; : "${PF_ANCHOR:=com.lockqz}"
: "${BLOCKLIST:=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/blocklist.txt}"
WARM_IPS="${WARM_IPS:-$STATE/warm_ips}"
# API-only AI endpoints (29 Oct 2026): a program that never asks DNS (curl --resolve, a hard-coded address, its own
# DoH to an unlisted server) still reached them. Their addresses are resolved with the warm list and DROPPED on
# 443 (pf table <lq_api>) - unlike the warm table, new connections too. Only hosts that serve nothing but an AI
# API (never Google/Microsoft/GitHub front doors, which share addresses with Docs, Office, GitHub). Any address
# one of the ALLOW hosts (Brightspace, LOCKqz, USC sign-in, Google/Office sign-in) also uses is left alone.
API_HOSTS=(api.openai.com api.anthropic.com api.x.ai api.deepseek.com api.mistral.ai api.groq.com openrouter.ai api.together.xyz api.together.ai api.perplexity.ai api.cohere.com api.cohere.ai api.fireworks.ai api.replicate.com router.huggingface.co api-inference.huggingface.co api.cerebras.ai api.sambanova.ai api.deepinfra.com api.hyperbolic.xyz api.novita.ai api.moonshot.cn api.moonshot.ai open.bigmodel.cn api.minimax.chat api.minimaxi.com api.ai21.com api.voyageai.com api.siliconflow.cn api.siliconflow.com api.lepton.ai api.baseten.co api.friendli.ai api.nebius.com api.studio.nebius.ai api.kimi.com)
ALLOW_HOSTS=(lockqz.pages.dev usc.brightspace.com brightspace.com s.brightspace.com content-cdn.brightspace.com d2l.com www.d2l.com lms.usc.edu google.com www.google.com docs.google.com drive.google.com accounts.google.com login.microsoftonline.com outlook.office.com www.office.com shibboleth.usc.edu my.usc.edu www.usc.edu cloudflare.com challenges.cloudflare.com static.cloudflareinsights.com)
API_IPS="${API_IPS:-$STATE/api_ips}"
WARM_MAX_AGE=43200
warm_resolve() {   # -> $WARM_IPS (written atomically); exit 1 when dig is missing or nothing resolved
  local tmp="$WARM_IPS.tmp.$$"
  command -v dig >/dev/null 2>&1 || return 1
  domains_from "$BLOCKLIST" | sort -u | \
    xargs -P 48 -I{} sh -c 'dig +short +time=2 +tries=1 A "$1" 2>/dev/null; dig +short +time=2 +tries=1 AAAA "$1" 2>/dev/null' _ {} 2>/dev/null \
    | grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}$|^[0-9a-fA-F:]*:[0-9a-fA-F:]*$' \
    | grep -vE '^(0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|::1$|fe80:|fc|fd)' | sort -u > "$tmp"
  [ -s "$tmp" ] || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$WARM_IPS"
  api_resolve || true
}
_dig_all() {   # _dig_all host... -> addresses, one per line (A + AAAA), private/loopback dropped
  printf '%s\n' "$@" | xargs -P 24 -I{} sh -c 'dig +short +time=2 +tries=1 A "$1" 2>/dev/null; dig +short +time=2 +tries=1 AAAA "$1" 2>/dev/null' _ {} 2>/dev/null \
    | grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}$|^[0-9a-fA-F:]*:[0-9a-fA-F:]*$' \
    | grep -vE '^(0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|::1$|fe80:|fc|fd)' | sort -u
}
api_resolve() {   # -> $API_IPS: the API hosts' addresses minus every address an ALLOW host uses
  local tmp="$API_IPS.tmp.$$" allow
  command -v dig >/dev/null 2>&1 || return 1
  allow="$(_dig_all "${ALLOW_HOSTS[@]}")"
  _dig_all "${API_HOSTS[@]}" | grep -vxF -f <(printf '%s\n' "$allow"; echo "__none__") > "$tmp"
  [ -s "$tmp" ] || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$API_IPS"
}
_warm_age() {   # seconds since the file changed (macOS stat; GNU stat in the Linux tests)
  local m
  if [ "$(uname)" = Darwin ]; then m=$(stat -f %m "$1" 2>/dev/null); else m=$(stat -c %Y "$1" 2>/dev/null); fi
  case "$m" in ''|*[!0-9]*) m=0 ;; esac
  echo $(( $(date +%s) - m ))
}
warm_kill_states() {   # kill the states pf already holds to the listed addresses (once per lock)
  local ip
  while read -r ip; do
    [ -z "$ip" ] && continue
    case "$ip" in *:*) pfctl -k ::/0 -k "$ip" >/dev/null 2>&1 ;; *) pfctl -k 0.0.0.0/0 -k "$ip" >/dev/null 2>&1 ;; esac
  done < "$WARM_IPS"
}
warm_apply() {   # called on every lock pass (5 s): cheap unless the list changed
  local rc=0
  # The table is reloaded on every pass: load_pf re-reads the ruleset each time, and a ruleset load
  # resets a table to its (empty) definition. The state kill runs once per list version.
  if [ -s "$API_IPS" ]; then pfctl -a "$PF_ANCHOR" -t lq_api -T replace -f "$API_IPS" >/dev/null 2>&1 || rc=1; fi
  if [ -s "$WARM_IPS" ]; then
    if pfctl -a "$PF_ANCHOR" -t lq_warm -T replace -f "$WARM_IPS" >/dev/null 2>&1; then
      if [ ! -f "$STATE/warm.loaded" ] || [ "$WARM_IPS" -nt "$STATE/warm.loaded" ]; then warm_kill_states; touch "$STATE/warm.loaded"; fi
    else rc=1; fi
  fi
  if [ ! -s "$WARM_IPS" ] || [ "$(_warm_age "$WARM_IPS")" -gt "$WARM_MAX_AGE" ]; then
    if [ ! -f "$WARM_IPS.refreshing" ] || [ "$(_warm_age "$WARM_IPS.refreshing")" -gt 600 ]; then
      touch "$WARM_IPS.refreshing"
      ( warm_resolve; rm -f "$WARM_IPS.refreshing" ) >/dev/null 2>&1 &
    fi
  fi
  return $rc
}
warm_clear() { rm -f "$STATE/warm.loaded" 2>/dev/null; pfctl -a "$PF_ANCHOR" -t lq_warm -T flush >/dev/null 2>&1 || true; pfctl -a "$PF_ANCHOR" -t lq_api -T flush >/dev/null 2>&1 || true; }

extra_lock() {
  if [ "$DRYRUN" = "1" ]; then
    xb_say "[dry-run] extra blockers:"
    _kill_list "VPN" "${VPN_APPS[@]}"; _kill_list "VM" "${VM_APPS[@]}"
    _kill_list "remote-desktop" "${REMOTE_APPS[@]}"; _kill_list "overlay" "${OVERLAY_APPS[@]}"
    _kill_list "local-model" "${LOCAL_MODEL_PROCS[@]}"; _kill_cmd_res "${LOCAL_MODEL_CMD_RES[@]}"
    _kill_if_tunnel "${VPN_IF_TUNNEL[@]}"; _kill_list "Apple Intelligence" "${APPLE_AI_APPS[@]}"
    apple_intelligence_off; proxies_off; airplay_receiver_off
    echo "    [dry-run] would write ${#WILD_DOMAINS[@]} resolver files (wildcard AI domains) in $RESOLVER_DIR and load the AI addresses into pf <lq_warm> (warm connections)"
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
  airplay_receiver_off || rc=1
  proxies_off || true
  wild_block_on || rc=1
  warm_apply || rc=1
  return $rc
}

extra_unlock() {
  # VPN/VM/remote/overlay/model apps are left for the student to reopen; only the
  # OS-level Apple Intelligence policy and the proxies must be actively restored.
  local rc=0
  apple_intelligence_on || rc=1
  airplay_receiver_restore || rc=1
  proxies_restore || true
  wild_block_off || rc=1
  warm_clear
  rm -f "$PROXY_KEPT" 2>/dev/null || true
  return $rc
}
