# LOCKqz browser policy (Windows). No extension, no Web Store, no domain join.
# Writes HKLM policies that Chrome, Edge, Brave and Firefox honour on any PC, ONLY while a
# quiz is locked, plus Windows Copilot / Recall / Click to Do off.
#   powershell -ExecutionPolicy Bypass -File .\browser-policy.ps1 lock|unlock|status
# NEVER DESTROYS the student's or their organisation's own policies:
#   * before the first change, every value LOCKqz will touch is saved to
#     %ProgramData%\LOCKqz\policy-backup.json (whether it existed, its type and data);
#   * list policies (URLBlocklist, ...) are MERGED: existing entries stay, ours are added;
#   * unlock puts every saved value back exactly, removes only what LOCKqz added (and keys it
#     created, if empty), then deletes the backup. With no backup, unlock changes nothing.
#   * Firefox extensions are never touched (Firefox's "blocked" mode UNINSTALLS them).
# Firefox reads policies only when it starts; the agent restarts Firefox at lock when the quiz
# is not open in it. All registry access goes through the RG-* functions (tests swap them).
param([Parameter(Mandatory=$true)][ValidateSet("lock","unlock","status")]$cmd)
$ErrorActionPreference = "SilentlyContinue"

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$BlockFile = Join-Path $Here "blocklist.txt"
$BackupFile = if ($env:LOCKQZ_POLICY_BACKUP) { $env:LOCKQZ_POLICY_BACKUP } else { "$env:ProgramData\LOCKqz\policy-backup.json" }
$PolicyRoot = "HKLM:\SOFTWARE\Policies"

# On Windows all channels of a browser (Beta/Dev/Canary) read the SAME vendor policy key, so this
# single key per vendor already covers every channel. Chromium + Vivaldi added for breadth.
$Chromium = [ordered]@{ "HKLM:\SOFTWARE\Policies\Google\Chrome" = "chrome";
               "HKLM:\SOFTWARE\Policies\Microsoft\Edge" = "edge";
               "HKLM:\SOFTWARE\Policies\BraveSoftware\Brave" = "brave";
               "HKLM:\SOFTWARE\Policies\Vivaldi" = "vivaldi";
               "HKLM:\SOFTWARE\Policies\Chromium" = "chromium" }
$Firefox  = "HKLM:\SOFTWARE\Policies\Mozilla\Firefox"
$Mark     = "LOCKqzManaged"

$SearchBlock = @("google.com/search","google.com/webhp","bing.com/search","bing.com/copilotsearch","bing.com/chat",
                 "copilot.microsoft.com","duckduckgo.com","duck.ai","search.yahoo.com","search.brave.com",
                 "you.com","kagi.com","yandex.com/search","ecosia.org/search","startpage.com")
# Google verticals with no AI answer: Web (udm=14), Images, News, Video, Books.
$SearchAllow = @("google.com/search@udm=14","google.com/search@udm=2","google.com/search@udm=12",
                 "google.com/search@udm=7","google.com/search@udm=36","google.com/search@tbm=isch",
                 "google.com/search@tbm=nws","google.com/search@tbm=vid","google.com/search@tbm=bks")
$FfBlock = @("https://www.google.com/search*","https://www.google.com/webhp*","https://www.bing.com/*search*",
             "https://www.bing.com/chat*","https://copilot.microsoft.com/*","https://duckduckgo.com/*","https://duck.ai/*",
             "https://search.yahoo.com/*","https://search.brave.com/*","https://you.com/*","https://kagi.com/*",
             "https://yandex.com/search*","https://www.ecosia.org/search*","https://www.startpage.com/*")
$FfAllow = @("https://www.google.com/search?*udm=14*","https://www.google.com/search?*udm=2*","https://www.google.com/search?*udm=12*",
             "https://www.google.com/search?*udm=7*","https://www.google.com/search?*udm=36*","https://www.google.com/search?*tbm=isch*",
             "https://www.google.com/search?*tbm=nws*","https://www.google.com/search?*tbm=vid*","https://www.google.com/search?*tbm=bks*")
# Firefox AI prefs, set through the documented Preferences policy (one REG_MULTI_SZ JSON value).
$FfPrefs = [ordered]@{ "browser.ml.chat.enabled" = $false; "browser.ml.enable" = $false; "browser.ml.linkPreview.enabled" = $false }

