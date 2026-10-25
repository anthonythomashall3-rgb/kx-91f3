# LOCKqz browser policy (Windows). No extension, no Web Store, no domain join.
# Writes HKLM policies that Chrome, Edge, Brave and Firefox honour on any PC, ONLY while a
# quiz is locked, plus Windows Copilot / Recall / Click to Do / Notepad AI off, and (per signed-in
# user, HKU) Office "connected experiences that analyze content" off = Copilot off in Word, Excel,
# PowerPoint, OneNote, Outlook (Office reads it when an app starts).
# Every blocklist host is also blocked inside the browsers (URLBlocklist / WebsiteFilter), so a
# browser-level bypass of the hosts file (--host-resolver-rules, proxy add-on, Tor) still fails.
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
# + DuckDuckGo's no-AI site (Search Assist, Duck.ai and AI images off).
$SearchAllow = @("noai.duckduckgo.com","google.com/search?udm=14","google.com/search?udm=2","google.com/search?udm=12",
                 "google.com/search?udm=7","google.com/search?udm=36","google.com/search?tbm=isch",
                 "google.com/search?tbm=nws","google.com/search?tbm=vid","google.com/search?tbm=bks")
$FfBlock = @("https://www.google.com/search*","https://www.google.com/webhp*","https://www.bing.com/*search*",
             "https://www.bing.com/chat*","https://copilot.microsoft.com/*","https://duckduckgo.com/*","https://duck.ai/*",
             "https://search.yahoo.com/*","https://search.brave.com/*","https://you.com/*","https://kagi.com/*",
             "https://yandex.com/search*","https://www.ecosia.org/search*","https://www.startpage.com/*")
$FfAllow = @("https://www.google.com/search?*udm=14*","https://www.google.com/search?*udm=2*","https://www.google.com/search?*udm=12*",
             "https://www.google.com/search?*udm=7*","https://www.google.com/search?*udm=36*","https://www.google.com/search?*tbm=isch*",
             "https://www.google.com/search?*tbm=nws*","https://www.google.com/search?*tbm=vid*","https://www.google.com/search?*tbm=bks*")
