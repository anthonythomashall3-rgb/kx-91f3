#!/usr/bin/env python3
"""LOCKqz daemon (macOS). Runs as root via launchd.

- Loopback control server on 127.0.0.1 for the per-user LOCKqz agent:
    POST /lock {"quiz_id","student","max_minutes"}  -> engine lock, begin watching
    POST /unlock {"quiz_id"}                         -> engine unlock
    GET  /status                                     -> current state
    POST /student {"student"}                        -> name shown on the teacher roster
    POST /heartbeat {...}                            -> forwarded to Cloudflare
    POST /password {"url"}   -> quiz password, ONLY while this Mac is locked for that quiz
    POST /event {"event":"quiz_left",...}            -> forwarded to Cloudflare (signed)
  All requests must carry header  X-LOCKqz-Token: <token from config>.
- Device key: a random per-install key in a root-only file (0600). The helper registers it once
  and signs every report and password request with it (HMAC-SHA256), so a script that never
  installed LOCKqz cannot fake a lock and read the quiz password.
- Watcher: while a quiz is locked, re-applies the block every few seconds, reports
  tampering, refreshes the blocklist hourly, and AUTO-UNLOCKS at a hard maximum so a
  student is never left locked.
- Self-update: every ~6h (and ~90s after start), while NO quiz is locked, fetches
  <site>/download/update.json + update.sig, checks the RSA-SHA256 signature against the
  public key shipped with the install (update.pub), downloads each listed file, checks its
  SHA-256, swaps the files in atomically and restarts. Anything wrong (signature, hash, name,
  network) leaves the install exactly as it was. Nobody has to touch a student's computer.
- Set LOCKQZ_DRYRUN=1 in the environment to run unprivileged for testing (the engine
  makes no system changes).
"""
import base64, hashlib, hmac, json, os, platform, re, secrets, shutil, ssl, subprocess, tempfile, threading, time
import urllib.error, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.join(HERE, "lockqz.sh")
BLOCKLIST = os.environ.get("LOCKQZ_BLOCKLIST") or os.path.join(HERE, "blocklist.txt")
CONF_PATHS = ([os.environ["LOCKQZ_CONFIG"]] if os.environ.get("LOCKQZ_CONFIG") else []) + \
             ["/Library/Application Support/LOCKqz/config.json",
              os.path.join(HERE, "config.json")]
VERSION = "0.3.1"
# Cloudflare blocks the default "Python-urllib" user agent (403) — always send our own.
UA = {"User-Agent": "LOCKqz/%s (macOS)" % VERSION}

def load_conf():
    for p in CONF_PATHS:
        try:
            with open(p) as f: return json.load(f)
        except Exception: pass
    return {}

CONF = load_conf()
PORT    = int(CONF.get("port", 8787))
TOKEN   = CONF.get("token", "lockqz-dev")
API     = CONF.get("api_base", "").rstrip("/")
if API and not API.endswith("/api"): API += "/api"   # accept a bare site URL too
DEVICE  = CONF.get("device_id", "unknown")
MAX_MIN = int(CONF.get("max_minutes", 180))   # hard cap: auto-unlock after this
BEAT    = max(1, int(CONF.get("beat_cycles", 9)))  # liveness ping every BEAT*5s (default ~45s)
DRYRUN  = os.environ.get("LOCKQZ_DRYRUN", "0")
# Admin developer mode: AI stays available during quizzes ONLY on a Mac that holds the
# matching developer key. The code ships with the key's SHA-256 only — a student install
# has no key file and cannot forge one, so it can never enter developer mode.
DEV_KEY_HASH = "4695a520432e105e967dd2703366c24c039fe0a850fe35db03b73b6b9506aecd"

KEY_PATH = os.environ.get("LOCKQZ_KEY_PATH") or "/Library/Application Support/LOCKqz/device.key"
# Active-lock record (root-only). Brightspace checks access only when a quiz is LAUNCHED, so the lock
# must survive the helper being killed: on restart we resume an unexpired lock instead of unlocking.
LOCKFILE = os.environ.get("LOCKQZ_LOCKFILE") or "/Library/Application Support/LOCKqz/active_lock.json"
NET = {"skew": 0.0, "registered": False}   # skew: server clock minus ours, learned from a 401

