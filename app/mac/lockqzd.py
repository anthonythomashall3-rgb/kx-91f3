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
VERSION = "0.4.9"
# Cloudflare blocks the default "Python-urllib" user agent (403) — always send our own.
UA = {"User-Agent": "LOCKqz/%s (macOS)" % VERSION}

def _int(v, default):
    try: return int(v)
    except Exception: return default

OLD_HOST, NEW_HOST = "lockdownqz.pages.dev", "lockqz.pages.dev"
PLACEHOLDER_IDS = ("", "unknown", "set-at-install")

def migrate_conf_text(raw):
    """-> (new text, changes). The only two config changes the helper ever makes itself:
    api_base on the retired lockdownqz.pages.dev address moves to lockqz.pages.dev, and a
    placeholder device id (a package whose postinstall failed) gets a fresh 'mac-<uuid>'.
    Every other key and value is kept as it is."""
    c = json.loads(raw)
    if not isinstance(c, dict): return raw, []
    changes = []
    if OLD_HOST in str(c.get("api_base") or ""):
        c["api_base"] = str(c["api_base"]).replace(OLD_HOST, NEW_HOST); changes.append("api_base")
    if str(c.get("device_id") or "").strip() in PLACEHOLDER_IDS:
        import uuid
        c["device_id"] = "mac-" + str(uuid.uuid4()); changes.append("device_id")
    return (json.dumps(c, indent=2) + "\n" if changes else raw), changes

def load_conf():
    for p in CONF_PATHS:
        try:
            with open(p) as f: raw = f.read()
            c = json.loads(raw)
        except Exception: continue
        try:
            new, changes = migrate_conf_text(raw)
            if changes:
                # world-readable on purpose (the per-user agent reads it; it holds no secret)
                _write_private(p, new, 0o644)
                print("LOCKqzd: config updated (%s)" % ", ".join(changes), flush=True)
                c = json.loads(new)
        except Exception as e:
            print("LOCKqzd: config migration skipped: %s" % e, flush=True)
        return c
    return {}

def _write_private(path, text, mode=0o600):
    """Atomic write of a root-owned file; never follows a symlink planted at the temp name."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    try: os.unlink(tmp)
    except FileNotFoundError: pass
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), mode)
    with os.fdopen(fd, "w") as f: f.write(text)
    os.chmod(tmp, mode)
    os.replace(tmp, path)

CONF = load_conf()
PORT    = int(CONF.get("port", 8787))
API     = CONF.get("api_base", "").rstrip("/")
if API and not API.endswith("/api"): API += "/api"   # accept a bare site URL too
DEVICE  = CONF.get("device_id", "unknown")
# Safety cap (OWNER DECISION, round 2): AI comes back the moment the quiz is submitted; the cap is
# only a failsafe for a broken agent. Quiz end known (from the server's /password answer) ->
# end + 15 min; unknown -> 6 h; never more than 24 h. (The old fixed 3-hour cap and the config's
# "max_minutes": 180 are gone; "cap_minutes" replaces the 6 h default, for tests only.)
CEIL_MIN = 1440
END_GRACE = 15 * 60
CAP_MIN = max(1, min(_int(CONF.get("cap_minutes", 360), 360), CEIL_MIN))   # cap while the end is unknown
MAX_MIN = CAP_MIN
BEAT    = max(1, _int(CONF.get("beat_cycles", 60), 60))
# Helper liveness ping, timed on the WALL CLOCK (a watcher cycle can take far longer than 5 s while
# the engine closes apps): ~300 s apart (free-plan budget); the server's STALE is 660 s.
BEAT_SECS = min(300, BEAT * 5)
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
# Quiz released by the safety cap or by the server (submitted / ended / other school) - root-only
# record: the agent is told not to re-lock it while its page stays open.
CAPFILE = os.path.join(os.path.dirname(LOCKFILE), "capped.json")
# A release is remembered at most this long (or until the agent reports the quiz page closed): after
# that the same quiz - a new attempt, a makeup - always locks again.
CAP_FORGET = max(60, _int(os.environ.get("LOCKQZ_CAP_FORGET", "1800"), 1800))
# Last "install" report (C6): sent again only when the version or student changed, or after 24 h.
INSTFILE = os.path.join(os.path.dirname(LOCKFILE), "install_report.json")

# Loopback control token: random per install, never baked into the package. The master copy is
# root-only (0600). Each console user gets a read-only copy in a root-owned folder (see
# share_token), so only root and the logged-in student's own agent can drive the helper.
TOKEN_FILE = os.environ.get("LOCKQZ_TOKEN_FILE") or "/Library/Application Support/LOCKqz/helper.token"
TOKEN_DIR = os.environ.get("LOCKQZ_TOKEN_DIR") or "/Library/Application Support/LOCKqz/tokens"
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{16,128}")

def load_token():
    try:
        with open(TOKEN_FILE) as f: t = f.read().strip()
        if TOKEN_RE.fullmatch(t): return t
    except FileNotFoundError: pass
    except Exception as e: print("LOCKqzd: token unreadable (%s) - making a new one" % e, flush=True)
    t = secrets.token_urlsafe(32)
    try: _write_private(TOKEN_FILE, t)
    except Exception as e: print("LOCKqzd: could not save control token: %s" % e, flush=True)
    return t

TOKEN = load_token()
_SHARED = {"uid": None}

def share_token(uid):
    """Give console user <uid> a read-only copy of the token: <TOKEN_DIR>/<uid>, owned by that uid,
    mode 0400, inside a root-owned 0755 folder. The path is built from a NUMBER only, the folder is
    root's, and the file is created fresh with O_EXCL|O_NOFOLLOW - nothing a user controls is followed."""
    if not isinstance(uid, int) or uid <= 0: return
    if _SHARED["uid"] == uid and os.path.isfile(os.path.join(TOKEN_DIR, str(uid))): return
    try:
        os.makedirs(TOKEN_DIR, mode=0o755, exist_ok=True)
        st = os.lstat(TOKEN_DIR)
        import stat as _stat
        if not _stat.S_ISDIR(st.st_mode) or (os.geteuid() == 0 and st.st_uid != 0):
            log("token folder is not a root-owned directory - not sharing"); return
        os.chmod(TOKEN_DIR, 0o755)
        dst, tmp = os.path.join(TOKEN_DIR, str(uid)), os.path.join(TOKEN_DIR, ".%d.tmp" % uid)
        try: os.unlink(tmp)
        except FileNotFoundError: pass
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o400)
        try:
            os.write(fd, TOKEN.encode())
            if os.geteuid() == 0: os.fchown(fd, uid, -1)
            os.fchmod(fd, 0o400)
        finally: os.close(fd)
        os.replace(tmp, dst)
        _SHARED["uid"] = uid
    except Exception as e:
        log("could not share the control token with uid %s: %s" % (uid, e))

