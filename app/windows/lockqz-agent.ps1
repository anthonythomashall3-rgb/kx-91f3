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
$Poll = 2; $PollLocked = 1; $Grace = 30; $Beat = 300
$BrowserClasses = @("Chrome_WidgetWin_1","MozillaWindowClass")

function Log($m) { Add-Content -Path "$UserDir\agent.log" -Value ("{0} {1}" -f (Get-Date -Format s), $m) }
function Is-QuizPath($u) { ($u -match "/d2l/lms/quizzing/user/") -or (($u -match "/d2l/lms/quizzing/") -and ($u -match "isprv=1|preview")) }
function Is-Quiz($u)    { (Is-QuizPath $u) -and ($u -match "qi=") -and -not ($u -match "quizzes_list|quiz_submissions|feedback|results|submission") }
# Brightspace quiz-attempt pages carry "Quiz" (and often the LMS name) in the window title; used when
# the address bar is hidden (F11 / PWA), so going fullscreen can neither start nor drop a lock silently.
function Is-QuizByTitle($t) { $t -match "Quiz" -and $t -match "Brightspace|D2L|Attempt" }
function Is-Leaving($u) { (Is-QuizPath $u) -and ($u -match "quizzes_list|quiz_submissions|feedback|results|submission") }
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
  $out = @()
  $wins = $Root.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($w in $wins) {
    if ($BrowserClasses -notcontains $w.Current.ClassName) { continue }
    $url = ""
    $edit = $w.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Edit)))
    if ($edit) { $vp = $null; if ($edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $url = $vp.Current.Value } }
    $tabs = @()
    foreach ($t in $w.FindAll($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::TabItem)))) { $tabs += $t.Current.Name }
    $out += [pscustomobject]@{ Title = $w.Current.Name; Url = $url; Tabs = $tabs }
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
$Locked = $false; $Quiz = $null; $QuizTitle = $null; $QuizUrl = $null; $LastPw = $null; $PwChecked = Get-Date; $MissingSince = $null; $LastBeat = Get-Date; $LastCheck = Get-Date
# Adopt an existing lock (daemon resumed after a reboot/login) so we unlock correctly when the quiz
# ends instead of leaving the student blocked until the hard max.
try {
  $st0 = Helper "/status" $null 8
  if ((($st0.state -eq "locked") -or ($st0.state -eq "developer")) -and $st0.quiz_id) {
    $Locked = $true; $Quiz = $st0.quiz_id; $QuizUrl = ""; $MissingSince = $null; $LastBeat = Get-Date; $LastCheck = Get-Date
    Log "adopted existing lock $Quiz at startup"
  }
} catch { Log "startup status check failed" }
while ($true) {
  try {
    $wins = Get-BrowserWindows
    $quizWin = $wins | Where-Object { Is-Quiz $_.Url } | Select-Object -First 1
    $leaving = @($wins | Where-Object { Is-Leaving $_.Url }).Count -gt 0
    if (-not $Verified) {
      if ((Test-Path $StudentFile) -and ((Get-Item $StudentFile).LastWriteTime -gt $StudentRead)) { Load-Student; if ($Student) { try { Helper "/student" @{ student = $Student } | Out-Null } catch {} } }
      $since = ((Get-Date) - $SetupAt).TotalSeconds
      if ((-not $Verified) -and ((($null -ne $quizWin) -and ($since -gt 60)) -or ($since -gt 21600))) { Start-Setup }
    }
    if (-not $Locked) {
      if ($quizWin) {
        $Quiz = Lock-Id $quizWin.Url
        $QuizTitle = ($quizWin.Title -replace " and \d+ more page[s]?","" -replace "\s[-\u2014]\s(Google Chrome|Microsoft.Edge|Microsoft.Edge.*|Brave|Mozilla Firefox|Opera|Vivaldi).*$","")
        $r = $null; try { $r = Helper "/lock" @{ quiz_id = $Quiz; student = $Student; url = $quizWin.Url } } catch {}
        if ($r -and $r.ok) {
          $QuizUrl = $quizWin.Url; $LastCheck = Get-Date
          $Locked = $true; $MissingSince = $null; $LastBeat = Get-Date; Log "LOCKED $Quiz"
          $pw = $null; $script:PayShown = $false
          for ($i = 0; ($i -lt 3) -and (-not $pw); $i++) {
            try { $pr = Helper "/password" @{ url = $quizWin.Url }; $pw = $pr.password; if ((-not $pw) -and (Show-Pay $pr)) { break } } catch { Log "password via helper failed: $_" }
            if (-not $pw) { Start-Sleep -Seconds 2 }
          }
          $LastPw = $pw; $PwChecked = Get-Date
          if ($pw) { Set-Clipboard -Value $pw; Show-Message "AI is locked for this quiz.`n`nQuiz password:  $pw`n(copied to your clipboard - paste it into Brightspace)" }
          elseif (-not $script:PayShown) { Show-Message "AI is locked for this quiz.`n`nIf it needs a password, LOCKqz will show it here as soon as the quiz opens." }
        } else { Show-Message "LOCKqz could not lock AI for this quiz. Is the LOCKqz app installed and running?"; Start-Sleep -Seconds 30 }
      }
    } else {
      $present = ($null -ne $quizWin) -or (@($wins | Where-Object { ($_.Tabs -contains $QuizTitle) -or ($_.Title -like "$QuizTitle*") }).Count -gt 0) -or (@($wins | Where-Object { Is-QuizByTitle $_.Title }).Count -gt 0)
      $reason = $null
      if ($present) {
        $MissingSince = $null
        # Gated quizzes change password every 5 min: until the attempt starts, re-check and hand over a new one.
        if ($quizWin -and ($quizWin.Url -notmatch "/attempt/") -and (((Get-Date) - $PwChecked).TotalSeconds -gt 15)) {
          $PwChecked = Get-Date
          try {
            $pr2 = Helper "/password" @{ url = $QuizUrl }; $pw2 = $pr2.password; if (-not $pw2) { Show-Pay $pr2 | Out-Null }
            if ($pw2 -and ($pw2 -ne $LastPw)) { $hdr = if ($LastPw) { "The quiz password changed.`n`nNew password:  " } else { "Quiz password:  " }; $LastPw = $pw2; Set-Clipboard -Value $pw2; Show-Message ($hdr + $pw2 + "`n(copied to your clipboard)") }
          } catch { Log "password refresh failed: $_" }
        }
        # Self-heal: helper no longer locked while the quiz is open (3-hour cap, restart) -> lock again.
        if (((Get-Date) - $LastCheck).TotalSeconds -gt 10) {
          $LastCheck = Get-Date
          try {
            $hs = (Helper "/status" $null).state
            if (($hs -ne "locked") -and ($hs -ne "developer")) { Log "helper not locked during an open quiz ($hs) - re-locking"; Helper "/lock" @{ quiz_id = $Quiz; student = $Student; url = $QuizUrl } | Out-Null }
          } catch { Log "helper check failed: $_" }
        }
      }
      elseif ($leaving) { $reason = "submitted" }
      else {
        if (-not $MissingSince) { $MissingSince = Get-Date }
        if (((Get-Date) - $MissingSince).TotalSeconds -gt $Grace) { $reason = if (@($wins).Count -eq 0) { "browser_closed" } else { "quiz_tab_closed" } }
      }
      if ($reason) {
        try { Helper "/unlock" @{ quiz_id = $Quiz } | Out-Null } catch {}
        if ($reason -ne "submitted") {
          $sent = $false
          try { Helper "/event" @{ event = "quiz_left"; quiz_id = $Quiz; detail = $reason } | Out-Null; $sent = $true } catch {}
          if (-not $sent) { Api "/report" @{ device_id = $Device; event = "quiz_left"; quiz_id = $Quiz; student = $Student; source = "agent"; detail = $reason } | Out-Null }
        }
        Log "UNLOCKED ($reason)"; $Locked = $false; $Quiz = $null; $QuizTitle = $null; $MissingSince = $null
      } elseif (((Get-Date) - $LastBeat).TotalSeconds -gt $Beat) {
        $LastBeat = Get-Date
        Api "/report" @{ device_id = $Device; event = "heartbeat"; quiz_id = $Quiz; student = $Student; source = "agent" } | Out-Null
      }
    }
  } catch { Log "tick error: $_" }
  Start-Sleep -Seconds $(if ($Locked) { $PollLocked } else { $Poll })
}
