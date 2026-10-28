# Windows client logic, off-Windows: loads the REAL functions from windows/*.ps1 (by AST, so nothing
# else in the scripts runs) and checks the quiz-ending decisions, the helper's timers and unlock
# reasons, the hosts-file handling, and the browser-policy backup/restore against an in-memory registry.
# Runs on PowerShell 7 (any OS) or Windows PowerShell 5.1. Exit 1 on any failure.
$ErrorActionPreference = "Stop"
$Win = Join-Path $PSScriptRoot "..\windows"
$pass = 0; $fail = 0
function Check($m, $c) { if ($c) { $script:pass++; Write-Host "  ok: $m" } else { $script:fail++; Write-Host "  FAIL: $m" } }
# ======================================================================================
Write-Host "A. agent: quiz page still open? (real Step-Locked / Clean-Title / Get-ActiveTab)"
$agentAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Win "lockqz-agent.ps1"), [ref]$null, [ref]$null)
foreach ($f in @($agentAst.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and @("Url-Path","Url-Query","Is-QuizPath","Is-Quiz","Is-QuizByTitle","Is-Leaving","Lock-Id","Clean-Title","Get-ActiveTab","Test-TitlePresent","Step-Locked","Next-PwCheck","Handle-Pw","Add-Cap") -contains $_.Name })) {
  . ([scriptblock]::Create($f.Extent.Text))
}
$ZW = [string][char]0x200B; $EM = [string][char]0x2014
function W($title, $url, $tabs) { [pscustomobject]@{ Title = $title; Url = $url; Tabs = @($tabs); Proc = "msedge" } }
$qTab = "Quiz 3 - ECON 203 - USC Brightspace"
$qUrl = "https://brightspace.usc.edu/d2l/lms/quizzing/user/attempt/quiz_attempt_page.d2l?ou=98765&qi=12345"
$edgeTitle = "$qTab and 2 more pages - Personal - Microsoft$ZW Edge"
$edgeQuiz = W $edgeTitle $qUrl @($qTab, "Notes - Google Docs", "Lecture 5.pdf")

Check "Edge title (zero-width space) loses ' and N more pages' + 'Microsoft Edge'" ((Clean-Title $edgeTitle) -eq "$qTab - Personal")
Check "Chrome title + profile suffix stripped" ((Clean-Title "$qTab - Google Chrome - Work") -eq $qTab)
Check "Firefox em-dash title stripped" ((Clean-Title "$qTab $EM Mozilla Firefox") -eq $qTab)
Check "Firefox private-window title stripped" ((Clean-Title "$qTab $EM Mozilla Firefox Private Browsing") -eq $qTab)
Check "active tab found from the Edge title" ((Get-ActiveTab $edgeQuiz) -eq $qTab)

$now = Get-Date
$tab = Get-ActiveTab $edgeQuiz; $title = Clean-Title $edgeQuiz.Title
$s = Step-Locked @($edgeQuiz) $edgeQuiz $tab $title $null $now 30
Check "quiz URL on screen -> present" ($s.Present -and -not $s.Reason)
# Student switches to the notes tab in the same Edge window: URL and title now show the notes.
$edgeNotes = W ("Notes - Google Docs and 2 more pages - Personal - Microsoft$ZW Edge") "https://docs.google.com/document/d/x" @($qTab, "Notes - Google Docs", "Lecture 5.pdf")
$s = Step-Locked @($edgeNotes) $null $tab $title $null $now 30
Check "Edge tab switch mid-quiz keeps the lock (quiz tab still open)" ($s.Present -and -not $s.Reason -and -not $s.MissingSince)
$s = Step-Locked @($edgeNotes) $null $tab $title $now $now.AddSeconds(120) 30
Check "... even long after (never a 30 s unlock while the quiz tab is open)" ($s.Present -and -not $s.Reason)
$oldClean = ($edgeTitle -replace " and \d+ more page[s]?","" -replace "\s[-\u2014]\s(Google Chrome|Microsoft.Edge|Microsoft.Edge.*|Brave|Mozilla Firefox|Opera|Vivaldi).*$","")
Check "(regression) the old cleaner left the Edge suffix on" ($oldClean -match "Microsoft")

Write-Host "   adopted lock: no remembered title"
$other = @((W "Lecture 5.pdf - Personal - Microsoft$ZW Edge" "file:///C:/notes/l5.pdf" @("Lecture 5.pdf")), (W "Inbox - Outlook - Google Chrome" "https://outlook.office.com/mail" @("Inbox - Outlook")))
Check "empty title matches no window (old '-like `$null*' matched all)" (-not (Test-TitlePresent $other $null $null))
Check "(regression) old rule '-like `"`$null*`"' matched every window" ((@($other | Where-Object { $_.Title -like "$($null)*" }).Count) -eq 2)
$s1 = Step-Locked $other $null $null $null $null $now 30
Check "adopted lock with no quiz open: grace starts" ((-not $s1.Present) -and $s1.MissingSince -and -not $s1.Reason)
$s2 = Step-Locked $other $null $null $null $s1.MissingSince $now.AddSeconds(31) 30
Check "adopted lock with no quiz open: unlocks after the 30 s grace" ($s2.Reason -eq "quiz_tab_closed")
$s3 = Step-Locked @() $null $null $null $now $now.AddSeconds(10) 30
Check "no unlock inside the grace" (-not $s3.Reason)