def console_uid():
    try:
        out = subprocess.run(["stat", "-f", "%u", "/dev/console"], capture_output=True, text=True, timeout=5).stdout.strip()
        return int(out) if out.isdigit() else None
    except Exception:
        return None

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
PENDING = os.path.join(UPDATE_DIR, ".pending")   # "this update has not proven it starts yet" (see lockqz-boot.sh)
# Helper log (launchd's StandardOutPath). Rotated at 1 MB so it can never fill a disk.
LOGFILE = os.environ.get("LOCKQZ_LOG") or (os.path.join(HERE, "lockqzd.log") if UPDATE_OK else "")
LOG_MAX = int(os.environ.get("LOCKQZ_LOG_MAX", "1000000"))
# Files an update may never touch: this install's identity and live state.
UPDATE_NEVER = {"config.json", "device.key", "active_lock.json", "lockqzd.log", "developer.key",
                "helper.token", "tokens", "capped.json", "policy-backup", "applicationaccess.backup.plist",
                "applicationaccess.backup.plist.none", "hosts.backup", "status.json", "pf.enabled", "proxy.state",
                "install_report.json", "lockqzd.log.1"}

STATE = {"state": "unlocked", "quiz_id": None, "student": CONF.get("student"),
         "locked_at": None, "locked_since": 0.0, "max_minutes": MAX_MIN, "cap_at": 0.0, "end_known": False,
         "mono_since": None, "unlock_pending": False, "capped_quiz": None, "capped_at": 0.0, "capped_reason": None}
LOCK = threading.Lock()
QUIZ_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
UNLOCK_REASONS = {"quiz_submitted", "quiz_left", "quiz_tab_closed"}   # what the agent may say
SERVER_REASONS = {"quiz_submitted", "quiz_ended"}                     # C9: the server's unlock:true

def parse_iso(s):
    """ISO-8601 time from the server ('2026-10-25T21:00:00.000Z', '+00:00' offsets) -> unix seconds,
    or None. Written out by hand: Apple's python 3.9 fromisoformat() does not take 'Z'."""
    m = re.fullmatch(r"\s*(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d)(?:\.\d+)?)?\s*(Z|[+-]\d\d:?\d\d)?\s*", str(s or ""))
    if not m: return None
    import calendar
    y, mo, d, h, mi, sec = (int(x or 0) for x in m.groups()[:6])
    try: t = calendar.timegm((y, mo, d, h, mi, sec, 0, 0, 0))
    except Exception: return None
    z = m.group(7)
    if z and z != "Z":
        sign = -1 if z[0] == "-" else 1; z = z[1:].replace(":", "")
        t -= sign * (int(z[:2]) * 3600 + int(z[2:]) * 60)
    return float(t)

def cap_for_end(locked_since, end_epoch, now, skew=0.0):
    """New cap time for a lock once the server told us the quiz end (server clock), or None to keep
    the current cap. end + 15 min, never more than 24 h after the lock started. An end that is already
    over is ignored (the server's own quiz_ended unlock, C9, covers that case)."""
    if end_epoch is None or not locked_since: return None
    local_end = end_epoch - skew              # the server's clock -> this Mac's clock
    if local_end + END_GRACE <= now: return None
    return min(locked_since + CEIL_MIN * 60, local_end + END_GRACE)

