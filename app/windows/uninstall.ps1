# Remove LOCKqz from this PC. Run elevated, or paste the one-line remover in any PowerShell window:
#     irm https://lockqz.com/uninstall.ps1 | iex
# (it asks Windows for administrator rights and continues in a new window).
$ErrorActionPreference = "SilentlyContinue"
$Dest = "$env:ProgramData\LOCKqz"
$Here = if ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { "" }
$FromFile = [bool]$Here   # $false: pasted as "irm ... | iex"
$Site = if ($env:LOCKQZ_SITE) { $env:LOCKQZ_SITE } else { "https://lockqz.pages.dev" }
function Fail([string]$msg) {
  # Run as a file (Inno uninstaller, Store clean-up): exit 1. Pasted as "irm ... | iex": "exit" would
  # close the student's PowerShell window before they can read why, so stop with an error instead.
  Write-Host $msg -ForegroundColor Red
  if ($FromFile) { exit 1 }
  throw "LOCKqz was not removed. $msg"
}
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  if (-not $Here) {
    Write-Host "Removing LOCKqz needs administrator rights. Click Yes on the Windows prompt; it continues in a new window."
    try { Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -NoExit -Command `"irm $Site/uninstall.ps1 | iex`"" -ErrorAction Stop }
    catch { Fail "Windows did not give administrator rights. Open PowerShell with 'Run as administrator' and paste the line again." }
    return
  }
  Fail "Run this in an ELEVATED PowerShell (Run as administrator)."
}

function LQ-StopAll {
  # Every PowerShell (Windows PowerShell or 7, any processor) running a LOCKqz script, and whichever one serves
  # LOCKqz's local address: Windows' HTTP service serves it (the port's owner shows as "System"), so ask that
  # service which process registered http://127.0.0.1:8787/. (Win PowerShell 5.1 has no .CommandLine: CIM.)
  $ids = @{}
  foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'")) {
    $c = [string]$p.CommandLine
    if ($c -like "*lockqzd.ps1*" -or $c -like "*lockqz-boot.ps1*" -or $c -like "*lockqz-agent.ps1*" -or $c -like "*\LOCKqz\lockqz*.ps1*") { $ids[[int]$p.ProcessId] = 1 }
  }
  $q = @(); $ours = $false
  foreach ($l in @(@(netsh http show servicestate view=requestq) + @("END"))) {
    $l = [string]$l
    if ($l -match '^\S') { if ($ours) { foreach ($x in $q) { $ids[[int]$x] = 1 } }; $q = @(); $ours = $false }
    elseif ($l -match '^\s+(\d+)\s*$') { $q += $Matches[1] }
    elseif ($l -match '(?i)^\s+HTTP://127\.0\.0\.1:8787/\s*$') { $ours = $true }
  }
  foreach ($id in @($ids.Keys)) {
    if ($id -eq $PID) { continue }
    $p = Get-Process -Id $id
    if ($p -and (@("powershell", "pwsh") -contains $p.ProcessName)) { Stop-Process -Id $id -Force }
  }
}
# STOP the watchers FIRST, so nothing re-locks after we strip the block. The agent (quiz detection) goes
# for good; the helper's task is switched off (no trigger or restart can start it again meanwhile) until the
# restore below is confirmed.
Stop-ScheduledTask -TaskName "LOCKqz Agent"; Unregister-ScheduledTask -TaskName "LOCKqz Agent" -Confirm:$false
Disable-ScheduledTask -TaskName "LOCKqz" | Out-Null
Stop-ScheduledTask -TaskName "LOCKqz"
LQ-StopAll
Start-Sleep -Seconds 1

# Now nothing is running to fight us: restore everything (hosts, firewall, and every policy value
# exactly as it was before the last quiz). Checked and retried: the folder removed below holds the
# policy backup, so it is only removed once the restore really finished.
$done = $false
for ($i = 0; ($i -lt 3) -and -not $done; $i++) {
  $o = (& powershell -NoProfile -ExecutionPolicy Bypass -File "$Dest\lockqz.ps1" unlock) -join "`n"
  $done = ($o -cmatch "LOCKqz: UNLOCKED") -and -not ($o -match "restore pending") -and -not (Test-Path "$Dest\policy-backup.json")
  if (-not $done) { Start-Sleep -Seconds 2 }
}
if (-not $done -and (Test-Path "$Dest\policy-backup.json")) {
  Copy-Item "$Dest\policy-backup.json" "$env:ProgramData\LOCKqz-policy-backup.json" -Force
  Write-Host "LOCKqz: some browser settings could not be restored; a copy of the originals is in $env:ProgramData\LOCKqz-policy-backup.json"
}
if (-not $done) {
  # Keep the scripts and restart the helper: with no agent nothing locks, and the helper finishes an
  # unfinished unlock by itself (at start and every 15 s), so AI never stays blocked.
  Enable-ScheduledTask -TaskName "LOCKqz" | Out-Null
  Start-ScheduledTask -TaskName "LOCKqz"
  Fail "LOCKqz: the AI block could not be fully removed yet; LOCKqz keeps trying by itself. Restart the computer and remove LOCKqz again."
}
Unregister-ScheduledTask -TaskName "LOCKqz" -Confirm:$false
LQ-StopAll   # once more, now that no task can start anything: nothing of LOCKqz keeps running after removal

# Per-user leftovers: the agent's log in every profile's %APPDATA%\LOCKqz; student.json (the confirmed
# school email + its proof) is KEPT so a reinstall never asks again (never
# through a junction: a planted link must not make this delete anything else).
foreach ($prof in @(Get-CimInstance Win32_UserProfile | Where-Object { -not $_.Special -and $_.LocalPath })) {
  $d = Join-Path $prof.LocalPath "AppData\Roaming\LOCKqz"
  $di = Get-Item -LiteralPath $d -Force
  if (-not $di -or ($di.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
  foreach ($n in "agent.log", "agent.log.1", "setup.json") {
    $f = Get-Item -LiteralPath (Join-Path $d $n) -Force
    if ($f -and -not ($f.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Remove-Item -LiteralPath $f.FullName -Force }
  }
  if (@(Get-ChildItem -LiteralPath $d -Force).Count -eq 0) { Remove-Item -LiteralPath $d -Force }
}

Remove-Item -Recurse -Force $Dest
Remove-Item -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\LOCKqz" -Recurse -Force -ErrorAction SilentlyContinue   # the Installed apps entry
Write-Host "LOCKqz removed."
