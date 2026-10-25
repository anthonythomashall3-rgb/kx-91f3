# LOCKqz agent (Windows). Runs in the student's session at logon (scheduled task).
# Replaces the browser extension, so the student installs ONE thing - nothing from the
# Chrome Web Store. Every 2 s it reads the address bar + tab titles of every Chrome/Edge/
# Brave/Firefox window through Windows UI Automation (no browser permission needed) and:
#   * on a Brightspace quiz attempt page -> tells the helper to LOCK, then asks the helper
#     for the quiz password (the helper checks its block and signs the request with its
#     SYSTEM-only device key), shows it and copies it to the clipboard
#   * while locked                       -> pings the backend (teacher's live monitor)
#   * when the quiz tab is gone (submitted / left) -> tells the helper to UNLOCK
# First run asks the student's school email ONCE (confirmed by an emailed code) so the
# professor's roster and the quiz gate know who is locked. -Setup runs that dialog in its own
# process so quiz watching never waits on it.
param([switch]$Setup, [switch]$QuizOpen)
$ErrorActionPreference = "SilentlyContinue"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing, Microsoft.VisualBasic

$ConfPath = "$env:ProgramData\LOCKqz\config.json"
$Conf  = if (Test-Path $ConfPath) { Get-Content $ConfPath -Raw | ConvertFrom-Json } else { @{} }
$Port  = if ($Conf.port) { [int]$Conf.port } else { 8787 }
$Token = if ($Conf.token) { $Conf.token } else { "lockqz-dev" }
$Api   = if ($Conf.api_base) { $Conf.api_base.TrimEnd("/") } else { "" }
if ($Api -and -not $Api.EndsWith("/api")) { $Api += "/api" }   # accept a bare site URL too
$Device= if ($Conf.device_id) { $Conf.device_id } else { "unknown" }
$UserDir = "$env:APPDATA\LOCKqz"; New-Item -ItemType Directory -Force -Path $UserDir | Out-Null
$StudentFile = "$UserDir\student.json"
$Poll = 2; $PollLocked = 1; $Grace = 30; $Beat = 60; $HelperOk = $true   # agent reports only while the helper is unreachable
$BrowserClasses = @("Chrome_WidgetWin_1","MozillaWindowClass")

