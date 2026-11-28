# Exam rules on Windows, off-Windows: the REAL functions of windows/lockqz.ps1, lockqzd.ps1, browser-policy.ps1 and
# lockqz-agent.ps1 (loaded by AST, nothing else in the scripts runs) make this exam's lists exactly as app/mac/rules.py
# does on the Mac and Linux, close and keep the right programs, and write the browser lists.
# Runs on PowerShell 7 (any OS) or Windows PowerShell 5.1, with python3 for the Mac side. Exit 1 on any failure.
$ErrorActionPreference = "Stop"
$Win = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, "..", "windows")); $Mac = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, "..", "mac"))
$pass = 0; $fail = 0
function Check($m, $c, $info = "") { if ($c) { $script:pass++; Write-Host "  ok: $m" } else { $script:fail++; Write-Host "  FAIL: $m  $info" } }
function Get-Defs([string]$file, $names, $vars = @()) {
  $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Win $file), [ref]$null, [ref]$null)
  $out = @()
  foreach ($s in @($ast.EndBlock.Statements)) {
    if (($s -is [System.Management.Automation.Language.FunctionDefinitionAst]) -and ($names -contains $s.Name)) { $out += $s.Extent.Text }
    elseif (($s -is [System.Management.Automation.Language.AssignmentStatementAst]) -and ($vars -contains $s.Left.Extent.Text)) { $out += $s.Extent.Text }
  }
  return ,$out
}
foreach ($t in (Get-Defs "lockqz.ps1" @("LQ-Host", "LQ-Under", "Build-Exam", "LQ-WriteIfChanged", "Use-Exam", "Clear-Exam"))) { . ([scriptblock]::Create($t)) }
# LQ-Cut, LQ-RulesRecord and LQ-BeatRules live in the code the watcher loads too ($SignLib): loaded from there.
$dsrc = Get-Content (Join-Path $Win "lockqzd.ps1") -Raw
$lib = [regex]::Match($dsrc, "(?s)\`$SignLib = @'\r?\n(.*?)\r?\n'@")
. ([ScriptBlock]::Create($lib.Groups[1].Value))
foreach ($t in (Get-Defs "lockqzd.ps1" @("Set-Rules"))) { . ([scriptblock]::Create($t)) }
foreach ($t in (Get-Defs "browser-policy.ps1" @("Get-ExamWeb", "Get-FfWebExceptions", "Get-ExamLists") @('$SearchAllow', '$FfOkParams', '$FfAllow', '$FfPrefs'))) { . ([scriptblock]::Create($t)) }
foreach ($t in (Get-Defs "lockqz-agent.ps1" @() @('$ExamNote'))) { . ([scriptblock]::Create($t)) }

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("lqz-wrules-" + [guid]::NewGuid().ToString("N")); New-Item -ItemType Directory -Path $Tmp | Out-Null
$cat = Get-Content -LiteralPath (Join-Path $Win "rules-catalog.json") -Raw | ConvertFrom-Json
$keys = @($cat.rows.PSObject.Properties | ForEach-Object { $_.Name })
$off = @($keys | Where-Object { $cat.rows.$_.default -eq "block" })
$base = Join-Path $Win "blocklist.txt"
$py = $null; foreach ($c in @("python3", "python")) { if (Get-Command $c -ErrorAction SilentlyContinue) { $py = $c; break } }
$n = 0
function Rules($b, $allow = @(), $block = @(), $label = "Custom", $qh = "usc.brightspace.com") {
  $script:n++; $p = Join-Path $Tmp "rules-$($script:n).json"
  $rec = [ordered]@{ quiz_id = "1-2"; rules = [ordered]@{ label = $label; b = [object[]]@($b); allow = [object[]]@($allow); block = [object[]]@($block) }; quiz_host = $qh }
  [IO.File]::WriteAllText($p, ($rec | ConvertTo-Json -Depth 5 -Compress)); return $p
}
function MacBuild($rf) {   # app/mac/rules.py on the same rules -> @{ list; exam }
  $d = Join-Path $Tmp ("mac-" + [guid]::NewGuid().ToString("N")); New-Item -ItemType Directory -Path $d | Out-Null
  & $py (Join-Path $Mac "rules.py") build $rf (Join-Path $Mac "blocklist.txt") $d mac | Out-Null
  return @{ list = @([IO.File]::ReadAllLines((Join-Path $d "exam-blocklist.txt")) | Where-Object { $_ }); exam = (Get-Content -LiteralPath (Join-Path $d "exam.json") -Raw | ConvertFrom-Json) }
}
function Same($a, $b) { return ((@($a) -join "`n") -ceq (@($b) -join "`n")) }

