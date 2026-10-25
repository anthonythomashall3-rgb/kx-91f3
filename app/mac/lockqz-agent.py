#!/usr/bin/env python3
"""LOCKqz agent (macOS). Per-user LaunchAgent. Replaces the browser extension, so the
student installs ONE thing and nothing comes from the Chrome Web Store.

Every 2 s it reads the open tab URLs of every running browser (Chrome, Edge, Brave,
Chromium, Vivaldi, Arc, Safari via Apple Events; Firefox via its session file) and:
  * on a Brightspace quiz attempt page  -> tells the root helper to LOCK, then asks the
    helper for the quiz password (the helper checks its block is in place and makes a
    request signed with its root-only device key), shows it and copies it to the clipboard
  * while locked                        -> pings the backend (live monitor), and forces
    any Google/Bing/DDG/... search tab onto Google "Web" results (no AI answer) —
    the backstop for Safari, which has no policy layer
  * when the quiz page is gone (submitted / left) -> tells the helper to UNLOCK
First run asks the student's school email ONCE (confirmed by an emailed code) so the
professor's roster and the quiz gate know who is locked.
"""
import hashlib, json, os, re, subprocess, threading, time, urllib.error, urllib.request, urllib.parse, glob
NOPROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # never go through a system proxy

SYS_CONF = "/Library/Application Support/LOCKqz/config.json"
# Per-user copy of the helper's random control token, written by the helper (root) for the console user.
TOKEN_DIR = os.environ.get("LOCKQZ_TOKEN_DIR") or "/Library/Application Support/LOCKqz/tokens"
USER_DIR = os.path.expanduser("~/Library/Application Support/LOCKqz")
USER_CONF = os.path.join(USER_DIR, "student.json")
HERE = os.path.dirname(os.path.abspath(__file__))

def _helper_version():
    """The release version (the helper's VERSION line, shipped in the same folder) for the User-Agent."""
    try:
        with open(os.path.join(HERE, "lockqzd.py")) as f:
            m = re.search(r'^VERSION = "([0-9.]+)"', f.read(), re.M)
        return m.group(1) if m else "0"
    except Exception:
        return "0"
VERSION = _helper_version()
POLL, POLL_LOCKED, GRACE, BEAT = 2, 1, 30, 60   # agent reports (every 60s) only while the helper is unreachable
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

# Brightspace URL rules (tests/test_url_parsing.mjs loads these exact patterns). Each is matched
# against ONE part of the URL only, so a word inside another parameter (?returnUrl=...results) or a
# quiz path quoted in a query string can never lock or unlock anything.
# Taking a quiz (/quizzing/user/) OR previewing one (TAs/staff open quizzes via Preview): URL path.
QUIZ_PATH_RE = re.compile(r"^/d2l/lms/quizzing/(user/|.*preview)", re.I)
QUIZ_ANY_PATH_RE = re.compile(r"^/d2l/lms/quizzing/", re.I)
PREVIEW_QUERY_RE = re.compile(r"(^|&)isprv=1(&|$)", re.I)         # query string: a Preview attempt
LEAVING_RE = re.compile(r"quizzes_list|quiz_submissions|feedback|results|submission", re.I)   # URL path only
QI_RE = re.compile(r"[?&]qi=(\d+)")                                  # the quiz's own parameters
OU_RE = re.compile(r"[?&]ou=(\d+)")
QUIZ_RE = QUIZ_PATH_RE   # old name, kept for anything that still imports it
WEB_OK_UDM = {"14", "2", "12", "7", "36"}
WEB_OK_TBM = {"isch", "nws", "vid", "bks"}
JXA_BROWSERS = ["Google Chrome", "Google Chrome Beta", "Google Chrome Dev", "Google Chrome Canary",
                "Microsoft Edge", "Microsoft Edge Beta", "Microsoft Edge Dev", "Microsoft Edge Canary",
                "Brave Browser", "Brave Browser Beta", "Brave Browser Nightly", "Chromium",
                "Vivaldi", "Opera", "Opera GX", "Arc", "Safari"]

_LOGF = os.path.expanduser("~/Library/Logs/LOCKqz-agent.log")
LOG_MAX = 1000000
def log(m):
    line = "LOCKqz-agent: " + str(m)
    print(line, flush=True)
    try:
        os.makedirs(os.path.dirname(_LOGF), exist_ok=True)
        try:
            if os.path.getsize(_LOGF) > LOG_MAX: os.replace(_LOGF, _LOGF + ".1")   # never grows past ~2 MB
        except OSError: pass
        with open(_LOGF, "a") as f: f.write(time.strftime("%Y-%m-%dT%H:%M:%S ") + line + "\n")
    except Exception: pass

def load(p):
    try:
        with open(p) as f: return json.load(f)
    except Exception: return {}

# ---------- pure helpers (unit-tested in tests/test_agent.py) ----------
def url_parts(url):
    """-> (path, query) of a URL; ("", "") for anything that is not one."""
    try:
        s = str(url or "")
        if "://" not in s[:12] and not s.startswith("/"): s = "https://" + s   # address bar text without a scheme
        u = urllib.parse.urlsplit(s)
        return u.path or "", u.query or ""
    except Exception:
        return "", ""

CONTENT_VIEW_RE = re.compile(r"^/d2l/le/(content|lessons)/\d+/", re.I)
def inner_url(url):
    """A quiz opened from Content/Lessons runs in a frame of
    /d2l/le/content/<ou>/fullscreen/<topic>/ViewLocation?...&location=<quiz URL, encoded>. Return that quiz
    URL (same scheme and host), so every rule below sees the real quiz; any other URL is returned as is."""
    s = str(url or "")
    try:
        t = s if "://" in s[:12] else "https://" + s
        u = urllib.parse.urlsplit(t)
        if CONTENT_VIEW_RE.search(u.path or ""):
            loc = (urllib.parse.parse_qs(u.query).get("location") or [""])[0]
            if loc.startswith("/d2l/"): return "%s://%s%s" % (u.scheme, u.netloc, loc)
    except Exception: pass
    return s

def lock_id(url):
    qi = (QI_RE.search(str(url or "")) or [None, None])[1]
    ou = (OU_RE.search(str(url or "")) or [None, None])[1]
    return "%s-%s" % (ou or "x", qi or "x")

