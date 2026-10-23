#!/usr/bin/env python3
"""LOCKqz agent (macOS). Per-user LaunchAgent. Replaces the browser extension, so the
student installs ONE thing and nothing comes from the Chrome Web Store.

Every 2 s it reads the open tab URLs of every running browser (Chrome, Edge, Brave,
Chromium, Vivaldi, Arc, Safari via Apple Events; Firefox via its session file) and:
  * on a Brightspace quiz attempt page  -> tells the root helper to LOCK, fetches the
    quiz password from the LOCKqz backend, shows it and copies it to the clipboard
  * while locked                        -> pings the backend (live monitor), and forces
    any Google/Bing/DDG/... search tab onto Google "Web" results (no AI answer) —
    the backstop for Safari, which has no policy layer
  * when the quiz page is gone (submitted / left) -> tells the helper to UNLOCK
First run asks the student's name once so the teacher's roster shows who is locked.
"""
import hashlib, json, os, re, subprocess, threading, time, urllib.request, urllib.parse, glob

SYS_CONF = "/Library/Application Support/LOCKqz/config.json"
USER_DIR = os.path.expanduser("~/Library/Application Support/LOCKqz")
USER_CONF = os.path.join(USER_DIR, "student.json")
POLL, POLL_LOCKED, GRACE, BEAT = 2, 1, 30, 45
DEV_KEY = os.path.join(USER_DIR, "developer.key")
DEV_KEY_HASH = "4695a520432e105e967dd2703366c24c039fe0a850fe35db03b73b6b9506aecd"

def developer_mode():
    """True only when this Mac holds the admin developer key. Students have no key file
    and cannot forge one from the shipped hash, so for them this is always False and
    LOCKqz locks during every quiz."""
    try:
        return hashlib.sha256(open(DEV_KEY, "rb").read().strip()).hexdigest() == DEV_KEY_HASH
    except Exception:
        return False

QUIZ_RE = re.compile(r"/d2l/lms/quizzing/user/", re.I)
LEAVING_RE = re.compile(r"quizzes_list|quiz_submissions|feedback|results|submission", re.I)
WEB_OK_UDM = {"14", "2", "12", "7", "36"}
WEB_OK_TBM = {"isch", "nws", "vid", "bks"}
JXA_BROWSERS = ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium", "Vivaldi", "Arc", "Safari"]

def log(m): print("LOCKqz-agent:", m, flush=True)

def load(p):
    try:
        with open(p) as f: return json.load(f)
    except Exception: return {}

# ---------- pure helpers (unit-tested in tests/test_agent.py) ----------
def lock_id(url):
    qi = (re.search(r"qi=(\d+)", url) or [None, None])[1]
    ou = (re.search(r"ou=(\d+)", url) or [None, None])[1]
    return "%s-%s" % (ou or "x", qi or "x")

def is_quiz(url):
    return bool(QUIZ_RE.search(url)) and "qi=" in url and not LEAVING_RE.search(url)

def rewrite_search(url):
    """URL a locked browser tab should be sent to instead (None = leave it alone)."""
    try: u = urllib.parse.urlsplit(url)
    except Exception: return None
    host, path = u.netloc.lower(), u.path
    q = urllib.parse.parse_qs(u.query)
    query = (q.get("q") or q.get("p") or [""])[0]
    web = "https://www.google.com/search?udm=14&q=" + urllib.parse.quote_plus(query)
    if re.match(r"^(www\.)?google\.[a-z.]+$", host) and path in ("/search", "/webhp"):
        udm, tbm = q.get("udm", []), q.get("tbm", [])
        if (udm and all(x in WEB_OK_UDM for x in udm)) or (tbm and all(x in WEB_OK_TBM for x in tbm)):
            return None
        return web if query else None
    if host.endswith("bing.com") and path.startswith(("/search", "/copilotsearch", "/chat")): return web
    if host.endswith("duckduckgo.com") or host == "duck.ai": return web
    if host in ("search.yahoo.com", "search.brave.com", "you.com", "kagi.com") or host.endswith(".search.yahoo.com"): return web
    return None

