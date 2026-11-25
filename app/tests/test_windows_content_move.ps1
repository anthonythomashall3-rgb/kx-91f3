# Real-browser test of the Content-quiz move (Windows): a quiz opened from Brightspace Content runs in a
# frame of /d2l/le/content/<ou>/fullscreen/<topic>/ViewLocation?location=<quiz>. The agent must move the
# tab to the quiz's own page through that window's address bar (UI Automation), exactly once, and must
# leave a Content page that is NOT a quiz alone. Runs the agent's OWN functions (parsed out of
# lockqz-agent.ps1) against real Chrome and Edge, under Windows PowerShell 5.1 like students.
param([string]$Agent = "$PSScriptRoot\..\windows\lockqz-agent.ps1", [string]$Out = "$env:TEMP\lqz-move")
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

# --- the agent's functions, unchanged -----------------------------------------------------------
$errs = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Agent).Path, [ref]$null, [ref]$errs)
if ($errs) { throw "agent does not parse: $errs" }
$want = 'Log','Url-Path','Url-Query','Inner-Url','Is-QuizPath','Is-Quiz','Is-Leaving','Lock-Id','Wait-Focus','Type-Address','Move-ToQuiz','Get-BrowserWindows'
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
# A test CA (trusted by this machine, so Firefox - which has no ignore-certificate switch - opens the
# page too) and a 127.0.0.1 certificate signed by it.
Set-Content -Path "$Out\leaf.ext" -Encoding ASCII -Value "subjectAltName=IP:127.0.0.1`nbasicConstraints=CA:FALSE`nextendedKeyUsage=serverAuth"
& $openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=LOCKqz Test CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -keyout "$Out\ca.key" -out "$Out\ca.pem" 2>&1 | Out-Null
& $openssl req -newkey rsa:2048 -nodes -subj "/CN=127.0.0.1" -keyout "$Out\key.pem" -out "$Out\leaf.csr" 2>&1 | Out-Null
& $openssl x509 -req -in "$Out\leaf.csr" -CA "$Out\ca.pem" -CAkey "$Out\ca.key" -CAcreateserial -days 1 -extfile "$Out\leaf.ext" -out "$Out\cert.pem" 2>&1 | Out-Null
$ErrorActionPreference = "Stop"
if (-not (Test-Path "$Out\cert.pem")) { throw "could not make a test certificate" }
Import-Certificate -FilePath "$Out\ca.pem" -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
$port = 8443; $hits = "$Out\hits.log"; Set-Content -Path $hits -Value ""
$py = (Get-Command python -ErrorAction Stop).Source
$srv = Start-Process -FilePath $py -ArgumentList @("`"$PSScriptRoot\fake_content_server.py`"", $port, "`"$hits`"", "`"$Out\cert.pem`"", "`"$Out\key.pem`"") -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
$base = "https://127.0.0.1:$port"
$quizPath = "/d2l/lms/quizzing/user/quiz_summary.d2l?qi=77&ou=123"
$contentQuiz = "$base/d2l/le/content/123/fullscreen/456/ViewLocation?tId=456&location=" + [Uri]::EscapeDataString($quizPath)
$contentFile = "$base/d2l/le/content/123/fullscreen/457/ViewLocation?tId=457&location=" + [Uri]::EscapeDataString("/d2l/le/content/123/viewContent/457/View")

# A browser this test starts may open behind other windows (Windows 11 keeps a background process from taking the
# foreground); the student's own browser is in front when they use it. Bring the test browser to the front the way
# a click would (an ALT key press first gives this process the right to), so the window can take the keyboard focus.
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class LqzFront {
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static void Front(IntPtr h) { keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); ShowWindow(h, 9); SetForegroundWindow(h); }
  public static string Fg() { IntPtr h = GetForegroundWindow(); uint p = 0; GetWindowThreadProcessId(h, out p); return h.ToString() + " pid " + p; }
  public static uint FgPid() { uint p = 0; GetWindowThreadProcessId(GetForegroundWindow(), out p); return p; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  public static string FgClass() { var b = new System.Text.StringBuilder(256); GetClassName(GetForegroundWindow(), b, 256); return b.ToString(); }
  public static void MinFg() { ShowWindow(GetForegroundWindow(), 6); }
}
'@
function Diag-Focus([string]$proc) {
  # When a check that needs the keyboard focus fails: which window is in front, and what has the focus after the
  # address bar is asked to take it (the move into the page works only when that is the address bar).
  try {
    $p = @(Get-Process $proc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero }) | Select-Object -First 1
    $fp = [int][LqzFront]::FgPid(); $fn = if ($fp) { [string](Get-Process -Id $fp -ErrorAction SilentlyContinue).ProcessName } else { "" }
    Write-Host ("  [focus] foreground window: {0} ({4}, class {5}); {1} main window {2} pid {3}" -f [LqzFront]::Fg(), $proc, $(if ($p) { $p.MainWindowHandle } else { "-" }), $(if ($p) { $p.Id } else { "-" }), $fn, [LqzFront]::FgClass())
    foreach ($w in $Root.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
      if ($BrowserClasses -notcontains $w.Current.ClassName) { continue }
      $e = $w.FindFirst($TS::Descendants, $script:AddressBar); if (-not $e) { continue }
      $err = ""; try { $e.SetFocus() } catch { $err = " (SetFocus: " + $_.Exception.Message + ")" }
      Start-Sleep -Milliseconds 300
      $f = [System.Windows.Automation.AutomationElement]::FocusedElement
      Write-Host ("  [focus] after SetFocus{0}: focused = {1} '{2}' class '{3}' pid {4}; is the address bar: {5}; HasKeyboardFocus: {6}" -f $err, $(if ($f) { $f.Current.ControlType.ProgrammaticName } else { "none" }), $(if ($f) { $f.Current.Name } else { "" }), $(if ($f) { $f.Current.ClassName } else { "" }), $(if ($f) { $f.Current.ProcessId } else { "" }), $(if ($f) { [System.Windows.Automation.Automation]::Compare($f, $e) } else { $false }), $e.Current.HasKeyboardFocus)
      Write-Host ("  [focus] this test runs in session {0}; the browser in session {1}" -f [System.Diagnostics.Process]::GetCurrentProcess().SessionId, (Get-Process -Id $w.Current.ProcessId).SessionId)
    }
  } catch { Write-Host "  [focus] diagnostics failed: $_" }
}
$script:Cleared = @{}; $script:Escs = 0
function Front-Browser([string]$proc) {
  $p = @(Get-Process $proc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero }) | Select-Object -First 1
  if (-not $p) { return }
  # A build machine's first sign-in can leave a Windows prompt in front ("Choose privacy settings for your device"),
  # which keeps every other window behind it: closed once, the way a student would answer it.
  try {
    $fg = [int][LqzFront]::FgPid()
    $n = if ($fg) { [string](Get-Process -Id $fg -ErrorAction SilentlyContinue).ProcessName } else { "" }
    $shells = @("explorer","powershell","pwsh","conhost","WindowsTerminal","OpenConsole","Runner.Listener","Runner.Worker","dwm","csrss","winlogon","ShellExperienceHost","StartMenuExperienceHost","SearchHost","TextInputHost","LockApp")
    if ($n -and ($n -ne $proc) -and ($shells -notcontains $n) -and -not $script:Cleared.ContainsKey($n)) {
      $script:Cleared[$n] = 1; Write-Host "  (closing $n, a window in front of every other)"; Stop-Process -Id $fg -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 700
      $fg = [int][LqzFront]::FgPid(); $n = if ($fg) { [string](Get-Process -Id $fg -ErrorAction SilentlyContinue).ProcessName } else { "" }
    }
    # An open Start menu or search box keeps the browser behind it too: Escape closes it, as a student would.
    if ((@("SearchHost","StartMenuExperienceHost","SearchApp","ShellExperienceHost") -contains $n) -and ($script:Escs -lt 6)) {
      $script:Escs++; Write-Host "  (pressing Escape: $n, the Start menu or search, is in front)"
      [System.Windows.Forms.SendKeys]::SendWait("{ESC}"); Start-Sleep -Milliseconds 700
    }
    # A File Explorer window in front: put it down to the taskbar.
    if (($n -eq "explorer") -and (@("CabinetWClass","ExploreWClass") -contains [LqzFront]::FgClass()) -and ($script:Escs -lt 6)) {
      $script:Escs++; Write-Host "  (minimizing a File Explorer window in front)"; [LqzFront]::MinFg(); Start-Sleep -Milliseconds 500
    }
  } catch { }
  try { [LqzFront]::Front($p.MainWindowHandle) } catch { }
}
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
function Close-EdgeWelcome([string]$proc) {
  # Edge's own "welcome / make Edge your default" tab, opened in front of the test's tab on a new build machine (its
  # policies do not stop it there): closed once, as a student would close it. Only with Edge itself in front.
  if ($proc -ne "msedge") { return }
  if (@(Bar-Values | Where-Object { $_ -match '(?i)explore\.microsoft\.com/[^ ]*edge/|edge://welcome|microsoftedgewelcome' }).Count -eq 0) { return }
  Front-Browser $proc; Start-Sleep -Milliseconds 500
  $fp = [int][LqzFront]::FgPid()
  if ((-not $fp) -or ([string](Get-Process -Id $fp -ErrorAction SilentlyContinue).ProcessName -ne "msedge")) { Write-Host "  (Edge's welcome tab is in front, but Edge is not the window in front)"; return }
  Write-Host "  (closing Edge's welcome tab, in front of the test's tab)"
  [System.Windows.Forms.SendKeys]::SendWait("^w"); Start-Sleep -Seconds 1
}
function Bar-Values {
  # Raw address-bar text of every browser window (what the student sees), read the same way the agent does.
  $vals = @()
  foreach ($w in $Root.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($BrowserClasses -notcontains $w.Current.ClassName) { continue }
    $e = $w.FindFirst($TS::Descendants, $script:AddressBar)   # set by the agent's Get-BrowserWindows
    $vp = $null; if ($e -and $e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $vals += [string]$vp.Current.Value }
  }
  $vals
}

function Dump-Tree($proc) {
  # Diagnostics when a check fails: what UI Automation shows for that browser's windows.
  foreach ($w in $Root.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    $pn = [string](Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName
    if ($pn -ne $proc) { continue }
    Write-Host ("  [window] class={0} name={1}" -f $w.Current.ClassName, $w.Current.Name)
    $n = 0
    foreach ($e in $w.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
      $ct = $e.Current.ControlType.ProgrammaticName
      if ($ct -notmatch 'Edit|ComboBox|Document|ToolBar|Pane|Group') { continue }
      $vp = $null; $val = ""
      if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $val = "value=" + [string]$vp.Current.Value }
      Write-Host ("    {0} name='{1}' id='{2}' class='{3}' {4}" -f $ct, $e.Current.Name, $e.Current.AutomationId, $e.Current.ClassName, $val)
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

  # 1) A Content page that is NOT a quiz: never moved.
  Set-Content -Path $hits -Value ""; Remove-Item "$Out\agent.log" -ErrorAction SilentlyContinue; $script:Moved = @{}
  Start-Process -FilePath $b.Exe -ArgumentList ($common + @($nw, "`"$contentFile`""))
  # Wait for the page itself (a cold first browser start on a slow runner can take well over 12 s), then
  # a few more seconds so a wrong move of this non-quiz page would have time to show up.
  for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Seconds 1; [void](Get-BrowserWindows); if ((Get-Content $hits -Raw) -match 'document /d2l/le/content/123/fullscreen/457/') { break } }
  if ($i -ge 20) { Write-Host "  ($($b.Name) took $i s to load the first page)" }
  for ($i = 0; $i -lt 6; $i++) { Start-Sleep -Seconds 1; [void](Get-BrowserWindows) }
  $h = Get-Content $hits -Raw
  Check ($h -match 'document /d2l/le/content/123/fullscreen/457/') "$($b.Name): the Content page loaded"
  Check (-not ($h -match 'document /d2l/le/content/123/viewContent/457/View')) "$($b.Name): a non-quiz Content page is left alone"
  Check (-not (Test-Path "$Out\agent.log") -or -not ((Get-Content "$Out\agent.log" -Raw) -match 'moved')) "$($b.Name): nothing logged as moved"
  Get-Process $b.Proc -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 2

  # 2) A quiz opened from Content: moved to its own page, once.
  Set-Content -Path $hits -Value ""; Remove-Item "$Out\agent.log" -ErrorAction SilentlyContinue; $script:Moved = @{}
  Start-Process -FilePath $b.Exe -ArgumentList ($common + @($nw, "`"$contentQuiz`""))
  $wasMoved = $false; $seen = @()
  for ($i = 0; $i -lt 40 -and -not $wasMoved; $i++) {
    Start-Sleep -Seconds 1
    Front-Browser $b.Proc
    $wins = @(Get-BrowserWindows)
    $seen = @($wins | ForEach-Object { $_.Url })
    if ((Get-Content $hits -Raw) -match ('document ' + [regex]::Escape($quizPath))) { $wasMoved = $true }
  }
  for ($i = 0; $i -lt 12; $i++) { Start-Sleep -Seconds 1; [void](Get-BrowserWindows) }   # keep watching: no second move
  Shot "$($b.Name)-after"
  $h = Get-Content $hits -Raw
  Check ($h -match 'iframe /d2l/lms/quizzing/user/quiz_summary') "$($b.Name): the quiz first ran inside the Content frame"
  Check $wasMoved "$($b.Name): the tab now shows the quiz as its own page"
  Close-EdgeWelcome $b.Proc
  $bars = @(Bar-Values)
  Check (@($bars | Where-Object { $_ -match 'quizzing/user/quiz_summary\.d2l\?qi=77' }).Count -ge 1) "$($b.Name): the address bar shows the quiz URL ($($bars -join ' | '))"
  $log = if (Test-Path "$Out\agent.log") { Get-Content "$Out\agent.log" -Raw } else { "" }
  Check ([regex]::Matches($log, 'moved to its own page \(123-77\)').Count -eq 1) "$($b.Name): moved exactly once (agent log: $($log.Trim()))"
  Check (([regex]::Matches($h, 'document /d2l/lms/quizzing/user/quiz_summary')).Count -eq 1) "$($b.Name): the quiz page loaded once (no reload loop)"
  $wins = @(Get-BrowserWindows)
  Check (@($wins | Where-Object { Is-Quiz $_.Url }).Count -ge 1) "$($b.Name): the agent still sees the quiz (lock stays on)"
  if ($fail) { Diag-Focus $b.Proc; Dump-Tree $b.Proc }
  Get-Process $b.Proc -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 2
}
foreach ($n in $EdgeSet) { Remove-ItemProperty -Path $EdgePol -Name $n -ErrorAction SilentlyContinue }
Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
if ($fail) { Write-Host "$fail check(s) FAILED"; exit 1 }
Write-Host "Content-quiz move: all checks passed"
exit 0
