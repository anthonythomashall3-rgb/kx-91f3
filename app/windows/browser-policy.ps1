# LOCKqz browser policy (Windows). No extension, no Web Store, no domain join.
# Writes HKLM policies that Chrome, Edge, Brave and Firefox honour on any PC, ONLY while a
# quiz is locked; removed at unlock so the student's browser AI comes back.
#   powershell -ExecutionPolicy Bypass -File .\browser-policy.ps1 lock|unlock|status
param([Parameter(Mandatory=$true)][ValidateSet("lock","unlock","status")]$cmd)
$ErrorActionPreference = "SilentlyContinue"

# On Windows all channels of a browser (Beta/Dev/Canary) read the SAME vendor policy key, so this
# single key per vendor already covers every channel. Chromium + Opera added for breadth.
$Chromium = @{ "HKLM:\SOFTWARE\Policies\Google\Chrome" = "chrome";
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

function Set-Val($path,$name,$val,$type="DWord") {
  New-Item -Path $path -Force | Out-Null
  New-ItemProperty -Path $path -Name $name -Value $val -PropertyType $type -Force | Out-Null
}
function Set-List($path,$items) {
  Remove-Item -Path $path -Recurse -Force; New-Item -Path $path -Force | Out-Null
  $i = 1; foreach ($it in $items) { New-ItemProperty -Path $path -Name "$i" -Value $it -PropertyType String -Force | Out-Null; $i++ }
}

# ---- Firefox family (Firefox + forks: LibreWolf, Waterfox, Floorp, Zen, Mullvad, dev/nightly) ----
# Forks read a distribution\policies.json in their own install dir (safe to add; unlike a macOS app
# bundle, adding a file here does not break anything). We find each install, back up any existing
# policies.json, and drop ours (marked) for the quiz; Do-Unlock restores exactly what was there.
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
function FirefoxPoliciesJson {
  $pol = @{ policies = @{
      DNSOverHTTPS = @{ Enabled = $false; Locked = $true }
      Proxy = @{ Mode = "none"; Locked = $true }
      WebsiteFilter = @{ Block = $FfBlock; Exceptions = $FfAllow }
      ExtensionSettings = @{ "*" = @{ installation_mode = "blocked" } }
      Preferences = @{
        "browser.ml.chat.enabled" = @{ Value = $false; Status = "locked" }
        "browser.ml.enable" = @{ Value = $false; Status = "locked" }
        "browser.ml.linkPreview.enabled" = @{ Value = $false; Status = "locked" }
      }
    }; "_lockqz" = $true }
  return ($pol | ConvertTo-Json -Depth 8)
}
function Apply-FirefoxForkFiles {
  foreach ($d in Get-FirefoxFamilyDirs) {
    try {
      $dist = Join-Path $d "distribution"
      $pj = Join-Path $dist "policies.json"
      New-Item -ItemType Directory -Force -Path $dist | Out-Null
      if (Test-Path $pj) {
        $existing = Get-Content $pj -Raw -ErrorAction SilentlyContinue
        if ($existing -and ($existing -notmatch '"_lockqz"')) { Copy-Item $pj "$pj.lockqzbak" -Force }
      }
      Set-Content -Path $pj -Value (FirefoxPoliciesJson) -Encoding UTF8
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
          Remove-Item $pj -Force
          if (Test-Path "$pj.lockqzbak") { Move-Item "$pj.lockqzbak" $pj -Force }
        }
      }
    } catch { }
  }
}

