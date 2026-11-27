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
$env:LOCKQZ_NO_BROWSER = "1"   # the installer ends by opening the pay page; no browser on a build machine (and -Wait waits for the whole tree)
$p = Start-Process -FilePath $Exe -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/LOG=install.log' -Wait -PassThru
Check "installer exit code 0" ($p.ExitCode -eq 0)
$Dest = "$env:ProgramData\LOCKqz"
foreach ($f in 'lockqz.ps1','lockqzd.ps1','lockqz-boot.ps1','lockqz-agent.ps1','browser-policy.ps1','blocklist.txt','config.json','rules-catalog.json') { Check "installed $f" (Test-Path "$Dest\$f") }
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
# Every firewall rule the engine names exists exactly once, by the cmdlet and in the rules' registry key (the
# quick look the engine takes on every pass).
$fwWant = @([regex]::Matches((Get-Content "$Dest\lockqz.ps1" -Raw), '@\{ n = "\$FwTag-([A-Za-z0-9-]+)"') | ForEach-Object { "LOCKqz-AI-" + $_.Groups[1].Value })
$fwHave = @(Get-NetFirewallRule -DisplayName 'LOCKqz-AI-*' -ErrorAction SilentlyContinue | ForEach-Object { $_.DisplayName })
$fwReg = @(); $fwKey = Get-Item 'HKLM:\SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\FirewallRules'
foreach ($vn in $fwKey.GetValueNames()) { $d = [string]$fwKey.GetValue($vn); if ($d -match 'LOCKqz-AI') { $m = [regex]::Match($d, '\|Name=([^|]*)\|'); $fwReg += $m.Groups[1].Value } }
Write-Host ("INFO  firewall rules wanted: " + ($fwWant -join ', '))
Write-Host ("INFO  firewall rules by the cmdlet: " + (($fwHave | Sort-Object) -join ', '))
Write-Host ("INFO  firewall rules in the registry key: " + (($fwReg | Sort-Object) -join ', '))
$fwSample = @($fwKey.GetValueNames() | ForEach-Object { [string]$fwKey.GetValue($_) } | Where-Object { $_ -match 'LOCKqz-AI' } | Select-Object -First 1)
if ($fwSample.Count) { Write-Host ("INFO  one rule as stored: " + $fwSample[0].Substring(0, [math]::Min(170, $fwSample[0].Length))) }
Check "every engine firewall rule exists once ($($fwWant.Count) rules)" (($fwWant.Count -ge 6) -and (@($fwWant | Where-Object { $w = $_; @($fwHave | Where-Object { $_ -eq $w }).Count -ne 1 }).Count -eq 0))
Check "the registry key shows the same rules (the engine's quick look)" (@($fwWant | Where-Object { $w = $_; @($fwReg | Where-Object { $_ -eq $w }).Count -ne 1 }).Count -eq 0)
# One lock pass of the kind that repeats every few seconds during a quiz (the engine itself, timed), and the
# engine's own "is it locked" look that goes with it.
$env:LOCKQZ_TIMING = "1"
$sw = [Diagnostics.Stopwatch]::StartNew(); $rp = & powershell -NoProfile -ExecutionPolicy Bypass -File "$Dest\lockqz.ps1" lock 2>&1; $sw.Stop()
$env:LOCKQZ_TIMING = $null
$rp | Where-Object { "$_" -match '^TIMING' } | ForEach-Object { Write-Host "INFO  repeat $_" }
Write-Host ("INFO  repeat lock pass took {0:N1} s" -f $sw.Elapsed.TotalSeconds)
$sw2 = [Diagnostics.Stopwatch]::StartNew(); & powershell -NoProfile -ExecutionPolicy Bypass -File "$Dest\lockqz.ps1" status | Out-Null; $sw2.Stop()
Write-Host ("INFO  status look took {0:N1} s" -f $sw2.Elapsed.TotalSeconds)
Check "the repeat lock pass takes under 15 s on this test machine" ($sw.Elapsed.TotalSeconds -lt 15)

