# Build the LOCKqz Microsoft Store package (MSIX). Runs on any Windows machine with the Windows SDK
# (GitHub's windows-latest has it). The Store re-signs the package for free after certification, so
# the Store build is unsigned. -TestSign signs with a throwaway certificate for local install tests.
#   powershell -File build-msix.ps1 -Name <Package/Identity/Name> -Publisher "CN=<GUID>" -PublisherDisplay "<name>" -Out lockqz.msix
param(
  [string]$Name = "LOCKqz.Test",
  [string]$Publisher = "CN=LOCKqz Test",
  [string]$PublisherDisplay = "LOCKqz",
  [string]$Out = "$PSScriptRoot\Output\lockqz.msix",
  [string]$VersionOverride = "",
  [switch]$TestSign
)
$ErrorActionPreference = "Stop"
$Win = Split-Path -Parent $PSScriptRoot
$App = Split-Path -Parent $Win
$ver = if ($VersionOverride) { $VersionOverride } else { (Get-Content (Join-Path $App "VERSION") -Raw).Trim() }
$stage = Join-Path $env:TEMP ("lockqz-msix-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path "$stage\payload", "$stage\Assets", (Split-Path -Parent $Out) | Out-Null

# 1. Launcher exe (.NET Framework compiler that ships with Windows).
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
& $csc /nologo /target:winexe /optimize+ "/out:$stage\LOCKqz.exe" "/win32icon:$PSScriptRoot\lockqz.ico" `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll "$PSScriptRoot\LOCKqz.cs"
if ($LASTEXITCODE -ne 0) { throw "csc failed" }

# 2. Payload = the same helper every other install uses.
foreach ($f in "lockqz.ps1","lockqzd.ps1","blocklist.txt","browser-policy.ps1","lockqz-agent.ps1","install.ps1","uninstall.ps1","update.pub.xml") {
  Copy-Item (Join-Path $Win $f) "$stage\payload\" -Force
}
Set-Content "$stage\payload\VERSION" $ver -Encoding ASCII
Set-Content "$stage\payload\store_package.txt" $Name -Encoding ASCII
Copy-Item "$PSScriptRoot\Assets\Square44x44Logo.png","$PSScriptRoot\Assets\Square150x150Logo.png","$PSScriptRoot\Assets\StoreLogo.png" "$stage\Assets\"

# 3. Manifest. Store versions need four parts with the last one 0.
$m = (Get-Content "$PSScriptRoot\AppxManifest.xml.in" -Raw).Replace("@NAME@", $Name).Replace("@PUBLISHER@", [Security.SecurityElement]::Escape($Publisher)).Replace("@PUBDISPLAY@", [Security.SecurityElement]::Escape($PublisherDisplay)).Replace("@VERSION@", "$ver.0")
Set-Content "$stage\AppxManifest.xml" $m -Encoding UTF8

# 4. Pack.
$kits = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" | Sort-Object FullName | Select-Object -Last 1
if (-not $kits) { throw "Windows SDK (makeappx.exe) not found" }
if (Test-Path $Out) { Remove-Item $Out -Force }
& $kits.FullName pack /o /d $stage /p $Out | Out-Null
if ($LASTEXITCODE -ne 0) { throw "makeappx failed" }

if ($TestSign) {
  $cert = New-SelfSignedCertificate -Type Custom -Subject $Publisher -KeyUsage DigitalSignature -FriendlyName "LOCKqz test" `
    -CertStoreLocation "Cert:\CurrentUser\My" -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")
  $pw = ConvertTo-SecureString -String "lockqz-test" -Force -AsPlainText
  $pfx = Join-Path $env:TEMP "lockqz-test.pfx"
  Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $pw | Out-Null
  Export-Certificate -Cert $cert -FilePath "$pfx.cer" | Out-Null
  Import-Certificate -FilePath "$pfx.cer" -CertStoreLocation "Cert:\LocalMachine\TrustedPeople" | Out-Null
  $signtool = Join-Path (Split-Path -Parent $kits.FullName) "signtool.exe"
  & $signtool sign /q /fd SHA256 /f $pfx /p "lockqz-test" $Out
  if ($LASTEXITCODE -ne 0) { throw "signtool failed" }
}
Copy-Item "$stage\LOCKqz.exe" (Join-Path (Split-Path -Parent $Out) "LOCKqz.exe") -Force
Remove-Item $stage -Recurse -Force
Write-Host "built $Out ($Name $ver.0)"