function Do-Lock {
  foreach ($root in $Chromium.Keys) {
    Set-Val $root $Mark 1
    Set-Val $root "GenAiDefaultSettings" 2
    Set-Val $root "GeminiSettings" 1
    Set-Val $root "BuiltInAIAPIsEnabled" 0
    Set-Val $root "DnsOverHttpsMode" "off" "String"
    Set-Val $root "ProxyMode" "direct" "String"   # a proxy would resolve AI sites remotely, past the hosts block
    Set-Val $root "DefaultSearchProviderEnabled" 1
    Set-Val $root "DefaultSearchProviderName" "Google (Web)" "String"
    Set-Val $root "DefaultSearchProviderSearchURL" "https://www.google.com/search?udm=14&q={searchTerms}" "String"
    Set-Val $root "DefaultSearchProviderSuggestURL" "https://www.google.com/complete/search?output=chrome&q={searchTerms}" "String"
    Set-List "$root\URLBlocklist" $SearchBlock
    Set-List "$root\URLAllowlist" $SearchAllow
    Set-List "$root\ExtensionInstallBlocklist" @("*")
    if ($Chromium[$root] -eq "edge") {
      Set-Val $root "HubsSidebarEnabled" 0; Set-Val $root "CopilotCDPPageContext" 0
      Set-Val $root "EdgeEntraCopilotPageContext" 0; Set-Val $root "ComposeInlineEnabled" 0
      Set-Val $root "Microsoft365CopilotChatIconEnabled" 0; Set-Val $root "GenAILocalFoundationalModelSettings" 1
    }
    if ($Chromium[$root] -eq "brave") { Set-Val $root "BraveAIChatEnabled" 0 }
  }
  Set-Val $Firefox $Mark 1
  Set-Val "$Firefox\DNSOverHTTPS" "Enabled" 0
  Set-Val "$Firefox\DNSOverHTTPS" "Locked" 1
  Set-Val "$Firefox\Proxy" "Mode" "none" "String"
  Set-Val "$Firefox\Proxy" "Locked" 1
  Set-List "$Firefox\WebsiteFilter\Block" $FfBlock
  Set-List "$Firefox\WebsiteFilter\Exceptions" $FfAllow
  Set-Val "$Firefox\Preferences" "browser.ml.chat.enabled" "false" "String"
  Set-Val "$Firefox\Preferences" "browser.ml.enable" "false" "String"
  Set-Val "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsCopilot" "TurnOffWindowsCopilot" 1
  Set-Val "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsCopilot" $Mark 1
  Apply-FirefoxForkFiles
  "LOCKqz browser policy: LOCKED"
}

function Do-Unlock {
  foreach ($root in $Chromium.Keys) {
    if ((Get-ItemProperty -Path $root).$Mark -eq 1) {
      foreach ($n in @($Mark,"GenAiDefaultSettings","GeminiSettings","BuiltInAIAPIsEnabled","DnsOverHttpsMode","ProxyMode",
                       "DefaultSearchProviderEnabled","DefaultSearchProviderName","DefaultSearchProviderSearchURL",
                       "DefaultSearchProviderSuggestURL","HubsSidebarEnabled","CopilotCDPPageContext",
                       "EdgeEntraCopilotPageContext","ComposeInlineEnabled","Microsoft365CopilotChatIconEnabled",
                       "GenAILocalFoundationalModelSettings","BraveAIChatEnabled")) { Remove-ItemProperty -Path $root -Name $n }
      foreach ($k in @("URLBlocklist","URLAllowlist","ExtensionInstallBlocklist")) { Remove-Item -Path "$root\$k" -Recurse -Force }
    }
  }
  if ((Get-ItemProperty -Path $Firefox).$Mark -eq 1) {
    Remove-Item -Path "$Firefox\DNSOverHTTPS","$Firefox\Proxy","$Firefox\WebsiteFilter","$Firefox\Preferences" -Recurse -Force
    Remove-ItemProperty -Path $Firefox -Name $Mark
  }
  $wc = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsCopilot"
  if ((Get-ItemProperty -Path $wc).$Mark -eq 1) { Remove-ItemProperty -Path $wc -Name "TurnOffWindowsCopilot",$Mark }
  Remove-FirefoxForkFiles
  "LOCKqz browser policy: off"
}

switch ($cmd) {
  "lock"   { Do-Lock }
  "unlock" { Do-Unlock }
  "status" { if ((Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Google\Chrome").$Mark -eq 1) { "LOCKqz browser policy: LOCKED" } else { "LOCKqz browser policy: off" } }
}
