# LOCKqz agent (Windows). Runs in the student's session at logon (scheduled task).
# Replaces the browser extension, so the student installs ONE thing - nothing from the
# Chrome Web Store. Every 2 s it reads the address bar + tab titles of every Chrome/Edge/
# Brave/Firefox window through Windows UI Automation (no browser permission needed) and:
#   * on a Brightspace quiz attempt page -> tells the helper to LOCK, then asks the helper
#     for the quiz password (the helper checks its block and signs the request with its
#     SYSTEM-only device key), shows it and copies it to the clipboard
#   * while locked                       -> pings the backend (teacher's live monitor)
#   * when the quiz tab is gone (submitted / left) -> tells the helper to UNLOCK
# First run asks the student's name once so the teacher's roster shows who is locked.
$ErrorActionPreference = "SilentlyContinue"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, Microsoft.VisualBasic

$ConfPath = "$env:ProgramData\LOCKqz\config.json"
$Conf  = if (Test-Path $ConfPath) { Get-Content $ConfPath -Raw | ConvertFrom-Json } else { @{} }
$Port  = if ($Conf.port) { [int]$Conf.port } else { 8787 }
$Token = if ($Conf.token) { $Conf.token } else { "lockqz-dev" }
$Api   = if ($Conf.api_base) { $Conf.api_base.TrimEnd("/") } else { "" }
if ($Api -and -not $Api.EndsWith("/api")) { $Api += "/api" }   # accept a bare site URL too
$Device= if ($Conf.device_id) { $Conf.device_id } else { "unknown" }
$UserDir = "$env:APPDATA\LOCKqz"; New-Item -ItemType Directory -Force -Path $UserDir | Out-Null
$StudentFile = "$UserDir\student.json"
$Poll = 2; $PollLocked = 1; $Grace = 30; $Beat = 120
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
function Show-Message($text) {
  # Non-blocking: the box runs in its own process so the watch loop never stalls.
  $safe = $text.Replace([char]39, [char]34)
  $cmd = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('" + $safe + "', 'LOCKqz') | Out-Null"
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
  Start-Process powershell -ArgumentList "-WindowStyle Hidden -EncodedCommand $enc" -WindowStyle Hidden
}

# ---- student name (once) ----
$Student = $null
if (Test-Path $StudentFile) { $Student = (Get-Content $StudentFile -Raw | ConvertFrom-Json).student }
if (-not $Student) {
  # Must be a real email: the professor's roster and the quiz gate match students by it.
  $msg = "LOCKqz setup - enter your school email (the one Brightspace uses, e.g. you@usc.edu):"
  for ($t = 0; $t -lt 3; $t++) {
    $Student = ([Microsoft.VisualBasic.Interaction]::InputBox($msg, "LOCKqz", "")).Trim().ToLower()
    if ($Student -match '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$') { break }
    $Student = $null; $msg = "That is not an email address. Enter your school email (e.g. you@usc.edu):"
  }
  if ($Student) { @{ student = $Student } | ConvertTo-Json | Set-Content $StudentFile -Encoding UTF8 }
}
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
    if (-not $Locked) {
      if ($quizWin) {
        $Quiz = Lock-Id $quizWin.Url
        $QuizTitle = ($quizWin.Title -replace " and \d+ more page[s]?","" -replace "\s[-\u2014]\s(Google Chrome|Microsoft.Edge|Microsoft.Edge.*|Brave|Mozilla Firefox|Opera|Vivaldi).*$","")
        $r = $null; try { $r = Helper "/lock" @{ quiz_id = $Quiz; student = $Student; url = $quizWin.Url } } catch {}
        if ($r -and $r.ok) {
          $QuizUrl = $quizWin.Url; $LastCheck = Get-Date
          $Locked = $true; $MissingSince = $null; $LastBeat = Get-Date; Log "LOCKED $Quiz"
          $pw = $null
          for ($i = 0; ($i -lt 3) -and (-not $pw); $i++) {
            try { $pw = (Helper "/password" @{ url = $quizWin.Url }).password } catch { Log "password via helper failed: $_" }
            if (-not $pw) { Start-Sleep -Seconds 2 }
          }
          $LastPw = $pw; $PwChecked = Get-Date
          if ($pw) { Set-Clipboard -Value $pw; Show-Message "AI is locked for this quiz.`n`nQuiz password:  $pw`n(copied to your clipboard - paste it into Brightspace)" }
          else { Show-Message "AI is locked for this quiz.`n`nIf it needs a password, LOCKqz will show it here as soon as the quiz opens." }
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
            $pw2 = (Helper "/password" @{ url = $QuizUrl }).password
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