function Log($m) {
  $lf = "$UserDir\agent.log"
  try { if ((Get-Item -LiteralPath $lf -ErrorAction Stop).Length -gt 1000000) { Move-Item -LiteralPath $lf "$lf.1" -Force } } catch { }   # never past ~2 MB
  Add-Content -Path $lf -Value ("{0} {1}" -f (Get-Date -Format s), $m)
}
# Brightspace URL rules (tests/test_url_parsing.mjs runs these exact functions). Each rule looks at ONE
# part of the URL, so a word in another parameter (?returnUrl=...results) or a quiz path quoted in a
# query string can never lock or unlock anything. The address bar may show the URL without "https://".
# Taking a quiz: /d2l/lms/quizzing/user/... ; previewing one (TAs/staff): .../preview... or ?isprv=1
function Url-Path([string]$u) { if ($u -match '^(?:[A-Za-z][A-Za-z0-9+.-]*://)?[^/?#]*([^?#]*)') { return $Matches[1] }; return "" }
function Url-Query([string]$u) { $i = $u.IndexOf("?"); if ($i -lt 0) { return "" }; $q = $u.Substring($i + 1); $h = $q.IndexOf("#"); if ($h -ge 0) { $q = $q.Substring(0, $h) }; return $q }
function Is-QuizPath($u) { $p = Url-Path ([string]$u); ($p -match '^/d2l/lms/quizzing/(user/|.*preview)') -or (($p -match '^/d2l/lms/quizzing/') -and ((Url-Query ([string]$u)) -match '(^|&)isprv=1(&|$)')) }
function Is-Quiz($u)    { (Is-QuizPath $u) -and [regex]::IsMatch([string]$u, '[?&]qi=\d') -and -not (Is-Leaving $u) }
# Brightspace quiz-attempt pages carry "Quiz" (and often the LMS name) in the window title; used ONLY for
# a window whose address bar can't be read (F11 / PWA), so going fullscreen can't drop a lock silently.
function Is-QuizByTitle($t) { $t -match "Quiz" -and $t -match "Brightspace|D2L|Attempt" }
function Is-Leaving($u) { (Is-QuizPath $u) -and ((Url-Path ([string]$u)) -match 'quizzes_list|quiz_submissions|feedback|results|submission') }
function Clean-Title([string]$t) {
  # Window title -> page title: drops zero-width characters (Edge writes "Microsoft<U+200B> Edge"),
  # " and N more pages" and the browser-name suffix (" - Google Chrome - Profile", " - Mozilla Firefox").
  # Edge's profile segment (" - Personal") stays; it is the same in every window of that profile.
  if (-not $t) { return "" }
  $t = $t -replace '[\u200b-\u200f\u2060\ufeff]', ''
  $t = $t -replace '\s+and \d+ more pages?(?=\s[-\u2013\u2014]\s)', ''
  $t = $t -replace '\s[-\u2013\u2014]\s(Google Chrome|Microsoft\W*Edge|Brave|Mozilla Firefox|Firefox|Opera|Vivaldi|Chromium)(\W.*)?$', ''
  return $t.Trim()
}
function Get-ActiveTab($win) {
  # The tab whose title the window title starts with (longest match) = the active tab's title.
  $t = Clean-Title $win.Title; $best = ""
  foreach ($n in @($win.Tabs)) { $n = [string]$n; if ($n.Length -gt $best.Length -and $t.StartsWith($n, [StringComparison]::Ordinal)) { $best = $n } }
  return $best
}
function Test-TitlePresent($wins, [string]$tab, [string]$title) {
  # Is the quiz page still open in some tab of some window (active or not)? Never matches on an
  # empty/unknown title (an adopted lock), so it can't keep AI blocked by matching every window.
  foreach ($w in @($wins)) {
    if ($tab -and (@($w.Tabs) -contains $tab)) { return $true }
    if ($title -and $title.Length -ge 3 -and (Clean-Title $w.Title).StartsWith($title, [StringComparison]::Ordinal)) { return $true }
  }
  return $false
}
function Step-Locked($wins, $quizWin, [string]$tab, [string]$title, $missingSince, [datetime]$now, [int]$grace) {
  # One tick while locked -> @{ Present; Reason (unlock now, or $null); MissingSince }.
  # Order matters: a quiz-attempt URL anywhere keeps the lock; then a Brightspace "after the quiz"
  # page (submitted / back to the list) ends it at once, BEFORE any title heuristic, because those
  # pages are titled "Quizzes - <course> - <school> Brightspace" too.
  $r = @{ Present = $false; Reason = $null; MissingSince = $missingSince }
  if ($null -ne $quizWin) { $r.Present = $true; $r.MissingSince = $null; return $r }
  $leave = @($wins | Where-Object { Is-Leaving $_.Url }) | Select-Object -First 1
  if ($leave) { $r.Reason = $(if ($leave.Url -match "quizzes_list") { "quiz_left" } else { "quiz_submitted" }); return $r }
  if ((Test-TitlePresent $wins $tab $title) -or (@($wins | Where-Object { (-not $_.Url) -and (Is-QuizByTitle $_.Title) }).Count -gt 0)) {
    $r.Present = $true; $r.MissingSince = $null; return $r
  }
  if (-not $missingSince) { $r.MissingSince = $now; return $r }
  if (($now - [datetime]$missingSince).TotalSeconds -gt $grace) {
    $r.Reason = $(if (@($wins | Where-Object { $_.Url -match "/d2l/" }).Count -gt 0) { "quiz_left" } else { "quiz_tab_closed" })
  }
  return $r
}
function Lock-Id($u) {
  $qi = [regex]::Match([string]$u, '[?&]qi=(\d+)'); $ou = [regex]::Match([string]$u, '[?&]ou=(\d+)')
  "$(if ($ou.Success) { $ou.Groups[1].Value } else { 'x' })-$(if ($qi.Success) { $qi.Groups[1].Value } else { 'x' })"
}

$Root = [System.Windows.Automation.AutomationElement]::RootElement
$TS   = [System.Windows.Automation.TreeScope]
$CT   = [System.Windows.Automation.ControlType]
$AE   = [System.Windows.Automation.AutomationElement]
function Get-BrowserWindows {
  # -> objects { Title, Url (active tab), Tabs (all tab titles) } for every browser window.
  $out = @(); $names = @{}
  $wins = $Root.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($w in $wins) {
    if ($BrowserClasses -notcontains $w.Current.ClassName) { continue }
    $wpid = $w.Current.ProcessId
    if (-not $names.ContainsKey($wpid)) { $names[$wpid] = [string](Get-Process -Id $wpid -ErrorAction SilentlyContinue).ProcessName }
    $url = ""
    $edit = $w.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Edit)))
    if ($edit) { $vp = $null; if ($edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $url = $vp.Current.Value } }
    $tabs = @()
    foreach ($t in $w.FindAll($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::TabItem)))) { $tabs += $t.Current.Name }
    $out += [pscustomobject]@{ Title = $w.Current.Name; Url = $url; Tabs = $tabs; Proc = $names[$wpid] }
  }
  $out
}

