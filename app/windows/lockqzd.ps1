# LOCKqz Windows daemon (watcher + loopback control server).  Run elevated.
# Mirrors the macOS daemon: the per-user agent calls 127.0.0.1:8787 to lock/unlock;
# a watcher re-applies the block during a quiz and reports tampering.
# Device key: a random per-install key in a file only SYSTEM and Administrators can read. The
# daemon registers it once and signs every report and password request (HMAC-SHA256), so a
# script that never installed LOCKqz cannot fake a lock and read the quiz password. The agent
# gets the password from POST /password here, only while this PC is locked for that quiz.
# Self-update: ~90 s after start and every ~6 h, while NO quiz is locked, fetches
# <site>/download/update.json + update.sig, checks the RSA-SHA256 signature against the public key
# shipped with the install (update.pub.xml), downloads each listed file, checks its SHA-256, swaps
# the files in and restarts both tasks. Anything wrong leaves the install exactly as it was.
$ErrorActionPreference = "SilentlyContinue"
$Version = "0.3.7"
$Here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$Engine = Join-Path $Here "lockqz.ps1"
$ConfPath = "$env:ProgramData\LOCKqz\config.json"
$Conf = if (Test-Path $ConfPath) { Get-Content $ConfPath -Raw | ConvertFrom-Json } else { @{} }
$Port   = if ($Conf.port) { [int]$Conf.port } else { 8787 }
$Token  = if ($Conf.token) { $Conf.token } else { "lockqz-dev" }
$Api    = if ($Conf.api_base) { $Conf.api_base.TrimEnd("/") } else { "" }
if ($Api -and -not $Api.EndsWith("/api")) { $Api += "/api" }   # accept a bare site URL too
$Site = if ($Api.EndsWith("/api")) { $Api.Substring(0, $Api.Length - 4) } else { $Api }
$UpdateUrl = if ($Conf.store_package) { "store:" + $Conf.store_package } elseif ($env:LOCKQZ_UPDATE_URL) { $env:LOCKQZ_UPDATE_URL.TrimEnd("/") } elseif ($Site) { "$Site/download" } else { "" }
$Device = if ($Conf.device_id) { $Conf.device_id } else { "unknown" }
$MaxMin = if ($Conf.max_minutes) { [int]$Conf.max_minutes } else { 180 }
$State  = [hashtable]::Synchronized(@{ state="unlocked"; quiz_id=$null; student=$Conf.student; locked_since=0; max_minutes=$MaxMin; skew=0; registered=$false })
$KeyPath = "$env:ProgramData\LOCKqz\device.key"

