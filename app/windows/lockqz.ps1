# LOCKqz Windows blocking engine (strong v1).  Run elevated (admin).
#   powershell -ExecutionPolicy Bypass -File .\lockqz.ps1 lock|unlock|status
# Blackholes AI + DoH domains in the hosts file (all browsers + apps using system
# DNS), adds firewall backup rules, kills AI apps, and (via browser-policy.ps1) turns off
# browser AI, AI search answers, extensions and Windows Copilot/Recall for the quiz only.
# Fully reversible: browser-policy.ps1 backs up every policy value it changes and puts the
# student's (or their organisation's) own values back at unlock.
# Output contract (read by lockqzd.ps1): the LAST line starts with
#   "LOCKqz: LOCKED"      - the hosts block is really in place
#   "LOCKqz: LOCK FAILED" - it is not (e.g. hosts file not writable)
#   "LOCKqz: UNLOCKED"    - the hosts block is really gone
#   "LOCKqz: UNLOCK FAILED"
param([Parameter(Mandatory=$true)][ValidateSet("lock","unlock","status")]$cmd)
$ErrorActionPreference = "SilentlyContinue"

$Hosts     = "$env:WINDIR\System32\drivers\etc\hosts"
$StateDir  = "$env:ProgramData\LOCKqz"
$Backup    = "$StateDir\hosts.backup"
$MarkStart = "# LOCKqz START - do not edit"
$MarkEnd   = "# LOCKqz END"
$Here      = Split-Path -Parent $MyInvocation.MyCommand.Path
$BlockFile = Join-Path $Here "blocklist.txt"
$Policy    = Join-Path $Here "browser-policy.ps1"
# (no "dia": that name is also the Dia diagram editor; M365Copilot = the Microsoft 365 Copilot app)
$AiApps = @("chatgpt","claude","copilot","perplexity","ollama","lmstudio","LM Studio","gpt4all","msty","cluely","jan","comet","atlas","notion ai","deepseek","poe","mistral","sider","grammarly",
            "AnythingLLM","Chatbox","Cherry Studio","M365Copilot",
            # local-model chat apps (their servers: $ModelProcs)
            "Msty Studio","Backyard AI","Faraday","Sanctum","Open WebUI","Pinokio","Witsy","Reor","ollama app",
            "grok","kimi","qwen",   # xAI / Kimi / Qwen desktop apps
            "codex","doubao","quillbot","highlight","fellou","browseros","raycast")   # OpenAI Codex, Doubao, QuillBot, Highlight AI, AI browsers, Raycast AI
# Non-browser routes to AI or a human helper, all closed during the quiz:
$VmApps     = @("Parallels","prl_vm_app","vmware","vmware-vmx","VirtualBox","VirtualBoxVM","VBoxHeadless","qemu-system-x86_64","qemu-system-aarch64","vmwp","vmms","Docker Desktop","com.docker.backend",
                "WindowsSandbox","WindowsSandboxClient","WindowsSandboxServer","WindowsSandboxRemoteSession","wsl","wslhost","wslrelay")
$RemoteApps = @("TeamViewer","AnyDesk","RustDesk","remoting_host","ScreenConnect","ConnectWiseControl","LogMeIn","Splashtop","SRServer","vncserver","winvnc","tvnserver","Parsec","GoToMyPC",
                "mstsc","msrdc","QuickAssist",
                "PhoneExperienceHost","nxplayer","ZohoAssist",
                "scrcpy","escrcpy","QtScrcpy","Vysor","AirDroid","ApowerMirror","LetsView","AirServer","AnyViewer")   # Phone Link = the phone's apps (and its network) on the PC screen; NoMachine; Zoho Assist
$OverlayApps= @("Cluely","InterviewCoder","Interview Coder","LockedInAI","FinalRound","Ohmni","Sensei","UltraCode","Pieces","Verve AI","Parakeet AI","Beyz AI","Interview Solver")
$ModelProcs = @("ollama","llama-server","llama-cli","llama-run","llamafile","koboldcpp","localai","local-ai","jan","gpt4all","text-generation-webui","vllm",
                "ollama_llama_server","lms","llama-mtmd-cli","koboldcpp_cu12","koboldcpp_nocuda","cortex","cortex-server","open-webui","lmdeploy","text-generation-launcher","lemonade-server","lemonade-app")
