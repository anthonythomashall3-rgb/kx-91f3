# Real-browser test of the Content-quiz move (Windows): a quiz opened from Brightspace Content runs in a
# frame of /d2l/le/content/<ou>/fullscreen/<topic>/ViewLocation?location=<quiz>. The agent must move the
# tab to the quiz's own page through that window's address bar (UI Automation), exactly once, and must
# leave a Content page that is NOT a quiz alone. Runs the agent's OWN functions (parsed out of
# lockqz-agent.ps1) against real Chrome and Edge, under Windows PowerShell 5.1 like students.
param([string]$Agent = "$PSScriptRoot\..\windows\lockqz-agent.ps1", [string]$Out = "$env:TEMP\lqz-move")
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
New-Item -ItemType Directory -Force -Path $Out | Out-Null

# --- the agent's functions, unchanged -----------------------------------------------------------
$errs = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Agent).Path, [ref]$null, [ref]$errs)
if ($errs) { throw "agent does not parse: $errs" }
$want = 'Log','Url-Path','Url-Query','Inner-Url','Is-QuizPath','Is-Quiz','Is-Leaving','Lock-Id','Move-ToQuiz','Get-BrowserWindows'
$got = @()
foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
  if ($want -contains $f.Name) { . ([scriptblock]::Create($f.Extent.Text)); $got += $f.Name }
}
$missing = $want | Where-Object { $got -notcontains $_ }
if ($missing) { throw "agent functions not found: $missing" }
$UserDir = $Out
$BrowserClasses = @("Chrome_WidgetWin_1","MozillaWindowClass")
$Root = [System.Windows.Automation.AutomationElement]::RootElement
$TS = [System.Windows.Automation.TreeScope]; $CT = [System.Windows.Automation.ControlType]; $AE = [System.Windows.Automation.AutomationElement]
$script:Moved = @{}

