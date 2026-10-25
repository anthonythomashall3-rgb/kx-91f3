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
param([switch]$Setup)
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

function Log($m) { Add-Content -Path "$UserDir\agent.log" -Value ("{0} {1}" -f (Get-Date -Format s), $m) }
function Is-QuizPath($u) { ($u -match "/d2l/lms/quizzing/user/") -or (($u -match "/d2l/lms/quizzing/") -and ($u -match "isprv=1|preview")) }
function Is-Quiz($u)    { (Is-QuizPath $u) -and ($u -match "qi=") -and -not ($u -match "quizzes_list|quiz_submissions|feedback|results|submission") }
# Brightspace quiz-attempt pages carry "Quiz" (and often the LMS name) in the window title; used ONLY for
# a window whose address bar can't be read (F11 / PWA), so going fullscreen can't drop a lock silently.
function Is-QuizByTitle($t) { $t -match "Quiz" -and $t -match "Brightspace|D2L|Attempt" }
function Is-Leaving($u) { (Is-QuizPath $u) -and ($u -match "quizzes_list|quiz_submissions|feedback|results|submission") }
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
  $qi = if ($u -match "qi=(\d+)") { $Matches[1] } else { "x" }
  $ou = if ($u -match "ou=(\d+)") { $Matches[1] } else { "x" }
  "$ou-$qi"
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
  try { Invoke-RestMethod -Uri "$Api$path" -Method Post -Body ($body | ConvertTo-Json -Compress) -ContentType "application/json" -TimeoutSec 8 } catch { $null }
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
function Err-Text($r) {
  if (-not $r) { return "LOCKqz can't reach the internet right now. It will ask again later." }
  if ($r.error -eq "too_many_codes") { return "Too many codes were sent. LOCKqz will ask again in an hour." }
  if (($r.error -eq "send_failed") -or ($r.error -eq "mail_busy")) { return "LOCKqz couldn't send the email right now. It will ask again later." }
  return "Something went wrong. LOCKqz will ask again later."
}
function Setup-Identity($saved) {
  # -> @{ student; verified } to save, or $null (not finished: ask again later)
  $st = Verify "status" $null
  if (-not $st) { return $null }
  if ($st.verified -and $st.student) { return @{ student = $st.student; verified = $true } }
  if ((-not $st.codes) -and $st.student) { return @{ student = $st.student; verified = $false } }
  $email = [string]$saved; $msg = "LOCKqz setup (one time only)`n`n" + $Ask
  while ($true) {
    $a = Ask-Box $msg @("OK") $email $true
    if (-not $a) { return $null }
    $email = ([string]$a.t).Trim().ToLower()
    if ($email -notmatch $EmailRe) { $msg = "That is not an email address.`n`n" + $Ask; continue }
    $chk = Verify "check" @{ email = $email }
    if (-not $chk) { Say (Err-Text $null); return $null }
    if ($chk.name) { $a = Ask-Box ("Is this you?`n`n" + $chk.name + "`n" + $email) @("No, retype", "Yes") "" $false }
    else { $a = Ask-Box ($email + " is not on a LOCKqz class list yet.`n`nCheck the spelling.") @("Retype", "Use it") "" $false }
    if (-not $a) { return $null }
    if (($a.b -eq "No, retype") -or ($a.b -eq "Retype")) { $msg = $Ask; continue }
    $r = Verify "send" @{ email = $email }
    if ($r -and $r.bound) { return @{ student = $email; verified = $false } }
    if (-not ($r -and $r.sent)) { Say (Err-Text $r); return $null }
    $note = ""
    while ($true) {
      $a = Ask-Box ($note + "We emailed a 6-digit code to`n" + $email + "`n`nType it here (check Junk/Spam if you don't see it):") @("Change email", "Send new code", "OK") "" $true
      if (-not $a) { return $null }
      if ($a.b -eq "Change email") { $msg = $Ask; break }
      if ($a.b -eq "Send new code") {
        $r = Verify "send" @{ email = $email }
        if (-not ($r -and $r.sent)) { Say (Err-Text $r); return $null }
        $note = "New code sent.`n`n"; continue
      }
      $r = Verify "code" @{ email = $email; code = $a.t }
      if ($r -and $r.verified) { Say "Done. LOCKqz is set up and won't ask again."; return @{ student = $email; verified = $true } }
      if ($r -and $r.resent) {
        if ($r.error -eq "expired") { $note = "That code expired. We sent a new one.`n`n" }
        elseif ($r.error -eq "too_many_tries") { $note = "Too many wrong tries. We sent a new code.`n`n" }
        else { $note = "We sent a new code.`n`n" }
        continue
      }
      if ($r -and ($r.error -eq "wrong_code")) { $note = "That code is wrong (" + $r.tries_left + " tries left).`n`n"; continue }
      Say (Err-Text $r); return $null
    }
  }
}

