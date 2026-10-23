# LOCKqz agent (Windows). Runs in the student's session at logon (scheduled task).
# Replaces the browser extension, so the student installs ONE thing - nothing from the
# Chrome Web Store. Every 2 s it reads the address bar + tab titles of every Chrome/Edge/
# Brave/Firefox window through Windows UI Automation (no browser permission needed) and:
#   * on a Brightspace quiz attempt page -> tells the helper to LOCK, fetches the quiz
#     password from the backend, shows it and copies it to the clipboard
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
$Poll = 2; $PollLocked = 1; $Grace = 30; $Beat = 45
$BrowserClasses = @("Chrome_WidgetWin_1","MozillaWindowClass")

function Log($m) { Add-Content -Path "$UserDir\agent.log" -Value ("{0} {1}" -f (Get-Date -Format s), $m) }
function Is-Quiz($u)    { ($u -match "/d2l/lms/quizzing/user/") -and ($u -match "qi=") -and -not ($u -match "quizzes_list|quiz_submissions|feedback|results|submission") }
function Is-Leaving($u) { ($u -match "/d2l/lms/quizzing/user/") -and ($u -match "quizzes_list|quiz_submissions|feedback|results|submission") }
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

function Helper($path, $body) {
  $h = @{ "X-LOCKqz-Token" = $Token }
  if ($null -ne $body) { Invoke-RestMethod -Uri "http://127.0.0.1:$Port$path" -Method Post -Headers $h -Body ($body | ConvertTo-Json -Compress) -ContentType "application/json" -TimeoutSec 8 }
  else { Invoke-RestMethod -Uri "http://127.0.0.1:$Port$path" -Headers $h -TimeoutSec 8 }
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
  $Student = [Microsoft.VisualBasic.Interaction]::InputBox("LOCKqz setup - enter your name as it appears in Brightspace:", "LOCKqz", "")
  if ($Student) { @{ student = $Student } | ConvertTo-Json | Set-Content $StudentFile -Encoding UTF8 }
}
try { Helper "/student" @{ student = $Student } | Out-Null } catch { Log "helper not reachable yet" }
Log "running (device $Device, student $Student)"

# ---- main loop ----
$Locked = $false; $Quiz = $null; $QuizTitle = $null; $MissingSince = $null; $LastBeat = Get-Date
while ($true) {
  try {
    $wins = Get-BrowserWindows
    $quizWin = $wins | Where-Object { Is-Quiz $_.Url } | Select-Object -First 1
    $leaving = ($wins | Where-Object { Is-Leaving $_.Url }).Count -gt 0
    if (-not $Locked) {
      if ($quizWin) {
        $Quiz = Lock-Id $quizWin.Url
        $QuizTitle = ($quizWin.Title -replace " - (Google Chrome|Microsoft. Edge|Brave|Mozilla Firefox).*$","")
        $r = $null; try { $r = Helper "/lock" @{ quiz_id = $Quiz; student = $Student; url = $quizWin.Url } } catch {}
        if ($r -and $r.ok) {
          $Locked = $true; $MissingSince = $null; $LastBeat = Get-Date; Log "LOCKED $Quiz"
          $pw = (Api "/password" @{ url = $quizWin.Url; device_id = $Device }).password
          if ($pw) { Set-Clipboard -Value $pw; Show-Message "AI is locked for this quiz.`n`nQuiz password:  $pw`n(copied to your clipboard - paste it into Brightspace)" }
          else { Show-Message "AI is locked for this quiz." }
        } else { Show-Message "LOCKqz could not lock AI for this quiz. Is the LOCKqz app installed and running?"; Start-Sleep -Seconds 30 }
      }
    } else {
      $present = ($null -ne $quizWin) -or (($wins | Where-Object { $_.Tabs -contains $QuizTitle }).Count -gt 0)
      $reason = $null
      if ($present) { $MissingSince = $null }
      elseif ($leaving) { $reason = "submitted" }
      else {
        if (-not $MissingSince) { $MissingSince = Get-Date }
        if (((Get-Date) - $MissingSince).TotalSeconds -gt $Grace) { $reason = if ($wins.Count -eq 0) { "browser_closed" } else { "quiz_tab_closed" } }
      }
      if ($reason) {
        try { Helper "/unlock" @{ quiz_id = $Quiz } | Out-Null } catch {}
        if ($reason -ne "submitted") { Api "/report" @{ device_id = $Device; event = "quiz_left"; quiz_id = $Quiz; student = $Student; source = "agent"; detail = $reason } | Out-Null }
        Log "UNLOCKED ($reason)"; $Locked = $false; $Quiz = $null; $QuizTitle = $null; $MissingSince = $null
      } elseif (((Get-Date) - $LastBeat).TotalSeconds -gt $Beat) {
        $LastBeat = Get-Date
        Api "/report" @{ device_id = $Device; event = "heartbeat"; quiz_id = $Quiz; student = $Student; source = "agent" } | Out-Null
      }
    }
  } catch { Log "tick error: $_" }
  Start-Sleep -Seconds $(if ($Locked) { $PollLocked } else { $Poll })
}
