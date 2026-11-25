#!/usr/bin/env python3
"""LOCKqz agent (macOS). Per-user LaunchAgent. Replaces the browser extension, so the
student installs ONE thing and nothing comes from the Chrome Web Store.

Every 2 s it reads the open tab URLs of every running browser (Chrome, Edge, Brave,
Chromium, Vivaldi, Arc, Safari via Apple Events; Firefox via its session file) and:
  * on a Brightspace quiz attempt page  -> tells the root helper to LOCK, then asks the
    helper for the quiz password (the helper checks its block is in place and makes a
    request signed with its root-only device key) and enters it in the quiz page itself
    (never shown, never copied: see HAND_APPS)
  * while locked                        -> pings the backend (live monitor), and forces
    any Google/Bing/DDG/... search tab onto Google "Web" results (no AI answer) —
    the backstop for Safari, which has no policy layer
  * when the quiz page is gone (submitted / left) -> tells the helper to UNLOCK
First run asks the student's school email ONCE (confirmed by an emailed code) so the
professor's roster and the quiz gate know who is locked.
"""
import random
import hashlib, json, os, re, subprocess, threading, time, urllib.error, urllib.request, urllib.parse, glob
NOPROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # never go through a system proxy

SYS_CONF = "/Library/Application Support/LOCKqz/config.json"
# Per-user copy of the helper's random control token, written by the helper (root) for the console user.
TOKEN_DIR = os.environ.get("LOCKQZ_TOKEN_DIR") or "/Library/Application Support/LOCKqz/tokens"
USER_DIR = os.path.expanduser("~/Library/Application Support/LOCKqz")
READY_FLAG = os.path.join(USER_DIR, "ready-shown")   # written once the "LOCKqz is ready" notice was shown
READY_TEXT = "LOCKqz is ready. Nothing to do until your exam \u2014 just open it in Brightspace."
# Shown instead while the server does not confirm this computer is verified, paid and not revoked.
SETUP_TEXT = "LOCKqz is installed. Finish setup before your exam: open https://lockqz.com"
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
PAY_FAST = 600   # s: how long an unpaid student's password is asked for at the server's fast pace
POLL, POLL_LOCKED, GRACE, BEAT = 2, 1, 30, 60   # agent reports (every 60s) only while the helper is unreachable
# A quiz the server released because Brightspace says the attempt is over (submitted, or a gated quiz's end): once its
# pages have been gone this long it locks normally again, so a student who goes back for another attempt is handed the
# password at once (it is entered before the attempt starts). The safety cap and the other releases keep GRACE.
SRV_GRACE, SRV_ENDS = 5, ("quiz_submitted", "quiz_ended")
DEV_KEY = os.path.join(USER_DIR, "developer.key")
DEV_KEY_HASH = "4695a520432e105e967dd2703366c24c039fe0a850fe35db03b73b6b9506aecd"

def at_console():
    """True when this account is the one at the screen. With fast user switching a switched-away
    account's agent keeps running but sees no browser: it must stay out of the way (the helper refuses
    it too). Unknown (no /dev/console, e.g. tests) = True."""
    try:
        out = subprocess.run(["stat", "-f", "%u", "/dev/console"], capture_output=True, text=True, timeout=5).stdout.strip()
        return int(out) == os.getuid() if out.isdigit() else True
    except Exception:
        return True

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
# A quiz's "turned in" pages (every leaving page except the quiz list): the attempt ends on this computer only
# when one of these takes the place of the exam's attempt page in the same tab, on the same Brightspace host.
SUBMIT_PATH_RE = re.compile(r"quiz_submissions|submission|feedback|results", re.I)
SUMMARY_PATH_RE = re.compile(r"quiz_summary", re.I)   # an exam's start page
ATT_SUB_S, ATT_SUB_SLOW = 15, 45   # s since that tab last showed the attempt page (live tabs / session files)
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
        # Every udm/tbm on the page must be an AI-free vertical (tbm=nws&udm=50 is not news).
        if (udm or tbm) and all(x in WEB_OK_UDM for x in udm) and all(x in WEB_OK_TBM for x in tbm):
            return None
        # Any other udm/tbm (AI Mode udm=50, Lens udm=26, ...) goes to plain web results, even with no q.
        if udm or tbm: return web
        return web if (query and path != "/") else None
    if host.endswith("bing.com") and path.startswith(("/search", "/copilotsearch", "/chat")): return web
    if host.endswith("duckduckgo.com") or host == "duck.ai": return web
    if host in ("search.yahoo.com", "search.brave.com", "you.com", "kagi.com") or host.endswith(".search.yahoo.com"): return web
    # More engines that answer with AI (Ecosia AI, Yandex Neuro, Baidu AI, Naver Cue, Ask, Yep, AOL=Bing, Sogou, 360):
    # their search pages go to Google Web too. Everything else on those hosts is left alone.
    if host.endswith(("ecosia.org", "yandex.com", "yandex.ru", "ya.ru", "ask.com", "yep.com", "sogou.com")) and path.startswith(("/search", "/web", "/chat")): return web
    if host.endswith("search.naver.com") and path.startswith("/search"): return web
    if host.endswith("search.aol.com") and path.startswith("/aol/"): return web
    if host.endswith(("baidu.com", "so.com")) and (path == "/s" or path.startswith(("/s?", "/search"))): return web
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

# (app, windowIndex, tabIndex) -> a key that stays with that tab while windows are reordered (window id plus the
# tab's own id, or its place in that window): filled by browser_tabs(keys=True), read by the attempt evidence.
TAB_KEYS, WANT_KEYS = {}, [False]   # WANT_KEYS[0]: the agent is locked (set by tick)
def browser_tabs():
    """-> list of (app, windowIndex, tabIndex, url) across every running browser (while locked, also TAB_KEYS)."""
    tabs, procs = [], ps_procs()
    apps = running_apps(procs)
    keys = WANT_KEYS[0]
    TAB_KEYS.clear()
    for app in JXA_BROWSERS:
        if app not in apps: continue   # never name a browser that is not running (JXA would launch it)
        try:
            if keys:
                js = ('JSON.stringify(Application(%s).windows().map(function(w){var i=null,d=null;try{i=w.id()}catch(e){}'
                      'try{d=w.tabs.id()}catch(e){}return {u:w.tabs().map(t=>t.url()),w:i,t:d}}))') % json.dumps(app)
            else:
                js = 'JSON.stringify(Application(%s).windows().map(w=>w.tabs().map(t=>t.url())))' % json.dumps(app)
            for wi, win in enumerate(json.loads(osa(js) or "[]")):
                urls = win.get("u") if isinstance(win, dict) else win
                for ti, u in enumerate(urls or []):
                    tabs.append((app, wi, ti, u or ""))
                    if isinstance(win, dict):
                        ids = win.get("t") if isinstance(win.get("t"), list) else []
                        TAB_KEYS[(app, wi, ti)] = (app, win.get("w") if win.get("w") is not None else "w%d" % wi,
                                                   ids[ti] if ti < len(ids) and ids[ti] is not None else "#%d" % ti)
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

GECKO_APP_RE = re.compile(r"^(/.+?\.app)/Contents/MacOS/")