if ($Setup) {
  # One setup window at a time per user session.
  $mtx = New-Object System.Threading.Mutex($false, "Local\LOCKqzSetup")
  if (-not $mtx.WaitOne(0)) { exit }
  $saved = $null; if (Test-Path $StudentFile) { $saved = (Get-Content $StudentFile -Raw | ConvertFrom-Json).student }
  $got = Setup-Identity $saved
  if ($got) {
    @{ student = $got.student; verified = $got.verified } | ConvertTo-Json | Set-Content $StudentFile -Encoding UTF8
    try { Helper "/student" @{ student = $got.student } | Out-Null } catch {}
    Log "student $($got.student) verified=$($got.verified)"
  }
  $mtx.ReleaseMutex(); exit
}

$Student = $null; $Verified = $false; $StudentRead = Get-Date "2000-01-01"; $SetupAt = Get-Date "2000-01-01"
function Load-Student {
  if (Test-Path $StudentFile) {
    $j = Get-Content $StudentFile -Raw | ConvertFrom-Json
    $script:Student = $j.student; $script:Verified = [bool]$j.verified; $script:StudentRead = (Get-Item $StudentFile).LastWriteTime
  }
}
function Start-Setup {
  $script:SetupAt = Get-Date
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Setup"
}
Load-Student
Start-Setup   # checks the server once per login; asks only if not yet confirmed
try { Helper "/student" @{ student = $Student } 8 | Out-Null } catch { Log "helper not reachable yet" }
Log "running (device $Device, student $Student)"

