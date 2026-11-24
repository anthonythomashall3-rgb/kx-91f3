# Real-browser test of the quiz password entered by LOCKqz itself (Windows): on the quiz's start page the
# agent puts the password into the page's password box through UI Automation, so the student never types
# or pastes it. Runs the agent's OWN functions against real Chrome, Edge and Firefox, under Windows
# PowerShell 5.1 like students, with a stand-in Brightspace that reports what reached the page.
param([string]$Agent = "$PSScriptRoot\..\windows\lockqz-agent.ps1", [string]$Out = "$env:TEMP\lqz-fill")
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
# Edge's own welcome, promotion and "make Edge your default" tabs open in front of the test's page on a new build
# machine: off while this test runs (machine policies it sets itself), put back at its end.
$EdgePol = "HKLM:\SOFTWARE\Policies\Microsoft\Edge"; $EdgeSet = @()
try {
  if (-not (Test-Path $EdgePol)) { New-Item -Path $EdgePol -Force | Out-Null }
  foreach ($kv in @(@("HideFirstRunExperience", 1), @("PromotionalTabsEnabled", 0), @("DefaultBrowserSettingsCampaignEnabled", 0), @("ShowRecommendationsEnabled", 0))) {
    if ($null -eq (Get-ItemProperty -Path $EdgePol -Name $kv[0] -ErrorAction SilentlyContinue)) { New-ItemProperty -Path $EdgePol -Name $kv[0] -Value $kv[1] -PropertyType DWord -Force | Out-Null; $EdgeSet += $kv[0] }
  }
} catch { Write-Host "  (Edge's welcome tabs could not be turned off: $_)" }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$errs = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Agent).Path, [ref]$null, [ref]$errs)
if ($errs) { throw "agent does not parse: $errs" }
$want = 'Log','Url-Path','Url-Query','Inner-Url','Is-QuizPath','Is-Quiz','Is-Leaving','Lock-Id','Move-ToQuiz','Get-BrowserWindows','Fill-QuizPassword'
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
$script:Moved = @{}; $script:PwFilled = @{}