Write-Host "   leaving pages are checked BEFORE the title heuristic"
$subUrl = "https://brightspace.usc.edu/d2l/lms/quizzing/user/quiz_submissions_attempt.d2l?ou=98765&qi=12345"
$sub = W "Quizzes - ECON 203 - USC Brightspace - Personal - Microsoft$ZW Edge" $subUrl @("Quizzes - ECON 203 - USC Brightspace")
Check "(the submitted page's title fools the title heuristic)" (Is-QuizByTitle $sub.Title)
$s = Step-Locked @($sub) $null "Quizzes - ECON 203 - USC Brightspace" "Quizzes - ECON 203 - USC Brightspace - Personal" $null $now 30
Check "submitted page -> unlock now (quiz_submitted), even when its title equals the quiz's" ($s.Reason -eq "quiz_submitted")
$list = W "Quizzes - ECON 203 - USC Brightspace - Google Chrome" "https://brightspace.usc.edu/d2l/lms/quizzing/user/quizzes_list.d2l?ou=98765" @("Quizzes - ECON 203 - USC Brightspace")
$s = Step-Locked @($list) $null $qTab $qTab $null $now 30
Check "back to the quiz list -> unlock now (quiz_left)" ($s.Reason -eq "quiz_left")
$s = Step-Locked @($list, $edgeQuiz) $edgeQuiz $qTab $qTab $null $now 30
Check "quiz attempt open in another window wins over a leaving page" ($s.Present -and -not $s.Reason)
$course = W "Content - ECON 203 - Google Chrome" "https://brightspace.usc.edu/d2l/le/content/98765/Home" @("Content - ECON 203")
$s = Step-Locked @($course) $null $qTab $qTab $now $now.AddSeconds(31) 30
Check "navigated elsewhere in Brightspace, past grace -> quiz_left" ($s.Reason -eq "quiz_left")

Write-Host "   fullscreen / odd titles"
$fs = W "$qTab - Google Chrome" "" @()
Check "fullscreen (no address bar) quiz window -> present" ((Step-Locked @($fs) $null $null $null $null $now 30).Present)
$notQuiz = W "Quiz tips | D2L community - Google Chrome" "https://community.d2l.com/tips" @("Quiz tips | D2L community")
Check "a quiz-like title WITH a non-quiz URL does not hold the lock" (-not (Step-Locked @($notQuiz) $null $null $null $null $now 30).Present)
$wild = "[Quiz] 3 * ECON?"
Check "titles with wildcard characters match literally" (Test-TitlePresent @((W "$wild - Google Chrome" "https://x" @())) "" $wild)
Check "Lock-Id from the attempt URL" ((Lock-Id $qUrl) -eq "98765-12345")

# ======================================================================================
Write-Host "B. helper: wall-clock heartbeat, unlock reasons, safety cap (real SignLib / Clamp-Minutes)"
$dsrc = Get-Content (Join-Path $Win "lockqzd.ps1") -Raw
$m = [regex]::Match($dsrc, "(?s)\`$SignLib = @'\r?\n(.*?)\r?\n'@")
. ([ScriptBlock]::Create($m.Groups[1].Value))
$dAst = [System.Management.Automation.Language.Parser]::ParseInput($dsrc, [ref]$null, [ref]$null)
$CapMin = 360
foreach ($f in @($dAst.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and @("Clamp-Minutes","Migrate-ConfText") -contains $_.Name })) { . ([scriptblock]::Create($f.Extent.Text)) }
# Watcher cycles that really take 12 s each (5 s sleep + engine runs): beats must still be <= 120 s apart.
$t = 1700000000; $last = 0; $beats = @()
for ($i = 0; $i -lt 100; $i++) { $t += 12; if (LQ-Due $last $t 120) { $last = $t; $beats += $t } }
$gaps = @(for ($i = 1; $i -lt $beats.Count; $i++) { $beats[$i] - $beats[$i - 1] })
Check "slow 12 s cycles: heartbeat gap never above 132 s (server stale = 420 s)" (($gaps | Measure-Object -Maximum).Maximum -le 132)
Check "(regression) the old 'every 36 cycles' rule would wait 432 s" ((36 * 12) -gt 420)
Check "first beat is due immediately" (LQ-Due 0 $t 120)
Check "a clock set backwards does not stop the heartbeat" (LQ-Due ($t + 5000) $t 120)
$agent = @{ kind = "agent" }; $other = @{ kind = "other" }; $unk = @{ kind = "unknown" }
Check "agent + quiz_submitted -> quiz_submitted" ((LQ-UnlockReason "quiz_submitted" $agent) -eq "quiz_submitted")
Check "agent + quiz_left -> quiz_left" ((LQ-UnlockReason "quiz_left" $agent) -eq "quiz_left")
Check "agent + quiz_tab_closed -> quiz_tab_closed" ((LQ-UnlockReason "quiz_tab_closed" $agent) -eq "quiz_tab_closed")
Check "another local program claiming quiz_submitted -> local_request" ((LQ-UnlockReason "quiz_submitted" $other) -eq "local_request")
Check "no reason -> local_request" ((LQ-UnlockReason $null $agent) -eq "local_request")
Check "made-up reason (cap) from a caller -> local_request" ((LQ-UnlockReason "cap" $agent) -eq "local_request")
Check "process lookup failed: agent reason kept (requester recorded as unknown)" ((LQ-UnlockReason "quiz_left" $unk) -eq "quiz_left")
Check "a /lock asking 100000 min gets the unknown-end cap (6 h), never more" ((Clamp-Minutes 100000) -eq 360)
Check "a /lock may ask for less (60)" ((Clamp-Minutes 60) -eq 60)
Check "missing/0/garbage -> 6 h" (((Clamp-Minutes $null) -eq 360) -and ((Clamp-Minutes 0) -eq 360) -and ((Clamp-Minutes "x") -eq 360))
Check "the helper source has no fixed 3-hour cap any more" ($dsrc -notmatch '\$CapMin = 180')

