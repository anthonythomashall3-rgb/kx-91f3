# LOCKqz Windows installer. Run in an ELEVATED PowerShell from the windows\ folder:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Token <shared> -Api https://<project>.pages.dev/api
# Installs the SYSTEM helper (blocks AI) + the per-user agent (detects the quiz). No extension.
# Uninstall:  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#
# ONE-LINE INSTALL (no download, no SmartScreen warning - the $0 path), in an elevated PowerShell:
#     irm https://lockqz.pages.dev/install.ps1 | iex
# With no files next to it, this script fetches the current release from the site, checks the
# release manifest's RSA signature against the key below and every file's SHA-256, then installs.
param([string]$Token, [string]$Api, [string]$Student = "", [string]$StorePackage = "")

$ErrorActionPreference = "Stop"
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host "Run this in an ELEVATED PowerShell (Run as administrator)."; exit 1 }

$Here = if ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { "" }
$Dest = "$env:ProgramData\LOCKqz"
$Site = if ($env:LOCKQZ_SITE) { $env:LOCKQZ_SITE } else { "https://lockqz.pages.dev" }
# LOCKqz release-signing public key (same as windows/update.pub.xml). Releases are signed in CI.
$UpdatePub = '<RSAKeyValue><Modulus>piWuG94l1Cz1wYheWVdCfgcSV3WVMDyacyssa/QBWs0OYVMxmjXhWWrBlJswqfVw2+BAyDhnAQ774tjJENkrN8YP8hAc6CPPP+Nmz4PHhZZNT7kJdHeCSRAlWe+65YO/JN1KvKqjB4OZOp/zEjqTtfVKTKltqVrewNAfqfdhnXp76k1839vLjsIyQGHjfWnTRUX8coRrWWcxEmXUhuByZSaXloYjac0lr/za6P3lo95GHerqWWRwavLLqbIKUeClvRMv9mmts6ijdJRsWnYVSCo0jlJ4RyE8FyFd7XA24wCCVUJv4xhxfvH11zkHwT05K6tb1HZAJvwF8MoCdSyXP2ObtSW8EWt0NejK0KOkJhbiA4umfBpaJmcdECu1OTxGN0VNJHfUPpluDc5OK5qMr4BD1aDvg2xUpWn+sRxdskQPvbL0fC59hhGmkM7dLRat9Q08h2TDdxnVnpcTDjms/ewkWcV1hOiMr8LxliOQpaNDRucB6ZRIcookWq+pzpoL</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>'

