# Programs that hide their windows from screen capture are closed during a quiz - for real on Windows (GitHub's Windows
# runner, Windows PowerShell 5.1 like students). The agent's own functions find a window another process hid with
# SetWindowDisplayAffinity, and close that process; a normal window and a name on the never-close list stay open.
# Not part of run_all (it needs a Windows desktop).
param([string]$Out = "$env:TEMP\lqz-hidden")
$ErrorActionPreference = "Stop"
$Win = Join-Path $PSScriptRoot "..\windows"
$pass = 0; $fail = 0
function Check($m, $c) { if ($c) { $script:pass++; Write-Host "  ok: $m" } else { $script:fail++; Write-Host "  FAIL: $m" } }
function Log($m) { Write-Host "    agent: $m" }
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Win "lockqz-agent.ps1"), [ref]$null, [ref]$null)
foreach ($s in $ast.EndBlock.Statements) {
  if (($s -is [System.Management.Automation.Language.FunctionDefinitionAst] -and @("Get-HiddenPids", "Read-KeepApps", "Keep-Hidden", "Close-HiddenApps", "Signer-Kept") -contains $s.Name) -or
      ($s -is [System.Management.Automation.Language.AssignmentStatementAst] -and @('$KeepApps', '$KeepSigners', '$SignerCache', '$HiddenNoClose') -contains $s.Left.Extent.Text)) { . ([ScriptBlock]::Create($s.Extent.Text)) }
}
New-Item -ItemType Directory -Force -Path $Out | Out-Null

# A tiny program with one window far off screen: hidden from capture (WDA_EXCLUDEFROMCAPTURE, or WDA_MONITOR on an
# older Windows), or a normal one when started with "shown". It quits by itself after 90 s.
$src = @'
using System; using System.Windows.Forms; using System.Runtime.InteropServices;
public static class LqTestWindow {
  [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr h, uint a);
  [STAThread] public static void Main(string[] a) {
    Form f = new Form(); f.StartPosition = FormStartPosition.Manual; f.Location = new System.Drawing.Point(-4000, -4000);
    f.Size = new System.Drawing.Size(60, 60); f.ShowInTaskbar = false;
    bool hide = !(a.Length > 0 && a[0] == "shown");
    f.Load += delegate { if (hide && !SetWindowDisplayAffinity(f.Handle, 0x11)) SetWindowDisplayAffinity(f.Handle, 1); };
    Timer t = new Timer(); t.Interval = 90000; t.Tick += delegate { Application.Exit(); }; t.Start();
    Application.Run(f);
  }
}
'@
$exe = Join-Path $Out "LQHiddenTest.exe"
Add-Type -TypeDefinition $src -ReferencedAssemblies System.Windows.Forms, System.Drawing -OutputAssembly $exe -OutputType WindowsApplication
Copy-Item $exe (Join-Path $Out "LQShownTest.exe") -Force; Copy-Item $exe (Join-Path $Out "KeptByServer.exe") -Force
$h = Start-Process $exe -PassThru
$s = Start-Process (Join-Path $Out "LQShownTest.exe") -ArgumentList "shown" -PassThru
$k = Start-Process (Join-Path $Out "KeptByServer.exe") -PassThru
Start-Sleep -Seconds 4

$t0 = Get-Date
$ids = @(Get-HiddenPids | ForEach-Object { [int]$_ })
Write-Host ("  window list: " + (($ids | ForEach-Object { $p = Get-Process -Id $_ -ErrorAction SilentlyContinue; "$_=$($p.ProcessName)" }) -join ", ") + ("  ({0:N0} ms)" -f ((Get-Date) - $t0).TotalMilliseconds))
Check "a window hidden from capture is found in another process" ($ids -contains $h.Id)
Check "a normal window is not" ($ids -notcontains $s.Id)
[IO.File]::WriteAllText((Join-Path $Out "keep.txt"), "KeptByServer`n")
$closed = @(Close-HiddenApps (Read-KeepApps (Join-Path $Out "keep.txt")))
Check "the program with the hidden window is closed" ($h.WaitForExit(5000) -and ($closed -contains "LQHiddenTest"))
Check "the normal one and a name the server added stay open" ((-not $s.HasExited) -and (-not $k.HasExited) -and ($closed -notcontains "KeptByServer"))
Check "nothing else on this computer was closed" (@($closed | Where-Object { $_ -ne "LQHiddenTest" }).Count -eq 0)
Check "a Microsoft-signed program counts as Windows' own; the unsigned test program does not" (((Signer-Kept "$env:WINDIR\System32\notepad.exe") -or (Signer-Kept "$env:WINDIR\explorer.exe")) -and -not (Signer-Kept $exe))
foreach ($p in @($s, $k)) { try { if (-not $p.HasExited) { $p.Kill() } } catch { } }

Write-Host ""
Write-Host "RESULT: $pass passed, $fail failed"
if ($fail) { exit 1 }
exit 0
