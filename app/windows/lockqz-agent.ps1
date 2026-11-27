# LOCKqz agent (Windows). Runs in the student's session at logon (scheduled task).
# Replaces the browser extension, so the student installs ONE thing - nothing from the
# Chrome Web Store. Every 2 s it reads the address bar + tab titles of every Chrome/Edge/
# Brave/Firefox window through Windows UI Automation (no browser permission needed) and:
#   * on a Brightspace quiz attempt page -> tells the helper to LOCK, then asks the helper
#     for the quiz password (the helper checks its block and signs the request with its
#     SYSTEM-only device key) and enters it in the quiz page itself (shown and copied only if no password box is found)
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
# A quiz opened from Content/Lessons runs in a frame of /d2l/le/content/<ou>/fullscreen/<topic>/ViewLocation
# ?...&location=<quiz URL, encoded>: return that quiz URL (same host) so every rule sees the real quiz.
function Inner-Url([string]$u) {
  try {
    if ((Url-Path $u) -match '^/d2l/le/(content|lessons)/\d+/') {
      foreach ($kv in ((Url-Query $u) -split '&')) {
        if ($kv -like 'location=*') {
          $raw = $kv.Substring(9).Replace('+', ' ')
          $loc = [Uri]::UnescapeDataString($raw)
          if ($loc.StartsWith('/d2l/')) { $hn = ''; if ($u -match '^(?:[A-Za-z][A-Za-z0-9+.-]*://)?([^/?#]+)') { $hn = $Matches[1] }; return "https://$hn$loc" }
        }
      }
    }
  } catch { }
  return $u
}
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
function Url-Host([string]$u) { if ($u -match '^(?:[A-Za-z][A-Za-z0-9+.-]*://)?([^/?#:]*)') { return $Matches[1].ToLowerInvariant() }; return "" }
# A quiz's "turned in" pages (every leaving page except the quiz list): the attempt ends on this PC only when one
# of these takes the place of the exam's attempt page in the same browser window, on the same Brightspace host.
function Is-SubmitPath([string]$u) { (Url-Path $u) -match 'quiz_submissions|submission|feedback|results' }
$script:Seen = @{}; $script:AttWin = @{}; $script:RestartWait = [DateTime]::MinValue
function Step-Evidence($wins, [string]$quiz, [bool]$present, [datetime]$now) {
  # What this PC saw of the locked exam's attempt (sent with an unlock, see Seen-For).
  if (-not $quiz) { return }
  if (-not $script:Seen.ContainsKey($quiz)) { $script:Seen[$quiz] = @{ attempt = $false; sub = $false; rt = $true; at = $now } }
  $ev = $script:Seen[$quiz]; $byUrl = $false
  foreach ($w in @($wins)) {
    $u = [string]$w.Url
    if (-not $u -or -not (Is-QuizPath $u) -or ((Lock-Id $u) -ne $quiz)) { continue }
    $byUrl = $true
    $k = [string]$w.Hwnd
    if ((Url-Path $u) -match '/attempt/') { $ev.attempt = $true; $script:AttWin[$k] = @{ host = (Url-Host $u); at = $now } }
    elseif (Is-SubmitPath $u) {
      $p = $script:AttWin[$k]
      if ($p -and ($p.host -eq (Url-Host $u)) -and (($now - [datetime]$p.at).TotalSeconds -le 15)) {
        if (-not $ev.sub) { Log "$quiz turned in (its submitted page replaced the attempt page)" }
        $ev.sub = $true
      }
    }
    elseif ($script:AttWin[$k] -and ($script:AttWin[$k].host -eq (Url-Host $u))) {
      if ((Url-Path $u) -match 'quiz_summary') { $script:AttWin.Remove($k) }   # back on its start page: that attempt was left, not turned in
      else { $script:AttWin[$k] = @{ host = (Url-Host $u); at = $now } }   # another page of the exam after its attempt (the "submit?" page): same window
    }
  }
  if ($present -and -not $byUrl) { $ev.rt = $false }   # seen by its window title only (F11 / app window): not watched live
}
function Seen-For([string]$quiz) {
  $ev = $script:Seen[$quiz]
  if (-not $ev) { return @{ sub = $false; attempt = $null } }
  $att = $null
  if ($ev.attempt) { $att = $true } elseif ($ev.rt -and -not $ev.adopted) { $att = $false }
  return @{ sub = [bool]$ev.sub; attempt = $att }
}
function Lock-Id($u) {
  $qi = [regex]::Match([string]$u, '[?&]qi=(\d+)'); $ou = [regex]::Match([string]$u, '[?&]ou=(\d+)')
  "$(if ($ou.Success) { $ou.Groups[1].Value } else { 'x' })-$(if ($qi.Success) { $qi.Groups[1].Value } else { 'x' })"
}

