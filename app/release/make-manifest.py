#!/usr/bin/env python3
"""Build the signed release that installed helpers update themselves from.

    python3 make-manifest.py --key <private.pem> --out <public/download dir>

Copies the Mac and Windows helper files into <out>/mac and <out>/windows, writes a compact
<out>/update.json  {"version","mac":{"files":{name:sha256}},"windows":{"files":{...}}}
and <out>/update.sig (RSA-SHA256, PKCS#1 v1.5, base64 of the signature over the exact bytes of
update.json). The helpers verify the signature with the public key shipped in the install, then
each file's SHA-256, before swapping anything in. Run by CI on every push to main.
The version comes from app/VERSION and must equal the VERSION constant in both daemons.

Release-candidate checks (the build refuses to sign when one fails):
  * every Mac .py compiles on Apple's Command Line Tools python 3.9 (python3.9 -m py_compile when a
    python3.9 is found - LOCKQZ_PY39 or PATH - else an AST check for 3.10+ syntax);
  * every Windows .ps1 is plain ASCII (Windows PowerShell 5.1 misreads UTF-8 without a BOM) and parses
    (pwsh/powershell when found - LOCKQZ_PWSH or PATH);
  * E10: against the LIVE update.json (--live, default the production site): a file that changed while
    the version did not, or an older version than the live one, is refused (installed helpers would
    never pick the change up). --live none skips this (tests only).
"""
import argparse, ast, base64, hashlib, json, os, re, shutil, subprocess, sys, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
MAC_FILES = ["lockqz.sh", "lockqz-core.sh", "extra-block.sh", "lockqzd.py", "lockqz-agent.py",
             "browser-policy.py", "blocklist.txt", "com.lockqz.pf.conf", "ensure-python.sh",
             "lockqz-boot.sh", "install.sh", "uninstall.sh", "update.pub"]
WIN_FILES = ["lockqz.ps1", "lockqzd.ps1", "lockqz-boot.ps1", "blocklist.txt", "browser-policy.ps1", "lockqz-agent.ps1",
             "install.ps1", "uninstall.ps1", "update.pub.xml"]
# Linux (28 Oct 2026): its own engine/agent/policy writer + the shared Mac files under their installed names.
LINUX_FILES = {"lockqz.sh": "linux/lockqz.sh", "lockqz-agent.py": "linux/lockqz-agent.py", "browser-policy.py": "linux/browser-policy.py",
               "install.sh": "linux/install.sh", "uninstall.sh": "linux/uninstall.sh",
               "lockqzd.py": "mac/lockqzd.py", "agent-mac.py": "mac/lockqz-agent.py", "policy-mac.py": "mac/browser-policy.py",
               "lockqz-core.sh": "mac/lockqz-core.sh", "blocklist.txt": "mac/blocklist.txt", "update.pub": "mac/update.pub"}
LIVE_DEFAULT = "https://lockqz.pages.dev/download/update.json"

def _which(names):
    for n in names:
        if not n: continue
        if os.path.isabs(n) and os.access(n, os.X_OK): return n
        for d in os.environ.get("PATH", "").split(os.pathsep):
            c = os.path.join(d, n)
            if os.access(c, os.X_OK): return c
    return None

def py39_problems(src, name):
    """3.10+ syntax that python 3.9 would refuse, found without a 3.9 interpreter."""
    try: tree = ast.parse(src, name, feature_version=(3, 9))
    except SyntaxError as e: return ["%s: %s (line %s)" % (name, e.msg, e.lineno)]
    out = []
    for node in ast.walk(tree):
        if type(node).__name__ in ("Match", "TryStar", "TypeAlias"):
            out.append("%s:%d: %s statement needs python >= 3.10" % (name, node.lineno, type(node).__name__))
        anns = []
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            anns = [a.annotation for a in node.args.args + node.args.kwonlyargs if a.annotation] + ([node.returns] if node.returns else [])
        elif isinstance(node, ast.AnnAssign): anns = [node.annotation]
        for a in anns:
            if any(isinstance(n, ast.BinOp) and isinstance(n.op, ast.BitOr) for n in ast.walk(a)):
                out.append("%s:%d: 'X | Y' type annotation fails on python 3.9" % (name, node.lineno))
    return out