def lz4_block(src):
    dst, i, n = bytearray(), 0, len(src)
    while i < n:
        token = src[i]; i += 1
        lit = token >> 4
        if lit == 15:
            while True:
                b = src[i]; i += 1; lit += b
                if b != 255: break
        dst += src[i:i + lit]; i += lit
        if i >= n: break
        off = src[i] | (src[i + 1] << 8); i += 2
        ml = token & 15
        if ml == 15:
            while True:
                b = src[i]; i += 1; ml += b
                if b != 255: break
        ml += 4; start = len(dst) - off
        for k in range(ml): dst.append(dst[start + k])
    return bytes(dst)

def mozlz4_json(path):
    with open(path, "rb") as f: raw = f.read()
    if raw[:8] != b"mozLz40\0": return None
    return json.loads(lz4_block(raw[12:]).decode("utf-8", "replace"))

def firefox_urls(session):
    out = []
    for w in (session or {}).get("windows", []):
        for t in w.get("tabs", []):
            ents = t.get("entries", [])
            if ents: out.append(ents[min(max(t.get("index", 1), 1), len(ents)) - 1].get("url", ""))
    return out

# ---------- live browser access ----------
def osa(script, lang="JavaScript"):
    r = subprocess.run(["osascript", "-l", lang, "-e", script], capture_output=True, text=True, timeout=10)
    if r.returncode: raise RuntimeError(r.stderr.strip())
    return r.stdout.strip()

def running_apps():
    try:
        return set(osa('tell application "System Events" to get name of every process whose background only is false', "AppleScript").split(", "))
    except Exception: return set()

def browser_tabs():
    """-> list of (app, windowIndex, tabIndex, url) across every running browser."""
    tabs, apps = [], running_apps()
    for app in JXA_BROWSERS:
        if app not in apps: continue
        try:
            js = 'JSON.stringify(Application(%s).windows().map(w=>w.tabs().map(t=>t.url())))' % json.dumps(app)
            for wi, urls in enumerate(json.loads(osa(js) or "[]")):
                for ti, u in enumerate(urls or []): tabs.append((app, wi, ti, u or ""))
        except Exception as e:
            if "-1743" in str(e) or "not allowed" in str(e).lower(): permission_hint(app)
    if "Firefox" in apps or "firefox" in apps:
        for p in glob.glob(os.path.expanduser("~/Library/Application Support/Firefox/Profiles/*/sessionstore-backups/recovery.jsonlz4")):
            try:
                for u in firefox_urls(mozlz4_json(p)): tabs.append(("Firefox", -1, -1, u))
            except Exception: pass
    return tabs

def set_tab_url(app, wi, ti, url):
    try: osa('Application(%s).windows()[%d].tabs()[%d].url = %s' % (json.dumps(app), wi, ti, json.dumps(url)))
    except Exception: pass

_hinted = set()
def permission_hint(app):
    if app in _hinted: return
    _hinted.add(app)
    dialog("LOCKqz needs permission to see your %s tabs so it can tell when a quiz starts.\n\n"
           "System Settings → Privacy & Security → Automation → allow LOCKqz / python3 for %s." % (app, app))

def dialog(text, title="LOCKqz"):
    def run():
        try: osa('display dialog %s with title %s buttons {"OK"} default button 1 giving up after 180' % (json.dumps(text), json.dumps(title)), "AppleScript")
        except Exception: pass
    threading.Thread(target=run, daemon=True).start()

def ask_name():
    try:
        s = osa('text returned of (display dialog "LOCKqz setup — enter your name as it appears in Brightspace:" default answer "" with title "LOCKqz" buttons {"OK"} default button 1)', "AppleScript")
        return s.strip() or None
    except Exception: return None

def clipboard(text):
    try: subprocess.run(["pbcopy"], input=text.encode(), timeout=5)
    except Exception: pass