# Self-update (signed). The site that serves the API also serves the release files.
SITE = API[:-4] if API.endswith("/api") else API
UPDATE_URL = (os.environ.get("LOCKQZ_UPDATE_URL") or (SITE + "/download" if SITE else "")).rstrip("/")
UPDATE_DIR = os.environ.get("LOCKQZ_UPDATE_DIR") or HERE          # where this install's files live
# Only a real install updates itself (or a test that names its own LOCKQZ_UPDATE_DIR): a daemon
# started from a source checkout must never overwrite the checkout.
UPDATE_OK = bool(os.environ.get("LOCKQZ_UPDATE_DIR")) or HERE == "/Library/Application Support/LOCKqz"
PUBKEY = os.environ.get("LOCKQZ_UPDATE_PUB") or os.path.join(HERE, "update.pub")
UPDATE_EVERY = max(12, int(os.environ.get("LOCKQZ_UPDATE_CYCLES", "4320")))   # 5 s cycles: 4320 = 6 h
UPDATE_DELAY = float(os.environ.get("LOCKQZ_UPDATE_DELAY", "90"))           # seconds after start
# Files an update may never touch: this install's identity and live state.
UPDATE_NEVER = {"config.json", "device.key", "active_lock.json", "lockqzd.log", "developer.key"}

STATE = {"state": "unlocked", "quiz_id": None, "student": CONF.get("student"),
         "locked_at": None, "locked_since": 0.0, "max_minutes": MAX_MIN}
LOCK = threading.Lock()

