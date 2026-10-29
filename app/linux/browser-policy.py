#!/usr/bin/env python3
"""LOCKqz browser policy (Linux). Same policies as the Mac (policy-mac.py = app/mac/browser-policy.py,
installed next to this file: one source of truth for the Chromium / Firefox policy content), written as
the managed-policy files Linux browsers read:
  * Chrome, Chromium (deb + snap), Edge, Brave, Vivaldi, Opera: <etc dir>/policies/managed/zz-lockqz.json
    (the alphabetically last file wins for any key another file also sets)
  * Firefox family (deb, snap, distribution builds): policies.json (an existing one is backed up, merged
    with ours, and put back exactly at unlock)
Applied only while a quiz is locked; removed at unlock.

    browser-policy.py lock | unlock | status
    browser-policy.py resolve <blocklist> <out>   # warm connections: every host's addresses, past /etc/hosts
"""
import hashlib, importlib.util, json, os, random, re, socket, struct, sys, time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.environ.get("LOCKQZ_STATE") or "/var/lib/lockqz"
BACKUP = os.environ.get("LOCKQZ_POLICY_BACKUP") or os.path.join(STATE, "policy-backup")
ROOT = os.environ.get("LOCKQZ_POLICY_ROOT") or ""      # tests: prefix for every policy path
os.environ.setdefault("LOCKQZ_POLICY_DIR", os.path.join(STATE, "unused-managed-prefs"))
os.environ.setdefault("LOCKQZ_POLICY_BACKUP", BACKUP)
os.environ.setdefault("LOCKQZ_BLOCKLIST", os.path.join(HERE, "blocklist.txt"))
os.environ.setdefault("LOCKQZ_ASSIST_FILE", os.path.join(STATE, "assist.json"))
os.environ.setdefault("LOCKQZ_PROXY_KEPT", os.path.join(STATE, "proxy.kept"))

def _mac():
    p = os.path.join(HERE, "policy-mac.py")
    spec = importlib.util.spec_from_file_location("lockqz_policy_mac", p)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m

# (etc dir, policy id the shared module branches on)
CHROMIUM_DIRS = [("/etc/opt/chrome", "com.google.Chrome"), ("/etc/chromium", "org.chromium.Chromium"),
                 ("/etc/chromium-browser", "org.chromium.Chromium"), ("/etc/opt/edge", "com.microsoft.Edge"),
                 ("/etc/brave", "com.brave.Browser"), ("/etc/vivaldi", "com.vivaldi.Vivaldi"), ("/etc/opera", "com.operasoftware.Opera")]
FIREFOX_FILES = ["/etc/firefox/policies/policies.json", "/usr/lib/firefox/distribution/policies.json",
                 "/usr/lib64/firefox/distribution/policies.json", "/usr/lib/firefox-esr/distribution/policies.json",
                 "/opt/firefox/distribution/policies.json", "/usr/lib/librewolf/distribution/policies.json",
                 "/etc/librewolf/policies/policies.json", "/usr/lib/waterfox/distribution/policies.json",
                 "/usr/lib/floorp/distribution/policies.json", "/opt/zen/distribution/policies.json"]
OURS = "zz-lockqz.json"

def P(p): return ROOT + p if ROOT else p

def _atomic(path, text):
    d = os.path.dirname(path); os.makedirs(d, exist_ok=True)
    try:   # unchanged content is not rewritten (the lock loop runs every 5 s; browsers reload policy on change)
        with open(path) as f:
            if f.read() == text: return
    except Exception: pass
    tmp = path + ".lockqz.tmp"
    with open(tmp, "w") as f: f.write(text)
    os.chmod(tmp, 0o644); os.replace(tmp, path)

def _read(path):
    try:
        with open(path) as f: return json.load(f)
    except Exception: return None

def chromium_targets():
    # Every Chromium-family policy dir (snap Chromium reads /etc/chromium through its plug, Brave's and Edge's
    # packages never create theirs): written whether or not the browser is installed - a file in an unused dir
    # is harmless and a browser installed mid-quiz is covered.
    return [(os.path.join(P(d), "policies", "managed", OURS), pid) for d, pid in CHROMIUM_DIRS]

def firefox_targets():
    out = []
    for f in FIREFOX_FILES:
        p = P(f)
        parent = os.path.dirname(os.path.dirname(p))   # /etc/firefox, /usr/lib/firefox ...
        if f.startswith("/etc/firefox") or os.path.isdir(parent): out.append(p)
    return out

def _bkey(p): return hashlib.sha256(p.encode()).hexdigest()[:16] + ".json"