def save_lock(pending=False):
    try:
        rec = {k: STATE[k] for k in ("quiz_id", "student", "locked_at", "locked_since", "max_minutes", "cap_at", "end_known")}
        if pending: rec["unlock_pending"] = True
        _write_private(LOCKFILE, json.dumps(rec))
    except Exception as e:
        log("could not save lock record: %s" % e)

def save_capped(qid, reason="cap"):
    STATE.update(capped_quiz=qid, capped_at=time.time(), capped_reason=reason)
    try: _write_private(CAPFILE, json.dumps({"quiz_id": qid, "at": STATE["capped_at"], "reason": reason}))
    except Exception as e: log("could not save cap record: %s" % e)

def forget_capped():
    """Caller holds LOCK (or is single-threaded at start)."""
    STATE.update(capped_quiz=None, capped_at=0.0, capped_reason=None)
    try: os.unlink(CAPFILE)
    except FileNotFoundError: pass
    except Exception as e: log("could not remove cap record: %s" % e)

def load_capped():
    try:
        with open(CAPFILE) as f: rec = json.load(f)
        at = float(rec.get("at") or 0)
        if isinstance(rec.get("quiz_id"), str) and 0 <= time.time() - at < CAP_FORGET:
            STATE.update(capped_quiz=rec["quiz_id"], capped_at=at, capped_reason=str(rec.get("reason") or "cap")[:32])
    except Exception:
        pass

def clear_lock():
    try: os.remove(LOCKFILE)
    except FileNotFoundError: pass
    except Exception as e: log("could not clear lock record: %s" % e)

