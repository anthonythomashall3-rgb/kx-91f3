#!/bin/bash
# LOCKqz blocking engine (Linux). Run as root (the lockqzd systemd service calls it).
#   sudo bash lockqz.sh lock|unlock|status
# Same layers as the Mac engine, with Linux tools:
#   * /etc/hosts blackhole of every AI host (lockqz-core.sh, shared with the Mac)
#   * nftables (iptables fallback): DNS-over-TLS, known DoH resolver addresses, local-model ports,
#     VPN protocols, QUIC to the AI hosts' addresses (warm connections)
#   * browser policies (browser-policy.py): Chrome/Chromium/Edge/Brave/Vivaldi/Opera + Firefox family
#   * AI / local-model / VPN / VM / remote-desktop / overlay / messaging apps closed
#   * connections already open to AI hosts cut (ss -K) once the address list exists (warm_ips,
#     resolved in the background past /etc/hosts)
# Output contract (read by lockqzd.py): exit 0 = every layer applied; `status` prints "LOCKqz: LOCKED"
# only while the hosts block is really in place. Honour LOCKQZ_DRYRUN=1 to preview.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOSTS="${HOSTS:-/etc/hosts}"
STATE="${STATE:-/var/lib/lockqz}"
BLOCKLIST="${BLOCKLIST:-$HERE/blocklist.txt}"
POLICY="${POLICY:-$HERE/browser-policy.py}"
DRYRUN="${LOCKQZ_DRYRUN:-0}"
NFT_TABLE="lockqz"
BACKUP="$STATE/hosts.backup"
STATUS="$STATE/status.json"
WARM_IPS="${WARM_IPS:-$STATE/warm_ips}"
WARM_MAX_AGE=43200
source "$HERE/lockqz-core.sh"

say() { echo "LOCKqz: $*"; }
need_root() { [ "$DRYRUN" = "1" ] && return; [ "$(id -u)" -eq 0 ] || { echo "LOCKqz: must run as root (or LOCKQZ_DRYRUN=1 to preview)." >&2; exit 1; }; }
is_locked() { hosts_is_locked "$HOSTS"; }

# --- process lists (exact process names; pkill -x) ---
AI_APPS=(chatgpt ChatGPT claude Claude claude-desktop copilot perplexity ollama "LM Studio" lm-studio lmstudio gpt4all msty jan Jan
         anythingllm AnythingLLM chatbox Chatbox cherry-studio "Cherry Studio" open-webui pinokio witsy reor
         deepseek poe mistral grok kimi qwen codex doubao quillbot cursor-ai-chat highlight fellou browseros
         notion Notion notion-app canva slack Slack evernote
         whatsapp WhatsApp whatsapp-desktop telegram-desktop Telegram telegram discord Discord messenger Messenger)
LOCAL_MODEL_PROCS=(ollama llama-server llama-cli llama-run llamafile koboldcpp localai local-ai lm-studio-server jan-server gpt4all
                   vllm lms ollama_llama_server llama-mtmd-cli cortex cortex-server open-webui lmdeploy sglang lemonade-server text-generation-launcher)
LOCAL_MODEL_CMD_RES=('/bin/mlx_lm[._][a-z_]+( |$)' ' -m mlx_lm([. ]|$)' '/bin/vllm( |$)' ' -m vllm[. ]' ' -m llama_cpp\.server( |$)'
                     '/bin/open-webui( |$)' ' -m open_webui( |$)' ' -m sglang\.launch_server' '/bin/text-generation-launcher( |$)' 'ollama serve')
VPN_APPS=(openvpn openvpn-gui nordvpn nordvpnd expressvpn expressvpnd surfshark protonvpn protonvpn-app protonvpn-cli mullvad mullvad-daemon mullvad-gui
          windscribe windscribe-cli tunnelbear hotspotshield cyberghost tailscale tailscaled zerotier-one warp-svc warp-cli psiphon hiddify
          v2ray xray clash clash-verge Clash.Meta sing-box shadowsocks ss-local tor Tor "Tor Browser" wg wg-quick)