Write-Host "   round 2: C2 cap from the quiz end, C9 server unlock, C6 install throttle, E1 config move"
$t0 = [int64]1800000000
Check "ISO 'Z' time parsed" ((LQ-ParseIso "2027-01-15T08:00:00.000Z") -eq [int64]1800000000)
Check "garbage / missing time -> 0" (((LQ-ParseIso "soon") -eq 0) -and ((LQ-ParseIso $null) -eq 0))
Check "DateTime (PowerShell 7 JSON) accepted" ((LQ-ParseIso ([DateTime]::SpecifyKind([DateTime]"2027-01-15 08:00:00", "Utc"))) -eq [int64]1800000000)
Check "end known -> cap = end + 15 min" ((LQ-CapForEnd $t0 ($t0 + 3600) ($t0 + 60) 0) -eq ($t0 + 3600 + 900))
Check "a 3-day quiz window -> never more than 24 h" ((LQ-CapForEnd $t0 ($t0 + 259200) ($t0 + 60) 0) -eq ($t0 + 86400))
Check "an end already over is ignored (0 = keep the 6 h cap)" ((LQ-CapForEnd $t0 ($t0 - 3600) ($t0 + 60) 0) -eq 0)
Check "server clock ahead by 100 s is corrected" ((LQ-CapForEnd $t0 ($t0 + 3600) ($t0 + 60) 100) -eq ($t0 + 3500 + 900))
Check "C9: unlock:true quiz_submitted -> quiz_submitted" ((LQ-ServerReason ([pscustomobject]@{ ok = $true; unlock = $true; reason = "quiz_submitted" })) -eq "quiz_submitted")
Check "C9: unlock:true with an odd reason -> quiz_ended" ((LQ-ServerReason ([pscustomobject]@{ unlock = $true; reason = "whatever" })) -eq "quiz_ended")
Check "C9: no unlock field / unlock 'true' as text -> nothing" (($null -eq (LQ-ServerReason ([pscustomobject]@{ ok = $true }))) -and ($null -eq (LQ-ServerReason ([pscustomobject]@{ unlock = "true" }))))
$rec = [pscustomobject]@{ version = "0.4.1"; student = "a@usc.edu"; at = $t0 }
Check "C6: same version + student within 24 h -> no install report" (-not (LQ-InstallDue $rec "0.4.1" "a@usc.edu" ($t0 + 3600)))
Check "C6: new version, new student, 24 h, or no record -> report" ((LQ-InstallDue $rec "0.4.2" "a@usc.edu" ($t0 + 60)) -and (LQ-InstallDue $rec "0.4.1" "b@usc.edu" ($t0 + 60)) -and (LQ-InstallDue $rec "0.4.1" "a@usc.edu" ($t0 + 86400)) -and (LQ-InstallDue $null "0.4.1" "x" $t0))
$oldCfg = '{"port":8787,"token":"lqz-abc","api_base":"https://lockdownqz.pages.dev/api","device_id":"win-1","student":"s"}'
$mc = Migrate-ConfText $oldCfg
Check "E1: lockdownqz api_base moves to lockqz.pages.dev, everything else byte-for-byte" ($mc.changed -and ($mc.text -eq $oldCfg.Replace("lockdownqz.pages.dev", "lockqz.pages.dev")))
$mc2 = Migrate-ConfText '{"api_base":"https://lockqz.pages.dev/api"}'
Check "E1: a current config is left alone" (-not $mc2.changed)

# ======================================================================================
Write-Host "C. engine: hosts lines, clean removal, read-only hosts file (real lockqz.ps1 functions)"
$eAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Win "lockqz.ps1"), [ref]$null, [ref]$null)
$MarkStart = "# LOCKqz START - do not edit"; $MarkEnd = "# LOCKqz END"; $Latin1 = [Text.Encoding]::GetEncoding(28591)
foreach ($f in @($eAst.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and @("Get-HostsLines","Remove-Block","Read-Hosts","Is-Locked","Write-Hosts") -contains $_.Name })) { . ([scriptblock]::Create($f.Extent.Text)) }
$doms = @(Get-Content (Join-Path $Win "blocklist.txt") | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith("#") })
$hl = Get-HostsLines $doms
Check "no path entry becomes a hosts line" (-not ($hl | Where-Object { $_ -match "/" }))
Check "chat.z.ai and duck.ai blackholed" (($hl -contains "0.0.0.0 chat.z.ai") -and ($hl -contains "0.0.0.0 duck.ai") -and ($hl -contains ":: duck.ai"))
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("lqz-hosts-" + [guid]::NewGuid().ToString("N"))
$orig = "# user hosts`r`n127.0.0.1 myapp.local`r`n# caf" + [char]0xE9 + " (Latin-1 byte)`r`n"
[IO.File]::WriteAllText($tmp, $orig, $Latin1)
$Hosts = $tmp
(Get-Item $tmp).IsReadOnly = $true
$okw = Write-Hosts ("`r`n" + ($hl -join "`r`n") + "`r`n") $true
Check "read-only hosts file: block written" ($okw -and (Is-Locked))
Check "read-only flag put back" ((Get-Item $tmp).IsReadOnly)
$okw = Write-Hosts (Remove-Block (Read-Hosts)) $false
$after = [IO.File]::ReadAllBytes($tmp); $before = $Latin1.GetBytes($orig.TrimEnd() + "`r`n")
Check "unlock leaves the user's hosts byte-for-byte (non-ASCII byte kept)" ($okw -and -not (Is-Locked) -and ([Convert]::ToBase64String($after) -eq [Convert]::ToBase64String($before)))
(Get-Item $tmp).IsReadOnly = $false; Remove-Item $tmp -Force
$Hosts = Join-Path ([IO.Path]::GetTempPath()) "lqz-no-such-dir-$([guid]::NewGuid().ToString('N'))/hosts"
Check "unwritable hosts: Write-Hosts reports failure (no silent LOCKED)" (-not (Write-Hosts "x" $true))