def load_lock():
    """An unexpired saved lock, or None. Expired/corrupt records are discarded."""
    try:
        with open(LOCKFILE) as f: rec = json.load(f)
        if rec.get("unlock_pending"): return None      # an unlock that did not finish: finish it, never re-lock
        since = float(rec.get("locked_since") or 0)
        try: cap_at = float(rec.get("cap_at") or 0)
        except Exception: cap_at = 0.0
        if cap_at <= since:   # a record without a cap time (0.4.0): its own max_minutes, at most the unknown-end cap
            cap_at = since + max(1, min(_int(rec.get("max_minutes") or CAP_MIN, CAP_MIN), CAP_MIN)) * 60
        cap_at = min(cap_at, since + CEIL_MIN * 60)
        now = time.time()
        if rec.get("quiz_id") and since and 0 <= now - since and now < cap_at:
            rec["cap_at"], rec["max_minutes"] = cap_at, int((cap_at - since) // 60)
            rec["end_known"] = bool(rec.get("end_known"))
            return rec
    except FileNotFoundError:
        return None
    except Exception:
        pass
    return None

def engine(cmd):
    """Run the engine; True when it reported success (dry-run: always)."""
    try:
        r = subprocess.run(["bash", ENGINE, cmd], check=False, capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            log("engine %s exited %s: %s" % (cmd, r.returncode, (r.stderr or r.stdout or "").strip()[-300:]))
        return r.returncode == 0
    except Exception as e:
        log("engine error: %s" % e)
        return False

def unlock_now(qid):
    """Strip the block. The lock record is cleared ONLY when the engine confirms every layer is gone;
    otherwise the record is marked unlock_pending (a restart finishes the unlock, never re-locks) and
    the watcher retries every cycle. Caller holds LOCK."""
    STATE.update(state="unlocked", quiz_id=None, locked_at=None, locked_since=0.0)
    ok = engine("unlock")
    if ok:
        STATE["unlock_pending"] = False; clear_lock()
    else:
        STATE["unlock_pending"] = True
        save_lock(pending=True)
        log("unlock did not complete - will retry")
    return ok

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

# Dry-run (tests) never signs with this install's real key: otherwise `sudo LOCKQZ_DRYRUN=1 lockqzd.py`
# would send real, signed lock/heartbeats while blocking nothing.
KEY = secrets.token_hex(32) if DRYRUN == "1" and not os.environ.get("LOCKQZ_KEY_PATH") else device_key()

def lock_id(url):
    """Same rule as the agent and the server: '<ou>-<qi>' from the quiz URL's own ?ou= / &qi= parameters."""
    qi = re.search(r"[?&]qi=(\d+)", url or ""); ou = re.search(r"[?&]ou=(\d+)", url or "")
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
            # O_NOFOLLOW: never follow a symlink (a student could point it at /dev/zero or a fifo).
            fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0))
            try:
                st = os.fstat(fd)
                import stat as _stat
                if not _stat.S_ISREG(st.st_mode) or st.st_size > 256: continue
                data = os.read(fd, 256)
            finally:
                os.close(fd)
            if hashlib.sha256(data.strip()).hexdigest() == DEV_KEY_HASH:
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
    """Signed report. Returns (status, reply). A heartbeat/lock reply may carry the server's
    {unlock:true, reason:"quiz_submitted"|"quiz_ended"} (C9): the helper then unlocks at once.
    Never call this while holding LOCK (server_release takes it)."""
    body = {"device_id": DEVICE, "event": event, "quiz_id": STATE["quiz_id"],
            "student": STATE["student"], "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if extra: body.update(extra)
    code, j = call("/report", body)
    if event not in ("unlock", "install", "update") and isinstance(j, dict) and j.get("unlock") is True:
        server_release(body.get("quiz_id"), j.get("reason"))
    return code, j

def server_release(qid, reason):
    """The server says this student's quiz is over (submitted per the professor's Sync, or its end has
    passed): unlock now and tell the agent not to re-lock it. Only for the quiz that is locked."""
    reason = reason if reason in SERVER_REASONS else "quiz_ended"
    with LOCK:
        if STATE["state"] != "locked" or not qid or STATE["quiz_id"] != qid: return False
        log("server says %s is over (%s) - unlocking" % (qid, reason))
        save_capped(qid, reason)
        unlock_now(qid)
    report("unlock", {"quiz_id": qid, "detail": {"reason": reason}})
    return True

LOCK_SENT = {"qid": None, "ev": threading.Event(), "ok": False}

def report_lock_async(qid, extra=None):
    """The lock report, in the background (the agent gets its answer at once), remembered so that the
    first /password for this quiz can wait for it: the server only releases a password to a device
    whose lock it has seen, and no separate heartbeat precedes /password any more (C1)."""
    ev = threading.Event()
    LOCK_SENT.update(qid=qid, ev=ev, ok=False, extra=extra)
    def run():
        try:
            code, _ = report("lock", extra)
            if LOCK_SENT["ev"] is ev: LOCK_SENT["ok"] = code == 200
        finally:
            ev.set()
    threading.Thread(target=run, daemon=True).start()

def ensure_lock_reported(qid):
    """Before a /password call: wait for this quiz's lock report; resend it once if it did not get through."""
    if LOCK_SENT["qid"] != qid: return
    LOCK_SENT["ev"].wait(15)
    if LOCK_SENT["qid"] == qid and not LOCK_SENT["ok"]:
        code, _ = report("lock", LOCK_SENT.get("extra"))
        if LOCK_SENT["qid"] == qid: LOCK_SENT["ok"] = code == 200

def report_async(event, extra=None):
    # Reply to the agent first; send the server report in the background so a slow network never makes
    # a successful lock/unlock look like a failure to the agent (which would then never unlock).
    threading.Thread(target=lambda: report(event, extra), daemon=True).start()

def install_due(rec, version, student, now):
    """C6: send the 'install' report only when the version or the student changed, or 24 h passed."""
    if not isinstance(rec, dict): return True
    try: at = float(rec.get("at") or 0)
    except Exception: at = 0.0
    return rec.get("version") != version or rec.get("student") != student or not (0 <= now - at < 86400)

def report_install():
    try:
        with open(INSTFILE) as f: rec = json.load(f)
    except Exception:
        rec = None
    student = STATE["student"]
    if not install_due(rec, VERSION, student, time.time()): return False
    code, _ = report("install", {"platform": "mac-" + platform.mac_ver()[0], "version": VERSION})
    if code == 200:
        try: _write_private(INSTFILE, json.dumps({"version": VERSION, "student": student, "at": time.time()}))
        except Exception as e: log("could not save install record: %s" % e)
    return code == 200

def refresh_blocklist():
    if not API: return
    try:
        # Static copy first (free on Cloudflare Pages: no Functions request), the API as a fallback.
        doms = []
        for u in ([SITE + "/blocklist.json"] if SITE else []) + [API + "/blocklist"]:
            try:
                r = urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=8, context=ssl.create_default_context())
                doms = json.loads(r.read()).get("domains", [])
                if doms: break
            except Exception as e:
                log("blocklist %s: %s" % (u, e))
        # Validate before trusting: must be a healthy list of well-formed hosts, and
        # must still contain the anchors. A bad/empty download never wipes the list.
        # host names AND host/path entries (bing.com/chat): the browser policy enforces the paths
        clean = [d.strip() for d in doms if isinstance(d, str) and
                 re.fullmatch(r"[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(/[A-Za-z0-9._~%/-]*)?", d.strip() or "")]
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
                tmp = BLOCKLIST + ".tmp"
                with open(tmp, "w") as f:
                    f.write("# LOCKqz AI blocklist - shipped list plus additions from the server %s\n" % time.strftime("%Y-%m-%d"))
                    f.write("\n".join(merged) + "\n")
                os.replace(tmp, BLOCKLIST)   # atomic: readers see either the old list or the full new one
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

