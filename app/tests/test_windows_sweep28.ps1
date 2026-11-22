# Sweep 28 (22 Nov 2026), Windows agent + helper, off-Windows: the REAL functions loaded by AST (nothing else runs).
#   E  what the agent saw of the exam's attempt goes with its unlock (Step-Evidence / Seen-For): sub = the exam's
#      turned-in page took the place of its attempt page in the same window, same Brightspace host; attempt = an
#      attempt page was seen (never "none" when the exam was seen by its title only, or for an adopted lock).
#   F  the exam's own Firefox, already running when the lock began, is restarted once (Restart-QuizFirefox).
#   K  the helper passes the agent's view on as booleans (LQ-Seen); an unlock LOCKqz did not answer is held, and
#      offline the 10 minutes after which it stands do not start (LQ-AskWait); a SSH rule for the quiz only.
$ErrorActionPreference = "Stop"
$Win = Join-Path $PSScriptRoot "..\windows"
$pass = 0; $fail = 0
function Check($m, $c) { if ($c) { $script:pass++; Write-Host "  ok: $m" } else { $script:fail++; Write-Host "  FAIL: $m" } }
function FuncTexts($file, $names) {
  $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Win $file), [ref]$null, [ref]$null)
  @($ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $_.Name } | ForEach-Object { $_.Extent.Text })
}
function Log($m) { }
foreach ($t in (FuncTexts "lockqz-agent.ps1" @("Url-Path","Url-Query","Is-QuizPath","Is-Quiz","Is-Leaving","Lock-Id","Url-Host","Is-SubmitPath","Step-Evidence","Seen-For","Restart-QuizFirefox"))) { . ([scriptblock]::Create($t)) }
$script:Seen = @{}; $script:AttWin = @{}; $script:RestartWait = [DateTime]::MinValue
$B = "https://brightspace.usc.edu"
$ATT = "$B/d2l/lms/quizzing/user/attempt/quiz_attempt_page.d2l?ou=98765&qi=12345"
$SUMM = "$B/d2l/lms/quizzing/user/quiz_summary.d2l?qi=12345&ou=98765"
$SUBM = "$B/d2l/lms/quizzing/user/quiz_submissions_attempt.d2l?ou=98765&qi=12345&ai=9"
function W($url, $hwnd, $title = "Quiz - USC Brightspace") { [pscustomobject]@{ Title = $title; Url = $url; Tabs = @($title); Proc = "msedge"; Hwnd = $hwnd } }
$Q = "98765-12345"; $t0 = [DateTime]::UtcNow

