#!/usr/bin/env python3
"""LOCKqz Linux port (28 Oct 2026): unit checks that need no root and no systemd.
 L1 release manifest lists every Linux file and each source exists; scripts parse / compile
 L2 browser-policy.py: Chromium + Firefox policy files written in a fake root, a student's own
    policies.json merged and put back exactly, status, unlock
 L3 resolver: raw DNS answer parsing (A + AAAA, CNAME chain) against a fake DNS server; private/loopback dropped
 L4 agent: Chromium SNSS session parsing (navigation, selected index, closed tab) on a synthetic file;
    the shared Mac logic is imported and the desktop pieces swapped; Firefox session paths; browsers to close
 L5 engine script: dry-run lock/unlock parse, LOCKQZ_NO_KILL honoured, nft ruleset text well-formed
 L6 installer: fetches the "linux" manifest section, keeps the device id, opens /pay via xdg-open unless LOCKQZ_NO_BROWSER
"""
import importlib.util, json, os, re, shutil, socket, struct, subprocess, sys, tempfile, threading

HERE = os.path.dirname(os.path.abspath(__file__)); APP = os.path.dirname(HERE)
LINUX, MAC = os.path.join(APP, "linux"), os.path.join(APP, "mac")
PASS = FAIL = 0
def ok(m):
    global PASS; PASS += 1; print("  ok:", m)
def bad(m):
    global FAIL; FAIL += 1; print("  FAIL:", m)
def check(m, c, extra=""):
    (ok if c else bad)(m + (("  [" + str(extra)[:200] + "]") if (not c and extra) else ""))
def load(path, name, env=None):
    old = dict(os.environ)
    if env: os.environ.update(env)
    try:
        spec = importlib.util.spec_from_file_location(name, path); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    finally:
        os.environ.clear(); os.environ.update(old)
    return mod

TMP = tempfile.mkdtemp(); STAGE = os.path.join(TMP, "stage"); os.makedirs(STAGE)
# the installed layout: linux files + shared mac files under their installed names
mm = load(os.path.join(APP, "release", "make-manifest.py"), "mm")
for n, rel in mm.LINUX_FILES.items(): shutil.copy2(os.path.join(APP, rel), os.path.join(STAGE, n))

print("L1 release manifest + syntax")
check("LINUX_FILES has the engine, agent, policy writer, helper, shared logic, installer", all(k in mm.LINUX_FILES for k in
      ["lockqz.sh", "lockqz-agent.py", "browser-policy.py", "lockqzd.py", "agent-mac.py", "policy-mac.py", "lockqz-core.sh", "blocklist.txt", "install.sh", "uninstall.sh", "update.pub"]))
check("every Linux source exists", all(os.path.isfile(os.path.join(APP, rel)) for rel in mm.LINUX_FILES.values()))
for f in ("lockqz.sh", "install.sh", "uninstall.sh"):
    r = subprocess.run(["bash", "-n", os.path.join(LINUX, f)], capture_output=True, text=True); check("%s parses" % f, r.returncode == 0, r.stderr)
for f in ("lockqz-agent.py", "browser-policy.py"):
    r = subprocess.run([sys.executable, "-m", "py_compile", os.path.join(LINUX, f)], capture_output=True, text=True); check("%s compiles" % f, r.returncode == 0, r.stderr)
check("E10 compares the linux section too (first release exempt)", '"linux"' in open(os.path.join(APP, "release", "make-manifest.py")).read() and "first Linux release" in open(os.path.join(APP, "release", "make-manifest.py")).read())
check("helper: Linux mode is opt-in (LOCKQZ_PLATFORM=linux), sessions from logind, platform tag, update section by platform",
      all(x in open(os.path.join(MAC, "lockqzd.py")).read() for x in ['IS_LINUX = os.environ.get("LOCKQZ_PLATFORM") == "linux"', "loginctl", "def platform_tag", 'plat = "linux" if IS_LINUX else "mac"']))

print("L2 browser policies in a fake root")
ROOT = os.path.join(TMP, "root"); ST = os.path.join(TMP, "state")
os.makedirs(os.path.join(ROOT, "etc/firefox/policies")); os.makedirs(os.path.join(ROOT, "etc/brave")); os.makedirs(os.path.join(ROOT, "usr/lib/firefox"))
with open(os.path.join(ROOT, "etc/firefox/policies/policies.json"), "w") as f: json.dump({"policies": {"DisableTelemetry": True}}, f)
env = {"LOCKQZ_STATE": ST, "LOCKQZ_POLICY_ROOT": ROOT, "LOCKQZ_POLICY_BACKUP": os.path.join(ST, "policy-backup")}
def bp(*a):
    return subprocess.run([sys.executable, os.path.join(STAGE, "browser-policy.py")] + list(a), capture_output=True, text=True, env=dict(os.environ, **env))
