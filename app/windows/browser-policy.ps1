# LOCKqz browser policy (Windows). No extension, no Web Store, no domain join.
# Writes HKLM policies that Chrome, Edge, Brave and Firefox honour on any PC, ONLY while a
# quiz is locked; removed at unlock so the student's browser AI comes back.
#   powershell -ExecutionPolicy Bypass -File .\browser-policy.ps1 lock|unlock|status
param([Parameter(Mandatory=$true)][ValidateSet("lock","unlock","status")]$cmd)
$ErrorActionPreference = "SilentlyContinue"

$Chromium = @{ "HKLM:\SOFTWARE\Policies\Google\Chrome" = "chrome";
               "HKLM:\SOFTWARE\Policies\Microsoft\Edge" = "edge";
               "HKLM:\SOFTWARE\Policies\BraveSoftware\Brave" = "brave";
               "HKLM:\SOFTWARE\Policies\Vivaldi" = "vivaldi" }
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

function Do-Lock {
  foreach ($root in $Chromium.Keys) {
    Set-Val $root $Mark 1
    Set-Val $root "GenAiDefaultSettings" 2
    Set-Val $root "GeminiSettings" 1
    Set-Val $root "BuiltInAIAPIsEnabled" 0
    Set-Val $root "DnsOverHttpsMode" "off" "String"
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
  Set-List "$Firefox\WebsiteFilter\Block" $FfBlock
  Set-List "$Firefox\WebsiteFilter\Exceptions" $FfAllow
  Set-Val "$Firefox\Preferences" "browser.ml.chat.enabled" "false" "String"
  Set-Val "$Firefox\Preferences" "browser.ml.enable" "false" "String"
  Set-Val "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsCopilot" "TurnOffWindowsCopilot" 1
  Set-Val "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsCopilot" $Mark 1
  "LOCKqz browser policy: LOCKED"
}

function Do-Unlock {
  foreach ($root in $Chromium.Keys) {
    if ((Get-ItemProperty -Path $root).$Mark -eq 1) {
      foreach ($n in @($Mark,"GenAiDefaultSettings","GeminiSettings","BuiltInAIAPIsEnabled","DnsOverHttpsMode",
                       "DefaultSearchProviderEnabled","DefaultSearchProviderName","DefaultSearchProviderSearchURL",
                       "DefaultSearchProviderSuggestURL","HubsSidebarEnabled","CopilotCDPPageContext",
                       "EdgeEntraCopilotPageContext","ComposeInlineEnabled","Microsoft365CopilotChatIconEnabled",
                       "GenAILocalFoundationalModelSettings","BraveAIChatEnabled")) { Remove-ItemProperty -Path $root -Name $n }
      foreach ($k in @("URLBlocklist","URLAllowlist","ExtensionInstallBlocklist")) { Remove-Item -Path "$root\$k" -Recurse -Force }
    }
  }
  if ((Get-ItemProperty -Path $Firefox).$Mark -eq 1) {
    Remove-Item -Path "$Firefox\DNSOverHTTPS","$Firefox\WebsiteFilter","$Firefox\Preferences" -Recurse -Force
    Remove-ItemProperty -Path $Firefox -Name $Mark
  }
  $wc = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsCopilot"
  if ((Get-ItemProperty -Path $wc).$Mark -eq 1) { Remove-ItemProperty -Path $wc -Name "TurnOffWindowsCopilot",$Mark }
  "LOCKqz browser policy: off"
}

switch ($cmd) {
  "lock"   { Do-Lock }
  "unlock" { Do-Unlock }
  "status" { if ((Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Google\Chrome").$Mark -eq 1) { "LOCKqz browser policy: LOCKED" } else { "LOCKqz browser policy: off" } }
}
