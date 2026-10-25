# LOCKqz helper start wrapper (the "LOCKqz" task runs this). Runs lockqzd.ps1 in this same process,
# so stopping the task stops the helper.
# Self-update rollback: a signed update leaves .pending (+ the replaced files in .prev\). The new
# helper removes .pending once its control server answers /status. If it still has not after 3
# starts, the update is put back to the previous files and that version is never installed again
# (.bad_version); the next release updates normally. Kept small and plain on purpose: it must keep
# working whatever a release does to the other files.
param([switch]$RollbackCheck)
$ErrorActionPreference = "SilentlyContinue"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$MaxStarts = if ($env:LQ_MAX_STARTS) { [int]$env:LQ_MAX_STARTS } else { 3 }

function LQ-Rollback {
  $prev = Join-Path $Here ".prev"; $pend = Join-Path $Here ".pending"
  $to = ""
  foreach ($l in @(Get-Content $pend)) { if ($l -match '^to=([0-9A-Za-z.]+)$') { $to = $Matches[1] } }
  if (Test-Path -LiteralPath $prev -PathType Container) {
    foreach ($n in @(Get-Content (Join-Path $prev ".added"))) {
      $n = ([string]$n).Trim()
      if ($n -match '^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$') { Remove-Item -LiteralPath (Join-Path $Here $n) -Force }
    }
    foreach ($f in @(Get-ChildItem -LiteralPath $prev -File | Where-Object { -not $_.Name.StartsWith(".") })) {
      Copy-Item -LiteralPath $f.FullName (Join-Path $Here $f.Name) -Force
    }
  }
  if ($to) { [IO.File]::WriteAllText((Join-Path $Here ".bad_version"), $to) }
  Remove-Item -LiteralPath $prev -Recurse -Force
  Remove-Item -LiteralPath $pend -Force
  Write-Host "LOCKqz: update $to did not start - rolled back to the previous version"
}

function LQ-CountStart {
  # -> $true when this start may run the code as it is, $false when it must roll back first
  $pend = Join-Path $Here ".pending"
  if (-not (Test-Path -LiteralPath $pend -PathType Leaf)) { return $true }
  $lines = @(Get-Content $pend); $n = 0
  foreach ($l in $lines) { if ($l -match '^starts=(\d+)$') { $n = [int]$Matches[1] } }
  $n++
  if ($n -gt $MaxStarts) { return $false }
  $keep = @($lines | Where-Object { $_ -notmatch '^starts=' })
  [IO.File]::WriteAllText($pend, ((@($keep) + "starts=$n") -join "`r`n") + "`r`n")
  return $true
}

try { if (-not (LQ-CountStart)) { LQ-Rollback } } catch { Write-Host "LOCKqz: rollback check failed: $_" }
if ($RollbackCheck) { exit 0 }   # tests
& (Join-Path $Here "lockqzd.ps1")
exit 1   # the helper never returns on its own; the task's repetition starts it again