def save_lock():
    try:
        os.makedirs(os.path.dirname(LOCKFILE), exist_ok=True)
        rec = {k: STATE[k] for k in ("quiz_id", "student", "locked_at", "locked_since", "max_minutes")}
        fd = os.open(LOCKFILE + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f: json.dump(rec, f)
        os.replace(LOCKFILE + ".tmp", LOCKFILE)
    except Exception as e:
        log("could not save lock record: %s" % e)

def clear_lock():
    try: os.remove(LOCKFILE)
    except FileNotFoundError: pass
    except Exception as e: log("could not clear lock record: %s" % e)

def load_lock():
    """An unexpired saved lock, or None. Expired/corrupt records are discarded."""
    try:
        with open(LOCKFILE) as f: rec = json.load(f)
        since, mx = float(rec.get("locked_since") or 0), int(rec.get("max_minutes") or MAX_MIN)
        if rec.get("quiz_id") and since and 0 <= time.time() - since < mx * 60:
            return rec
    except Exception:
        pass
    clear_lock()
    return None

def engine(cmd):
    try:
        subprocess.run(["bash", ENGINE, cmd], check=False, capture_output=True, timeout=60)
    except Exception as e:
        log("engine error: %s" % e)

def engine_locked():
    try:
        out = subprocess.run(["bash", ENGINE, "status"], capture_output=True, text=True, timeout=30).stdout
        return "LOCKED" in out
    except Exception:
        return False

def log(msg): print("LOCKqzd:", msg, flush=True)

def device_key():
    """This install's signing key: 32 random bytes (hex) in a file only root can read.
    The per-user agent and the student's own account never see it."""
    try:
        with open(KEY_PATH) as f:
            k = f.read().strip()
        if re.fullmatch(r"[0-9a-f]{64}", k): return k
    except FileNotFoundError:
        pass
    except Exception as e:
        log("device key unreadable (%s) - making a new one" % e)
    k = secrets.token_hex(32)
    try:
        os.makedirs(os.path.dirname(KEY_PATH), exist_ok=True)
        tmp = KEY_PATH + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f: f.write(k)
        os.chmod(tmp, 0o600)
        os.replace(tmp, KEY_PATH)
    except Exception as e:
        log("could not save device key: %s" % e)
    return k

KEY = device_key()

def lock_id(url):
    """Same rule as the agent and the server: '<ou>-<qi>' from the quiz URL."""
    qi = re.search(r"qi=(\d+)", url or ""); ou = re.search(r"ou=(\d+)", url or "")
    return "%s-%s" % (ou.group(1) if ou else "x", qi.group(1) if qi else "x")

def _console_user():
    try:
        u = subprocess.run(["stat", "-f", "%Su", "/dev/console"], capture_output=True, text=True, timeout=5).stdout.strip()
        return u or None
    except Exception:
        return None

def developer_mode():
    """True only on the admin's Mac (a valid developer key is present). Student installs
    have no key file and cannot forge one from the shipped hash, so this is always False
    for them — LOCKqz locks for everyone except the admin who holds the key."""
    if os.environ.get("LOCKQZ_NO_DEVMODE"): return False   # tests: behave like a student install
    cands = []
    if os.environ.get("LOCKQZ_DEV_KEY"): cands.append(os.environ["LOCKQZ_DEV_KEY"])
    u = _console_user()
    if u: cands.append("/Users/%s/Library/Application Support/LOCKqz/developer.key" % u)
    for p in cands:
        try:
            if hashlib.sha256(open(p, "rb").read().strip()).hexdigest() == DEV_KEY_HASH:
                return True
        except Exception:
            pass
    return False

def _json(b):
    try: return json.loads(b or b"null")
    except Exception: return None

def signed_headers(url, raw):
    ts = str(int(time.time() + NET["skew"]))
    path = urllib.parse.urlsplit(url).path or "/"
    msg = "POST\n%s\n%s\n%s" % (path, ts, hashlib.sha256(raw).hexdigest())
    return {"X-LOCKqz-Device": DEVICE, "X-LOCKqz-Time": ts,
            "X-LOCKqz-Sig": hmac.new(KEY.encode(), msg.encode(), hashlib.sha256).hexdigest()}

def call(path, body, signed=True):
    """POST JSON to the LOCKqz API; returns (http_status, json). Signed with the device key.
    Retries network blips (an exam report is never dropped), corrects for a wrong student
    clock (server_time in a 401) and re-registers if the server does not know this device.
    Never raises."""
    if not API: return (0, None)
    url, raw = API + path, json.dumps(body).encode()
    for attempt in range(3):
        hdrs = {"Content-Type": "application/json", **UA}
        if signed: hdrs.update(signed_headers(url, raw))
        try:
            r = urllib.request.urlopen(urllib.request.Request(url, data=raw, headers=hdrs),
                                       timeout=8, context=ssl.create_default_context())
            return (r.status, _json(r.read()))
        except urllib.error.HTTPError as e:
            j = _json(e.read())
            if e.code == 401 and signed and attempt < 2 and isinstance(j, dict):
                st = j.get("server_time")
                if isinstance(st, (int, float)): NET["skew"] = st - time.time()
                if j.get("why") == "unregistered":
                    NET["registered"] = False; register()
                continue
            log("api %s -> HTTP %s" % (path, e.code))
            return (e.code, j)
        except Exception as e:
            if attempt == 2:
                log("post %s failed after retries: %s" % (path, e)); return (0, None)
            time.sleep(2 * (attempt + 1))
    return (0, None)

def register():
    """Register this install's key with the server once (trust on first use)."""
    if NET["registered"] or not API or DEVICE in ("", "unknown"): return NET["registered"]
    code, j = call("/register", {"device_id": DEVICE, "key": KEY, "version": VERSION,
                                 "platform": "mac-" + platform.mac_ver()[0], "student": STATE["student"]},
                   signed=False)
    if code == 200: NET["registered"] = True; log("device registered")
    elif code == 409: log("device id is registered with another key - reinstall LOCKqz for a new device id")
    return NET["registered"]

def post(path, body):
    return call(path, body)[0]

def engine_ok():
    """True when the AI block is really in place (dry-run tests: when the state says locked)."""
    return STATE["state"] == "locked" if DRYRUN == "1" else engine_locked()

def report(event, extra=None):
    body = {"device_id": DEVICE, "event": event, "quiz_id": STATE["quiz_id"],
            "student": STATE["student"], "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if extra: body.update(extra)
    post("/report", body)

def refresh_blocklist():
    if not API: return
    try:
        r = urllib.request.urlopen(urllib.request.Request(API + "/blocklist", headers=UA), timeout=8, context=ssl.create_default_context())
        doms = json.loads(r.read()).get("domains", [])
        # Validate before trusting: must be a healthy list of well-formed hosts, and
        # must still contain the anchors. A bad/empty download never wipes the list.
        clean = [d.strip() for d in doms if isinstance(d, str) and "." in d and " " not in d.strip()]
        anchors = {"chatgpt.com", "claude.ai", "gemini.google.com"}
        if len(clean) >= 20 and anchors.issubset(set(clean)):
            # The server can only ADD domains: a shorter or older server list never removes
            # anything this Mac already blocks.
            try:
                with open(BLOCKLIST) as f:
                    have = [l.strip() for l in f if l.strip() and not l.lstrip().startswith("#")]
            except Exception:
                have = []
            merged = list(dict.fromkeys(have + clean))
            if len(merged) > len(have):
                with open(BLOCKLIST, "w") as f:
                    f.write("# LOCKqz AI blocklist - shipped list plus additions from the server %s\n" % time.strftime("%Y-%m-%d"))
                    f.write("\n".join(merged) + "\n")
                log("blocklist refreshed (%d -> %d domains)" % (len(have), len(merged)))
        else:
            log("blocklist refresh rejected (failed sanity check) — keeping current list")
    except Exception as e:
        log("blocklist refresh failed: %s" % e)

def _vtuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", str(v))[:3]) or (0,)

def _fetch(url, limit=5_000_000):
    r = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=15, context=ssl.create_default_context())
    data = r.read(limit + 1)
    if len(data) > limit: raise ValueError("download too large: " + url)
    return data

def verify_manifest(body, sig_b64):
    """RSA-SHA256 (PKCS#1 v1.5) check with /usr/bin/openssl - present on every Mac - against the
    public key pinned in this install. False on any problem."""
    try:
        with tempfile.TemporaryDirectory() as d:
            b, sg = os.path.join(d, "m.json"), os.path.join(d, "m.sig")
            with open(b, "wb") as f: f.write(body)
            with open(sg, "wb") as f: f.write(base64.b64decode(sig_b64))
            r = subprocess.run(["openssl", "dgst", "-sha256", "-verify", PUBKEY, "-signature", sg, b],
                               capture_output=True, text=True, timeout=30)
            return r.returncode == 0 and "Verified OK" in r.stdout
    except Exception as e:
        log("update: signature check error: %s" % e)
        return False

def restart_after_update():
    """Restart the per-user agent, then exit: launchd (KeepAlive) starts the new helper code."""
    if DRYRUN == "1":
        log("update: (dry-run) would restart the agent and the helper"); return
    try:
        uid = subprocess.run(["stat", "-f", "%u", "/dev/console"], capture_output=True, text=True, timeout=5).stdout.strip()
        if uid and uid != "0":
            subprocess.run(["launchctl", "kickstart", "-k", "gui/%s/com.lockqz.agent" % uid], capture_output=True, timeout=20)
    except Exception as e:
        log("update: agent restart: %s" % e)
    log("update: restarting helper on the new version"); os._exit(0)

def check_update():
    """Signed self-update; only while no quiz is locked. Returns True when an update was installed.
    A bad signature, hash, file name or download leaves the install untouched. Never raises."""
    if not UPDATE_OK or not UPDATE_URL or not os.path.isfile(PUBKEY): return False
    stage = os.path.join(UPDATE_DIR, ".update")
    try:
        body = _fetch(UPDATE_URL + "/update.json", 200_000)
        sig = _fetch(UPDATE_URL + "/update.sig", 10_000).decode("ascii", "ignore").strip()
        if not verify_manifest(body, sig):
            log("update: manifest signature INVALID - ignored"); return False
        m = json.loads(body)
        new = str(m.get("version", ""))
        if _vtuple(new) <= _vtuple(VERSION): return False
        files = (m.get("mac") or {}).get("files") or {}
        if not isinstance(files, dict) or "lockqzd.py" not in files:
            log("update: manifest lists no Mac helper - ignored"); return False
        for name, want in files.items():
            if name in UPDATE_NEVER or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,80}", name) \
               or not re.fullmatch(r"[0-9a-f]{64}", str(want)):
                log("update: refusing file entry %r" % name); return False
        shutil.rmtree(stage, ignore_errors=True); os.makedirs(stage, mode=0o700)
        for name, want in files.items():
            data = _fetch(UPDATE_URL + "/mac/" + name)
            if hashlib.sha256(data).hexdigest() != want:
                log("update: SHA-256 mismatch for %s - ignored" % name); shutil.rmtree(stage, ignore_errors=True); return False
            with open(os.path.join(stage, name), "wb") as f: f.write(data)
        with LOCK:
            if STATE["state"] == "locked":
                log("update: quiz in progress - deferred"); shutil.rmtree(stage, ignore_errors=True); return False
            for name in files:
                dst = os.path.join(UPDATE_DIR, name)
                os.replace(os.path.join(stage, name), dst)
                os.chmod(dst, 0o755 if name.endswith((".sh", ".py")) else 0o644)
        shutil.rmtree(stage, ignore_errors=True)
        log("update: %s -> %s installed (%d files)" % (VERSION, new, len(files)))
        report("update", {"from": VERSION, "to": new})
        restart_after_update()
        return True
    except Exception as e:
        log("update check failed: %s" % e)
        shutil.rmtree(stage, ignore_errors=True)
        return False