def lock():
    m = _mac(); failed = False
    extra, hosts = m.path_entries(), m.host_entries()
    for path, pid in chromium_targets():
        pol = m.chromium_policy(pid)
        pol["URLBlocklist"] = m._union(pol["URLBlocklist"], extra + hosts)
        pol["IncognitoModeAvailability"] = 1      # no incognito: the session file cannot see those tabs
        pol["BrowserGuestModeEnabled"] = False
        pol["BrowserAddPersonEnabled"] = False
        pol["BuiltInDnsClientEnabled"] = False    # system resolver only (/etc/hosts + the stub rule)
        try: _atomic(path, json.dumps(pol, indent=1, sort_keys=True))
        except Exception as e: failed = True; print("LOCKqz policy: %s: %s" % (path, e), file=sys.stderr)
    ff = m.firefox_policy()
    ff["DisablePrivateBrowsing"] = True           # private windows are not in the session store
    ff["WebsiteFilter"]["Block"] = m._union(ff["WebsiteFilter"]["Block"],
        [p for e in extra for p in ("*://%s*" % e, "*://*.%s*" % e)] + ["*://*.%s/*" % h for h in hosts])
    os.makedirs(BACKUP, exist_ok=True)
    for path in firefox_targets():
        try:
            cur = _read(path)
            bk = os.path.join(BACKUP, "firefox-" + _bkey(path))
            if cur is not None and not (cur.get("policies") or {}).get(m.MARK) and not os.path.exists(bk):
                with open(bk, "w") as f: json.dump(cur, f)          # the student's / distro's own file, kept exactly
            base = (cur or {}).get("policies") or {}
            if base.get(m.MARK): base = (_read(bk) or {}).get("policies") or {} if os.path.exists(bk) else {}
            merged = m.merge_firefox(dict(base), dict(ff))
            _atomic(path, json.dumps({"policies": merged}, indent=1, sort_keys=True))
        except Exception as e: failed = True; print("LOCKqz policy: %s: %s" % (path, e), file=sys.stderr)
    return not failed

def unlock():
    m = _mac(); failed = False
    for path, _ in chromium_targets():
        try:
            if os.path.exists(path): os.unlink(path)
        except Exception as e: failed = True; print("LOCKqz policy: %s: %s" % (path, e), file=sys.stderr)
    for path in firefox_targets():
        try:
            cur = _read(path)
            if cur is None or not (cur.get("policies") or {}).get(m.MARK): continue
            bk = os.path.join(BACKUP, "firefox-" + _bkey(path))
            if os.path.exists(bk):
                with open(bk) as f: _atomic(path, f.read())
                os.unlink(bk)
            else: os.unlink(path)
        except Exception as e: failed = True; print("LOCKqz policy: %s: %s" % (path, e), file=sys.stderr)
    return not failed

def status():
    on = [p for p, _ in chromium_targets() if os.path.exists(p)]
    m = _mac()
    on += [p for p in firefox_targets() if ((_read(p) or {}).get("policies") or {}).get(m.MARK)]
    print("locked" if on else "unlocked"); return 0

# ---------- resolver for the warm-connection list (raw DNS, past /etc/hosts) ----------
# API-only AI endpoints: their addresses (minus any address an allow host uses) go to <out>.api and are dropped
# outright by the engine, so a client that never asks DNS (curl --resolve, own DoH) gets no connection either.
API_HOSTS = ['api.openai.com', 'api.anthropic.com', 'api.x.ai', 'api.deepseek.com', 'api.mistral.ai', 'api.groq.com', 'openrouter.ai', 'api.together.xyz', 'api.together.ai', 'api.perplexity.ai', 'api.cohere.com', 'api.cohere.ai', 'api.fireworks.ai', 'api.replicate.com', 'router.huggingface.co', 'api-inference.huggingface.co', 'api.cerebras.ai', 'api.sambanova.ai', 'api.deepinfra.com', 'api.hyperbolic.xyz', 'api.novita.ai', 'api.moonshot.cn', 'api.moonshot.ai', 'open.bigmodel.cn', 'api.minimax.chat', 'api.minimaxi.com', 'api.ai21.com', 'api.voyageai.com', 'api.siliconflow.cn', 'api.siliconflow.com', 'api.lepton.ai', 'api.baseten.co', 'api.friendli.ai', 'api.nebius.com', 'api.studio.nebius.ai', 'api.kimi.com']
ALLOW_HOSTS = ['lockqz.pages.dev', 'usc.brightspace.com', 'brightspace.com', 's.brightspace.com', 'content-cdn.brightspace.com', 'd2l.com', 'www.d2l.com', 'lms.usc.edu', 'google.com', 'www.google.com', 'docs.google.com', 'drive.google.com', 'accounts.google.com', 'login.microsoftonline.com', 'outlook.office.com', 'www.office.com', 'shibboleth.usc.edu', 'my.usc.edu', 'www.usc.edu', 'cloudflare.com', 'challenges.cloudflare.com', 'static.cloudflareinsights.com']
PRIVATE = re.compile(r"^(0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|::1$|fe80:|fc|fd)")
def upstream_servers():
    srv = []
    try:
        for l in open("/etc/resolv.conf"):
            p = l.split()
            if len(p) >= 2 and p[0] == "nameserver": srv.append(p[1])
    except Exception: pass
    if any(s.startswith("127.0.0.53") or s == "127.0.0.54" for s in srv) or not srv:
        try:
            import subprocess
            out = subprocess.run(["resolvectl", "status"], capture_output=True, text=True, timeout=10).stdout
            for l in out.splitlines():
                l = l.strip()
                if l.startswith(("DNS Servers:", "Current DNS Server:")):
                    srv = [x.split("#")[0].split("%")[0] for x in l.split(":", 1)[1].split()] + srv
        except Exception: pass
    srv = [s for s in srv if s and not s.startswith("127.0.0.5") and not s.startswith("::1")]
    return srv or ["1.1.1.1", "8.8.8.8"]

