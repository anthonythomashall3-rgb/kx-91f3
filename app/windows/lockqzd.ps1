# LOCKqz Windows daemon (watcher + loopback control server).  Run elevated.
# Mirrors the macOS daemon: the per-user agent calls 127.0.0.1:8787 to lock/unlock;
# a watcher re-applies the block during a quiz and reports tampering.
$ErrorActionPreference = "SilentlyContinue"
$Here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$Engine = Join-Path $Here "lockqz.ps1"
$ConfPath = "$env:ProgramData\LOCKqz\config.json"
$Conf = if (Test-Path $ConfPath) { Get-Content $ConfPath -Raw | ConvertFrom-Json } else { @{} }
$Port   = if ($Conf.port) { [int]$Conf.port } else { 8787 }
$Token  = if ($Conf.token) { $Conf.token } else { "lockqz-dev" }
$Api    = if ($Conf.api_base) { $Conf.api_base.TrimEnd("/") } else { "" }
if ($Api -and -not $Api.EndsWith("/api")) { $Api += "/api" }   # accept a bare site URL too
$Device = if ($Conf.device_id) { $Conf.device_id } else { "unknown" }
$MaxMin = if ($Conf.max_minutes) { [int]$Conf.max_minutes } else { 180 }
$State  = [hashtable]::Synchronized(@{ state="unlocked"; quiz_id=$null; student=$Conf.student; locked_since=0; max_minutes=$MaxMin })

function Engine([string]$c) { & powershell -ExecutionPolicy Bypass -File $Engine $c | Out-Null }
function EngineLocked { (& powershell -ExecutionPolicy Bypass -File $Engine status) -match "LOCKED" }
function Report($event, $detail) {
  if (-not $Api) { return }
  $body = @{ device_id=$Device; event=$event; quiz_id=$State.quiz_id; student=$State.student;
             ts=(Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"); detail=$detail } | ConvertTo-Json
  try { Invoke-RestMethod -Uri "$Api/report" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 8 } catch {}
}

# Watcher runspace: re-apply the block while locked; flag tamper.
$watcher = [powershell]::Create()
$watcher.AddScript({
  param($State,$Engine,$Api,$Device)
  function ELocked { (& powershell -ExecutionPolicy Bypass -File $Engine status) -match "LOCKED" }
  function WReport($event,$detail,$source) {
    if (-not $Api) { return }
    $b = @{ device_id=$Device; event=$event; quiz_id=$State.quiz_id; student=$State.student;
            ts=(Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
    if ($detail) { $b.detail = $detail }
    if ($source) { $b.source = $source }
    try { Invoke-RestMethod -Uri "$Api/report" -Method Post -Body ($b|ConvertTo-Json) -ContentType "application/json" -TimeoutSec 8 } catch {}
  }
  $cycles = 0
  while ($true) {
    Start-Sleep -Seconds 5; $cycles++
    if ($State.state -eq "locked") {
      $now = [int][double]::Parse((Get-Date -UFormat %s))
      if ($State.locked_since -gt 0 -and ($now - $State.locked_since) -gt ($State.max_minutes * 60)) {
        # hard-max safety: never leave a student locked
        WReport "auto_unlock" "max_minutes" $null
        $State.state = "unlocked"; $State.quiz_id = $null; $State.locked_since = 0
        & powershell -ExecutionPolicy Bypass -File $Engine unlock | Out-Null
      } else {
        if (-not (ELocked)) { WReport "tamper" "hosts_block_removed" $null }
        & powershell -ExecutionPolicy Bypass -File $Engine lock | Out-Null
        # liveness ping every ~45s so a killed helper shows up on the live monitor
        if ($cycles % 9 -eq 0) { WReport "heartbeat" $null "helper" }
      }
    }
  }
}).AddArgument($State).AddArgument($Engine).AddArgument($Api).AddArgument($Device) | Out-Null
$watcher.BeginInvoke() | Out-Null

# Fail safe on start: never leave a machine locked across a restart.
Engine "unlock"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Host "LOCKqzd: listening on 127.0.0.1:$Port"

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request; $res = $ctx.Response
  $res.Headers.Add("Access-Control-Allow-Origin","*")
  $res.Headers.Add("Access-Control-Allow-Headers","Content-Type, X-LOCKqz-Token")
  if ($req.HttpMethod -eq "OPTIONS") { $res.StatusCode = 204; $res.Close(); continue }
  if ($req.Headers["X-LOCKqz-Token"] -ne $Token) { $res.StatusCode = 401; $res.Close(); continue }
  $path = $req.Url.AbsolutePath
  $body = @{}
  if ($req.HasEntityBody) { $body = (New-Object IO.StreamReader($req.InputStream)).ReadToEnd() | ConvertFrom-Json }
  $out = @{ ok = $true }
  switch ($path) {
    "/lock"      { $State.state="locked"; $State.quiz_id=$body.quiz_id; if($body.student){$State.student=$body.student}; if($body.max_minutes){$State.max_minutes=[int]$body.max_minutes}; $State.locked_since=[int][double]::Parse((Get-Date -UFormat %s)); Engine "lock"; Report "lock" $null; $out.state="locked" }
    "/unlock"    { $State.state="unlocked"; $State.quiz_id=$null; Engine "unlock"; Report "unlock" $null; $out.state="unlocked" }
    "/student"   { if($body.student){$State.student=$body.student}; Report "install" @{ platform="windows"; version="0.2.0" }; $out.student=$State.student }
    "/heartbeat" { Report "heartbeat" $body }
    "/status"    { $out = @{ state=$State.state; quiz_id=$State.quiz_id; engine_locked=(EngineLocked); version="0.2.0" } }
    default      { $res.StatusCode = 404; $out = @{ error="not found" } }
  }
  $json = ($out | ConvertTo-Json -Compress)
  $buf = [Text.Encoding]::UTF8.GetBytes($json)
  $res.ContentType = "application/json"; $res.OutputStream.Write($buf,0,$buf.Length); $res.Close()
}