def gecko_app(procs, base):
    """The running app (its .app path) of the Gecko browser whose profile folder is `base`; None when not running."""
    for (_, _, comm) in procs:
        if base in GECKO_DIRS.get(os.path.basename(comm).lower(), []):
            m = GECKO_APP_RE.match(comm)
            if m: return m.group(1)
    return None

def new_gecko_searches(tabs, before, blocked):
    """Firefox and its forks (tabs read from their session files, wi < 0): a search with an AI answer that is NEW since
    the last look -> [(profile folder, AI-free results URL)]. No tab of theirs can be sent anywhere from outside, so the
    results open in a new tab of the same browser, once per search; `before` = the (folder, url) seen last time."""
    out = []
    for (app, wi, _, u) in tabs:
        if wi >= 0 or (app, u) in before or blocked(u): continue
        new = rewrite_search(u)
        if new: out.append((app, new))
    return out

def open_search(procs, base, url):
    """Opens url in a new tab of the running Gecko browser whose profile folder is `base` (Linux has its own)."""
    a = gecko_app(procs, base)
    if not a: return False
    try: return subprocess.run(["/usr/bin/open", "-a", a, url], capture_output=True, timeout=10).returncode == 0
    except Exception as e:
        log("could not open Web results: %s" % e); return False

def set_tab_url(app, wi, ti, url, expect=None):
    """Sends one tab to url. expect: the address that tab showed when the tabs were read. Windows are listed
    front to back, so a click on another window between that read and this call shifts the indexes: the
    tab is changed only if it still shows that address (its # part aside), never some other tab."""
    js = "(function(){var t=Application(%s).windows()[%d].tabs()[%d];" % (json.dumps(app), wi, ti)
    if expect is not None:
        js += "if(String(t.url()||\"\").split(\"#\")[0]!==%s)return \"moved\";" % json.dumps(str(expect).split("#", 1)[0])
    js += "t.url=%s;return \"ok\";})()" % json.dumps(url)
    try: return osa(js) == "ok"
    except Exception: return False

_moved = {}
def move_content_quizzes(tabs, now=None, setter=None):
    """A quiz opened from Brightspace Content/Lessons runs in a frame, so its submission never shows in the
    address bar: move that tab to the quiz's own page (same quiz, same attempt). At most once every 10 s
    per quiz URL, so a page still loading is never sent there again (no reload loop). -> URLs moved."""
    now = time.time() if now is None else now
    setter = setter or set_tab_url
    done = []
    for k in [k for k, v in _moved.items() if now - v > 600]: del _moved[k]
    for (a, w, t, u) in tabs:
        inner = inner_url(u)
        if w < 0 or inner == u or not is_quiz(inner): continue
        if now - _moved.get(inner, 0) < 10: continue
        _moved[inner] = now
        log("quiz opened from Content: moved to its own page (%s)" % lock_id(inner))
        setter(a, w, t, inner, u)
        done.append(inner)
    return done

# ---------- browsers that cannot switch their AI off mid-session (G3/G4) ----------
OPERA_APPS = ("Opera", "Opera GX", "Opera Air", "Opera Neon")   # no policy layer (Aria AI, built-in VPN)
# The quiz password is entered by LOCKqz only: never shown, never copied (a password a student can read can be
# passed to a computer without LOCKqz). During a quiz Google Chrome, Brave and Microsoft Edge carry LOCKqz's own
# extension (browser-policy.py adds it for the length of the quiz, and turns their history off then, so the
# handed address is kept nowhere). The agent hands the password to the quiz tab in its address (#lqz=...); the
# extension takes it out at once, puts it into the page's password box and answers in the address: #lqz-got =
# it has the password, #lqz-in = it is in the box. An exam whose start page is open only in another browser
# (Safari, Firefox, Arc, Vivaldi...) is opened in the first of MOVE_TO that is installed, and taken there. A
# browser that gives no answer for HAND_WAIT seconds (MOVE_WAIT just after LOCKqz opened it) has no extension:
# the next one is tried. The extension answered but no password box for HAND_FILL_WAIT: the student is told
# where the box is (the extension still fills it when it appears).
HAND_APPS = frozenset(("Google Chrome", "Google Chrome Beta", "Google Chrome Dev", "Google Chrome Canary",
                       "Brave Browser", "Brave Browser Beta", "Brave Browser Nightly",
                       "Microsoft Edge", "Microsoft Edge Beta", "Microsoft Edge Dev", "Microsoft Edge Canary"))
MOVE_TO = ("Google Chrome", "Brave Browser", "Microsoft Edge")
HAND_WAIT, HAND_FILL_WAIT, HAND_EVERY, MOVE_WAIT, MOVE_AGAIN, MOVE_MAX = 30, 75, 3, 60, 90, 3
HAND_BY_OPEN = False   # Linux: a tab address cannot be set; the start page is opened again with the password (hand_step)
_INSTALLED = {}
def app_installed(app):
    """True when the app is in /Applications or ~/Applications (looked at once a minute)."""
    now = time.time(); c = _INSTALLED.get(app)
    if c and now - c[1] < 60: return c[0]
    ok = any(os.path.isdir(os.path.join(d, app + ".app")) for d in ("/Applications", os.path.expanduser("~/Applications")))
    _INSTALLED[app] = (ok, now)
    return ok
def open_in(app, url):
    """Opens url in app (started if it is not running). The address never carries the password."""
    try: return subprocess.run(["open", "-a", app, url], capture_output=True, timeout=20).returncode == 0
    except Exception as e:
        log("open in %s failed: %s" % (app, e)); return False
def hand_fragment(url):
    try: f = urllib.parse.urlsplit(str(url or "")).fragment
    except Exception: return ""
    return f if f.startswith("lqz") else ""
def strip_hand(url):
    """The URL without LOCKqz's own #lqz... part (every other rule sees the page's real address)."""
    return str(url or "").split("#", 1)[0] if hand_fragment(url) else url
GECKO_BINS = tuple(GECKO_DIRS)                                   # read policies only when they start
def no_policy_pids(procs, keep_app):
    """Main processes of the Opera family, except the browser the quiz is in."""
    out = []
    for pid, _, comm in procs:
        m = APP_MAIN_RE.search(comm)
        if m and m.group(1) in OPERA_APPS and m.group(1) != keep_app: out.append((pid, m.group(1)))
    return out

# Browsers LOCKqz can police (policy plist and/or tab reading). Any OTHER running app that handles
# http(s) links (Orion, Helium, Thorium, a re-signed Chrome copy with a new bundle id ...) has no policy:
# its own DNS-over-HTTPS / proxy skips /etc/hosts and Google AI Mode is open in it -> closed while locked.
POLICED_IDS = {"com.apple.Safari", "com.apple.SafariTechnologyPreview",
               "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary",
               "com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.microsoft.edgemac.Dev", "com.microsoft.edgemac.Canary",
               "com.brave.Browser", "com.brave.Browser.beta", "com.brave.Browser.nightly", "org.chromium.Chromium",
               "com.vivaldi.Vivaldi", "company.thebrowser.Browser", "org.mozilla.firefox",
               "org.mozilla.firefoxdeveloperedition", "org.mozilla.nightly", "org.mozilla.librewolf",
               "net.waterfox.waterfox", "one.ablaze.floorp", "app.zen-browser.zen", "net.mullvad.mullvadbrowser",
               "org.torproject.torbrowser"}
