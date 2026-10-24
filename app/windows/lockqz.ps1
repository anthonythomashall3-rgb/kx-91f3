# LOCKqz Windows blocking engine (strong v1).  Run elevated (admin).
#   powershell -ExecutionPolicy Bypass -File .\lockqz.ps1 lock|unlock|status
# Blackholes AI + DoH domains in the hosts file (all browsers + apps using system
# DNS), adds firewall backup rules, kills AI apps, and (via browser-policy.ps1) turns off
# browser AI, AI search answers and extensions for the quiz only. Fully reversible.
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
$AiApps = @("chatgpt","claude","copilot","perplexity","ollama","lmstudio","gpt4all","msty","cluely","jan","dia","comet","atlas","opera","notion ai","deepseek","poe","mistral","sider","grammarly")
# Non-browser routes to AI or a human helper, all closed during the quiz:
$VmApps     = @("Parallels","prl_vm_app","vmware","vmware-vmx","VirtualBox","VirtualBoxVM","VBoxHeadless","qemu-system-x86_64","qemu-system-aarch64","vmwp","vmms","Docker Desktop","com.docker.backend")
$RemoteApps = @("TeamViewer","AnyDesk","RustDesk","remoting_host","ScreenConnect","ConnectWiseControl","LogMeIn","Splashtop","SRServer","vncserver","winvnc","tvnserver","Parsec","GoToMyPC")
$OverlayApps= @("Cluely","InterviewCoder","Interview Coder","LockedInAI","FinalRound","Ohmni","Sensei","UltraCode","Pieces")
$ModelProcs = @("ollama","llama-server","llamafile","koboldcpp","localai","jan","gpt4all","text-generation-webui","vllm")
$VpnApps    = @("nordvpn","expressvpn","surfshark","protonvpn","mullvad","pia","piaservice","Cloudflare WARP","warp-svc","openvpn","wireguard","windscribe","tunnelbear","hssvpn","cyberghost")
$ModelPorts = @(11434,1234,4891,1337,8080,7860,5000,8000)
$VpnPorts   = @(51820,1194,500,4500)
$FwTag  = "LOCKqz-AI"

function Get-Domains {
  Get-Content $BlockFile | Where-Object { $_ -and -not $_.StartsWith("#") } | ForEach-Object { $_.Trim() }
}
function Is-Locked { (Get-Content $Hosts -Raw) -match [regex]::Escape($MarkStart) }

function Do-Lock {
  if (Is-Locked) { "LOCKqz: already locked"; return }
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  if (-not (Test-Path $Backup)) { Copy-Item $Hosts $Backup -Force }
  $lines = @($MarkStart)
  foreach ($d in Get-Domains) {
    $lines += "0.0.0.0 $d"; $lines += ":: $d"
    if ($d -like "*.*" -and $d -notlike "www.*") { $lines += "0.0.0.0 www.$d"; $lines += ":: www.$d" }
  }
  $lines += $MarkEnd
  Add-Content -Path $Hosts -Value ("`r`n" + ($lines -join "`r`n"))
  ipconfig /flushdns | Out-Null

  # Firewall backup: block DoT (853) + known DoH resolver IPs on 443.
  New-NetFirewallRule -DisplayName "$FwTag-DoT" -Direction Outbound -Action Block -Protocol TCP -RemotePort 853 | Out-Null
  New-NetFirewallRule -DisplayName "$FwTag-DoH" -Direction Outbound -Action Block -Protocol TCP -RemotePort 443 -RemoteAddress 1.1.1.1,1.0.0.1,8.8.8.8,8.8.4.4,9.9.9.9,149.112.112.112 | Out-Null

  # Browser AI + AI search answers + extensions off, Windows Copilot off (quiz only).
  if (Test-Path $Policy) { & powershell -ExecutionPolicy Bypass -File $Policy lock | Out-Null }

  foreach ($a in $AiApps) { Stop-Process -Name $a -Force }
  foreach ($a in ($VmApps + $RemoteApps + $OverlayApps + $ModelProcs + $VpnApps)) { Stop-Process -Name $a -Force }

  # Firewall: block local AI model servers and VPN protocols (backup to closing their apps).
  New-NetFirewallRule -DisplayName "$FwTag-models" -Direction Outbound -Action Block -Protocol TCP -RemotePort $ModelPorts | Out-Null
  New-NetFirewallRule -DisplayName "$FwTag-vpn-udp" -Direction Outbound -Action Block -Protocol UDP -RemotePort $VpnPorts  | Out-Null
  New-NetFirewallRule -DisplayName "$FwTag-vpn-tcp" -Direction Outbound -Action Block -Protocol TCP -RemotePort 1194      | Out-Null

  # Windows built-in AI off for the quiz (Copilot, Recall snapshots, Click to Do) via HKLM policy.
  $wai = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsAI"
  New-Item -Path $wai -Force | Out-Null
  Set-ItemProperty -Path $wai -Name "TurnOffWindowsCopilot" -Value 1 -Type DWord
  Set-ItemProperty -Path $wai -Name "DisableAIDataAnalysis" -Value 1 -Type DWord
  Set-ItemProperty -Path $wai -Name "DisableClickToDo" -Value 1 -Type DWord
  "LOCKqz: LOCKED (AI apps, VPNs, VMs, remote-desktop, overlays and local models closed; Windows Copilot/Recall off)"
}

function Do-Unlock {
  if (Is-Locked) {
    $raw = Get-Content $Hosts -Raw
    $raw = [regex]::Replace($raw, "(?s)\r?\n?" + [regex]::Escape($MarkStart) + ".*?" + [regex]::Escape($MarkEnd), "")
    Set-Content -Path $Hosts -Value $raw.TrimEnd() -NoNewline
    Add-Content -Path $Hosts -Value "`r`n"
    ipconfig /flushdns | Out-Null
  }
  Get-NetFirewallRule -DisplayName "$FwTag-*" | Remove-NetFirewallRule
  $wai = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsAI"
  Remove-ItemProperty -Path $wai -Name "TurnOffWindowsCopilot","DisableAIDataAnalysis","DisableClickToDo" -ErrorAction SilentlyContinue
  if (Test-Path $Policy) { & powershell -ExecutionPolicy Bypass -File $Policy unlock | Out-Null }
  "LOCKqz: UNLOCKED"
}

switch ($cmd) {
  "lock"   { Do-Lock }
  "unlock" { Do-Unlock }
  "status" { if (Is-Locked) { "LOCKqz: LOCKED" } else { "LOCKqz: unlocked" } }
}