Write-Host "W1 this exam's lists: the same as the Mac's"
$cases = @(
  @{ name = "default (Notes + internet)"; b = $off; label = "Notes + internet" },
  @{ name = "Notes only"; b = @($off + @("search", "wiki", "web")); label = "Notes only" },
  @{ name = "custom: YouTube, homework, chat allowed; Excel blocked; typed sites and programs"; b = @($off | Where-Object { @("youtube", "homework", "chat") -notcontains $_ }) + @("excel", "web");
     allow = @("https://www.investopedia.com/terms", "x.com", "chatgpt.com"); block = @("Spotify", "khanacademy.org", "Finder", "brightspace.com", "google.com", "Safari.app", "chrome.exe", "Steam.app") },
  @{ name = "another school's quiz site stays open"; b = @($off + @("web")); qh = "lms.otherschool.edu" },
  @{ name = "Also block never takes the quiz's own site"; b = @($off + @("web")); block = @("brightspace.usc.edu", "usc.edu", "khanacademy.org"); qh = "brightspace.usc.edu" },
  @{ name = "e-textbooks and MATLAB allowed in Notes only: their sign-in pages"; b = @(@($off | Where-Object { @("ebooks", "matlab") -notcontains $_ }) + @("search", "wiki", "web")); label = "Notes only" }
)
foreach ($c in $cases) {
  $qh = "usc.brightspace.com"; if ($c.qh) { $qh = $c.qh }
  $rf = Rules $c.b $c.allow $c.block ($(if ($c.label) { $c.label } else { "Custom" })) $qh
  $w = Build-Exam $rf $base (Join-Path $Win "rules-catalog.json")
  if (-not $py) { Check "$($c.name): built" ($null -ne $w); continue }
  $m = MacBuild $rf
  Check "$($c.name): the same blocklist ($(@($w.list).Count) entries)" (Same $w.list $m.list) ("win " + @($w.list).Count + " mac " + @($m.list).Count)
  $wj = $w.exam | ConvertTo-Json -Depth 4 -Compress | ConvertFrom-Json
  Check "$($c.name): the same exam.json (label, rows, search, translators, open sites)" (($wj.label -ceq $m.exam.label) -and (Same $wj.b $m.exam.b) -and ($wj.search -eq $m.exam.search) -and ($wj.translate -eq $m.exam.translate) -and (Same $wj.web $m.exam.web)) ("win web " + (@($wj.web) -join ",") + " | mac web " + (@($m.exam.web) -join ","))
}
$w = Build-Exam (Rules $off) $base (Join-Path $Win "rules-catalog.json")
$apps = @($w.apps | ForEach-Object { $_[0] + ":" + $_[1] })
Check "default: Outlook, Zoom, Teams, WhatsApp closed; Word and Excel kept" (($apps -contains "close:OUTLOOK") -and ($apps -contains "close:Zoom") -and ($apps -contains "close:ms-teams") -and ($apps -contains "close:WhatsApp") -and ($apps -contains "keep:WINWORD") -and ($apps -contains "keep:EXCEL")) ($apps -join " ")
$w = Build-Exam (Rules @($off | Where-Object { $_ -ne "chat" }) @() @("Spotify", "explorer.exe", "Steam.app", "notepad")) $base (Join-Path $Win "rules-catalog.json")
$apps = @($w.apps | ForEach-Object { $_[0] + ":" + $_[1] })
Check "chat allowed: Discord and Slack kept open; typed Spotify, Steam, notepad closed; explorer never" (($apps -contains "keep:Discord") -and ($apps -contains "keep:slack") -and ($apps -contains "typed:Spotify") -and ($apps -contains "typed:Steam") -and ($apps -contains "typed:notepad") -and -not ($apps -match "explorer")) ($apps -join " ")
Check "unreadable rules -> nothing (LOCKqz locks as before)" ($null -eq (Build-Exam (Join-Path $Tmp "missing.json") $base (Join-Path $Win "rules-catalog.json")))
$w = Build-Exam (Rules @($off + @("web")) @() @("brightspace.usc.edu", "usc.edu", "khanacademy.org") "Custom" "brightspace.usc.edu") $base (Join-Path $Win "rules-catalog.json")
Check "Also block: the quiz's own site and its parent never join the list; khanacademy.org does" ((@($w.list) -notcontains "brightspace.usc.edu") -and (@($w.list) -notcontains "usc.edu") -and (@($w.list) -contains "khanacademy.org"))
$w = Build-Exam (Rules @($off + @("search", "wiki", "web")) @() @() "Notes only") $base (Join-Path $Win "rules-catalog.json")
Check "Notes only with Python and Jupyter open: localhost and 127.0.0.1 are open sites, never on the hosts list" ((@($w.exam.web) -contains "localhost") -and (@($w.exam.web) -contains "127.0.0.1") -and (@($w.list) -notcontains "localhost"))
$w = Build-Exam (Rules @($off + @("search", "wiki", "web", "python")) @() @() "Notes only") $base (Join-Path $Win "rules-catalog.json")
Check "Python and Jupyter blocked: no localhost" (@($w.exam.web) -notcontains "localhost")