def rotate_log():
    """Keep the helper's log under LOG_MAX: move it to lockqzd.log.1 and point this process's
    stdout/stderr (launchd's StandardOutPath) at a fresh file. Only when stdout really is that file."""
    if not LOGFILE: return False
    try:
        st = os.stat(LOGFILE)
        if st.st_size <= LOG_MAX: return False
        out = os.fstat(1)
        if (out.st_dev, out.st_ino) != (st.st_dev, st.st_ino): return False
        os.replace(LOGFILE, LOGFILE + ".1")
        fd = os.open(LOGFILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0), 0o644)
        os.dup2(fd, 1); os.dup2(fd, 2); os.close(fd)
        log("log rotated")
        return True
    except Exception:
        return False

def self_check():
    """A freshly updated helper proves it starts: once its own control server answers /status with
    this version, the .pending marker is removed and lockqz-boot.sh will not roll the update back."""
    if not os.path.exists(PENDING): return
    for _ in range(30):
        time.sleep(2)
        try:
            req = urllib.request.Request("http://127.0.0.1:%d/status" % PORT, headers={"X-LOCKqz-Token": TOKEN})
            s = json.loads(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=10).read())
            if s.get("version") == VERSION:
                os.remove(PENDING); log("update confirmed: %s answers /status" % VERSION); return
        except Exception:
            pass

def check_update():
    """Signed self-update; only while no quiz is locked. Returns True when an update was installed.
    A bad signature, hash, file name or download leaves the install untouched. Never raises."""
    if not UPDATE_OK or not UPDATE_URL or not os.path.isfile(PUBKEY): return False
    # Never download during a quiz (no traffic, no CPU, nothing swapped while the student works).
    if STATE["state"] != "unlocked" or STATE["quiz_id"]: return False
    stage = os.path.join(UPDATE_DIR, ".update")
    try:
        body = _fetch(UPDATE_URL + "/update.json", 200_000)
        sig = _fetch(UPDATE_URL + "/update.sig", 10_000).decode("ascii", "ignore").strip()
        if not verify_manifest(body, sig):
            log("update: manifest signature INVALID - ignored"); return False
        m = json.loads(body)
        new = str(m.get("version", ""))
        if _vtuple(new) <= _vtuple(VERSION): return False
        try:
            with open(os.path.join(UPDATE_DIR, ".bad_version")) as f: bad = f.read().strip()
        except Exception: bad = ""
        if bad and bad == new:
            return False   # this release failed to start here and was rolled back; wait for the next one
        files = (m.get("mac") or {}).get("files") or {}
        if not isinstance(files, dict) or "lockqzd.py" not in files:
            log("update: manifest lists no Mac helper - ignored"); return False
        for name, want in files.items():
            if name in UPDATE_NEVER or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,80}", name) \
               or not re.fullmatch(r"[0-9a-f]{64}", str(want)) \
               or os.path.isdir(os.path.join(UPDATE_DIR, name)) or os.path.islink(os.path.join(UPDATE_DIR, name)):
                log("update: refusing file entry %r" % name); return False
        shutil.rmtree(stage, ignore_errors=True); os.makedirs(stage, mode=0o700)
        for name, want in files.items():
            data = _fetch(UPDATE_URL + "/mac/" + name)
            if hashlib.sha256(data).hexdigest() != want:
                log("update: SHA-256 mismatch for %s - ignored" % name); shutil.rmtree(stage, ignore_errors=True); return False
            with open(os.path.join(stage, name), "wb") as f: f.write(data)
        with LOCK:
            if STATE["state"] != "unlocked" or STATE["quiz_id"]:
                log("update: quiz in progress - deferred"); shutil.rmtree(stage, ignore_errors=True); return False
            # Rollback kit (lockqz-boot.sh uses it): the files this update replaces, the names it adds,
            # and a .pending marker the NEW helper clears once it answers /status. A helper that keeps
            # failing to start is put back to these files after 3 starts.
            prev = os.path.join(UPDATE_DIR, ".prev")
            shutil.rmtree(prev, ignore_errors=True); os.makedirs(prev, mode=0o700)
            added = []
            for name in files:
                cur = os.path.join(UPDATE_DIR, name)
                if os.path.isfile(cur): shutil.copy2(cur, os.path.join(prev, name))
                else: added.append(name)
            _write_private(os.path.join(prev, ".added"), "".join(n + "\n" for n in added))
            _write_private(PENDING, "from=%s\nto=%s\nstarts=0\n" % (VERSION, new))
            for name in files:
                dst = os.path.join(UPDATE_DIR, name)
                os.replace(os.path.join(stage, name), dst)
                os.chmod(dst, 0o755 if name.endswith((".sh", ".py")) else 0o644)
        shutil.rmtree(stage, ignore_errors=True)
        try:
            with open(os.path.join(UPDATE_DIR, ".updated"), "w") as f: f.write(new)
        except Exception: pass
        log("update: %s -> %s installed (%d files)" % (VERSION, new, len(files)))
        report("update", {"from": VERSION, "to": new})
        restart_after_update()
        return True
    except Exception as e:
        log("update check failed: %s" % e)
        shutil.rmtree(stage, ignore_errors=True)
        return False