# --- a stand-in Brightspace over HTTPS on 127.0.0.1 ---------------------------------------------
$openssl = @("C:\Program Files\Git\usr\bin\openssl.exe", "C:\Program Files\Git\mingw64\bin\openssl.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $openssl) { throw "openssl not found" }
$ErrorActionPreference = "Continue"   # openssl writes progress to stderr
& $openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=127.0.0.1" -keyout "$Out\key.pem" -out "$Out\cert.pem" 2>&1 | Out-Null
$ErrorActionPreference = "Stop"
if (-not (Test-Path "$Out\cert.pem")) { throw "could not make a test certificate" }
$port = 8443; $hits = "$Out\hits.log"; Set-Content -Path $hits -Value ""
$py = (Get-Command python -ErrorAction Stop).Source
$srv = Start-Process -FilePath $py -ArgumentList @("`"$PSScriptRoot\fake_content_server.py`"", $port, "`"$hits`"", "`"$Out\cert.pem`"", "`"$Out\key.pem`"") -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
$base = "https://127.0.0.1:$port"
$quizPath = "/d2l/lms/quizzing/user/quiz_summary.d2l?qi=77&ou=123"
$contentQuiz = "$base/d2l/le/content/123/fullscreen/456/ViewLocation?tId=456&location=" + [Uri]::EscapeDataString($quizPath)
$contentFile = "$base/d2l/le/content/123/fullscreen/457/ViewLocation?tId=457&location=" + [Uri]::EscapeDataString("/d2l/le/content/123/viewContent/457/View")

$fail = 0
function Check($ok, $what) { if ($ok) { Write-Host "  ok   $what" } else { Write-Host "  FAIL $what"; $script:fail++ } }
function Shot($name) {
  try {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    $bmp.Save("$Out\$name.png"); $g.Dispose(); $bmp.Dispose()
  } catch { }
}
function Bar-Values {
  # Raw address-bar text of every browser window (what the student sees), read the same way the agent does.
  $vals = @()
  foreach ($w in $Root.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($BrowserClasses -notcontains $w.Current.ClassName) { continue }
    $e = $w.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Edit)))
    $vp = $null; if ($e -and $e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $vals += [string]$vp.Current.Value }
  }
  $vals
}

$browsers = @(
  @{ Name = "Chrome"; Exe = "C:\Program Files\Google\Chrome\Application\chrome.exe"; Proc = "chrome" },
  @{ Name = "Edge";   Exe = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"; Proc = "msedge" }
)
foreach ($b in $browsers) {
  if (-not (Test-Path $b.Exe)) { Write-Host "  FAIL $($b.Name) not installed"; $fail++; continue }
  Write-Host "== $($b.Name)"
  Get-Process $b.Proc -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 1
  $prof = "$Out\profile-$($b.Name)"; Remove-Item -Recurse -Force $prof -ErrorAction SilentlyContinue
  $common = @("--user-data-dir=`"$prof`"", "--no-first-run", "--no-default-browser-check", "--ignore-certificate-errors",
              "--disable-features=msEdgeFRE,msImplicitSignin,msEdgeSidebarV2", "--hide-crash-restore-bubble", "--start-maximized")

  # 1) A Content page that is NOT a quiz: never moved.
  Set-Content -Path $hits -Value ""; Remove-Item "$Out\agent.log" -ErrorAction SilentlyContinue; $script:Moved = @{}
  Start-Process -FilePath $b.Exe -ArgumentList ($common + @("--new-window", "`"$contentFile`""))
  for ($i = 0; $i -lt 12; $i++) { Start-Sleep -Seconds 1; [void](Get-BrowserWindows) }
  $h = Get-Content $hits -Raw
  Check ($h -match 'document /d2l/le/content/123/fullscreen/457/') "$($b.Name): the Content page loaded"
  Check (-not ($h -match 'document /d2l/le/content/123/viewContent/457/View')) "$($b.Name): a non-quiz Content page is left alone"
  Check (-not (Test-Path "$Out\agent.log") -or -not ((Get-Content "$Out\agent.log" -Raw) -match 'moved')) "$($b.Name): nothing logged as moved"
  Get-Process $b.Proc -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 2

  # 2) A quiz opened from Content: moved to its own page, once.
  Set-Content -Path $hits -Value ""; Remove-Item "$Out\agent.log" -ErrorAction SilentlyContinue; $script:Moved = @{}
  Start-Process -FilePath $b.Exe -ArgumentList ($common + @("--new-window", "`"$contentQuiz`""))
  $moved = $false; $seen = @()
  for ($i = 0; $i -lt 40 -and -not $moved; $i++) {
    Start-Sleep -Seconds 1
    $wins = @(Get-BrowserWindows)
    $seen = @($wins | ForEach-Object { $_.Url })
    if ((Get-Content $hits -Raw) -match ('document ' + [regex]::Escape($quizPath))) { $moved = $true }
  }
  for ($i = 0; $i -lt 12; $i++) { Start-Sleep -Seconds 1; [void](Get-BrowserWindows) }   # keep watching: no second move
  Shot "$($b.Name)-after"
  $h = Get-Content $hits -Raw
  Check ($h -match 'iframe /d2l/lms/quizzing/user/quiz_summary') "$($b.Name): the quiz first ran inside the Content frame"
  Check $moved "$($b.Name): the tab now shows the quiz as its own page"
  $bars = @(Bar-Values)
  Check (@($bars | Where-Object { $_ -match 'quizzing/user/quiz_summary\.d2l\?qi=77' }).Count -ge 1) "$($b.Name): the address bar shows the quiz URL ($($bars -join ' | '))"
  $log = if (Test-Path "$Out\agent.log") { Get-Content "$Out\agent.log" -Raw } else { "" }
  Check ([regex]::Matches($log, 'moved to its own page \(123-77\)').Count -eq 1) "$($b.Name): moved exactly once (agent log: $($log.Trim()))"
  Check (([regex]::Matches($h, 'document /d2l/lms/quizzing/user/quiz_summary')).Count -eq 1) "$($b.Name): the quiz page loaded once (no reload loop)"
  $wins = @(Get-BrowserWindows)
  Check (@($wins | Where-Object { Is-Quiz $_.Url }).Count -ge 1) "$($b.Name): the agent still sees the quiz (lock stays on)"
  Get-Process $b.Proc -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 2
}
Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
if ($fail) { Write-Host "$fail check(s) FAILED"; exit 1 }
Write-Host "Content-quiz move: all checks passed"
exit 0