# ---- main loop ----
$Locked = $false; $Quiz = $null; $QuizTab = $null; $QuizTitle = $null; $QuizUrl = $null; $QuizProc = ""
$LastPw = $null; $PwChecked = Get-Date; $MissingSince = $null; $LastBeat = Get-Date; $LastCheck = Get-Date "2000-01-01"
$Pending = $null; $PendingAt = Get-Date "2000-01-01"; $OperaWarned = $false
function Send-Unlock($quiz, $reason) {
  # -> $true only when the helper confirmed it is unlocked.
  try { $r = Helper "/unlock" @{ quiz_id = $quiz; reason = $reason }; return [bool]($r -and $r.ok -and ($r.state -eq "unlocked")) } catch { return $false }
}
while ($true) {
  try {
    $wins = @(Get-BrowserWindows)
    $quizWin = $wins | Where-Object { Is-Quiz $_.Url } | Select-Object -First 1
    if (-not $Verified) {
      if ((Test-Path $StudentFile) -and ((Get-Item $StudentFile).LastWriteTime -gt $StudentRead)) { Load-Student; if ($Student) { try { Helper "/student" @{ student = $Student } | Out-Null } catch {} } }
      $since = ((Get-Date) - $SetupAt).TotalSeconds
      if ((-not $Verified) -and ((($null -ne $quizWin) -and ($since -gt 60)) -or ($since -gt 21600))) { Start-Setup }
    }
    # An unlock the helper did not confirm is retried every 5 s until it is (AI must come back).
    if ($Pending -and (-not $quizWin) -and (((Get-Date) - $PendingAt).TotalSeconds -ge 5)) {
      $PendingAt = Get-Date
      if (Send-Unlock $Pending.quiz $Pending.reason) { Log "UNLOCKED on retry ($($Pending.reason))"; $Pending = $null }
    }
    if (-not $Locked) {
      if ($quizWin) {
        $Pending = $null
        $Quiz = Lock-Id $quizWin.Url
        $QuizTab = Get-ActiveTab $quizWin; $QuizTitle = Clean-Title $quizWin.Title; $QuizProc = [string]$quizWin.Proc
        $r = $null; try { $r = Helper "/lock" @{ quiz_id = $Quiz; student = $Student; url = $quizWin.Url } } catch {}
        if ($r -and $r.ok) {
          $QuizUrl = $quizWin.Url; $LastCheck = Get-Date
          $Locked = $true; $MissingSince = $null; $LastBeat = Get-Date; Log "LOCKED $Quiz"
          $closed = @()
          if (Close-Browsers $FirefoxFamily $QuizProc) { $closed += "Firefox" }
          if (Close-Browsers $NoPolicy $QuizProc) { $closed += "Opera" }
          $pw = $null; $script:PayShown = $false
          for ($i = 0; ($i -lt 3) -and (-not $pw); $i++) {
            try { $pr = Helper "/password" @{ url = $quizWin.Url }; $pw = $pr.password; if ((-not $pw) -and (Show-Pay $pr)) { break } } catch { Log "password via helper failed: $_" }
            if (-not $pw) { Start-Sleep -Seconds 2 }
          }
          $LastPw = $pw; $PwChecked = Get-Date
          $note = if ($closed.Count) { "`n`n" + ($closed -join " and ") + " was closed for the quiz so its AI stays off. You can reopen it; your tabs come back." } else { "" }
          if ($pw) { Set-Clipboard -Value $pw; Show-Message ("AI is locked for this quiz.`n`nQuiz password:  $pw`n(copied to your clipboard - paste it into Brightspace)" + $note) }
          elseif (-not $script:PayShown) { Show-Message ("AI is locked for this quiz.`n`nIf it needs a password, LOCKqz will show it here as soon as the quiz opens." + $note) }
          elseif ($note) { Show-Message ("AI is locked for this quiz." + $note) }
        } else { Show-Message "LOCKqz could not lock AI for this quiz. Is the LOCKqz app installed and running?"; Start-Sleep -Seconds 30 }
      } elseif ((-not $Pending) -and (((Get-Date) - $LastCheck).TotalSeconds -gt 10)) {
        # Helper locked while this agent is not (it resumed a lock after a restart or reboot, or an
        # earlier unlock was lost): take the lock over. If no quiz is open, the normal 30 s grace below
        # unlocks it - the student is never left blocked until the 3-hour cap.
        $LastCheck = Get-Date
        try {
          $st = Helper "/status" $null 8
          if ((($st.state -eq "locked") -or ($st.state -eq "developer")) -and $st.quiz_id -and ((-not $st.student) -or (-not $Student) -or ($st.student -eq $Student))) {
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
        # Gated quizzes change password every 5 min: until the attempt starts, re-check and hand over a new one.
        if ($quizWin -and $QuizUrl -and ($quizWin.Url -notmatch "/attempt/") -and (((Get-Date) - $PwChecked).TotalSeconds -gt 15)) {
          $PwChecked = Get-Date
          try {
            $pr2 = Helper "/password" @{ url = $QuizUrl }; $pw2 = $pr2.password; if (-not $pw2) { Show-Pay $pr2 | Out-Null }
            if ($pw2 -and ($pw2 -ne $LastPw)) { $hdr = if ($LastPw) { "The quiz password changed.`n`nNew password:  " } else { "Quiz password:  " }; $LastPw = $pw2; Set-Clipboard -Value $pw2; Show-Message ($hdr + $pw2 + "`n(copied to your clipboard)") }
          } catch { Log "password refresh failed: $_" }
        }
        # Self-heal: helper no longer locked while the quiz is open (3-hour cap, restart) -> lock again.
        if ($QuizUrl -and (((Get-Date) - $LastCheck).TotalSeconds -gt 10)) {
          $LastCheck = Get-Date
          try {
            $hs = (Helper "/status" $null).state
            $HelperOk = $true
            if (($hs -ne "locked") -and ($hs -ne "developer")) { Log "helper not locked during an open quiz ($hs) - re-locking"; Helper "/lock" @{ quiz_id = $Quiz; student = $Student; url = $QuizUrl } | Out-Null }
          } catch { $HelperOk = $false; Log "helper check failed: $_" }
        }
      }
      if ($reason) {
        # The helper reports the unlock (signed) with this reason; quiz_left / quiz_tab_closed are also
        # reported as "quiz_left" by the helper. Not confirmed -> retried until it is.
        if (-not (Send-Unlock $Quiz $reason)) { $Pending = @{ quiz = $Quiz; reason = $reason }; $PendingAt = Get-Date; Log "unlock not confirmed ($reason) - will retry" }
        # A Firefox started during the quiz keeps the quiz policies until it restarts.
        if (($FirefoxFamily -notcontains $QuizProc) -and (@($wins | Where-Object { $FirefoxFamily -contains $_.Proc }).Count -gt 0)) { Show-Message "AI is unlocked. Restart Firefox to get its AI features back." }
        Log "UNLOCKED ($reason)"; $Locked = $false; $Quiz = $null; $QuizTab = $null; $QuizTitle = $null; $QuizUrl = $null; $QuizProc = ""; $MissingSince = $null; $OperaWarned = $false
        $LastCheck = Get-Date
      } elseif ((-not $HelperOk) -and (((Get-Date) - $LastBeat).TotalSeconds -gt $Beat)) {
        # only while the helper is unreachable (proof for "helper killed"); the helper's own signed pings say the rest
        $LastBeat = Get-Date
        Api "/report" @{ device_id = $Device; event = "heartbeat"; quiz_id = $Quiz; student = $Student; source = "agent" } | Out-Null
      }
    }
  } catch { Log "tick error: $_" }
  Start-Sleep -Seconds $(if ($Locked) { $PollLocked } else { $Poll })
}