# tor = the Tor Browser's network daemon (Tor resolves names remotely, past the hosts block).
$VpnApps    = @("nordvpn","expressvpn","surfshark","protonvpn","mullvad","pia","piaservice","Cloudflare WARP","warp-svc","openvpn","wireguard","windscribe","tunnelbear","hssvpn","cyberghost","tor")
$ModelPorts = @(11434,1234,4891,1337,7860)
# 8080/8000/5000 are also ordinary web ports: blocked only to this PC and private networks (where a
# llama.cpp / vLLM server would run), never to the internet.
$LocalModelPorts = @(8080,5000,8000)
$LocalNets  = @("127.0.0.0/8","10.0.0.0/8","172.16.0.0/12","192.168.0.0/16","169.254.0.0/16","::1","fc00::/7","fe80::/10")
$VpnPorts   = @(51820,1194,500,4500)
# Encrypted-DNS resolvers a browser may already be connected to (IPv4 + IPv6), incl. the
# Firefox (mozilla.cloudflare-dns.com) and Chrome (chrome.cloudflare-dns.com) endpoints.
$DohIps = @("1.1.1.1","1.0.0.1","8.8.8.8","8.8.4.4","9.9.9.9","149.112.112.112",
            "162.159.61.3","162.159.61.4","172.64.41.3","172.64.41.4","146.112.41.2",
            "2606:4700:4700::1111","2606:4700:4700::1001","2001:4860:4860::8888","2001:4860:4860::8844",
            "2620:fe::fe","2620:fe::9","2803:f800:53::3","2803:f800:53::4","2a06:98c1:52::3","2a06:98c1:52::4",
            "2620:119:fc::2",
            # AdGuard, Mullvad, Control D, CIRA Shield, Wikimedia DNS, AliDNS, DNSPod (doh.pub)
            "94.140.14.14","94.140.15.15","2a10:50c0::ad1:ff","2a10:50c0::ad2:ff","194.242.2.2","2a07:e340::2",
            "76.76.2.11","2606:1a40::11","149.112.121.10","149.112.122.10","2620:10a:80bb::10","2620:10a:80bc::10",
            "185.71.138.138","2001:67c:930::1","223.5.5.5","223.6.6.6","2400:3200::1","2400:3200:baba::1",
            "1.12.12.12","120.53.53.53")
$FwTag  = "LOCKqz-AI"
$FwRules = @(
  @{ n = "$FwTag-DoT";     p = @{ Protocol = "TCP"; RemotePort = 853 } },
  @{ n = "$FwTag-DoQ";     p = @{ Protocol = "UDP"; RemotePort = 853 } },
  @{ n = "$FwTag-DoH";     p = @{ Protocol = "TCP"; RemotePort = 443; RemoteAddress = $DohIps } },
  @{ n = "$FwTag-DoH3";    p = @{ Protocol = "UDP"; RemotePort = 443; RemoteAddress = $DohIps } },
  @{ n = "$FwTag-models";  p = @{ Protocol = "TCP"; RemotePort = $ModelPorts } },
  @{ n = "$FwTag-models-local"; p = @{ Protocol = "TCP"; RemotePort = $LocalModelPorts; RemoteAddress = $LocalNets } },
  @{ n = "$FwTag-vpn-udp"; p = @{ Protocol = "UDP"; RemotePort = $VpnPorts } },
  @{ n = "$FwTag-vpn-tcp"; p = @{ Protocol = "TCP"; RemotePort = 1194 } }
)
# Latin-1 maps every byte to one char and back, so a hosts file in any encoding round-trips untouched.
$Latin1 = [Text.Encoding]::GetEncoding(28591)

function Get-Domains {
  Get-Content $BlockFile | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith("#") }
}
function Get-HostsLines($domains) {
  # A path entry (site.com/chat) can't be a hosts entry; browser-policy.ps1 blocks those URLs.
  $lines = @($MarkStart)
  foreach ($d in $domains) {
    if ($d -like "*/*") { continue }
    $lines += "0.0.0.0 $d"; $lines += ":: $d"
    if ($d -like "*.*" -and $d -notlike "www.*") { $lines += "0.0.0.0 www.$d"; $lines += ":: www.$d" }
  }
  $lines += $MarkEnd
  return $lines
}
function Remove-Block([string]$raw) {
  $raw = [regex]::Replace($raw, "(?s)\r?\n?" + [regex]::Escape($MarkStart) + ".*?" + [regex]::Escape($MarkEnd) + "\r?\n?", "")
  return ($raw.TrimEnd() + "`r`n")
}
function Read-Hosts { [IO.File]::ReadAllText($Hosts, $Latin1) }
function Is-Locked { try { (Read-Hosts) -match [regex]::Escape($MarkStart) } catch { $false } }
function Write-Hosts([string]$text, [bool]$append) {
  # Clears a read-only flag for the write and puts it back; $false if the write failed.
  $ro = $false
  try {
    $fi = Get-Item -LiteralPath $Hosts -Force -ErrorAction Stop
    $ro = $fi.IsReadOnly
    if ($ro) { $fi.IsReadOnly = $false }
    if ($append) { [IO.File]::AppendAllText($Hosts, $text, $Latin1) } else { [IO.File]::WriteAllText($Hosts, $text, $Latin1) }
    return $true
  } catch { return $false }
  finally { if ($ro) { try { (Get-Item -LiteralPath $Hosts -Force).IsReadOnly = $true } catch { } } }
}

