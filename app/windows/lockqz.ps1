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
$AiApps = @("chatgpt","claude","copilot","perplexity","ollama","lmstudio","gpt4all","msty","cluely","jan","dia","comet","atlas","opera","notion ai")
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
    $lines += "0.0.0.0 $d"
    if ($d -like "*.*" -and $d -notlike "www.*") { $lines += "0.0.0.0 www.$d" }
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
  "LOCKqz: LOCKED"
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
  if (Test-Path $Policy) { & powershell -ExecutionPolicy Bypass -File $Policy unlock | Out-Null }
  "LOCKqz: UNLOCKED"
}

switch ($cmd) {
  "lock"   { Do-Lock }
  "unlock" { Do-Unlock }
  "status" { if (Is-Locked) { "LOCKqz: LOCKED" } else { "LOCKqz: unlocked" } }
}
