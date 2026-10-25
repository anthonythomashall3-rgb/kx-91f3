# Real-machine test of the Microsoft Store (MSIX) build on the GitHub Windows runner, as admin.
# Builds + test-signs the package, installs it, launches it INSIDE the package the way the Start
# menu does, then checks: helper installed with store mode, daemon answering, LOCK/UNLOCK, update
# from a newer Store package (no download), Remove button, and a store-listing screenshot.
param([string]$Shot = "$env:TEMP\lqmsix\screenshot.png")
$ErrorActionPreference = "Continue"
$fail = 0
function Check($name, $cond) { if ($cond) { Write-Host "PASS  $name" } else { Write-Host "FAIL  $name"; $script:fail++ } }
$StoreDir = Join-Path (Split-Path -Parent $PSScriptRoot) "windows\store"
$Dest = "$env:ProgramData\LOCKqz"
$Out = "$env:TEMP\lqmsix\lockqz.msix"

# 1) build + install the package
& powershell -NoProfile -ExecutionPolicy Bypass -File "$StoreDir\build-msix.ps1" -TestSign -Out $Out
Check "package built" (Test-Path $Out)
Add-AppxPackage -Path $Out
$pkg = Get-AppxPackage -Name "LOCKqz.Test"
Check "package installed" ($null -ne $pkg)

# 2) open it from inside the package (what clicking Open in the Store does)
$exe = Join-Path $pkg.InstallLocation "LOCKqz.exe"
# Exactly what a student gets: the window opens and sets itself up (no flags).
try { Invoke-CommandInDesktopPackage -PackageFamilyName $pkg.PackageFamilyName -AppId "LOCKqz" -Command $exe -ErrorAction Stop; $inPkg = $true }
catch { Write-Host "      (Invoke-CommandInDesktopPackage unavailable: $_) - running the exe directly"; $inPkg = $false; Start-Process $exe }
# The launch returns at once: wait until setup has finished (both tasks registered).
function TasksReady { (Get-ScheduledTask -TaskName 'LOCKqz' -ErrorAction SilentlyContinue) -and (Get-ScheduledTask -TaskName 'LOCKqz Agent' -ErrorAction SilentlyContinue) }
for ($i = 0; $i -lt 90 -and -not (TasksReady); $i++) { Start-Sleep 2 }
Check "ran inside the package" $inPkg
Start-Sleep 3
Check "window still open (no crash)" ($null -ne (Get-Process LOCKqz -ErrorAction SilentlyContinue))
Get-Process LOCKqz -ErrorAction SilentlyContinue | Stop-Process -Force
foreach ($f in 'lockqz.ps1','lockqzd.ps1','lockqz-agent.ps1','browser-policy.ps1','blocklist.txt','uninstall.ps1','config.json') { Check "installed $f" (Test-Path "$Dest\$f") }
$cfg = Get-Content "$Dest\config.json" -Raw | ConvertFrom-Json
Check "store mode recorded" ($cfg.store_package -eq "LOCKqz.Test")
Check "api is the live site" ($cfg.api_base -eq "https://lockqz.pages.dev/api")
Check "task LOCKqz (helper)" ($null -ne (Get-ScheduledTask -TaskName 'LOCKqz' -ErrorAction SilentlyContinue))
Check "task LOCKqz Agent" ($null -ne (Get-ScheduledTask -TaskName 'LOCKqz Agent' -ErrorAction SilentlyContinue))

# 3) daemon + lock/unlock
$H = @{ 'X-LOCKqz-Token' = $cfg.token }; $B = 'http://127.0.0.1:8787'; $s = $null
for ($i = 0; $i -lt 30 -and -not $s; $i++) { try { $s = Invoke-RestMethod "$B/status" -Headers $H -TimeoutSec 3 } catch { Start-Sleep 2 } }
Check "daemon answering" ($null -ne $s)
try { Invoke-RestMethod "$B/lock" -Method Post -Headers $H -Body '{"quiz_id":"ci-store","student":"CI"}' -ContentType 'application/json' -TimeoutSec 90 | Out-Null } catch { Write-Host "      lock: $_" }
$hosts = Get-Content "$env:WINDIR\System32\drivers\etc\hosts" -Raw
Check "LOCK puts the block in hosts" ($hosts -match 'LOCKqz START')
try { Invoke-RestMethod "$B/unlock" -Method Post -Headers $H -Body '{"quiz_id":"ci-store"}' -ContentType 'application/json' -TimeoutSec 90 | Out-Null } catch { Write-Host "      unlock: $_" }
$hosts = Get-Content "$env:WINDIR\System32\drivers\etc\hosts" -Raw
Check "UNLOCK cleans hosts" (-not ($hosts -match 'LOCKqz START'))

# 4) update from a newer Store package: copies the package payload, downloads nothing
& powershell -NoProfile -ExecutionPolicy Bypass -File "$StoreDir\build-msix.ps1" -TestSign -Out "$env:TEMP\lqmsix2\lockqz.msix" -VersionOverride "9.9.9"
Add-AppxPackage -Path "$env:TEMP\lqmsix2\lockqz.msix"
$src = Get-Content (Join-Path (Split-Path -Parent $PSScriptRoot) "windows\lockqzd.ps1") -Raw
$lib = [regex]::Match($src, "(?s)\`$SignLib = @'\r?\n(.*?)\r?\n'@").Groups[1].Value
. ([ScriptBlock]::Create($lib))
$tmp = Join-Path $env:TEMP ("lqup-" + [guid]::NewGuid().ToString("N")); New-Item -ItemType Directory $tmp | Out-Null
Set-Content "$tmp\config.json" '{"keep":"me"}'
$env:LOCKQZ_UPDATE_DIR = $tmp
$st = @{ state = "locked" }
Check "store update deferred during a quiz" (-not (LQ-CheckUpdate $st $tmp "store:LOCKqz.Test" "0.3.6"))
$st = @{ state = "unlocked" }
Check "store update applies a newer package" (LQ-CheckUpdate $st $tmp "store:LOCKqz.Test" "0.3.6")
Check "store update copied the helper" (Test-Path "$tmp\lockqzd.ps1")
Check "store update kept config.json" ((Get-Content "$tmp\config.json" -Raw) -match 'keep')
Check "store update no-op when current" (-not (LQ-CheckUpdate $st $tmp "store:LOCKqz.Test" "9.9.9"))
Remove-Item Env:\LOCKQZ_UPDATE_DIR

# 5) screenshot for the Store listing
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Shot) | Out-Null
Start-Process (Join-Path (Split-Path -Parent $Out) "LOCKqz.exe") -ArgumentList "/screenshot", "`"$Shot`"" -Wait
Check "listing screenshot made" (Test-Path $Shot)

# 6) Remove button path, then uninstall the package
$pkg = Get-AppxPackage -Name "LOCKqz.Test"
Start-Process (Join-Path $pkg.InstallLocation "LOCKqz.exe") "/uninstall" -Wait
Start-Sleep 3
Check "Remove: tasks gone" ($null -eq (Get-ScheduledTask -TaskName 'LOCKqz' -ErrorAction SilentlyContinue))
Check "Remove: files gone" (-not (Test-Path "$Dest\lockqzd.ps1"))
Remove-AppxPackage -Package $pkg.PackageFullName
Check "package removed" ($null -eq (Get-AppxPackage -Name "LOCKqz.Test"))

Write-Host ""; Write-Host "store failures: $fail"
if ($fail) { exit 1 } else { exit 0 }