_bundle_cache = {}
def _bundle_info(comm):
    """(bundle id, handles http) for a main binary path '/X.app/Contents/MacOS/x', cached."""
    m = re.search(r"^(.*?\.app)/Contents/MacOS/[^/]+$", comm or "")
    if not m: return None, False
    app = m.group(1)
    if app not in _bundle_cache:
        bid, web = None, False
        try:
            import plistlib
            with open(os.path.join(app, "Contents", "Info.plist"), "rb") as f: info = plistlib.load(f)
            bid = str(info.get("CFBundleIdentifier") or "")
            for t in info.get("CFBundleURLTypes") or []:
                if {"http", "https"} & {str(x).lower() for x in (t.get("CFBundleURLSchemes") or [])}: web = True
        except Exception: pass
        _bundle_cache[app] = (bid, web)
    return _bundle_cache[app]

def unpoliced_browser_pids(procs, keep_app, denied=()):
    """Main processes of web browsers LOCKqz cannot police, plus browsers whose tabs the student
    refused to let LOCKqz read (Automation 'Don't Allow': no tab rewrite, e.g. Safari + Google AI Mode)."""
    out = []
    for pid, _, comm in procs:
        m = APP_MAIN_RE.search(comm)
        if not m or m.group(1) == keep_app or "/System/" in comm: continue
        bid, web = _bundle_info(comm)
        if (web and bid not in POLICED_IDS) or m.group(1) in denied: out.append((pid, m.group(1)))
    return out

def join_names(names):
    names = list(names)
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]

def closed_note(names):
    """The note for browsers closed for the whole quiz (no policy reaches them); '' for none."""
    names = [str(n).replace("other:", "") for n in names]
    if not names: return ""
    if len(names) == 1: return "\n\n%s was closed: it cannot turn its AI off during a quiz. Use it again after the quiz." % names[0]
    return "\n\n%s were closed: they cannot turn their AI off during a quiz. Use them again after the quiz." % join_names(names)

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

EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")   # ' is a real email character (o'brien@...)

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
    def open_url(self, u):
        try: subprocess.run(["open", u], timeout=10)
        except Exception as e: log("open failed: %s" % e)

ASK = "Enter your school email (the one Brightspace uses, e.g. you@usc.edu):"
CODE_FRESH = 12 * 60   # a code sent less than 12 min ago is still good (server: 15 min): ask for it, don't resend