def is_quiz_page(url):
    """A Brightspace quiz page (taking or previewing), whatever stage: start, attempt or submitted."""
    path, query = url_parts(url)
    return bool(QUIZ_PATH_RE.search(path) or (QUIZ_ANY_PATH_RE.search(path) and PREVIEW_QUERY_RE.search(query)))

def is_leaving(url):
    """A quiz's 'after the quiz' page (submitted, results, back to the list)."""
    return is_quiz_page(url) and bool(LEAVING_RE.search(url_parts(url)[0]))

def is_quiz(url):
    return is_quiz_page(url) and bool(QI_RE.search(str(url or ""))) and not is_leaving(url)

def classify(urls):
    """-> (present, left). present: {quiz id: url} for quizzes that are really open; left: ids whose
    submitted/results page is showing. "Leaving" is evaluated BEFORE "present": a quiz's own start or
    summary page left in another tab never keeps the lock once its submission page shows. Only an
    open ATTEMPT page outranks a leaving page (so opening an old submission in a new tab mid-attempt
    never unlocks)."""
    starts, left = {}, set()
    for u in urls:
        if not u or not is_quiz_page(u) or not QI_RE.search(u): continue
        q = lock_id(u)
        if is_leaving(u): left.add(q)
        else: starts.setdefault(q, []).append(u)
    present = {}
    for q, us in starts.items():
        att = [u for u in us if "/attempt/" in url_parts(u)[0]]
        if att: present[q] = att[0]
        elif q not in left: present[q] = us[0]
    return present, left - set(present)

def next_password_check(now, opens):
    """C2: a quiz that has not opened yet: ask every 5 min until 90 s before it opens, then every 15 s."""
    if opens is None: return now + 300
    t = opens - 90
    return min(now + 300, t) if now < t else now + 15

def unlock_reason(tabs_now, tabs_before):
    """Why the open quiz went away (no submission page seen): every tab gone or fewer tabs than while
    the quiz was open -> the quiz tab was closed; otherwise the student navigated away."""
    if not tabs_now or (tabs_before and len(tabs_now) < tabs_before): return "quiz_tab_closed"
    return "quiz_left"

# Gecko browsers: profile folder (under ~/Library/Application Support) per launcher binary name.
GECKO_DIRS = {"firefox": ["Firefox", "Firefox Developer Edition", "Firefox Nightly"], "librewolf": ["LibreWolf"],
              "waterfox": ["Waterfox"], "floorp": ["Floorp"], "zen": ["zen", "Zen"], "mullvadbrowser": ["MullvadBrowser"]}

def _etime(s):
    """ps etime ([[dd-]hh:]mm:ss) -> seconds."""
    d, _, rest = s.strip().rpartition("-")
    parts = [int(x) for x in rest.split(":")]
    while len(parts) < 3: parts.insert(0, 0)
    return (int(d) if d else 0) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]

def gecko_running(ps_lines, now):
    """`ps -x -o etime= -o comm=` lines -> {profile folder: start time of that browser}."""
    out = {}
    for line in ps_lines:
        try:
            et, comm = line.strip().split(None, 1)
            # A full path must be an app launcher; a bare name (some ps builds print only that) is
            # accepted - the profile still has to be newer than the process to be read.
            if "/" in comm and ".app/Contents/MacOS/" not in comm: continue
            b = os.path.basename(comm).lower()
            if b not in GECKO_DIRS: continue
            start = now - _etime(et)
            for base in GECKO_DIRS[b]: out[base] = min(out.get(base, start), start)
        except Exception:
            continue
    return out

def gecko_session_files(running, files_for, mtime):
    """Session files worth reading: only for a Gecko browser that is RUNNING, and only a profile it
    wrote since it started. A recovery file left by a crash (browser not running, or a stale profile
    of a browser that started later) never makes LOCKqz lock."""
    out = []
    for base, started in running.items():
        for p in files_for(base):
            try:
                if mtime(p) >= started - 5: out.append((base, p))
            except Exception:
                pass
    return out

def rewrite_search(url):
    """URL a locked browser tab should be sent to instead (None = leave it alone)."""
    try: u = urllib.parse.urlsplit(url)
    except Exception: return None
    if u.scheme not in ("http", "https"): return None
    host, path = (u.hostname or "").lower(), u.path
    q = urllib.parse.parse_qs(u.query)
    query = (q.get("q") or q.get("p") or [""])[0]
    web = "https://www.google.com/search?udm=14&q=" + urllib.parse.quote_plus(query)
    if host == "lens.google.com" or re.match(r"^lens\.google\.[a-z.]+$", host): return web   # Lens answers photographed questions
    if re.match(r"^(www\.)?google\.[a-z.]+$", host) and (path in ("/search", "/webhp", "/") or path.startswith(("/ai", "/searchbyimage"))):
        if path.startswith(("/ai", "/searchbyimage")): return web   # AI Mode / image search pages
        udm, tbm = q.get("udm", []), q.get("tbm", [])
        if (udm and all(x in WEB_OK_UDM for x in udm)) or (tbm and all(x in WEB_OK_TBM for x in tbm)):
            return None
        # Any other udm/tbm (AI Mode udm=50, Lens udm=26, ...) goes to plain web results, even with no q.
        if udm or tbm: return web
        return web if (query and path != "/") else None
    if host.endswith("bing.com") and path.startswith(("/search", "/copilotsearch", "/chat")): return web
    if host.endswith("duckduckgo.com") or host == "duck.ai": return web
    if host in ("search.yahoo.com", "search.brave.com", "you.com", "kagi.com") or host.endswith(".search.yahoo.com"): return web
    return None

def parse_blocklist(lines):
    """blocklist.txt lines -> (hosts, [(host, path prefix)]): plain hosts and host/path entries."""
    hosts, paths = set(), []
    for l in lines:
        l = l.strip().lower()
        if not l or l.startswith("#") or " " in l: continue
        h, _, p = l.partition("/")
        if not re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+", h): continue
        if p: paths.append((h, "/" + p))
        else: hosts.add(h)
    return hosts, paths