# ---------------- registry layer (the only code that touches the registry) ----------------
function RG-KeyExists($path) { Test-Path -LiteralPath $path }
function RG-CreateKey($path) { New-Item -Path $path -ErrorAction Stop | Out-Null }   # parent must exist
function RG-RemoveKey($path) { Remove-Item -LiteralPath $path -ErrorAction Stop }    # never recursive
function RG-ValueNames($path) { try { @((Get-Item -LiteralPath $path -ErrorAction Stop).GetValueNames()) } catch { @() } }
function RG-SubKeyCount($path) { try { [int](Get-Item -LiteralPath $path -ErrorAction Stop).SubKeyCount } catch { 0 } }
function RG-Read($path, $name) {
  # -> $null when the value does not exist, else @{ kind = "DWord"|"String"|...; value = <data> }
  try { $k = Get-Item -LiteralPath $path -ErrorAction Stop } catch { return $null }
  if (@($k.GetValueNames()) -notcontains $name) { return $null }
  return @{ kind = [string]$k.GetValueKind($name); value = $k.GetValue($name, $null, "DoNotExpandEnvironmentNames") }
}
function RG-Write($path, $name, $value, $kind) { New-ItemProperty -LiteralPath $path -Name $name -Value $value -PropertyType $kind -Force -ErrorAction Stop | Out-Null }
function RG-Remove($path, $name) { Remove-ItemProperty -LiteralPath $path -Name $name -ErrorAction Stop }
# -------------------------------------------------------------------------------------------

function Get-PathEntries {
  # host/path lines of blocklist.txt (e.g. huggingface.co/chat): hosts can't block a path, policy can.
  if (-not (Test-Path $BlockFile)) { return @() }
  @(Get-Content $BlockFile | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith("#") -and $_ -like "*/*" })
}
function Get-PolicyPlan {
  # Every change LOCKqz makes, as data: @{ op = "v"; path; name; value; kind } | @{ op = "list"; path; items }
  # | @{ op = "ffprefs"; path; name; prefs }.
  $paths = Get-PathEntries
  $cBlock = @($SearchBlock + $paths | Select-Object -Unique)
  $fBlock = @($FfBlock + @($paths | ForEach-Object { "*://*." + $_ + "*" }) | Select-Object -Unique)
  $plan = New-Object System.Collections.ArrayList
  function V($p, $n, $v, $k = "DWord") { [void]$plan.Add(@{ op = "v"; path = $p; name = $n; value = $v; kind = $k }) }
  function L($p, $items) { [void]$plan.Add(@{ op = "list"; path = $p; items = @($items) }) }
  foreach ($root in $Chromium.Keys) {
    V $root $Mark 1
    V $root "GenAiDefaultSettings" 2
    V $root "GeminiSettings" 1
    V $root "BuiltInAIAPIsEnabled" 0
    V $root "DnsOverHttpsMode" "off" "String"
    V $root "ProxyMode" "direct" "String"   # a proxy would resolve AI sites remotely, past the hosts block
    V $root "DefaultSearchProviderEnabled" 1
    V $root "DefaultSearchProviderName" "Google (Web)" "String"
    V $root "DefaultSearchProviderSearchURL" "https://www.google.com/search?udm=14&q={searchTerms}" "String"
    V $root "DefaultSearchProviderSuggestURL" "https://www.google.com/complete/search?output=chrome&q={searchTerms}" "String"
    L "$root\URLBlocklist" $cBlock
    L "$root\URLAllowlist" $SearchAllow
    # Chromium only DISABLES blocklisted extensions and re-enables them when the entry is removed.
    L "$root\ExtensionInstallBlocklist" @("*")
    if ($Chromium[$root] -eq "edge") {
      V $root "HubsSidebarEnabled" 0; V $root "CopilotCDPPageContext" 0
      V $root "EdgeEntraCopilotPageContext" 0; V $root "ComposeInlineEnabled" 0
      V $root "Microsoft365CopilotChatIconEnabled" 0; V $root "GenAILocalFoundationalModelSettings" 1
    }
    if ($Chromium[$root] -eq "brave") { V $root "BraveAIChatEnabled" 0 }
  }
  V $Firefox $Mark 1
  V "$Firefox\DNSOverHTTPS" "Enabled" 0
  V "$Firefox\DNSOverHTTPS" "Locked" 1
  V "$Firefox\Proxy" "Mode" "none" "String"
  V "$Firefox\Proxy" "Locked" 1
  L "$Firefox\WebsiteFilter\Block" $fBlock
  L "$Firefox\WebsiteFilter\Exceptions" $FfAllow
  # GenerativeAI (Firefox 144+): chatbot, link previews, smart tab groups off.
  foreach ($n in @("Enabled","Chatbot","LinkPreviews","TabGroups")) { V "$Firefox\GenerativeAI" $n 0 }
  V "$Firefox\GenerativeAI" "Locked" 1
  # AIControls (Firefox 149+): only the cloud sidebar chatbot ("blocked" also deletes downloaded
  # on-device models for the other features, so those are left alone).
  V "$Firefox\AIControls\SidebarChatbot" "Value" "blocked" "String"
  V "$Firefox\AIControls\SidebarChatbot" "Locked" 1
  [void]$plan.Add(@{ op = "ffprefs"; path = $Firefox; name = "Preferences"; prefs = $FfPrefs })
  V "$PolicyRoot\Microsoft\Windows\WindowsCopilot" "TurnOffWindowsCopilot" 1
  V "$PolicyRoot\Microsoft\Windows\WindowsAI" "DisableAIDataAnalysis" 1
  V "$PolicyRoot\Microsoft\Windows\WindowsAI" "DisableClickToDo" 1
  return ,$plan
}

