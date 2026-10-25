# Remove LOCKqz from this PC. Run elevated.
$ErrorActionPreference = "SilentlyContinue"
$Dest = "$env:ProgramData\LOCKqz"

# STOP the watchers FIRST, so nothing re-locks after we strip the block.
foreach ($t in @("LOCKqz","LOCKqz Agent")) { Stop-ScheduledTask -TaskName $t; Unregister-ScheduledTask -TaskName $t -Confirm:$false }
# Kill any running helper/agent (Win PowerShell 5.1 has no Get-Process .CommandLine, so use CIM).
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like "*lockqzd.ps1*" -or $_.CommandLine -like "*lockqz-agent.ps1*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
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
  # Keep the scripts (the tasks are already gone, nothing re-locks) so the cleanup can be run again.
  Write-Host "LOCKqz: the AI block could not be fully removed. Restart the computer and remove LOCKqz again."
  exit 1
}

Remove-Item -Recurse -Force $Dest
Write-Host "LOCKqz removed."