# Remote mode: nothing next to this script -> fetch the signed release from the site into $Dest.
if (-not $Here -or -not (Test-Path (Join-Path $Here "lockqzd.ps1"))) {
  Write-Host "== fetching LOCKqz from $Site =="
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $wc = New-Object System.Net.WebClient; $wc.Headers["User-Agent"] = "LOCKqz-install (Windows)"
  $body = $wc.DownloadData("$Site/download/update.json")
  $sig  = [Text.Encoding]::ASCII.GetString($wc.DownloadData("$Site/download/update.sig")).Trim()
  $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider; $rsa.FromXmlString($UpdatePub)
  if (-not $rsa.VerifyData($body, "SHA256", [Convert]::FromBase64String($sig))) { Write-Host "LOCKqz: release signature is INVALID - not installing. Tell your professor."; exit 1 }
  $m = [Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json
  $files = $m.windows.files
  if (-not $files -or -not $files.PSObject.Properties["lockqzd.ps1"]) { Write-Host "LOCKqz: release manifest has no Windows helper - not installing."; exit 1 }
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  $sha = [System.Security.Cryptography.SHA256]::Create()
  foreach ($p in $files.PSObject.Properties) {
    if ($p.Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$' -or ([string]$p.Value) -notmatch '^[0-9a-f]{64}$') { Write-Host "LOCKqz: bad manifest entry - not installing."; exit 1 }
    $data = $wc.DownloadData("$Site/download/windows/$($p.Name)")
    $got = -join ($sha.ComputeHash($data) | ForEach-Object { $_.ToString("x2") })
    if ($got -ne [string]$p.Value) { Write-Host "LOCKqz: $($p.Name) failed its integrity check - not installing."; exit 1 }
    [IO.File]::WriteAllBytes((Join-Path $Dest $p.Name), $data)
  }
  Set-Content -Path (Join-Path $Dest "update.pub.xml") -Value $UpdatePub -Encoding ASCII
  $Here = $Dest
  if (-not $Api)   { $Api = "$Site/api" }
  if (-not $Token) { $Token = "lqz-" + [guid]::NewGuid().ToString("N").Substring(0, 20) }
}

# Fall back to an existing config.json next to this script for token/api.
$cfgOld = Join-Path $Here "config.json"
if (-not $Token -and (Test-Path $cfgOld)) { $Token = (Get-Content $cfgOld -Raw | ConvertFrom-Json).token }
if (-not $Api   -and (Test-Path $cfgOld)) { $Api   = (Get-Content $cfgOld -Raw | ConvertFrom-Json).api_base }
if (-not $Token) { $Token = Read-Host "Shared token" }
if (-not $Api)   { $Api   = Read-Host "API base (e.g. https://<project>.pages.dev/api)" }

Write-Host "== installing LOCKqz helper =="
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
# Only SYSTEM + Administrators may write here; Users get read+execute. Stops a standard user from
# swapping a staged self-update file between its hash check and the move (local privilege escalation).
& icacls "$Dest" /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" "Users:(OI)(CI)RX" | Out-Null
# The .exe installer already unpacks into $Dest and runs this script from there; copying a
# file onto itself throws, so only copy when installing from a separate folder.
if ((Resolve-Path $Here).Path.TrimEnd('\') -ne (Resolve-Path $Dest).Path.TrimEnd('\')) {
  foreach ($f in "lockqz.ps1","lockqzd.ps1","blocklist.txt","browser-policy.ps1","lockqz-agent.ps1","install.ps1","uninstall.ps1","update.pub.xml") {
    Copy-Item (Join-Path $Here $f) $Dest -Force
  }
}

$device = "win-" + [guid]::NewGuid().ToString()
$prevStudent = $null
if (Test-Path "$Dest\config.json") {
  try {
    $prev = Get-Content "$Dest\config.json" -Raw | ConvertFrom-Json
    if ($prev.token)     { $Token  = $prev.token }       # keep the key the running helper already uses
    if ($prev.device_id) { $device = $prev.device_id }   # keep roster continuity
    if ($prev.student)   { $prevStudent = $prev.student }
  } catch { }
}
$cfg = @{ port=8787; token=$Token; api_base=$Api; device_id=$device;
          student= if ($Student) { $Student } elseif ($prevStudent) { $prevStudent } else { $null }; max_minutes=180 }
if ($StorePackage) { $cfg.store_package = $StorePackage }   # Store install: updates come from the Store
$cfg | ConvertTo-Json | Set-Content -Path "$Dest\config.json" -Encoding UTF8

# Daemon at boot as SYSTEM.
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Dest\lockqzd.ps1`""
$trigger = New-ScheduledTaskTrigger -AtStartup
# Repeat the trigger so the task restarts even after a clean process exit (RestartCount only covers
# launch failures). MultipleInstances=IgnoreNew keeps a single running copy.
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)).Repetition
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
# Comes back on its own if it ever stops (crash, kill, self-update restart); no time limit, runs on battery.
$dSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "LOCKqz" -Action $action -Trigger $trigger `
  -Principal $principal -Settings $dSettings -Force | Out-Null

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
} catch { Write-Host "Daemon still starting - re-check http://127.0.0.1:8787/status in a few seconds." }
Write-Host "Done. Open a Brightspace quiz - the agent asks your name once, then locks AI automatically."