Write-Host "W2 Use-Exam writes the files the policy reads, and they go without rules"
$Here = $Win; $ExamDir = Join-Path $Tmp "state"; New-Item -ItemType Directory -Path $ExamDir | Out-Null
$RulesFile = Rules @($off + @("search", "wiki", "web")) @("investopedia.com") @() "Notes only"; $BlockFile = $base; $Catalog = Join-Path $Win "rules-catalog.json"; $ExamApps = @()
Use-Exam
Check "exam files written; the engine reads this exam's list and programs" ((Test-Path (Join-Path $ExamDir "exam.json")) -and (Test-Path (Join-Path $ExamDir "exam-blocklist.txt")) -and ($BlockFile -like "*exam-blocklist.txt") -and (@($ExamApps).Count -gt 10))
$t1 = (Get-Item (Join-Path $ExamDir "exam-blocklist.txt")).LastWriteTimeUtc; Start-Sleep -Milliseconds 1100; Use-Exam
Check "unchanged rules: the files are not rewritten" ((Get-Item (Join-Path $ExamDir "exam-blocklist.txt")).LastWriteTimeUtc -eq $t1)
$Exam = Get-Content -LiteralPath (Join-Path $ExamDir "exam.json") -Raw | ConvertFrom-Json
$ex = Get-ExamLists @("chatgpt.com", "m365.cloud.microsoft/chat") @("*://*.chatgpt.com/*")
Check "Chromium: '*' first, the open sites + local files allowed, no Google 'Web' results, no translation" (($ex.cBlock[0] -eq "*") -and ($ex.cAllow -contains "brightspace.com") -and ($ex.cAllow -contains "investopedia.com") -and ($ex.cAllow -contains "file://*") -and -not ($ex.cAllow -match "udm=14") -and ($ex.translate -eq $false)) ($ex.cAllow[0..5] -join ",")
Check "Firefox: <all_urls> first, open sites as exceptions, local files, translations pref off" (($ex.fBlock[0] -eq "<all_urls>") -and ($ex.fAllow -contains "*://*.brightspace.com/*") -and ($ex.fAllow -contains "*://*.investopedia.com/*") -and ($ex.fAllow -contains "file:///*") -and ($ex.prefs["browser.translations.enable"] -eq $false)) ($ex.fAllow[0..5] -join ",")
Check "Firefox: an open site with a blocked part is not an exception (m365.cloud.microsoft has /chat)" (-not ($ex.fAllow -match "m365\.cloud\.microsoft")) (($ex.fAllow | Where-Object { $_ -match "m365" }) -join ",")
Check "a notebook on this PC: localhost and 127.0.0.1 in both browsers (Firefox: exactly those hosts, every port)" (($ex.cAllow -contains "localhost") -and ($ex.cAllow -contains "127.0.0.1") -and ($ex.fAllow -contains "*://localhost/*") -and ($ex.fAllow -contains "*://127.0.0.1/*") -and -not ($ex.fAllow -contains "*://*.localhost/*")) (($ex.fAllow | Where-Object { $_ -match "local|127" }) -join ",")
$RulesFile = Join-Path $Tmp "gone.json"; Use-Exam
Check "no rules: the exam files are removed" (-not (Test-Path (Join-Path $ExamDir "exam.json")) -and -not (Test-Path (Join-Path $ExamDir "exam-blocklist.txt")))
$Exam = $null; $ex = Get-ExamLists @("a.com") @("*://*.a.com/*")
Check "no exam: the lists as always (Google 'Web' results allowed, no '*')" (($ex.cBlock[0] -eq "a.com") -and ($ex.cAllow -match "udm=14") -and $ex.translate)