def watcher():
    cycles, last_beat = 0, time.time()
    while True:
        time.sleep(5); cycles += 1
        do_cap = do_tamper = do_beat = cap_end_known = False; qid = None
        share_token(console_uid())   # the student who is logged in now can reach the helper
        # Decide inside the lock; do all network OUTSIDE it so a slow post never
        # stalls a /lock or /status request coming from the agent.
        with LOCK:
            if developer_mode():
                if STATE["state"] != "developer":
                    log("developer mode ON — not locking on this Mac")
                    unlock_now(STATE["quiz_id"])
                    STATE["state"] = "developer"
                elif STATE["quiz_id"]:
                    # Admin in a quiz: keep the signed lock alive so the quiz gate admits him.
                    qid = STATE["quiz_id"]; do_beat = time.time() - last_beat >= BEAT_SECS
            elif STATE["state"] == "developer":
                STATE.update(state="unlocked", quiz_id=None)
            if STATE["state"] == "locked":
                qid = STATE["quiz_id"]
                # safety cap (quiz end + 15 min, or 6 h when the end is unknown, never > 24 h): a
                # failsafe for a broken agent - normally AI comes back the moment the quiz is submitted.
                cap_at = STATE["cap_at"] or (STATE["locked_since"] + STATE["max_minutes"] * 60)
                # Wall clock AND monotonic clock must both say the cap is reached: an admin who moves the
                # Mac's date forward 24 h must not end the lock (time.monotonic() ignores date changes).
                mono_ok = STATE.get("mono_since") is None or time.monotonic() - STATE["mono_since"] >= cap_at - STATE["locked_since"]
                if STATE["locked_since"] and time.time() >= cap_at and mono_ok:
                    log("safety cap reached — auto-unlocking")
                    cap_end_known = STATE["end_known"]
                    save_capped(qid)
                    unlock_now(qid); do_cap = True
                else:
                    do_tamper = not engine_locked()
                    if do_tamper:
                        log("TAMPER: block missing during quiz — re-applying")
                    engine("lock")   # idempotent; re-kills reopened AI apps
                    do_beat = time.time() - last_beat >= BEAT_SECS
            elif STATE["unlock_pending"]:
                # An earlier unlock failed part-way: keep trying until every layer is really gone.
                if engine("unlock"):
                    STATE["unlock_pending"] = False; clear_lock(); log("pending unlock completed")
        if do_cap:    report("unlock", {"quiz_id": qid, "detail": {"reason": "cap", "end_known": cap_end_known}}); continue
        if do_tamper: report("tamper", {"quiz_id": qid, "detail": "hosts_block_removed"})
        # Liveness ping: proves the helper is still running. If the student kills it
        # mid-quiz these stop, last_lock goes stale, and the teacher's live monitor
        # flags "helper killed". UPDATE-only on the server — tiny at finals scale.
        if do_beat:
            last_beat = time.time()
            report("heartbeat", {"quiz_id": qid, "source": "helper"})
        if cycles % 8640 == 0:   # ~every 12h — keeps API calls minimal
            refresh_blocklist()
        if cycles % 720 == 0:    # ~hourly: keep the helper log small
            rotate_log()
        if cycles % 720 == 0 and not NET["registered"]:   # ~hourly until the server knows this key
            register()
        if cycles % UPDATE_EVERY == 0:   # ~every 6h: signed self-update (skips itself during a quiz)
            check_update()

def _qid(v):
    """A quiz id from the agent, or None. Only short [A-Za-z0-9_-] ids are stored or reported."""
    return v if isinstance(v, str) and QUIZ_ID_RE.fullmatch(v) else None

def _student(v, fallback):
    return str(v)[:200] if isinstance(v, str) and v.strip() else fallback