$openssl = @("C:\Program Files\Git\usr\bin\openssl.exe", "C:\Program Files\Git\mingw64\bin\openssl.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $openssl) { throw "openssl not found" }
$ErrorActionPreference = "Continue"
Set-Content -Path "$Out\leaf.ext" -Encoding ASCII -Value "subjectAltName=IP:127.0.0.1`nbasicConstraints=CA:FALSE`nextendedKeyUsage=serverAuth"
& $openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=LOCKqz Test CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -keyout "$Out\ca.key" -out "$Out\ca.pem" 2>&1 | Out-Null
& $openssl req -newkey rsa:2048 -nodes -subj "/CN=127.0.0.1" -keyout "$Out\key.pem" -out "$Out\leaf.csr" 2>&1 | Out-Null
& $openssl x509 -req -in "$Out\leaf.csr" -CA "$Out\ca.pem" -CAkey "$Out\ca.key" -CAcreateserial -days 1 -extfile "$Out\leaf.ext" -out "$Out\cert.pem" 2>&1 | Out-Null
$ErrorActionPreference = "Stop"
if (-not (Test-Path "$Out\cert.pem")) { throw "could not make a test certificate" }
Import-Certificate -FilePath "$Out\ca.pem" -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
$port = 8444; $hits = "$Out\hits.log"; Set-Content -Path $hits -Value ""
$py = (Get-Command python -ErrorAction Stop).Source
$srv = Start-Process -FilePath $py -ArgumentList @("`"$PSScriptRoot\fake_content_server.py`"", $port, "`"$hits`"", "`"$Out\cert.pem`"", "`"$Out\key.pem`"") -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
$base = "https://127.0.0.1:$port"
$startPage = "$base/d2l/lms/quizzing/user/quiz_start_frame_auto.d2l?ou=123&isprv=&qi=77&cfql=0&dnb=0"
$otherPage = "$base/d2l/lms/quizzing/user/quiz_start_frame_auto.d2l?ou=123"   # the same page, but not a quiz address (no qi)
$attemptPage = "$base/d2l/lms/quizzing/user/attempt/quiz_start_frame_auto.d2l?ou=123&qi=77"
$PW = "LQ-AB12CD34"

$fail = 0
function Check($ok, $what) { if ($ok) { Write-Host "  ok   $what" } else { Write-Host "  FAIL $what"; $script:fail++ } }
function Dump-Tree($proc) {
  foreach ($w in $Root.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    $pn = [string](Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName
    if ($pn -ne $proc) { continue }
    Write-Host ("  [window] class={0} name={1}" -f $w.Current.ClassName, $w.Current.Name)
    $n = 0
    foreach ($e in $w.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
      $ct = $e.Current.ControlType.ProgrammaticName
      if ($ct -notmatch 'Edit|Document|Button') { continue }
      Write-Host ("    {0} name='{1}' id='{2}' pw={3}" -f $ct, $e.Current.Name, $e.Current.AutomationId, $e.Current.IsPassword)
      if (++$n -ge 40) { break }
    }
  }
}
$browsers = @(
  @{ Name = "Chrome"; Exe = "C:\Program Files\Google\Chrome\Application\chrome.exe"; Proc = "chrome" },
  @{ Name = "Edge";   Exe = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"; Proc = "msedge" },
  @{ Name = "Firefox"; Exe = "C:\Program Files\Mozilla Firefox\firefox.exe"; Proc = "firefox"; Gecko = $true }
)
foreach ($b in $browsers) {
  if (-not (Test-Path $b.Exe)) { Write-Host "  FAIL $($b.Name) not installed"; $fail++; continue }
  Write-Host "== $($b.Name)"
  Get-Process $b.Proc -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 1
  $prof = "$Out\profile-$($b.Name)"; Remove-Item -Recurse -Force $prof -ErrorAction SilentlyContinue
  if ($b.Gecko) {
    New-Item -ItemType Directory -Force -Path $prof | Out-Null
    Set-Content -Path "$prof\user.js" -Encoding ASCII -Value @(
      'user_pref("security.enterprise_roots.enabled", true);', 'user_pref("browser.aboutwelcome.enabled", false);',
      'user_pref("datareporting.policy.firstRunURL", "");', 'user_pref("browser.startup.homepage_override.mstone", "ignore");',
      'user_pref("trailhead.firstrun.didSeeAboutWelcome", true);', 'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);', 'user_pref("browser.tabs.warnOnClose", false);', 'user_pref("browser.sessionstore.resume_from_crash", false);')
  }
  $common = if ($b.Gecko) { @("-profile", "`"$prof`"", "-no-remote") } else { @("--user-data-dir=`"$prof`"", "--no-first-run", "--no-default-browser-check", "--ignore-certificate-errors",
              "--disable-features=msEdgeFRE,msImplicitSignin,msEdgeSidebarV2", "--hide-crash-restore-bubble", "--start-maximized") }
  $nw = if ($b.Gecko) { "-new-window" } else { "--new-window" }

  # 1) The same page at an address that is not a quiz: nothing is entered.
  Set-Content -Path $hits -Value ""; $script:PwFilled = @{}
  Start-Process -FilePath $b.Exe -ArgumentList ($common + @($nw, "`"$otherPage`""))
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Seconds 1; if ((Get-Content $hits -Raw) -match 'document /d2l/lms/quizzing/user/quiz_start') { break } }
  $n0 = 0; for ($i = 0; $i -lt 5; $i++) { Start-Sleep -Seconds 1; $n0 += (Fill-QuizPassword $PW) }
  Check ((Get-Content $hits -Raw) -match 'document /d2l/lms/quizzing/user/quiz_start') "$($b.Name): the page loaded"
  Check ($n0 -eq 0 -and -not ((Get-Content $hits -Raw) -match '/pwlog')) "$($b.Name): a page that is not a quiz gets nothing entered"
  Get-Process $b.Proc -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 2

  # 2) The quiz's start page: the password is entered, in the password box only, once -- and only while
  #    this is the quiz LOCKqz locked (another quiz's start page open beside it gets nothing).
  Set-Content -Path $hits -Value ""; $script:PwFilled = @{}
  Start-Process -FilePath $b.Exe -ArgumentList ($common + @($nw, "`"$startPage`""))
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Seconds 1; if ((Get-Content $hits -Raw) -match 'document /d2l/lms/quizzing/user/quiz_start') { break } }
  $script:Quiz = "123-78"
  $n0 = 0; for ($i = 0; $i -lt 4; $i++) { Start-Sleep -Seconds 1; $n0 += (Fill-QuizPassword $PW) }
  Check ($n0 -eq 0 -and -not ((Get-Content $hits -Raw) -match '/pwlog')) "$($b.Name): another quiz's start page gets nothing entered"
  $script:Quiz = "123-77"
  $n1 = 0; $t0 = Get-Date
  for ($i = 0; $i -lt 25 -and $n1 -eq 0; $i++) { Start-Sleep -Seconds 1; $n1 += (Fill-QuizPassword $PW) }
  $took = [int]((Get-Date) - $t0).TotalSeconds
  if ($n1 -eq 0) {
    # A browser that never shows the page's contents to UI Automation (seen once on a build machine): opened again,
    # as a student would reload the start page (LOCKqz tells them where it enters the password after 40 s).
    Write-Host "  (no box after $took s: $($b.Name) opened again once)"
    Get-Process $b.Proc -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 2
    Set-Content -Path $hits -Value ""; $script:PwFilled = @{}
    Start-Process -FilePath $b.Exe -ArgumentList ($common + @($nw, "`"$startPage`""))
    for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Seconds 1; if ((Get-Content $hits -Raw) -match 'document /d2l/lms/quizzing/user/quiz_start') { break } }
    $t0 = Get-Date
    for ($i = 0; $i -lt 25 -and $n1 -eq 0; $i++) { Start-Sleep -Seconds 1; $n1 += (Fill-QuizPassword $PW) }
    $took = "$([int]((Get-Date) - $t0).TotalSeconds) s after opening it again; first try over 25"
  }
  Start-Sleep -Seconds 3
  $h = Get-Content $hits -Raw
  Check ($n1 -eq 1) "$($b.Name): one password box found and filled (after $took s)"
  Check ($h -match ('/pwlog\?(pw|poll)=' + [regex]::Escape($PW) + '(\s|$)')) "$($b.Name): the page really holds the password"
  Check (-not ($h -match '/pwlog\?text=')) "$($b.Name): the other box on the page is untouched"
  $n2 = 0; for ($i = 0; $i -lt 4; $i++) { Start-Sleep -Seconds 1; $n2 += (Fill-QuizPassword $PW) }
  Check ($n2 -eq 0) "$($b.Name): the same box is not filled twice"
  $n3 = Fill-QuizPassword "LQ-ZZ99YY88"; Start-Sleep -Seconds 3
  Check ($n3 -eq 1 -and ((Get-Content $hits -Raw) -match '/pwlog\?(pw|poll)=LQ-ZZ99YY88')) "$($b.Name): a changed password replaces it"
  Get-Process $b.Proc -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 2

  # 3) A page whose password box is a plain box labelled Password: entered too.
  Set-Content -Path $hits -Value ""; $script:PwFilled = @{}
  Start-Process -FilePath $b.Exe -ArgumentList ($common + @($nw, "`"$startPage&kind=text`""))
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Seconds 1; if ((Get-Content $hits -Raw) -match 'document /d2l/lms/quizzing/user/quiz_start') { break } }
  $n4 = 0; for ($i = 0; $i -lt 25 -and $n4 -eq 0; $i++) { Start-Sleep -Seconds 1; $n4 += (Fill-QuizPassword $PW) }
  Start-Sleep -Seconds 3; $h = Get-Content $hits -Raw
  Check ($n4 -eq 1 -and ($h -match ('/pwlog\?(pw|poll)=' + [regex]::Escape($PW) + '(\s|$)'))) "$($b.Name): a plain box labelled Password is filled"
  Check (-not ($h -match '/pwlog\?text=')) "$($b.Name): the Notes box beside it is untouched"

  # 4) Inside the attempt: nothing is ever entered (answer boxes).
  Set-Content -Path $hits -Value ""; $script:PwFilled = @{}
  Get-Process $b.Proc -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 2
  Start-Process -FilePath $b.Exe -ArgumentList ($common + @($nw, "`"$attemptPage`""))
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Seconds 1; if ((Get-Content $hits -Raw) -match 'document /d2l/lms/quizzing/user/attempt/quiz_start') { break } }
  $n5 = 0; for ($i = 0; $i -lt 5; $i++) { Start-Sleep -Seconds 1; $n5 += (Fill-QuizPassword $PW) }
  Check ($n5 -eq 0 -and -not ((Get-Content $hits -Raw) -match '/pwlog')) "$($b.Name): nothing is entered inside the attempt"
  if ($fail) { Dump-Tree $b.Proc; Write-Host (Get-Content $hits -Raw) }
  Get-Process $b.Proc -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 2
  $script:Quiz = $null
}
foreach ($n in $EdgeSet) { Remove-ItemProperty -Path $EdgePol -Name $n -ErrorAction SilentlyContinue }
Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
if ($fail) { Write-Host "$fail check(s) FAILED"; exit 1 }
Write-Host "all checks passed"