VM_APPS=(VirtualBox VirtualBoxVM VBoxHeadless vboxmanage qemu-system-x86_64 qemu-system-aarch64 qemu-kvm virt-manager gnome-boxes vmware vmware-vmx vmplayer dockerd containerd "Docker Desktop" limactl)
REMOTE_APPS=(teamviewer TeamViewer teamviewerd anydesk AnyDesk rustdesk RustDesk x11vnc vncserver Xvnc tigervncserver vino-server gnome-remote-desktop-daemon
             remoting_host chrome-remote-desktop parsec parsecd moonlight splashtop nomachine nxserver nxnode zohoassist scrcpy)
OVERLAY_APPS=(cluely Cluely interview-coder InterviewCoder lockedin-ai FinalRound ohmni sensei ultracode pieces verve-ai parakeet-ai beyz-ai)

_kill_list() {   # _kill_list label name...
  local label="$1"; shift
  local n
  for n in "$@"; do
    if [ "$DRYRUN" = "1" ]; then pgrep -x -- "$n" >/dev/null 2>&1 && echo "    [dry-run] would close $label: $n"; continue; fi
    pkill -x -- "$n" 2>/dev/null || true
  done
}
_kill_cmd_res() {
  local r
  for r in "$@"; do
    if [ "$DRYRUN" = "1" ]; then pgrep -f -- "$r" >/dev/null 2>&1 && echo "    [dry-run] would close local-model tool: $r"; continue; fi
    pkill -f -- "$r" 2>/dev/null || true
  done
}
SYSTEM_SERVICES=(tailscaled zerotier-one warp-svc docker containerd gnome-remote-desktop x11vnc vncserver tor openvpn wg-quick@wg0 nordvpnd expressvpn mullvad-daemon protonvpn-daemon)
stop_services() {   # once per lock: systemd would restart a killed service every 5 s
  [ "${LOCKQZ_NO_KILL:-0}" = 1 ] && return 0
  local u
  for u in "${SYSTEM_SERVICES[@]}"; do systemctl is-active --quiet "$u" 2>/dev/null && systemctl stop --no-block "$u" 2>/dev/null; done
  return 0
}
close_apps() {
  [ "${LOCKQZ_NO_KILL:-0}" = 1 ] && return 0   # tests on a shared machine: never signal real processes
  _kill_list "AI app" "${AI_APPS[@]}"
  _kill_list "local-model" "${LOCAL_MODEL_PROCS[@]}"; _kill_cmd_res "${LOCAL_MODEL_CMD_RES[@]}"
  _kill_list "VPN" "${VPN_APPS[@]}"; _kill_list "VM" "${VM_APPS[@]}"
  _kill_list "remote-desktop" "${REMOTE_APPS[@]}"; _kill_list "overlay" "${OVERLAY_APPS[@]}"
  # WireGuard / OpenVPN interfaces brought up by a tool that is now gone: take them down too.
  if [ "$DRYRUN" != "1" ] && command -v ip >/dev/null 2>&1; then
    local i
    for i in $(ip -o link show 2>/dev/null | awk -F': ' '{print $2}' | grep -E '^(wg|tun|tap|proton|nordlynx|tailscale|warp|ts)[0-9]*$' || true); do
      ip link set "$i" down 2>/dev/null || true
    done
  fi
}

# --- firewall (nftables, iptables fallback) ---
DOH_V4=(1.1.1.1 1.0.0.1 8.8.8.8 8.8.4.4 9.9.9.9 9.9.9.10 9.9.9.11 149.112.112.112 149.112.112.10 149.112.112.11 162.159.61.3 162.159.61.4 172.64.41.3 172.64.41.4 146.112.41.2
        94.140.14.0/23 194.242.2.2 194.242.2.3 194.242.2.4 76.76.2.0/24 76.76.10.0/24 149.112.121.10 149.112.122.10 185.71.138.138 223.5.5.5 223.6.6.6 1.12.12.12 120.53.53.53
        45.90.28.0/22 185.228.168.0/23 208.67.222.222 208.67.220.220 208.67.222.123 208.67.220.123 185.222.222.222 45.11.45.11 101.101.101.101 101.102.103.104
        193.110.81.0 185.253.5.0 77.88.8.8 77.88.8.1 156.154.70.1 156.154.71.1 64.6.64.6 64.6.65.6 76.223.122.150 76.223.118.150)   # Cloudflare, Google, Quad9, OpenDNS, AdGuard, Mullvad, Control D, CIRA, Wikimedia, AliDNS, DNSPod, NextDNS, CleanBrowsing, dns.sb, Quad101, dns0, Yandex, Neustar/Verisign, Alekberg