def _query(name, qtype, server, timeout=2.0):
    qid = random.randint(0, 65535)
    q = struct.pack(">HHHHHH", qid, 0x0100, 1, 0, 0, 0)
    for part in name.strip(".").split("."): q += bytes([len(part)]) + part.encode()
    q += b"\0" + struct.pack(">HH", qtype, 1)
    fam = socket.AF_INET6 if ":" in server else socket.AF_INET
    s = socket.socket(fam, socket.SOCK_DGRAM); s.settimeout(timeout)
    try:
        s.sendto(q, (server, 53)); data, _ = s.recvfrom(4096)
    finally: s.close()
    if len(data) < 12 or struct.unpack(">H", data[:2])[0] != qid: return []
    qd, an = struct.unpack(">HH", data[4:8])
    off = 12
    def skip_name(o):
        while True:
            l = data[o]
            if l == 0: return o + 1
            if l & 0xC0 == 0xC0: return o + 2
            o += 1 + l
    for _ in range(qd): off = skip_name(off) + 4
    out = []
    for _ in range(an):
        off = skip_name(off)
        t, _c, _ttl, rl = struct.unpack(">HHIH", data[off:off + 10]); off += 10
        rd = data[off:off + rl]; off += rl
        if t == 1 and rl == 4: out.append(socket.inet_ntop(socket.AF_INET, rd))
        elif t == 28 and rl == 16: out.append(socket.inet_ntop(socket.AF_INET6, rd))
    return out

def resolve(blocklist, out_path):
    m = _mac()
    os.environ["LOCKQZ_BLOCKLIST"] = blocklist
    hosts = []
    try:
        for l in open(blocklist):
            l = l.strip().lower()
            if l and not l.startswith("#") and re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+", l): hosts.append(l)
    except Exception: return 1
    servers = upstream_servers()
    def one(h):
        ips = set()
        for qtype in (1, 28):
            for srv in servers[:2]:
                try: ips.update(_query(h, qtype, srv)); break
                except Exception: continue
        return ips
    ips, api, allow = set(), set(), set()
    with ThreadPoolExecutor(max_workers=32) as ex:
        for got in ex.map(one, sorted(set(hosts))): ips.update(got)
        for got in ex.map(one, API_HOSTS): api.update(got)
        for got in ex.map(one, ALLOW_HOSTS): allow.update(got)
    ips = sorted(i for i in ips if not PRIVATE.match(i))
    api = sorted(i for i in api - allow if not PRIVATE.match(i))
    if not ips: return 1
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp = out_path + ".tmp"
    with open(tmp, "w") as f: f.write("\n".join(ips) + "\n")
    os.replace(tmp, out_path)
    if api:
        with open(tmp, "w") as f: f.write("\n".join(api) + "\n")
        os.replace(tmp, out_path + ".api")
    return 0

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "lock": sys.exit(0 if lock() else 1)
    if cmd == "unlock": sys.exit(0 if unlock() else 1)
    if cmd == "status": sys.exit(status())
    if cmd == "resolve" and len(sys.argv) == 4: sys.exit(resolve(sys.argv[2], sys.argv[3]))
    print(__doc__); sys.exit(2)
