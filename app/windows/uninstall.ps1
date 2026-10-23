# Remove LOCKqz from this PC. Run elevated.
$ErrorActionPreference = "SilentlyContinue"
$Dest = "$env:ProgramData\LOCKqz"
& powershell -ExecutionPolicy Bypass -File "$Dest\lockqz.ps1" unlock | Out-Null
& powershell -ExecutionPolicy Bypass -File "$Dest\browser-policy.ps1" unlock | Out-Null
foreach ($t in @("LOCKqz","LOCKqz Agent")) { Stop-ScheduledTask -TaskName $t; Unregister-ScheduledTask -TaskName $t -Confirm:$false }
Get-Process powershell | Where-Object { $_.CommandLine -like "*lockqz-agent*" } | Stop-Process -Force
Remove-Item -Recurse -Force $Dest
Write-Host "LOCKqz removed."