class H(BaseHTTPRequestHandler):
    # No CORS headers and no OPTIONS handler: a web page can never pass a preflight, so it cannot
    # send the token header to this server. The Host check also refuses DNS-rebinding requests.
    def _auth(self):
        host = (self.headers.get("Host") or "").lower()
        if host not in ("127.0.0.1:%d" % PORT, "localhost:%d" % PORT): return False
        if self.headers.get("Origin"): return False      # browsers always send Origin; the agent never does
        return hmac.compare_digest(str(self.headers.get("X-LOCKqz-Token") or ""), TOKEN)
    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def _body(self):
        n = _int(self.headers.get("Content-Length", 0) or 0, 0)
        if n < 0 or n > 65536: return {}
        try:
            j = json.loads(self.rfile.read(n) or b"{}")
            return j if isinstance(j, dict) else {}
        except Exception: return {}
    def log_message(self, *a): pass
    def do_GET(self):
        if not self._auth(): return self._send(401, {"error": "unauthorized"})
        if self.path == "/status":
            s = dict(STATE)   # no LOCK: an engine run can hold it for seconds; a snapshot is enough
            s["version"] = VERSION; s["engine_locked"] = engine_locked(); s["dryrun"] = DRYRUN == "1"; s["developer"] = developer_mode()
            # A quiz released by the safety cap or by the server (within 30 min, until the agent says its
            # page closed - /uncap): the agent must not re-lock it while the student is still on it.
            if not (s.get("capped_quiz") and 0 <= time.time() - float(s.get("capped_at") or 0) < CAP_FORGET):
                s["capped_quiz"] = None; s["capped_reason"] = None
            return self._send(200, s)
        self._send(404, {"error": "not found"})
    def do_POST(self):
        if not self._auth(): return self._send(401, {"error": "unauthorized"})
        try:
            return self._post(self._body())
        except Exception as e:   # never drop the connection without an answer
            log("request %s failed: %s" % (self.path, e))
            return self._send(500, {"error": "internal"})
    def _post(self, body):
        if self.path == "/lock":
            qid = _qid(body.get("quiz_id"))
            if not qid: return self._send(400, {"error": "bad quiz_id"})
            # Starts with the unknown-end cap (6 h); a caller may only ask for LESS. The server's quiz end
            # (in the /password answer) then sets it to end + 15 min.
            mx = max(1, min(_int(body.get("max_minutes", MAX_MIN), MAX_MIN), MAX_MIN))
            if developer_mode():
                with LOCK:
                    unlock_now(STATE["quiz_id"])
                    STATE.update(state="developer", quiz_id=qid,
                                 student=_student(body.get("student"), STATE["student"]))
                # Signed "lock" flagged developer: the server admits ONLY the admin's account with it
                # (any other device sending this is shown as tamper and refused the password).
                report_lock_async(qid, {"quiz_id": qid, "detail": {"developer": True}})
                return self._send(200, {"ok": True, "state": "developer", "developer": True})
            with LOCK:
                same = STATE["state"] == "locked" and STATE["quiz_id"] == qid
                STATE.update(state="locked", quiz_id=qid, unlock_pending=False,
                             student=_student(body.get("student"), STATE["student"]))
                if not same:   # a repeat /lock for the running quiz never extends the cap
                    now = time.time()
                    STATE.update(max_minutes=mx, locked_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                 locked_since=now, cap_at=now + mx * 60, end_known=False, mono_since=time.monotonic())
                if STATE["capped_quiz"] == qid: forget_capped()
                save_lock(); engine("lock")
            report_lock_async(qid)
            return self._send(200, {"ok": True, "state": "locked"})
        if self.path == "/unlock":
            reason = body.get("reason") if body.get("reason") in UNLOCK_REASONS else "local_request"
            with LOCK:
                qid = STATE["quiz_id"] or _qid(body.get("quiz_id"))   # report WHICH quiz ended (live monitor "done")
                ok = unlock_now(qid) if STATE["state"] != "developer" else (STATE.update(state="unlocked", quiz_id=None) or True)
            report_async("unlock", {"quiz_id": qid, "detail": {"reason": reason}})
            if not ok:
                return self._send(500, {"ok": False, "state": "unlocking", "error": "unlock incomplete - retrying"})
            return self._send(200, {"ok": True, "state": "unlocked"})
        if self.path == "/student":
            with LOCK: STATE["student"] = _student(body.get("student"), STATE["student"])
            threading.Thread(target=report_install, daemon=True).start()   # only if new version/student or 24 h (C6)
            return self._send(200, {"ok": True, "student": STATE["student"]})
        if self.path == "/verify":
            # One-time student email setup (status | check | send | code), signed with the device key
            # so an email can only ever be bound to THIS computer.
            op = str(body.get("op") or "")
            if op not in ("status", "check", "send", "code", "token"): return self._send(400, {"error": "bad op"})
            req = {"op": op, "device_id": DEVICE}
            for k in ("email", "code", "vtoken"):
                if body.get(k) is not None: req[k] = str(body[k])[:200]
            code, j = call("/verify", req)
            out = dict(j) if isinstance(j, dict) else {}
            if out.get("verified"):
                with LOCK: STATE["student"] = _student(out.get("student"), None) or req.get("email") or STATE["student"]
            out["status"] = code
            return self._send(200, out)
        if self.path == "/heartbeat":
            report("heartbeat", {"quiz_id": STATE["quiz_id"], "source": "agent", "detail": body})
            return self._send(200, {"ok": True})
        if self.path == "/password":
            # The quiz password is released only to this helper, only while it holds the lock for
            # THIS quiz with the block really in place, and only over a request signed with the
            # root-only device key. The agent (student's account) never talks to /api/password.
            url = str(body.get("url") or "")[:2000]
            with LOCK:
                st, qid = STATE["state"], STATE["quiz_id"]
            if st not in ("locked", "developer") or qid != lock_id(url):
                return self._send(409, {"error": "not locked for this quiz"})
            if st == "locked" and not engine_ok():
                engine("lock")
                if not engine_ok():
                    report("tamper", {"quiz_id": qid, "detail": "block_missing_at_password"})
                    return self._send(409, {"error": "AI block is not in place"})
            # The signed /password call itself refreshes this device's lock row on the server (C1): no
            # separate heartbeat first - only the lock report itself must have arrived.
            ensure_lock_reported(qid)
            code, j = call("/password", {"url": url, "device_id": DEVICE})
            j = j if isinstance(j, dict) else {}
            pw = j.get("password") if isinstance(j.get("password"), str) else None
            pay = j.get("pay") if isinstance(j.get("pay"), dict) else None
            out = {"password": pw, "status": code, "pay": pay}
            reason = j.get("reason") if isinstance(j.get("reason"), str) else None
            if isinstance(j.get("recheck"), (int, float)): out["recheck"] = j["recheck"]   # gated: next code change
            if code in (0, 502, 503) or j.get("error") == "server_busy": out["error"] = "server_busy"   # agent backs off
            if code == 200 and pw:
                # C2: the server names the quiz end -> the safety cap becomes end + 15 min (<= 24 h).
                with LOCK:
                    if STATE["state"] == "locked" and STATE["quiz_id"] == qid:
                        c = cap_for_end(STATE["locked_since"], parse_iso(j.get("end")), time.time(), NET["skew"])
                        if c:
                            STATE.update(cap_at=c, end_known=True, max_minutes=int((c - STATE["locked_since"]) // 60))
                            save_lock()
            elif code == 403 and reason == "not started":
                st = parse_iso(j.get("start"))
                out.update(reason=reason, start=j.get("start"),
                           start_in=(max(0, int(st - (time.time() + NET["skew"]))) if st else None))
            elif code == 403 and reason == "other_school":
                # C10: this Brightspace is not a LOCKqz school; nothing to protect -> AI back now.
                out["reason"] = reason
                with LOCK:
                    if STATE["state"] == "locked" and STATE["quiz_id"] == qid:
                        save_capped(qid, "other_school"); unlock_now(qid)
                    else: qid = None
                if qid: report_async("unlock", {"quiz_id": qid, "detail": {"reason": "other_school"}})
            elif code == 402 and reason:
                out["reason"] = reason   # "verify": the student must confirm their school email first
            return self._send(200 if (pw or pay or out.get("reason")) else 502, out)
        if self.path == "/uncap":
            # The agent saw the released quiz's page closed (or a new attempt start): it may lock again.
            qid = _qid(body.get("quiz_id"))
            with LOCK:
                if qid and STATE["capped_quiz"] == qid: forget_capped()
            return self._send(200, {"ok": True})
        if self.path == "/event":
            if body.get("event") != "quiz_left":
                return self._send(400, {"error": "event not allowed"})
            det = body.get("detail")
            report("quiz_left", {"quiz_id": _qid(body.get("quiz_id")), "source": "agent",
                                 "detail": str(det)[:100] if det is not None else None})
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})

