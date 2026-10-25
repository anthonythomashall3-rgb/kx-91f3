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

# Well-known SIDs, never names: "Users"/"Administrators"/"SYSTEM" are translated on non-English
# Windows (Benutzer, Administrateurs, ...) and the English names fail there.
$SidSystem = "S-1-5-18"; $SidAdmins = "S-1-5-32-544"; $SidUsers = "S-1-5-32-545"
function Sid-Name($sid) {
  # Local name of a well-known SID, in the language of this Windows.
  try { return (New-Object System.Security.Principal.SecurityIdentifier($sid)).Translate([System.Security.Principal.NTAccount]).Value } catch { return $sid }
}

Write-Host "== installing LOCKqz helper =="
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
# Only SYSTEM + Administrators may write here; Users get read+execute. Stops a standard user from
# swapping a staged self-update file between its hash check and the move (local privilege escalation).
& icacls "$Dest" /inheritance:r /grant:r "*$($SidSystem):(OI)(CI)F" "*$($SidAdmins):(OI)(CI)F" "*$($SidUsers):(OI)(CI)RX" | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "LOCKqz: could not set permissions on $Dest (icacls exit $LASTEXITCODE) - not installing."; exit 1 }
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
# Repeat so the task restarts even after a clean process exit (RestartCount only covers launch
# failures). A boot trigger's repetition only starts at the NEXT boot, so a second trigger starting
# now repeats every 5 minutes indefinitely from install on. MultipleInstances=IgnoreNew keeps one copy.
$rep = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)).Repetition
$trigger.Repetition = $rep
$tNow = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId (Sid-Name $SidSystem) -LogonType ServiceAccount -RunLevel Highest
# Comes back on its own if it ever stops (crash, kill, self-update restart); no time limit, runs on battery.
$dSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "LOCKqz" -Action $action -Trigger @($trigger, $tNow) `
  -Principal $principal -Settings $dSettings -Force | Out-Null

# Per-user agent at every logon (quiz detection + password + live monitor).
$aAction  = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Dest\lockqz-agent.ps1`""
$aTrigger = New-ScheduledTaskTrigger -AtLogOn
$aPrincipal = New-ScheduledTaskPrincipal -GroupId (Sid-Name $SidUsers) -RunLevel Limited
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