DOH_V6=(2606:4700:4700::1111 2606:4700:4700::1001 2001:4860:4860::8888 2001:4860:4860::8844 2620:fe::fe 2620:fe::9 2620:fe::10 2620:fe::11 2620:fe::fe:10 2620:fe::fe:11 2803:f800:53::3 2803:f800:53::4
        2a06:98c1:52::3 2a06:98c1:52::4 2620:119:fc::2 2620:119:35::35 2620:119:53::53 2a10:50c0::/29 2a07:e340::2 2a07:e340::3 2606:1a40::11 2620:10a:80bb::10 2620:10a:80bc::10
        2001:67c:930::1 2400:3200::1 2400:3200:baba::1 2a07:a8c0::/32 2a07:a8c1::/32 2a0d:2a00:1::/48 2a0d:2a00:2::/48 2a09::/128 2a11::/128 2a0f:fc80::/128 2a0f:fc81::/128 2001:678:8::/128 2a04:e4c0:10::2 2a04:e4c0:11::2)
MODEL_PORTS="11434, 1234, 4891, 1337, 7860"
LOCAL_MODEL_PORTS="8080, 5000, 8000"
VPN_UDP="51820, 1194, 500, 4500"
_join() { local IFS=,; echo "$*"; }
resolved_stub() { grep -qE '^nameserver 127\.0\.0\.5[34]' /etc/resolv.conf 2>/dev/null && id -u systemd-resolve >/dev/null 2>&1; }
nft_ruleset() {
  local dns53=""
  # With systemd-resolved, only the stub (which honours /etc/hosts) may speak DNS: a program that asks another
  # server directly (dig @1.1.1.1, curl --doh-url to an unlisted resolver, --host-resolver-rules, a container) gets nothing.
  local ruid
  if resolved_stub; then ruid="$(id -u systemd-resolve 2>/dev/null)"; dns53="    meta skuid != { 0, $ruid } udp dport 53 drop
    meta skuid != { 0, $ruid } tcp dport 53 drop"; fi   # root = LOCKqz's own warm-list resolver (a student with sudo is admin: accepted)
  cat <<EOF
table inet $NFT_TABLE {
  set lq_warm4 { type ipv4_addr; }
  set lq_warm6 { type ipv6_addr; }
  set lq_api4 { type ipv4_addr; }
  set lq_api6 { type ipv6_addr; }
  chain output {
    type filter hook output priority 0; policy accept;
    tcp dport 853 drop
    udp dport 853 drop
$dns53
    ip daddr { $(_join "${DOH_V4[@]}") } tcp dport 443 drop
    ip daddr { $(_join "${DOH_V4[@]}") } udp dport 443 drop
    ip6 daddr { $(_join "${DOH_V6[@]}") } tcp dport 443 drop
    ip6 daddr { $(_join "${DOH_V6[@]}") } udp dport 443 drop
    tcp dport { $MODEL_PORTS } drop
    ip daddr { 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } tcp dport { $LOCAL_MODEL_PORTS } drop
    ip6 daddr { ::1, fc00::/7, fe80::/10 } tcp dport { $LOCAL_MODEL_PORTS } drop
    udp dport { $VPN_UDP } drop
    tcp dport 1194 drop
    ip daddr @lq_warm4 udp dport 443 drop
    ip6 daddr @lq_warm6 udp dport 443 drop
    ip daddr @lq_api4 tcp dport 443 drop
    ip6 daddr @lq_api6 tcp dport 443 drop
    ip daddr @lq_api4 udp dport 443 drop
    ip6 daddr @lq_api6 udp dport 443 drop
  }
}
EOF
}
fw_on() {
  if command -v nft >/dev/null 2>&1; then
    nft delete table inet "$NFT_TABLE" 2>/dev/null || true
    if nft_ruleset | nft -f - 2>/dev/null; then return 0; fi
    say "nftables refused the ruleset - trying iptables"
  fi
  if command -v iptables >/dev/null 2>&1; then
    iptables -N LOCKQZ 2>/dev/null || iptables -F LOCKQZ
    iptables -C OUTPUT -j LOCKQZ 2>/dev/null || iptables -I OUTPUT -j LOCKQZ
    iptables -A LOCKQZ -p tcp --dport 853 -j DROP; iptables -A LOCKQZ -p udp --dport 853 -j DROP
    local a
    for a in "${DOH_V4[@]}"; do iptables -A LOCKQZ -d "$a" -p tcp --dport 443 -j DROP; iptables -A LOCKQZ -d "$a" -p udp --dport 443 -j DROP; done
    iptables -A LOCKQZ -p tcp -m multiport --dports "${MODEL_PORTS// /}" -j DROP
    for a in 127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16; do iptables -A LOCKQZ -d "$a" -p tcp -m multiport --dports "${LOCAL_MODEL_PORTS// /}" -j DROP; done
    iptables -A LOCKQZ -p udp -m multiport --dports "${VPN_UDP// /}" -j DROP; iptables -A LOCKQZ -p tcp --dport 1194 -j DROP
    if command -v ip6tables >/dev/null 2>&1; then
      ip6tables -N LOCKQZ 2>/dev/null || ip6tables -F LOCKQZ
      ip6tables -C OUTPUT -j LOCKQZ 2>/dev/null || ip6tables -I OUTPUT -j LOCKQZ
      ip6tables -A LOCKQZ -p tcp --dport 853 -j DROP; ip6tables -A LOCKQZ -p udp --dport 853 -j DROP
      for a in "${DOH_V6[@]}"; do ip6tables -A LOCKQZ -d "$a" -p tcp --dport 443 -j DROP; ip6tables -A LOCKQZ -d "$a" -p udp --dport 443 -j DROP; done
      ip6tables -A LOCKQZ -p tcp -m multiport --dports "${MODEL_PORTS// /}" -j DROP
    fi
    return 0
  fi
  return 1
}
fw_off() {
  if command -v nft >/dev/null 2>&1; then nft delete table inet "$NFT_TABLE" 2>/dev/null || true; fi
  if command -v iptables >/dev/null 2>&1; then
    iptables -D OUTPUT -j LOCKQZ 2>/dev/null || true; iptables -F LOCKQZ 2>/dev/null || true; iptables -X LOCKQZ 2>/dev/null || true
    ip6tables -D OUTPUT -j LOCKQZ 2>/dev/null || true; ip6tables -F LOCKQZ 2>/dev/null || true; ip6tables -X LOCKQZ 2>/dev/null || true
  fi
  if command -v nft >/dev/null 2>&1; then nft list table inet "$NFT_TABLE" >/dev/null 2>&1 && return 1; fi
  return 0
}