r = bp("lock"); check("lock exits 0", r.returncode == 0, r.stderr)
cj = os.path.join(ROOT, "etc/opt/chrome/policies/managed/zz-lockqz.json"); bj = os.path.join(ROOT, "etc/brave/policies/managed/zz-lockqz.json")
check("Chrome + Brave + Edge + snap-Chromium policy files written (every family, installed or not)", os.path.isfile(cj) and os.path.isfile(bj) and os.path.isfile(os.path.join(ROOT, "etc/opt/edge/policies/managed/zz-lockqz.json")) and os.path.isfile(os.path.join(ROOT, "etc/chromium/policies/managed/zz-lockqz.json")))
check("Chrome: incognito/guest off, built-in DNS client off (system resolver only)", json.load(open(cj)).get("IncognitoModeAvailability") == 1 and json.load(open(cj)).get("BuiltInDnsClientEnabled") is False)
d = json.load(open(cj))
check("Chrome: GenAI off, Gemini off, DoH off, proxy direct, extensions blocked, blocklist hosts inside URLBlocklist",
      d.get("GenAiDefaultSettings") == 2 and d.get("GeminiSettings") == 1 and d.get("DnsOverHttpsMode") == "off" and d.get("ProxyMode") == "direct"
      and d.get("ExtensionInstallBlocklist") == ["*"] and "chatgpt.com" in d["URLBlocklist"] and "web.whatsapp.com" in d["URLBlocklist"] and d.get("LOCKqzManaged") is True)
check("Brave: Leo + Tor + VPN off", json.load(open(bj)).get("BraveAIChatEnabled") is False and json.load(open(bj)).get("TorDisabled") is True)
ff = json.load(open(os.path.join(ROOT, "etc/firefox/policies/policies.json")))["policies"]
check("Firefox: student's own policy kept, ours merged (AI chat off, DoH off, WebsiteFilter with the blocklist)",
      ff.get("DisableTelemetry") is True and ff.get("LOCKqzManaged") is True and ff["DNSOverHTTPS"]["Enabled"] is False and ff["GenerativeAI"]["Enabled"] is False
      and any("chatgpt.com" in b for b in ff["WebsiteFilter"]["Block"]))
check("Firefox distribution dir covered too; private browsing off", os.path.isfile(os.path.join(ROOT, "usr/lib/firefox/distribution/policies.json")) and ff.get("DisablePrivateBrowsing") is True)
check("status says locked", bp("status").stdout.strip() == "locked")
r = bp("lock"); check("second lock is idempotent (still the student's value, not doubled)", r.returncode == 0 and json.load(open(os.path.join(ROOT, "etc/firefox/policies/policies.json")))["policies"].get("DisableTelemetry") is True)
r = bp("unlock"); check("unlock exits 0", r.returncode == 0, r.stderr)
check("Chrome/Brave/Edge files gone", not os.path.exists(cj) and not os.path.exists(bj) and not os.path.exists(os.path.join(ROOT, "etc/opt/edge/policies/managed/zz-lockqz.json")))
check("student's policies.json put back exactly", json.load(open(os.path.join(ROOT, "etc/firefox/policies/policies.json"))) == {"policies": {"DisableTelemetry": True}})
check("distribution policies.json (ours only) removed", not os.path.exists(os.path.join(ROOT, "usr/lib/firefox/distribution/policies.json")))
check("status says unlocked", bp("status").stdout.strip() == "unlocked")

print("L3 resolver against a fake DNS server")
B = load(os.path.join(STAGE, "browser-policy.py"), "bp", env)
def fake_dns():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]
    def run():
        while True:
            try: data, addr = s.recvfrom(4096)
            except Exception: return
            qid = data[:2]; qtype = struct.unpack(">H", data[-4:-2])[0]
            qname = data[12:]   # question section: name + type + class
            def name_at(o): return struct.pack(">H", 0xC000 | o)
            ans = b""
            if qtype == 1:   # CNAME then two A records
                ans += name_at(12) + struct.pack(">HHIH", 5, 1, 60, 7) + b"\x05alias\x00"
                for ip in ("104.18.32.47", "127.0.0.1", "10.1.2.3"):
                    ans += name_at(12) + struct.pack(">HHIH", 1, 1, 60, 4) + socket.inet_aton(ip)
                n = 4
            else:
                for ip in ("2606:4700::6812:202f", "fe80::1"):
                    ans += name_at(12) + struct.pack(">HHIH", 28, 1, 60, 16) + socket.inet_pton(socket.AF_INET6, ip)
                n = 2
            resp = qid + struct.pack(">HHHHH", 0x8180, 1, n, 0, 0) + qname + ans
            s.sendto(resp, addr)
    threading.Thread(target=run, daemon=True).start(); return port, s