Write-Host "E what the agent saw of the attempt"
Check "the turned-in page is a submit page, the quiz list is not" ((Is-SubmitPath $SUBM) -and -not (Is-SubmitPath "$B/d2l/lms/quizzing/user/quizzes_list.d2l?ou=98765"))
Check "host read from a quiz address" ((Url-Host $ATT) -eq "brightspace.usc.edu")
Step-Evidence @((W $SUMM 101)) $Q $true $t0
Check "start page only -> no attempt seen (live address bars)" ((Seen-For $Q).attempt -eq $false -and -not (Seen-For $Q).sub)
Step-Evidence @((W $ATT 101)) $Q $true $t0.AddSeconds(2)
Step-Evidence @((W $SUBM 101)) $Q $false $t0.AddSeconds(4)
$s = Seen-For $Q
Check "attempt then the turned-in page in the same window -> sub + attempt" ($s.sub -eq $true -and $s.attempt -eq $true)
$script:Seen = @{}; $script:AttWin = @{}
Step-Evidence @((W $ATT 101)) $Q $true $t0
Step-Evidence @((W "https://docs.google.com/x" 101), (W $SUBM 202)) $Q $false $t0.AddSeconds(2)
Check "turned-in page in ANOTHER window -> not sub" (-not (Seen-For $Q).sub -and (Seen-For $Q).attempt -eq $true)
$script:Seen = @{}; $script:AttWin = @{}
Step-Evidence @((W $ATT 101)) $Q $true $t0
Step-Evidence @((W "https://evil.example.com/d2l/lms/quizzing/user/quiz_submissions_attempt.d2l?ou=98765&qi=12345&ai=9" 101)) $Q $false $t0.AddSeconds(2)
Check "a turned-in page on another host in the same window -> not sub" (-not (Seen-For $Q).sub)
$script:Seen = @{}; $script:AttWin = @{}
Step-Evidence @((W $ATT 101)) $Q $true $t0
Step-Evidence @((W $SUBM 101)) $Q $false $t0.AddSeconds(40)
Check "the turned-in page long after the attempt was last seen -> not sub" (-not (Seen-For $Q).sub)
$script:Seen = @{}; $script:AttWin = @{}
$CONF = "$B/d2l/lms/quizzing/user/quiz_confirm_finish.d2l?qi=12345&ou=98765"
Step-Evidence @((W $ATT 101)) $Q $true $t0
Step-Evidence @((W $CONF 101)) $Q $true $t0.AddSeconds(60)
Step-Evidence @((W $SUBM 101)) $Q $false $t0.AddSeconds(70)
Check "attempt, a minute on the 'submit?' page, then the turned-in page in that window -> sub" ((Seen-For $Q).sub -eq $true)
$script:Seen = @{}; $script:AttWin = @{}
$SUMQ = "$B/d2l/lms/quizzing/user/quiz_summary.d2l?qi=12345&ou=98765"
Step-Evidence @((W $ATT 101)) $Q $true $t0
Step-Evidence @((W $SUMQ 101)) $Q $true $t0.AddSeconds(3)
Step-Evidence @((W $SUBM 101)) $Q $false $t0.AddSeconds(6)
Check "attempt, its start page (attempt left), then a turned-in page in that window -> not sub" ((Seen-For $Q).sub -eq $false)
$script:Seen = @{}; $script:AttWin = @{}
Step-Evidence @((W "" 101 "Quiz 3 - ECON 203 - USC Brightspace")) $Q $true $t0
Check "the exam seen by its window title only (F11 / app window) -> attempt unknown, never 'none'" ($null -eq (Seen-For $Q).attempt)
$script:Seen = @{}; $script:Seen[$Q] = @{ attempt = $false; sub = $false; rt = $true; at = $t0; adopted = $true }
Check "an adopted lock -> attempt unknown" ($null -eq (Seen-For $Q).attempt)
Check "nothing seen at all -> sub false, attempt unknown" ((Seen-For "1-2").sub -eq $false -and $null -eq (Seen-For "1-2").attempt)
$sent = (@{ quiz_id = $Q; reason = "quiz_submitted"; seen = (Seen-For $Q) } | ConvertTo-Json -Compress)
Check "the unlock body carries seen as JSON booleans" ($sent -match '"seen":\{' -and $sent -match '"sub":false')

Write-Host "F the exam's own Firefox, open before the lock, is restarted once"
$script:stopped = @(); $script:started = @()
function Get-Process { param($Name, $ErrorAction) @([pscustomobject]@{ Id = 11; ProcessName = "firefox"; StartTime = (Get-Date).AddMinutes(-20); Path = "C:\Program Files\Mozilla Firefox\firefox.exe" },
                                                     [pscustomobject]@{ Id = 12; ProcessName = "firefox"; StartTime = (Get-Date).AddMinutes(-20); Path = $null }) }