# --- warm connections (28 Oct 2026): connections already open to AI hosts are cut at lock ---
# The address list is resolved in the background by browser-policy.py's resolver helper (raw DNS to the
# upstream servers, past /etc/hosts and the systemd-resolved stub), at most every 12 h.
_age() { local m; m=$(stat -c %Y "$1" 2>/dev/null); case "$m" in ''|*[!0-9]*) m=0;; esac; echo $(( $(date +%s) - m )); }
warm_apply() {
  if [ -s "$WARM_IPS" ]; then
    if command -v nft >/dev/null 2>&1; then
      local v4 v6
      v4=$(grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}$' "$WARM_IPS" | paste -sd, -); v6=$(grep ':' "$WARM_IPS" | paste -sd, -)
      [ -n "$v4" ] && nft add element inet "$NFT_TABLE" lq_warm4 "{ $v4 }" 2>/dev/null
      [ -n "$v6" ] && nft add element inet "$NFT_TABLE" lq_warm6 "{ $v6 }" 2>/dev/null
      if [ -s "$WARM_IPS.api" ]; then   # API-only AI endpoints: dropped outright (see browser-policy.py resolve)
        v4=$(grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}$' "$WARM_IPS.api" | paste -sd, -); v6=$(grep ':' "$WARM_IPS.api" | paste -sd, -)
        [ -n "$v4" ] && nft add element inet "$NFT_TABLE" lq_api4 "{ $v4 }" 2>/dev/null
        [ -n "$v6" ] && nft add element inet "$NFT_TABLE" lq_api6 "{ $v6 }" 2>/dev/null
      fi
    fi
    if [ ! -f "$STATE/warm.killed" ] || [ "$WARM_IPS" -nt "$STATE/warm.killed" ]; then
      if command -v ss >/dev/null 2>&1; then
        local ip
        while read -r ip; do
          [ -z "$ip" ] && continue
          case "$ip" in *:*) ss -K dst "[$ip]" >/dev/null 2>&1 ;; *) ss -K dst "$ip" >/dev/null 2>&1 ;; esac
        done < "$WARM_IPS"
      fi
      touch "$STATE/warm.killed"
    fi
  fi
  if [ ! -s "$WARM_IPS" ] || [ "$(_age "$WARM_IPS")" -gt "$WARM_MAX_AGE" ]; then
    if [ ! -f "$WARM_IPS.refreshing" ] || [ "$(_age "$WARM_IPS.refreshing")" -gt 600 ]; then
      touch "$WARM_IPS.refreshing"
      # Its own session (setsid): it outlives this lock pass and the helper's subprocess timeout.
      setsid bash -c 'python3 "$1" resolve "$2" "$3"; rm -f "$3.refreshing"' _ "$POLICY" "$BLOCKLIST" "$WARM_IPS" >/dev/null 2>&1 < /dev/null &
    fi
  fi
  return 0
}
warm_clear() { rm -f "$STATE/warm.killed" 2>/dev/null; }

