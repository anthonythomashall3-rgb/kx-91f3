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
$Version = "0.5.1"
$Here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$Engine = Join-Path $Here "lockqz.ps1"
$ConfPath = if ($env:LOCKQZ_CONFIG) { $env:LOCKQZ_CONFIG } else { "$env:ProgramData\LOCKqz\config.json" }
function Migrate-ConfText([string]$raw) {
  # The only config changes the helper makes itself: an api_base on the retired lockdownqz.pages.dev
  # moves to lockqz.pages.dev (old installs reach the current API and updates). Text-level, so every
  # other key, value and the file's permissions stay exactly as they were. -> @{ text; changed }
  $c = $null; try { $c = $raw | ConvertFrom-Json } catch { }
  if ($c -and ([string]$c.api_base) -match 'lockdownqz\.pages\.dev') {
    return @{ text = ($raw -replace 'lockdownqz\.pages\.dev', 'lockqz.pages.dev'); changed = $true }
  }
  return @{ text = $raw; changed = $false }
}
if (Test-Path $ConfPath) {
  try {
    $mc = Migrate-ConfText ([IO.File]::ReadAllText($ConfPath))
    if ($mc.changed) { [IO.File]::WriteAllText($ConfPath, $mc.text, (New-Object Text.UTF8Encoding($false))); Write-Host "LOCKqzd: config moved to lockqz.pages.dev" }
  } catch { Write-Host "LOCKqzd: config migration skipped: $_" }
}
$Conf = if (Test-Path $ConfPath) { Get-Content $ConfPath -Raw | ConvertFrom-Json } else { @{} }
$Port   = if ($Conf.port) { [int]$Conf.port } else { 8787 }
# A release (safety cap / server / other school) is reported to the agent at most this long, or until
# the agent says the quiz page closed (/uncap): then the same quiz - a new attempt, a makeup - locks again.
$CapForget = if ($env:LOCKQZ_CAP_FORGET) { [Math]::Max(60, [int]$env:LOCKQZ_CAP_FORGET) } else { 1800 }
$Token  = if ($Conf.token) { $Conf.token } else { "lockqz-dev" }
$Api    = if ($Conf.api_base) { $Conf.api_base.TrimEnd("/") } else { "" }
if ($Api -and -not $Api.EndsWith("/api")) { $Api += "/api" }   # accept a bare site URL too
$Site = if ($Api.EndsWith("/api")) { $Api.Substring(0, $Api.Length - 4) } else { $Api }
$UpdateUrl = if ($Conf.store_package) { "store:" + $Conf.store_package } elseif ($env:LOCKQZ_UPDATE_URL) { $env:LOCKQZ_UPDATE_URL.TrimEnd("/") } elseif ($Site) { "$Site/download" } else { "" }
$Device = if ($Conf.device_id) { $Conf.device_id } else { "unknown" }
# Safety cap (OWNER DECISION, round 2): AI comes back the moment the quiz is submitted; the cap is only
# a failsafe for a broken agent. Quiz end known (the server's /password answer) -> end + 15 min;
# unknown -> 6 h; never more than 24 h. The old 3-hour cap and config "max_minutes": 180 are gone;
# config "cap_minutes" replaces the 6 h default (tests only). A /lock request may only ask for LESS.
$CapCeilMin = 1440
$CapMin = 360
$cmN = 0; if ([int]::TryParse([string]$Conf.cap_minutes, [ref]$cmN) -and $cmN -gt 0) { $CapMin = [Math]::Min($cmN, $CapCeilMin) }
function Clamp-Minutes($m) { $n = 0; if (-not [int]::TryParse([string]$m, [ref]$n) -or $n -le 0) { return $CapMin }; return [Math]::Min($n, $CapMin) }
$MaxMin = $CapMin
# state: "unlocked" | "locking" (engine running, watcher keeps out) | "locked".  applied = the block was
# verified in place at least once during this lock (only then can its absence be tampering).
# capped_quiz: released by the safety cap or the server (submitted / ended / other school) - the agent
# never re-locks it while its page stays open.
$State  = [hashtable]::Synchronized(@{ state="unlocked"; quiz_id=$null; student=$Conf.student; locked_since=0; max_minutes=$MaxMin; cap_at=0; end_known=$false; mono_since=$null; applied=$false; skew=0; registered=$false; capped_quiz=$null; capped_at=0; capped_reason=$null })
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
      $ua = "LOCKqz/" + $(if ($Version) { $Version } else { "0" }) + " (Windows)"
      $d = Invoke-RestMethod -Uri $url -Method Post -Body $raw -Headers $hd -ContentType "application/json; charset=utf-8" -TimeoutSec 8 -UserAgent $ua
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
function LQ-Due($last, $now, [int]$every) {
  # Wall-clock timer: $true when at least $every seconds passed since $last (unix seconds; 0 = never).
  return ([int64]$last -le 0) -or (([int64]$now - [int64]$last) -ge $every) -or ([int64]$now -lt [int64]$last)
}
function LQ-ParseIso($s) {
  # Server time ("2026-10-25T21:00:00.000Z") -> unix seconds, or 0 when missing/garbage. (PowerShell 7
  # turns ISO strings in JSON into DateTime objects; Windows PowerShell 5.1 keeps the string.)
  if ($s -is [DateTime]) { return [int64]([DateTimeOffset]$s.ToUniversalTime()).ToUnixTimeSeconds() }
  $s = [string]$s
  if (-not $s) { return [int64]0 }
  $d = [DateTimeOffset]::MinValue
  $st = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
  if ([DateTimeOffset]::TryParse($s, [Globalization.CultureInfo]::InvariantCulture, $st, [ref]$d)) { return [int64]$d.ToUnixTimeSeconds() }
  return [int64]0
}
function LQ-CapForEnd([int64]$lockedSince, [int64]$endUnix, [int64]$now, [int64]$skew) {
  # New safety-cap time once the server named the quiz end (server clock), or 0 = keep the current cap:
  # end + 15 min, never more than 24 h after the lock started; an end already over is ignored (the
  # server own quiz_ended unlock covers that).
  if ($endUnix -le 0 -or $lockedSince -le 0) { return [int64]0 }
  $localEnd = $endUnix - $skew
  if (($localEnd + 900) -le $now) { return [int64]0 }
  return [int64][Math]::Min($lockedSince + 86400, $localEnd + 900)
}
function LQ-ServerReason($data) {
  # C9: the server reply to a helper heartbeat/lock may say {unlock:true, reason}. -> reason or $null.
  if (-not $data) { return $null }
  if (-not (($data.unlock -is [bool]) -and $data.unlock)) { return $null }
  if (@("quiz_submitted", "quiz_ended") -contains [string]$data.reason) { return [string]$data.reason }
  return "quiz_ended"
}
function LQ-InstallDue($rec, [string]$version, $student, [int64]$now) {
  # C6: the "install" report goes out only when the version or the student changed, or after 24 h.
  if (-not $rec) { return $true }
  $at = [int64]0; [void][int64]::TryParse([string]$rec.at, [ref]$at)
  return (([string]$rec.version -ne $version) -or ([string]$rec.student -ne [string]$student) -or (($now - $at) -ge 86400) -or ($now -lt $at))
}
function LQ-UnlockReason($claimed, $requester) {
  # Reason sent with every unlock report. Only the LOCKqz agent may name a quiz-ending reason;
  # any other local caller of /unlock is "local_request". (The safety cap reports "cap" itself.)
  $agentReasons = @("quiz_submitted", "quiz_left", "quiz_tab_closed")
  if (($agentReasons -contains [string]$claimed) -and ($requester.kind -ne "other")) { return [string]$claimed }
  return "local_request"
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
    if ($state.state -ne "unlocked") { return $false }   # never during a quiz
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
    # Never download during a quiz (no traffic, nothing swapped while the student works).
    if ($state.state -ne "unlocked") { return $false }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $wc = New-Object System.Net.WebClient
    $wc.Headers["User-Agent"] = "LOCKqz/$version (Windows)"
    $body = $wc.DownloadData("$updateUrl/update.json")
    $sig = [Text.Encoding]::ASCII.GetString($wc.DownloadData("$updateUrl/update.sig"))
    if (-not (LQ-VerifySig $body $sig (Get-Content $pubPath -Raw))) { Write-Host "update: manifest signature INVALID - ignored"; return $false }
    $m = [Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json
    if ([version]$m.version -le [version]$version) { return $false }
    # A release that failed to start here and was rolled back (lockqz-boot.ps1) is never retried.
    $badf = Join-Path $here ".bad_version"
    if ((Test-Path $badf) -and (([string](Get-Content $badf -Raw)).Trim() -eq [string]$m.version)) { return $false }
    $files = $m.windows.files
    if (-not $files -or -not $files.PSObject.Properties["lockqzd.ps1"]) { Write-Host "update: manifest lists no Windows helper - ignored"; return $false }
    $never = @("config.json", "device.key", "active_lock.json", "install_report.json", "policy-backup.json", "hosts.backup")
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
    if ($state.state -ne "unlocked") { Write-Host "update: quiz in progress - deferred"; Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue; return $false }
    # Rollback kit for lockqz-boot.ps1: the files this update replaces (.prev), the names it adds
    # (.prev\.added) and a .pending marker the NEW helper clears once it answers /status.
    $prev = Join-Path $here ".prev"
    Remove-Item $prev -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $prev -Force -ErrorAction Stop | Out-Null
    $added = @()
    foreach ($p in $files.PSObject.Properties) {
      $cur = Join-Path $here $p.Name
      if (Test-Path -LiteralPath $cur -PathType Leaf) { Copy-Item -LiteralPath $cur (Join-Path $prev $p.Name) -Force -ErrorAction Stop } else { $added += $p.Name }
    }
    [IO.File]::WriteAllText((Join-Path $prev ".added"), (($added | ForEach-Object { $_ + "`r`n" }) -join ""))
    [IO.File]::WriteAllText((Join-Path $here ".pending"), ("from=" + $version + "`r`nto=" + [string]$m.version + "`r`nstarts=0`r`n"))
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
  # -> the engine's output (one string). "LOCKqz: LOCKED" / "LOCKqz: UNLOCKED" only when verified.
  $got = $false
  try { $got = $EngineMutex.WaitOne(120000) } catch [System.Threading.AbandonedMutexException] { $got = $true }
  try { return ((& powershell -NoProfile -ExecutionPolicy Bypass -File $Engine $c) -join "`n") }
  finally { if ($got) { try { $EngineMutex.ReleaseMutex() } catch { } } }
}
function Policy-Relock {
  # Browser policy only (the allowance changed while locked), under the engine's lock.
  $got = $false
  try { $got = $EngineMutex.WaitOne(120000) } catch [System.Threading.AbandonedMutexException] { $got = $true }
  try { & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Here "browser-policy.ps1") lock | Out-Null }
  finally { if ($got) { try { $EngineMutex.ReleaseMutex() } catch { } } }
}
function EngineLocked { (& powershell -NoProfile -ExecutionPolicy Bypass -File $Engine status) -cmatch "LOCKqz: LOCKED" }
# Cheap in-process check of the hosts block (same marker as the engine), for /status.
$HostsFile = "$env:WINDIR\System32\drivers\etc\hosts"
function HostsLocked { try { [IO.File]::ReadAllText($HostsFile) -match [regex]::Escape("# LOCKqz START") } catch { $false } }
function Get-Requester($req) {
  # Which local process called us: its TCP source port -> owning process -> command line.
  # kind: "agent" (the installed LOCKqz agent), "other", or "unknown" (lookup failed).
  $who = @{ kind = "unknown" }
  try {
    $c = Get-NetTCPConnection -LocalPort $req.RemoteEndPoint.Port -RemotePort $Port -ErrorAction Stop | Select-Object -First 1
    $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$c.OwningProcess) -ErrorAction Stop
    $cl = [string]$p.CommandLine
    $who = @{ kind = "other"; pid = [int]$c.OwningProcess; name = [string]$p.Name; cmd = $cl.Substring(0, [Math]::Min(300, $cl.Length)) }
    if ($cl -match ('-File\s+"?' + [regex]::Escape((Join-Path $Here "lockqz-agent.ps1")) + '"?(\s|$)')) { $who.kind = "agent" }
  } catch { }
  return $who
}
# Active-lock record (SYSTEM/admins only). Brightspace checks access only when a quiz is LAUNCHED, so the
# lock must survive this service being killed: on restart we resume an unexpired lock instead of unlocking.
$LockFile = if ($env:LOCKQZ_LOCKFILE) { $env:LOCKQZ_LOCKFILE } else { "$env:ProgramData\LOCKqz\active_lock.json" }
function Save-Lock {
  New-Item -ItemType Directory -Force -Path (Split-Path $LockFile) | Out-Null
  @{ quiz_id=$State.quiz_id; student=$State.student; locked_since=$State.locked_since; max_minutes=$State.max_minutes; cap_at=$State.cap_at; end_known=$State.end_known } | ConvertTo-Json -Compress | Set-Content -Path $LockFile -Encoding UTF8
  try { & icacls $LockFile /inheritance:r /grant:r "*S-1-5-18:F" "*S-1-5-32-544:F" | Out-Null } catch {}
}
function Clear-Lock { Remove-Item -Path $LockFile -Force -ErrorAction SilentlyContinue }
function Load-Lock {
  try {
    $r = Get-Content $LockFile -Raw | ConvertFrom-Json
    $now = [int64][DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); $since = [int64]$r.locked_since
    # cap time from the record; a 0.4.0 record has none: its max_minutes, at most the unknown-end cap
    $cap = [int64]0; [void][int64]::TryParse([string]$r.cap_at, [ref]$cap)
    if ($cap -le $since) { $cap = $since + 60 * (Clamp-Minutes $r.max_minutes) }
    $cap = [Math]::Min($cap, $since + 86400)
    if ($r.quiz_id -and $since -gt 0 -and ($now - $since) -ge 0 -and $now -lt $cap) {
      return [pscustomobject]@{ quiz_id = $r.quiz_id; student = $r.student; locked_since = $since; cap_at = $cap; end_known = [bool]$r.end_known }
    }
  } catch {}
  Clear-Lock; return $null
}
function Lock-Id($u) {
  # Same rule as the agent and the server: "<ou>-<qi>" from the quiz URL's own ?ou= / &qi= parameters.
  $qi = [regex]::Match([string]$u, '[?&]qi=(\d+)'); $ou = [regex]::Match([string]$u, '[?&]ou=(\d+)')
  "$(if ($ou.Success) { $ou.Groups[1].Value } else { 'x' })-$(if ($qi.Success) { $qi.Groups[1].Value } else { 'x' })"
}
function Report($event, $detail, $source, $quiz) {
  $b = @{ device_id=$Device; event=$event; quiz_id=$(if ($quiz) { $quiz } else { $State.quiz_id }); student=$State.student;
          ts=(Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
  if ($detail) { $b.detail = $detail }
  if ($source) { $b.source = $source }
  return (LQ-Call $Api "/report" $b $Device $Key $State $true)
}
$InstFile = "$env:ProgramData\LOCKqz\install_report.json"
# Assistive tools the professor allows this student in the locked quiz (server's /password answer):
# keys only, read by browser-policy.ps1 (same admin-only folder), removed at every unlock / new quiz.
$AssistFile = if ($env:LOCKQZ_ASSIST_FILE) { $env:LOCKQZ_ASSIST_FILE } else { "$env:ProgramData\LOCKqz\assist.json" }
$AssistKeys = @("readwrite","equatio","cowriter","snapread","readaloud")
function LQ-AssistKeys($list) { return @(@($list) | ForEach-Object { [string]$_ } | Where-Object { $AssistKeys -contains $_ } | Sort-Object -Unique) }
function Set-Assist($q, $tools) {
  # Write (or remove, no tools) this quiz's allowance. -> $true when it changed.
  $t = @(LQ-AssistKeys $tools)
  if ($t.Count -eq 0) { if (Test-Path -LiteralPath $AssistFile) { Remove-Item -LiteralPath $AssistFile -Force -ErrorAction SilentlyContinue; return $true }; return $false }
  $new = (@{ quiz_id = [string]$q; tools = $t } | ConvertTo-Json -Compress)
  $cur = $null; try { $cur = Get-Content -LiteralPath $AssistFile -Raw -ErrorAction Stop } catch { }
  if ($cur -and ($cur.Trim() -eq $new)) { return $false }
  try { [IO.File]::WriteAllText($AssistFile, $new, (New-Object Text.UTF8Encoding($false))); return $true } catch { return $false }
}
function Report-Install {
  # C6: only when the version or the student changed, or 24 h passed (persisted across restarts).
  $rec = $null; try { $rec = Get-Content $InstFile -Raw -ErrorAction Stop | ConvertFrom-Json } catch { }
  $now = [int64][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  if (-not (LQ-InstallDue $rec $Version $State.student $now)) { return }
  $r = Report "install" @{ platform="windows"; version=$Version }
  if ($r.code -eq 200) { try { @{ version=$Version; student=$State.student; at=$now } | ConvertTo-Json -Compress | Set-Content -Path $InstFile -Encoding UTF8 } catch { } }
}
function Release-Quiz($q, [string]$reason) {
  # The server says this quiz is over (C9), or it is not a LOCKqz school (C10): AI back now; the agent
  # is told (status capped_quiz) not to re-lock it. Main thread only (the watcher has its own copy).
  if (($State.state -ne "locked") -or ($State.quiz_id -ne $q)) { return $false }
  $State.capped_quiz = $q; $State.capped_at = [int64][DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); $State.capped_reason = $reason
  $State.state = "unlocked"; $State.quiz_id = $null; $State.locked_since = 0; $State.cap_at = 0; $State.applied = $false
  $ok = (Engine "unlock") -cmatch "LOCKqz: UNLOCKED"   # if not, the watcher finishes it within 15 s
  Clear-Lock
  Report "unlock" @{ reason = $reason; requester = "server"; engine_ok = $ok } $null $q | Out-Null
  return $true
}

# Watcher runspace: re-apply the block while locked; flag tamper.
$watcher = [powershell]::Create()
$watcher.AddScript({
  param($State,$Engine,$Api,$Device,$Key,$SignLib,$Here,$UpdateUrl,$Version,$Port,$Token)
  . ([ScriptBlock]::Create($SignLib))
  function WUpdate {
    if (-not (LQ-CheckUpdate $State $Here $UpdateUrl $Version)) { return }
    $b = @{ device_id=$Device; event="update"; detail=@{ from=$Version }; ts=(Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
    LQ-Call $Api "/report" $b $Device $Key $State $true | Out-Null
    if ($env:LOCKQZ_NO_RESTART) { Write-Host "update: (test) would restart the agent and the helper"; return }
    # Restart both tasks from a detached process: stopping "LOCKqz" ends this very process.
    Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile -Command `"Stop-ScheduledTask -TaskName 'LOCKqz Agent'; Stop-ScheduledTask -TaskName 'LOCKqz'; Start-Sleep 3; Start-ScheduledTask -TaskName 'LOCKqz'; Start-ScheduledTask -TaskName 'LOCKqz Agent'`""
  }
  function ELocked { (& powershell -NoProfile -ExecutionPolicy Bypass -File $Engine status) -cmatch "LOCKqz: LOCKED" }
  function WEngine([string]$c) { ((& powershell -NoProfile -ExecutionPolicy Bypass -File $Engine $c) -join "`n") }
  function WReport($event,$detail,$source,$quiz) {
    $b = @{ device_id=$Device; event=$event; quiz_id=$(if ($quiz) { $quiz } else { $State.quiz_id }); student=$State.student;
            ts=(Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
    if ($detail) { $b.detail = $detail }
    if ($source) { $b.source = $source }
    return (LQ-Call $Api "/report" $b $Device $Key $State $true)
  }
  function WLock { $got = $false; try { $got = $mx.WaitOne(120000) } catch [System.Threading.AbandonedMutexException] { $got = $true }; return $got }
  function WUnlockMx($got) { if ($got) { try { $mx.ReleaseMutex() } catch { } } }
  $hostsPath = "$env:WINDIR\System32\drivers\etc\hosts"
  $policyBackup = "$env:ProgramData\LOCKqz\policy-backup.json"
  $mx = New-Object System.Threading.Mutex($false, "Global\LOCKqzEngine")
  $lf = if ($env:LOCKQZ_LOCKFILE) { $env:LOCKQZ_LOCKFILE } else { "$env:ProgramData\LOCKqz\active_lock.json" }
  function WRelease($q, [string]$reason, $extra) {
    # Unlock now and remember the quiz so the agent never re-locks it while its page stays open:
    # the safety cap, or the server's {unlock:true} (C9). -> $true when it unlocked.
    $ok = $false; $did = $false
    $got = WLock
    try {
      if (($State.state -eq "locked") -and $q -and ($State.quiz_id -eq $q)) {
        $State.capped_quiz = $q; $State.capped_at = [int64][DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); $State.capped_reason = $reason
        $State.state = "unlocked"; $State.quiz_id = $null; $State.locked_since = 0; $State.cap_at = 0; $State.applied = $false
        $ok = (WEngine "unlock") -cmatch "LOCKqz: UNLOCKED"
        Remove-Item -Path $lf -Force -ErrorAction SilentlyContinue
        $did = $true
      }
    } finally { WUnlockMx $got }
    if ($did) {
      $d = @{ reason = $reason; requester = "helper"; engine_ok = $ok }
      if ($extra) { foreach ($k in $extra.Keys) { $d[$k] = $extra[$k] } }
      WReport "unlock" $d $null $q | Out-Null
    }
    return $did
  }
  $cycles = 0; $lastBeat = 0; $lastSweep = 0; $storeMiss = 0
  while ($true) {
    Start-Sleep -Seconds 5; $cycles++
    $now = [int64][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    if ($State.state -eq "locked") {
      $capAt = [int64]$State.cap_at; if ($capAt -le 0) { $capAt = [int64]$State.locked_since + 60 * [int64]$State.max_minutes }
      # Wall clock AND monotonic clock must both say the cap is reached (as on the Mac): someone who moves
      # the PC's date forward must not end the lock. Stopwatch ticks ignore clock changes (PS 5.1 + 7).
      $monoNow = [int64]([Diagnostics.Stopwatch]::GetTimestamp() / [Diagnostics.Stopwatch]::Frequency)
      $monoOk = ($null -eq $State.mono_since) -or (($monoNow - [int64]$State.mono_since) -ge ($capAt - [int64]$State.locked_since))
      if ($State.locked_since -gt 0 -and $now -ge $capAt -and $monoOk) {
        # safety cap (quiz end + 15 min, or 6 h when the end is unknown, never > 24 h): a failsafe for a
        # broken agent - normally AI comes back the moment the quiz is submitted.
        WRelease $State.quiz_id "cap" @{ end_known = [bool]$State.end_known } | Out-Null
      } else {
        # Tamper check and re-apply under the engine mutex, re-checking the state inside it, so a
        # lock or unlock in progress can never look like a removed block.
        $tamper = $false
        $got = WLock
        try {
          if ($State.state -eq "locked") {
            $was = ELocked
            if ((-not $was) -and $State.applied -and ($State.state -eq "locked")) { $tamper = $true }
            $o = WEngine "lock"
            if (($State.state -eq "locked") -and ($o -cmatch "LOCKqz: LOCKED")) { $State.applied = $true }
          }
        } finally { WUnlockMx $got }
        if ($tamper) { WReport "tamper" "hosts_block_removed" $null | Out-Null }
        # liveness ping every 300 s of wall time, whatever a cycle costs (server: stale after 660 s)
        if (($State.state -eq "locked") -and (LQ-Due $lastBeat $now 300)) {
          $lastBeat = $now; $hq = $State.quiz_id
          $hr = WReport "heartbeat" $null "helper"
          $why = LQ-ServerReason $hr.data   # C9: the server says this student's quiz is over
          if ($why) { WRelease $hq $why $null | Out-Null }
        }
      }
    } elseif ($State.state -eq "unlocked") {
      $lastBeat = 0
      # Never leave AI blocked after an unlock: a block (or saved policy backup) still present while
      # unlocked means an unlock did not finish (hosts file busy, policy write failed) -> finish it.
      $stray = $false
      try { $stray = ([IO.File]::ReadAllText($hostsPath) -match [regex]::Escape("# LOCKqz START")) } catch { }
      if (-not $stray) { $stray = Test-Path $policyBackup }
      if ($stray -and (LQ-Due $lastSweep $now 15)) {
        $lastSweep = $now
        $got = WLock
        try { if ($State.state -eq "unlocked") { WEngine "unlock" | Out-Null } } finally { WUnlockMx $got }
      }
    }
    # ~hourly until the server knows this device's key
    if (($cycles % 720 -eq 0) -and -not $State.registered) { LQ-Register $Api $Device $Key $State | Out-Null }
    # A self-update proves it starts: once this helper answers /status with its own version, the
    # .pending marker goes and lockqz-boot.ps1 will not roll it back.
    $pend = Join-Path $Here ".pending"
    if (($cycles -ge 2) -and ($cycles -le 60) -and (Test-Path $pend)) {
      try {
        $sv = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/status" -Headers @{ "X-LOCKqz-Token" = $Token } -TimeoutSec 10
        if ($sv.version -eq $Version) { Remove-Item $pend -Force; Write-Host "update confirmed: $Version answers /status" }
      } catch { }
    }
    # Store install whose package the student removed (MSIX uninstall leaves the helper): after two
    # hourly checks that both SUCCEED and find no package, LOCKqz removes itself. Never during a quiz.
    if (($cycles % 720 -eq 0) -and ($UpdateUrl -like "store:*") -and ($State.state -eq "unlocked")) {
      $gone = $false
      try { $gone = -not (Get-AppxPackage -AllUsers -Name $UpdateUrl.Substring(6) -ErrorAction Stop) } catch { $gone = $false }
      if ($gone) { $storeMiss++ } else { $storeMiss = 0 }
      if ($storeMiss -ge 2) {
        $storeMiss = -100000
        Write-Host "store package removed - uninstalling LOCKqz"
        # Created through WMI so it outlives this task (uninstall.ps1 stops the task first).
        try { Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $Here "uninstall.ps1") + '"') } | Out-Null } catch { }
      }
    }
    # ~90 s after start, then every ~6 h: signed self-update (skips itself during a quiz)
    $every = if ($env:LOCKQZ_UPDATE_CYCLES) { [int]$env:LOCKQZ_UPDATE_CYCLES } else { 4320 }
    if ($cycles -eq [math]::Min(18, $every) -or ($cycles % $every -eq 0)) { WUpdate }
  }
}).AddArgument($State).AddArgument($Engine).AddArgument($Api).AddArgument($Device).AddArgument($Key).AddArgument($SignLib).AddArgument($Here).AddArgument($UpdateUrl).AddArgument($Version).AddArgument($Port).AddArgument($Token) | Out-Null
# Fail safe on start: never leave a machine locked across a restart. The state is set BEFORE the
# watcher starts, so it never mistakes a resumed lock for a leftover block.
$saved = Load-Lock
if ($saved) {
  $State.state="locking"; $State.quiz_id=$saved.quiz_id; if ($saved.student) { $State.student=$saved.student }
  $State.locked_since=[int64]$saved.locked_since; $State.cap_at=[int64]$saved.cap_at; $State.end_known=[bool]$saved.end_known
  $State.max_minutes=[int](([int64]$saved.cap_at - [int64]$saved.locked_since) / 60)
  # monotonic start = now minus the time already locked (the wall clock is all a restart has)
  $State.mono_since = [int64]([Diagnostics.Stopwatch]::GetTimestamp() / [Diagnostics.Stopwatch]::Frequency) - [Math]::Max([int64]0, [int64][DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [int64]$saved.locked_since)
}
$watcher.BeginInvoke() | Out-Null
if ($saved) {
  # Service was killed or the PC rebooted mid-quiz: stay locked and report it. Hard max still unlocks
  # on time, and the agent unlocks within its 30 s grace if the quiz is no longer open.
  $State.applied = (Engine "lock") -cmatch "LOCKqz: LOCKED"
  $State.state="locked"
  Report "tamper" @{ detail="helper_restarted_mid_quiz" } $null $saved.quiz_id | Out-Null
} else { Engine "unlock" | Out-Null }   # restores only what a LOCKqz lock changed; no-op otherwise
LQ-Register $Api $Device $Key $State | Out-Null
# Tell the server which version runs now (a self-update restarts the helper) - only when it changed or
# once a day (C6).
try { Report-Install } catch {}
# Installs from before 0.4.1 start this script straight from the "LOCKqz" task: point the task at the
# boot wrapper once, so a future update that fails to start is rolled back (lockqz-boot.ps1).
if ((-not $env:LOCKQZ_UPDATE_DIR) -and ($Here.TrimEnd("\") -eq "$env:ProgramData\LOCKqz") -and (Test-Path (Join-Path $Here "lockqz-boot.ps1"))) {
  try {
    $tk = Get-ScheduledTask -TaskName "LOCKqz" -ErrorAction Stop
    if (-not (@($tk.Actions) | Where-Object { $_.Arguments -match 'lockqz-boot\.ps1' })) {
      $na = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ('-WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $Here "lockqz-boot.ps1") + '"')
      Set-ScheduledTask -TaskName "LOCKqz" -Action $na -ErrorAction Stop | Out-Null
      Write-Host "LOCKqzd: task now starts through lockqz-boot.ps1"
    }
  } catch { Write-Host "LOCKqzd: could not point the task at lockqz-boot.ps1: $_" }
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Host "LOCKqzd: listening on 127.0.0.1:$Port"

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request; $res = $ctx.Response
  # No CORS: only local programs (the agent) talk to this server, never a web page.
  if ($req.Headers["Origin"]) { $res.StatusCode = 403; $res.Close(); continue }
  if ($req.Headers["X-LOCKqz-Token"] -ne $Token) { $res.StatusCode = 401; $res.Close(); continue }
  $path = $req.Url.AbsolutePath
  $body = @{}
  if ($req.HasEntityBody) { $body = (New-Object IO.StreamReader($req.InputStream)).ReadToEnd() | ConvertFrom-Json }
  $out = @{ ok = $true }
  switch ($path) {
    "/lock"      {
      # "locking" while the engine runs: the watcher neither checks for tampering nor sweeps a
      # "stray" block until the block is really in place.
      $same = ($State.state -eq "locked") -and ($State.quiz_id -eq $body.quiz_id)
      $State.state="locking"; $State.quiz_id=$body.quiz_id; if($body.student){$State.student=$body.student}
      if (-not $same) {
        # a new lock starts on the unknown-end cap (6 h); a caller may only ask for LESS; the server's
        # quiz end (in the /password answer) then sets it to end + 15 min. A repeat /lock never extends it.
        $State.max_minutes = Clamp-Minutes $(if ($body.max_minutes) { $body.max_minutes } else { $MaxMin })
        $State.locked_since=[int64][DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); $State.applied=$false
        $State.cap_at = [int64]$State.locked_since + 60 * [int64]$State.max_minutes; $State.end_known = $false
        $State.mono_since = [int64]([Diagnostics.Stopwatch]::GetTimestamp() / [Diagnostics.Stopwatch]::Frequency)
        Set-Assist $null @() | Out-Null   # another quiz's allowance never carries over
      }
      if ($State.capped_quiz -eq $body.quiz_id) { $State.capped_quiz = $null; $State.capped_at = 0; $State.capped_reason = $null }
      $ok = (Engine "lock") -cmatch "LOCKqz: LOCKED"
      if ($ok) { $State.applied = $true }
      $State.state="locked"; Save-Lock
      $lr = Report "lock" $null
      $out.state="locked"; $out.engine_locked=$ok
      $why = LQ-ServerReason $lr.data   # C9: this student already submitted / the quiz is over
      if ($why -and (Release-Quiz $body.quiz_id $why)) { $out.state = "unlocked"; $out.capped_quiz = $body.quiz_id; $out.capped_reason = $why }
    }
    "/unlock"    {
      $q = if ($State.quiz_id) { $State.quiz_id } else { $body.quiz_id }
      $who = Get-Requester $req
      $why = LQ-UnlockReason $body.reason $who
      $State.state="unlocked"; $State.quiz_id=$null; $State.locked_since=0; $State.applied=$false
      $ok = (Engine "unlock") -cmatch "LOCKqz: UNLOCKED"   # if not, the watcher finishes it within 5 s
      Clear-Lock
      $det = @{ reason = $why; requester = $who.kind; engine_ok = $ok }
      if ($who.name) { $det.process = $who.name }
      if (($why -eq "local_request") -and $body.reason) { $det.claimed = ([string]$body.reason).Substring(0, [Math]::Min(40, ([string]$body.reason).Length)) }
      if (($why -eq "local_request") -and $who.cmd) { $det.cmd = $who.cmd }
      Report "unlock" $det $null $q | Out-Null
      if (($why -eq "quiz_left") -or ($why -eq "quiz_tab_closed")) { Report "quiz_left" $why "agent" $q | Out-Null }
      $out.state="unlocked"; $out.engine_unlocked=$ok
    }
    "/student"   { if($body.student){$State.student=$body.student}; Report-Install; $out.student=$State.student }
    "/verify"    {
      # One-time student email setup (status | check | send | code), signed with the SYSTEM-only key
      # so an email can only ever be bound to THIS computer.
      $op = [string]$body.op
      if (@("status","check","send","code","token") -notcontains $op) { $res.StatusCode = 400; $out = @{ error = "bad op" } }
      else {
        $q = @{ op = $op; device_id = $Device }
        if ($body.email) { $em = [string]$body.email; $q.email = $em.Substring(0, [Math]::Min(200, $em.Length)) }
        if ($body.code)  { $q.code = [string]$body.code }
        if ($body.vtoken) { $vt = [string]$body.vtoken; $q.vtoken = $vt.Substring(0, [Math]::Min(100, $vt.Length)) }
        $r = LQ-Call $Api "/verify" $q $Device $Key $State $true
        $out = @{ status = $r.code }
        if ($r.data) { foreach ($pp in $r.data.PSObject.Properties) { $out[$pp.Name] = $pp.Value } }
        if ($out.verified) { $State.student = if ($out.student) { $out.student } else { $q.email } }
      }
    }
    "/heartbeat" { Report "heartbeat" $body "agent" | Out-Null }
    "/password"  {
      # The quiz password is released only to this helper, only while it holds the lock for THIS
      # quiz with the block really in place, over a request signed with the SYSTEM-only key.
      $u = [string]$body.url
      if ($State.state -ne "locked" -or $State.quiz_id -ne (Lock-Id $u)) { $res.StatusCode = 409; $out = @{ error = "not locked for this quiz" } }
      else {
        if (-not (EngineLocked)) { Engine "lock" }
        if (-not (EngineLocked)) { Report "tamper" "block_missing_at_password" $null | Out-Null; $res.StatusCode = 409; $out = @{ error = "AI block is not in place" } }
        else {
          # The signed /password call itself refreshes this device's lock row on the server (C1).
          $r = LQ-Call $Api "/password" @{ url = $u; device_id = $Device } $Device $Key $State $true
          $pw = $null; $pay = $null; $why = $null
          if ($r.data) { $pw = $r.data.password; $pay = $r.data.pay; $why = [string]$r.data.reason }
          $out = @{ password = $pw; status = $r.code; pay = $pay }
          if ($r.data -and ($null -ne $r.data.recheck)) { $out.recheck = $r.data.recheck }   # gated: next code change
          if (($r.code -eq 0) -or ($r.code -eq 502) -or ($r.code -eq 503)) { $out.error = "server_busy" }   # agent backs off
          $nowS = [int64][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
          if (($r.code -eq 200) -and $pw) {
            # C2: the server names the quiz end -> safety cap = end + 15 min (never > 24 h)
            $c = LQ-CapForEnd ([int64]$State.locked_since) (LQ-ParseIso $r.data.end) $nowS ([int64]$State.skew)
            if (($c -gt 0) -and ($State.state -eq "locked")) { $State.cap_at = $c; $State.end_known = $true; $State.max_minutes = [int](($c - [int64]$State.locked_since) / 60); Save-Lock }
            elseif (($null -eq $r.data.end) -and $State.end_known -and ($State.state -eq "locked")) {
              # No end any more (accommodation added mid-quiz / gate stopped): never shorter than the 6 h failsafe.
              $c = [Math]::Min([int64]$State.locked_since + 60 * $CapCeilMin, [Math]::Max([int64]$State.cap_at, [int64]$State.locked_since + 60 * $CapMin))
              $State.cap_at = $c; $State.end_known = $false; $State.max_minutes = [int](($c - [int64]$State.locked_since) / 60); Save-Lock
            }
            # The professor's assistive-tool allowance: only those extensions may run (browser policy now).
            if ((Set-Assist $State.quiz_id $r.data.assist) -and ($State.state -eq "locked")) { Policy-Relock }
          } elseif (($r.code -eq 403) -and ($why -eq "not started")) {
            $st = LQ-ParseIso $r.data.start
            $out.reason = $why; $out.start = $r.data.start
            $out.start_in = $(if ($st -gt 0) { [Math]::Max([int64]0, $st - ($nowS + [int64]$State.skew)) } else { $null })
          } elseif (($r.code -eq 403) -and ($why -eq "other_school")) {
            $out.reason = $why   # C10: not a LOCKqz school -> nothing to protect, AI back now
            Release-Quiz $State.quiz_id "other_school" | Out-Null
          } elseif (($r.code -eq 402) -and $why) { $out.reason = $why }
          if ((-not $pw) -and (-not $pay) -and (-not $out.reason)) { $res.StatusCode = 502 }
        }
      }
    }
    "/uncap"     {
      # The agent saw the released quiz's page closed (or a new attempt start): it may lock again.
      if ($State.capped_quiz -and ([string]$State.capped_quiz -eq [string]$body.quiz_id)) { $State.capped_quiz = $null; $State.capped_at = 0; $State.capped_reason = $null }
    }
    "/event"     { if ($body.event -eq "quiz_left") { Report "quiz_left" $body.detail "agent" $body.quiz_id | Out-Null } else { $res.StatusCode = 400; $out = @{ error = "event not allowed" } } }
    "/status"    {
      $out = @{ state=$State.state; quiz_id=$State.quiz_id; student=$State.student; engine_locked=(HostsLocked); version=$Version; cap_at=$State.cap_at; end_known=$State.end_known; capped_quiz=$null; capped_reason=$null; capped_at=0 }
      # a quiz the safety cap or the server released within 24 h: the agent must not re-lock it
      if ($State.capped_quiz -and (([int64][DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [int64]$State.capped_at) -lt $CapForget)) { $out.capped_quiz = $State.capped_quiz; $out.capped_reason = $State.capped_reason; $out.capped_at = [int64]$State.capped_at }
    }
    default      { $res.StatusCode = 404; $out = @{ error="not found" } }
  }
  $json = ($out | ConvertTo-Json -Compress)
  $buf = [Text.Encoding]::UTF8.GetBytes($json)
  $res.ContentType = "application/json"; $res.OutputStream.Write($buf,0,$buf.Length); $res.Close()
}