# Firefox AI prefs, set through the documented Preferences policy (one REG_MULTI_SZ JSON value).
$FfPrefs = [ordered]@{ "browser.ml.chat.enabled" = $false; "browser.ml.enable" = $false; "browser.ml.linkPreview.enabled" = $false; "browser.smartwindow.enabled" = $false }
# Extensions that stay ON during the quiz (no AI in them): Bitwarden, 1Password, LastPass, Dashlane,
# Proton Pass, iCloud Passwords, Google Docs Offline, Zotero Connector (Chrome Web Store ids) and
# Bitwarden, 1Password, LastPass, Dashlane (Edge Add-ons ids). Fixed list, never read from the user.
$SafeExtensions = @("nngceckbapebfimnlniiiahkandclblb","aeblfdkhhhdcdjpifhhbdiojplfjncoa","hdokiejnpimakedhajhdlcegeplioahd",
                    "fdjamakpfbbddfjaooikfcpapjohcfmg","ghmbeldphafepmbegfdlkpapadhbakde","pejdijmoenmkgeppbflobdenhhabjlaj",
                    "ghbmnnjooekpmoecnnnilnnbdlolhkhi","ekhagklcjbdpajgpjgmbionohlpdbjgc","jbkfoedolllekgbhcbcoahefnbanhhlh",
                    "dppgmdbiimibapkepcbdbmkaabgiofem","bbcinlkgjjkejfdpemiealijmmooekmp","gehmmocbbkpblljhkekmfhjpfbkclbph")

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
function Get-HostEntries {
  # Plain host lines of blocklist.txt (the hosts-file entries), mirrored into the browsers' own URL
  # filters. Chromium matches subdomains too. URLBlocklist / WebsiteFilter take <= 1000 entries.
  if (-not (Test-Path $BlockFile)) { return @() }
  @(Get-Content $BlockFile | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ -match '^[a-z0-9-]+(\.[a-z0-9-]+)+$' } | Select-Object -Unique)
}
function Get-ConsoleUserSids {
  # SIDs of the users signed in at this PC (owners of explorer.exe), for per-user (HKU) policies.
  $out = @()
  try {
    foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" -ErrorAction Stop)) {
      try { $o = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop; if ($o.Sid) { $out += [string]$o.Sid } } catch { }
    }
  } catch { }
  @($out | Where-Object { $_ -match '^S-1-(5-21|12-1)-[0-9-]+$' } | Select-Object -Unique)
}
function Test-DirectInternet {
  # $true when the internet answers WITHOUT a proxy (any HTTP reply counts, even an error page).
  try {
    $r = [Net.WebRequest]::Create("http://www.gstatic.com/generate_204"); $r.Proxy = $null; $r.Timeout = 6000
    $resp = $r.GetResponse(); $resp.Close(); return $true
  } catch [Net.WebException] { if ($_.Exception.Response) { return $true }; return $false } catch { return $false }
}
function Test-KeepProxy {
  # Keep the browsers' proxy setting ONLY when a signed-in user has a system proxy AND the internet
  # does not answer without it (campus / workplace proxy): forcing "direct" would stop Brightspace.
  $any = $false
  foreach ($sid in Get-ConsoleUserSids) {
    $is = "Registry::HKEY_USERS\$sid\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
    $pe = RG-Read $is "ProxyEnable"; $ac = RG-Read $is "AutoConfigURL"
    if (($pe -and ([int]$pe.value) -eq 1) -or ($ac -and [string]$ac.value)) { $any = $true }
  }
  if (-not $any) { return $false }
  return (-not (Test-DirectInternet))
}
function Get-PolicyPlan([bool]$KeepProxy = $false) {
  # Every change LOCKqz makes, as data: @{ op = "v"; path; name; value; kind } | @{ op = "list"; path; items }
  # | @{ op = "rlist"; path; items } (list REPLACED for the quiz, restored after) | @{ op = "ffprefs"; path; name; prefs }.
  $paths = Get-PathEntries
  $hosts = Get-HostEntries
  $cBlock = @($SearchBlock + $paths + $hosts | Select-Object -Unique)
  $fBlock = @($FfBlock + @($paths | ForEach-Object { "*://*." + $_ + "*" }) + @($hosts | ForEach-Object { "*://*." + $_ + "/*" }) | Select-Object -Unique)
  $plan = New-Object System.Collections.ArrayList
  function V($p, $n, $v, $k = "DWord") { [void]$plan.Add(@{ op = "v"; path = $p; name = $n; value = $v; kind = $k }) }
  function L($p, $items) { [void]$plan.Add(@{ op = "list"; path = $p; items = @($items) }) }
  function RL($p, $items) { [void]$plan.Add(@{ op = "rlist"; path = $p; items = @($items) }) }
  foreach ($root in $Chromium.Keys) {
    V $root $Mark 1
    V $root "GenAiDefaultSettings" 2
    V $root "GeminiSettings" 1
    V $root "BuiltInAIAPIsEnabled" 0
    # Every Chrome AI feature off one by one too (chromium policy_definitions/GenerativeAI), plus no
    # developer-mode (unpacked) or externally installed extensions.
    foreach ($kv in @(@("AIModeSettings",1),@("GeminiActOnWebSettings",1),@("GeminiSparkSettings",1),
        @("GeminiChromeFileUploadSettings",1),@("HelpMeWriteSettings",2),@("HistorySearchSettings",2),
        @("TabCompareSettings",2),@("TabOrganizerSettings",2),@("CreateThemesSettings",2),
        @("DevToolsGenAiSettings",2),@("AutofillGenAiSettings",2),@("AutofillPredictionSettings",2),
        @("SearchContentSharingSettings",1),@("SmartTabSharingSettings",1),@("ThirdPartyAiChatSettings",1),
        @("TryOnYouSettings",2),@("ChromeSuggestionsSettings",1),@("GenAILocalFoundationalModelSettings",1),
        @("LensOverlaySettings",1),@("LensRegionSearchEnabled",0),@("LensDesktopNTPSearchEnabled",0),
        @("GoogleSearchSidePanelEnabled",0),@("ExtensionDeveloperModeSettings",1),@("BlockExternalExtensions",1))) {
      V $root $kv[0] $kv[1]
    }
    V $root "DnsOverHttpsMode" "off" "String"
    if (-not $KeepProxy) { V $root "ProxyMode" "direct" "String" }   # a proxy would resolve AI sites remotely, past the hosts block
    V $root "DefaultSearchProviderEnabled" 1
    V $root "DefaultSearchProviderName" "Google (Web)" "String"
    V $root "DefaultSearchProviderSearchURL" "https://www.google.com/search?udm=14&q={searchTerms}" "String"
    V $root "DefaultSearchProviderSuggestURL" "https://www.google.com/complete/search?output=chrome&q={searchTerms}" "String"
    L "$root\URLBlocklist" $cBlock
    L "$root\URLAllowlist" $SearchAllow
    # Chromium only DISABLES blocklisted extensions and re-enables them when the entry is removed.
    L "$root\ExtensionInstallBlocklist" @("*")
    # Only the fixed safe list is exempt during the quiz (an existing allowlist could exempt an AI
    # extension): replaced for the quiz, put back exactly at unlock.
    RL "$root\ExtensionInstallAllowlist" $SafeExtensions
    if ($Chromium[$root] -eq "edge") {
      V $root "HubsSidebarEnabled" 0; V $root "CopilotCDPPageContext" 0
      V $root "EdgeEntraCopilotPageContext" 0; V $root "ComposeInlineEnabled" 0
      V $root "Microsoft365CopilotChatIconEnabled" 0
    }
    # Brave: Leo AI off; Tor windows and Brave VPN off (both look names up remotely, past hosts).
    if ($Chromium[$root] -eq "brave") { V $root "BraveAIChatEnabled" 0; V $root "TorDisabled" 1; V $root "BraveVPNDisabled" 1 }
  }
  V $Firefox $Mark 1
  V "$Firefox\DNSOverHTTPS" "Enabled" 0
  V "$Firefox\DNSOverHTTPS" "Locked" 1
  if (-not $KeepProxy) { V "$Firefox\Proxy" "Mode" "none" "String"; V "$Firefox\Proxy" "Locked" 1 }
  V $Firefox "IPProtectionAvailable" 0   # Firefox's built-in VPN (149+)
  L "$Firefox\WebsiteFilter\Block" $fBlock
  L "$Firefox\WebsiteFilter\Exceptions" $FfAllow
  # GenerativeAI (Firefox 144+): chatbot, link previews, smart tab groups, Smart Window off.
  # Firefox IGNORES GenerativeAI when AIControls is set, so AIControls repeats the chatbot + Smart Window.
  foreach ($n in @("Enabled","Chatbot","LinkPreviews","TabGroups","SmartWindow")) { V "$Firefox\GenerativeAI" $n 0 }
  V "$Firefox\GenerativeAI" "Locked" 1
  # AIControls (Firefox 149+): sidebar chatbot + Smart Window. Never "Default" ("blocked" deletes
  # downloaded on-device models); the on-device features are off through the prefs ($FfPrefs).
  foreach ($f in @("SidebarChatbot","SmartWindow")) {
    V "$Firefox\AIControls\$f" "Value" "blocked" "String"
    V "$Firefox\AIControls\$f" "Locked" 1
  }
  [void]$plan.Add(@{ op = "ffprefs"; path = $Firefox; name = "Preferences"; prefs = $FfPrefs })
  V "$PolicyRoot\Microsoft\Windows\WindowsCopilot" "TurnOffWindowsCopilot" 1
  V "$PolicyRoot\Microsoft\Windows\WindowsAI" "DisableAIDataAnalysis" 1
  V "$PolicyRoot\Microsoft\Windows\WindowsAI" "DisableClickToDo" 1
  # Notepad Write / Rewrite / Summarize (policy DisableAIFeaturesInNotepad, Notepad 11.2503.16+).
  V "$PolicyRoot\WindowsNotepad" "DisableAIFeatures" 1
  # Office Copilot (per user): "connected experiences that analyze content" = 2 (disabled).
  foreach ($sid in Get-ConsoleUserSids) {
    if (RG-KeyExists "Registry::HKEY_USERS\$sid\Software") {
      V "Registry::HKEY_USERS\$sid\Software\Policies\Microsoft\office\16.0\common\privacy" "usercontentdisabled" 2
    }
  }
  return ,$plan
}

