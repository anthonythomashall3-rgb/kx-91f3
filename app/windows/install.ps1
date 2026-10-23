# LOCKqz Windows installer. Run in an ELEVATED PowerShell from the windows\ folder:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Token <shared> -Api https://<project>.pages.dev/api
# Installs the SYSTEM helper (blocks AI) + the per-user agent (detects the quiz). No extension.
# Uninstall:  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
param([string]$Token, [string]$Api, [string]$Student = "")

$ErrorActionPreference = "Stop"
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host "Run this in an ELEVATED PowerShell (Run as administrator)."; exit 1 }

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dest = "$env:ProgramData\LOCKqz"

# Fall back to an existing config.json next to this script for token/api.
$cfgOld = Join-Path $Here "config.json"
if (-not $Token -and (Test-Path $cfgOld)) { $Token = (Get-Content $cfgOld -Raw | ConvertFrom-Json).token }
if (-not $Api   -and (Test-Path $cfgOld)) { $Api   = (Get-Content $cfgOld -Raw | ConvertFrom-Json).api_base }
if (-not $Token) { $Token = Read-Host "Shared token" }
if (-not $Api)   { $Api   = Read-Host "API base (e.g. https://<project>.pages.dev/api)" }

Write-Host "== installing LOCKqz helper =="
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item (Join-Path $Here "lockqz.ps1")   $Dest -Force
Copy-Item (Join-Path $Here "lockqzd.ps1")  $Dest -Force
Copy-Item (Join-Path $Here "blocklist.txt") $Dest -Force
Copy-Item (Join-Path $Here "browser-policy.ps1") $Dest -Force
Copy-Item (Join-Path $Here "lockqz-agent.ps1") $Dest -Force

$device = "win-" + [guid]::NewGuid().ToString()
$cfg = @{ port=8787; token=$Token; api_base=$Api; device_id=$device;
          student= if ($Student) { $Student } else { $null }; max_minutes=180 }
$cfg | ConvertTo-Json | Set-Content -Path "$Dest\config.json" -Encoding UTF8

# Daemon at boot as SYSTEM.
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Dest\lockqzd.ps1`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName "LOCKqz" -Action $action -Trigger $trigger `
  -Principal $principal -Force | Out-Null

# Per-user agent at every logon (quiz detection + password + live monitor).
$aAction  = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Dest\lockqz-agent.ps1`""
$aTrigger = New-ScheduledTaskTrigger -AtLogOn
$aPrincipal = New-ScheduledTaskPrincipal -GroupId "BUILTIN\Users" -RunLevel Limited
$aSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "LOCKqz Agent" -Action $aAction -Trigger $aTrigger `
  -Principal $aPrincipal -Settings $aSettings -Force | Out-Null

# Start it now.
Start-ScheduledTask -TaskName "LOCKqz"
Start-ScheduledTask -TaskName "LOCKqz Agent"
Start-Sleep -Seconds 2
Write-Host ""
Write-Host "Installed. Device id: $device"
try {
  $s = Invoke-RestMethod -Uri "http://127.0.0.1:8787/status" -Headers @{ "X-LOCKqz-Token" = $Token } -TimeoutSec 4
  Write-Host ("Helper status: " + ($s | ConvertTo-Json -Compress))
} catch { Write-Host "Daemon still starting — re-check http://127.0.0.1:8787/status in a few seconds." }
Write-Host "Done. Open a Brightspace quiz - the agent asks your name once, then locks AI automatically."