def blocked_tab(url, hosts, paths):
    """True when an open tab is an AI site from the blocklist (it is sent to about:blank at lock, so a
    chat page loaded before the quiz cannot keep talking over its open connection). Google search
    pages are left to rewrite_search (plain web results), never blanked."""
    try: u = urllib.parse.urlsplit(str(url or ""))
    except Exception: return False
    if u.scheme not in ("http", "https", "wss", "ws"): return False
    h = (u.hostname or "").lower()
    if not h: return False
    if re.match(r"^(www\.)?google\.[a-z.]+$", h) and (u.path in ("/search", "/webhp", "/") or u.path.startswith("/search")): return False
    hs = h[4:] if h.startswith("www.") else h
    for d in hosts:
        if h == d or h.endswith("." + d) or hs == d: return True
    for d, p in paths:
        if (h == d or hs == d or h.endswith("." + d)) and (u.path or "/").lower().startswith(p): return True
    return False

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

def _frame_quiz_url(entry):
    """A quiz running in a frame of the page (Brightspace Content/Lessons view): the frame's CURRENT URL,
    from the session store's child entries (it changes to the submission page when the quiz is turned in)."""
    for c in (entry or {}).get("children", []) or []:
        u = str(c.get("url", "") or "")
        if QUIZ_ANY_PATH_RE.search(url_parts(u)[0]): return u
        deeper = _frame_quiz_url(c)
        if deeper: return deeper
    return ""

def firefox_urls(session):
    out = []
    for w in (session or {}).get("windows", []):
        for t in w.get("tabs", []):
            ents = t.get("entries", [])
            if not ents: continue
            e = ents[min(max(t.get("index", 1), 1), len(ents)) - 1]
            u = e.get("url", "")
            if CONTENT_VIEW_RE.search(url_parts(u)[0]): u = _frame_quiz_url(e) or u   # quiz inside Content
            out.append(u)
    return out

# ---------- live browser access ----------
def osa(script, lang="JavaScript", timeout=10, args=None):
    cmd = ["osascript", "-l", lang, "-e", script] + ([str(a) for a in args] if args else [])
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if r.returncode: raise RuntimeError(r.stderr.strip())
    return r.stdout.strip()

