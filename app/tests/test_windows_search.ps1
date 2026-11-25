# Real-browser test of web search during a quiz (Windows): Chrome, Edge and Brave ignore a default-search policy on a
# PC nobody manages, and Firefox takes one only in its ESR edition, so a search typed in the address bar opens the
# engine's usual results page. During a quiz the agent sends that tab on to Google's Web results (udm=14, no AI
# answer) through the window's own address bar (UI Automation), once, and leaves Web results alone. Runs the agent's
# OWN functions (parsed out of lockqz-agent.ps1) against real Chrome, Edge and Firefox, under Windows PowerShell 5.1.
# No page has to load: www.google.com points at a closed local port, and the address bar is what is checked.
param([string]$Agent = "$PSScriptRoot\..\windows\lockqz-agent.ps1", [string]$Out = "$env:TEMP\lqz-search")
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
$want = 'Log','Url-Path','Url-Query','Url-Host','Inner-Url','Is-QuizPath','Is-Quiz','Is-Leaving','Lock-Id','Wait-Focus','Type-Address','Move-ToQuiz','Query-Map','Rewrite-Search','Is-Foreground','Move-ToSearch','Get-BrowserWindows'
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
$script:Moved = @{}; $script:SearchMoved = @{}
$WebOkUdm = @("14","2","12","7","36"); $WebOkTbm = @("isch","nws","vid","bks")
$script:Locked = $true

# www.google.com -> a closed local port (Firefox through the hosts file; Chromium through its own switch as well).
$hostsFile = "$env:WINDIR\System32\drivers\etc\hosts"
$hostsBefore = [IO.File]::ReadAllText($hostsFile)
[IO.File]::WriteAllText($hostsFile, $hostsBefore.TrimEnd() + "`r`n127.0.0.1 www.google.com # lqz-search-test`r`n")
ipconfig /flushdns | Out-Null

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
function Bar-Values {
  $vals = @()
  foreach ($w in $Root.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($BrowserClasses -notcontains $w.Current.ClassName) { continue }
    $e = $w.FindFirst($TS::Descendants, $script:AddressBar)
    $vp = $null; if ($e -and $e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $vals += [string]$vp.Current.Value }
  }
  $vals
}
$browsers = @(
  @{ Name = "Chrome"; Exe = "C:\Program Files\Google\Chrome\Application\chrome.exe"; Proc = "chrome" },
  @{ Name = "Edge";   Exe = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"; Proc = "msedge" },
  @{ Name = "Firefox"; Exe = "C:\Program Files\Mozilla Firefox\firefox.exe"; Proc = "firefox"; Gecko = $true }
)
$search = "https://www.google.com/search?q=lockqz+photosynthesis&sourceid=chrome&ie=UTF-8"
try {
  foreach ($b in $browsers) {
    if (-not (Test-Path $b.Exe)) { Write-Host "  FAIL $($b.Name) not installed"; $fail++; continue }
    Write-Host "== $($b.Name)"
    Get-Process $b.Proc -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 1
    $prof = "$Out\profile-$($b.Name)"; Remove-Item -Recurse -Force $prof -ErrorAction SilentlyContinue
    if ($b.Gecko) {
      New-Item -ItemType Directory -Force -Path $prof | Out-Null
      Set-Content -Path "$prof\user.js" -Encoding ASCII -Value @(
        'user_pref("network.trr.mode", 5);', 'user_pref("browser.aboutwelcome.enabled", false);',
        'user_pref("datareporting.policy.firstRunURL", "");', 'user_pref("browser.startup.homepage_override.mstone", "ignore");',
        'user_pref("trailhead.firstrun.didSeeAboutWelcome", true);', 'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);', 'user_pref("browser.tabs.warnOnClose", false);', 'user_pref("browser.sessionstore.resume_from_crash", false);')
    }
    $common = if ($b.Gecko) { @("-profile", "`"$prof`"", "-no-remote") } else { @("--user-data-dir=`"$prof`"", "--no-first-run", "--no-default-browser-check",
                "--host-resolver-rules=`"MAP www.google.com 127.0.0.1:9`"", "--disable-features=msEdgeFRE,msImplicitSignin,msEdgeSidebarV2", "--hide-crash-restore-bubble", "--start-maximized") }
    $nw = if ($b.Gecko) { "-new-window" } else { "--new-window" }
    Remove-Item "$Out\agent.log" -ErrorAction SilentlyContinue; $script:SearchMoved = @{}
    Start-Process -FilePath $b.Exe -ArgumentList ($common + @($nw, "`"$search`""))
    $sent = $false
    for ($i = 0; $i -lt 40 -and -not $sent; $i++) {
      Start-Sleep -Seconds 1
      Front-Browser $b.Proc
      [void](Get-BrowserWindows)
      if (@(Bar-Values | Where-Object { $_ -match 'udm=14' -and $_ -match 'lockqz' }).Count -ge 1) { $sent = $true }
    }
    for ($i = 0; $i -lt 12; $i++) { Start-Sleep -Seconds 1; [void](Get-BrowserWindows) }   # keep watching: Web results stay
    $bars = @(Bar-Values)
    Check $sent "$($b.Name): the search went to Google's Web results ($($bars -join ' | '))"
    $log = if (Test-Path "$Out\agent.log") { Get-Content "$Out\agent.log" -Raw } else { "" }
    Check ([regex]::Matches($log, "web search sent to Google's Web results").Count -eq 1) "$($b.Name): sent once, then left alone (agent log: $($log.Trim()))"
    Check (@($bars | Where-Object { $_ -match 'udm=14' }).Count -ge 1) "$($b.Name): the address bar still shows Web results"
    if (-not $sent) { Diag-Focus $b.Proc }
    Get-Process $b.Proc -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 2
  }
} finally {
  [IO.File]::WriteAllText($hostsFile, $hostsBefore); ipconfig /flushdns | Out-Null
  foreach ($n in $EdgeSet) { Remove-ItemProperty -Path $EdgePol -Name $n -ErrorAction SilentlyContinue }
}
if ($fail) { Write-Host "$fail check(s) FAILED"; exit 1 }
Write-Host "Web search during a quiz: all checks passed"
exit 0
