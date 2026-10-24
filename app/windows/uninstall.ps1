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

# Now nothing is running to fight us: restore everything.
& powershell -ExecutionPolicy Bypass -File "$Dest\lockqz.ps1" unlock | Out-Null
& powershell -ExecutionPolicy Bypass -File "$Dest\browser-policy.ps1" unlock | Out-Null

Remove-Item -Recurse -Force $Dest
Write-Host "LOCKqz removed."