# 4) UNLOCK
$r = Invoke-RestMethod "$B/unlock" -Method Post -Headers $H -Body '{"quiz_id":"ci-test"}' -ContentType 'application/json' -TimeoutSec 90
Check "unlock accepted" ($r.state -eq 'unlocked')
$hosts = Get-Content "$env:WINDIR\System32\drivers\etc\hosts" -Raw
Check "hosts file clean" (-not ($hosts -match 'LOCKqz START'))
# Where a first lock and an unlock spend their time (the engine itself, each step timed; printed for the record).
# The helper is kept out of this hand-driven lock and unlock: it clears a block it did not start within seconds,
# which would run a second unlock beside the timed one.
foreach ($t in 'LOCKqz','LOCKqz Agent') { Disable-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue | Out-Null; Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
$up = $true; try { Invoke-RestMethod "$B/status" -Headers $H -TimeoutSec 3 | Out-Null } catch { $up = $false }
Write-Host "INFO  helper answering during the timed part: $up"
$env:LOCKQZ_TIMING = "1"
$timed = @{}
foreach ($c in 'lock','unlock') {
  $sw = [Diagnostics.Stopwatch]::StartNew(); $out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$Dest\lockqz.ps1" $c 2>&1; $sw.Stop()
  $out | Where-Object { "$_" -match '^TIMING' } | ForEach-Object { Write-Host "INFO  $c $_" }
  $out | Where-Object { "$_" -match '^LOCKqz' } | ForEach-Object { Write-Host ("INFO  $c says: " + ("$_").Substring(0, [math]::Min(150, ("$_").Length))) }
  Write-Host ("INFO  engine {0} took {1:N1} s in all" -f $c, $sw.Elapsed.TotalSeconds)
  $timed[$c] = ($out | ForEach-Object { "$_" }) -join "`n"
}
$env:LOCKQZ_TIMING = $null
Check "the timed lock applied the browser policy (run beside the other steps)" (($timed['lock'] -match 'LOCKqz: LOCKED') -and -not ($timed['lock'] -match 'not applied|FAILED'))
Check "the timed unlock put every policy back in one go (run beside the other steps)" (($timed['unlock'] -match 'LOCKqz: UNLOCKED') -and -not ($timed['unlock'] -match 'pending|incomplete'))
Check "no LOCKqz policy mark left in the registry" ($null -eq (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Google\Chrome' -Name 'LOCKqzManaged' -ErrorAction SilentlyContinue))
# Exam rules (27 Nov 2026) on a real Windows PC (Windows PowerShell 5.1, the helper still stopped): the professor's rules
# as the helper keeps them (rules.json) become this exam's lists - a blocked row's site in the hosts file, Chrome opening
# only the open sites, a program the professor typed closed - and all of it goes at the unlock.
$rj = '{"quiz_id":"ci-rules","quiz_host":"usc.brightspace.com","rules":{"label":"Notes only","allow":["investopedia.com"],"block":["lqtyped"],"b":["solvers","text","chat","email","calls","social","homework","writing","translate","search","wiki","web"]}}'
[IO.File]::WriteAllText("$Dest\rules.json", $rj, (New-Object Text.UTF8Encoding($false)))
$tp = $null; try { Copy-Item "$env:WINDIR\System32\PING.EXE" "$env:TEMP\lqtyped.exe" -Force; $tp = Start-Process "$env:TEMP\lqtyped.exe" -ArgumentList "-t", "127.0.0.1" -PassThru -WindowStyle Hidden; Start-Sleep -Seconds 1 } catch { }
$out = (& powershell -NoProfile -ExecutionPolicy Bypass -File "$Dest\lockqz.ps1" lock 2>&1 | ForEach-Object { "$_" }) -join "`n"
$hosts = Get-Content "$env:WINDIR\System32\drivers\etc\hosts" -Raw
$el = @(Get-Content "$Dest\exam-blocklist.txt" -ErrorAction SilentlyContinue)
Check "rules: locked with this exam's lists ($($el.Count) entries)" (($out -match 'LOCKqz: LOCKED') -and (Test-Path "$Dest\exam.json") -and (Test-Path "$Dest\exam-apps.txt") -and ($el.Count -gt 900))
Check "rules: a blocked row's site is in the hosts file (zoom.us)" ($hosts -match '(?m)^0\.0\.0\.0 zoom\.us\r?$')
Check "rules: an allowed row's entries leave the list (YouTube), the AI list stays" ((-not ($el -contains 'youtube.com/watch')) -and ($el -contains 'chatgpt.com'))
$ck = 'HKLM:\SOFTWARE\Policies\Google\Chrome'
$cb = @((Get-Item "$ck\URLBlocklist").GetValueNames() | ForEach-Object { (Get-ItemProperty "$ck\URLBlocklist").$_ })
$ca = @((Get-Item "$ck\URLAllowlist").GetValueNames() | ForEach-Object { (Get-ItemProperty "$ck\URLAllowlist").$_ })
Check "rules: Chrome blocks every other site, opens Brightspace and the typed site, no translation" (($cb -contains '*') -and ($ca -contains 'brightspace.com') -and ($ca -contains 'investopedia.com') -and ((Get-ItemProperty $ck).TranslateEnabled -eq 0))
if ($tp) { Start-Sleep -Milliseconds 500; Check "rules: the program the professor typed is closed" ($tp.HasExited) } else { Write-Host "INFO  rules: typed-program check skipped (the test program did not start)" }
Remove-Item "$Dest\rules.json" -Force -ErrorAction SilentlyContinue
$out = (& powershell -NoProfile -ExecutionPolicy Bypass -File "$Dest\lockqz.ps1" unlock 2>&1 | ForEach-Object { "$_" }) -join "`n"
Check "rules: the unlock clears this exam's lists, the policy and the hosts block" (($out -match 'LOCKqz: UNLOCKED') -and (-not (Test-Path "$Dest\exam.json")) -and (-not ((Get-Content "$env:WINDIR\System32\drivers\etc\hosts" -Raw) -match 'LOCKqz START')) -and ($null -eq (Get-ItemProperty -Path $ck -Name 'LOCKqzManaged' -ErrorAction SilentlyContinue)))
foreach ($t in 'LOCKqz','LOCKqz Agent') { Enable-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue | Out-Null; Start-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 5
$hosts = Get-Content "$env:WINDIR\System32\drivers\etc\hosts" -Raw
Check "hosts file clean after the timed unlock" (-not ($hosts -match 'LOCKqz START'))
Check "firewall rules removed" (@(Get-NetFirewallRule -DisplayName 'LOCKqz-AI-*' -ErrorAction SilentlyContinue).Count -eq 0)
$ip = try { ([System.Net.Dns]::GetHostAddresses('chatgpt.com') | Select-Object -First 1).IPAddressToString } catch { 'unresolved' }
Check "chatgpt.com reachable again ($ip)" ($ip -ne '0.0.0.0' -and $ip -ne 'unresolved')

# 5) backend reachable from Windows PowerShell 5.1 (what students' PCs run)
$api = $cfg.api_base.TrimEnd('/'); if (-not $api.EndsWith('/api')) { $api += '/api' }
$n = powershell -NoProfile -Command "(Invoke-RestMethod '$api/blocklist').domains.Count"
Check "API reachable from PowerShell 5.1 ($n domains)" ([int]$n -ge 20)
$rep = powershell -NoProfile -Command "(Invoke-RestMethod '$api/report' -Method Post -ContentType 'application/json' -Body '{""event"":""heartbeat""}').ok"
Check "report accepted by API" ($rep -match 'True')

# Installed apps: the .exe's own entry (LOCKqz_is1), never a second one from install.ps1
# (the .exe is a 32-bit installer: Windows keeps its entry under WOW6432Node; both views are Installed apps)
$uk = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'; $uk32 = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
$innoKey = (Test-Path "$uk\LOCKqz_is1") -or (Test-Path "$uk32\LOCKqz_is1")
Check "listed once in Installed apps (.exe entry)" ($innoKey -and -not (Test-Path "$uk\LOCKqz") -and -not (Test-Path "$uk32\LOCKqz"))

function Port-Owner {
  # Who listens on the helper's port (empty when nobody): pid, program and command line. Windows' HTTP service owns the
  # port ("System", pid 4) for whoever registered an address on it, so name the registering processes too.
  $c = @(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue) | Select-Object -First 1
  if (-not $c) { return "" }
  $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$c.OwningProcess) -ErrorAction SilentlyContinue
  $o = "pid {0} {1} {2}" -f $c.OwningProcess, $(if ($p) { $p.Name } else { "?" }), $(if ($p) { $p.CommandLine } else { "" })
  if ([int]$c.OwningProcess -eq 4) {
    # Windows' HTTP service: print its request queues (which process registered which address) for the log.
    try { $o += " | " + ((@(netsh http show servicestate view=requestq) | Where-Object { [string]$_ -match '\S' }) -join " / ") } catch { }
    $o += " | PowerShell running a LOCKqz script: " + (@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" | Where-Object { [string]$_.CommandLine -like "*LOCKqz*" } | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }) -join "; ")
  }
  return $o
}
# 6) UNINSTALL
$un = Get-ChildItem $Dest -Filter 'unins*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
Check "uninstaller present" ($null -ne $un)
if ($un) { Start-Process $un.FullName -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -Wait }
Start-Sleep 8
Check "uninstall removed helper task" ($null -eq (Get-ScheduledTask -TaskName 'LOCKqz' -ErrorAction SilentlyContinue))
Check "uninstall removed agent task" ($null -eq (Get-ScheduledTask -TaskName 'LOCKqz Agent' -ErrorAction SilentlyContinue))
$hosts = Get-Content "$env:WINDIR\System32\drivers\etc\hosts" -Raw
Check "hosts clean after uninstall" (-not ($hosts -match 'LOCKqz START'))
$po = ""; for ($i = 0; $i -lt 10; $i++) { $po = Port-Owner; if (-not $po) { break }; Start-Sleep 1 }
Check "nothing of LOCKqz still runs after uninstall (its port is free: $(if ($po) { $po } else { 'yes' }))" (-not $po)
Check "Installed apps entry gone after uninstall" (-not (Test-Path "$uk\LOCKqz_is1") -and -not (Test-Path "$uk32\LOCKqz_is1") -and -not (Test-Path "$uk\LOCKqz"))

if ($fail) { Write-Host "`n$fail CHECK(S) FAILED"; Get-Content install.log -ErrorAction SilentlyContinue | Select-Object -Last 40; exit 1 }
Write-Host "`nALL CHECKS PASSED"
