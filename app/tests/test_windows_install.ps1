# Real-machine test of the Windows installer (runs on the GitHub Windows runner, as admin).
# Installs lockqz-win.exe silently, then checks: files + tasks, daemon, token check, LOCK
# (hosts, DNS, firewall, browser policy), UNLOCK, backend reachable from Windows PowerShell 5.1,
# and a clean UNINSTALL. Exits 1 on any failure.
param([string]$Exe, [string]$Token)
$ErrorActionPreference = "Continue"
$fail = 0
function Check($name, $cond) { if ($cond) { Write-Host "PASS  $name" } else { Write-Host "FAIL  $name"; $script:fail++ } }

# 0) every Windows script parses
Get-ChildItem "$PSScriptRoot\..\windows\*.ps1" | ForEach-Object {
  $errs = $null
  [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$null, [ref]$errs) | Out-Null
  Check "parses: $($_.Name)" ($errs.Count -eq 0)
  $errs | Select-Object -First 3 | ForEach-Object { Write-Host "      $($_.Extent.StartLineNumber): $($_.Message)" }
  # PowerShell 5.1 reads BOM-less scripts as Windows-1252: any non-ASCII byte can corrupt the code.
  Check "plain ASCII: $($_.Name)" (-not ([IO.File]::ReadAllBytes($_.FullName) | Where-Object { $_ -gt 127 } | Select-Object -First 1))
}

# 1) silent install
$p = Start-Process -FilePath $Exe -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/LOG=install.log' -Wait -PassThru
Check "installer exit code 0" ($p.ExitCode -eq 0)
$Dest = "$env:ProgramData\LOCKqz"
foreach ($f in 'lockqz.ps1','lockqzd.ps1','lockqz-boot.ps1','lockqz-agent.ps1','browser-policy.ps1','blocklist.txt','config.json') { Check "installed $f" (Test-Path "$Dest\$f") }
$cfg = Get-Content "$Dest\config.json" -Raw | ConvertFrom-Json
Check "config has its own per-PC control token" ([string]$cfg.token -match "^lqz-[0-9a-f]{20}$")
Check "config device id" ($cfg.device_id -like 'win-*')
Check "task LOCKqz (helper)" ($null -ne (Get-ScheduledTask -TaskName 'LOCKqz' -ErrorAction SilentlyContinue))
Check "task LOCKqz Agent" ($null -ne (Get-ScheduledTask -TaskName 'LOCKqz Agent' -ErrorAction SilentlyContinue))

# 2) daemon answering
$H = @{ 'X-LOCKqz-Token' = $cfg.token }; $B = 'http://127.0.0.1:8787'; $s = $null
for ($i = 0; $i -lt 30 -and -not $s; $i++) { try { $s = Invoke-RestMethod "$B/status" -Headers $H -TimeoutSec 3 } catch { Start-Sleep 2 } }
Check "daemon answering on 127.0.0.1:8787" ($null -ne $s)
Check "starts unlocked" ($s.state -eq 'unlocked')
$rejected = $false; try { Invoke-RestMethod "$B/status" -Headers @{ 'X-LOCKqz-Token' = 'wrong' } -TimeoutSec 3 | Out-Null } catch { $rejected = $true }
Check "rejects a wrong token" $rejected

# 3) LOCK
$r = Invoke-RestMethod "$B/lock" -Method Post -Headers $H -Body '{"quiz_id":"ci-test","student":"CI"}' -ContentType 'application/json' -TimeoutSec 90
Check "lock accepted" ($r.state -eq 'locked')
$hosts = Get-Content "$env:WINDIR\System32\drivers\etc\hosts" -Raw
Check "hosts file has the block" ($hosts -match 'LOCKqz START')
foreach ($d in 'chatgpt.com','claude.ai','gemini.google.com','perplexity.ai') {
  $ip = try { ([System.Net.Dns]::GetHostAddresses($d) | Select-Object -First 1).IPAddressToString } catch { 'unresolved' }
  Check "$d blocked (resolves to $ip)" ($ip -eq '0.0.0.0' -or $ip -eq 'unresolved')
}
Check "firewall rules added" (@(Get-NetFirewallRule -DisplayName 'LOCKqz-AI-*' -ErrorAction SilentlyContinue).Count -ge 2)
Check "Chrome AI policy set" (Test-Path 'HKLM:\SOFTWARE\Policies\Google\Chrome')
Check "Edge AI policy set" (Test-Path 'HKLM:\SOFTWARE\Policies\Microsoft\Edge')
Check "status says locked" ((Invoke-RestMethod "$B/status" -Headers $H).engine_locked)

# 4) UNLOCK
$r = Invoke-RestMethod "$B/unlock" -Method Post -Headers $H -Body '{"quiz_id":"ci-test"}' -ContentType 'application/json' -TimeoutSec 90
Check "unlock accepted" ($r.state -eq 'unlocked')
$hosts = Get-Content "$env:WINDIR\System32\drivers\etc\hosts" -Raw
Check "hosts file clean" (-not ($hosts -match 'LOCKqz START'))
Check "firewall rules removed" (@(Get-NetFirewallRule -DisplayName 'LOCKqz-AI-*' -ErrorAction SilentlyContinue).Count -eq 0)
$ip = try { ([System.Net.Dns]::GetHostAddresses('chatgpt.com') | Select-Object -First 1).IPAddressToString } catch { 'unresolved' }
Check "chatgpt.com reachable again ($ip)" ($ip -ne '0.0.0.0' -and $ip -ne 'unresolved')

# 5) backend reachable from Windows PowerShell 5.1 (what students' PCs run)
$api = $cfg.api_base.TrimEnd('/'); if (-not $api.EndsWith('/api')) { $api += '/api' }
$n = powershell -NoProfile -Command "(Invoke-RestMethod '$api/blocklist').domains.Count"
Check "API reachable from PowerShell 5.1 ($n domains)" ([int]$n -ge 20)
$rep = powershell -NoProfile -Command "(Invoke-RestMethod '$api/report' -Method Post -ContentType 'application/json' -Body '{""event"":""heartbeat""}').ok"
Check "report accepted by API" ($rep -match 'True')

# 6) UNINSTALL
$un = Get-ChildItem $Dest -Filter 'unins*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
Check "uninstaller present" ($null -ne $un)
if ($un) { Start-Process $un.FullName -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -Wait }
Start-Sleep 8
Check "uninstall removed helper task" ($null -eq (Get-ScheduledTask -TaskName 'LOCKqz' -ErrorAction SilentlyContinue))
Check "uninstall removed agent task" ($null -eq (Get-ScheduledTask -TaskName 'LOCKqz Agent' -ErrorAction SilentlyContinue))
$hosts = Get-Content "$env:WINDIR\System32\drivers\etc\hosts" -Raw
Check "hosts clean after uninstall" (-not ($hosts -match 'LOCKqz START'))

if ($fail) { Write-Host "`n$fail CHECK(S) FAILED"; Get-Content install.log -ErrorAction SilentlyContinue | Select-Object -Last 40; exit 1 }
Write-Host "`nALL CHECKS PASSED"
