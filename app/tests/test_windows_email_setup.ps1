# Windows one-time email setup: parses every Windows script, then runs the REAL Setup-Identity
# from lockqz-agent.ps1 with scripted dialogs + a fake server. Needs pwsh (any OS). Exit 1 on failure.
$ErrorActionPreference = "Stop"
$Win = Join-Path $PSScriptRoot "..\windows"
$pass = 0; $fail = 0
function Check($m, $c) { if ($c) { $script:pass++; Write-Host "  ok: $m" } else { $script:fail++; Write-Host "  FAIL: $m" } }

Write-Host "W1 every Windows script parses"
foreach ($f in Get-ChildItem $Win -Filter *.ps1) {
  $tok = $null; $err = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tok, [ref]$err)
  Check "$($f.Name) parses" ($err.Count -eq 0)
  if ($err.Count) { $err | ForEach-Object { Write-Host "     $($_.Extent.StartLineNumber): $($_.Message)" } }
}

Write-Host "W2 Setup-Identity (real code) with scripted dialogs"
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Win "lockqz-agent.ps1"), [ref]$null, [ref]$null)
$fns = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and @("Verify","Err-Text","Setup-Identity","Say") -contains $n.Name }, $true)
foreach ($fn in $fns) { . ([scriptblock]::Create($fn.Extent.Text)) }
$EmailRe = ($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$EmailRe' }, $true) | Select-Object -First 1).Right.Extent.Text.Trim("'")
$Ask = "Enter your school email"
function Log($m) {}
$script:Answers = @(); $script:Shown = @(); $script:Calls = @()
function Ask-Box($msg, $buttons, $default, [bool]$answer) {
  $script:Shown += $msg
  if ($script:Answers.Count -eq 0) { return $null }
  $a = $script:Answers[0]; $script:Answers = @($script:Answers | Select-Object -Skip 1)
  return @{ b = $a[0]; t = $a[1] }
}
$script:Srv = @{}
function Helper($path, $body) {
  $script:Calls += $body.op
  switch ($body.op) {
    "status" { return [pscustomobject]@{ status = 200; student = $script:Srv.verified; verified = [bool]$script:Srv.verified; codes = -not $script:Srv.off } }
    "check"  { return [pscustomobject]@{ status = 200; name = $(if ($body.email -eq "al@usc.edu") { "Al Student" } else { $null }) } }
    "send"   { if ($script:Srv.off) { return [pscustomobject]@{ status = 200; bound = $true } } else { return [pscustomobject]@{ status = 200; sent = $true } } }
    "code"   {
      if ($script:Srv.expire) { $script:Srv.expire = $false; return [pscustomobject]@{ status = 200; error = "expired"; resent = $true } }
      if ($body.code -eq "246810") { return [pscustomobject]@{ status = 200; verified = $true } }
      return [pscustomobject]@{ status = 200; error = "wrong_code"; tries_left = 4 }
    }
  }
}
function Run($answers, $srv) { $script:Answers = $answers; $script:Shown = @(); $script:Calls = @(); $script:Srv = $srv; Setup-Identity "" }

$r = Run @() @{ verified = "al@usc.edu" }
Check "already confirmed on the server: no dialog" (($r.student -eq "al@usc.edu") -and $r.verified -and $script:Shown.Count -eq 0)
$r = Run (@(@("OK","AL@usc.edu"), @("Yes",""), @("OK","000000"), @("OK","246810"))) @{}
Check "Is this you -> wrong code -> right code -> confirmed" (($r.student -eq "al@usc.edu") -and $r.verified -and ($script:Shown -match "Al Student") -and ($script:Shown -match "wrong"))
$r = Run (@(@("OK","al@usc.eud"), @("Retype",""), @("OK","al@usc.edu"), @("Yes",""), @("OK","246810"))) @{}
Check "typo -> not on a class list -> Retype -> confirmed" (($r.student -eq "al@usc.edu") -and ($script:Shown -match "not on a LOCKqz class list"))
$r = Run (@(@("OK","bo@usc.edu"), @("Use it",""), @("Change email",""), @("OK","al@usc.edu"), @("Yes",""), @("OK","246810"))) @{}
Check "code never arrives -> Change email -> confirmed" (($r.student -eq "al@usc.edu") -and $r.verified)
$r = Run (@(@("OK","al@usc.edu"), @("Yes",""), @("OK","246810"), @("OK","246810"))) @{ expire = $true }
Check "expired code auto-resent, email not retyped" ($r.verified -and ($script:Shown -match "expired") -and (@($script:Calls | Where-Object { $_ -eq "check" }).Count -eq 1))
$r = Run (@(@("OK","al@usc.edu"), @("Yes",""), @("Send new code",""), @("OK","246810"))) @{}
Check "Send new code resends" ($r.verified -and (@($script:Calls | Where-Object { $_ -eq "send" }).Count -eq 2))
$r = Run (@(@("OK","nope"), @("OK","al@usc.edu"), @("Yes",""), @("OK","246810"))) @{}
Check "non-email re-asked" ($r.verified -and ($script:Shown[1] -match "not an email"))
$r = Run (@(@("OK","al@usc.edu"), @("Yes",""))) @{ off = $true }
Check "server codes off: roster check only, unconfirmed" (($r.student -eq "al@usc.edu") -and -not $r.verified)
$r = Run (,@("OK","al@usc.edu")) @{}
Check "dialog closed mid-way: nothing saved" ($null -eq $r)
function Helper($path, $body) { throw "offline" }
$r = Run @() @{}
Check "offline: nothing saved, no dialog" (($null -eq $r) -and $script:Shown.Count -eq 0)

Write-Host ""; Write-Host "RESULT: $pass passed, $fail failed"
if ($fail) { exit 1 }