def startup_network():
    # Runs in the background so a slow/absent network never delays the control server.
    register()
    report_install()   # C6: only when the version/student changed or 24 h passed (persisted)
    refresh_blocklist()
    time.sleep(UPDATE_DELAY)
    check_update()

def main():
    load_capped()
    try:
        with open(LOCKFILE) as f: pend = bool(json.load(f).get("unlock_pending"))
    except Exception:
        pend = False
    rec = None if developer_mode() else load_lock()
    if rec:
        # Helper was killed or the Mac rebooted mid-quiz: stay locked, report it. The hard max still
        # auto-unlocks on time, so nobody is ever left locked.
        STATE.update(state="locked", quiz_id=rec["quiz_id"], student=rec.get("student") or STATE["student"],
                      locked_at=rec.get("locked_at"), locked_since=float(rec["locked_since"]),
                      max_minutes=rec["max_minutes"], cap_at=rec["cap_at"], end_known=rec["end_known"],
                      mono_since=time.monotonic() - max(0.0, time.time() - float(rec["locked_since"])))
        engine("lock")
        # A restart from our own signed self-update is expected, not tampering. The updater drops a
        # marker; consume it and report a benign "resumed" instead of "tamper".
        updated = os.path.exists(os.path.join(UPDATE_DIR, ".updated"))
        try:
            if updated: os.remove(os.path.join(UPDATE_DIR, ".updated"))
        except Exception: pass
        log("resumed lock for %s after restart" % rec["quiz_id"])
        ev = "resumed" if updated else "tamper"
        detail = "resumed_after_update" if updated else "helper_restarted_mid_quiz"
        threading.Thread(target=lambda: report(ev, {"quiz_id": rec["quiz_id"], "detail": detail}), daemon=True).start()
    else:
        # No live quiz (none, expired, or an unlock that never finished): never stay locked across a
        # restart. The record is cleared only once the engine confirms the block is gone.
        if engine("unlock"): clear_lock()
        else:
            STATE["unlock_pending"] = True
            if not pend: save_lock(pending=True)
            log("startup unlock did not complete - will retry")
    share_token(console_uid())
    rotate_log()
    threading.Thread(target=startup_network, daemon=True).start()
    threading.Thread(target=watcher, daemon=True).start()
    threading.Thread(target=self_check, daemon=True).start()   # clears an update's .pending marker
    log("listening on 127.0.0.1:%d (v%s, dryrun=%s)" % (PORT, VERSION, DRYRUN))
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()

if __name__ == "__main__":
    main()