# The email is asked ONCE. The moment the student types it, it is saved on this computer (save());
# every later try goes straight to the emailed code. Server/network trouble is NEVER shown as a popup:
# setup just stops quietly (state["r"] = "server") and the agent retries in the background.
NOLOCK_AGAIN = 180   # a quiz LOCKqz does not protect: asked again every 3 minutes while its page stays open
GOOGLE_POLL, GOOGLE_WAIT = 4, 600   # Google sign-in: check every 4 s, give up (-> email code) after 10 min
GOOGLE_URL = re.compile(r"^%s/google\?n=[0-9a-f]{32}$" % (re.escape(os.environ["LOCKQZ_SITE"].rstrip("/")) if os.environ.get("LOCKQZ_SITE") else r"https://lockqz\.(?:com|pages\.dev)"))
def _google(call, ui, state):
    """One click instead of an emailed code: sign in with the school Google account in the browser; the
    server confirms the email and this computer sees it through "status". -> (email, True); None = use
    the email code (Google sign-in off, not chosen, or not finished); False = the dialog was closed."""
    if not hasattr(ui, "open_url"): return None
    g = call("google_start")
    url = g.get("url") if isinstance(g, dict) else None
    if not (isinstance(url, str) and GOOGLE_URL.match(url)): return None
    b, _ = ui.ask("LOCKqz setup (one time only)\n\nConfirm your school email with your USC Google account.",
                  ["Use an email code", "Sign in with Google"], answer=False)
    if b is None: state["r"] = "closed"; return False
    if b != "Sign in with Google": return None
    ui.open_url(url)
    end = time.time() + GOOGLE_WAIT
    while time.time() < end:
        time.sleep(GOOGLE_POLL)
        st = call("status")
        if st.get("verified") and st.get("student"):
            if st.get("vtoken"): state["vtoken"] = st["vtoken"]
            ui.say("Done. LOCKqz is set up and won't ask again.")
            return (st["student"], True)
    return None

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
            g = _google(call, ui, state)
            if g is False: return None               # the student closed the dialog
            if g: return g
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
            b, code = ui.ask(note + "We emailed a 6-digit code to\n%s\nIt comes from support@lockqz.com.\n\nType it here (check Junk/Spam if you don't see it):" % email,
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

def pay_text(pay):
    """The unpaid message: every way at its own price ("$200 by Zelle, or $210 by card or Venmo"), the memo for
    Zelle / Venmo. An older server sends one amount."""
    line, code = pay.get("line"), str(pay.get("code") or "")
    if isinstance(line, str) and line.strip():
        t = "Pay for LOCKqz this semester to get the quiz password: %s." % line.strip().rstrip(".")
        if code and (pay.get("zelle") or pay.get("venmo")): t += "\n\nMemo for Zelle or Venmo:  %s" % code
    else:
        t = "Pay $%s for LOCKqz this semester to get the quiz password.\n\nMemo:  %s" % (pay.get("amount") or "", code)
    return t + "\n\nThe payment page is open. LOCKqz shows the password here as soon as your payment arrives."

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
        self.cap_why = {}            # quiz id -> why it was released (the helper's capped_reason)
        self.nolock = {}             # quiz id -> when to ask again: the helper did not lock it (not LOCKqz's quiz)
        self.cap_forgot = {}         # quiz id -> when this agent forgot its release (the helper's older one is ignored)
        self.tabs_seen = 0           # how many tabs were open while the quiz was open
        self.ready_told = os.path.exists(READY_FLAG)   # the one-time "LOCKqz is ready" notice (first Brightspace visit)
        self.last_check, self.lock_fail_shown = 0.0, {}
        self.hand = None   # the password hand-over to the quiz tab (see HAND_APPS)
        self.pw, self.pw_next, self.start_told = None, 0.0, None   # next /password check; "opens at" shown for
        self.quiz_app, self.opera_warned = None, False             # browser holding the quiz
        self.bl, self.bl_mtime = (set(), []), None                 # AI blocklist (hosts, host/path)
        self.seen, self.att_tabs = {}, {}   # per quiz: what this computer saw of its attempt (sent with an unlock)
        self.restart_wait = 0.0             # the quiz's own Firefox is being restarted: its page may be gone until then

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
                    was = self.verified
                    self.save_student(*got); self.id_fails, self.id_next = 0, 0.0
                    try: self.helper("/student", {"student": self.student})
                    except Exception: pass
                    if self.verified and not was: self.pay_after_setup()   # setup just finished: straight to the pay page
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

    def open_page(self, u):
        subprocess.run(["open", u], timeout=10)

    def pay_after_setup(self):
        """Right after the one-time setup: this semester's fee is not paid yet -> the student's own pay page opens
        by itself (no email to wait for). Once per setup; nothing opens for a paid student or when there is no fee."""
        try:
            st = self.verify_call("status")
            u = str(st.get("pay_url") or "")
            if st.get("verified") is True and st.get("paid") is False and u.startswith(("https://lockqz.com/", "https://lockqz.pages.dev/")):
                self.open_page(u); log("setup done: pay page opened")
        except Exception as e: log("pay page after setup: %s" % e)

    def payment(self, r):
        # Student fee unpaid: open the payment page once per quiz. The password arrives by itself
        # (re-checked every 15s) as soon as the Venmo/Zelle payment is matched.
        pay = r.get("pay") if isinstance(r, dict) else None
        if not isinstance(pay, dict): return False
        if not getattr(self, "pay_shown", False):
            self.pay_shown = True
            u = str(pay.get("url") or "https://lockqz.com/pay")
            if u.startswith(("https://lockqz.com/", "https://lockqz.pages.dev/")):
                try: self.open_page(u)
                except Exception: pass
            dialog(pay_text(pay))
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
        """At lock: close Firefox (and forks) and Brave, which read their quiz policies only when they start, and the
        browsers no policy reaches (the Opera family, any other browser LOCKqz cannot police) - except the browser the
        quiz is in. -> note for the student ('' when nothing closed)."""
        procs = ps_procs()
        g, o, b = gecko_pids(procs, app), no_policy_pids(procs, app), restart_pids(procs, app)
        u = unpoliced_browser_pids(procs, app, set(_denied))
        close_pids(g + o + b + u)
        self.opera_check = time.time() + 5   # give the closed ones time to exit before re-checking
        if o or u: self.opera_warned = True  # the lock note already says so
        names = (["Firefox"] if g else []) + (["Brave"] if b else [])
        kept = (["Opera"] if o else []) + sorted(set(n for _, n in u) - {"Opera"})
        note = ""
        if len(names) == 1:
            note += "\n\n%s was closed for the quiz so its AI stays off. You can reopen it; your tabs come back." % names[0]
        elif names:
            note += "\n\n%s were closed for the quiz so their AI stays off. You can reopen them; your tabs come back." % join_names(names)
        return note + closed_note(kept)

    def restart_quiz_gecko(self, app):
        """The exam is open in a Firefox (or fork) that was already running when this lock began: it reads the quiz
        policies (its AI, encrypted DNS and built-in VPN off, AI sites blocked) only when it starts, so it is
        restarted once, now - closed at once (a forced close: it comes back with its tabs) and opened again.
        -> note for the student ('' when nothing was restarted)."""
        b = gecko_bin_of(app)
        if not b: return ""
        old = [(pid, comm) for pid, et, comm in ps_procs()
               if ".app/Contents/MacOS/" in comm and os.path.basename(comm).lower() == b and et > 3]
        if not old: return ""
        import signal
        for pid, _ in old:
            try: os.kill(pid, signal.SIGKILL)
            except Exception: pass
        apps = sorted({comm.split(".app/Contents/MacOS/")[0] + ".app" for _, comm in old})
        self.restart_wait = time.time() + 120   # its exam page is gone until it is back (not "the exam was closed")
        def reopen():
            time.sleep(2)
            for a in apps:
                try: subprocess.run(["open", "-a", a], timeout=20, capture_output=True)
                except Exception as e: log("reopen %s failed: %s" % (a, e))
        threading.Thread(target=reopen, daemon=True).start()
        log("%s restarted for %s (quiz policies are read when it starts)" % (app, self.quiz))
        return "\n\n%s was restarted for the exam so its AI stays off. Your tabs come back." % app

    def pw_reply(self, r, now, first=False, note=""):
        """Act on the helper's /password answer -> "pw" | "pay" | "wait" | "other" | None (nothing yet).
        Sets when the next check may run (C2: a quiz that has not opened yet is asked every 5 min, then
        every 15 s from 90 s before it opens)."""
        r = r if isinstance(r, dict) else {}
        pw, reason = r.get("password"), r.get("reason")
        if pw:
            changed, had = pw != self.pw, self.pw
            # Gated quiz: the server says when the code can next change (older servers: every 15 s).
            rc = r.get("recheck")
            self.pw, self.pw_next = pw, now + (max(15, min(360, rc)) if isinstance(rc, (int, float)) else 15)
            if changed and not developer_mode():
                # LOCKqz enters it in the quiz page itself (hand_step): never shown, never copied.
                self.hand = {"pw": pw, "since": now, "sent": 0.0, "got": False, "in": False, "told": False}
                if first and getattr(self, "quiz_app", None) in HAND_APPS:
                    dialog("AI is locked for this quiz.\n\nLOCKqz enters the quiz password for you. Just start the quiz." + note)
                elif first and note:
                    dialog("AI is locked for this quiz." + note)   # where the quiz opens for its password follows (hand_move)
            elif changed:
                # Developer mode (the admin's own Mac, its key file): shown so the admin can try a quiz by hand.
                self.hand = None
                clipboard(pw)
                if first: dialog("Developer mode: AI stays ON for you.\n\nQuiz password:  %s\n(copied to your clipboard)" % pw)
            return "pw"
        if self.payment(r):
            # Unpaid at the exam: asked again at the server's pace (a few seconds) for the first 10 minutes after
            # the pay page opened, so the password follows the payment at once; after that every 15 s.
            if not getattr(self, "pay_since", 0): self.pay_since = now
            rc = r.get("recheck")
            fast = isinstance(rc, (int, float)) and not isinstance(rc, bool) and now - self.pay_since < PAY_FAST
            self.pw_next = now + (max(2, min(15, rc)) if fast else 15)
            if first and note: dialog("AI is locked for this quiz." + note)
            return "pay"
        if reason == "not started":
            si = r.get("start_in")
            opens = now + si if isinstance(si, (int, float)) else None
            self.pw_next = next_password_check(now, opens)
            if self.start_told != self.quiz:
                self.start_told = self.quiz
                at = time.strftime("%I:%M %p", time.localtime(opens)).lstrip("0") if opens else "its start time"
                dialog("AI is locked for this quiz.\n\nThe quiz opens at %s. LOCKqz enters its password for you then." % at + note)
            return "wait"
        if reason == "other_school":
            # C10: the helper has already put AI back (nothing to protect here).
            dialog("LOCKqz is not set up for this school yet.\n\nAI stays on for this quiz.")
            self.add_cap(self.quiz, now)
            log("other school: %s not protected" % self.quiz)
            self.locked, self.quiz, self.url, self.missing_since = False, None, None, None
            return "other"
        if reason == "not_protected":
            # This class is not using LOCKqz (its professor has not signed up / is not active). The helper
            # locked AI when the quiz opened; restore it now, quietly, and tell no one.
            q = self.quiz
            self.send_unlock(q, "not_protected")
            self.add_cap(q, now)
            log("not protected: %s (class not using LOCKqz)" % q)
            self.locked, self.quiz, self.url, self.missing_since = False, None, None, None
            return "other"
        if reason == "verify":
            self.ensure_identity(force=True)   # the server needs the confirmed school email first
        if reason == "gate_off" and getattr(self, "gate_told", None) != self.quiz:
            # The professor's gate is not running yet: the password is held; it arrives by itself.
            self.gate_told = self.quiz
            dialog("AI is locked for this quiz.\n\nThe quiz opens once your professor's LOCKqz is running. LOCKqz enters its password for you then." + note)
        if reason in ("in_use", "too_many_devices") and getattr(self, "share_told", None) != self.quiz:
            # One payment = one student: the paid email is in use on another computer.
            self.share_told = self.quiz
            dialog("This school email is in a quiz on another computer right now.\n\nOne payment covers one student." if reason == "in_use"
                   else "This school email is already used on 2 computers.\n\nEmail support@lockqz.com to remove one.")
        if reason == "vm":
            # LOCKqz runs inside a virtual machine: no password (the real computer around it keeps AI).
            if getattr(self, "vm_told", None) != self.quiz:
                self.vm_told = self.quiz
                dialog("This quiz can't open inside a virtual machine.\n\nOpen it on the computer itself.")
            self.pw_next = now + 120
            return "vm"
        # LOCKqz busy (free-plan limit, 503 server_busy) or unreachable: back off with jitter (30 s .. 5 min)
        # so thousands of waiting students do not burn the daily request budget; any answer resets it.
        if reason is None and (not r or r.get("error") == "server_busy"):
            self.busy_n = getattr(self, "busy_n", 0) + 1
            self.pw_next = now + min(300, 15 * 2 ** min(self.busy_n, 5)) * (0.5 + random.random() / 2)
            return None
        self.busy_n = 0
        self.pw_next = now + 15
        return None

    def hand_step(self, tabs, now, setter=None):
        """One look at the quiz's start pages while LOCKqz enters its password (tabs = raw addresses). Every open
        start page of this quiz in a browser with LOCKqz's extension (HAND_APPS) is handed it: the extension fills
        only the tab it was handed to, and a student may have the quiz open in two tabs. A tab's #lqz-in / #lqz-got
        counts only once THIS password was handed to that tab: an answer left in an address from before (a changed
        password, Chrome restarted during the quiz with its tabs restored) says nothing about this one. Entered =
        every such tab #lqz-in. The password is never shown or copied: a start page open only in another browser is
        opened in one with the extension (hand_move), and a browser that never answers is left for the next one."""
        h = getattr(self, "hand", None)
        if not h or not self.locked: return
        if h.get("lost"):
            # The quiz page was gone and is back (Chrome quit and reopened with its tabs restored): the page
            # is new and its box empty, whatever its address still says. Handed over again from the start.
            h.update(since=now, sent=0.0, got=False, told=False, handed=set(), lost=False, seen=None, bad=set(), moves=0,
                     moved_at=None, none_told=False)
            h["in"] = False
        setter = setter or set_tab_url
        handed, bad = h.setdefault("handed", set()), h.setdefault("bad", set())
        mine, other = [], []
        for (a, w, t, u) in tabs:
            base = strip_hand(u)
            if not (is_quiz(base) and lock_id(base) == self.quiz and "/attempt/" not in url_parts(base)[0]): continue
            page = base.split("#", 1)[0]
            if w >= 0 and a in HAND_APPS and a not in bad:
                mine.append((a, w, t, u, page, hand_fragment(u) if (a, w, t) in handed else ""))
            else: other.append((a, page))
        if h["in"]: return
        if HAND_BY_OPEN: return self.hand_by_open(h, tabs, other, now)
        if any(f == "lqz-in" for (*_, f) in mine) and not h.get("said"):
            h["said"] = True; log("quiz password entered in the quiz page")
        if any(f in ("lqz-in", "lqz-got") for (*_, f) in mine): h["got"] = True
        if mine and all(f == "lqz-in" for (*_, f) in mine):
            h["in"] = True; return
        if not mine:
            h["seen"] = None
            if other: self.hand_move(h, other[0][1], now)
            return
        if h.get("seen") is None: h["seen"] = now   # a start page in a browser with the extension: its wait starts now
        waited = now - h["seen"]
        wait = MOVE_WAIT if h.get("moved_to") in {m[0] for m in mine} else HAND_WAIT   # just opened: it may still be adding the extension
        # Handed again every few seconds until each tab answers: for the wait, and once a tab has answered (the
        # extension is there) until the password is entered.
        todo = [m for m in mine if m[5] not in ("lqz-in", "lqz-got")]
        if todo and (waited <= wait or h["got"]) and now - h["sent"] >= HAND_EVERY:
            h["sent"] = now
            for (a, w, t, u, page, _) in todo:
                if setter(a, w, t, page + "#lqz=" + urllib.parse.quote(h["pw"], safe=""), u) is not False: handed.add((a, w, t))
        if not h["got"] and waited > wait:
            # No answer: this browser has no LOCKqz extension (yet). The password leaves its address; the next browser is tried.
            for (a, w, t, u, page, _) in mine:
                if hand_fragment(u).startswith("lqz="): setter(a, w, t, page + "#", u)
            apps = sorted({m[0] for m in mine})
            log("no answer from %s for the quiz password - another browser is tried" % ", ".join(apps))
            bad.update(apps); h["seen"] = None
            self.hand_move(h, mine[0][4], now, failed=apps[0])
        elif h["got"] and waited > HAND_FILL_WAIT and not h["told"]:
            # The extension has it but the page shows no password box yet: it enters it when the box appears.
            h["told"] = True
            dialog("LOCKqz has the quiz password ready. Open the quiz's start page (the one with Start Quiz): LOCKqz enters it there.")

    def hand_by_open(self, h, tabs, other, now):
        """(Linux) A tab address cannot be set, and its tabs come from session files: the quiz's start page, once it
        shows in a running browser with LOCKqz's extension, is opened there again with the password in its address
        (launched into the running browser, so no long-lived command line carries it; its history is off during the
        quiz). Answers are read from the session files. At most twice per password, MOVE_WAIT apart."""
        here = [(a, p) for (a, p) in other if a in HAND_APPS]
        if not here and other:
            # Not open in such a browser yet. One that is running (its session file is read) is handed it at once;
            # otherwise the start page is opened, without the password, in one that is installed (it starts).
            run = {a for (a, w, t, u) in tabs if a in HAND_APPS}
            a0 = next((a for a in MOVE_TO if a in run), None)
            if a0: here = [(a0, other[0][1])]
        if h.get("opened_at"):
            ans = {hand_fragment(u) for (a, w, t, u) in tabs
                   if a in HAND_APPS and is_quiz(strip_hand(u)) and lock_id(strip_hand(u)) == self.quiz}
            if "lqz-in" in ans:
                h["in"] = True; log("quiz password entered in the quiz page"); return
            if "lqz-got" in ans: h["got"] = True
        if not here:
            if other: self.hand_move(h, other[0][1], now)
            return
        if h["got"] or (h.get("opened_at") and now - h["opened_at"] < MOVE_WAIT): return
        if h.get("opens", 0) >= 2:
            if not h.get("none_told"):
                h["none_told"] = True
                dialog("AI is locked for this quiz.\n\nLOCKqz could not enter the quiz password in %s. Quit it, then open the quiz again." % here[0][0])
            return
        if open_in(here[0][0], here[0][1] + "#lqz=" + urllib.parse.quote(h["pw"], safe="")):
            h["opened_at"], h["opens"] = now, h.get("opens", 0) + 1
            log("quiz password handed to %s" % here[0][0])

    def hand_move(self, h, page, now, failed=None):
        """The quiz's start page is open only where LOCKqz cannot enter its password: open it in the first browser of
        MOVE_TO that is installed and has not failed (at most MOVE_MAX times, MOVE_AGAIN apart unless a browser just
        failed: a sign-in page may come first). None installed: the student is told to open it in Chrome."""
        if not failed and h.get("moved_at") and now - h["moved_at"] < MOVE_AGAIN: return
        bad = h.setdefault("bad", set())
        target = next((a for a in MOVE_TO if a not in bad and app_installed(a)), None)
        if target and h.get("moves", 0) < MOVE_MAX:
            h["moved_at"], h["moved_to"], h["moves"] = now, target, h.get("moves", 0) + 1
            if not open_in(target, page):
                bad.add(target); return
            log("quiz %s opened in %s: LOCKqz enters its password there" % (self.quiz, target))
            if h.get("move_told") != target:
                h["move_told"] = target
                why = ("LOCKqz could not enter the quiz password in %s.\n\n" % failed) if failed else ""
                dialog("AI is locked for this quiz.\n\n" + why + "Your quiz opened in %s: LOCKqz enters its password there. "
                       "Take the quiz in %s." % (target, target))
        elif not h.get("none_told"):
            h["none_told"] = True   # looked at again on every look: a browser installed now is used at once
            have = [a for a in MOVE_TO if app_installed(a)]
            if bad and have: msg = "LOCKqz could not enter the quiz password in %s. Quit it, then open the quiz again." % ", ".join(sorted(bad))
            elif have: msg = "Open the quiz in %s: LOCKqz enters its password there." % have[0]
            else: msg = ("Open it in Google Chrome: LOCKqz enters the quiz password there (Brave and Microsoft Edge work too)."
                         "\n\nNo Chrome? Get it at google.com/chrome")
            dialog("AI is locked for this quiz.\n\n" + msg)

    def start(self, url, app=None):
        quiz = lock_id(url)
        if app in OPERA_APPS and not developer_mode():
            # Opera has no policy layer (its Aria AI and built-in VPN stay on): a quiz open in Opera is neither
            # locked nor given its password; the student is told once to open it in another browser.
            self.nolock[quiz] = time.time() + 20
            if getattr(self, "opera_told", None) != quiz:
                self.opera_told = quiz
                dialog("Opera cannot turn its AI off during a quiz.\n\nOpen this quiz in Chrome, Safari, Edge or Firefox to take it.")
            log("quiz %s is open in %s (no AI policy) - not locked, no password" % (quiz, app)); return
        try:
            r = self.helper("/lock", {"quiz_id": quiz, "student": self.student, "url": url})
            if isinstance(r, dict) and r.get("not_protected"):
                # Not LOCKqz's quiz (a class or exam not using LOCKqz): nothing locked, nothing closed, nothing
                # said. Asked again every 3 minutes while its page stays open (its professor may turn LOCKqz on).
                self.nolock[quiz] = time.time() + NOLOCK_AGAIN
                log("not protected: %s (%s) - not locked" % (quiz, r.get("reason") or "not_protected")); return
            if not (isinstance(r, dict) and r.get("ok")): raise RuntimeError("helper answered %r" % (r,))
        except Exception as e:
            log("helper lock failed: %s" % e)
            busy = isinstance(e, urllib.error.HTTPError) and e.code == 409
            if time.time() - self.lock_fail_shown.get(quiz, 0) > 120:   # retried every tick; tell the student once
                self.lock_fail_shown[quiz] = time.time()
                dialog("Another account on this Mac is taking a LOCKqz quiz right now. Switch back to it, or log it out, to take this quiz here."
                       if busy else "LOCKqz could not lock AI for this quiz. Is the LOCKqz app installed and running?")
            return
        self.quiz, self.url, self.quiz_app, self.opera_warned, self.hand = quiz, url, app, False, None
        self.locked, self.missing_since, self.last_beat, self.pending = True, None, time.time(), None
        self.start_told = None
        # What was seen of this exam's attempt is kept for 6 h (a student who stepped out and came back is still
        # in the same attempt); another exam starts fresh.
        for k in [k for k, v in self.seen.items() if time.time() - v.get("at", 0) > 6 * 3600]: self.seen.pop(k, None)
        if quiz not in self.seen: self.seen[quiz] = {"attempt": False, "sub": False, "rt": True, "at": time.time()}
        self.seen[quiz]["sub"] = False; self.att_tabs = {}
        if app not in JXA_BROWSERS: self.seen[quiz]["rt"] = False   # its tabs come from a session file, not live
        log("LOCKED %s" % self.quiz)
        dev = developer_mode()
        note = "" if dev else self.close_for_quiz(app) + self.restart_quiz_gecko(app)
        self.pw, self.pay_shown, self.pay_since, res = None, False, 0, None
        for attempt in range(3):   # the helper fetches it (signed); retry a brief network blip
            try:
                res = self.pw_reply(self.helper("/password", {"url": url}), time.time(), first=True, note=note)
            except Exception as e: log("password via helper failed: %s" % e)
            if res or not self.locked: break
            time.sleep(2)
        if res is None and self.locked and not self.pay_shown:
            dialog("AI is locked for this quiz.\n\nIf it needs a password, LOCKqz enters it for you as soon as the quiz opens." + note)

    HOLD_TEXT = ("AI stays off: this exam was not turned in on this computer.\n\n"
                 "Go back to the exam and submit it. AI comes back the moment it is submitted. "
                 "If you did submit, AI comes back by itself once Brightspace shows it, or when the exam ends.")
    def seen_for(self, quiz):
        """What this computer saw of the exam's attempt during the lock (the server ends an exam early only on
        this): sub = its turned-in page took the place of its attempt page in the same tab; attempt = an
        attempt page was seen (False only when every look at the exam came from a live tab list)."""
        ev = self.seen.get(quiz)
        if not ev: return {"sub": False, "attempt": None}
        att = True if ev.get("attempt") else (False if ev.get("rt") and not ev.get("adopted") else None)
        return {"sub": bool(ev.get("sub")), "attempt": att}
    def evidence_step(self, tabs, now):
        q = self.quiz
        if not q: return
        ev = self.seen.setdefault(q, {"attempt": False, "sub": False, "rt": True, "at": now})
        for (a, w, t, u) in tabs:
            if not is_quiz_page(u) or lock_id(u) != q: continue
            if w < 0: ev["rt"] = False   # a session file (Firefox, Linux): written every few seconds, not live
            path = url_parts(u)[0]
            key = TAB_KEYS.get((a, w, t)) or (a, w, t)
            try: host = (urllib.parse.urlsplit(u).hostname or "").lower()
            except Exception: host = ""
            if "/attempt/" in path:
                ev["attempt"] = True
                self.att_tabs[key] = (host, now)
            elif SUBMIT_PATH_RE.search(path):
                prev = self.att_tabs.get(key)
                if prev and prev[0] == host and 0 <= now - prev[1] <= (ATT_SUB_S if w >= 0 else ATT_SUB_SLOW):
                    if not ev.get("sub"): log("%s turned in (its submitted page replaced the attempt page)" % q)
                    ev["sub"] = True
            elif key in self.att_tabs and self.att_tabs[key][0] == host:
                if SUMMARY_PATH_RE.search(path): self.att_tabs.pop(key, None)   # back on its start page: that attempt was left, not turned in
                else: self.att_tabs[key] = (host, now)   # another page of the exam after its attempt (Brightspace's "submit?" page): same tab
    def send_unlock(self, quiz, reason):
        """True only when the helper confirms AI is back. 202 pending = the server has not vouched for the
        quiz end yet (held): told to the student once per quiz, retried quietly."""
        try:
            r = self.helper("/unlock", {"quiz_id": quiz, "reason": reason, "seen": self.seen_for(quiz)}, timeout=150)
            if isinstance(r, dict) and r.get("pending") and getattr(self, "hold_told", None) != quiz:
                self.hold_told = quiz; dialog(self.HOLD_TEXT)
            ok = isinstance(r, dict) and bool(r.get("ok"))
            if ok: self.attempt_over(quiz)
            return ok
        except Exception as e:
            log("helper unlock failed: %s" % e); return False

    def attempt_over(self, quiz):
        """The lock ended with AI back (the student's own turned-in page, or the server vouched): an attempt page seen
        before is over, so a later visit to the exam (its start page, to look at a score) starts fresh and ends the
        moment the student leaves it. A new attempt is seen again on its own page."""
        ev = self.seen.get(quiz)
        if ev: ev["attempt"] = False

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
        if not self.pending: self.firefox_note()   # held / not confirmed: said once AI is really back
        self.locked, self.quiz, self.url, self.missing_since = False, None, None, None

    def firefox_note(self):
        """A Firefox started during the quiz read the quiz policies at start and keeps them until it restarts."""
        try:
            if not developer_mode() and gecko_pids(ps_procs(), self.quiz_app):
                dialog("AI is unlocked. Restart Firefox to get its AI features back.")
        except Exception: pass

    def adopt(self, st, present):
        """The helper is locked but this agent is not (agent restarted, or the helper resumed a lock
        after a reboot): take the lock over so it ends with the quiz. If the quiz is not open it ends
        after the normal grace period."""
        q = st.get("quiz_id")
        self.locked, self.quiz, self.url = True, q, present.get(q, "")
        ev = self.seen.setdefault(q, {"attempt": False, "sub": False, "rt": True, "at": time.time()})
        ev["adopted"] = True   # this agent did not watch the whole lock: it never says "no attempt"
        self.missing_since = None if q in present else time.time()
        self.last_beat, self.tabs_seen = time.time(), 0
        log("adopted existing lock %s" % q)

    def add_cap(self, q, now=None, why=None):
        """A quiz the helper (cap / server / other school) just released: not re-locked while its page stays open."""
        now = time.time() if now is None else now
        if q not in self.capped: self.cap_left[q] = False
        if why or q not in self.capped: self.cap_why[q] = why
        if why in SRV_ENDS: self.attempt_over(q)   # Brightspace says the attempt is over
        self.capped[q] = now

    def note_cap(self, st):
        q = st.get("capped_quiz") if isinstance(st, dict) else None
        if not q or q in self.capped: return
        try: at = float(st.get("capped_at") or 0)
        except Exception: at = 0.0
        if q in self.cap_forgot and at <= self.cap_forgot[q]: return   # a release this agent already forgot
        self.add_cap(q, why=st.get("capped_reason"))

    def forget_cap(self, q, why):
        """Its page was closed, or a NEW attempt started: the quiz locks normally again. The helper forgets it too."""
        self.capped.pop(q, None); self.cap_left.pop(q, None); self.cap_why.pop(q, None); self.cap_forgot[q] = time.time()
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
            elif now - self.capped[q] > (SRV_GRACE if self.cap_why.get(q) in SRV_ENDS else GRACE):
                self.forget_cap(q, "page closed")

    def console_step(self, now_console=None):
        """Fast user switching: while another account is at the screen this agent does nothing (it cannot
        see its browser, so it would wrongly think the quiz closed). It forgets its own view of the lock,
        never unlocking it; back at the screen it re-reads the helper and adopts its own lock again."""
        c = at_console() if now_console is None else now_console
        if not c:
            if self.locked or self.pending:
                log("another account is at the screen - pausing (lock left as it is)")
            self.locked, self.quiz, self.url, self.missing_since, self.pending = False, None, None, None, None
            self.last_check = 0.0
            return False
        return True

    def ready_notice(self, urls):
        """Once ever: the first time a Brightspace tab is seen after install, a notification says LOCKqz is
        ready and there is nothing to do until the exam -- but ONLY after the server confirms (signed /verify
        status) this computer is verified, paid and not revoked. Otherwise "finish setup" (at most every 6 h)
        and the flag is not written, so "ready" comes once setup is done. No answer -> nothing shown."""
        if self.ready_told or not any("/d2l/" in (u or "") for u in urls): return
        now = time.time()
        if getattr(self, "ready_busy", False) or now < getattr(self, "ready_next", 0.0): return
        self.ready_busy, self.ready_next = True, now + 1800   # one status check per 30 min at most
        def run():
            try:
                st = self.verify_call("status")
                if not st: return                                  # helper / network trouble: claim nothing
                ok = st.get("status") == 200 and st.get("verified") is True and st.get("paid") is True
                if ok:
                    self.ready_told = True
                    try:
                        os.makedirs(USER_DIR, exist_ok=True)
                        with open(READY_FLAG, "w") as f: f.write(time.strftime("%Y-%m-%dT%H:%M:%S"))
                    except Exception as e: log("ready flag: %s" % e)
                elif now - getattr(self, "setup_told", 0.0) < 6 * 3600: return
                else: self.setup_told = now
                try: subprocess.run(["osascript", "-e", 'display notification "%s" with title "LOCKqz"' % (READY_TEXT if ok else SETUP_TEXT)], timeout=10, capture_output=True)
                except Exception as e: log("ready notice: %s" % e)
            finally: self.ready_busy = False
        threading.Thread(target=run, daemon=True).start()

    def tick(self, tabs=None, dev=None):
        # Developer mode (admin only): same quiz flow (gate password, start/end reporting) but the
        # daemon never blocks AI and search tabs are never rewritten.
        if not self.console_step(): return
        dev = developer_mode() if dev is None else dev
        WANT_KEYS[0] = bool(self.locked)
        tabs = browser_tabs() if tabs is None else tabs
        # A quiz opened from Brightspace Content/Lessons runs in a frame, so its submission never shows
        # in the address bar. Move it to its own page (same quiz, same attempt): from then on the address
        # bar shows every quiz page, including "submitted", and AI comes back the moment it is turned in.
        move_content_quizzes(tabs)
        tabs = [(a, w, t, inner_url(u)) for (a, w, t, u) in tabs]   # quizzes opened from Content/Lessons
        raw = tabs                                                   # with LOCKqz's own #lqz... answers (hand_step)
        tabs = [(a, w, t, strip_hand(u)) for (a, w, t, u) in tabs]
        now = time.time()
        urls = [u for (_, _, _, u) in tabs]
        self.ready_notice(urls)
        present, left = classify(urls)
        any_leaving = any(is_leaving(u) for u in urls)
        # A quiz released by the safety cap or by the server is never re-locked while it stays open; once
        # its page has been gone for the grace period, a new attempt locks normally again.
        self.cap_step(present, now)
        for q in [q for q, t in self.nolock.items() if t <= now or q not in present]: self.nolock.pop(q, None)
        open_quizzes = {q: u for q, u in present.items() if q not in self.capped and q not in self.nolock}
        if not self.verified:
            self.ensure_identity(quiz=bool(open_quizzes))
        if not self.locked:
            if open_quizzes:
                url = next(iter(open_quizzes.values()))
                apps = [a for (a, _, _, u) in tabs if u == url]   # the same page open in Opera and Chrome: Chrome
                self.start(url, next((a for a in apps if a not in OPERA_APPS), apps[0] if apps else None))
                if self.locked:
                    self.tabs_seen = len(tabs)
                    self.evidence_step(tabs, now)   # the page it locked on (an attempt page counts from the first look)
                return
            if self.pending and now - self.pending_try >= 5:
                self.pending_try = now
                if self.send_unlock(*self.pending):
                    log("pending unlock confirmed (%s)" % self.pending[1]); self.pending = None
                    self.firefox_note()
                return
            # Unlocked here: make sure the helper is not still locked (a lost unlock, a resumed lock).
            if now - self.last_check > 10:
                self.last_check = now
                try:
                    st = self.helper("/status", timeout=8)
                    self.note_cap(st)
                    self.tell_student(st)
                    if st.get("state") == "locked" and st.get("quiz_id") and st["quiz_id"] not in self.capped:
                        self.adopt(st, present)
                except Exception as e: log("helper check failed: %s" % e)
            return
        # locked
        self.evidence_step(tabs, now)
        restarting = self.quiz not in present and now < self.restart_wait and self.quiz not in self.capped
        if restarting:
            self.missing_since = None   # its Firefox is restarting for the exam: the page comes back with its tabs
        elif self.quiz in present and self.quiz not in self.capped:
            self.missing_since = None
            self.tabs_seen = max(self.tabs_seen, len(tabs))
            if not self.url or "/attempt/" in url_parts(present[self.quiz])[0]: self.url = present[self.quiz]
            if not self.quiz_app: self.quiz_app = next((a for (a, _, _, u) in tabs if u == present[self.quiz]), None)
        else:
            if getattr(self, "hand", None): self.hand["lost"] = True   # handed over again when its page is back (hand_step)
            if self.quiz in left:
                self.end("quiz_submitted"); return
            if any_leaving and not open_quizzes:   # quiz list / another quiz's page: not proof of a submit
                self.end("quiz_left"); return
            if open_quizzes:          # our quiz is gone and another one is open: hand over at once
                self.end("quiz_left"); return
            self.missing_since = self.missing_since or now
            if now - self.missing_since > GRACE:
                self.end(unlock_reason(tabs, self.tabs_seen)); return
        # Gated quizzes change password every 5 min. Until the attempt starts (still on the quiz's
        # start page, no "/attempt/" in the URL), re-check and hand over a new one if it changed. A quiz
        # that has not opened yet is asked on the slower C2 schedule (pw_next).
        cur = present.get(self.quiz)
        if cur and "/attempt/" not in url_parts(cur)[0]:
            try: self.hand_step(raw, now)
            except Exception as e: log("password hand-over failed: %s" % e)
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
                self.tell_student(st)
                if self.quiz in self.capped:
                    log("%s released %s — not re-locking" % (st.get("capped_reason") or "safety cap", self.quiz))
                    self.locked, self.quiz, self.url, self.missing_since = False, None, None, None
                    return
                if st.get("state") not in ("locked", "developer"):
                    log("helper not locked during an open quiz (%s) — re-locking" % st.get("state"))
                    rl = self.helper("/lock", {"quiz_id": self.quiz, "student": self.student, "url": self.url or ""})
                    if isinstance(rl, dict) and rl.get("not_protected"):
                        self.nolock[self.quiz] = now + NOLOCK_AGAIN; log("not protected: %s - not locked" % self.quiz)
                        self.locked, self.quiz, self.url, self.missing_since = False, None, None, None
                        return
            except Exception as e:
                self.helper_ok = False; log("helper check failed: %s" % e)
        if not dev:
            # AI tabs opened before the quiz (an open chat keeps its connection past the hosts block) go
            # to about:blank; AI-answer searches go to plain Google web results.
            hosts, paths = self.blocklist()
            for (app, wi, ti, u) in tabs:
                if wi < 0: continue
                new = "about:blank" if blocked_tab(u, hosts, paths) else rewrite_search(u)
                if new: set_tab_url(app, wi, ti, new, u)
            # Firefox family: the AI-free results of a new search open in a new tab of that browser.
            gk = set((a, u) for (a, wi, _, u) in tabs if wi < 0)
            todo = new_gecko_searches(tabs, getattr(self, "gecko_seen", gk), lambda u: blocked_tab(u, hosts, paths))
            self.gecko_seen = gk
            if todo:
                procs = ps_procs()
                for (base, new) in todo[:3]:
                    if open_search(procs, base, new): log("web search in %s: Google's Web results opened in a new tab (no AI answer)" % base)
            # Opera reopened during the quiz (no policy layer, built-in VPN) -> closed again.
            if now - getattr(self, "opera_check", 0) >= 5:
                self.opera_check = now
                procs = ps_procs()
                o = no_policy_pids(procs, self.quiz_app) + unpoliced_browser_pids(procs, self.quiz_app, set(_denied))
                if close_pids(o) and not self.opera_warned:
                    self.opera_warned = True
                    seen = []
                    for _, n in o:
                        n = str(n).replace("other:", "")
                        if n not in seen: seen.append(n)
                    dialog(closed_note(seen).strip())
        # Report to the server ONLY while the helper is unreachable (proof for "helper killed"); while the
        # helper answers, its own signed pings say everything -> no routine agent traffic (free plan).
        if not getattr(self, "helper_ok", True) and now - self.last_beat > BEAT:
            self.last_beat = now
            self.api_post("/report", {"device_id": self.device, "event": "heartbeat", "quiz_id": self.quiz,
                                      "student": self.student, "source": "agent"})

    def tell_student(self, st):
        """A helper that came up after this agent (an update or a reboot restarts both) missed the student this
        agent told it at start: tell it again, once it answers. Never while another account's quiz holds it."""
        if self.student and isinstance(st, dict) and "student" in st and not st.get("student") and st.get("state") != "other_user":
            try:
                self.helper("/student", {"student": self.student}, timeout=8)
                log("told the helper the student again (%s)" % self.student)
            except Exception: pass

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