# Signing + API calls. Kept as text so the watcher runspace can load the same code.
$SignLib = @'
function LQ-Hex([byte[]]$b) { -join ($b | ForEach-Object { $_.ToString("x2") }) }
function LQ-Sign([string]$key, [string]$path, [string]$ts, [byte[]]$raw) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $msg = "POST`n" + $path + "`n" + $ts + "`n" + (LQ-Hex $sha.ComputeHash($raw))
  $h = New-Object System.Security.Cryptography.HMACSHA256
  $h.Key = [Text.Encoding]::ASCII.GetBytes($key)
  LQ-Hex $h.ComputeHash([Text.Encoding]::UTF8.GetBytes($msg))
}
function LQ-Call($api, $path, $obj, $device, $key, $state, [bool]$signed) {
  # POST JSON to the LOCKqz API. Returns @{ code = <http status, 0 = no answer>; data = <reply> }.
  # Signed with the device key; corrects a wrong PC clock and re-registers on a 401. Never throws.
  if (-not $api) { return @{ code = 0; data = $null } }
  $url = $api + $path
  $raw = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress))
  for ($i = 0; $i -lt 3; $i++) {
    $hd = @{}
    if ($signed) {
      $ts = [string]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + [int64]$state.skew)
      $hd["X-LOCKqz-Device"] = $device
      $hd["X-LOCKqz-Time"] = $ts
      $hd["X-LOCKqz-Sig"] = LQ-Sign $key ([Uri]$url).AbsolutePath $ts $raw
    }
    try {
      $d = Invoke-RestMethod -Uri $url -Method Post -Body $raw -Headers $hd -ContentType "application/json; charset=utf-8" -TimeoutSec 8
      return @{ code = 200; data = $d }
    } catch {
      $code = 0; $data = $null
      if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
      if ($_.ErrorDetails -and $_.ErrorDetails.Message) { try { $data = $_.ErrorDetails.Message | ConvertFrom-Json } catch {} }
      if ($code -eq 401 -and $signed -and $data -and $i -lt 2) {
        if ($data.server_time) { $state.skew = [int64]$data.server_time - [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }
        if ($data.why -eq "unregistered") { $state.registered = $false; LQ-Register $api $device $key $state | Out-Null }
        continue
      }
      if ($code -ne 0) { return @{ code = $code; data = $data } }
      Start-Sleep -Seconds (2 * ($i + 1))
    }
  }
  return @{ code = 0; data = $null }
}
function LQ-Register($api, $device, $key, $state) {
  # Register the key of this install once (trust on first use).
  if ($state.registered -or -not $api -or -not $device -or $device -eq "unknown") { return $state.registered }
  $r = LQ-Call $api "/register" @{ device_id = $device; key = $key; platform = "windows"; version = $Version; student = $state.student } $device $key $state $false
  if ($r.code -eq 200) { $state.registered = $true }
  return $state.registered
}
function LQ-VerifySig([byte[]]$body, [string]$sigB64, [string]$pubXml) {
  # RSA-SHA256 (PKCS#1 v1.5) over the exact manifest bytes, public key in .NET XML form.
  try {
    $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
    $rsa.FromXmlString($pubXml)
    return [bool]$rsa.VerifyData($body, "SHA256", [Convert]::FromBase64String($sigB64.Trim()))
  } catch { return $false }
}
function LQ-StoreUpdate($state, [string]$here, [string]$pkgName, [string]$version) {
  # Microsoft Store installs: never download code. When the Store has delivered a newer LOCKqz
  # package, copy its (Microsoft-signed) payload into the install. Never throws.
  try {
    if (-not $env:LOCKQZ_UPDATE_DIR -and $here.TrimEnd("\") -ne "$env:ProgramData\LOCKqz") { return $false }
    $pkg = Get-AppxPackage -AllUsers -Name $pkgName -ErrorAction SilentlyContinue | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1
    if (-not $pkg) { return $false }
    $src = Join-Path $pkg.InstallLocation "payload"
    $vf = Join-Path $src "VERSION"
    if (-not (Test-Path $vf)) { return $false }
    $v = (Get-Content $vf -Raw).Trim()
    if ([version]$v -le [version]$version) { return $false }
    if ($state.state -eq "locked") { Write-Host "update: quiz in progress - deferred"; return $false }
    $never = @("config.json", "device.key", "active_lock.json", "VERSION")
    foreach ($f in Get-ChildItem $src -File) {
      if ($never -contains $f.Name) { continue }
      Copy-Item -Force $f.FullName (Join-Path $here $f.Name)
    }
    Write-Host "update: $version -> $v from the Store package"
    return $true
  } catch { Write-Host "store update check failed: $_"; return $false }
}
function LQ-CheckUpdate($state, [string]$here, [string]$updateUrl, [string]$version) {
  # Signed self-update; only while no quiz is locked. Returns $true when an update was installed.
  # A bad signature, hash, file name or download leaves the install untouched. Never throws.
  $stage = Join-Path $here ".update"
  if ($updateUrl -like "store:*") { return (LQ-StoreUpdate $state $here $updateUrl.Substring(6) $version) }
  try {
    if (-not $updateUrl) { return $false }
    $pubPath = Join-Path $here "update.pub.xml"
    if (-not (Test-Path $pubPath)) { return $false }
    # Only a real install updates itself (or a test that names LOCKQZ_UPDATE_DIR): never a source checkout.
    if (-not $env:LOCKQZ_UPDATE_DIR -and $here.TrimEnd("\") -ne "$env:ProgramData\LOCKqz") { return $false }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $wc = New-Object System.Net.WebClient
    $wc.Headers["User-Agent"] = "LOCKqz/$version (Windows)"
    $body = $wc.DownloadData("$updateUrl/update.json")
    $sig = [Text.Encoding]::ASCII.GetString($wc.DownloadData("$updateUrl/update.sig"))
    if (-not (LQ-VerifySig $body $sig (Get-Content $pubPath -Raw))) { Write-Host "update: manifest signature INVALID - ignored"; return $false }
    $m = [Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json
    if ([version]$m.version -le [version]$version) { return $false }
    $files = $m.windows.files
    if (-not $files -or -not $files.PSObject.Properties["lockqzd.ps1"]) { Write-Host "update: manifest lists no Windows helper - ignored"; return $false }
    $never = @("config.json", "device.key", "active_lock.json")
    foreach ($p in $files.PSObject.Properties) {
      if ($never -contains $p.Name -or $p.Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$' -or ([string]$p.Value) -notmatch '^[0-9a-f]{64}$') {
        Write-Host "update: refusing file entry $($p.Name)"; return $false
      }
    }
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    $sha = [System.Security.Cryptography.SHA256]::Create()
    foreach ($p in $files.PSObject.Properties) {
      $data = $wc.DownloadData("$updateUrl/windows/$($p.Name)")
      $got = LQ-Hex $sha.ComputeHash($data)
      if ($got -ne [string]$p.Value) { Write-Host "update: SHA-256 mismatch for $($p.Name) - ignored"; Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue; return $false }
      [IO.File]::WriteAllBytes((Join-Path $stage $p.Name), $data)
    }
    if ($state.state -eq "locked") { Write-Host "update: quiz in progress - deferred"; Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue; return $false }
    foreach ($p in $files.PSObject.Properties) { Move-Item -Force (Join-Path $stage $p.Name) (Join-Path $here $p.Name) }
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "update: $version -> $($m.version) installed ($($files.PSObject.Properties.Name.Count) files)"
    return $true
  } catch { Write-Host "update check failed: $_"; Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue; return $false }
}
'@
. ([ScriptBlock]::Create($SignLib))

function Get-DeviceKey {
  # 32 random bytes (hex) that only SYSTEM and Administrators can read; students' normal
  # accounts, and the per-user agent, cannot.
  if (Test-Path $KeyPath) {
    $k = ([string](Get-Content $KeyPath -Raw)).Trim()
    if ($k -match "^[0-9a-f]{64}$") { return $k }
  }
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $k = LQ-Hex $bytes
  Set-Content -Path $KeyPath -Value $k -Encoding ASCII -NoNewline
  & icacls $KeyPath /inheritance:r /grant:r "*S-1-5-18:F" "*S-1-5-32-544:F" | Out-Null
  return $k
}
$Key = Get-DeviceKey

# One engine run at a time (shared with the watcher): a re-lock still running when the quiz ends
# must never land after the unlock and leave the student blocked.
$EngineMutex = New-Object System.Threading.Mutex($false, "Global\LOCKqzEngine")
function Engine([string]$c) {
  try { $null = $EngineMutex.WaitOne(120000) } catch [System.Threading.AbandonedMutexException] { }
  try { & powershell -ExecutionPolicy Bypass -File $Engine $c | Out-Null } finally { try { $EngineMutex.ReleaseMutex() } catch { } }
}
function EngineLocked { (& powershell -ExecutionPolicy Bypass -File $Engine status) -cmatch "LOCKqz: LOCKED" }
# Active-lock record (SYSTEM/admins only). Brightspace checks access only when a quiz is LAUNCHED, so the
# lock must survive this service being killed: on restart we resume an unexpired lock instead of unlocking.
$LockFile = if ($env:LOCKQZ_LOCKFILE) { $env:LOCKQZ_LOCKFILE } else { "$env:ProgramData\LOCKqz\active_lock.json" }
function Save-Lock {
  New-Item -ItemType Directory -Force -Path (Split-Path $LockFile) | Out-Null
  @{ quiz_id=$State.quiz_id; student=$State.student; locked_since=$State.locked_since; max_minutes=$State.max_minutes } | ConvertTo-Json -Compress | Set-Content -Path $LockFile -Encoding UTF8
  try { icacls $LockFile /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" | Out-Null } catch {}
}
function Clear-Lock { Remove-Item -Path $LockFile -Force -ErrorAction SilentlyContinue }
function Load-Lock {
  try {
    $r = Get-Content $LockFile -Raw | ConvertFrom-Json
    $now = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); $mx = if ($r.max_minutes) { [int]$r.max_minutes } else { $MaxMin }
    if ($r.quiz_id -and $r.locked_since -gt 0 -and ($now - [int]$r.locked_since) -ge 0 -and ($now - [int]$r.locked_since) -lt ($mx * 60)) { return $r }
  } catch {}
  Clear-Lock; return $null
}
function Lock-Id($u) {
  # Same rule as the agent and the server: "<ou>-<qi>" from the quiz URL.
  $qi = if ($u -match "qi=(\d+)") { $Matches[1] } else { "x" }
  $ou = if ($u -match "ou=(\d+)") { $Matches[1] } else { "x" }
  "$ou-$qi"
}
function Report($event, $detail, $source, $quiz) {
  $b = @{ device_id=$Device; event=$event; quiz_id=$(if ($quiz) { $quiz } else { $State.quiz_id }); student=$State.student;
          ts=(Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
  if ($detail) { $b.detail = $detail }
  if ($source) { $b.source = $source }
  LQ-Call $Api "/report" $b $Device $Key $State $true | Out-Null
}

# Watcher runspace: re-apply the block while locked; flag tamper.
$watcher = [powershell]::Create()
$watcher.AddScript({
  param($State,$Engine,$Api,$Device,$Key,$SignLib,$Here,$UpdateUrl,$Version)
  . ([ScriptBlock]::Create($SignLib))
  function WUpdate {
    if (-not (LQ-CheckUpdate $State $Here $UpdateUrl $Version)) { return }
    $b = @{ device_id=$Device; event="update"; detail=@{ from=$Version }; ts=(Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
    LQ-Call $Api "/report" $b $Device $Key $State $true | Out-Null
    if ($env:LOCKQZ_NO_RESTART) { Write-Host "update: (test) would restart the agent and the helper"; return }
    # Restart both tasks from a detached process: stopping "LOCKqz" ends this very process.
    Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile -Command `"Stop-ScheduledTask -TaskName 'LOCKqz Agent'; Stop-ScheduledTask -TaskName 'LOCKqz'; Start-Sleep 3; Start-ScheduledTask -TaskName 'LOCKqz'; Start-ScheduledTask -TaskName 'LOCKqz Agent'`""
  }
  function ELocked { (& powershell -ExecutionPolicy Bypass -File $Engine status) -cmatch "LOCKqz: LOCKED" }
  function WReport($event,$detail,$source) {
    $b = @{ device_id=$Device; event=$event; quiz_id=$State.quiz_id; student=$State.student;
            ts=(Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
    if ($detail) { $b.detail = $detail }
    if ($source) { $b.source = $source }
    LQ-Call $Api "/report" $b $Device $Key $State $true | Out-Null
  }
  $mx = New-Object System.Threading.Mutex($false, "Global\LOCKqzEngine")
  $cycles = 0
  while ($true) {
    Start-Sleep -Seconds 5; $cycles++
    if ($State.state -eq "locked") {
      $now = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
      if ($State.locked_since -gt 0 -and ($now - $State.locked_since) -gt ($State.max_minutes * 60)) {
        # hard-max safety: never leave a student locked
        WReport "auto_unlock" "max_minutes" $null
        $State.state = "unlocked"; $State.quiz_id = $null; $State.locked_since = 0
        try { $null = $mx.WaitOne(120000) } catch [System.Threading.AbandonedMutexException] { }
        try { & powershell -ExecutionPolicy Bypass -File $Engine unlock | Out-Null } finally { try { $mx.ReleaseMutex() } catch { } }
        $lf = if ($env:LOCKQZ_LOCKFILE) { $env:LOCKQZ_LOCKFILE } else { "$env:ProgramData\LOCKqz\active_lock.json" }
        Remove-Item -Path $lf -Force -ErrorAction SilentlyContinue
      } else {
        if (-not (ELocked)) { WReport "tamper" "hosts_block_removed" $null }
        try { $null = $mx.WaitOne(120000) } catch [System.Threading.AbandonedMutexException] { }
        try { if ($State.state -eq "locked") { & powershell -ExecutionPolicy Bypass -File $Engine lock | Out-Null } }
        finally { try { $mx.ReleaseMutex() } catch { } }
        # liveness ping every ~45s so a killed helper shows up on the live monitor
        if ($cycles % 9 -eq 0) { WReport "heartbeat" $null "helper" }
      }
    }
    # ~hourly until the server knows this device's key
    if (($cycles % 720 -eq 0) -and -not $State.registered) { LQ-Register $Api $Device $Key $State | Out-Null }
    # ~90 s after start, then every ~6 h: signed self-update (skips itself during a quiz)
    $every = if ($env:LOCKQZ_UPDATE_CYCLES) { [int]$env:LOCKQZ_UPDATE_CYCLES } else { 4320 }
    if ($cycles -eq [math]::Min(18, $every) -or ($cycles % $every -eq 0)) { WUpdate }
  }
}).AddArgument($State).AddArgument($Engine).AddArgument($Api).AddArgument($Device).AddArgument($Key).AddArgument($SignLib).AddArgument($Here).AddArgument($UpdateUrl).AddArgument($Version) | Out-Null
$watcher.BeginInvoke() | Out-Null

# Fail safe on start: never leave a machine locked across a restart.
$saved = Load-Lock
if ($saved) {
  # Service was killed or the PC rebooted mid-quiz: stay locked and report it. Hard max still unlocks on time.
  $State.state="locked"; $State.quiz_id=$saved.quiz_id; if ($saved.student) { $State.student=$saved.student }
  $State.locked_since=[int]$saved.locked_since; $State.max_minutes=[int]$saved.max_minutes
  Engine "lock"; Report "tamper" @{ detail="helper_restarted_mid_quiz" } $null $saved.quiz_id
} else { Engine "unlock" }
LQ-Register $Api $Device $Key $State | Out-Null

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
    "/lock"      { $State.state="locked"; $State.quiz_id=$body.quiz_id; if($body.student){$State.student=$body.student}; if($body.max_minutes){$State.max_minutes=[int]$body.max_minutes}; $State.locked_since=[int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); Engine "lock"; Save-Lock; Report "lock" $null; $out.state="locked" }
    "/unlock"    { $q = if ($State.quiz_id) { $State.quiz_id } else { $body.quiz_id }; $State.state="unlocked"; $State.quiz_id=$null; Engine "unlock"; Clear-Lock; Report "unlock" $null $null $q; $out.state="unlocked" }
    "/student"   { if($body.student){$State.student=$body.student}; Report "install" @{ platform="windows"; version=$Version }; $out.student=$State.student }
    "/verify"    {
      # One-time student email setup (status | check | send | code), signed with the SYSTEM-only key
      # so an email can only ever be bound to THIS computer.
      $op = [string]$body.op
      if (@("status","check","send","code") -notcontains $op) { $res.StatusCode = 400; $out = @{ error = "bad op" } }
      else {
        $q = @{ op = $op; device_id = $Device }
        if ($body.email) { $em = [string]$body.email; $q.email = $em.Substring(0, [Math]::Min(200, $em.Length)) }
        if ($body.code)  { $q.code = [string]$body.code }
        $r = LQ-Call $Api "/verify" $q $Device $Key $State $true
        $out = @{ status = $r.code }
        if ($r.data) { foreach ($pp in $r.data.PSObject.Properties) { $out[$pp.Name] = $pp.Value } }
        if ($out.verified) { $State.student = if ($out.student) { $out.student } else { $q.email } }
      }
    }
    "/heartbeat" { Report "heartbeat" $body "agent" }
    "/password"  {
      # The quiz password is released only to this helper, only while it holds the lock for THIS
      # quiz with the block really in place, over a request signed with the SYSTEM-only key.
      $u = [string]$body.url
      if ($State.state -ne "locked" -or $State.quiz_id -ne (Lock-Id $u)) { $res.StatusCode = 409; $out = @{ error = "not locked for this quiz" } }
      else {
        if (-not (EngineLocked)) { Engine "lock" }
        if (-not (EngineLocked)) { Report "tamper" "block_missing_at_password" $null; $res.StatusCode = 409; $out = @{ error = "AI block is not in place" } }
        else {
          Report "heartbeat" $null "helper"
          $r = LQ-Call $Api "/password" @{ url = $u; device_id = $Device } $Device $Key $State $true
          $pw = $null; $pay = $null; if ($r.data) { $pw = $r.data.password; $pay = $r.data.pay }
          if ((-not $pw) -and (-not $pay)) { $res.StatusCode = 502 }
          $out = @{ password = $pw; status = $r.code; pay = $pay }
        }
      }
    }
    "/event"     { if ($body.event -eq "quiz_left") { Report "quiz_left" $body.detail "agent" $body.quiz_id } else { $res.StatusCode = 400; $out = @{ error = "event not allowed" } } }
    "/status"    { $out = @{ state=$State.state; quiz_id=$State.quiz_id; engine_locked=(EngineLocked); version=$Version } }
    default      { $res.StatusCode = 404; $out = @{ error="not found" } }
  }
  $json = ($out | ConvertTo-Json -Compress)
  $buf = [Text.Encoding]::UTF8.GetBytes($json)
  $res.ContentType = "application/json"; $res.OutputStream.Write($buf,0,$buf.Length); $res.Close()
}