function Helper($path, $body, $timeout = 90) {
  $h = @{ "X-LOCKqz-Token" = $Token }
  if ($null -ne $body) { Invoke-RestMethod -Uri "http://127.0.0.1:$Port$path" -Method Post -Headers $h -Body ($body | ConvertTo-Json -Compress) -ContentType "application/json" -TimeoutSec $timeout }
  else { Invoke-RestMethod -Uri "http://127.0.0.1:$Port$path" -Headers $h -TimeoutSec $timeout }
}
function Api($path, $body) {
  if (-not $Api) { return $null }
  try { Invoke-RestMethod -Uri "$Api$path" -Method Post -Body ($body | ConvertTo-Json -Compress) -ContentType "application/json" -TimeoutSec 8 -UserAgent "LOCKqz-agent (Windows)" } catch { $null }
}
function Show-Pay($r) {
  # Student fee unpaid: open the payment page once per quiz; the password follows when the payment arrives.
  if (-not $r -or -not $r.pay) { return $false }
  if (-not $script:PayShown) {
    $script:PayShown = $true
    $u = [string]$r.pay.url; if (-not $u.StartsWith("https://lockqz.pages.dev/")) { $u = "https://lockqz.pages.dev/pay" }
    try { Start-Process $u } catch {}
    $amt = if ($r.pay.amount) { $r.pay.amount } else { 5 }
    Show-Message ("Pay `$$amt for LOCKqz this semester to get the quiz password.`n`nMemo:  " + $r.pay.code + "`n`nThe payment page is open. LOCKqz shows the password here as soon as your payment arrives.")
  }
  return $true
}
function Show-Message($text) {
  # Non-blocking: the box runs in its own process so the watch loop never stalls.
  $safe = $text.Replace([char]39, [char]34)
  $cmd = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('" + $safe + "', 'LOCKqz') | Out-Null"
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
  Start-Process powershell -ArgumentList "-WindowStyle Hidden -EncodedCommand $enc" -WindowStyle Hidden
}

# Firefox (and its forks) read policies only when they start, so a Firefox already open when the lock
# begins would keep its AI features and AI search answers. Opera has no policy layer at all (Aria AI,
# built-in VPN past the hosts block). These are closed for the quiz - never the browser the quiz is in.
# A closed Firefox reopens with its tabs (it restores the session after a forced close).
$FirefoxFamily = @("firefox","librewolf","waterfox","floorp","zen","mullvadbrowser")
$NoPolicy = @("opera","opera_gx","opera_crashreporter")
function Close-Browsers($names, [string]$keep) {
  # -> $true when something was closed. Asks politely first (CloseMainWindow), then forces.
  $ps = @(Get-Process -Name $names -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -ne $keep })
  if ($ps.Count -eq 0) { return $false }
  foreach ($p in $ps) { try { [void]$p.CloseMainWindow() } catch { } }
  Start-Sleep -Seconds 3
  foreach ($p in $ps) { try { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } } catch { } }
  return $true
}