function Stop-Process { param($Id, [switch]$Force, $ErrorAction) $script:stopped += $Id }
function Start-Process { param($FilePath) $script:started += $FilePath }
function Start-Sleep { param($Seconds, $Milliseconds) }
$r = Restart-QuizFirefox "firefox" ([DateTime]::UtcNow)
Check "Firefox running from before the lock: every process of it closed at once" ($r -and ($script:stopped -contains 11) -and ($script:stopped -contains 12))
Check "... and opened again from its own program file" ($script:started -contains "C:\Program Files\Mozilla Firefox\firefox.exe")
Check "... its exam page may be gone for up to 2 minutes meanwhile" ($script:RestartWait -gt [DateTime]::UtcNow.AddSeconds(100))
$script:stopped = @(); $script:started = @()
function Get-Process { param($Name, $ErrorAction) @([pscustomobject]@{ Id = 13; ProcessName = "firefox"; StartTime = (Get-Date).AddSeconds(5); Path = "C:\ff\firefox.exe" }) }
$r = Restart-QuizFirefox "firefox" ([DateTime]::UtcNow)
Check "a Firefox started after the lock (it read the quiz policies) is left alone" ((-not $r) -and $script:stopped.Count -eq 0 -and $script:started.Count -eq 0)
Remove-Item Function:\Get-Process, Function:\Stop-Process, Function:\Start-Process, Function:\Start-Sleep

Write-Host "K the helper: the agent's view as booleans; no answer + offline never lets an unlock stand"
foreach ($t in (FuncTexts "lockqzd.ps1" @("LQ-Seen","LQ-AskWait"))) { . ([scriptblock]::Create($t)) }
$v = LQ-Seen ([pscustomobject]@{ sub = $true; attempt = $false; extra = 1 })
Check "booleans passed on" ($v.sub -eq $true -and $v.attempt -eq $false -and $v.Keys.Count -eq 2)
$v = LQ-Seen ([pscustomobject]@{ sub = "yes"; attempt = "no" })
Check "anything else is not true" ($v.sub -eq $false -and $null -eq $v.attempt)
Check "nothing sent -> nothing" ($null -eq (LQ-Seen $null) -and $null -eq (LQ-Seen "x"))
$now = [int64]1800000000
$w = LQ-AskWait $null $now $false
Check "offline: held, the 10 minutes not started" ($w.held -and $null -eq $w.since)
$w = LQ-AskWait ($now - 3600) $now $false
Check "offline an hour after the first failed ask: still held, the count dropped" ($w.held -and $null -eq $w.since)
$w = LQ-AskWait $null $now $true
Check "online, no answer: held, the 10 minutes start now" ($w.held -and $w.since -eq $now)
$w = LQ-AskWait ($now - 599) $now $true
Check "online 9:59 later: still held" ($w.held)
$w = LQ-AskWait ($now - 601) $now $true
Check "online 10 minutes with no answer from LOCKqz: it stands (unchanged)" (-not $w.held)
$eng = Get-Content (Join-Path $Win "lockqz.ps1") -Raw
Check "SSH (port 22) is blocked for a quiz, not for Test it now (a vpn- rule)" ($eng -match '@\{ n = "\$FwTag-vpn-ssh"; p = @\{ Protocol = "TCP"; RemotePort = 22 \} \}')
Check "ssh / PuTTY / Termius and Android emulators are on the closed lists" ($eng -match '"ssh","putty"' -and $eng -match '"HD-Player"' -and $eng -match '"Proxifier"')
Check "a local model under any name: by its command line or a huge program file" ($eng -match 'ModelFileRe' -and $eng -match '-gt 1\.5GB')
Check "the model-file pattern matches llama.cpp, Ollama and Hugging Face paths, not ordinary ones" (('llama-server.exe -m C:\m\qwen.gguf --port 9' -match $( ([regex]::Match($eng, "\`$ModelFileRe = '([^']+)'")).Groups[1].Value )) -and
  ('C:\Users\a\.ollama\models\blobs\sha256-1' -match $( ([regex]::Match($eng, "\`$ModelFileRe = '([^']+)'")).Groups[1].Value )) -and
  -not ('C:\Program Files\Microsoft Office\WINWORD.EXE /n notes.docx' -match $( ([regex]::Match($eng, "\`$ModelFileRe = '([^']+)'")).Groups[1].Value )))

Write-Host ""
Write-Host "RESULT: $pass passed, $fail failed"
if ($fail) { exit 1 }