def watcher():
    cycles = 0
    while True:
        time.sleep(5); cycles += 1
        do_auto = do_tamper = do_beat = False; qid = None
        # Decide inside the lock; do all network OUTSIDE it so a slow post never
        # stalls a /lock or /status request coming from the agent.
        with LOCK:
            if developer_mode():
                if STATE["state"] != "developer":
                    log("developer mode ON — not locking on this Mac")
                    STATE.update(state="developer", quiz_id=None, locked_at=None, locked_since=0.0)
                    engine("unlock"); clear_lock()
                elif STATE["quiz_id"]:
                    # Admin in a quiz: keep the signed lock alive so the quiz gate admits him.
                    qid = STATE["quiz_id"]; do_beat = (cycles % BEAT == 0)
            elif STATE["state"] == "developer":
                STATE.update(state="unlocked", quiz_id=None)
            if STATE["state"] == "locked":
                qid = STATE["quiz_id"]
                # hard-max safety: never leave a student locked
                if STATE["locked_since"] and (time.time() - STATE["locked_since"] > STATE["max_minutes"] * 60):
                    log("hard-max reached — auto-unlocking")
                    STATE.update(state="unlocked", quiz_id=None, locked_at=None, locked_since=0.0)
                    engine("unlock"); clear_lock(); do_auto = True
                else:
                    do_tamper = not engine_locked()
                    if do_tamper:
                        log("TAMPER: block missing during quiz — re-applying")
                    engine("lock")   # idempotent; re-kills reopened AI apps
                    do_beat = (cycles % BEAT == 0)   # liveness ping (default ~45s)
        if do_auto:   report("auto_unlock", {"quiz_id": qid, "reason": "max_minutes"}); continue
        if do_tamper: report("tamper", {"quiz_id": qid, "detail": "hosts_block_removed"})
        # Liveness ping: proves the helper is still running. If the student kills it
        # mid-quiz these stop, last_lock goes stale, and the teacher's live monitor
        # flags "helper killed". UPDATE-only on the server — tiny at finals scale.
        if do_beat:   report("heartbeat", {"quiz_id": qid, "source": "helper"})
        if cycles % 8640 == 0:   # ~every 12h — keeps API calls minimal
            refresh_blocklist()
        if cycles % 720 == 0 and not NET["registered"]:   # ~hourly until the server knows this key
            register()
        if cycles % UPDATE_EVERY == 0:   # ~every 6h: signed self-update (skips itself during a quiz)
            check_update()