policy() { [ -f "$POLICY" ] || return 0; /usr/bin/env python3 "$POLICY" "$1" 2>/dev/null; }
flush_dns() {
  resolvectl flush-caches 2>/dev/null || systemd-resolve --flush-caches 2>/dev/null || true
  command -v nscd >/dev/null 2>&1 && nscd -i hosts 2>/dev/null || true
}
write_status() { mkdir -p "$STATE"; printf '{"state":"%s","at":"%s","host":"%s"}\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(hostname)" > "$STATUS"; }

do_lock() {
  need_root
  if [ "$DRYRUN" = "1" ]; then
    say "[dry-run] would blackhole $(domains_from "$BLOCKLIST" | wc -l | tr -d ' ') domains, load nftables, flush DNS, write browser policies, close AI apps."
    close_apps; return 0
  fi
  local already=0 rc=0; is_locked && already=1
  mkdir -p "$STATE"; [ -f "$BACKUP" ] || cp "$HOSTS" "$BACKUP" 2>/dev/null || true
  chattr -i "$HOSTS" 2>/dev/null || true
  hosts_add_block "$HOSTS" "$BLOCKLIST" || rc=1
  is_locked || rc=1
  fw_on || rc=1
  policy lock || rc=1
  [ "$already" = 0 ] && { flush_dns; stop_services; }
  close_apps
  warm_apply
  write_status locked
  [ "$already" = 1 ] || say "LOCKED. AI domains blackholed; firewall up; browser AI off; AI, VPN, VM, remote-desktop, overlay and messaging apps closed."
  return $rc
}
do_unlock() {
  need_root
  if [ "$DRYRUN" = "1" ]; then say "[dry-run] would remove the hosts block, the firewall table and the browser policies."; return 0; fi
  local rc=0
  chattr -i "$HOSTS" 2>/dev/null || true
  hosts_remove_block "$HOSTS" || rc=1
  is_locked && rc=1
  fw_off || rc=1
  policy unlock || rc=1
  warm_clear
  flush_dns
  write_status unlocked
  [ "$rc" = 0 ] && say "UNLOCKED." || say "UNLOCK INCOMPLETE (a layer is still in place; will retry)."
  return $rc
}
do_status() {
  if is_locked; then say "LOCKED"; else say "unlocked"; fi
  [ -f "$STATUS" ] && cat "$STATUS"
  return 0
}

case "${1:-}" in
  lock) do_lock ;;
  unlock) do_unlock ;;
  status) do_status ;;
  *) echo "usage: lockqz.sh lock|unlock|status"; exit 2 ;;
esac