port, srv = fake_dns()
def _q(name, qtype):
    qid = 7; qb = struct.pack(">HHHHHH", qid, 0x0100, 1, 0, 0, 0)
    for p in name.split("."): qb += bytes([len(p)]) + p.encode()
    qb += b"\0" + struct.pack(">HH", qtype, 1)
    c = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); c.settimeout(2); c.sendto(qb, ("127.0.0.1", port)); data, _ = c.recvfrom(4096); c.close()
    return data
def patched(name, qtype, server, timeout=2.0): return real_parse(_q(name, qtype), name, qtype)
def real_parse(data, name, qtype):
    # identical to the parser inside browser-policy._query (kept in sync by this test)
    qd, an = struct.unpack(">HH", data[4:8]); off = 12
    def skip_name(o):
        while True:
            l = data[o]
            if l == 0: return o + 1
            if l & 0xC0 == 0xC0: return o + 2
            o += 1 + l
    for _ in range(qd): off = skip_name(off) + 4
    out = []
    for _ in range(an):
        off = skip_name(off); t, _c, _ttl, rl = struct.unpack(">HHIH", data[off:off + 10]); off += 10
        rd = data[off:off + rl]; off += rl
        if t == 1 and rl == 4: out.append(socket.inet_ntop(socket.AF_INET, rd))
        elif t == 28 and rl == 16: out.append(socket.inet_ntop(socket.AF_INET6, rd))
    return out
a = patched("chatgpt.com", 1, None); aaaa = patched("chatgpt.com", 28, None)
check("A answers parsed past a CNAME in the same answer", a == ["104.18.32.47", "127.0.0.1", "10.1.2.3"], a)
check("AAAA answers parsed", aaaa == ["2606:4700::6812:202f", "fe80::1"], aaaa)
kept = [i for i in a + aaaa if not B.PRIVATE.match(i)]
check("private / loopback / link-local dropped by the PRIVATE filter", kept == ["104.18.32.47", "2606:4700::6812:202f"], kept)
# the module's own _query end to end against the fake server (server passed explicitly, port patched)
B_sock = socket.socket
class S(B_sock):
    def sendto(self, data, addr): return super().sendto(data, ("127.0.0.1", port))
B.socket.socket = S
try:
    r1 = B._query("chatgpt.com", 1, "127.0.0.1"); check("module _query end to end: A list", r1 == ["104.18.32.47", "127.0.0.1", "10.1.2.3"], r1)
finally: B.socket.socket = B_sock
srv.close()
check("upstream_servers never returns the systemd stub", all(not s.startswith("127.0.0.5") for s in B.upstream_servers()))