function Get-Ancestors($path) {
  # "HKLM:\SOFTWARE\Policies\A\B" -> @("...\Policies\A", "...\Policies\A\B"), never above Policies.
  # A user's "Registry::HKEY_USERS\<SID>\Software\Policies\..." also lists that Policies key itself.
  $out = @()
  $m = [regex]::Match([string]$path, '^(Registry::HKEY_USERS\\S-1-[0-9-]+\\Software\\Policies)(\\.+)?$')
  if ($m.Success) { $root = $m.Groups[1].Value; $out += $root }
  elseif ($path.StartsWith($PolicyRoot + "\")) { $root = $PolicyRoot }
  else { return $out }
  if ($path.Length -le $root.Length) { return $out }
  $cur = $root
  foreach ($seg in $path.Substring($root.Length + 1).Split("\")) { $cur = "$cur\$seg"; $out += $cur }
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
    if ($op.op -eq "list" -or $op.op -eq "rlist") { [void]$lists.Add(@{ path = $op.path; values = @(Snapshot $op.path) }); continue }
    $id = $op.path + "|" + $op.name
    if ($seenV.ContainsKey($id)) { continue }
    $seenV[$id] = 1
    [void]$vals.Add(@{ path = $op.path; name = $op.name; prev = (RG-Read $op.path $op.name) })
  }
  return @{ version = 1; created_keys = @($keys); values = @($vals); lists = @($lists); keep_proxy = $false }
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
    "rlist" {
      # Only our entries during the quiz; the backup holds theirs and Restore-Backup puts them back.
      foreach ($h in @(Snapshot $op.path)) { if ($op.items -notcontains [string]$h.value) { RG-Remove $op.path $h.name } }
      $data = @(Snapshot $op.path | ForEach-Object { [string]$_.value })
      $n = 0; foreach ($h in @(Snapshot $op.path)) { $i = 0; if ([int]::TryParse([string]$h.name, [ref]$i) -and $i -gt $n) { $n = $i } }
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
function FirefoxPoliciesJson([string]$existing, [bool]$KeepProxy = $false) {
  $paths = Get-PathEntries
  $hosts = Get-HostEntries
  $prefs = @{}; foreach ($k in $FfPrefs.Keys) { $prefs[$k] = @{ Value = $FfPrefs[$k]; Status = "locked" } }
  $ours = @{
      DNSOverHTTPS = @{ Enabled = $false; Locked = $true }
      IPProtectionAvailable = $false
      WebsiteFilter = @{ Block = @(@($FfBlock + @($paths | ForEach-Object { "*://*." + $_ + "*" }) + @($hosts | ForEach-Object { "*://*." + $_ + "/*" })) | Select-Object -Unique); Exceptions = $FfAllow }
      GenerativeAI = @{ Enabled = $false; Chatbot = $false; LinkPreviews = $false; TabGroups = $false; SmartWindow = $false; Locked = $true }
      AIControls = @{ SidebarChatbot = @{ Value = "blocked"; Locked = $true }; SmartWindow = @{ Value = "blocked"; Locked = $true } }
      Preferences = $prefs
  }
  if (-not $KeepProxy) { $ours.Proxy = @{ Mode = "none"; Locked = $true } }
  $base = $null
  if ($existing) { try { $base = $existing | ConvertFrom-Json } catch { $base = $null } }
  if (-not $base) { $base = New-Object PSObject }
  if (-not $base.policies) { $base | Add-Member -NotePropertyName policies -NotePropertyValue (New-Object PSObject) -Force }
  foreach ($k in $ours.Keys) { $base.policies | Add-Member -NotePropertyName $k -NotePropertyValue $ours[$k] -Force }
  $base | Add-Member -NotePropertyName "_lockqz" -NotePropertyValue $true -Force
  return ($base | ConvertTo-Json -Depth 12)
}
function Write-Utf8NoBom($path, $text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false)) }
function Apply-FirefoxForkFiles([bool]$KeepProxy = $false) {
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
      Write-Utf8NoBom $pj (FirefoxPoliciesJson $existing $KeepProxy)
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
  # Back up FIRST, and only once per quiz: a re-run must never back up LOCKqz's own values.
  $b = Load-Backup
  if (-not $b) {
    $keep = [bool](Test-KeepProxy)   # decided once per quiz, kept in the backup
    $plan = Get-PolicyPlan $keep
    if (Test-Path $BackupFile) { Remove-Item $BackupFile -Force }   # unreadable leftover
    $nb = New-PolicyBackup $plan; $nb.keep_proxy = $keep
    if (-not (Save-Backup $nb)) { "LOCKqz browser policy: FAILED (backup could not be written; nothing changed)"; return }
  } else {
    $keep = [bool]$b.keep_proxy
    $plan = Get-PolicyPlan $keep
    # Values this quiz's backup does not cover yet (a user who signed in later, a policy added by an
    # update while a restore was pending) were never set by LOCKqz, so their current state is the
    # owner's: add it to the backup first. If that cannot be saved, those values are left alone.
    $have = @{}
    foreach ($v in @($b.values)) { $have["v|" + [string]$v.path + "|" + [string]$v.name] = 1 }
    foreach ($l in @($b.lists)) { $have["l|" + [string]$l.path] = 1 }
    $missing = @($plan | Where-Object { if ($_.op -eq "list" -or $_.op -eq "rlist") { -not $have.ContainsKey("l|" + $_.path) } else { -not $have.ContainsKey("v|" + $_.path + "|" + $_.name) } })
    if ($missing.Count -gt 0) {
      $add = New-PolicyBackup $missing
      $nb = @{ version = 1; created_keys = @(@($b.created_keys) + @($add.created_keys) | Where-Object { $_ } | Select-Object -Unique)
               values = @(@($b.values) + @($add.values)); lists = @(@($b.lists) + @($add.lists)); keep_proxy = $keep }
      if (-not (Save-Backup $nb)) { $plan = @($plan | Where-Object { $missing -notcontains $_ }) }
    }
  }
  $fails = 0
  foreach ($op in $plan) { try { Apply-Op $op } catch { $fails++ } }
  Apply-FirefoxForkFiles $keep
  $note = ""; if ($keep) { $note = " (network needs its proxy: browser proxy setting kept)" }
  if ($fails) { "LOCKqz browser policy: LOCKED ($fails values could not be set)$note" } else { "LOCKqz browser policy: LOCKED$note" }
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