function Kill-AiAndTools {
  foreach ($a in ($AiApps + $VmApps + $RemoteApps + $OverlayApps + $ModelProcs + $VpnApps)) {
    Stop-Process -Name $a -Force -ErrorAction SilentlyContinue
  }
}
function Ensure-FirewallRules {
  # One rule per name: creates missing ones, collapses duplicates left by an older version.
  $have = @(Get-NetFirewallRule -DisplayName "$FwTag-*" -ErrorAction SilentlyContinue)
  foreach ($r in $FwRules) {
    $same = @($have | Where-Object { $_.DisplayName -eq $r.n })
    if ($same.Count -eq 1) { continue }
    if ($same.Count -gt 1) { $same | Remove-NetFirewallRule -ErrorAction SilentlyContinue }
    $p = $r.p
    New-NetFirewallRule -DisplayName $r.n -Direction Outbound -Action Block @p | Out-Null
  }
}
function Policy($verb) {
  if (-not (Test-Path $Policy)) { return "" }
  return ((& powershell -NoProfile -ExecutionPolicy Bypass -File $Policy $verb) -join "`n")
}
function Do-Lock {
  if (Is-Locked) {
    Kill-AiAndTools
    # Policies removed by hand mid-quiz -> put them back (browser-policy keeps the first backup).
    if ((Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Google\Chrome").LOCKqzManaged -ne 1) { Policy "lock" | Out-Null }
    "LOCKqz: LOCKED (re-applied, apps re-closed)"; return
  }
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  if (-not (Test-Path $Backup)) { Copy-Item $Hosts $Backup -Force }
  $wrote = Write-Hosts ("`r`n" + ((Get-HostsLines (Get-Domains)) -join "`r`n") + "`r`n") $true
  ipconfig /flushdns | Out-Null

  # Firewall backup: DoT/DoQ + known DoH resolvers, local AI model servers, VPN protocols.
  Ensure-FirewallRules

  # Browser AI + AI search answers + extensions off, Windows Copilot/Recall/Click to Do off (quiz only).
  $pol = Policy "lock"

  Kill-AiAndTools
  if ($pol -match "FAILED") { "LOCKqz: browser policy not applied ($pol)" }
  if ($wrote -and (Is-Locked)) { "LOCKqz: LOCKED (AI apps, VPNs, VMs, remote-desktop, overlays and local models closed; Windows Copilot/Recall off)" }
  else { "LOCKqz: LOCK FAILED (the hosts file could not be written)" }
}

function Do-Unlock {
  $wrote = $true
  # The professor's per-quiz assistive-tool allowance ends with the lock (every unlock path runs here).
  Remove-Item -LiteralPath "$StateDir\assist.json" -Force -ErrorAction SilentlyContinue
  if (Is-Locked) {
    $wrote = Write-Hosts (Remove-Block (Read-Hosts)) $false
    ipconfig /flushdns | Out-Null
  }
  Get-NetFirewallRule -DisplayName "$FwTag-*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  # Restores exactly the policy values that were there before the quiz (nothing if none were changed).
  $pol = Policy "unlock"
  if ($pol -match "incomplete") { "LOCKqz: policy restore pending ($pol)" }
  if ($wrote -and -not (Is-Locked)) { "LOCKqz: UNLOCKED" } else { "LOCKqz: UNLOCK FAILED (the hosts file could not be written)" }
}

switch ($cmd) {
  "lock"   { Do-Lock }
  "unlock" { Do-Unlock }
  "status" { if (Is-Locked) { "LOCKqz: LOCKED" } else { "LOCKqz: unlocked" } }
}