def candidate_problems(mac, win):
    """Release-candidate checks; -> list of problems (empty = OK)."""
    probs = []
    py39 = _which([os.environ.get("LOCKQZ_PY39"), "python3.9"])
    for n in MAC_FILES:
        if not n.endswith(".py"): continue
        p = os.path.join(mac, n)
        src = open(p, encoding="utf-8").read()
        probs += py39_problems(src, n)
        if py39:
            r = subprocess.run([py39, "-c", "import sys; compile(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1], 'exec')", p],
                               capture_output=True, text=True)
            if r.returncode: probs.append("%s does not compile on python 3.9: %s" % (n, (r.stderr.strip().splitlines() or ["?"])[-1]))
    if not py39: print("note: no python3.9 found - Mac python checked by AST only (set LOCKQZ_PY39)")
    pwsh = _which([os.environ.get("LOCKQZ_PWSH"), "pwsh", "powershell"])
    for n in WIN_FILES:
        if not n.endswith(".ps1"): continue
        p = os.path.join(win, n)
        raw = open(p, "rb").read()
        bad = [i for i, b in enumerate(raw) if b > 127]
        if bad: probs.append("%s has non-ASCII bytes (first at byte %d) - Windows PowerShell 5.1 misreads them" % (n, bad[0]))
        if pwsh:
            q = os.path.abspath(p).replace("'", "''")
            r = subprocess.run([pwsh, "-NoProfile", "-Command",
                                "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('%s',[ref]$null,[ref]$e); if ($e) { $e | ForEach-Object { $_.ToString() }; exit 1 }" % q],
                               capture_output=True, text=True)
            if r.returncode: probs.append("%s does not parse: %s" % (n, (r.stdout.strip() or r.stderr.strip())[:300]))
    if not pwsh: print("note: no pwsh/powershell found - .ps1 files not parse-checked (set LOCKQZ_PWSH)")
    return probs

def _vt(v): return tuple(int(x) for x in re.findall(r"\d+", str(v))[:3]) or (0,)

def live_problems(live, version, files):
    """E10: compare with the release installed helpers see now. -> list of problems."""
    if live in (None, "", "none"): return []
    try:
        if re.match(r"^https?://", live):
            req = urllib.request.Request(live, headers={"User-Agent": "LOCKqz-release"})
            raw = urllib.request.urlopen(req, timeout=20).read()
        else:
            raw = open(live, "rb").read()
    except urllib.error.HTTPError as e:
        if e.code == 404: return []   # nothing published yet
        return ["cannot read the live release %s (HTTP %s) - pass --live none to skip" % (live, e.code)]
    except FileNotFoundError:
        return []
    except Exception as e:
        return ["cannot read the live release %s (%s) - pass --live none to skip" % (live, e)]
    m = json.loads(raw)
    lv = str(m.get("version", ""))
    if _vt(version) < _vt(lv): return ["version %s is OLDER than the live %s" % (version, lv)]
    if _vt(version) > _vt(lv): return []
    changed = []
    for plat in ("mac", "windows", "linux"):
        old = (m.get(plat) or {}).get("files") or {}
        if plat == "linux" and not old: continue   # first Linux release: nothing live to compare with
        for n in sorted(set(old) | set(files[plat])):
            if old.get(n) != files[plat].get(n): changed.append("%s/%s" % (plat, n))
    if changed:
        return ["files changed but the version is still %s (bump app/VERSION and both daemons): %s" % (version, ", ".join(changed))]
    return []

def sha(p):
    with open(p, "rb") as f: return hashlib.sha256(f.read()).hexdigest()

