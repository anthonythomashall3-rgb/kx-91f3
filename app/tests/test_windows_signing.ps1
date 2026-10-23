# Windows device signing: loads the REAL signing code from windows/lockqzd.ps1 and proves
# (1) both Windows scripts parse, (2) the HMAC matches the shared vector used by the server and
# the Mac helper, (3) against a mock server that verifies signatures exactly like the real API,
# the Windows code registers its key, signs a lock, recovers from a PC clock 15 minutes off, and
# gets the password only while locked. Runs on PowerShell 5.1 (Windows) or 7 (any OS).
param([int]$Port = 8921)
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Win = Join-Path $Here "..\windows"
$pass = 0; $fail = 0
function Check($name, $cond) { if ($cond) { $script:pass++; Write-Host "  ok: $name" } else { $script:fail++; Write-Host "  FAIL: $name" } }

Write-Host "T1 both Windows scripts parse"
foreach ($f in "lockqzd.ps1", "lockqz-agent.ps1") {
  $errs = $null; [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Win $f), [ref]$null, [ref]$errs)
  Check "parses: $f" ($errs.Count -eq 0)
}

Write-Host "T2 the signing code matches the shared vector"
$src = Get-Content (Join-Path $Win "lockqzd.ps1") -Raw
$m = [regex]::Match($src, "(?s)\`$SignLib = @'\r?\n(.*?)\r?\n'@")
Check "SignLib found in lockqzd.ps1" $m.Success
. ([ScriptBlock]::Create($m.Groups[1].Value))
$sig = LQ-Sign ("00" * 32) "/api/report" "1700000000" ([Text.Encoding]::UTF8.GetBytes('{"a":1}'))
Check "HMAC vector" ($sig -eq "9f569120c07099a12759105ba726aa27111277be70b407d718a8ff0013400111")

Write-Host "T3 register, signed lock, clock fix, password only while locked (mock server)"
$py = (Get-Command python3 -ErrorAction SilentlyContinue)
if (-not $py) { $py = (Get-Command python -ErrorAction SilentlyContinue) }
if (-not $py) { Write-Host "  (skipped: no python for the mock server)" }
else {
  $mock = Join-Path ([IO.Path]::GetTempPath()) ("lqz-mock-" + [guid]::NewGuid().ToString("N") + ".py")
  @'
import sys, json, time, hmac, hashlib, re
from http.server import BaseHTTPRequestHandler, HTTPServer
PORT, SKEW = int(sys.argv[1]), float(sys.argv[2])
KEYS, LOCKS = {}, {}
def now(): return time.time() + SKEW
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def reply(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0) or 0)); b = json.loads(raw or b"{}")
        if self.path.endswith("/register"):
            KEYS.setdefault(b["device_id"], b["key"]); return self.reply(200 if KEYS[b["device_id"]] == b["key"] else 409, {"ok": True})
        dev, ts, sig = self.headers.get("X-LOCKqz-Device"), self.headers.get("X-LOCKqz-Time"), self.headers.get("X-LOCKqz-Sig")
        why = "ok"
        if not (dev and ts and sig): why = "unsigned"
        elif abs(now() - float(ts)) > 300: why = "clock"
        elif dev not in KEYS: why = "unregistered"
        else:
            msg = "POST\n%s\n%s\n%s" % (self.path, ts, hashlib.sha256(raw).hexdigest())
            if not hmac.compare_digest(hmac.new(KEYS[dev].encode(), msg.encode(), hashlib.sha256).hexdigest(), sig): why = "bad signature"
        if why != "ok": return self.reply(401, {"why": why, "server_time": int(now())})
        if self.path.endswith("/report"):
            if b.get("event") == "lock": LOCKS[(dev, b.get("quiz_id"))] = now()
            return self.reply(200, {"ok": True})
        u = b.get("url", ""); qi = re.search(r"qi=(\d+)", u); ou = re.search(r"ou=(\d+)", u)
        lid = "%s-%s" % (ou.group(1) if ou else "x", qi.group(1) if qi else "x")
        t = LOCKS.get((dev, lid))
        return self.reply(200, {"password": "LQ-WINPASS"}) if t and now() - t < 60 else self.reply(403, {"password": None})
HTTPServer(("127.0.0.1", PORT), H).serve_forever()
'@ | Set-Content -Path $mock -Encoding ASCII
  $sp = @{ FilePath = $py.Source; ArgumentList = @($mock, $Port, 900); PassThru = $true }
  if ($PSVersionTable.PSEdition -ne "Core" -or $IsWindows) { $sp.WindowStyle = "Hidden" }
  $proc = Start-Process @sp
  Start-Sleep -Seconds 2
  try {
    $api = "http://127.0.0.1:$Port/api"; $dev = "win-test-device-0001"
    $key = LQ-Hex ([byte[]](1..32))
    $state = [hashtable]::Synchronized(@{ skew = 0; registered = $false; student = "s@usc.edu" })
    Check "registers its key" (LQ-Register $api $dev $key $state)
    $url = "https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?ou=98765&qi=12345"
    $r = LQ-Call $api "/password" @{ url = $url; device_id = $dev } $dev $key $state $true
    Check "no password before a lock (403)" ($r.code -eq 403)
    Check "learned the server clock (skew ~900 s)" ([math]::Abs([int64]$state.skew - 900) -le 5)
    $r = LQ-Call $api "/report" @{ device_id = $dev; event = "lock"; quiz_id = "98765-12345" } $dev $key $state $true
    Check "signed lock accepted" ($r.code -eq 200)
    $r = LQ-Call $api "/password" @{ url = $url; device_id = $dev } $dev $key $state $true
    Check "password while locked" ($r.data.password -eq "LQ-WINPASS")
    $r = LQ-Call $api "/password" @{ url = $url; device_id = $dev } $dev ("ab" * 32) $state $true
    Check "wrong key refused (401)" ($r.code -eq 401)
  } finally { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; Remove-Item $mock -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host "RESULT: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