$Root = [System.Windows.Automation.AutomationElement]::RootElement
$TS   = [System.Windows.Automation.TreeScope]
$CT   = [System.Windows.Automation.ControlType]
$AE   = [System.Windows.Automation.AutomationElement]
$script:Moved = @{}
function Wait-Focus($e, [int]$ms) {
  # $true once the keyboard focus is on $e, looked at every 100 ms for up to $ms (a slow PC moves it late).
  for ($t = 0; $t -le $ms; $t += 100) {
    try { $f = [System.Windows.Automation.AutomationElement]::FocusedElement; if ($f -and [System.Windows.Automation.Automation]::Compare($f, $e)) { return $true } } catch { }
    Start-Sleep -Milliseconds 100
  }
  return $false
}
function Type-Address($edit, $vp, [string]$to) {
  # Into that window's own address bar: focus, the address, Enter - only while the address bar really holds the
  # keyboard focus. Nothing is typed before the focus is there, and what was typed is taken back if the focus left,
  # so an address bar never keeps an address it did not open. -> $true when Enter was pressed.
  $orig = [string]$vp.Current.Value
  $edit.SetFocus()
  if (-not (Wait-Focus $edit 1500)) { return $false }
  $vp.SetValue($to); Start-Sleep -Milliseconds 100
  if (-not (Wait-Focus $edit 500)) { try { $vp.SetValue($orig) } catch { }; return $false }
  [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
  return $true
}
function Move-ToQuiz($edit, [string]$url) {
  # Types the quiz URL into that window's own address bar (UI Automation) and presses Enter, only when
  # the address bar really has the keyboard focus; at most once every 10 s per URL.
  $now = [DateTime]::UtcNow
  if ($script:Moved.ContainsKey($url) -and (($now - $script:Moved[$url]).TotalSeconds -lt 10)) { return $false }
  $script:Moved[$url] = $now
  try {
    $vp = $null
    if (-not $edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { return $false }
    if (-not (Type-Address $edit $vp $url)) { return $false }
    Log "quiz opened from Content: moved to its own page ($(Lock-Id $url))"
    return $true
  } catch { return $false }
}
# Web search during a quiz: Chrome, Edge and Brave take a default-search policy only on a PC that a school or company
# manages (never a student's own PC), and Firefox only in its ESR edition, so a search typed in the address bar goes to
# the engine's usual results page (Google's AI Overview, Bing's Copilot), which the quiz policy refuses. That search is
# sent on to Google's Web results (udm=14: no AI answer), as the Mac agent does (rewrite_search: the same rules).
$WebOkUdm = @("14","2","12","7","36"); $WebOkTbm = @("isch","nws","vid","bks")
function Query-Map([string]$u) {
  # "a=1&b=x+y" -> @{ a = @("1"); b = @("x y") } (decoded; a name may come more than once).
  $m = @{}
  foreach ($kv in ((Url-Query $u) -split '&')) {
    if (-not $kv) { continue }
    $i = $kv.IndexOf('=')
    $k = if ($i -ge 0) { $kv.Substring(0, $i) } else { $kv }
    $v = if ($i -ge 0) { $kv.Substring($i + 1) } else { "" }
    try { $k = [uri]::UnescapeDataString($k.Replace('+', ' ')) } catch { }
    try { $v = [uri]::UnescapeDataString($v.Replace('+', ' ')) } catch { }
    if (-not $m.ContainsKey($k)) { $m[$k] = @() }
    $m[$k] = @($m[$k]) + @($v)
  }
  return $m
}
function Rewrite-Search([string]$u) {
  # -> the address a locked browser tab is sent to instead ($null = leave it alone).
  if (-not $u) { return $null }
  if (($u -match '^[A-Za-z][A-Za-z0-9+.-]*:') -and ($u -notmatch '^(?i)https?://')) { return $null }
  $h = Url-Host $u; $p = Url-Path $u
  if ($h -notmatch '\.') { return $null }
  $q = Query-Map $u
  $query = ""
  if ($q.ContainsKey("q")) { $query = [string](@($q["q"])[0]) } elseif ($q.ContainsKey("p")) { $query = [string](@($q["p"])[0]) }
  $web = "https://www.google.com/search?udm=14&q=" + [uri]::EscapeDataString($query)
  if (($h -eq "lens.google.com") -or ($h -match '^lens\.google\.[a-z.]+$')) { return $web }   # Lens answers photographed questions
  if (($h -match '^(www\.)?google\.[a-z.]+$') -and ((@("/search","/webhp","/","") -contains $p) -or $p.StartsWith("/ai") -or $p.StartsWith("/searchbyimage"))) {
    if ($p.StartsWith("/ai") -or $p.StartsWith("/searchbyimage")) { return $web }   # AI Mode / image search pages
    $udm = if ($q.ContainsKey("udm")) { @($q["udm"]) } else { @() }
    $tbm = if ($q.ContainsKey("tbm")) { @($q["tbm"]) } else { @() }
    if (($udm.Count + $tbm.Count) -gt 0) {
      # Every udm/tbm on the page must be an AI-free vertical (tbm=nws&udm=50 is not news).
      if ((@($udm | Where-Object { $WebOkUdm -notcontains $_ }).Count -eq 0) -and (@($tbm | Where-Object { $WebOkTbm -notcontains $_ }).Count -eq 0)) { return $null }
      return $web
    }
    if ($query -and ($p -ne "/") -and ($p -ne "")) { return $web }
    return $null
  }
  if ($h.EndsWith("bing.com") -and ($p.StartsWith("/search") -or $p.StartsWith("/copilotsearch") -or $p.StartsWith("/chat"))) { return $web }
  if ($h.EndsWith("duckduckgo.com") -or ($h -eq "duck.ai")) { return $web }
  if ((@("search.yahoo.com","search.brave.com","you.com","kagi.com") -contains $h) -or $h.EndsWith(".search.yahoo.com")) { return $web }
  if ((@(@("ecosia.org","yandex.com","yandex.ru","ya.ru","ask.com","yep.com","sogou.com") | Where-Object { $h.EndsWith($_) }).Count -gt 0) -and ($p.StartsWith("/search") -or $p.StartsWith("/web") -or $p.StartsWith("/chat"))) { return $web }
  if ($h.EndsWith("search.naver.com") -and $p.StartsWith("/search")) { return $web }
  if ($h.EndsWith("search.aol.com") -and $p.StartsWith("/aol/")) { return $web }
  if ((@(@("baidu.com","so.com") | Where-Object { $h.EndsWith($_) }).Count -gt 0) -and (($p -eq "/s") -or $p.StartsWith("/search"))) { return $web }
  return $null
}
function Is-Foreground($w) {
  # The window that holds the keyboard focus (the one the student is looking at): only that one is sent on, so
  # LOCKqz never brings another window to the front.
  try {
    $e = [System.Windows.Automation.AutomationElement]::FocusedElement
    $walk = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    for ($i = 0; $e -and ($i -lt 60); $i++) {
      $up = $walk.GetParent($e)
      if ((-not $up) -or [System.Windows.Automation.Automation]::Compare($up, $Root)) { break }
      $e = $up
    }
    return [bool]($e -and [System.Windows.Automation.Automation]::Compare($e, $w))
  } catch { return $false }
}
$script:SearchMoved = @{}
function Move-ToSearch($edit, [string]$from, [string]$to) {
  # Like Move-ToQuiz: that window's own address bar, never while the student is typing in it, at most once every
  # 10 s per address.
  if (-not $script:SearchMoved) { $script:SearchMoved = @{} }
  $now = [DateTime]::UtcNow
  if ($script:SearchMoved.ContainsKey($from) -and (($now - $script:SearchMoved[$from]).TotalSeconds -lt 10)) { return $false }
  try {
    if ($edit.Current.HasKeyboardFocus) { return $false }
    $vp = $null
    if (-not $edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { return $false }
    $script:SearchMoved[$from] = $now
    if (-not (Type-Address $edit $vp $to)) { return $false }
    Log "web search sent to Google's Web results (no AI answer)"
    return $true
  } catch { return $false }
}
$script:PwFilled = @{}
function Fill-QuizPassword([string]$pw) {
  # Puts the quiz password into the password box of the quiz page itself (UI Automation), so the student
  # never types or pastes it. Only in a browser window whose address bar shows the locked quiz, only in a
  # password box, and each box once per password. -> how many boxes were filled now.
  if (-not $pw) { return 0 }
  $n = 0
  if (-not $script:PwBox) { $script:PwBox = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Edit) }
  if (-not $script:AddressBar) { [void](Get-BrowserWindows) }
  foreach ($w in $Root.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
      if ($BrowserClasses -notcontains $w.Current.ClassName) { continue }
      $bar = $w.FindFirst($TS::Descendants, $script:AddressBar); if (-not $bar) { continue }
      $vp = $null; if (-not $bar.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { continue }
      $u = Inner-Url ([string]$vp.Current.Value)
      if ((-not (Is-Quiz $u)) -or ((Url-Path $u) -match "/attempt/")) { continue }   # never inside the attempt (its answer boxes)
      if ($script:Quiz -and ((Lock-Id $u) -ne [string]$script:Quiz)) { continue }   # only the locked quiz's own page, never another quiz's box
      foreach ($e in $w.FindAll($TS::Descendants, $script:PwBox)) {
        # A password box, or a plain box the page labels as the password. Never the address bar.
        if ([System.Windows.Automation.Automation]::Compare($e, $bar)) { continue }
        if ((-not $e.Current.IsPassword) -and ([string]$e.Current.Name -notmatch '(?i)password')) { continue }
        $id = ($e.GetRuntimeId() -join ".")
        if ($script:PwFilled[$id] -eq $pw) { continue }
        $ev = $null; if (-not $e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$ev)) { continue }
        if ($ev.Current.IsReadOnly) { continue }
        $ev.SetValue($pw); $script:PwFilled[$id] = $pw; $n++
      }
    } catch { }
  }
  if ($n) { Log "quiz password entered in the quiz page ($n box)" }
  return $n
}
function Get-BrowserWindows {
  # -> objects { Title, Url (active tab), Tabs (all tab titles) } for every browser window.
  $out = @(); $names = @{}
  # The address bar: Chromium's is the window's first Edit; Firefox's is the ComboBox "urlbar-input" (no
  # Edit comes before it), so one tree walk finds either.
  if (-not $script:AddressBar) {
    $script:AddressBar = New-Object System.Windows.Automation.OrCondition(
      (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Edit)),
      (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, "urlbar-input")))
  }
  $wins = $Root.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($w in $wins) {
    if ($BrowserClasses -notcontains $w.Current.ClassName) { continue }
    $wpid = $w.Current.ProcessId
    if (-not $names.ContainsKey($wpid)) { $names[$wpid] = [string](Get-Process -Id $wpid -ErrorAction SilentlyContinue).ProcessName }
    $url = ""
    $edit = $w.FindFirst($TS::Descendants, $script:AddressBar)
    if ($edit) { $vp = $null; if ($edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $url = $vp.Current.Value } }
    # A quiz opened from Brightspace Content/Lessons runs in a frame, so its submission never shows in
    # the address bar: move it to its own page (same quiz, same attempt), then every quiz page shows.
    $inner = Inner-Url $url
    if ($edit -and ($inner -ne $url) -and (Is-Quiz $inner)) { [void](Move-ToQuiz $edit $inner) }
    $url = $inner
    # During a quiz, a web search with an AI answer goes to Google's Web results (only the window in front).
    if ($script:Locked -and $edit) { $to = Rewrite-Search $url; if ($to -and (Is-Foreground $w) -and (Move-ToSearch $edit $url $to)) { $url = $to } }
    $tabs = @()
    foreach ($t in $w.FindAll($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::TabItem)))) { $tabs += $t.Current.Name }
    $out += [pscustomobject]@{ Title = $w.Current.Name; Url = $url; Tabs = $tabs; Proc = $names[$wpid]; Hwnd = $w.Current.NativeWindowHandle }
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
    $u = [string]$r.pay.url; if (-not ($u.StartsWith("https://lockqz.com/") -or $u.StartsWith("https://lockqz.pages.dev/"))) { $u = "https://lockqz.com/pay" }
    try { Start-Process $u } catch {}
    # Every way at its own price ("$200 by Zelle, or $210 by card or Venmo") and the memo for Zelle / Venmo; an older server sends one amount.
    $line = [string]$r.pay.line
    if ($line.Trim()) {
      $t = "Pay for LOCKqz this semester to get the quiz password: " + $line.Trim().TrimEnd(".") + "."
      if ($r.pay.code -and ($r.pay.zelle -or $r.pay.venmo)) { $t += "`n`nMemo for Zelle or Venmo:  " + $r.pay.code }
    } else { $t = "Pay `$" + [string]$r.pay.amount + " for LOCKqz this semester to get the quiz password.`n`nMemo:  " + $r.pay.code }
    Show-Message ($t + "`n`nThe payment page is open. LOCKqz shows the password here as soon as your payment arrives.")
  }
  return $true
}
# Once ever: the first time a Brightspace tab is seen after install, a Windows toast says LOCKqz is ready
# and there is nothing to do until the exam. The flag file keeps it to once (survives restarts).
$ReadyFile = "$UserDir\ready-shown"
$script:ReadyTold = Test-Path $ReadyFile
# The "ready" toast only after the server confirms (signed /verify status through the helper) this computer is
# verified, paid and not revoked; otherwise "finish setup" (at most every 6 h) and no flag file, so "ready"
# comes once setup is done. One status check per 30 min; no answer -> nothing shown.
$script:ReadyNext = [DateTime]::MinValue
$script:SetupTold = [DateTime]::MinValue
function Check-Ready {
  if ([DateTime]::UtcNow -lt $script:ReadyNext) { return }
  $script:ReadyNext = [DateTime]::UtcNow.AddMinutes(30)
  $st = $null
  try { $st = Helper "/verify" @{ op = "status" } 15 } catch { Log "ready status: $_"; return }
  if (-not $st -or -not $st.status) { return }
  if (([int]$st.status -eq 200) -and ($st.verified -eq $true) -and ($st.paid -eq $true)) { Show-Ready $true; return }
  if ([DateTime]::UtcNow -lt $script:SetupTold.AddHours(6)) { return }
  $script:SetupTold = [DateTime]::UtcNow
  Show-Ready $false
}
function Show-Ready($ok) {
  if ($ok) {
    $script:ReadyTold = $true
    try { Set-Content $ReadyFile ([DateTime]::UtcNow.ToString("o")) -Encoding UTF8 } catch {}
    $text = "LOCKqz is ready. Nothing to do until your exam " + [char]0x2014 + " just open it in Brightspace."
  } else { $text = "LOCKqz is installed. Finish setup before your exam: open https://lockqz.com" }
  # A toast through WinRT, in its own hidden process (never stalls the watch loop); a message box if toasts are off.
  $cmd = @"
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  `$x = New-Object Windows.Data.Xml.Dom.XmlDocument
  `$x.LoadXml('<toast><visual><binding template="ToastGeneric"><text>LOCKqz</text><text>$text</text></binding></visual></toast>')
  `$t = New-Object Windows.UI.Notifications.ToastNotification `$x
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show(`$t)
} catch { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('$text', 'LOCKqz') | Out-Null }
"@
  try {
    $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
    Start-Process powershell -ArgumentList "-WindowStyle Hidden -EncodedCommand $enc" -WindowStyle Hidden
  } catch { Log "ready notice: $_" }
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
# Browsers LOCKqz turns the AI off in: the policy keys of browser-policy.ps1 (Chrome and the Chromium builds that run as
# chrome, Edge, Brave, Vivaldi) and the Firefox family. Every other browser registered on this PC (the Start menu's
# Internet programs: antivirus "secure browsers" and other Chromium rebrands, Yandex, Arc ...) and the DuckDuckGo app
# keep their AI features, AI extensions and AI search answers: no quiz is taken in them (like Opera), and they are
# closed while locked, never the browser the quiz is in.
$Policed = @("chrome","msedge","brave","vivaldi") + $FirefoxFamily
$UnpolicedApps = @("DuckDuckGo")
$script:RegBrowsers = $null; $script:RegBrowsersAt = [DateTime]::MinValue
function Registered-Browsers {
  # program file (lower case) -> display name of every browser registered for the Start menu (this PC and this user),
  # read at most every 10 minutes.
  if ($script:RegBrowsers -and (([DateTime]::UtcNow - $script:RegBrowsersAt).TotalMinutes -lt 10)) { return $script:RegBrowsers }
  $m = @{}
  foreach ($root in @("HKLM:\SOFTWARE\Clients\StartMenuInternet", "HKLM:\SOFTWARE\WOW6432Node\Clients\StartMenuInternet", "HKCU:\SOFTWARE\Clients\StartMenuInternet")) {
    foreach ($k in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
      try {
        $cmd = [string](Get-ItemProperty -LiteralPath (Join-Path $k.PSPath "shell\open\command") -ErrorAction Stop).'(default)'
        $exe = if ($cmd -match '^\s*"([^"]+?\.exe)"') { $Matches[1] } elseif ($cmd -match '^\s*([^\s"]+?\.exe)') { $Matches[1] } else { "" }
        if ($exe) {
          $nm = [string](Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue).'(default)'
          $m[$exe.ToLowerInvariant()] = $(if ($nm) { $nm } else { [string]$k.PSChildName })
        }
      } catch { }
    }
  }
  $script:RegBrowsers = $m; $script:RegBrowsersAt = [DateTime]::UtcNow
  return $m
}
function Browser-Name([string]$proc) {
  # What the student calls a browser LOCKqz cannot police: its Start menu name, else its program's product name.
  if ($NoPolicy -contains $proc) { return "Opera" }
  $reg = Registered-Browsers
  foreach ($p in @(Get-Process -Name $proc -ErrorAction SilentlyContinue)) {
    $path = ""; try { $path = [string]$p.Path } catch { }
    if ($path -and $reg.ContainsKey($path.ToLowerInvariant())) { return [string]$reg[$path.ToLowerInvariant()] }
    try { if ($p.Product) { return [string]$p.Product } } catch { }
  }
  return $(if ($proc) { $proc } else { "This browser" })
}
function Close-Unpoliced([string]$keep) {
  # The running browsers without LOCKqz's policies (registered ones matched by their program file, so another
  # program with the same file name is never touched), never $keep: asked to close, then forced. -> their names.
  $reg = Registered-Browsers
  $cand = @($UnpolicedApps)
  foreach ($exe in @($reg.Keys)) { $b = [IO.Path]::GetFileNameWithoutExtension($exe); if ($cand -notcontains $b) { $cand += $b } }
  $ps = @(); $names = @()
  foreach ($p in @(Get-Process -Name $cand -ErrorAction SilentlyContinue)) {
    $n = [string]$p.ProcessName
    if (($n -eq $keep) -or ($Policed -contains $n) -or ($NoPolicy -contains $n) -or ($n -eq "iexplore")) { continue }
    $label = $null
    if ($UnpolicedApps -contains $n) { $label = $n }
    else { $path = ""; try { $path = [string]$p.Path } catch { }; if ($path -and $reg.ContainsKey($path.ToLowerInvariant())) { $label = [string]$reg[$path.ToLowerInvariant()] } }
    if (-not $label) { continue }
    $ps += $p; if ($names -notcontains $label) { $names += $label }
  }
  if ($ps.Count -eq 0) { return @() }
  foreach ($p in $ps) { try { [void]$p.CloseMainWindow() } catch { } }
  Start-Sleep -Seconds 3
  foreach ($p in $ps) { try { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } } catch { } }
  return @($names)
}
function Join-Names($names) { $n = @($names); if ($n.Count -gt 1) { (($n[0..($n.Count - 2)]) -join ", ") + " and " + $n[-1] } else { [string]($n -join "") } }
function Restart-QuizFirefox([string]$name, [datetime]$lockedAt) {
  # The exam is open in a Firefox (or fork) that was already running when this lock began: it reads the quiz policies
  # (its AI, encrypted DNS and built-in VPN off, AI sites blocked) only when it starts, so it is restarted once, now
  # (a forced close: it comes back with its tabs). -> $true when restarted.
  $ps = @(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { try { $_.StartTime.ToUniversalTime() -lt $lockedAt.AddSeconds(-1) } catch { $true } })
  if ($ps.Count -eq 0) { return $false }
  $exe = (@($ps | Where-Object { $_.Path }) | Select-Object -First 1).Path
  foreach ($p in $ps) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { } }
  $script:RestartWait = [DateTime]::UtcNow.AddSeconds(120)   # its exam page is gone until it is back (not "the exam was closed")
  if ($exe) { Start-Sleep -Seconds 2; try { Start-Process -FilePath $exe } catch { Log "reopen $name failed: $_" } }
  Log "$name restarted for the quiz (quiz policies are read when it starts)"
  return $true
}
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
$EmailRe = '^[A-Za-z0-9._%+''-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'   # ' is a real email character (o'brien@...)
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
$script:VToken = $null   # proof of a confirmed email (kept on the computer, survives reinstall)
function Save-Student($email, $verified) {
  $o = @{ student = $(if ($email) { $email } else { $null }); verified = [bool]$verified }
  if ($script:VToken) { $o.vtoken = [string]$script:VToken }
  try { $o | ConvertTo-Json | Set-Content $StudentFile -Encoding UTF8 }
  catch { Log "could not save student: $_" }
}
function Open-PayAfterSetup {
  # Right after the one-time setup: this semester's fee is not paid yet -> the student's own pay page opens by
  # itself (no email to wait for). Nothing opens for a paid student or when there is no fee.
  try {
    $st = Verify "status" $null
    if ($st -and ($st.verified -is [bool]) -and $st.verified -and ($st.paid -is [bool]) -and (-not $st.paid) -and $st.pay_url) {
      $u = [string]$st.pay_url
      if ($u.StartsWith("https://lockqz.com/") -or $u.StartsWith("https://lockqz.pages.dev/")) { Start-Process $u; Log "setup done: pay page opened" }
    }
  } catch { Log "pay page after setup: $_" }
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
# One click instead of an emailed code: sign in with the school Google account in the browser; the server
# confirms the email and this PC sees it through "status". -> @{ student; verified } when done; $null = use
# the email code (Google sign-in off, not chosen, or not finished); $false = the dialog was closed.
$GoogleSite = if ($env:LOCKQZ_SITE) { $env:LOCKQZ_SITE.TrimEnd("/") } else { "https://lockqz.pages.dev" }
function Google-Setup($state) {
  $g = Verify "google_start" $null
  if (-not ($g -and $g.url)) { return $null }
  $u = [string]$g.url
  $gsRe = if ($env:LOCKQZ_SITE) { [regex]::Escape($GoogleSite) } else { 'https://lockqz\.(com|pages\.dev)' }
  if ($u -notmatch ('^' + $gsRe + '/google\?n=[0-9a-f]{32}$')) { return $null }
  $a = Ask-Box "LOCKqz setup (one time only)`n`nConfirm your school email with your USC Google account." @("Use an email code", "Sign in with Google") "" $false
  if (-not $a) { $state.r = "closed"; return $false }
  if ($a.b -ne "Sign in with Google") { return $null }
  try { Start-Process "explorer.exe" -ArgumentList $u -ErrorAction SilentlyContinue } catch {}
  $end = (Now-Sec) + 600
  while ((Now-Sec) -lt $end) {
    Start-Sleep -Seconds 4
    $st = Verify "status" $null
    if ($st -and $st.verified -and $st.student) { if ($st.vtoken) { $script:VToken = [string]$st.vtoken }; Say "Done. LOCKqz is set up and won't ask again."; return @{ student = $st.student; verified = $true } }
  }
  return $null
}
function Setup-Identity($saved, $state) {
  # -> @{ student; verified } to save, or $null ($state.r = "server": retry quietly; "closed": dialog closed)
  if ($null -eq $state) { $state = @{ sent_email = ""; sent_at = 0; r = "" } }
  $state.r = "server"
  $st = Verify "status" $null
  if (-not $st) { return $null }
  if ($st.verified -and $st.student) { if ($st.vtoken) { $script:VToken = [string]$st.vtoken }; return @{ student = $st.student; verified = $true } }
  if ((-not $st.codes) -and $st.student) { return @{ student = $st.student; verified = $false } }
  $email = ([string]$(if ($saved) { $saved } else { $st.student })).Trim().ToLower()
  if ($email -notmatch $EmailRe) { $email = "" }
  if ($email -and $script:VToken) {
    # Confirmed before on this computer (e.g. LOCKqz was reinstalled): the saved proof does it, no dialog.
    $r = Verify "token" @{ email = $email; vtoken = [string]$script:VToken }
    if ($r -and $r.verified) { if ($r.vtoken) { $script:VToken = [string]$r.vtoken }; return @{ student = $email; verified = $true } }
    if (-not $r) { return $null }
    if ($r.error -eq "bad_token") { $script:VToken = $null }
  }
  while ($true) {
    if (-not $email) {
      $gs = Google-Setup $state
      if (($gs -is [bool]) -and (-not $gs)) { return $null }   # the student closed the dialog
      if ($gs) { return $gs }
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
      $a = Ask-Box ($note + "We emailed a 6-digit code to`n" + $email + "`nIt comes from support@lockqz.com.`n`nType it here (check Junk/Spam if you don't see it):") @("Change email", "Send new code", "OK") "" $true
      if (-not $a) { $state.r = "closed"; return $null }
      if ($a.b -eq "Change email") { $email = ""; $state.sent_email = ""; Save-Student $null $false; break }
      if ($a.b -eq "Send new code") {
        $r = Verify "send" @{ email = $email }
        if (-not ($r -and $r.sent)) { $note = "LOCKqz couldn't send a new code right now. Use the last one, or try again in a few minutes.`n`n"; continue }
        $state.sent_email = $email; $state.sent_at = Now-Sec
        $note = "New code sent.`n`n"; continue
      }
      $r = Verify "code" @{ email = $email; code = $a.t }
      if ($r -and $r.verified) { $state.sent_email = ""; if ($r.vtoken) { $script:VToken = [string]$r.vtoken }; Say "Done. LOCKqz is set up and won't ask again."; return @{ student = $email; verified = $true } }
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
  $saved = $null; try { if (Test-Path $StudentFile) { $sj = Get-Content $StudentFile -Raw | ConvertFrom-Json; $saved = $sj.student; if ($sj.vtoken) { $script:VToken = [string]$sj.vtoken } } } catch {}
  $wasVerified = $false; try { $wasVerified = [bool]$sj.verified } catch {}
  $got = $null
  try { $got = Setup-Identity $saved $state } catch { Log "identity setup error: $_"; $state.r = "server" }
  if ($got) {
    Save-Student $got.student $got.verified
    if ($got.verified -and (-not $wasVerified)) { Open-PayAfterSetup }   # setup just finished: straight to the pay page
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
  $script:SetupAt = [DateTime]::UtcNow
  $qa = if ($Quiz) { " -QuizOpen" } else { "" }
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Setup$qa"
}
Load-Student
Start-Setup -Force   # checks the server once per login; asks only if not yet confirmed
try { Helper "/student" @{ student = $Student } 8 | Out-Null } catch { Log "helper not reachable yet" }
Log "running (device $Device, student $Student)"

# ---- programs that hide their windows from screen capture (22 Nov 2026) ----
# AI assistants that sit over the screen (Cluely and its many copies; the free ones can be renamed at will) hide their
# windows from screen capture (SetWindowDisplayAffinity, Electron setContentProtection). During a quiz any program of
# this user with such a window is closed, whatever its name, except Windows' own code (the Windows folder, Microsoft's
# Store apps) and what people need beside a quiz: $KeepApps plus the server's additions in keep.txt (the helper writes
# it with the AI list), so an app closed by mistake is fixed from the server without an update.
$KeepApps = @("Zoom","CptHost","aomhost64","zWebview2Agent","ms-teams","Teams","msteams","CiscoCollabHost","webexmta","atmgr",
  "CiscoWebexStart","ptoneclk","WebexHost","Webex","GoTo","g2mcomm","g2mstart","g2mui","GoToMeeting","RingCentral","RingCentral Video",
  "Chime","BlueJeans","Jitsi Meet","wemeetapp","WeMeet","TencentMeeting","VooVMeeting","WeChat","Weixin","WeChatAppEx","DingTalk","Lark","Feishu",
  "chrome","msedge","msedgewebview2","firefox","brave","vivaldi","arc","iexplore",
  "1Password","Bitwarden","KeePassXC","KeePass","Dashlane","keeperpasswordmanager","Keeper Password Manager","NordPass","ProtonPass",
  "Proton Pass","Enpass","RoboForm","robotaskbaricon","LastPass","StickyPassword","Signal",
  "obs64","obs32","obs","Loom","ShareX","Snagit32","SnagitEditor","SnagitCapture","CamtasiaStudio","CamtasiaRecorder","Greenshot",
  "Lightshot","ScreenToGif","bdcam","Bandicam","Screenpresso","Monosnap",
  "nvda","nvda_slave","jfw","ZoomText","Zt","ZoomTextFusion","Fusion","ReadAndWrite","TextHelpReadAndWrite","Kurzweil 3000","natspeak",
  "Dragon","dragonbar","SuperNova","ClaroRead","WordQ",
  "LockDownBrowser","LockDownBrowserOEM","Respondus LockDown Browser","SafeExamBrowser","Safe Exam Browser","Honorlock","Guardian",
  "GuardianBrowser","Examplify","ExamSoft","Inspera Exam Portal","InsperaExamPortal","LOCKqz")
$KeepFile = if ($env:LOCKQZ_KEEP_FILE) { $env:LOCKQZ_KEEP_FILE } else { "$env:ProgramData\LOCKqz\keep.txt" }
# Security and graphics software is never closed, whatever it names its programs: an antivirus may hide its own alerts
# from capture (and treats an attempt to close it as an attack on itself); graphics and game overlays may hide theirs.
$KeepSigners = @("Microsoft Corporation", "Microsoft Windows", "NVIDIA Corporation", "Advanced Micro Devices", "Intel Corporation",
  "Gen Digital", "NortonLifeLock", "Symantec", "McAfee", "Avast Software", "AVG Technologies", "Bitdefender", "Kaspersky", "ESET",
  "Malwarebytes", "Sophos", "Trend Micro", "Webroot", "Avira", "F-Secure", "WithSecure", "CrowdStrike", "SentinelOne", "Cisco",
  "Zoom Video Communications", "Zoom Communications", "Google LLC", "Mozilla Corporation", "Brave Software")
$SignerCache = @{}
$HiddenNoClose = New-Object 'System.Collections.Generic.HashSet[int]'
function Signer-Kept([string]$path) {
  # $true when the program file carries a valid signature of one of $KeepSigners (checked once per file)
  if (-not $path) { return $false }
  if ($script:SignerCache.ContainsKey($path)) { return $script:SignerCache[$path] }
  $ok = $false
  try {
    $sig = Get-AuthenticodeSignature -LiteralPath $path -ErrorAction Stop
    if ($sig.Status -eq 'Valid' -and $sig.SignerCertificate) {
      $subj = [string]$sig.SignerCertificate.Subject
      foreach ($k in $script:KeepSigners) { if ($subj -match ('(^|, )O="?' + [regex]::Escape($k))) { $ok = $true; break } }
    }
  } catch { }
  $script:SignerCache[$path] = $ok
  return $ok
}
function Tell-Student($st) {
  # A helper that came up after this agent (an update or a reboot restarts both) missed the student this agent told
  # it at start: tell it again once it answers.
  if ($script:Student -and $st -and (@($st.PSObject.Properties.Name) -contains "student") -and -not $st.student) {
    try { Helper "/student" @{ student = $script:Student } | Out-Null; Log "told the helper the student again ($script:Student)" } catch { }
  }
}
function Get-HiddenPids {
  # -> the process ids that own a top-level window hidden from screen capture (display affinity not WDA_NONE)
  if (-not ('LqHidden' -as [type])) {
    Add-Type -ErrorAction Stop -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class LqHidden {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static uint[] Pids() {
    Dictionary<uint, bool> s = new Dictionary<uint, bool>();
    EnumProc cb = delegate (IntPtr h, IntPtr l) {
      uint a, p;
      if (GetWindowDisplayAffinity(h, out a) && a != 0 && GetWindowThreadProcessId(h, out p) != 0 && p != 0) s[p] = true;
      return true;
    };
    EnumWindows(cb, IntPtr.Zero); GC.KeepAlive(cb);
    return new List<uint>(s.Keys).ToArray();
  }
}
'@
  }
  return @([LqHidden]::Pids())
}
function Read-KeepApps([string]$file) {
  # the shipped never-close list plus the server's additions (each a program name; "id:" entries are for Macs)
  $k = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($a in $script:KeepApps) { [void]$k.Add([string]$a) }
  try {
    if ($file -and (Test-Path -LiteralPath $file)) {
      foreach ($l in [IO.File]::ReadAllLines($file)) { $t = $l.Trim(); if ($t -cmatch '^[A-Za-z0-9][A-Za-z0-9 ._&+()-]{1,59}$') { [void]$k.Add($t) } }
    }
  } catch { }
  return ,$k
}
function Keep-Hidden([string]$name, [string]$path, $keep) {
  # $true = stays open: Windows' own code, Microsoft's own Store apps, or a name on the never-close list
  if (-not $path) { return $true }   # unreadable: an elevated or system program, not this user's to close
  $w = ([string]$env:WINDIR).TrimEnd('\')
  if ($w -and $path.StartsWith($w + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
  if ($path -match '\\WindowsApps\\[^\\]+__8wekyb3d8bbwe\\') { return $true }   # Teams, Snipping Tool, Game Bar, ...
  if ($keep.Contains($name)) { return $true }
  return (Signer-Kept $path)   # security and graphics software (see $KeepSigners)
}
function Close-HiddenApps($keep) {
  # every few seconds during a quiz -> the names closed
  $closed = @()
  $ids = @(); try { $ids = @(Get-HiddenPids) } catch { return $closed }
  foreach ($id in $ids) {
    if (([int]$id -eq $PID) -or $script:HiddenNoClose.Contains([int]$id)) { continue }
    $p = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue; if (-not $p) { continue }
    $path = ""; try { $path = [string]$p.Path } catch { }
    if (Keep-Hidden ([string]$p.ProcessName) $path $keep) { continue }
    try { Stop-Process -Id ([int]$id) -Force -ErrorAction Stop; $closed += [string]$p.ProcessName; Log "closed $($p.ProcessName) ($path): it hides its windows from screen capture" }
    catch { [void]$script:HiddenNoClose.Add([int]$id); Log "could not close $($p.ProcessName) (not tried again): $_" }
  }
  return $closed
}
$HiddenAt = [DateTime]::MinValue; $UnpolAt = [DateTime]::MinValue; $script:UnpolTold = $false

# ---- main loop ----
$Locked = $false; $Quiz = $null; $QuizTab = $null; $QuizTitle = $null; $QuizUrl = $null; $QuizProc = ""
# Every timer below runs on UTC ([DateTime]::UtcNow), never local Get-Date: local time jumps back an
# hour when daylight saving ends (1 Nov 2026, 2:00 -> 1:00), which froze password checks, the quiz-
# closed grace and heartbeats for an hour. UTC never jumps; only the "opens at" text is shown local.
$LastPw = $null; $PwNext = [DateTime]::UtcNow; $StartTold = $null; $MissingSince = $null; $LastBeat = [DateTime]::UtcNow; $LastCheck = Get-Date "2000-01-01"
$Pending = $null; $PendingAt = Get-Date "2000-01-01"; $OperaWarned = $false
# Quizzes the helper released (safety cap, the server's "submitted"/"ended", another school): never
# re-locked while their page stays open; forgotten once the page has been gone for the grace period.
$Capped = @{}
# Quizzes the helper did not lock because LOCKqz does not protect them (class or exam not using LOCKqz):
# asked again every 3 minutes while the page stays open (its professor may turn LOCKqz on).
$NoLock = @{}
function NoLock-Now([string]$q) { $NoLock.ContainsKey($q) -and ([DateTime]::UtcNow -lt $NoLock[$q]) }
$CapLeft = @{}     # quiz id -> its page left the attempt pages since the release (summary seen)
$CapForgot = @{}   # quiz id -> unix time this agent forgot its release (the helper's older one is ignored)
$CapWhy = @{}      # quiz id -> why it was released (the helper's capped_reason)
# A quiz the server released because Brightspace says the attempt is over (submitted, or a gated quiz's end): once its
# pages have been gone this long it locks normally again, so a student who goes back for another attempt is handed the
# password at once (it is entered before the attempt starts). The safety cap and the other releases keep $Grace.
$SrvGrace = 5; $SrvEnds = @("quiz_submitted", "quiz_ended")
function Add-Cap([string]$q, [string]$why = "") {
  if (-not $script:Capped.ContainsKey($q)) { $script:CapLeft[$q] = $false; $script:CapWhy[$q] = $why } elseif ($why) { $script:CapWhy[$q] = $why }
  if ($SrvEnds -contains $why) { Attempt-Over $q }   # Brightspace says the attempt is over
  $script:Capped[$q] = [DateTime]::UtcNow
}
function Note-Cap($st) {
  # The helper reports a release: remembered unless it is one this agent already forgot.
  if (-not $st -or -not $st.capped_quiz) { return }
  $q = [string]$st.capped_quiz
  if ($script:Capped.ContainsKey($q)) { return }
  $at = [int64]0; [void][int64]::TryParse([string]$st.capped_at, [ref]$at)
  if ($script:CapForgot.ContainsKey($q) -and ($at -le [int64]$script:CapForgot[$q])) { return }
  Add-Cap $q ([string]$st.capped_reason)
}
function Forget-Cap([string]$q, [string]$why) {
  # Page closed or a NEW attempt started: the quiz locks normally again; the helper forgets it too.
  $script:Capped.Remove($q); $script:CapLeft.Remove($q); $script:CapWhy.Remove($q); $script:CapForgot[$q] = [int64][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
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
      $script:Capped[$cq] = [DateTime]::UtcNow
    } elseif (([DateTime]::UtcNow - [datetime]$script:Capped[$cq]).TotalSeconds -gt $(if ($SrvEnds -contains [string]$script:CapWhy[$cq]) { $SrvGrace } else { $Grace })) { Forget-Cap $cq "page closed" }
  }
}
function Next-PwCheck([datetime]$now, $opens) {
  # C2: a quiz that has not opened yet is asked every 5 min until 90 s before it opens, then every 15 s.
  if ($null -eq $opens) { return $now.AddSeconds(300) }
  $t = ([datetime]$opens).AddSeconds(-90)
  if ($now -lt $t) { if ($t -lt $now.AddSeconds(300)) { return $t } else { return $now.AddSeconds(300) } }
  return $now.AddSeconds(15)
}
$PwWait = 40
function Step-Pw([datetime]$now) {
  # Every look while a quiz is locked and has not started: enter the password wherever its box now is. The
  # password is never shown or copied (a password a student can read can be passed to a computer without
  # LOCKqz). No box for $PwWait seconds after the password arrived -> the student is told, once, where LOCKqz
  # enters it; it is still entered the moment the box shows.
  if (-not $script:LastPw) { return }
  if ((Fill-QuizPassword $script:LastPw) -gt 0) { $script:PwEntered = $true }
  if ((-not $script:PwEntered) -and (-not $script:PwTold) -and $script:PwSince -and (($now - $script:PwSince).TotalSeconds -gt $PwWait)) {
    $script:PwTold = $true
    Show-Message "LOCKqz has the quiz password ready. Open the quiz's start page (the one with Start Quiz) in Chrome, Edge or Firefox: LOCKqz enters it there."
  }
}
# What the student is told at the lock about the professor's rules for this exam (the server's names for them).
$ExamNote = @{ "Notes + internet" = "`n`nMessaging apps are closed until you submit."; "Notes only" = "`n`nOnly Brightspace and your notes and files are open until you submit."
               "Custom" = "`n`nYour professor chose what else is open until you submit." }
function Handle-Pw($pr, [bool]$first, [string]$note) {
  # Acts on the helper's /password answer -> "pw" | "pay" | "wait" | "other" | $null (nothing yet), and
  # sets when the next check may run ($PwNext).
  $now = [DateTime]::UtcNow
  if ($pr -and ($pr.exam -is [string]) -and $ExamNote.ContainsKey($pr.exam)) { $note = $note + $ExamNote[$pr.exam] }
  if ($pr -and $pr.password) {
    $rc = 15; if ($null -ne $pr.recheck) { $rc = [Math]::Max(15, [Math]::Min(360, [int]$pr.recheck)) }   # gated: next code change
    $pw = [string]$pr.password; $script:PwNext = $now.AddSeconds($rc)
    if ($pw -ne $script:LastPw) {
      # LOCKqz enters the password in the quiz page itself (Fill-QuizPassword, now and on every look while the
      # quiz has not started): nothing to type or paste, never shown or copied (Step-Pw).
      $script:LastPw = $pw; $script:PwSince = $now; $script:PwTold = $false
      $script:PwEntered = ((Fill-QuizPassword $pw) -gt 0)
      if ($first) { Show-Message ("AI is locked for this quiz.`n`nLOCKqz enters the quiz password for you. Just start the quiz." + $note) }
    }
    return "pw"
  }
  if (Show-Pay $pr) {
    # Unpaid at the exam: asked again at the server's pace (a few seconds) for the first 10 minutes after the
    # pay page opened, so the password follows the payment at once; after that every 15 s.
    if ($null -eq $script:PaySince) { $script:PaySince = $now }
    $prc = 15; $prn = 0
    if (($null -ne $pr.recheck) -and [int]::TryParse([string]$pr.recheck, [ref]$prn) -and (($now - [datetime]$script:PaySince).TotalSeconds -lt 600)) { $prc = [Math]::Max(2, [Math]::Min(15, $prn)) }
    $script:PwNext = $now.AddSeconds($prc); if ($first -and $note) { Show-Message ("AI is locked for this quiz." + $note) }; return "pay"
  }
  $why = if ($pr) { [string]$pr.reason } else { "" }
  if ($why -eq "not started") {
    $opens = $null; $si = [int64]0
    if (($null -ne $pr.start_in) -and [int64]::TryParse([string]$pr.start_in, [ref]$si)) { $opens = $now.AddSeconds($si) }
    $script:PwNext = Next-PwCheck $now $opens
    if ($script:StartTold -ne $script:Quiz) {
      $script:StartTold = $script:Quiz
      $at = if ($opens) { $opens.ToLocalTime().ToString("h:mm tt") } else { "its start time" }   # timers run on UTC; shown in the student's own zone
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
  if ($why -eq "not_protected") {
    # This class is not using LOCKqz (its professor has not signed up / is not active). AI was locked when
    # the quiz opened; restore it now, quietly, and report nothing.
    $q = [string]$script:Quiz
    [void](Send-Unlock $q "not_protected")
    Add-Cap $q
    Log "not protected: $q (class not using LOCKqz)"
    Clear-Quiz
    return "other"
  }
  if (($why -eq "verify") -and (([DateTime]::UtcNow - $script:SetupAt).TotalSeconds -gt 60)) { Start-Setup -Quiz }   # school email first
  if (($why -eq "gate_off") -and ($script:GateTold -ne $script:Quiz)) {
    # The professor's gate is not running yet: the password is held; it arrives by itself.
    $script:GateTold = $script:Quiz
    Show-Message ("AI is locked for this quiz.`n`nThe quiz opens once your professor's LOCKqz is running. The password appears here by itself." + $note)
  }
  if ((($why -eq "in_use") -or ($why -eq "too_many_devices")) -and ($script:ShareTold -ne $script:Quiz)) {
    # One payment = one student: the paid email is in use on another computer.
    $script:ShareTold = $script:Quiz
    if ($why -eq "in_use") { Show-Message "This school email is in a quiz on another computer right now.`n`nOne payment covers one student." }
    else { Show-Message "This school email is already used on 2 computers.`n`nEmail support@lockqz.com to remove one." }
  }
  if ($why -eq "vm") {
    # LOCKqz runs inside a virtual machine: no password (the real computer around it keeps AI).
    if ($script:VmTold -ne $script:Quiz) { $script:VmTold = $script:Quiz; Show-Message "This quiz can't open inside a virtual machine.`n`nOpen it on the computer itself." }
    $script:PwNext = $now.AddSeconds(120)
    return "vm"
  }
  # LOCKqz busy (free-plan limit) or unreachable: back off with jitter (30 s .. 5 min); any answer resets it.
  if ((-not $why) -and ((-not $pr) -or ($pr.error -eq "server_busy"))) {
    $script:BusyN = [int]$script:BusyN + 1
    $script:PwNext = $now.AddSeconds([Math]::Min(300, 15 * [Math]::Pow(2, [Math]::Min($script:BusyN, 5))) * (0.5 + (Get-Random -Maximum 1.0) / 2))
    return $null
  }
  $script:BusyN = 0
  $script:PwNext = $now.AddSeconds(15)
  return $null
}
function Clear-Quiz { $script:Locked = $false; $script:Quiz = $null; $script:QuizTab = $null; $script:QuizTitle = $null; $script:QuizUrl = $null; $script:QuizProc = ""; $script:MissingSince = $null; $script:OperaWarned = $false; $script:UnpolTold = $false }
$script:HoldTold = $null
$HoldText = "AI stays off: this exam was not turned in on this computer.`n`nGo back to the exam and submit it. AI comes back the moment it is submitted. If you did submit, AI comes back by itself once Brightspace shows it, or when the exam ends."
function Attempt-Over([string]$quiz) {
  # The lock ended with AI back (the PC's own turned-in page, or the server vouched): an attempt page seen before is
  # over, so a later visit to the exam (its start page, to look at a score) starts fresh and ends the moment the
  # student leaves it. A new attempt is seen again on its own page.
  if ($quiz -and $script:Seen.ContainsKey($quiz)) { $script:Seen[$quiz].attempt = $false }
}
function Send-Unlock($quiz, $reason) {
  # -> $true only when the helper confirmed it is unlocked. 202 pending = the server has not vouched for the
  # quiz end yet (held): told to the student once per quiz, retried quietly.
  try {
    $r = Helper "/unlock" @{ quiz_id = $quiz; reason = $reason; seen = (Seen-For ([string]$quiz)) }
    if ($r -and $r.pending -and ($script:HoldTold -ne $quiz)) { $script:HoldTold = $quiz; Show-Message $HoldText }
    $ok = [bool]($r -and $r.ok -and ($r.state -eq "unlocked"))
    if ($ok) { Attempt-Over ([string]$quiz) }
    return $ok
  } catch { return $false }
}
$GoneAt = $null
while ($true) {
  # LOCKqz removed while this agent still runs (the remover stops it first; this is the fallback): stop. Never while a
  # quiz is locked, and only once both scripts have been gone for 30 s (an update replaces one file at a time).
  if ((-not $Locked) -and $PSCommandPath -and -not (Test-Path -LiteralPath $PSCommandPath) -and -not (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $PSCommandPath) "lockqzd.ps1"))) {
    if (-not $GoneAt) { $GoneAt = [DateTime]::UtcNow } elseif (([DateTime]::UtcNow - $GoneAt).TotalSeconds -ge 30) { Log "LOCKqz was removed from this PC - stopping"; exit 0 }
  } else { $GoneAt = $null }
  try {
    $wins = @(Get-BrowserWindows)
    if ((-not $ReadyTold) -and (@($wins | Where-Object { $_.Url -match '/d2l/' }).Count -gt 0)) { Check-Ready }
    # A quiz open in Opera (or another browser LOCKqz cannot police) and in another browser: the other browser's window
    # counts (no lock in the first).
    $qws = @($wins | Where-Object { Is-Quiz $_.Url })
    $quizWin = (@($qws | Where-Object { $Policed -contains [string]$_.Proc }) + @($qws | Where-Object { $Policed -notcontains [string]$_.Proc })) | Select-Object -First 1
    $openId = if ($quizWin) { Lock-Id $quizWin.Url } else { $null }
    Step-Caps $openId $(if ($quizWin) { $quizWin.Url } else { "" })
    if (-not $Verified) {
      if ((Test-Path $StudentFile) -and ((Get-Item $StudentFile).LastWriteTime -gt $StudentRead)) { Load-Student; if ($Student) { try { Helper "/student" @{ student = $Student } | Out-Null } catch {} } }
      $since = ([DateTime]::UtcNow - $SetupAt).TotalSeconds
      if ((-not $Verified) -and ($since -gt 60)) { Start-Setup -Quiz:($null -ne $quizWin) }
    }
    # An unlock the helper did not confirm is retried every 5 s until it is (AI must come back).
    if ($Pending -and (-not $quizWin) -and (([DateTime]::UtcNow - $PendingAt).TotalSeconds -ge 5)) {
      $PendingAt = [DateTime]::UtcNow
      if (Send-Unlock $Pending.quiz $Pending.reason) {
        Log "UNLOCKED on retry ($($Pending.reason))"
        if (($FirefoxFamily -notcontains [string]$Pending.proc) -and (@($wins | Where-Object { $FirefoxFamily -contains $_.Proc }).Count -gt 0)) { Show-Message "AI is unlocked. Restart Firefox to get its AI features back." }
        $Pending = $null
      }
    }
    if (-not $Locked) {
      if ($quizWin -and ($Policed -notcontains [string]$quizWin.Proc) -and -not $Capped.ContainsKey($openId) -and -not (NoLock-Now ([string]$openId))) {
        # Opera has no policy layer (its Aria AI and built-in VPN stay on), nor has any browser outside $Policed: a quiz
        # open there is neither locked nor given its password; the student is told once to open it in another browser.
        $NoLock[[string]$openId] = [DateTime]::UtcNow.AddSeconds(20)
        $bn = Browser-Name ([string]$quizWin.Proc)
        if ($script:OperaToldQuiz -ne [string]$openId) { $script:OperaToldQuiz = [string]$openId; Show-Message "$bn cannot turn its AI off during a quiz.`n`nOpen this quiz in Chrome, Edge or Firefox to take it." }
        Log "quiz $openId is open in $bn (no AI policy) - not locked, no password"
      } elseif ($quizWin -and -not $Capped.ContainsKey($openId) -and -not (NoLock-Now ([string]$openId))) {
        $Pending = $null
        $Quiz = $openId
        $QuizTab = Get-ActiveTab $quizWin; $QuizTitle = Clean-Title $quizWin.Title; $QuizProc = [string]$quizWin.Proc
        $r = $null; try { $r = Helper "/lock" @{ quiz_id = $Quiz; student = $Student; url = $quizWin.Url } } catch {}
        if ($r -and $r.not_protected) {
          # Not LOCKqz's quiz: nothing locked, nothing closed, nothing said.
          $NoLock[[string]$Quiz] = [DateTime]::UtcNow.AddSeconds(180); Log "not protected: $Quiz ($($r.reason)) - not locked"; Clear-Quiz
        } elseif ($r -and $r.ok -and ($r.capped_quiz -eq $Quiz)) {
          # C9: the server says this student already finished this quiz - the helper did not lock.
          Add-Cap ([string]$Quiz) ([string]$r.capped_reason); Log "server: $Quiz is over ($($r.capped_reason)) - not locked"; Clear-Quiz
        } elseif ($r -and $r.ok) {
          $QuizUrl = $quizWin.Url; $LastCheck = [DateTime]::UtcNow; $lockedAt = [DateTime]::UtcNow
          $Locked = $true; $MissingSince = $null; $LastBeat = [DateTime]::UtcNow; Log "LOCKED $Quiz"
          # What was seen of this exam's attempt is kept for 6 h (a student who stepped out and came back is still in
          # the same attempt); another exam starts fresh.
          $nowL = [DateTime]::UtcNow
          foreach ($k in @($script:Seen.Keys)) { if (($nowL - [datetime]$script:Seen[$k].at).TotalHours -gt 6) { $script:Seen.Remove($k) } }
          if (-not $script:Seen.ContainsKey([string]$Quiz)) { $script:Seen[[string]$Quiz] = @{ attempt = $false; sub = $false; rt = $true; at = $nowL } }
          $script:Seen[[string]$Quiz].sub = $false; $script:AttWin = @{}
          $restarted = ($FirefoxFamily -contains $QuizProc) -and (Restart-QuizFirefox $QuizProc $lockedAt)
          $closed = @(); $kept = @()   # $kept: closed for the whole quiz (no policy), not to be reopened before it ends
          if (Close-Browsers $FirefoxFamily $QuizProc) { $closed += "Firefox" }
          if (Close-Browsers $NoPolicy $QuizProc) { $kept += "Opera"; $OperaWarned = $true }
          $un = @(Close-Unpoliced $QuizProc); if ($un.Count) { $kept += $un; $script:UnpolTold = $true }
          # Brave reads its quiz policies (Leo, Tor windows, VPN off) only when it starts: close it once.
          if (Close-Browsers @("brave") $QuizProc) { $closed += "Brave" }
          $rnote = if ($restarted) { "`n`nFirefox was restarted for the exam so its AI stays off. Your tabs come back." } else { "" }
          $note = $rnote + $(if ($closed.Count -gt 1) { "`n`n" + (Join-Names $closed) + " were closed for the quiz so their AI stays off. You can reopen them; your tabs come back." } elseif ($closed.Count) { "`n`n" + $closed[0] + " was closed for the quiz so its AI stays off. You can reopen it; your tabs come back." } else { "" })
          $note += $(if ($kept.Count -gt 1) { "`n`n" + (Join-Names $kept) + " were closed: they cannot turn their AI off during a quiz. Use them again after the quiz." } elseif ($kept.Count) { "`n`n" + $kept[0] + " was closed: it cannot turn its AI off during a quiz. Use it again after the quiz." } else { "" })
          $LastPw = $null; $StartTold = $null; $script:PayShown = $false; $script:PaySince = $null; $res = $null
          $script:PwFilled = @{}; $script:PwEntered = $false; $script:PwTold = $false; $script:PwSince = $null
          for ($i = 0; ($i -lt 3) -and (-not $res); $i++) {
            try { $res = Handle-Pw (Helper "/password" @{ url = $quizWin.Url }) $true $note } catch { Log "password via helper failed: $_" }
            if (-not $res) { Start-Sleep -Seconds 2 }
          }
          if ($res -eq "other") { Clear-Quiz }
          elseif (-not $res) { Show-Message ("AI is locked for this quiz.`n`nIf it needs a password, LOCKqz will show it here as soon as the quiz opens." + $note) }
        } else { Show-Message "LOCKqz could not lock AI for this quiz. Is the LOCKqz app installed and running?"; Start-Sleep -Seconds 30 }
      } elseif ((-not $Pending) -and (([DateTime]::UtcNow - $LastCheck).TotalSeconds -gt 10)) {
        # Helper locked while this agent is not (it resumed a lock after a restart or reboot, or an
        # earlier unlock was lost): take the lock over. If no quiz is open, the normal 30 s grace below
        # unlocks it - the student is never left blocked until the safety cap.
        $LastCheck = [DateTime]::UtcNow
        try {
          $st = Helper "/status" $null 8
          Note-Cap $st
          Tell-Student $st
          if ((($st.state -eq "locked") -or ($st.state -eq "developer")) -and $st.quiz_id -and -not $Capped.ContainsKey([string]$st.quiz_id) -and ((-not $st.student) -or (-not $Student) -or ($st.student -eq $Student))) {
            $Locked = $true; $Quiz = $st.quiz_id; $QuizTab = $null; $QuizTitle = $null; $QuizUrl = ""; $QuizProc = ""
            if (-not $script:Seen.ContainsKey([string]$Quiz)) { $script:Seen[[string]$Quiz] = @{ attempt = $false; sub = $false; rt = $true; at = [DateTime]::UtcNow } }
            $script:Seen[[string]$Quiz].adopted = $true   # this agent did not watch the whole lock: it never says "no attempt"
            $MissingSince = $null; $LastBeat = [DateTime]::UtcNow; Log "adopted helper lock $Quiz"
          }
        } catch { }
      }
    } else {
      $step = Step-Locked $wins $quizWin $QuizTab $QuizTitle $MissingSince ([DateTime]::UtcNow) $Grace
      $MissingSince = $step.MissingSince; $reason = $step.Reason
      Step-Evidence $wins ([string]$Quiz) ([bool]$step.Present) ([DateTime]::UtcNow)
      if ((-not $step.Present) -and ([DateTime]::UtcNow -lt $script:RestartWait)) { $MissingSince = $null; $reason = $null }   # its Firefox is restarting for the exam
      if ($step.Present) {
        if ($quizWin -and ((Lock-Id $quizWin.Url) -eq $Quiz)) {
          # Keep the remembered quiz page fresh (titles change between quiz pages; an adopted lock has none).
          $t = Get-ActiveTab $quizWin; if ($t) { $QuizTab = $t }
          $QuizTitle = Clean-Title $quizWin.Title; $QuizProc = [string]$quizWin.Proc
          if (-not $QuizUrl) { $QuizUrl = $quizWin.Url }
        }
        # Programs hiding their windows from screen capture (overlay AI assistants) -> closed, every 5 s.
        if (([DateTime]::UtcNow - $HiddenAt).TotalSeconds -ge 5) { $HiddenAt = [DateTime]::UtcNow; try { Close-HiddenApps (Read-KeepApps $KeepFile) | Out-Null } catch { } }
        # Opera reopened during the quiz (no policy layer, built-in VPN) -> closed again.
        if (Close-Browsers $NoPolicy $QuizProc) { if (-not $OperaWarned) { $OperaWarned = $true; Show-Message "Opera was closed: it cannot turn its AI off during a quiz. Use it again after the quiz." } }
        # A browser LOCKqz cannot police, opened during the quiz -> closed, every 5 s.
        if (([DateTime]::UtcNow - $UnpolAt).TotalSeconds -ge 5) {
          $UnpolAt = [DateTime]::UtcNow; $un = @()
          try { $un = @(Close-Unpoliced $QuizProc) } catch { }
          if ($un.Count -and -not $script:UnpolTold) {
            $script:UnpolTold = $true
            Show-Message ((Join-Names $un) + $(if ($un.Count -gt 1) { " were closed: they cannot turn their AI off during a quiz. Use them again after the quiz." } else { " was closed: it cannot turn its AI off during a quiz. Use it again after the quiz." }))
          }
        }
        # Gated quizzes change password every 5 min: until the attempt starts, re-check and hand over a new
        # one. A quiz that has not opened yet is asked on the slower C2 schedule ($PwNext).
        $pwRes = $null
        if ($quizWin -and ((Url-Path $quizWin.Url) -notmatch "/attempt/")) { try { Step-Pw ([DateTime]::UtcNow) } catch { } }
        if ($quizWin -and $QuizUrl -and ((Url-Path $quizWin.Url) -notmatch "/attempt/") -and ([DateTime]::UtcNow -ge $PwNext)) {
          $PwNext = [DateTime]::UtcNow.AddSeconds(15)
          try { $pwRes = Handle-Pw (Helper "/password" @{ url = $QuizUrl }) $false "" } catch { Log "password refresh failed: $_" }
        }
        if ($pwRes -eq "other") { Clear-Quiz; $LastCheck = [DateTime]::UtcNow; $reason = $null }
        # Self-heal: helper no longer locked while the quiz is open (restart, someone stopped it) -> lock
        # again, EXCEPT when the safety cap or the server (submitted / ended) released this quiz.
        elseif ($QuizUrl -and (([DateTime]::UtcNow - $LastCheck).TotalSeconds -gt 10)) {
          $LastCheck = [DateTime]::UtcNow
          try {
            $st = Helper "/status" $null
            $hs = $st.state
            $HelperOk = $true
            Tell-Student $st
            if ($st.capped_quiz -and ([string]$st.capped_quiz -eq [string]$Quiz)) {
              Add-Cap ([string]$Quiz) ([string]$st.capped_reason)
              Log "$(if ($st.capped_reason) { $st.capped_reason } else { 'safety cap' }) released $Quiz - not re-locking"
              Clear-Quiz; $reason = $null
            } elseif (($hs -ne "locked") -and ($hs -ne "developer")) {
              Log "helper not locked during an open quiz ($hs) - re-locking"
              $rl = Helper "/lock" @{ quiz_id = $Quiz; student = $Student; url = $QuizUrl }
              if ($rl -and $rl.not_protected) { $NoLock[[string]$Quiz] = [DateTime]::UtcNow.AddSeconds(180); Log "not protected: $Quiz - not locked"; Clear-Quiz; $reason = $null }
            }
          } catch { $HelperOk = $false; Log "helper check failed: $_" }
        }
      }
      if ($reason -and $Locked) {
        # The helper reports the unlock (signed) with this reason; quiz_left / quiz_tab_closed are also
        # reported as "quiz_left" by the helper. Not confirmed -> retried until it is.
        if (-not (Send-Unlock $Quiz $reason)) { $Pending = @{ quiz = $Quiz; reason = $reason; proc = $QuizProc }; $PendingAt = [DateTime]::UtcNow; Log "unlock not confirmed ($reason) - will retry" }
        elseif (($FirefoxFamily -notcontains $QuizProc) -and (@($wins | Where-Object { $FirefoxFamily -contains $_.Proc }).Count -gt 0)) { Show-Message "AI is unlocked. Restart Firefox to get its AI features back." }   # Firefox keeps the quiz policies until it restarts (said once AI is really back)
        Log "UNLOCKED ($reason)"; Clear-Quiz
        $LastCheck = [DateTime]::UtcNow
      } elseif ($Locked -and (-not $HelperOk) -and (([DateTime]::UtcNow - $LastBeat).TotalSeconds -gt $Beat)) {
        # only while the helper is unreachable (proof for "helper killed"); the helper's own signed pings say the rest
        $LastBeat = [DateTime]::UtcNow
        Api "/report" @{ device_id = $Device; event = "heartbeat"; quiz_id = $Quiz; student = $Student; source = "agent" } | Out-Null
      }
    }
  } catch { Log "tick error: $_" }
  Start-Sleep -Seconds $(if ($Locked) { $PollLocked } else { $Poll })
}