class H(BaseHTTPRequestHandler):
    def _auth(self): return self.headers.get("X-LOCKqz-Token") == TOKEN
    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-LOCKqz-Token")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def _body(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        try: return json.loads(self.rfile.read(n) or b"{}")
        except Exception: return {}
    def do_OPTIONS(self): self._send(204, {})
    def log_message(self, *a): pass
    def do_GET(self):
        if not self._auth(): return self._send(401, {"error": "unauthorized"})
        if self.path == "/status":
            s = dict(STATE); s["version"] = VERSION; s["engine_locked"] = engine_locked(); s["dryrun"] = DRYRUN == "1"; s["developer"] = developer_mode()
            return self._send(200, s)
        self._send(404, {"error": "not found"})
    def do_POST(self):
        if not self._auth(): return self._send(401, {"error": "unauthorized"})
        body = self._body()
        if self.path == "/lock":
            if developer_mode():
                with LOCK:
                    STATE.update(state="developer", quiz_id=body.get("quiz_id"),
                                 student=body.get("student", STATE["student"]),
                                 locked_at=None, locked_since=0.0)
                    engine("unlock")
                # Signed "lock" flagged developer: the server admits ONLY the admin's account with it
                # (any other device sending this is shown as tamper and refused the password).
                report("lock", {"quiz_id": body.get("quiz_id"), "detail": {"developer": True}})
                return self._send(200, {"ok": True, "state": "developer", "developer": True})
            with LOCK:
                STATE.update(state="locked", quiz_id=body.get("quiz_id"),
                             student=body.get("student", STATE["student"]),
                             max_minutes=int(body.get("max_minutes", MAX_MIN)),
                             locked_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                             locked_since=time.time())
                engine("lock"); save_lock()
            report("lock")
            return self._send(200, {"ok": True, "state": "locked"})
        if self.path == "/unlock":
            with LOCK:
                qid = STATE["quiz_id"] or body.get("quiz_id")   # report WHICH quiz ended (live monitor "done")
                STATE.update(state="unlocked", quiz_id=None, locked_at=None, locked_since=0.0)
                engine("unlock"); clear_lock()
            report("unlock", {"quiz_id": qid})
            return self._send(200, {"ok": True, "state": "unlocked"})
        if self.path == "/student":
            with LOCK: STATE["student"] = body.get("student") or STATE["student"]
            report("install", {"platform": "mac-" + platform.mac_ver()[0], "version": VERSION})
            return self._send(200, {"ok": True, "student": STATE["student"]})
        if self.path == "/heartbeat":
            report("heartbeat", {"quiz_id": STATE["quiz_id"], "source": "agent", "detail": body})
            return self._send(200, {"ok": True})
        if self.path == "/password":
            # The quiz password is released only to this helper, only while it holds the lock for
            # THIS quiz with the block really in place, and only over a request signed with the
            # root-only device key. The agent (student's account) never talks to /api/password.
            url = str(body.get("url") or "")
            with LOCK:
                st, qid = STATE["state"], STATE["quiz_id"]
            if st not in ("locked", "developer") or qid != lock_id(url):
                return self._send(409, {"error": "not locked for this quiz"})
            if st == "locked" and not engine_ok():
                engine("lock")
                if not engine_ok():
                    report("tamper", {"quiz_id": qid, "detail": "block_missing_at_password"})
                    return self._send(409, {"error": "AI block is not in place"})
            report("heartbeat", {"quiz_id": qid, "source": "helper"})   # fresh signed proof of the lock
            code, j = call("/password", {"url": url, "device_id": DEVICE})
            pw = j.get("password") if isinstance(j, dict) else None
            return self._send(200 if pw else 502, {"password": pw, "status": code})
        if self.path == "/event":
            if body.get("event") != "quiz_left":
                return self._send(400, {"error": "event not allowed"})
            report("quiz_left", {"quiz_id": body.get("quiz_id"), "source": "agent", "detail": body.get("detail")})
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})