function Get-Ancestors($path) {
  # "HKLM:\SOFTWARE\Policies\A\B" -> @("...\Policies\A", "...\Policies\A\B"), never above Policies.
  $out = @()
  if (-not $path.StartsWith($PolicyRoot + "\")) { return $out }
  $cur = $PolicyRoot
  foreach ($seg in $path.Substring($PolicyRoot.Length + 1).Split("\")) { $cur = "$cur\$seg"; $out += $cur }
  return $out
}
function Ensure-Key($path) { foreach ($k in Get-Ancestors $path) { if (-not (RG-KeyExists $k)) { RG-CreateKey $k } } }
function Snapshot($path) {
  @(RG-ValueNames $path | ForEach-Object { $r = RG-Read $path $_; if ($r) { @{ name = [string]$_; kind = $r.kind; value = $r.value } } })
}
function New-PolicyBackup($plan) {
  # Records the state of everything $plan touches BEFORE any change.
  $keys = New-Object System.Collections.ArrayList; $vals = New-Object System.Collections.ArrayList; $lists = New-Object System.Collections.ArrayList
  $seenK = @{}; $seenV = @{}
  foreach ($op in $plan) {
    foreach ($k in Get-Ancestors $op.path) { if (-not $seenK.ContainsKey($k)) { $seenK[$k] = 1; if (-not (RG-KeyExists $k)) { [void]$keys.Add($k) } } }
    if ($op.op -eq "list") { [void]$lists.Add(@{ path = $op.path; values = @(Snapshot $op.path) }); continue }
    $id = $op.path + "|" + $op.name
    if ($seenV.ContainsKey($id)) { continue }
    $seenV[$id] = 1
    [void]$vals.Add(@{ path = $op.path; name = $op.name; prev = (RG-Read $op.path $op.name) })
  }
  return @{ version = 1; created_keys = @($keys); values = @($vals); lists = @($lists) }
}
function Save-Backup($b) {
  try {
    $dir = Split-Path -Parent $BackupFile
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $tmp = "$BackupFile.tmp"
    [IO.File]::WriteAllText($tmp, ($b | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding $false))
    Move-Item -LiteralPath $tmp -Destination $BackupFile -Force -ErrorAction Stop
    return (Test-Path $BackupFile)
  } catch { return $false }
}
function Load-Backup {
  if (-not (Test-Path $BackupFile)) { return $null }
  try { return ([IO.File]::ReadAllText($BackupFile) | ConvertFrom-Json) } catch { return $null }
}
function As-Kind($value, [string]$kind) {
  switch ($kind) {
    "DWord"       { return [int]$value }
    "QWord"       { return [long]$value }
    "MultiString" { return [string[]]@($value) }
    "Binary"      { return [byte[]]@($value) }
    default       { return [string]$value }
  }
}
function Merge-FfPrefs($prev, $prefs) {
  # Our prefs merged into an existing Preferences JSON (the organisation's prefs stay).
  $obj = $null
  if ($prev -and $prev.value) { try { $obj = ((@($prev.value) -join "`n") | ConvertFrom-Json) } catch { $obj = $null } }
  if (-not $obj) { $obj = New-Object PSObject }
  foreach ($k in $prefs.Keys) { $obj | Add-Member -NotePropertyName $k -NotePropertyValue ([pscustomobject]@{ Value = $prefs[$k]; Status = "locked"; Type = "boolean" }) -Force }
  return ($obj | ConvertTo-Json -Depth 6 -Compress)
}
function Apply-Op($op) {
  Ensure-Key $op.path
  switch ($op.op) {
    "v"    { RG-Write $op.path $op.name $op.value $op.kind }
    "list" {
      $have = @(Snapshot $op.path)
      $data = @($have | ForEach-Object { [string]$_.value })
      $n = 0; foreach ($h in $have) { $i = 0; if ([int]::TryParse([string]$h.name, [ref]$i) -and $i -gt $n) { $n = $i } }
      foreach ($it in $op.items) { if ($data -notcontains $it) { $n++; RG-Write $op.path "$n" $it "String"; $data += $it } }
    }
    "ffprefs" { RG-Write $op.path $op.name ([string[]]@(Merge-FfPrefs (RG-Read $op.path $op.name) $op.prefs)) "MultiString" }
  }
}
function Restore-Backup($b) {
  # -> number of operations that failed (0 = everything is back as it was).
  $fails = 0
  foreach ($v in @($b.values)) {
    try {
      if ($null -ne $v.prev) { Ensure-Key $v.path; RG-Write $v.path $v.name (As-Kind $v.prev.value $v.prev.kind) $v.prev.kind }
      elseif ($null -ne (RG-Read $v.path $v.name)) { RG-Remove $v.path $v.name }
    } catch { $fails++ }
  }
  foreach ($l in @($b.lists)) {
    try {
      $keep = @{}; foreach ($x in @($l.values)) { if ($x) { $keep[[string]$x.name] = $x } }
      if (-not (RG-KeyExists $l.path)) { if ($keep.Count -eq 0) { continue }; Ensure-Key $l.path }
      foreach ($n in @(RG-ValueNames $l.path)) { if (-not $keep.ContainsKey([string]$n)) { RG-Remove $l.path $n } }
      foreach ($x in $keep.Values) { RG-Write $l.path $x.name (As-Kind $x.value $x.kind) $x.kind }
    } catch { $fails++ }
  }
  # Keys LOCKqz created: deepest first, only when nothing else lives in them.
  foreach ($k in @(@($b.created_keys) | Sort-Object { $_.Length } -Descending)) {
    try { if ((RG-KeyExists $k) -and (@(RG-ValueNames $k).Count -eq 0) -and ((RG-SubKeyCount $k) -eq 0)) { RG-RemoveKey $k } } catch { $fails++ }
  }
  return $fails
}
function Legacy-Cleanup {
  # LOCKqz 0.3.8 and older kept no backup: remove only what it is known to have set (marker present).
  $plan = Get-PolicyPlan
  $roots = @($Chromium.Keys) + @($Firefox)
  foreach ($root in $roots) {
    if ($null -eq (RG-Read $root $Mark)) { continue }
    foreach ($op in @($plan | Where-Object { $_.path -eq $root -or $_.path.StartsWith($root + "\") })) {
      if ($op.op -eq "v") { if (RG-Read $op.path $op.name) { RG-Remove $op.path $op.name } }
      elseif ($op.op -eq "list") {
        foreach ($n in @(RG-ValueNames $op.path)) { $r = RG-Read $op.path $n; if ($r -and ($op.items -contains [string]$r.value)) { RG-Remove $op.path $n } }
        if ((RG-KeyExists $op.path) -and (@(RG-ValueNames $op.path).Count -eq 0) -and ((RG-SubKeyCount $op.path) -eq 0)) { RG-RemoveKey $op.path }
      }
    }
    foreach ($n in @("browser.ml.chat.enabled","browser.ml.enable")) { if (RG-Read "$Firefox\Preferences" $n) { RG-Remove "$Firefox\Preferences" $n } }
  }
  $wc = "$PolicyRoot\Microsoft\Windows\WindowsCopilot"
  if (RG-Read $wc $Mark) { foreach ($n in @("TurnOffWindowsCopilot", $Mark)) { if (RG-Read $wc $n) { RG-Remove $wc $n } } }
}

# ---- Firefox family (Firefox + forks: LibreWolf, Waterfox, Floorp, Zen, Mullvad, dev/nightly) ----
# Forks read a distribution\policies.json in their own install dir. We find each install, back up
# any existing policies.json, write ours MERGED into it (marked), and Do-Unlock restores the original.
function Get-FirefoxFamilyDirs {
  $dirs = New-Object System.Collections.Generic.HashSet[string]
  $bases = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ }
  $names = @("Mozilla Firefox","Firefox Developer Edition","Firefox Nightly","LibreWolf","Waterfox",
             "Floorp","zen","Zen Browser","Mullvad Browser","Mozilla Firefox ESR")
  foreach ($b in $bases) {
    foreach ($n in $names) {
      $d = Join-Path $b $n
      if (Test-Path (Join-Path $d "firefox.exe")) { [void]$dirs.Add($d); continue }
      # some forks rebrand the launcher
      foreach ($exe in @("librewolf.exe","waterfox.exe","floorp.exe","zen.exe","mullvadbrowser.exe")) {
        if (Test-Path (Join-Path $d $exe)) { [void]$dirs.Add($d) }
      }
    }
  }
  return $dirs
}
function FirefoxPoliciesJson([string]$existing) {
  $paths = Get-PathEntries
  $prefs = @{}; foreach ($k in $FfPrefs.Keys) { $prefs[$k] = @{ Value = $FfPrefs[$k]; Status = "locked" } }
  $ours = @{
      DNSOverHTTPS = @{ Enabled = $false; Locked = $true }
      Proxy = @{ Mode = "none"; Locked = $true }
      WebsiteFilter = @{ Block = @($FfBlock + @($paths | ForEach-Object { "*://*." + $_ + "*" })); Exceptions = $FfAllow }
      GenerativeAI = @{ Enabled = $false; Chatbot = $false; LinkPreviews = $false; TabGroups = $false; Locked = $true }
      AIControls = @{ SidebarChatbot = @{ Value = "blocked"; Locked = $true } }
      Preferences = $prefs
  }
  $base = $null
  if ($existing) { try { $base = $existing | ConvertFrom-Json } catch { $base = $null } }
  if (-not $base) { $base = New-Object PSObject }
  if (-not $base.policies) { $base | Add-Member -NotePropertyName policies -NotePropertyValue (New-Object PSObject) -Force }
  foreach ($k in $ours.Keys) { $base.policies | Add-Member -NotePropertyName $k -NotePropertyValue $ours[$k] -Force }
  $base | Add-Member -NotePropertyName "_lockqz" -NotePropertyValue $true -Force
  return ($base | ConvertTo-Json -Depth 12)
}
function Write-Utf8NoBom($path, $text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false)) }
function Apply-FirefoxForkFiles {
  foreach ($d in Get-FirefoxFamilyDirs) {
    try {
      $dist = Join-Path $d "distribution"
      $pj = Join-Path $dist "policies.json"
      New-Item -ItemType Directory -Force -Path $dist | Out-Null
      $existing = $null
      if (Test-Path $pj) {
        $existing = Get-Content $pj -Raw -ErrorAction SilentlyContinue
        if ($existing -match '"_lockqz"') { continue }   # already ours (lock re-run)
        Copy-Item $pj "$pj.lockqzbak" -Force -ErrorAction Stop
      }
      Write-Utf8NoBom $pj (FirefoxPoliciesJson $existing)
    } catch { }
  }
}
function Remove-FirefoxForkFiles {
  foreach ($d in Get-FirefoxFamilyDirs) {
    try {
      $pj = Join-Path (Join-Path $d "distribution") "policies.json"
      if (Test-Path $pj) {
        $c = Get-Content $pj -Raw -ErrorAction SilentlyContinue
        if ($c -match '"_lockqz"') {
          if (Test-Path "$pj.lockqzbak") { Move-Item "$pj.lockqzbak" $pj -Force } else { Remove-Item $pj -Force }
        }
      }
    } catch { }
  }
}

function Do-Lock {
  $plan = Get-PolicyPlan
  # Back up FIRST, and only once per quiz: a re-run must never back up LOCKqz's own values.
  if (-not (Load-Backup)) {
    if (Test-Path $BackupFile) { Remove-Item $BackupFile -Force }   # unreadable leftover
    if (-not (Save-Backup (New-PolicyBackup $plan))) { "LOCKqz browser policy: FAILED (backup could not be written; nothing changed)"; return }
  }
  $fails = 0
  foreach ($op in $plan) { try { Apply-Op $op } catch { $fails++ } }
  Apply-FirefoxForkFiles
  if ($fails) { "LOCKqz browser policy: LOCKED ($fails values could not be set)" } else { "LOCKqz browser policy: LOCKED" }
}

function Do-Unlock {
  $b = Load-Backup
  if ($b) {
    $fails = Restore-Backup $b
    if ($fails -gt 0) { Remove-FirefoxForkFiles; "LOCKqz browser policy: restore incomplete ($fails) - will retry"; return }
    Remove-Item $BackupFile -Force
  } else { Legacy-Cleanup }
  Remove-FirefoxForkFiles
  "LOCKqz browser policy: off"
}

switch ($cmd) {
  "lock"   { Do-Lock }
  "unlock" { Do-Unlock }
  "status" { if ($null -ne (RG-Read "HKLM:\SOFTWARE\Policies\Google\Chrome" $Mark)) { "LOCKqz browser policy: LOCKED" } else { "LOCKqz browser policy: off" } }
}
