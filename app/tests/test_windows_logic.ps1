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
foreach ($f in @($agentAst.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and @("Is-QuizPath","Is-Quiz","Is-QuizByTitle","Is-Leaving","Lock-Id","Clean-Title","Get-ActiveTab","Test-TitlePresent","Step-Locked") -contains $_.Name })) {
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
Write-Host "B. helper: wall-clock heartbeat, unlock reasons, 3-hour cap (real SignLib / Clamp-Minutes)"
$dsrc = Get-Content (Join-Path $Win "lockqzd.ps1") -Raw
$m = [regex]::Match($dsrc, "(?s)\`$SignLib = @'\r?\n(.*?)\r?\n'@")
. ([ScriptBlock]::Create($m.Groups[1].Value))
$dAst = [System.Management.Automation.Language.Parser]::ParseInput($dsrc, [ref]$null, [ref]$null)
$CapMin = 180
foreach ($f in @($dAst.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq "Clamp-Minutes" })) { . ([scriptblock]::Create($f.Extent.Text)) }
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
Check "max_minutes 600 -> capped at 180" ((Clamp-Minutes 600) -eq 180)
Check "max_minutes 60 -> 60" ((Clamp-Minutes 60) -eq 60)
Check "max_minutes missing/0/garbage -> 180" (((Clamp-Minutes $null) -eq 180) -and ((Clamp-Minutes 0) -eq 180) -and ((Clamp-Minutes "x") -eq 180))

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
function Dump { ($script:REG.Keys | Sort-Object | ForEach-Object { $k = $_; $k + "{" + (($script:REG[$k].Keys | Sort-Object | ForEach-Object { $_ + "=" + $script:REG[$k][$_].kind + ":" + (@($script:REG[$k][$_].value) -join "|") }) -join ";") + "}" }) -join "`n" }
function Seed {
  $script:REG = @{}
  foreach ($k in @("HKLM:\SOFTWARE", "HKLM:\SOFTWARE\Policies", "HKLM:\SOFTWARE\Policies\Google", "HKLM:\SOFTWARE\Policies\Google\Chrome",
                   "HKLM:\SOFTWARE\Policies\Google\Chrome\URLBlocklist", "HKLM:\SOFTWARE\Policies\Mozilla", "HKLM:\SOFTWARE\Policies\Mozilla\Firefox",
                   "HKLM:\SOFTWARE\Policies\Microsoft", "HKLM:\SOFTWARE\Policies\Microsoft\Windows", "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsAI")) { $script:REG[$k] = @{} }
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
$pj = Join-Path $tdir "policies.json"; Write-Utf8NoBom $pj $j
$b3 = [IO.File]::ReadAllBytes($pj)
Check "policies.json written as UTF-8 without BOM" (-not ($b3[0] -eq 0xEF -and $b3[1] -eq 0xBB -and $b3[2] -eq 0xBF))
$ErrorActionPreference = "Stop"
Remove-Item $tdir -Recurse -Force

Write-Host ""
Write-Host "RESULT: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
