#!/usr/bin/env python3
"""Build the signed release that installed helpers update themselves from.

    python3 make-manifest.py --key <private.pem> --out <public/download dir>

Copies the Mac and Windows helper files into <out>/mac and <out>/windows, writes a compact
<out>/update.json  {"version","mac":{"files":{name:sha256}},"windows":{"files":{...}}}
and <out>/update.sig (RSA-SHA256, PKCS#1 v1.5, base64 of the signature over the exact bytes of
update.json). The helpers verify the signature with the public key shipped in the install, then
each file's SHA-256, before swapping anything in. Run by CI on every push to main.
The version comes from app/VERSION and must equal the VERSION constant in both daemons.
"""
import argparse, base64, hashlib, json, os, re, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
MAC_FILES = ["lockqz.sh", "lockqz-core.sh", "extra-block.sh", "lockqzd.py", "lockqz-agent.py",
             "browser-policy.py", "blocklist.txt", "com.lockqz.pf.conf", "ensure-python.sh",
             "lockqz-boot.sh", "install.sh", "uninstall.sh", "update.pub"]
WIN_FILES = ["lockqz.ps1", "lockqzd.ps1", "blocklist.txt", "browser-policy.ps1", "lockqz-agent.ps1",
             "install.ps1", "uninstall.ps1", "update.pub.xml"]

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
    a = ap.parse_args()
    v = version(a.version)
    files = {}
    for plat, src, names in (("mac", a.mac, MAC_FILES), ("windows", a.windows, WIN_FILES)):
        d = os.path.join(a.out, plat)
        shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
        files[plat] = {}
        for n in names:
            shutil.copy2(os.path.join(src, n), os.path.join(d, n))
            files[plat][n] = sha(os.path.join(d, n))
    m = {"version": v, "mac": {"files": files["mac"]}, "windows": {"files": files["windows"]}}
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
    print("release %s: %d mac files, %d windows files -> %s" % (v, len(files["mac"]), len(files["windows"]), a.out))

if __name__ == "__main__":
    main()