# ======================================================================================
Write-Host "D. browser policy: backup / merge / exact restore against an in-memory registry"
$pAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Win "browser-policy.ps1"), [ref]$null, [ref]$null)
foreach ($f in @($pAst.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] })) { . ([scriptblock]::Create($f.Extent.Text)) }
foreach ($st in @($pAst.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.AssignmentStatementAst] })) {
  if (@('$Here','$BlockFile','$BackupFile','$ErrorActionPreference') -contains $st.Left.Extent.Text) { continue }
  . ([scriptblock]::Create($st.Extent.Text))
}
$BlockFile = Join-Path $Win "blocklist.txt"
$tdir = Join-Path ([IO.Path]::GetTempPath()) ("lqz-pol-" + [guid]::NewGuid().ToString("N")); New-Item -ItemType Directory -Path $tdir | Out-Null
$BackupFile = Join-Path $tdir "policy-backup.json"
# ---- mock registry: path -> { name -> @{ kind; value } } ----
$script:REG = @{}; $script:FailWrite = $null; $script:Writes = 0
function Reg-Parent($p) { $i = $p.LastIndexOf("\"); if ($i -lt 0) { "" } else { $p.Substring(0, $i) } }
function RG-KeyExists($path) { $script:REG.ContainsKey($path) }
function RG-CreateKey($path) { if (-not $script:REG.ContainsKey((Reg-Parent $path))) { throw "parent missing: $path" }; $script:REG[$path] = @{} }
function RG-RemoveKey($path) { if ((RG-SubKeyCount $path) -gt 0) { throw "has subkeys" }; $script:REG.Remove($path) }
function RG-ValueNames($path) { if ($script:REG.ContainsKey($path)) { @($script:REG[$path].Keys) } else { @() } }
function RG-SubKeyCount($path) { @($script:REG.Keys | Where-Object { (Reg-Parent $_) -eq $path }).Count }
function RG-Read($path, $name) {
  if (-not $script:REG.ContainsKey($path) -or -not $script:REG[$path].ContainsKey($name)) { return $null }
  $v = $script:REG[$path][$name]; return @{ kind = $v.kind; value = $v.value }
}
function RG-Write($path, $name, $value, $kind) {
  if ($script:FailWrite -and $path -like $script:FailWrite) { throw "access denied (test)" }
  if (-not $script:REG.ContainsKey($path)) { throw "no key $path" }
  if (@("String","ExpandString","DWord","QWord","MultiString","Binary") -notcontains $kind) { throw "bad kind $kind" }
  $script:Writes++; $script:REG[$path][$name] = @{ kind = $kind; value = $value }
}
function RG-Remove($path, $name) { if (-not (RG-Read $path $name)) { throw "no value" }; $script:REG[$path].Remove($name) }
# signed-in users (HKU) and the direct-internet probe, mocked: no CIM, no network in a test
$SID1 = "S-1-5-21-111-222-333-1001"; $SID2 = "S-1-5-21-111-222-333-1002"
$script:Sids = @($SID1); $script:DirectOk = $true; $script:Probes = 0
function Get-ConsoleUserSids { @($script:Sids) }
function Test-DirectInternet { $script:Probes++; $script:DirectOk }
function Dump { ($script:REG.Keys | Sort-Object | ForEach-Object { $k = $_; $k + "{" + (($script:REG[$k].Keys | Sort-Object | ForEach-Object { $_ + "=" + $script:REG[$k][$_].kind + ":" + (@($script:REG[$k][$_].value) -join "|") }) -join ";") + "}" }) -join "`n" }
function Seed {
  $script:REG = @{}
  foreach ($k in @("HKLM:\SOFTWARE", "HKLM:\SOFTWARE\Policies", "HKLM:\SOFTWARE\Policies\Google", "HKLM:\SOFTWARE\Policies\Google\Chrome",
                   "HKLM:\SOFTWARE\Policies\Google\Chrome\URLBlocklist", "HKLM:\SOFTWARE\Policies\Mozilla", "HKLM:\SOFTWARE\Policies\Mozilla\Firefox",
                   "HKLM:\SOFTWARE\Policies\Microsoft", "HKLM:\SOFTWARE\Policies\Microsoft\Windows", "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsAI",
                   "HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallAllowlist",
                   "Registry::HKEY_USERS", "Registry::HKEY_USERS\$SID1", "Registry::HKEY_USERS\$SID1\Software",
                   "Registry::HKEY_USERS\$SID2", "Registry::HKEY_USERS\$SID2\Software")) { $script:REG[$k] = @{} }
  $script:REG["HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallAllowlist"]["1"] = @{ kind = "String"; value = "aiextensionaiextensionaiextensio" }
  # the student's / school's own policies
  $script:REG["HKLM:\SOFTWARE\Policies\Google\Chrome"]["DnsOverHttpsMode"] = @{ kind = "String"; value = "secure" }
  $script:REG["HKLM:\SOFTWARE\Policies\Google\Chrome"]["HomepageLocation"] = @{ kind = "String"; value = "https://usc.edu" }
  $script:REG["HKLM:\SOFTWARE\Policies\Google\Chrome"]["GeminiSettings"] = @{ kind = "DWord"; value = 0 }
  $script:REG["HKLM:\SOFTWARE\Policies\Google\Chrome\URLBlocklist"]["1"] = @{ kind = "String"; value = "badsite.example" }
  $script:REG["HKLM:\SOFTWARE\Policies\Mozilla\Firefox"]["Preferences"] = @{ kind = "MultiString"; value = [string[]]@('{"browser.startup.homepage":{"Value":"https://usc.edu","Status":"locked"}}') }
  $script:REG["HKLM:\SOFTWARE\Policies\Mozilla\Firefox"]["DisableTelemetry"] = @{ kind = "DWord"; value = 1 }
  $script:REG["HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsAI"]["DisableAIDataAnalysis"] = @{ kind = "DWord"; value = 0 }
  $script:REG["HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsAI"]["AllowRecallEnablement"] = @{ kind = "DWord"; value = 1 }
}
$ErrorActionPreference = "SilentlyContinue"   # as in production
Seed; $orig = Dump
$out = Do-Unlock
Check "daemon start (unlock, no quiz ever locked) changes NOTHING (old code deleted the school's Recall setting)" ((Dump) -eq $orig)
$out = Do-Lock
Check "lock reports LOCKED" ($out -match "LOCKED")
Check "backup written before changes" (Test-Path $BackupFile)
$C = "HKLM:\SOFTWARE\Policies\Google\Chrome"
Check "Chrome DoH forced off during the quiz" ((RG-Read $C "DnsOverHttpsMode").value -eq "off")
$bl = @(RG-ValueNames "$C\URLBlocklist" | ForEach-Object { (RG-Read "$C\URLBlocklist" $_).value })
Check "Chrome URLBlocklist MERGED: school entry kept at 1" ((RG-Read "$C\URLBlocklist" "1").value -eq "badsite.example")
Check "Chrome URLBlocklist has search + AI path entries (huggingface.co/chat, x.com/i/grok)" (($bl -contains "google.com/search") -and ($bl -contains "huggingface.co/chat") -and ($bl -contains "x.com/i/grok") -and ($bl -contains "hf.co/chat"))
Check "Edge policy key created for the quiz" ((RG-Read "HKLM:\SOFTWARE\Policies\Microsoft\Edge" "GeminiSettings").value -eq 1)
$F = "HKLM:\SOFTWARE\Policies\Mozilla\Firefox"
$prefs = (@((RG-Read $F "Preferences").value) -join "`n") | ConvertFrom-Json
Check "Firefox Preferences (REG_MULTI_SZ JSON, documented form): ours added, school pref kept" (((RG-Read $F "Preferences").kind -eq "MultiString") -and ($prefs."browser.ml.chat.enabled".Status -eq "locked") -and ($prefs."browser.ml.chat.enabled".Value -eq $false) -and ($prefs."browser.startup.homepage".Value -eq "https://usc.edu"))
Check "Firefox GenerativeAI off" (((RG-Read "$F\GenerativeAI" "Enabled").value -eq 0) -and ((RG-Read "$F\GenerativeAI" "Locked").value -eq 1))
$ffb = @(RG-ValueNames "$F\WebsiteFilter\Block" | ForEach-Object { (RG-Read "$F\WebsiteFilter\Block" $_).value })
Check "Firefox WebsiteFilter blocks the AI paths" ($ffb -contains "*://*.huggingface.co/chat*")
Check "Firefox extensions never touched (no ExtensionSettings anywhere)" (-not ((Dump) -match "ExtensionSettings"))
Check "Windows Copilot off under WindowsCopilot (not WindowsAI)" (((RG-Read "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsCopilot" "TurnOffWindowsCopilot").value -eq 1) -and -not (RG-Read "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsAI" "TurnOffWindowsCopilot"))
$bk1 = Get-Content $BackupFile -Raw; $locked1 = Dump
$out = Do-Lock
Check "lock re-run: backup untouched (never backs up LOCKqz's own values)" ((Get-Content $BackupFile -Raw) -eq $bk1)
Check "lock re-run: no duplicate list entries" ((Dump) -eq $locked1)
$out = Do-Unlock
Check "unlock reports off" ($out -match "off")
Check "unlock restores EVERY value and key exactly as before" ((Dump) -eq $orig)
Check "backup removed after a full restore" (-not (Test-Path $BackupFile))

Write-Host "   round 2: blocklist mirrored into the browsers, Brave Tor/VPN, Firefox Smart Window + VPN, Notepad, Office (per user)"
Seed; $orig = Dump; $script:Sids = @($SID1)
$out = Do-Lock
$hostsW = @(Get-HostEntries)
$bl = @(RG-ValueNames "$C\URLBlocklist" | ForEach-Object { (RG-Read "$C\URLBlocklist" $_).value })
Check "Chrome URLBlocklist has every blocklist host (chatgpt.com, gauthmath.com, api2.cursor.sh) + school entry, <= 1000" (($hostsW.Count -gt 250) -and (@($hostsW | Where-Object { $bl -notcontains $_ }).Count -eq 0) -and ($bl -contains "badsite.example") -and ($bl.Count -le 1000))
Check "no notes host in URLBlocklist (docs.google.com, quizlet.com, m365.cloud.microsoft, github.com)" (-not (@("google.com","docs.google.com","quizlet.com","studocu.com","knowunity.com","m365.cloud.microsoft","github.com") | Where-Object { $bl -contains $_ }))
$al = @(RG-ValueNames "$C\ExtensionInstallAllowlist" | ForEach-Object { (RG-Read "$C\ExtensionInstallAllowlist" $_).value })
Check "ExtensionInstallAllowlist REPLACED for the quiz by the fixed safe list (school's AI extension not exempt)" (($al.Count -eq $SafeExtensions.Count) -and ($al -notcontains "aiextensionaiextensionaiextensio") -and ($al -contains "nngceckbapebfimnlniiiahkandclblb"))
$ua = @(RG-ValueNames "$C\URLAllowlist" | ForEach-Object { (RG-Read "$C\URLAllowlist" $_).value })
Check "DuckDuckGo no-AI site allowed" ($ua -contains "noai.duckduckgo.com")
$Bv = "HKLM:\SOFTWARE\Policies\BraveSoftware\Brave"
Check "Brave: Leo + Tor windows + Brave VPN off" (((RG-Read $Bv "BraveAIChatEnabled").value -eq 0) -and ((RG-Read $Bv "TorDisabled").value -eq 1) -and ((RG-Read $Bv "BraveVPNDisabled").value -eq 1))
Check "Firefox AIControls: SidebarChatbot + SmartWindow blocked, no Default" (((RG-Read "$F\AIControls\SmartWindow" "Value").value -eq "blocked") -and ((RG-Read "$F\AIControls\SidebarChatbot" "Value").value -eq "blocked") -and -not (RG-KeyExists "$F\AIControls\Default"))
Check "Firefox: GenerativeAI SmartWindow off + built-in VPN off" (((RG-Read "$F\GenerativeAI" "SmartWindow").value -eq 0) -and ((RG-Read $F "IPProtectionAvailable").value -eq 0))
$ffb = @(RG-ValueNames "$F\WebsiteFilter\Block" | ForEach-Object { (RG-Read "$F\WebsiteFilter\Block" $_).value })
Check "Firefox WebsiteFilter has every host (*://*.host/*), <= 1000" ((@($hostsW | Where-Object { $ffb -notcontains ("*://*." + $_ + "/*") }).Count -eq 0) -and ($ffb.Count -le 1000))
Check "Notepad AI off (WindowsNotepad\DisableAIFeatures = 1)" ((RG-Read "HKLM:\SOFTWARE\Policies\WindowsNotepad" "DisableAIFeatures").value -eq 1)
$OP1 = "Registry::HKEY_USERS\$SID1\Software\Policies\Microsoft\office\16.0\common\privacy"
Check "Office Copilot off for the signed-in user (usercontentdisabled = 2, HKU)" ((RG-Read $OP1 "usercontentdisabled").value -eq 2)
Check "proxy forced direct when the internet works without it (no probe without a user proxy)" (((RG-Read $C "ProxyMode").value -eq "direct") -and ($script:Probes -eq 0))
$script:Sids = @($SID1, $SID2)   # a second user signs in mid-quiz
$out = Do-Lock
$OP2 = "Registry::HKEY_USERS\$SID2\Software\Policies\Microsoft\office\16.0\common\privacy"
Check "user who signs in mid-quiz: Office Copilot off for them too, and in the backup" (((RG-Read $OP2 "usercontentdisabled").value -eq 2) -and ((Get-Content $BackupFile -Raw) -match [regex]::Escape($SID2)))
$out = Do-Unlock
Check "unlock restores everything incl. the school's allowlist and both users' Office keys" (((Dump) -eq $orig) -and -not (Test-Path $BackupFile))

Write-Host "   28 Oct in-app AI: Acrobat / Reader AI Assistant off at lock (FeatureLockDown bEnableGentech = 0), restored exactly"
Seed
$AA = "HKLM:\SOFTWARE\Policies\Adobe\Adobe Acrobat\DC\FeatureLockDown"; $AR = "HKLM:\SOFTWARE\Policies\Adobe\Acrobat Reader\DC\FeatureLockDown"
foreach ($k in @("HKLM:\SOFTWARE\Policies\Adobe", "HKLM:\SOFTWARE\Policies\Adobe\Adobe Acrobat", "HKLM:\SOFTWARE\Policies\Adobe\Adobe Acrobat\DC", $AA)) { $script:REG[$k] = @{} }
$script:REG[$AA]["bProtectedMode"] = @{ kind = "DWord"; value = 1 }   # the school's own Acrobat lockdown
$script:REG[$AA]["bEnableGentech"] = @{ kind = "DWord"; value = 1 }
$orig = Dump; $script:Sids = @($SID1)
$out = Do-Lock
Check "Acrobat + Reader: bEnableGentech = 0 during the quiz, the school's lockdown kept" (((RG-Read $AA "bEnableGentech").value -eq 0) -and ((RG-Read $AR "bEnableGentech").value -eq 0) -and ((RG-Read $AA "bProtectedMode").value -eq 1))
$out = Do-Unlock
Check "unlock: Acrobat back to the school's 1, the Reader keys LOCKqz created removed" (((Dump) -eq $orig) -and -not (RG-KeyExists "HKLM:\SOFTWARE\Policies\Adobe\Acrobat Reader") -and -not (Test-Path $BackupFile))

Write-Host "   network that only works through its proxy: proxy policy left alone (quiz must load)"
Seed
$script:REG["Registry::HKEY_USERS\$SID1\Software\Microsoft"] = @{}
$script:REG["Registry::HKEY_USERS\$SID1\Software\Microsoft\Windows"] = @{}
$script:REG["Registry::HKEY_USERS\$SID1\Software\Microsoft\Windows\CurrentVersion"] = @{}
$script:REG["Registry::HKEY_USERS\$SID1\Software\Microsoft\Windows\CurrentVersion\Internet Settings"] = @{ ProxyEnable = @{ kind = "DWord"; value = 1 } }
$orig = Dump; $script:Sids = @($SID1); $script:DirectOk = $false; $script:Probes = 0
$out = Do-Lock
Check "proxy needed: Chrome ProxyMode + Firefox Proxy not set, everything else still on" (($null -eq (RG-Read $C "ProxyMode")) -and -not (RG-KeyExists "$F\Proxy") -and ((RG-Read $C "GenAiDefaultSettings").value -eq 2) -and ($out -match "proxy"))
$out = Do-Lock
Check "decision kept for the quiz (no second probe on re-run)" (($script:Probes -eq 1) -and ($null -eq (RG-Read $C "ProxyMode")))
$out = Do-Unlock
Check "unlock restores exactly" ((Dump) -eq $orig)
$script:DirectOk = $true; $script:Probes = 0
$out = Do-Lock
Check "user proxy set but internet works directly -> proxy forced direct" (((RG-Read $C "ProxyMode").value -eq "direct") -and ($script:Probes -eq 1))
$out = Do-Unlock
Check "... and restored" ((Dump) -eq $orig)
$script:DirectOk = $true
Seed; $orig = Dump

Write-Host "   restore that fails half-way is retried, never lost"
Seed; $out = Do-Lock
$script:FailWrite = "*Google\Chrome"
$out = Do-Unlock
Check "failed restore -> 'restore incomplete', backup kept" (($out -match "incomplete") -and (Test-Path $BackupFile))
$script:FailWrite = $null
$out = Do-Lock   # a new quiz before the retry: must reuse the ORIGINAL backup
$out = Do-Unlock
Check "retry restores the original values" (((Dump) -eq $orig) -and -not (Test-Path $BackupFile))

Write-Host "   no backup possible -> nothing changed"
Seed; $saveB = $BackupFile
$blocker = Join-Path $tdir "missing-dir"; Set-Content -Path $blocker -Value "a file, not a folder"
$BackupFile = Join-Path (Join-Path $blocker "sub") "nofile.json"
$script:Writes = 0; $out = Do-Lock
Check "backup cannot be written -> lock changes no policy" (($out -match "FAILED") -and ($script:Writes -eq 0) -and ((Dump) -eq $orig))
$BackupFile = $saveB

Write-Host "   upgrade from 0.3.8 (marker, no backup): only LOCKqz's own values removed"
Seed
$script:REG["$C"]["LOCKqzManaged"] = @{ kind = "DWord"; value = 1 }
$script:REG["$C"]["ProxyMode"] = @{ kind = "String"; value = "direct" }
$script:REG["$C\URLBlocklist"]["2"] = @{ kind = "String"; value = "google.com/search" }
$out = Do-Unlock
Check "legacy cleanup removes the old marker + values + list entries" ((-not (RG-Read $C "LOCKqzManaged")) -and (-not (RG-Read $C "ProxyMode")) -and (-not (RG-Read "$C\URLBlocklist" "2")))
Check "legacy cleanup keeps the school's own values" (((RG-Read $C "HomepageLocation").value -eq "https://usc.edu") -and ((RG-Read "$C\URLBlocklist" "1").value -eq "badsite.example"))

Write-Host "   Firefox-family policies.json"
$j = FirefoxPoliciesJson '{"policies":{"DisableTelemetry":true,"ExtensionSettings":{"uBlock0@raymondhill.net":{"installation_mode":"normal_installed"}}}}'
$jo = $j | ConvertFrom-Json
Check "policies.json merged: school's policies kept, ours added" ($jo.policies.DisableTelemetry -and $jo.policies.GenerativeAI -and $jo._lockqz -and $jo.policies.ExtensionSettings.'uBlock0@raymondhill.net')
$modes = @($jo.policies.ExtensionSettings.PSObject.Properties | ForEach-Object { $_.Value.installation_mode })
Check "policies.json never sets installation_mode blocked (it uninstalls extensions)" (($modes -notcontains "blocked") -and -not ($jo.policies.ExtensionSettings.PSObject.Properties.Name -contains "*"))
$jn = (FirefoxPoliciesJson $null) | ConvertFrom-Json
Check "fresh policies.json has no ExtensionSettings at all" ($null -eq $jn.policies.ExtensionSettings)
Check "policies.json: Smart Window blocked, built-in VPN off, hosts mirrored, proxy off" (($jn.policies.AIControls.SmartWindow.Value -eq "blocked") -and ($jn.policies.IPProtectionAvailable -eq $false) -and (@($jn.policies.WebsiteFilter.Block) -contains "*://*.chatgpt.com/*") -and ($jn.policies.Proxy.Mode -eq "none") -and (@($jn.policies.WebsiteFilter.Block).Count -le 1000))
$jk = (FirefoxPoliciesJson $null $true) | ConvertFrom-Json
Check "policies.json on a proxy-only network: no Proxy policy" ($null -eq $jk.policies.Proxy)
$pj = Join-Path $tdir "policies.json"; Write-Utf8NoBom $pj $j
$b3 = [IO.File]::ReadAllBytes($pj)
Check "policies.json written as UTF-8 without BOM" (-not ($b3[0] -eq 0xEF -and $b3[1] -eq 0xBB -and $b3[2] -eq 0xBF))
$ErrorActionPreference = "Stop"
Remove-Item $tdir -Recurse -Force

# ======================================================================================
Write-Host "E. agent round 2: password schedule (C2), other school (C10), URL rules (F14)"
$script:Msgs = @(); $script:Clip = $null; $script:Setups = 0
function Show-Message($t) { $script:Msgs += $t }
function Set-Clipboard($Value) { $script:Clip = $Value }
function Show-Pay($r) { return $false }
function Start-Setup { $script:Setups++; $script:SetupAt = [DateTime]::UtcNow }
$n0 = Get-Date "2026-10-25T12:00:00"
Check "not started: every 5 min until 90 s before it opens" (((Next-PwCheck $n0 $n0.AddSeconds(3600)) -eq $n0.AddSeconds(300)) -and ((Next-PwCheck $n0 $n0.AddSeconds(200)) -eq $n0.AddSeconds(110)))
Check "... then every 15 s; unknown start -> 5 min" (((Next-PwCheck $n0 $n0.AddSeconds(60)) -eq $n0.AddSeconds(15)) -and ((Next-PwCheck $n0 $null) -eq $n0.AddSeconds(300)))
$Quiz = "123-456"; $LastPw = $null; $StartTold = $null; $Capped = @{}; $CapLeft = @{}; $PwNext = [DateTime]::UtcNow; $SetupAt = Get-Date "2000-01-01"
$r = Handle-Pw ([pscustomobject]@{ password = $null; status = 403; reason = "not started"; start_in = 1200 }) $true ""
Check "not started -> wait, next ask ~5 min later, told once" (($r -eq "wait") -and (($PwNext - [DateTime]::UtcNow).TotalSeconds -gt 250) -and (@($Msgs | Where-Object { $_ -match "opens at" }).Count -eq 1))
Check "DST (1 Nov 2026): the password timer is on UTC, so the clock going back an hour never freezes it" ($PwNext.Kind -eq [DateTimeKind]::Utc)
Handle-Pw ([pscustomobject]@{ reason = "not started"; start_in = 1000 }) $false "" | Out-Null
Check "... the 'opens at' message is not repeated" (@($Msgs | Where-Object { $_ -match "opens at" }).Count -eq 1)
$r = Handle-Pw ([pscustomobject]@{ password = "PW9"; status = 200 }) $false ""
Check "password arrives -> shown + clipboard" (($r -eq "pw") -and ($Clip -eq "PW9") -and ($LastPw -eq "PW9"))
$r = Handle-Pw ([pscustomobject]@{ reason = "other_school"; status = 403 }) $true ""
Check "other school -> told, quiz remembered as released (never re-locked)" (($r -eq "other") -and $Capped.ContainsKey("123-456") -and (@($Msgs | Where-Object { $_ -match "not set up for this school" }).Count -eq 1))
$r = Handle-Pw ([pscustomobject]@{ reason = "verify"; status = 402 }) $true ""
Check "server needs the school email -> setup started" (($null -eq $r) -and ($Setups -eq 1))
Check "F14: 'submission' in the query of an attempt page is not a leaving page" ((Is-Quiz "https://x/d2l/lms/quizzing/user/attempt/quiz_attempt_page.d2l?ou=1&qi=2&returnUrl=quiz_submissions") -and -not (Is-Leaving "https://x/d2l/lms/quizzing/user/attempt/quiz_attempt_page.d2l?ou=1&qi=2&r=results"))
Check "F14: address bar without https:// still detected" (Is-Quiz "brightspace.usc.edu/d2l/lms/quizzing/user/quiz_summary.d2l?qi=5&ou=6")
Check "F14: [?&]qi= only" ((Lock-Id "https://x/d2l/lms/quizzing/user/q.d2l?xqi=9&qi=2&abou=8&ou=1") -eq "1-2")

# ======================================================================================
Write-Host "F. boot wrapper: an update that never answers /status is rolled back after 3 starts (real lockqz-boot.ps1)"
$bd = Join-Path ([IO.Path]::GetTempPath()) ("lqz-boot-" + [guid]::NewGuid().ToString("N")); New-Item -ItemType Directory -Path "$bd\.prev" | Out-Null
Copy-Item (Join-Path $Win "lockqz-boot.ps1") $bd
Set-Content "$bd\lockqzd.ps1" "NEW" -NoNewline; Set-Content "$bd\added.ps1" "NEW" -NoNewline; Set-Content "$bd\config.json" "CFG" -NoNewline
Set-Content "$bd\.prev\lockqzd.ps1" "OLD" -NoNewline; Set-Content "$bd\.prev\.added" "added.ps1" ; Set-Content "$bd\.pending" "from=0.4.1`r`nto=0.4.2`r`nstarts=0"
$sh = (Get-Process -Id $PID).Path
for ($i = 0; $i -lt 3; $i++) { & $sh -NoProfile -File "$bd\lockqz-boot.ps1" -RollbackCheck }
Check "3 starts without /status: still the new code, still pending" (((Get-Content "$bd\lockqzd.ps1" -Raw) -eq "NEW") -and (Test-Path "$bd\.pending"))
& $sh -NoProfile -File "$bd\lockqz-boot.ps1" -RollbackCheck
Check "4th start: previous files back, added file removed" (((Get-Content "$bd\lockqzd.ps1" -Raw) -eq "OLD") -and -not (Test-Path "$bd\added.ps1"))
Check "version marked bad, kit + marker gone, config untouched" ((((Get-Content "$bd\.bad_version" -Raw).Trim()) -eq "0.4.2") -and -not (Test-Path "$bd\.pending") -and -not (Test-Path "$bd\.prev") -and ((Get-Content "$bd\config.json" -Raw) -eq "CFG"))
Set-Content "$bd\.pending" "from=0.4.1`r`nto=0.4.3`r`nstarts=0"
& $sh -NoProfile -File "$bd\lockqz-boot.ps1" -RollbackCheck
Check "a healthy start just counts (starts=1)" ((Get-Content "$bd\.pending") -contains "starts=1")
Remove-Item $bd -Recurse -Force

Write-Host "G. round-2 #4: a released quiz locks again for a new attempt or once its page was closed (real Add-Cap / Note-Cap / Forget-Cap / Step-Caps)"
foreach ($f in @($agentAst.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and @("Add-Cap","Note-Cap","Forget-Cap","Step-Caps") -contains $_.Name })) {
  . ([scriptblock]::Create($f.Extent.Text))
}
$script:HelperCalls = @()
function Helper($path, $body, $timeout = 90) { $script:HelperCalls += $path; return [pscustomobject]@{ ok = $true } }
function Log($m) { }
$Grace = 30; $Capped = @{}; $CapLeft = @{}; $CapForgot = @{}
$cAtt = "https://brightspace.usc.edu/d2l/lms/quizzing/user/attempt/quiz_attempt_page.d2l?ou=1&qi=2"
$cSum = "https://brightspace.usc.edu/d2l/lms/quizzing/user/quiz_summary.d2l?qi=2&ou=1"
$nowU = [int64][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
Note-Cap ([pscustomobject]@{ capped_quiz = "1-2"; capped_at = $nowU; capped_reason = "quiz_submitted" })
Step-Caps "1-2" $cAtt
Check "released mid-attempt -> stays released while on the attempt page" ($Capped.ContainsKey("1-2"))
Step-Caps "1-2" $cSum
Check "back on the summary page -> still released" ($Capped.ContainsKey("1-2") -and $CapLeft["1-2"])
Step-Caps "1-2" $cAtt
Check "a NEW attempt after the summary -> forgotten (locks), helper told /uncap" ((-not $Capped.ContainsKey("1-2")) -and ($script:HelperCalls -contains "/uncap"))
Note-Cap ([pscustomobject]@{ capped_quiz = "1-2"; capped_at = $nowU - 5 })
Check "the helper's older release is not re-added" (-not $Capped.ContainsKey("1-2"))
Note-Cap ([pscustomobject]@{ capped_quiz = "1-2"; capped_at = $nowU + 5 })
Check "a later release of the same quiz is honored" ($Capped.ContainsKey("1-2"))
$Capped["1-2"] = [DateTime]::UtcNow.AddSeconds(-40)
Step-Caps $null ""
Check "page gone for the grace period -> forgotten" (-not $Capped.ContainsKey("1-2"))
$dmnSrc = Get-Content (Join-Path $Win "lockqzd.ps1") -Raw
Check "helper: /uncap endpoint and a 30 min release window (was 24 h)" (($dmnSrc -match '"/uncap"') -and ($dmnSrc -match 'else \{ 1800 \}') -and ($dmnSrc -match '-lt \$CapForget\)') -and -not ($dmnSrc -match 'capped_at\) -lt 86400'))

Write-Host ""
Write-Host "RESULT: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