def ps_procs():
    """This user's processes: [(pid, etime seconds, command path)] - plain `ps`, no Apple Events, so
    nothing depends on the student allowing System Events."""
    try:
        out = subprocess.run(["ps", "-x", "-o", "pid=", "-o", "etime=", "-o", "comm="], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return []
    procs = []
    for line in out.splitlines():
        try:
            pid, et, comm = line.strip().split(None, 2)
            procs.append((int(pid), _etime(et), comm.strip()))
        except Exception:
            continue
    return procs

APP_MAIN_RE = re.compile(r"/([^/]+)\.app/Contents/MacOS/[^/]+$")
def running_apps(procs=None):
    """Names of the running apps (bundle name of each app's main binary, e.g. 'Google Chrome').
    Helpers live in nested bundles ('Google Chrome Helper.app') and never count as the browser."""
    names = set()
    for _, _, comm in (ps_procs() if procs is None else procs):
        m = APP_MAIN_RE.search(comm)
        if m: names.add(m.group(1))
        elif "/" not in comm: names.add(comm)   # some ps builds print the bare name
    return names

def browser_tabs():
    """-> list of (app, windowIndex, tabIndex, url) across every running browser."""
    tabs, procs = [], ps_procs()
    apps = running_apps(procs)
    for app in JXA_BROWSERS:
        if app not in apps: continue   # never name a browser that is not running (JXA would launch it)
        try:
            js = 'JSON.stringify(Application(%s).windows().map(w=>w.tabs().map(t=>t.url())))' % json.dumps(app)
            for wi, urls in enumerate(json.loads(osa(js) or "[]")):
                for ti, u in enumerate(urls or []): tabs.append((app, wi, ti, u or ""))
            _denied.pop(app, None)
        except Exception as e:
            if "-1743" in str(e) or "not allowed" in str(e).lower(): permission_hint(app)
    # Firefox and every Gecko fork store open tabs in a per-app profile dir; read the ones that are
    # running now so a quiz opened in Firefox/LibreWolf/Waterfox/Floorp/Zen/Mullvad is detected.
    ps = ["%d %s" % (et, comm) for (_, et, comm) in procs]
    files = lambda base: glob.glob(os.path.expanduser("~/Library/Application Support/%s/Profiles/*/sessionstore-backups/recovery.jsonlz4" % base))
    for base, p in gecko_session_files(gecko_running(ps, time.time()), files, os.path.getmtime):
        try:
            for u in firefox_urls(mozlz4_json(p)): tabs.append((base, -1, -1, u))
        except Exception: pass
    return tabs

def set_tab_url(app, wi, ti, url):
    try: osa('Application(%s).windows()[%d].tabs()[%d].url = %s' % (json.dumps(app), wi, ti, json.dumps(url)))
    except Exception: pass

# ---------- browsers that cannot switch their AI off mid-session (G3/G4) ----------
OPERA_APPS = ("Opera", "Opera GX", "Opera Air", "Opera Neon")   # no policy layer (Aria AI, built-in VPN)
GECKO_BINS = tuple(GECKO_DIRS)                                   # read policies only when they start
def no_policy_pids(procs, keep_app):
    """Main processes of the Opera family, except the browser the quiz is in."""
    out = []
    for pid, _, comm in procs:
        m = APP_MAIN_RE.search(comm)
        if m and m.group(1) in OPERA_APPS and m.group(1) != keep_app: out.append((pid, m.group(1)))
    return out

RESTART_APPS = ("Brave Browser",)   # read new policies (Leo, Tor windows, VPN off) only when they start
def restart_pids(procs, keep_app):
    """Main processes of browsers closed once at lock so their quiz policies apply on reopen."""
    out = []
    for pid, _, comm in procs:
        m = APP_MAIN_RE.search(comm)
        if m and m.group(1) in RESTART_APPS and m.group(1) != keep_app: out.append((pid, m.group(1)))
    return out

def gecko_bin_of(app):
    """Gecko launcher binary for a tab's app name ('Firefox' profile folder -> 'firefox'), else None."""
    for b, dirs in GECKO_DIRS.items():
        if app in dirs: return b
    return None

def gecko_pids(procs, keep_app):
    """Main processes of Firefox and its forks (Tor Browser too: its binary is 'firefox'), except the
    browser the quiz is in."""
    keep = gecko_bin_of(keep_app)
    out = []
    for pid, _, comm in procs:
        if ".app/Contents/MacOS/" not in comm: continue
        b = os.path.basename(comm).lower()
        if b in GECKO_BINS and b != keep: out.append((pid, b))
    return out

def close_pids(pids):
    """Ask nicely (SIGTERM: the browser saves its session), then force after 3 s. In the background so
    quiz watching never waits."""
    import signal
    def run():
        for pid, _ in pids:
            try: os.kill(pid, signal.SIGTERM)
            except Exception: pass
        time.sleep(3)
        for pid, _ in pids:
            try: os.kill(pid, signal.SIGKILL)
            except Exception: pass
    if pids: threading.Thread(target=run, daemon=True).start()
    return bool(pids)

_hinted, _denied = {}, {}
HINT_EVERY = 600   # a denied browser that is in front gets the hint again at most every 10 min
def front_app():
    """Name of the frontmost app via lsappinfo (no Apple Events)."""
    try:
        asn = subprocess.run(["lsappinfo", "front"], capture_output=True, text=True, timeout=5).stdout.strip()
        out = subprocess.run(["lsappinfo", "info", "-only", "name", asn], capture_output=True, text=True, timeout=5).stdout
        m = re.search(r'"(?:LSDisplayName|name)"\s*=\s*"([^"]*)"', out)
        return m.group(1) if m else None
    except Exception:
        return None

def permission_hint(app, now=None, front=None):
    """Tabs of a running browser cannot be read (the student clicked Don't Allow): say so at once, and
    again whenever that browser is the one in front (the student may be opening a quiz in it)."""
    now = time.time() if now is None else now
    _denied[app] = now
    last = _hinted.get(app)
    if last is not None:
        if now - last < HINT_EVERY: return False
        if (front_app() if front is None else front) != app: return False
    _hinted[app] = now
    def run():
        try:
            b = osa('on run argv\n set r to display dialog (item 1 of argv) with title "LOCKqz" buttons {"Later", "Open Settings"} default button 2 giving up after 300\n return button returned of r\nend run',
                    "AppleScript", timeout=320, args=["LOCKqz cannot see your %s tabs, so it cannot tell when a quiz starts and cannot give you the quiz password.\n\n"
                                                      "Open Settings > Privacy & Security > Automation, and turn on %s under python3." % (app, app)])
            if b.strip() == "Open Settings":
                subprocess.run(["open", "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"], timeout=10)
        except Exception: pass
    threading.Thread(target=run, daemon=True).start()
    return True

def dialog(text, title="LOCKqz"):
    def run():
        try: osa('on run argv\n display dialog (item 1 of argv) with title (item 2 of argv) buttons {"OK"} default button 1 giving up after 180\nend run',
                 "AppleScript", timeout=200, args=[text, title])
        except Exception: pass
    threading.Thread(target=run, daemon=True).start()

EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")

# ---------- student email: asked ONCE per computer, confirmed by an emailed code ----------
# The quiz gate admits a student by their Brightspace email, so it must be theirs: LOCKqz shows the
# roster name ("Is this you?") and binds the email only after the 6-digit code sent to it is typed.
# A typo or a classmate's email can never stick. An expired code is resent automatically.
class MacUI:
    SCRIPT = ('on run argv\n set btns to items 4 thru -1 of argv\n'
              ' if item 3 of argv is "1" then\n'
              '  set r to display dialog (item 1 of argv) default answer (item 2 of argv) buttons btns default button (count of btns) with title "LOCKqz" giving up after 1800\n'
              '  if gave up of r then return ""\n'
              '  return (button returned of r) & linefeed & (text returned of r)\n'
              ' else\n'
              '  set r to display dialog (item 1 of argv) buttons btns default button (count of btns) with title "LOCKqz" giving up after 1800\n'
              '  if gave up of r then return ""\n'
              '  return (button returned of r) & linefeed\n'
              ' end if\nend run')
    def ask(self, msg, buttons, default="", answer=True):
        """Dialog that waits for the student (up to 30 min). -> (button, text) or (None, None)."""
        try: out = osa(self.SCRIPT, "AppleScript", timeout=1900, args=[msg, default or "", "1" if answer else "0"] + list(buttons))
        except Exception as e:
            log("dialog failed: %s" % e); out = ""
        if not out: return (None, None)
        b, _, t = out.partition("\n")
        return (b, t.strip())
    def say(self, msg): self.ask(msg, ["OK"], answer=False)

ASK = "Enter your school email (the one Brightspace uses, e.g. you@usc.edu):"
CODE_FRESH = 12 * 60   # a code sent less than 12 min ago is still good (server: 15 min): ask for it, don't resend

# The email is asked ONCE. The moment the student types it, it is saved on this computer (save());
# every later try goes straight to the emailed code. Server/network trouble is NEVER shown as a popup:
# setup just stops quietly (state["r"] = "server") and the agent retries in the background.
def _ask_email(call, ui, state):
    email, msg = "", "LOCKqz setup (one time only)\n\n" + ASK
    while True:
        b, typed = ui.ask(msg, ["OK"], email)
        if b is None: state["r"] = "closed"; return None
        email = (typed or "").strip().lower()
        if not EMAIL_RE.match(email):
            msg = "That is not an email address.\n\n" + ASK; continue
        chk = call("check", email=email)
        if not chk: return email          # server unreachable: keep what they typed (the code proves it later)
        if chk.get("name"):
            b, _ = ui.ask("Is this you?\n\n%s\n%s" % (chk["name"], email), ["No, retype", "Yes"], answer=False)
        else:
            b, _ = ui.ask("%s is not on a LOCKqz class list yet.\n\nCheck the spelling." % email, ["Retype", "Use it"], answer=False)
        if b is None: state["r"] = "closed"; return None
        if b in ("No, retype", "Retype"):
            msg = ASK; continue
        return email

def setup_identity(call, ui, saved="", save=None, state=None):
    """call(op, **kw) -> server reply dict ({} = no answer). Returns (email, verified) or None
    (not finished: state["r"] = "server" (retry quietly) or "closed" (the student closed the dialog))."""
    state = {} if state is None else state
    state["r"] = "server"
    st = call("status")
    if not st: return None
    if st.get("verified") and st.get("student"):
        if st.get("vtoken"): state["vtoken"] = st["vtoken"]
        return (st["student"], True)
    if not st.get("codes") and st.get("student"): return (st["student"], False)   # codes off on server
    email = (saved or st.get("student") or "").strip().lower()
    if not EMAIL_RE.match(email): email = ""
    if email and state.get("vtoken"):
        # Confirmed before on this computer (e.g. LOCKqz was reinstalled): the saved proof does it, no dialog.
        r = call("token", email=email, vtoken=state["vtoken"])
        if r.get("verified"):
            state["vtoken"] = r.get("vtoken") or state["vtoken"]; return (email, True)
        if not r: return None
        if r.get("error") == "bad_token": state.pop("vtoken", None)
    while True:
        if not email:
            email = _ask_email(call, ui, state)
            if not email: return None
            if save: save(email)                      # never asked again, whatever happens next
        sent = state.get("sent")
        if not (sent and sent[0] == email and time.time() - sent[1] < CODE_FRESH):
            r = call("send", email=email)
            if r.get("bound"): return (email, False)  # server has codes off: roster check only
            if not r.get("sent"):
                log("code not sent (%s): will retry quietly" % (r.get("error") or "no answer")); return None
            state["sent"] = (email, time.time())
        note = ""
        while True:
            b, code = ui.ask(note + "We emailed a 6-digit code to\n%s\n\nType it here (check Junk/Spam if you don't see it):" % email,
                             ["Change email", "Send new code", "OK"])
            if b is None: state["r"] = "closed"; return None
            if b == "Change email":
                email = ""; state.pop("sent", None)
                if save: save("")
                break
            if b == "Send new code":
                r = call("send", email=email)
                if not r.get("sent"):
                    note = "LOCKqz couldn't send a new code right now. Use the last one, or try again in a few minutes.\n\n"; continue
                state["sent"] = (email, time.time())
                note = "New code sent.\n\n"; continue
            r = call("code", email=email, code=code or "")
            if r.get("verified"):
                state.pop("sent", None)
                if r.get("vtoken"): state["vtoken"] = r["vtoken"]
                ui.say("Done. LOCKqz is set up and won't ask again."); return (email, True)
            e = r.get("error")
            if r.get("resent"):
                state["sent"] = (email, time.time())
                note = {"expired": "That code expired. We sent a new one.\n\n",
                        "too_many_tries": "Too many wrong tries. We sent a new code.\n\n"}.get(e, "We sent a new code.\n\n"); continue
            if e == "wrong_code":
                note = "That code is wrong (%s tries left).\n\n" % r.get("tries_left"); continue
            log("code check failed (%s): will retry quietly" % (e or "no answer")); return None

def clipboard(text):
    try: subprocess.run(["pbcopy"], input=text.encode(), timeout=5)
    except Exception: pass

# ---------- helper + backend ----------
def load_token(conf):
    """This user's copy of the helper token (written by the helper); the config value only for an
    older install that still has one."""
    try:
        with open(os.path.join(TOKEN_DIR, str(os.getuid()))) as f:
            t = f.read().strip()
        if t: return t
    except Exception:
        pass
    return conf.get("token", "")

class Agent:
    def __init__(self):
        c = load(SYS_CONF); self.conf = c
        self.port, self.token = int(c.get("port", 8787)), load_token(c)
        self.api, self.device = c.get("api_base", "").rstrip("/"), c.get("device_id", "unknown")
        if self.api and not self.api.endswith("/api"): self.api += "/api"   # accept a bare site URL too
        try: os.makedirs(USER_DIR, exist_ok=True)
        except Exception: pass
        u = load(USER_CONF)
        self.student, self.verified = u.get("student"), bool(u.get("verified"))
        self.id_busy, self.id_tried, self.id_next, self.id_fails = False, 0.0, 0.0, 0
        self.id_state = {"vtoken": u["vtoken"]} if u.get("vtoken") else {}   # proof of a confirmed email
        self.locked, self.quiz, self.url, self.missing_since, self.last_beat = False, None, None, None, 0.0
        self.pending = None          # (quiz, reason): an unlock the helper has not confirmed yet
        self.pending_try = 0.0
        self.capped = {}             # quiz id -> last time its page was seen (released by the safety cap or the server)
        self.cap_left = {}           # quiz id -> its page left the attempt pages since the release (summary seen)
        self.cap_forgot = {}         # quiz id -> when this agent forgot its release (the helper's older one is ignored)
        self.tabs_seen = 0           # how many tabs were open while the quiz was open
        self.last_check, self.lock_fail_shown = 0.0, {}
        self.pw, self.pw_next, self.start_told = None, 0.0, None   # next /password check; "opens at" shown for
        self.quiz_app, self.opera_warned = None, False             # browser holding the quiz
        self.bl, self.bl_mtime = (set(), []), None                 # AI blocklist (hosts, host/path)

    def blocklist(self):
        p = os.path.join(HERE, "blocklist.txt")
        try:
            m = os.path.getmtime(p)
            if m != self.bl_mtime:
                with open(p) as f: self.bl = parse_blocklist(f.readlines())
                self.bl_mtime = m
        except Exception:
            pass
        return self.bl

    def verify_call(self, op, **kw):
        try: r = self.helper("/verify", dict(kw, op=op))
        except Exception as e: log("verify %s: helper unreachable: %s" % (op, e)); return {}
        return r if isinstance(r, dict) and r.get("status") else {}

    def save_student(self, email, verified=False):
        self.student, self.verified = (email or None), bool(verified)
        try:
            d = {"student": self.student, "verified": self.verified}
            if self.id_state.get("vtoken"): d["vtoken"] = self.id_state["vtoken"]
            with open(USER_CONF, "w") as f: json.dump(d, f)
        except Exception as e: log("could not save student: %s" % e)

    def ensure_identity(self, force=False, quiz=False):
        """One-time email setup, in the background (never blocks quiz watching). Retries are quiet and
        spaced out: server trouble 2, 4, 8 ... 60 min; a closed dialog 10 min while a quiz is open,
        otherwise 6 h. force = check now (login, or the quiz gate needs the confirmed email)."""
        now = time.time()
        if self.id_busy or (self.verified and not force): return
        if now < self.id_next and not ((force or quiz) and now - self.id_tried >= 600): return
        self.id_busy, self.id_tried = True, now
        def run():
            try:
                got = setup_identity(self.verify_call, MacUI(), self.student or "",
                                     lambda e: self.save_student(e, False), self.id_state)
                if got:
                    self.save_student(*got); self.id_fails, self.id_next = 0, 0.0
                    try: self.helper("/student", {"student": self.student})
                    except Exception: pass
                    log("student %s (%s)" % (self.student, "verified" if self.verified else "unconfirmed"))
                elif self.id_state.get("r") == "closed":
                    self.id_next = time.time() + (600 if (quiz or self.quiz) else 6 * 3600)
                else:
                    self.id_fails += 1
                    self.id_next = time.time() + min(3600, 120 * 2 ** min(self.id_fails - 1, 5))
            except Exception as e:
                log("identity setup error: %s" % e); self.id_next = time.time() + 600
            finally: self.id_busy = False
        threading.Thread(target=run, daemon=True).start()

    def payment(self, r):
        # Student fee unpaid: open the payment page once per quiz. The password arrives by itself
        # (re-checked every 15s) as soon as the Venmo/Zelle payment is matched.
        pay = r.get("pay") if isinstance(r, dict) else None
        if not isinstance(pay, dict): return False
        if not getattr(self, "pay_shown", False):
            self.pay_shown = True
            u = str(pay.get("url") or "https://lockqz.pages.dev/pay")
            if u.startswith("https://lockqz.pages.dev/"):
                try: subprocess.run(["open", u], timeout=10)
                except Exception: pass
            dialog("Pay $%s for LOCKqz this semester to get the quiz password.\n\nMemo:  %s\n\nThe payment page is open. LOCKqz shows the password here as soon as your payment arrives."
                   % (pay.get("amount") or 5, pay.get("code") or ""))
        return True

    def helper(self, path, body=None, timeout=90):
        for attempt in (0, 1):
            req = urllib.request.Request("http://127.0.0.1:%d%s" % (self.port, path),
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers={"Content-Type": "application/json", "X-LOCKqz-Token": self.token},
                                         method="POST" if body is not None else "GET")
            try:
                return json.loads(NOPROXY.open(req, timeout=timeout).read())   # loopback must bypass any system proxy
            except urllib.error.HTTPError as e:
                # The helper may have (re)issued this user's token copy since we read it: reload once.
                if e.code == 401 and attempt == 0:
                    self.token = load_token(self.conf); continue
                raise

    def api_post(self, path, body):
        if not self.api: return None
        try:
            # Cloudflare blocks the default "Python-urllib" user agent (403) — send our own. Bypass any
            # system proxy, which could block or MITM the call.
            req = urllib.request.Request(self.api + path, data=json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json", "User-Agent": "LOCKqz/%s (macOS)" % VERSION})
            return json.loads(NOPROXY.open(req, timeout=8).read())
        except Exception as e:
            log("api %s failed: %s" % (path, e)); return None

    def close_for_quiz(self, app):
        """At lock: close Firefox (and forks) and the Opera family - they cannot switch their AI off while
        running - except the browser the quiz is in. -> note for the student ('' when nothing closed)."""
        procs = ps_procs()
        g, o, b = gecko_pids(procs, app), no_policy_pids(procs, app), restart_pids(procs, app)
        close_pids(g + o + b)
        self.opera_check = time.time() + 5   # give the closed ones time to exit before re-checking
        if o: self.opera_warned = True       # the lock note already says so
        names = (["Firefox"] if g else []) + (["Opera"] if o else []) + (["Brave"] if b else [])
        if not names: return ""
        if len(names) == 1:
            return "\n\n%s was closed for the quiz so its AI stays off. You can reopen it; your tabs come back." % names[0]
        return "\n\n%s were closed for the quiz so their AI stays off. You can reopen them; your tabs come back." % (", ".join(names[:-1]) + " and " + names[-1])

    def pw_reply(self, r, now, first=False, note=""):
        """Act on the helper's /password answer -> "pw" | "pay" | "wait" | "other" | None (nothing yet).
        Sets when the next check may run (C2: a quiz that has not opened yet is asked every 5 min, then
        every 15 s from 90 s before it opens)."""
        r = r if isinstance(r, dict) else {}
        pw, reason = r.get("password"), r.get("reason")
        if pw:
            changed, had = pw != self.pw, self.pw
            self.pw, self.pw_next = pw, now + 15
            if changed:
                clipboard(pw)
                if first and developer_mode():
                    dialog("Developer mode: AI stays ON for you.\n\nQuiz password:  %s\n(copied to your clipboard)" % pw)
                elif first:
                    dialog("AI is locked for this quiz.\n\nQuiz password:  %s\n(copied to your clipboard — paste it into Brightspace)" % pw + note)
                else:
                    dialog(("The quiz password changed.\n\nNew password:  %s" if had else "Quiz password:  %s") % pw + "\n(copied to your clipboard)")
            return "pw"
        if self.payment(r):
            self.pw_next = now + 15
            if first and note: dialog("AI is locked for this quiz." + note)
            return "pay"
        if reason == "not started":
            si = r.get("start_in")
            opens = now + si if isinstance(si, (int, float)) else None
            self.pw_next = next_password_check(now, opens)
            if self.start_told != self.quiz:
                self.start_told = self.quiz
                at = time.strftime("%I:%M %p", time.localtime(opens)).lstrip("0") if opens else "its start time"
                dialog("AI is locked for this quiz.\n\nThe quiz opens at %s. LOCKqz shows the password here then." % at + note)
            return "wait"
        if reason == "other_school":
            # C10: the helper has already put AI back (nothing to protect here).
            dialog("LOCKqz is not set up for this school yet.\n\nAI stays on for this quiz.")
            self.add_cap(self.quiz, now)
            log("other school: %s not protected" % self.quiz)
            self.locked, self.quiz, self.url, self.missing_since = False, None, None, None
            return "other"
        if reason == "verify":
            self.ensure_identity(force=True)   # the server needs the confirmed school email first
        self.pw_next = now + 15
        return None

    def start(self, url, app=None):
        quiz = lock_id(url)
        try:
            r = self.helper("/lock", {"quiz_id": quiz, "student": self.student, "url": url})
            if not (isinstance(r, dict) and r.get("ok")): raise RuntimeError("helper answered %r" % (r,))
        except Exception as e:
            log("helper lock failed: %s" % e)
            if time.time() - self.lock_fail_shown.get(quiz, 0) > 120:   # retried every tick; tell the student once
                self.lock_fail_shown[quiz] = time.time()
                dialog("LOCKqz could not lock AI for this quiz. Is the LOCKqz app installed and running?")
            return
        self.quiz, self.url, self.quiz_app, self.opera_warned = quiz, url, app, False
        self.locked, self.missing_since, self.last_beat, self.pending = True, None, time.time(), None
        self.start_told = None
        log("LOCKED %s" % self.quiz)
        dev = developer_mode()
        note = "" if dev else self.close_for_quiz(app)
        if app in OPERA_APPS and not dev:
            self.opera_warned = True
            dialog("Opera cannot turn its AI off during a quiz.\n\nPlease take this quiz in Chrome, Safari, Edge or Firefox.")
        self.pw, self.pay_shown, res = None, False, None
        for attempt in range(3):   # the helper fetches it (signed); retry a brief network blip
            try:
                res = self.pw_reply(self.helper("/password", {"url": url}), time.time(), first=True, note=note)
            except Exception as e: log("password via helper failed: %s" % e)
            if res or not self.locked: break
            time.sleep(2)
        if res is None and self.locked and not self.pay_shown:
            dialog("AI is locked for this quiz.\n\nIf it needs a password, LOCKqz will show it here as soon as the quiz opens." + note)

    def send_unlock(self, quiz, reason):
        """True only when the helper confirms AI is back."""
        try:
            r = self.helper("/unlock", {"quiz_id": quiz, "reason": reason}, timeout=150)
            return isinstance(r, dict) and bool(r.get("ok"))
        except Exception as e:
            log("helper unlock failed: %s" % e); return False

    def end(self, reason):
        """reason: quiz_submitted | quiz_left | quiz_tab_closed. A failed unlock is kept as pending and
        retried until the helper confirms - the student is never left blocked after the quiz."""
        quiz = self.quiz
        if not self.send_unlock(quiz, reason):
            self.pending, self.pending_try = (quiz, reason), time.time()
        if reason != "quiz_submitted":
            try: self.helper("/event", {"event": "quiz_left", "quiz_id": quiz, "detail": reason})
            except Exception:   # helper unreachable: send it directly (unsigned, best-effort)
                self.api_post("/report", {"device_id": self.device, "event": "quiz_left", "quiz_id": quiz,
                                          "student": self.student, "source": "agent", "detail": reason})
        log("UNLOCKED (%s)%s" % (reason, " - helper did not confirm, retrying" if self.pending else ""))
        # A Firefox started during the quiz read the quiz policies at start and keeps them until it restarts.
        try:
            if not developer_mode() and gecko_pids(ps_procs(), self.quiz_app):
                dialog("AI is unlocked. Restart Firefox to get its AI features back.")
        except Exception: pass
        self.locked, self.quiz, self.url, self.missing_since = False, None, None, None

    def adopt(self, st, present):
        """The helper is locked but this agent is not (agent restarted, or the helper resumed a lock
        after a reboot): take the lock over so it ends with the quiz. If the quiz is not open it ends
        after the normal grace period."""
        q = st.get("quiz_id")
        self.locked, self.quiz, self.url = True, q, present.get(q, "")
        self.missing_since = None if q in present else time.time()
        self.last_beat, self.tabs_seen = time.time(), 0
        log("adopted existing lock %s" % q)

    def add_cap(self, q, now=None):
        """A quiz the helper (cap / server / other school) just released: not re-locked while its page stays open."""
        now = time.time() if now is None else now
        if q not in self.capped: self.cap_left[q] = False
        self.capped[q] = now

    def note_cap(self, st):
        q = st.get("capped_quiz") if isinstance(st, dict) else None
        if not q or q in self.capped: return
        try: at = float(st.get("capped_at") or 0)
        except Exception: at = 0.0
        if q in self.cap_forgot and at <= self.cap_forgot[q]: return   # a release this agent already forgot
        self.add_cap(q)

    def forget_cap(self, q, why):
        """Its page was closed, or a NEW attempt started: the quiz locks normally again. The helper forgets it too."""
        self.capped.pop(q, None); self.cap_left.pop(q, None); self.cap_forgot[q] = time.time()
        log("%s: %s may lock again" % (why, q))
        try: self.helper("/uncap", {"quiz_id": q}, timeout=8)
        except Exception as e: log("helper uncap failed: %s" % e)

    def cap_step(self, present, now):
        """A released quiz stays unlocked while its page stays open (the student finishes what they were
        doing). Once the page has been gone for the grace period, or the student went back to the quiz's
        summary page and then opened an attempt again (a new attempt), it locks normally again."""
        for q in list(self.capped):
            if q in present:
                attempt = "/attempt/" in url_parts(present[q])[0]
                if attempt and self.cap_left.get(q):
                    self.forget_cap(q, "new attempt"); continue
                if not attempt: self.cap_left[q] = True
                self.capped[q] = now
            elif now - self.capped[q] > GRACE:
                self.forget_cap(q, "page closed")

    def tick(self, tabs=None, dev=None):
        # Developer mode (admin only): same quiz flow (gate password, start/end reporting) but the
        # daemon never blocks AI and search tabs are never rewritten.
        dev = developer_mode() if dev is None else dev
        tabs = browser_tabs() if tabs is None else tabs
        # A quiz opened from Brightspace Content/Lessons runs in a frame, so its submission never shows
        # in the address bar. Move it to its own page (same quiz, same attempt): from then on the address
        # bar shows every quiz page, including "submitted", and AI comes back the moment it is turned in.
        for (a, w, t, u) in tabs:
            inner = inner_url(u)
            if w >= 0 and inner != u and is_quiz(inner):
                log("quiz opened from Content: moved to its own page (%s)" % lock_id(inner))
                set_tab_url(a, w, t, inner)
        tabs = [(a, w, t, inner_url(u)) for (a, w, t, u) in tabs]   # quizzes opened from Content/Lessons
        now = time.time()
        urls = [u for (_, _, _, u) in tabs]
        present, left = classify(urls)
        any_leaving = any(is_leaving(u) for u in urls)
        # A quiz released by the safety cap or by the server is never re-locked while it stays open; once
        # its page has been gone for the grace period, a new attempt locks normally again.
        self.cap_step(present, now)
        open_quizzes = {q: u for q, u in present.items() if q not in self.capped}
        if not self.verified:
            self.ensure_identity(quiz=bool(open_quizzes))
        if not self.locked:
            if open_quizzes:
                url = next(iter(open_quizzes.values()))
                self.start(url, next((a for (a, _, _, u) in tabs if u == url), None))
                if self.locked: self.tabs_seen = len(tabs)
                return
            if self.pending and now - self.pending_try >= 5:
                self.pending_try = now
                if self.send_unlock(*self.pending):
                    log("pending unlock confirmed (%s)" % self.pending[1]); self.pending = None
                return
            # Unlocked here: make sure the helper is not still locked (a lost unlock, a resumed lock).
            if now - self.last_check > 10:
                self.last_check = now
                try:
                    st = self.helper("/status", timeout=8)
                    self.note_cap(st)
                    if st.get("state") == "locked" and st.get("quiz_id") and st["quiz_id"] not in self.capped:
                        self.adopt(st, present)
                except Exception as e: log("helper check failed: %s" % e)
            return
        # locked
        if self.quiz in present and self.quiz not in self.capped:
            self.missing_since = None
            self.tabs_seen = max(self.tabs_seen, len(tabs))
            if not self.url or "/attempt/" in url_parts(present[self.quiz])[0]: self.url = present[self.quiz]
            if not self.quiz_app: self.quiz_app = next((a for (a, _, _, u) in tabs if u == present[self.quiz]), None)
        else:
            if self.quiz in left or (any_leaving and not open_quizzes):
                self.end("quiz_submitted"); return
            if open_quizzes:          # our quiz is gone and another one is open: hand over at once
                self.end("quiz_left"); return
            self.missing_since = self.missing_since or now
            if now - self.missing_since > GRACE:
                self.end(unlock_reason(tabs, self.tabs_seen)); return
        # Gated quizzes change password every 5 min. Until the attempt starts (still on the quiz's
        # start page, no "/attempt/" in the URL), re-check and hand over a new one if it changed. A quiz
        # that has not opened yet is asked on the slower C2 schedule (pw_next).
        cur = present.get(self.quiz)
        if cur and "/attempt/" not in url_parts(cur)[0] and now >= self.pw_next:
            self.pw_next = now + 15
            try:
                if self.pw_reply(self.helper("/password", {"url": cur}), now) == "other": return
            except Exception as e: log("password refresh failed: %s" % e)
        # Self-heal: if the helper is no longer locked while the quiz is still open (helper restarted,
        # someone unloaded it), lock again right away - EXCEPT when the safety cap or the server
        # (submitted / ended) released this quiz: then the student stays unlocked.
        if now - self.last_check > 10:
            self.last_check = now
            try:
                st = self.helper("/status")
                self.helper_ok = True
                self.note_cap(st)
                if self.quiz in self.capped:
                    log("%s released %s — not re-locking" % (st.get("capped_reason") or "safety cap", self.quiz))
                    self.locked, self.quiz, self.url, self.missing_since = False, None, None, None
                    return
                if st.get("state") not in ("locked", "developer"):
                    log("helper not locked during an open quiz (%s) — re-locking" % st.get("state"))
                    self.helper("/lock", {"quiz_id": self.quiz, "student": self.student, "url": self.url or ""})
            except Exception as e:
                self.helper_ok = False; log("helper check failed: %s" % e)
        if not dev:
            # AI tabs opened before the quiz (an open chat keeps its connection past the hosts block) go
            # to about:blank; AI-answer searches go to plain Google web results.
            hosts, paths = self.blocklist()
            for (app, wi, ti, u) in tabs:
                if wi < 0: continue
                new = "about:blank" if blocked_tab(u, hosts, paths) else rewrite_search(u)
                if new: set_tab_url(app, wi, ti, new)
            # Opera reopened during the quiz (no policy layer, built-in VPN) -> closed again.
            if now - getattr(self, "opera_check", 0) >= 5:
                self.opera_check = now
                o = no_policy_pids(ps_procs(), self.quiz_app)
                if close_pids(o) and not self.opera_warned:
                    self.opera_warned = True
                    dialog("Opera was closed: it cannot turn its AI off during a quiz. Use it again after the quiz.")
        # Report to the server ONLY while the helper is unreachable (proof for "helper killed"); while the
        # helper answers, its own signed pings say everything -> no routine agent traffic (free plan).
        if not getattr(self, "helper_ok", True) and now - self.last_beat > BEAT:
            self.last_beat = now
            self.api_post("/report", {"device_id": self.device, "event": "heartbeat", "quiz_id": self.quiz,
                                      "student": self.student, "source": "agent"})

    def run(self):
        try: self.helper("/student", {"student": self.student}, timeout=8)
        except Exception as e: log("helper not reachable yet: %s" % e)
        # If the daemon is already locked (resumed after a reboot/login), adopt that lock so we unlock
        # correctly when the quiz ends instead of leaving the student blocked until the hard max.
        try:
            st = self.helper("/status", timeout=8)
            self.note_cap(st)
            if st.get("state") in ("locked", "developer") and st.get("quiz_id"):
                self.adopt(st, {})
        except Exception as e: log("startup status check failed: %s" % e)
        log("running (device %s, student %s)" % (self.device, self.student))
        self.ensure_identity(force=True)   # checks the server once per login; asks only if not yet confirmed
        while True:
            try: self.tick()
            except Exception as e: log("tick error: %s" % e)
            time.sleep(POLL_LOCKED if self.locked else POLL)

if __name__ == "__main__":
    Agent().run()