print("L4 agent: SNSS parsing + shared logic")
A = load(os.path.join(STAGE, "lockqz-agent.py"), "la", {"LOCKQZ_TOKEN_DIR": TMP, "LOCKQZ_CONFIG": os.path.join(TMP, "none.json")})
def pstr(s): b = s.encode(); return struct.pack("<I", len(b)) + b + b"\0" * ((-len(b)) % 4)
def cmd(cid, body): return struct.pack("<H", len(body) + 1) + bytes([cid]) + body
def nav(tid, idx, url): body = struct.pack("<ii", tid, idx) + pstr(url) + pstr("title"); return cmd(6, struct.pack("<I", len(body)) + body)
snss = b"SNSS" + struct.pack("<i", 3)
snss += nav(1, 0, "https://example.com/") + nav(1, 1, "https://example.com/page2") + cmd(7, struct.pack("<ii", 1, 1))
snss += nav(2, 0, "https://usc.brightspace.com/d2l/lms/quizzing/user/attempt/quiz_start_frame_auto.d2l?ou=1&qi=2")
snss += nav(3, 0, "https://chatgpt.com/") + cmd(16, struct.pack("<iq", 3, 0))
urls = A.snss_urls(snss)
check("selected navigation entry per tab, closed tab dropped", sorted(urls) == ["https://example.com/page2", "https://usc.brightspace.com/d2l/lms/quizzing/user/attempt/quiz_start_frame_auto.d2l?ou=1&qi=2"], urls)
check("a quiz attempt URL from the session file is a quiz for the shared logic", A.M.is_quiz(urls[-1]) if urls else False)
check("non-SNSS data ignored", A.snss_urls(b"junk") == [])
snss2 = b"SNSS" + struct.pack("<i", 3) + cmd(0, struct.pack("<ii", 5, 9)) + nav(9, 0, "https://example.com/win") + cmd(17, struct.pack("<iq", 5, 0))
check("a closed WINDOW closes its tabs (command 0 + 17)", A.snss_urls(snss2) == [], A.snss_urls(snss2))
check("an encrypted session file (version 2/4) is reported as unreadable, not as 'no tabs'", A.snss_urls(b"SNSS" + struct.pack("<i", 4) + b"x" * 20) is None)
check("browser label from the full path: snap Chromium is Chromium, not Chrome", A.classify_exe("/snap/chromium/3000/usr/lib/chromium-browser/chrome") == ("Chromium", False) and A.classify_exe("/opt/google/chrome/chrome") == ("Google Chrome", False) and A.classify_exe("/app/brave/brave")[1] is True and A.classify_exe("/usr/lib/firefox/firefox") == ("Firefox", False))
check("Tor/Mullvad launchers, Thorium, qutebrowser, Epiphany are seen (closed at lock, no policy reaches them)", A.classify_exe("/home/s/tor-browser/Browser/firefox.real")[0] == "Tor Browser" and A.classify_exe("/usr/bin/thorium-browser")[0] == "other:thorium-browser" and A.classify_exe("/usr/bin/qutebrowser")[0] == "other:qutebrowser" and A.classify_exe("/usr/bin/epiphany")[0] == "other:epiphany")
er = A.extra_roots([(1, 1, "/opt/google/chrome/chrome --user-data-dir=/tmp/x --no-first-run"), (2, 1, "/usr/lib/firefox/firefox -profile /tmp")])
check("non-default profile dirs on the command line are read too", er["chromium"] == {"/tmp/x"} and er["gecko"] == {"/tmp"}, er)
prof2 = os.path.join(TMP, "prof2"); os.makedirs(os.path.join(prof2, "Default", "Sessions")); os.makedirs(os.path.join(prof2, "Profile 1", "Sessions"))
open(os.path.join(prof2, "Default", "Sessions", "Session_1"), "wb").write(snss); open(os.path.join(prof2, "Profile 1", "Sessions", "Session_2"), "wb").write(snss2)
check("one session file per profile (a second profile window never hides the quiz)", len(A.chromium_session_files(prof2)) == 2)
prof = os.path.join(TMP, "prof"); os.makedirs(os.path.join(prof, "Default", "Sessions")); open(os.path.join(prof, "Default", "Sessions", "Session_1"), "wb").write(snss)
f = A.chromium_session_file(prof); check("newest Sessions/Session_* found", f and f[1].endswith("Session_1"))
check("desktop pieces swapped: LinuxUI, Linux tabs, no tab rewriting, Linux paths", A.M.MacUI is A.LinuxUI and A.M.browser_tabs is A.browser_tabs and A.M.set_tab_url("x", 0, 0, "u") is None and A.M.USER_DIR.endswith(".config/lockqz") and A.M.TOKEN_DIR == TMP)
procs = [(100, 50, "/usr/lib/firefox/firefox"), (101, 50, "/usr/lib/firefox/firefox -contentproc --type=tab"), (200, 40, "/opt/google/chrome/chrome"), (300, 30, "/app/brave/brave"), (400, 20, "/usr/lib/opera/opera")]
rb = A.running_browsers(procs)
check("running browsers by family (helpers excluded), flatpak flagged", set(rb) == {"Firefox", "Google Chrome", "Brave", "Opera"} and rb["Brave"][2] is True and rb["Firefox"][1] == [100], rb)
ag = A.Agent.__new__(A.Agent); ag.opera_check = 0
A.M.close_pids = lambda pids: pids; A.ps_procs = lambda: procs
note = ag.close_for_quiz("Google Chrome")
check("at lock: Firefox (policies at start), Opera (no policy), flatpak Brave closed; the quiz browser kept", "Firefox" in note and "Opera" in note and "Brave" in note and "Chrome" not in note, note)
check("Opera/flatpak re-closed during the quiz, never the quiz browser", {l for _, l in A.no_policy_pids(procs, "Google Chrome")} == {"Brave", "Opera"} and A.no_policy_pids(procs, "Opera") and all(l != "Opera" for _, l in A.no_policy_pids(procs, "Opera")))
check("Firefox session paths cover deb, snap and flatpak", any("snap/firefox" in r for _, _, roots in A.GECKO for r in roots) and any(".var/app/org.mozilla.firefox" in r for _, _, roots in A.GECKO for r in roots))