Write-Host "W3 helper: the rules it keeps"
$RulesFile = Join-Path $Tmp "helper-rules.json"
$r = [pscustomobject]@{ v = 1; label = "Notes only"; b = @("web", "search", "BAD KEY", 5); allow = @("investopedia.com", 7); block = @("Spotify") }
Check "saved: known-shape keys only, the quiz's site" ((Set-Rules "1-2" $r "https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=2&ou=1") -and ((Get-Content $RulesFile -Raw | ConvertFrom-Json).rules.b -join ",") -eq "web,search" -and ((Get-Content $RulesFile -Raw | ConvertFrom-Json).quiz_host -eq "usc.brightspace.com"))
Check "the same rules again: no change" (-not (Set-Rules "1-2" $r "https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=2&ou=1"))
Check "no rules from the server: the file goes" ((Set-Rules "1-2" $null) -and -not (Test-Path $RulesFile) -and -not (Set-Rules "1-2" $null))
Check "the lock note names what stays open" ($ExamNote["Notes only"] -match "Only Brightspace" -and $ExamNote["Notes + internet"] -match "Messaging")
$r1 = [pscustomobject]@{ v = 1; label = "Notes + internet"; b = @("text", "chat", "calls"); allow = @(); block = @() }
$r2 = [pscustomobject]@{ v = 1; label = "Custom"; b = @("text", "chat"); allow = @(); block = @() }
Check "heartbeat rules: none held yet (no password for this quiz) -> not taken" (-not (LQ-BeatRules "1-2" $r1 $RulesFile) -and -not (Test-Path $RulesFile))
Set-Rules "1-2" $r1 "https://brightspace.usc.edu/d2l/lms/quizzing/user/quiz_summary.d2l?qi=2&ou=1" | Out-Null
Check "heartbeat rules: the same again -> nothing" (-not (LQ-BeatRules "1-2" $r1 $RulesFile))
Check "heartbeat rules: changed during the exam -> saved (the lock runs again), the quiz's site kept" ((LQ-BeatRules "1-2" $r2 $RulesFile) -and (((Get-Content $RulesFile -Raw | ConvertFrom-Json).rules.b -join ",") -eq "text,chat") -and ((Get-Content $RulesFile -Raw | ConvertFrom-Json).quiz_host -eq "brightspace.usc.edu"))
Check "heartbeat rules: another quiz, or rules without rows -> ignored, the held rules stay" (-not (LQ-BeatRules "9-9" $r1 $RulesFile) -and -not (LQ-BeatRules "1-2" ([pscustomobject]@{ label = "x" }) $RulesFile) -and (((Get-Content $RulesFile -Raw | ConvertFrom-Json).rules.b -join ",") -eq "text,chat"))
Check "the watcher applies them with the heartbeat (lists, then the browser policy)" ($dsrc -match [regex]::Escape('(LQ-BeatRules $hq $hr.data.rules $rulesFile)'))
$src = Get-Content (Join-Path $Win "lockqzd.ps1") -Raw
Check "the helper rebuilds the lists when the rules change (engine, then policy) and drops them for a new quiz" (($src -match [regex]::Escape('if ($rch) { Engine "lock" | Out-Null; Policy-Relock }')) -and ($src -match [regex]::Escape('Set-Rules $null $null | Out-Null')))
$eng = Get-Content (Join-Path $Win "lockqz.ps1") -Raw
Check "the engine builds the lists first and clears rules + lists at unlock" (($eng -match "(?s)function Do-Lock \{\s+Use-Exam") -and ($eng -match [regex]::Escape('Remove-Item -LiteralPath $RulesFile -Force')) -and ($eng -match "Clear-Exam"))

Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ""; Write-Host "RESULT: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