def startup_network():
    # Runs in the background so a slow/absent network never delays the control server.
    register()
    report("install", {"platform": "mac-" + platform.mac_ver()[0], "version": VERSION})
    refresh_blocklist()
    time.sleep(UPDATE_DELAY)
    check_update()

def main():
    rec = None if developer_mode() else load_lock()
    if rec:
        # Helper was killed or the Mac rebooted mid-quiz: stay locked, report it. The hard max still
        # auto-unlocks on time, so nobody is ever left locked.
        STATE.update(state="locked", quiz_id=rec["quiz_id"], student=rec.get("student") or STATE["student"],
                      locked_at=rec.get("locked_at"), locked_since=float(rec["locked_since"]),
                      max_minutes=int(rec.get("max_minutes") or MAX_MIN))
        engine("lock")
        log("resumed lock for %s after restart (tamper)" % rec["quiz_id"])
        threading.Thread(target=lambda: report("tamper", {"quiz_id": rec["quiz_id"], "detail": "helper_restarted_mid_quiz"}), daemon=True).start()
    else:
        engine("unlock")  # no live quiz: never stay locked across a restart
    threading.Thread(target=startup_network, daemon=True).start()
    threading.Thread(target=watcher, daemon=True).start()
    log("listening on 127.0.0.1:%d (v%s, dryrun=%s)" % (PORT, VERSION, DRYRUN))
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()

if __name__ == "__main__":
    main()