print("L5 engine script")
env5 = dict(os.environ, LOCKQZ_DRYRUN="1", HOSTS=os.path.join(TMP, "hosts"), STATE=os.path.join(TMP, "st5"))
open(os.path.join(TMP, "hosts"), "w").write("127.0.0.1 localhost\n")
r = subprocess.run(["bash", os.path.join(STAGE, "lockqz.sh"), "lock"], capture_output=True, text=True, env=env5)
check("dry-run lock exits 0 and touches nothing", r.returncode == 0 and "dry-run" in r.stdout and open(os.path.join(TMP, "hosts")).read() == "127.0.0.1 localhost\n", r.stdout + r.stderr)
r = subprocess.run(["bash", os.path.join(STAGE, "lockqz.sh"), "unlock"], capture_output=True, text=True, env=env5); check("dry-run unlock exits 0", r.returncode == 0, r.stderr)
src = open(os.path.join(LINUX, "lockqz.sh")).read()
check("LOCKQZ_NO_KILL guard (tests never signal real processes)", 'LOCKQZ_NO_KILL' in src)
check("messaging + AI + model + VPN + VM + remote + overlay lists present", all(x in src for x in ['"LM Studio"', "whatsapp", "telegram-desktop", "discord", "ollama", "openvpn", "VirtualBox", "anydesk", "cluely"]))
check("nftables: DoT, DoH sets, model ports, VPN ports, QUIC-to-AI sets; iptables fallback", all(x in src for x in ["dport 853", "lq_warm4", "lq_warm6", "11434", "51820", "iptables -N LOCKQZ"]))
check("warm resolver runs detached (setsid) and ss -K cuts open AI connections (IPv6 bracketed)", "setsid bash -c" in src and 'ss -K dst "[$ip]"' in src)
check("with systemd-resolved only the stub (and root) may speak DNS; nft failure falls back to iptables; system services stopped once via systemd", "meta skuid != { 0, $ruid }" in src and "trying iptables" in src and "stop_services" in src)
check("DoH lists cover NextDNS, CleanBrowsing, OpenDNS, dns.sb, Control D, Quad101, dns0", all(x in src for x in ["45.90.28.0/22", "185.228.168.0/23", "208.67.222.222", "185.222.222.222", "76.76.2.0/24", "101.101.101.101", "193.110.81.0"]))
check("agent: desktop env recovered from the user manager; unit tied to the graphical session", "systemctl\", \"--user\", \"show-environment" in open(os.path.join(LINUX, "lockqz-agent.py")).read() and "WantedBy=graphical-session.target" in open(os.path.join(LINUX, "install.sh")).read())
check("unlock verifies the nft table is gone", 'nft list table inet "$NFT_TABLE" >/dev/null 2>&1 && return 1' in src)

print("L6 installer")
inst = open(os.path.join(LINUX, "install.sh")).read()
check("fetches the linux section of the signed manifest, verifies signature + sha256", 'm.get("linux")' in inst and "openssl dgst -sha256 -verify" in inst and "sha256sum" in inst)
check("keeps the device id on reinstall", 'case "$OLD_DEV" in linux-*) DEVICE="$OLD_DEV";; esac' in inst)
check("systemd: root helper + global user agent unit; Linux mode set for the helper", "WantedBy=multi-user.target" in inst and "systemctl --global enable lockqz-agent.service" in inst and "LOCKQZ_PLATFORM=linux" in inst)
check("ends on the pay page unless LOCKQZ_NO_BROWSER", "xdg-open '$SITE/pay'" in inst and "LOCKQZ_NO_BROWSER" in inst)
check("same release key as the Mac installer", re.search(r"-----BEGIN PUBLIC KEY-----(.*?)-----END", inst, re.S).group(1) == re.search(r"-----BEGIN PUBLIC KEY-----(.*?)-----END", open(os.path.join(MAC, "install.sh")).read(), re.S).group(1))
check("download page: Linux gets the one-line command, no installer box; phones/Chromebooks told plainly",
      all(x in open(os.path.join(APP, "cloudflare/public/index.html")).read() for x in ["install-linux.sh", "for Linux", "Chromebooks can't run LOCKqz"]))
check("release.yml publishes install-linux.sh and runs the real Linux install test", "install-linux.sh" in open(os.path.join(APP, "..", ".github/workflows/release.yml")).read() and "test_linux_install.sh" in open(os.path.join(APP, "..", ".github/workflows/release.yml")).read())

shutil.rmtree(TMP, ignore_errors=True)
print("\nRESULT: %d passed, %d failed" % (PASS, FAIL)); sys.exit(1 if FAIL else 0)