def version(override=None):
    if override: return override   # tests only
    v = open(os.path.join(APP, "VERSION")).read().strip()
    assert re.fullmatch(r"\d+\.\d+\.\d+", v), "app/VERSION must be X.Y.Z"
    for f, pat in (("mac/lockqzd.py", r'^VERSION = "([^"]+)"'), ("windows/lockqzd.ps1", r'^\$Version\s*=\s*"([^"]+)"')):
        m = re.search(pat, open(os.path.join(APP, f)).read(), re.M)
        assert m and m.group(1) == v, "%s says %s, app/VERSION says %s" % (f, m.group(1) if m else None, v)
    return v

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", required=True, help="RSA private key (PEM) - the release-signing key")
    ap.add_argument("--out", required=True, help="output folder (served as <site>/download)")
    ap.add_argument("--mac", default=os.path.join(APP, "mac"))
    ap.add_argument("--windows", default=os.path.join(APP, "windows"))
    ap.add_argument("--pub", default=None, help="public key to self-check and ship (default mac/update.pub)")
    ap.add_argument("--version", default=None, help="tests only: override app/VERSION")
    ap.add_argument("--live", default=LIVE_DEFAULT, help="live update.json (URL or file) to compare with; 'none' = skip (tests)")
    a = ap.parse_args()
    v = version(a.version)
    probs = candidate_problems(a.mac, a.windows)
    if probs: sys.exit("release refused:\n  " + "\n  ".join(probs))
    srcs = (("mac", a.mac, MAC_FILES), ("windows", a.windows, WIN_FILES))
    files = {plat: {n: sha(os.path.join(src, n)) for n in names} for plat, src, names in srcs}
    linux_src = {n: os.path.join(APP, rel) for n, rel in LINUX_FILES.items()}
    files["linux"] = {n: sha(p) for n, p in linux_src.items()}
    probs = live_problems(a.live, v, files)   # checked BEFORE anything is written to --out
    if probs: sys.exit("release refused:\n  " + "\n  ".join(probs))
    for plat, src, names in srcs:
        d = os.path.join(a.out, plat)
        shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
        for n in names:
            shutil.copy2(os.path.join(src, n), os.path.join(d, n))
            assert sha(os.path.join(d, n)) == files[plat][n], "copy of %s changed" % n
    d = os.path.join(a.out, "linux")
    shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    for n, p in linux_src.items():
        shutil.copy2(p, os.path.join(d, n))
        assert sha(os.path.join(d, n)) == files["linux"][n], "copy of linux/%s changed" % n
    m = {"version": v, "mac": {"files": files["mac"]}, "windows": {"files": files["windows"]}, "linux": {"files": files["linux"]}}
    body = json.dumps(m, sort_keys=True, separators=(",", ":")).encode()
    jp, sp = os.path.join(a.out, "update.json"), os.path.join(a.out, "update.sig")
    with open(jp, "wb") as f: f.write(body)
    sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", a.key, jp], capture_output=True, check=True).stdout
    with open(sp, "w") as f: f.write(base64.b64encode(sig).decode())
    # Self-check with the public key that ships in the install.
    pub = a.pub or os.path.join(a.mac, "update.pub")
    rawsig = sp + ".bin"
    with open(rawsig, "wb") as f: f.write(sig)
    r = subprocess.run(["openssl", "dgst", "-sha256", "-verify", pub, "-signature", rawsig, jp], capture_output=True, text=True)
    os.remove(rawsig)
    if r.returncode != 0 or "Verified OK" not in r.stdout:
        sys.exit("release signature does not verify with mac/update.pub - wrong key?")
    shutil.copy2(pub, os.path.join(a.out, "update.pub"))
    print("release %s: %d mac files, %d windows files, %d linux files -> %s" % (v, len(files["mac"]), len(files["windows"]), len(files["linux"]), a.out))

if __name__ == "__main__":
    main()