# ---------- helper + backend ----------
class Agent:
    def __init__(self):
        c = load(SYS_CONF)
        self.port, self.token = int(c.get("port", 8787)), c.get("token", "lockqz-dev")
        self.api, self.device = c.get("api_base", "").rstrip("/"), c.get("device_id", "unknown")
        if self.api and not self.api.endswith("/api"): self.api += "/api"   # accept a bare site URL too
        os.makedirs(USER_DIR, exist_ok=True)
        u = load(USER_CONF)
        if not u.get("student"):
            u["student"] = ask_name()
            if u["student"]:
                with open(USER_CONF, "w") as f: json.dump(u, f)
        self.student = u.get("student")
        self.locked, self.quiz, self.url, self.missing_since, self.last_beat = False, None, None, None, 0.0

    def helper(self, path, body=None):
        req = urllib.request.Request("http://127.0.0.1:%d%s" % (self.port, path),
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json", "X-LOCKqz-Token": self.token},
                                     method="POST" if body is not None else "GET")
        return json.loads(urllib.request.urlopen(req, timeout=8).read())

    def api_post(self, path, body):
        if not self.api: return None
        try:
            # Cloudflare blocks the default "Python-urllib" user agent (403) — send our own.
            req = urllib.request.Request(self.api + path, data=json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json", "User-Agent": "LOCKqz/0.2.0 (macOS)"})
            return json.loads(urllib.request.urlopen(req, timeout=8).read())
        except Exception as e:
            log("api %s failed: %s" % (path, e)); return None

    def start(self, url):
        self.quiz, self.url = lock_id(url), url
        try: self.helper("/lock", {"quiz_id": self.quiz, "student": self.student, "url": url})
        except Exception as e:
            log("helper lock failed: %s" % e)
            dialog("LOCKqz could not lock AI for this quiz. Is the LOCKqz app installed and running?"); return
        self.locked, self.missing_since, self.last_beat = True, None, time.time()
        log("LOCKED %s" % self.quiz)
        pw = (self.api_post("/password", {"url": url, "device_id": self.device}) or {}).get("password")
        if pw:
            clipboard(pw)
            dialog("AI is locked for this quiz.\n\nQuiz password:  %s\n(copied to your clipboard — paste it into Brightspace)" % pw)
        else:
            dialog("AI is locked for this quiz.")

    def end(self, reason):
        try: self.helper("/unlock", {"quiz_id": self.quiz})
        except Exception as e: log("helper unlock failed: %s" % e)
        if reason != "submitted":
            self.api_post("/report", {"device_id": self.device, "event": "quiz_left", "quiz_id": self.quiz,
                                      "student": self.student, "source": "agent", "detail": reason})
        log("UNLOCKED (%s)" % reason)
        self.locked, self.quiz, self.url, self.missing_since = False, None, None, None

    def tick(self):
        if developer_mode():
            if self.locked:
                try: self.helper("/unlock", {"quiz_id": self.quiz})
                except Exception: pass
                self.locked, self.quiz, self.url, self.missing_since = False, None, None, None
                log("developer mode ON — AI stays available; not locking")
            return
        tabs = browser_tabs()
        quiz_urls = [u for (_, _, _, u) in tabs if is_quiz(u)]
        leaving = any(LEAVING_RE.search(u) and QUIZ_RE.search(u) for (_, _, _, u) in tabs)
        if not self.locked:
            if quiz_urls: self.start(quiz_urls[0])
            return
        # locked
        if quiz_urls:
            self.missing_since = None
        else:
            if leaving: self.end("submitted"); return
            self.missing_since = self.missing_since or time.time()
            if time.time() - self.missing_since > GRACE:
                self.end("browser_closed" if not tabs else "quiz_tab_closed"); return
        for (app, wi, ti, u) in tabs:
            new = rewrite_search(u)
            if new and wi >= 0: set_tab_url(app, wi, ti, new)
        if time.time() - self.last_beat > BEAT:
            self.last_beat = time.time()
            self.api_post("/report", {"device_id": self.device, "event": "heartbeat", "quiz_id": self.quiz,
                                      "student": self.student, "source": "agent"})

    def run(self):
        try: self.helper("/student", {"student": self.student})
        except Exception as e: log("helper not reachable yet: %s" % e)
        log("running (device %s, student %s)" % (self.device, self.student))
        while True:
            try: self.tick()
            except Exception as e: log("tick error: %s" % e)
            time.sleep(POLL_LOCKED if self.locked else POLL)

if __name__ == "__main__":
    Agent().run()