# ---- student email: asked ONCE per computer, confirmed by an emailed code ----
# The quiz gate admits a student by their Brightspace email, so it must be theirs: LOCKqz shows the
# roster name ("Is this you?") and binds the email only after the 6-digit code sent to it is typed.
# A typo or a classmate's email can never stick. An expired code is resent automatically.
$EmailRe = '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
$Ask = "Enter your school email (the one Brightspace uses, e.g. you@usc.edu):"
function Ask-Box($msg, $buttons, $default, [bool]$answer) {
  # Modal dialog that waits for the student (closes itself after 30 min). -> @{ b; t } or $null
  $f = New-Object System.Windows.Forms.Form
  $f.Text = "LOCKqz"; $f.TopMost = $true; $f.StartPosition = "CenterScreen"; $f.FormBorderStyle = "FixedDialog"
  $f.MaximizeBox = $false; $f.MinimizeBox = $false; $f.ClientSize = New-Object System.Drawing.Size(440, 220)
  $f.Font = New-Object System.Drawing.Font("Segoe UI", 10)
  $l = New-Object System.Windows.Forms.Label; $l.Text = $msg; $l.SetBounds(16, 12, 408, 116); $f.Controls.Add($l)
  $tb = $null
  if ($answer) { $tb = New-Object System.Windows.Forms.TextBox; $tb.Text = [string]$default; $tb.SetBounds(16, 132, 408, 26); $f.Controls.Add($tb) }
  $script:BoxPick = $null
  $x = 424
  for ($i = $buttons.Count - 1; $i -ge 0; $i--) {
    $btn = New-Object System.Windows.Forms.Button; $btn.Text = $buttons[$i]; $btn.Tag = $buttons[$i]
    $w = [Math]::Max(80, [System.Windows.Forms.TextRenderer]::MeasureText($buttons[$i], $f.Font).Width + 24)
    $x -= $w; $btn.SetBounds($x, 176, $w, 30); $x -= 8
    $btn.Add_Click({ $script:BoxPick = $this.Tag; $this.FindForm().Close() })
    $f.Controls.Add($btn)
    if ($i -eq $buttons.Count - 1) { $f.AcceptButton = $btn }
  }
  $tm = New-Object System.Windows.Forms.Timer; $tm.Interval = 1800000; $tm.Tag = $f
  $tm.Add_Tick({ $this.Stop(); $this.Tag.Close() }); $tm.Start()
  $f.Add_Shown({ $this.Activate() })
  [void]$f.ShowDialog(); $tm.Stop(); $tm.Dispose()
  $t = if ($tb) { $tb.Text.Trim() } else { "" }
  $f.Dispose()
  if (-not $script:BoxPick) { return $null }
  return @{ b = $script:BoxPick; t = $t }
}
function Say($msg) { Ask-Box $msg @("OK") "" $false | Out-Null }
function Verify($op, $extra) {
  $b = @{ op = $op }
  if ($extra) { foreach ($k in $extra.Keys) { $b[$k] = $extra[$k] } }
  $r = $null
  try { $r = Helper "/verify" $b } catch { Log "verify $op unreachable: $_"; return $null }
  if ($r -and $r.status) { return $r }
  return $null
}
# The email is asked ONCE: saved on this computer the moment it is typed; every later try goes straight
# to the emailed code. Server/network trouble is NEVER shown as a popup: setup stops quietly and the
# agent retries in the background (2, 4, 8 ... 60 min). State between tries lives in setup.json.
$SetupFile = "$UserDir\setup.json"
$CodeFresh = 720   # a code sent < 12 min ago is still good (server: 15 min): ask for it, don't resend
function Save-Student($email, $verified) {
  try { @{ student = $(if ($email) { $email } else { $null }); verified = [bool]$verified } | ConvertTo-Json | Set-Content $StudentFile -Encoding UTF8 }
  catch { Log "could not save student: $_" }
}
function Read-SetupState {
  $s = @{ next = 0; fails = 0; tried = 0; sent_email = ""; sent_at = 0; r = "" }
  try { if (Test-Path $SetupFile) { $j = Get-Content $SetupFile -Raw | ConvertFrom-Json; foreach ($k in @($s.Keys)) { if ($null -ne $j.$k) { $s[$k] = $j.$k } } } } catch {}
  return $s
}
function Write-SetupState($s) { try { $s | ConvertTo-Json | Set-Content $SetupFile -Encoding UTF8 } catch {} }
function Now-Sec { return [double][DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }
function Ask-Email($state) {
  $email = ""; $msg = "LOCKqz setup (one time only)`n`n" + $Ask
  while ($true) {
    $a = Ask-Box $msg @("OK") $email $true
    if (-not $a) { $state.r = "closed"; return $null }
    $email = ([string]$a.t).Trim().ToLower()
    if ($email -notmatch $EmailRe) { $msg = "That is not an email address.`n`n" + $Ask; continue }
    $chk = Verify "check" @{ email = $email }
    if (-not $chk) { return $email }   # server unreachable: keep what they typed (the code proves it later)
    if ($chk.name) { $a = Ask-Box ("Is this you?`n`n" + $chk.name + "`n" + $email) @("No, retype", "Yes") "" $false }
    else { $a = Ask-Box ($email + " is not on a LOCKqz class list yet.`n`nCheck the spelling.") @("Retype", "Use it") "" $false }
    if (-not $a) { $state.r = "closed"; return $null }
    if (($a.b -eq "No, retype") -or ($a.b -eq "Retype")) { $msg = $Ask; continue }
    return $email
  }
}
function Setup-Identity($saved, $state) {
  # -> @{ student; verified } to save, or $null ($state.r = "server": retry quietly; "closed": dialog closed)
  if ($null -eq $state) { $state = @{ sent_email = ""; sent_at = 0; r = "" } }
  $state.r = "server"
  $st = Verify "status" $null
  if (-not $st) { return $null }
  if ($st.verified -and $st.student) { return @{ student = $st.student; verified = $true } }
  if ((-not $st.codes) -and $st.student) { return @{ student = $st.student; verified = $false } }
  $email = ([string]$(if ($saved) { $saved } else { $st.student })).Trim().ToLower()
  if ($email -notmatch $EmailRe) { $email = "" }
  while ($true) {
    if (-not $email) {
      $email = Ask-Email $state
      if (-not $email) { return $null }
      Save-Student $email $false          # never asked again, whatever happens next
    }
    if (-not (($state.sent_email -eq $email) -and ((Now-Sec) - [double]$state.sent_at -lt $CodeFresh))) {
      $r = Verify "send" @{ email = $email }
      if ($r -and $r.bound) { return @{ student = $email; verified = $false } }
      if (-not ($r -and $r.sent)) { Log "code not sent ($(if ($r) { $r.error } else { 'no answer' })): will retry quietly"; return $null }
      $state.sent_email = $email; $state.sent_at = Now-Sec
    }
    $note = ""
    while ($true) {
      $a = Ask-Box ($note + "We emailed a 6-digit code to`n" + $email + "`n`nType it here (check Junk/Spam if you don't see it):") @("Change email", "Send new code", "OK") "" $true
      if (-not $a) { $state.r = "closed"; return $null }
      if ($a.b -eq "Change email") { $email = ""; $state.sent_email = ""; Save-Student $null $false; break }
      if ($a.b -eq "Send new code") {
        $r = Verify "send" @{ email = $email }
        if (-not ($r -and $r.sent)) { $note = "LOCKqz couldn't send a new code right now. Use the last one, or try again in a few minutes.`n`n"; continue }
        $state.sent_email = $email; $state.sent_at = Now-Sec
        $note = "New code sent.`n`n"; continue
      }
      $r = Verify "code" @{ email = $email; code = $a.t }
      if ($r -and $r.verified) { $state.sent_email = ""; Say "Done. LOCKqz is set up and won't ask again."; return @{ student = $email; verified = $true } }
      if ($r -and $r.resent) {
        $state.sent_email = $email; $state.sent_at = Now-Sec
        if ($r.error -eq "expired") { $note = "That code expired. We sent a new one.`n`n" }
        elseif ($r.error -eq "too_many_tries") { $note = "Too many wrong tries. We sent a new code.`n`n" }
        else { $note = "We sent a new code.`n`n" }
        continue
      }
      if ($r -and ($r.error -eq "wrong_code")) { $note = "That code is wrong (" + $r.tries_left + " tries left).`n`n"; continue }
      Log "code check failed ($(if ($r) { $r.error } else { 'no answer' })): will retry quietly"; return $null
    }
  }
}

if ($Setup) {
  # One setup window at a time per user session.
  $mtx = New-Object System.Threading.Mutex($false, "Local\LOCKqzSetup")
  if (-not $mtx.WaitOne(0)) { exit }
  $state = Read-SetupState; $state.tried = Now-Sec
  $saved = $null; try { if (Test-Path $StudentFile) { $saved = (Get-Content $StudentFile -Raw | ConvertFrom-Json).student } } catch {}
  $got = $null
  try { $got = Setup-Identity $saved $state } catch { Log "identity setup error: $_"; $state.r = "server" }
  if ($got) {
    Save-Student $got.student $got.verified
    $state.fails = 0; $state.next = 0
    try { Helper "/student" @{ student = $got.student } | Out-Null } catch {}
    Log "student $($got.student) verified=$($got.verified)"
  } elseif ($state.r -eq "closed") {
    $state.next = (Now-Sec) + $(if ($QuizOpen) { 600 } else { 21600 })
  } else {
    $state.fails = [int]$state.fails + 1
    $state.next = (Now-Sec) + [Math]::Min(3600, 120 * [Math]::Pow(2, [Math]::Min([int]$state.fails - 1, 5)))
  }
  Write-SetupState $state
  $mtx.ReleaseMutex(); exit
}

$Student = $null; $Verified = $false; $StudentRead = Get-Date "2000-01-01"; $SetupAt = Get-Date "2000-01-01"
function Load-Student {
  if (Test-Path $StudentFile) {
    $j = Get-Content $StudentFile -Raw | ConvertFrom-Json
    $script:Student = $j.student; $script:Verified = [bool]$j.verified; $script:StudentRead = (Get-Item $StudentFile).LastWriteTime
  }
}
function Start-Setup([switch]$Force, [switch]$Quiz) {
  # Quiet, spaced-out retries (setup.json): only when due, or when a quiz needs it and the last try
  # was 10+ min ago. Force = check now (login).
  $st = Read-SetupState; $now = Now-Sec
  if (-not $Force) {
    if (($now -lt [double]$st.next) -and -not ($Quiz -and ($now - [double]$st.tried -ge 600))) { return }
  }
  $script:SetupAt = Get-Date
  $qa = if ($Quiz) { " -QuizOpen" } else { "" }
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Setup$qa"
}
Load-Student
Start-Setup -Force   # checks the server once per login; asks only if not yet confirmed
try { Helper "/student" @{ student = $Student } 8 | Out-Null } catch { Log "helper not reachable yet" }
Log "running (device $Device, student $Student)"

# ---- main loop ----
$Locked = $false; $Quiz = $null; $QuizTab = $null; $QuizTitle = $null; $QuizUrl = $null; $QuizProc = ""
$LastPw = $null; $PwNext = Get-Date; $StartTold = $null; $MissingSince = $null; $LastBeat = Get-Date; $LastCheck = Get-Date "2000-01-01"
$Pending = $null; $PendingAt = Get-Date "2000-01-01"; $OperaWarned = $false
# Quizzes the helper released (safety cap, the server's "submitted"/"ended", another school): never
# re-locked while their page stays open; forgotten once the page has been gone for the grace period.
$Capped = @{}
$CapLeft = @{}     # quiz id -> its page left the attempt pages since the release (summary seen)
$CapForgot = @{}   # quiz id -> unix time this agent forgot its release (the helper's older one is ignored)
function Add-Cap([string]$q) { if (-not $script:Capped.ContainsKey($q)) { $script:CapLeft[$q] = $false }; $script:Capped[$q] = Get-Date }
function Note-Cap($st) {
  # The helper reports a release: remembered unless it is one this agent already forgot.
  if (-not $st -or -not $st.capped_quiz) { return }
  $q = [string]$st.capped_quiz
  if ($script:Capped.ContainsKey($q)) { return }
  $at = [int64]0; [void][int64]::TryParse([string]$st.capped_at, [ref]$at)
  if ($script:CapForgot.ContainsKey($q) -and ($at -le [int64]$script:CapForgot[$q])) { return }
  Add-Cap $q
}
function Forget-Cap([string]$q, [string]$why) {
  # Page closed or a NEW attempt started: the quiz locks normally again; the helper forgets it too.
  $script:Capped.Remove($q); $script:CapLeft.Remove($q); $script:CapForgot[$q] = [int64][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  Log "${why}: $q may lock again"
  try { Helper "/uncap" @{ quiz_id = $q } 8 | Out-Null } catch { }
}
function Step-Caps($openId, $openUrl) {
  # A released quiz stays unlocked while its page stays open; gone for the grace period, or back on its
  # summary page and then an attempt again (a new attempt) -> it locks normally again.
  foreach ($cq in @($script:Capped.Keys)) {
    if ($cq -eq $openId) {
      $attempt = ((Url-Path $openUrl) -match "/attempt/")
      if ($attempt -and $script:CapLeft[$cq]) { Forget-Cap $cq "new attempt"; continue }
      if (-not $attempt) { $script:CapLeft[$cq] = $true }
      $script:Capped[$cq] = Get-Date
    } elseif (((Get-Date) - [datetime]$script:Capped[$cq]).TotalSeconds -gt $Grace) { Forget-Cap $cq "page closed" }
  }
}
function Next-PwCheck([datetime]$now, $opens) {
  # C2: a quiz that has not opened yet is asked every 5 min until 90 s before it opens, then every 15 s.
  if ($null -eq $opens) { return $now.AddSeconds(300) }
  $t = ([datetime]$opens).AddSeconds(-90)
  if ($now -lt $t) { if ($t -lt $now.AddSeconds(300)) { return $t } else { return $now.AddSeconds(300) } }
  return $now.AddSeconds(15)
}
function Handle-Pw($pr, [bool]$first, [string]$note) {
  # Acts on the helper's /password answer -> "pw" | "pay" | "wait" | "other" | $null (nothing yet), and
  # sets when the next check may run ($PwNext).
  $now = Get-Date
  if ($pr -and $pr.password) {
    $pw = [string]$pr.password; $script:PwNext = $now.AddSeconds(15)
    if ($pw -ne $script:LastPw) {
      $had = $script:LastPw; $script:LastPw = $pw; Set-Clipboard -Value $pw
      if ($first) { Show-Message ("AI is locked for this quiz.`n`nQuiz password:  $pw`n(copied to your clipboard - paste it into Brightspace)" + $note) }
      elseif ($had) { Show-Message ("The quiz password changed.`n`nNew password:  " + $pw + "`n(copied to your clipboard)") }
      else { Show-Message ("Quiz password:  " + $pw + "`n(copied to your clipboard)") }
    }
    return "pw"
  }
  if (Show-Pay $pr) { $script:PwNext = $now.AddSeconds(15); if ($first -and $note) { Show-Message ("AI is locked for this quiz." + $note) }; return "pay" }
  $why = if ($pr) { [string]$pr.reason } else { "" }
  if ($why -eq "not started") {
    $opens = $null; $si = [int64]0
    if (($null -ne $pr.start_in) -and [int64]::TryParse([string]$pr.start_in, [ref]$si)) { $opens = $now.AddSeconds($si) }
    $script:PwNext = Next-PwCheck $now $opens
    if ($script:StartTold -ne $script:Quiz) {
      $script:StartTold = $script:Quiz
      $at = if ($opens) { $opens.ToString("h:mm tt") } else { "its start time" }
      Show-Message ("AI is locked for this quiz.`n`nThe quiz opens at $at. LOCKqz shows the password here then." + $note)
    }
    return "wait"
  }
  if ($why -eq "other_school") {
    # C10: the helper has already put AI back (nothing to protect on this Brightspace).
    Show-Message "LOCKqz is not set up for this school yet.`n`nAI stays on for this quiz."
    Add-Cap ([string]$script:Quiz)
    return "other"
  }
  if (($why -eq "verify") -and (((Get-Date) - $script:SetupAt).TotalSeconds -gt 60)) { Start-Setup -Quiz }   # school email first
  $script:PwNext = $now.AddSeconds(15)
  return $null
}
function Clear-Quiz { $script:Locked = $false; $script:Quiz = $null; $script:QuizTab = $null; $script:QuizTitle = $null; $script:QuizUrl = $null; $script:QuizProc = ""; $script:MissingSince = $null; $script:OperaWarned = $false }
function Send-Unlock($quiz, $reason) {
  # -> $true only when the helper confirmed it is unlocked.
  try { $r = Helper "/unlock" @{ quiz_id = $quiz; reason = $reason }; return [bool]($r -and $r.ok -and ($r.state -eq "unlocked")) } catch { return $false }
}
while ($true) {
  try {
    $wins = @(Get-BrowserWindows)
    $quizWin = $wins | Where-Object { Is-Quiz $_.Url } | Select-Object -First 1
    $openId = if ($quizWin) { Lock-Id $quizWin.Url } else { $null }
    Step-Caps $openId $(if ($quizWin) { $quizWin.Url } else { "" })
    if (-not $Verified) {
      if ((Test-Path $StudentFile) -and ((Get-Item $StudentFile).LastWriteTime -gt $StudentRead)) { Load-Student; if ($Student) { try { Helper "/student" @{ student = $Student } | Out-Null } catch {} } }
      $since = ((Get-Date) - $SetupAt).TotalSeconds
      if ((-not $Verified) -and ($since -gt 60)) { Start-Setup -Quiz:($null -ne $quizWin) }
    }
    # An unlock the helper did not confirm is retried every 5 s until it is (AI must come back).
    if ($Pending -and (-not $quizWin) -and (((Get-Date) - $PendingAt).TotalSeconds -ge 5)) {
      $PendingAt = Get-Date
      if (Send-Unlock $Pending.quiz $Pending.reason) { Log "UNLOCKED on retry ($($Pending.reason))"; $Pending = $null }
    }
    if (-not $Locked) {
      if ($quizWin -and -not $Capped.ContainsKey($openId)) {
        $Pending = $null
        $Quiz = $openId
        $QuizTab = Get-ActiveTab $quizWin; $QuizTitle = Clean-Title $quizWin.Title; $QuizProc = [string]$quizWin.Proc
        $r = $null; try { $r = Helper "/lock" @{ quiz_id = $Quiz; student = $Student; url = $quizWin.Url } } catch {}
        if ($r -and $r.ok -and ($r.capped_quiz -eq $Quiz)) {
          # C9: the server says this student already finished this quiz - the helper did not lock.
          Add-Cap ([string]$Quiz); Log "server: $Quiz is over ($($r.capped_reason)) - not locked"; Clear-Quiz
        } elseif ($r -and $r.ok) {
          $QuizUrl = $quizWin.Url; $LastCheck = Get-Date
          $Locked = $true; $MissingSince = $null; $LastBeat = Get-Date; Log "LOCKED $Quiz"
          $closed = @()
          if (Close-Browsers $FirefoxFamily $QuizProc) { $closed += "Firefox" }
          if (Close-Browsers $NoPolicy $QuizProc) { $closed += "Opera"; $OperaWarned = $true }
          # Brave reads its quiz policies (Leo, Tor windows, VPN off) only when it starts: close it once.
          if (Close-Browsers @("brave") $QuizProc) { $closed += "Brave" }
          if ($NoPolicy -contains $QuizProc) { $OperaWarned = $true; Show-Message "Opera cannot turn its AI off during a quiz.`n`nPlease take this quiz in Chrome, Edge or Firefox." }
          $note = if ($closed.Count -gt 1) { "`n`n" + (($closed[0..($closed.Count-2)]) -join ", ") + " and " + $closed[-1] + " were closed for the quiz so their AI stays off. You can reopen them; your tabs come back." } elseif ($closed.Count) { "`n`n" + $closed[0] + " was closed for the quiz so its AI stays off. You can reopen it; your tabs come back." } else { "" }
          $LastPw = $null; $StartTold = $null; $script:PayShown = $false; $res = $null
          for ($i = 0; ($i -lt 3) -and (-not $res); $i++) {
            try { $res = Handle-Pw (Helper "/password" @{ url = $quizWin.Url }) $true $note } catch { Log "password via helper failed: $_" }
            if (-not $res) { Start-Sleep -Seconds 2 }
          }
          if ($res -eq "other") { Clear-Quiz }
          elseif (-not $res) { Show-Message ("AI is locked for this quiz.`n`nIf it needs a password, LOCKqz will show it here as soon as the quiz opens." + $note) }
        } else { Show-Message "LOCKqz could not lock AI for this quiz. Is the LOCKqz app installed and running?"; Start-Sleep -Seconds 30 }
      } elseif ((-not $Pending) -and (((Get-Date) - $LastCheck).TotalSeconds -gt 10)) {
        # Helper locked while this agent is not (it resumed a lock after a restart or reboot, or an
        # earlier unlock was lost): take the lock over. If no quiz is open, the normal 30 s grace below
        # unlocks it - the student is never left blocked until the safety cap.
        $LastCheck = Get-Date
        try {
          $st = Helper "/status" $null 8
          Note-Cap $st
          if ((($st.state -eq "locked") -or ($st.state -eq "developer")) -and $st.quiz_id -and -not $Capped.ContainsKey([string]$st.quiz_id) -and ((-not $st.student) -or (-not $Student) -or ($st.student -eq $Student))) {
            $Locked = $true; $Quiz = $st.quiz_id; $QuizTab = $null; $QuizTitle = $null; $QuizUrl = ""; $QuizProc = ""
            $MissingSince = $null; $LastBeat = Get-Date; Log "adopted helper lock $Quiz"
          }
        } catch { }
      }
    } else {
      $step = Step-Locked $wins $quizWin $QuizTab $QuizTitle $MissingSince (Get-Date) $Grace
      $MissingSince = $step.MissingSince; $reason = $step.Reason
      if ($step.Present) {
        if ($quizWin -and ((Lock-Id $quizWin.Url) -eq $Quiz)) {
          # Keep the remembered quiz page fresh (titles change between quiz pages; an adopted lock has none).
          $t = Get-ActiveTab $quizWin; if ($t) { $QuizTab = $t }
          $QuizTitle = Clean-Title $quizWin.Title; $QuizProc = [string]$quizWin.Proc
          if (-not $QuizUrl) { $QuizUrl = $quizWin.Url }
        }
        # Opera reopened during the quiz (no policy layer, built-in VPN) -> closed again.
        if (Close-Browsers $NoPolicy $QuizProc) { if (-not $OperaWarned) { $OperaWarned = $true; Show-Message "Opera was closed: it cannot turn its AI off during a quiz. Use it again after the quiz." } }
        # Gated quizzes change password every 5 min: until the attempt starts, re-check and hand over a new
        # one. A quiz that has not opened yet is asked on the slower C2 schedule ($PwNext).
        $pwRes = $null
        if ($quizWin -and $QuizUrl -and ((Url-Path $quizWin.Url) -notmatch "/attempt/") -and ((Get-Date) -ge $PwNext)) {
          $PwNext = (Get-Date).AddSeconds(15)
          try { $pwRes = Handle-Pw (Helper "/password" @{ url = $QuizUrl }) $false "" } catch { Log "password refresh failed: $_" }
        }
        if ($pwRes -eq "other") { Clear-Quiz; $LastCheck = Get-Date; $reason = $null }
        # Self-heal: helper no longer locked while the quiz is open (restart, someone stopped it) -> lock
        # again, EXCEPT when the safety cap or the server (submitted / ended) released this quiz.
        elseif ($QuizUrl -and (((Get-Date) - $LastCheck).TotalSeconds -gt 10)) {
          $LastCheck = Get-Date
          try {
            $st = Helper "/status" $null
            $hs = $st.state
            $HelperOk = $true
            if ($st.capped_quiz -and ([string]$st.capped_quiz -eq [string]$Quiz)) {
              Add-Cap ([string]$Quiz)
              Log "$(if ($st.capped_reason) { $st.capped_reason } else { 'safety cap' }) released $Quiz - not re-locking"
              Clear-Quiz; $reason = $null
            } elseif (($hs -ne "locked") -and ($hs -ne "developer")) { Log "helper not locked during an open quiz ($hs) - re-locking"; Helper "/lock" @{ quiz_id = $Quiz; student = $Student; url = $QuizUrl } | Out-Null }
          } catch { $HelperOk = $false; Log "helper check failed: $_" }
        }
      }
      if ($reason -and $Locked) {
        # The helper reports the unlock (signed) with this reason; quiz_left / quiz_tab_closed are also
        # reported as "quiz_left" by the helper. Not confirmed -> retried until it is.
        if (-not (Send-Unlock $Quiz $reason)) { $Pending = @{ quiz = $Quiz; reason = $reason }; $PendingAt = Get-Date; Log "unlock not confirmed ($reason) - will retry" }
        # A Firefox started during the quiz keeps the quiz policies until it restarts.
        if (($FirefoxFamily -notcontains $QuizProc) -and (@($wins | Where-Object { $FirefoxFamily -contains $_.Proc }).Count -gt 0)) { Show-Message "AI is unlocked. Restart Firefox to get its AI features back." }
        Log "UNLOCKED ($reason)"; Clear-Quiz
        $LastCheck = Get-Date
      } elseif ($Locked -and (-not $HelperOk) -and (((Get-Date) - $LastBeat).TotalSeconds -gt $Beat)) {
        # only while the helper is unreachable (proof for "helper killed"); the helper's own signed pings say the rest
        $LastBeat = Get-Date
        Api "/report" @{ device_id = $Device; event = "heartbeat"; quiz_id = $Quiz; student = $Student; source = "agent" } | Out-Null
      }
    }
  } catch { Log "tick error: $_" }
  Start-Sleep -Seconds $(if ($Locked) { $PollLocked } else { $Poll })
}
