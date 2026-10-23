#!/usr/bin/env python3
"""LOCKqz daemon (macOS). Runs as root via launchd.

- Loopback control server on 127.0.0.1 for the per-user LOCKqz agent:
    POST /lock {"quiz_id","student","max_minutes"}  -> engine lock, begin watching
    POST /unlock {"quiz_id"}                         -> engine unlock
    GET  /status                                     -> current state
    POST /student {"student"}                        -> name shown on the teacher roster
    POST /heartbeat {...}                            -> forwarded to Cloudflare
  All requests must carry header  X-LOCKqz-Token: <token from config>.
- Watcher: while a quiz is locked, re-applies the block every few seconds, reports
  tampering, refreshes the blocklist hourly, and AUTO-UNLOCKS at a hard maximum so a
  student is never left locked.
- Set LOCKQZ_DRYRUN=1 in the environment to run unprivileged for testing (the engine
  makes no system changes).
"""
import hashlib, json, os, platform, ssl, subprocess, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.join(HERE, "lockqz.sh")
BLOCKLIST = os.path.join(HERE, "blocklist.txt")
CONF_PATHS = ([os.environ["LOCKQZ_CONFIG"]] if os.environ.get("LOCKQZ_CONFIG") else []) + \
             ["/Library/Application Support/LOCKqz/config.json",
              os.path.join(HERE, "config.json")]
VERSION = "0.2.0"
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

STATE = {"state": "unlocked", "quiz_id": None, "student": CONF.get("student"),
         "locked_at": None, "locked_since": 0.0, "max_minutes": MAX_MIN}
LOCK = threading.Lock()

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

def post(path, body):
    # Retry a few times so a brief network blip during an exam never drops a
    # lock/unlock/tamper report. Best-effort; never raises.
    if not API: return None
    for attempt in range(3):
        try:
            req = urllib.request.Request(API + path, data=json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json", **UA})
            return urllib.request.urlopen(req, timeout=8, context=ssl.create_default_context())
        except Exception as e:
            if attempt == 2:
                log("post %s failed after retries: %s" % (path, e)); return None
            time.sleep(2 * (attempt + 1))

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
            with open(BLOCKLIST, "w") as f:
                f.write("# auto-updated from Cloudflare %s\n" % time.strftime("%Y-%m-%d"))
                f.write("\n".join(clean) + "\n")
            log("blocklist refreshed (%d domains)" % len(clean))
        else:
            log("blocklist refresh rejected (failed sanity check) — keeping current list")
    except Exception as e:
        log("blocklist refresh failed: %s" % e)

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
                    engine("unlock")
            elif STATE["state"] == "developer":
                STATE.update(state="unlocked", quiz_id=None)
            if STATE["state"] == "locked":
                qid = STATE["quiz_id"]
                # hard-max safety: never leave a student locked
                if STATE["locked_since"] and (time.time() - STATE["locked_since"] > STATE["max_minutes"] * 60):
                    log("hard-max reached — auto-unlocking")
                    STATE.update(state="unlocked", quiz_id=None, locked_at=None, locked_since=0.0)
                    engine("unlock"); do_auto = True
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
                report("developer_mode", {"quiz_id": body.get("quiz_id"),
                                          "detail": "admin developer mode — AI not locked"})
                return self._send(200, {"ok": True, "state": "developer", "developer": True})
            with LOCK:
                STATE.update(state="locked", quiz_id=body.get("quiz_id"),
                             student=body.get("student", STATE["student"]),
                             max_minutes=int(body.get("max_minutes", MAX_MIN)),
                             locked_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                             locked_since=time.time())
                engine("lock")
            report("lock")
            return self._send(200, {"ok": True, "state": "locked"})
        if self.path == "/unlock":
            with LOCK:
                STATE.update(state="unlocked", quiz_id=None, locked_at=None, locked_since=0.0)
                engine("unlock")
            report("unlock")
            return self._send(200, {"ok": True, "state": "unlocked"})
        if self.path == "/student":
            with LOCK: STATE["student"] = body.get("student") or STATE["student"]
            report("install", {"platform": "mac-" + platform.mac_ver()[0], "version": VERSION})
            return self._send(200, {"ok": True, "student": STATE["student"]})
        if self.path == "/heartbeat":
            report("heartbeat", {"detail": body})
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})

def startup_network():
    # Runs in the background so a slow/absent network never delays the control server.
    report("install", {"platform": "mac-" + platform.mac_ver()[0], "version": VERSION})
    refresh_blocklist()

def main():
    engine("unlock")  # fail safe: never locked across a restart
    threading.Thread(target=startup_network, daemon=True).start()
    threading.Thread(target=watcher, daemon=True).start()
    log("listening on 127.0.0.1:%d (v%s, dryrun=%s)" % (PORT, VERSION, DRYRUN))
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()

if __name__ == "__main__":
    main()
