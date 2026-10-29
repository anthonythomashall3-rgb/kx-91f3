#!/usr/bin/env python3
"""LOCKqz agent (Linux). Per-user systemd service (lockqz-agent.service, user unit, enabled globally).

The quiz logic is the Mac agent's (agent-mac.py = app/mac/lockqz-agent.py, installed next to this
file): lock when a Brightspace quiz attempt page is open, fetch the password from the root helper,
unlock when the page is gone, email confirmed once per computer, safety cap, resumed locks. This file
only swaps the macOS pieces for Linux ones:
  * open tabs: Firefox family from the session store (recovery.jsonlz4, every 15 s), Chromium family
    (Chrome, Chromium deb/snap/flatpak, Edge, Brave, Vivaldi, Opera) from the SNSS session file
    (Sessions/Session_*, written within ~2.5 s of a navigation or a closed tab)
  * dialogs: zenity (GNOME) / kdialog (KDE); notifications: notify-send; clipboard: wl-copy / xclip / xsel
  * browsers closed at lock so their quiz policies apply on reopen: Firefox family + Opera/Vivaldi +
    flatpak browsers (no managed-policy file reaches them), except the one holding the quiz
  * no tab rewriting (Linux browsers expose no tab API): the Chromium / Firefox policies pin search to
    Google Web and block AI sites inside the browser; the hosts file + warm-connection cut do the rest.
"""
import glob, importlib.util, json, os, re, shutil, struct, subprocess, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("lockqz_agent_mac", os.path.join(HERE, "agent-mac.py"))
M = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(M)

# ---------- paths ----------
M.SYS_CONF = os.environ.get("LOCKQZ_CONFIG") or os.path.join(HERE, "config.json")
M.TOKEN_DIR = os.environ.get("LOCKQZ_TOKEN_DIR") or "/var/lib/lockqz/tokens"
M.USER_DIR = os.path.expanduser("~/.config/lockqz")
M.READY_FLAG = os.path.join(M.USER_DIR, "ready-shown")
M.USER_CONF = os.path.join(M.USER_DIR, "student.json")
M.DEV_KEY = os.path.join(M.USER_DIR, "developer.key")
log = M.log

# ---------- desktop pieces ----------
def _which(*names):
    for n in names:
        p = shutil.which(n)
        if p: return p
    return None

def notify(text):
    try:
        if _which("notify-send"): subprocess.run(["notify-send", "-a", "LOCKqz", "LOCKqz", text], timeout=10, capture_output=True)
    except Exception: pass

def dialog(text, title="LOCKqz"):
    def run():
        try:
            if _which("zenity"): subprocess.run(["zenity", "--info", "--title", title, "--text", text, "--timeout", "180"], timeout=200, capture_output=True)
            elif _which("kdialog"): subprocess.run(["kdialog", "--title", title, "--msgbox", text], timeout=200, capture_output=True)
            else: notify(text)
        except Exception: pass
    threading.Thread(target=run, daemon=True).start()
M.dialog = dialog

class LinuxUI:
    """Dialog that waits for the student (up to 30 min). -> (button, text) or (None, None)."""
    def ask(self, msg, buttons, default="", answer=True):
        try:
            if _which("zenity"):
                if answer:
                    r = subprocess.run(["zenity", "--entry", "--title", "LOCKqz", "--text", msg, "--entry-text", default or "",
                                        "--ok-label", buttons[-1], "--cancel-label", buttons[0] if len(buttons) > 1 else "Cancel", "--timeout", "1800"],
                                       capture_output=True, text=True, timeout=1900)
                    if r.returncode == 0: return (buttons[-1], r.stdout.strip())
                    if r.returncode == 1 and len(buttons) > 1: return (buttons[0], "")
                    return (None, None)
                if len(buttons) == 1:
                    subprocess.run(["zenity", "--info", "--title", "LOCKqz", "--text", msg, "--ok-label", buttons[0], "--timeout", "1800"],
                                   capture_output=True, text=True, timeout=1900)
                    return (buttons[0], "")
                r = subprocess.run(["zenity", "--question", "--title", "LOCKqz", "--text", msg, "--ok-label", buttons[-1],
                                    "--cancel-label", buttons[0], "--timeout", "1800"], capture_output=True, text=True, timeout=1900)
                return (buttons[-1] if r.returncode == 0 else (buttons[0] if r.returncode == 1 else None), "")
            if _which("kdialog"):
                if answer:
                    r = subprocess.run(["kdialog", "--title", "LOCKqz", "--inputbox", msg, default or ""], capture_output=True, text=True, timeout=1900)
                    return (buttons[-1], r.stdout.strip()) if r.returncode == 0 else ((buttons[0], "") if len(buttons) > 1 else (None, None))
                if len(buttons) == 1:
                    subprocess.run(["kdialog", "--title", "LOCKqz", "--msgbox", msg], capture_output=True, timeout=1900); return (buttons[0], "")
                r = subprocess.run(["kdialog", "--title", "LOCKqz", "--yes-label", buttons[-1], "--no-label", buttons[0], "--yesno", msg],
                                   capture_output=True, timeout=1900)
                return (buttons[-1] if r.returncode == 0 else buttons[0], "")
        except Exception as e:
            log("dialog failed: %s" % e)
        notify(msg)
        return (None, None)
    def say(self, msg): self.ask(msg, ["OK"], answer=False)
M.MacUI = LinuxUI

def clipboard(text):
    for cmd in (["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]):
        if _which(cmd[0]):
            try: subprocess.run(cmd, input=text.encode(), timeout=5, capture_output=True); return
            except Exception: pass
M.clipboard = clipboard
M.at_console = lambda: True            # one graphical session per account is the Linux norm; the helper checks the owner uid too
M.set_tab_url = lambda app, wi, ti, url: None
M.move_content_quizzes = lambda tabs, now=None, setter=None: []
M.permission_hint = lambda app, now=None, front=None: False
M.front_app = lambda: None

# ---------- processes ----------
def ps_procs():
    """This user's processes: [(pid, etime seconds, command line)]."""
    try:
        out = subprocess.run(["ps", "-u", str(os.getuid()), "-o", "pid=", "-o", "etimes=", "-o", "args="], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return []
    procs = []
    for line in out.splitlines():
        try:
            pid, et, args = line.strip().split(None, 2)
            procs.append((int(pid), int(et), args))
        except Exception: continue
    return procs
M.ps_procs = ps_procs

def _exe(args):
    """Executable name of a command line (snap/flatpak wrappers resolved to the browser binary)."""
    first = args.split()[0] if args.split() else ""
    return os.path.basename(first)

# (process name regex, app label, Chromium profile dirs) - main processes only (no --type= helpers)
CHROMIUM = [(r"^(chrome|google-chrome(-stable|-beta|-unstable)?)$", "Google Chrome", ["~/.config/google-chrome", "~/.config/google-chrome-beta", "~/.config/google-chrome-unstable", "~/.var/app/com.google.Chrome/config/google-chrome"]),
            (r"^(chromium|chromium-browser|chrome)$", "Chromium", ["~/.config/chromium", "~/snap/chromium/common/chromium", "~/.var/app/org.chromium.Chromium/config/chromium"]),
            (r"^(msedge|microsoft-edge(-stable|-beta|-dev)?)$", "Microsoft Edge", ["~/.config/microsoft-edge", "~/.config/microsoft-edge-beta", "~/.config/microsoft-edge-dev", "~/.var/app/com.microsoft.Edge/config/microsoft-edge"]),
            (r"^(brave|brave-browser(-beta|-nightly)?)$", "Brave", ["~/.config/BraveSoftware/Brave-Browser", "~/.config/BraveSoftware/Brave-Browser-Beta", "~/snap/brave/current/.config/BraveSoftware/Brave-Browser", "~/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser"]),
            (r"^(vivaldi|vivaldi-bin|vivaldi-stable)$", "Vivaldi", ["~/.config/vivaldi", "~/.var/app/com.vivaldi.Vivaldi/config/vivaldi"]),
            (r"^(opera|opera-developer|opera-beta)$", "Opera", ["~/.config/opera", "~/.config/opera-beta", "~/.var/app/com.opera.Opera/config/opera"])]
GECKO = [(r"^(firefox|firefox-bin|firefox-esr|GeckoMain)$", "Firefox", ["~/.mozilla/firefox/*", "~/snap/firefox/common/.mozilla/firefox/*", "~/.var/app/org.mozilla.firefox/.mozilla/firefox/*"]),
         (r"^(librewolf|librewolf-bin)$", "LibreWolf", ["~/.librewolf/*", "~/.var/app/io.gitlab.librewolf-community/.librewolf/*"]),
         (r"^(waterfox|waterfox-bin)$", "Waterfox", ["~/.waterfox/*"]),
         (r"^(floorp|floorp-bin)$", "Floorp", ["~/.floorp/*", "~/.var/app/one.ablaze.floorp/.floorp/*"]),
         (r"^(zen|zen-bin)$", "Zen", ["~/.zen/*", "~/.var/app/app.zen_browser.zen/.zen/*"]),
         (r"^(mullvadbrowser|mullvad-browser)$", "Mullvad Browser", ["~/.local/share/mullvad-browser/*/profile.default", "~/.var/app/net.mullvad.MullvadBrowser/.local/share/mullvad-browser/*/profile.default"]),
         (r"^(torbrowser|tor-browser|start-tor-browser)$", "Tor Browser", ["~/.local/share/torbrowser/tbb/*/Browser/TorBrowser/Data/Browser/profile.default"])]
CLOSE_AT_LOCK = ("Firefox", "LibreWolf", "Waterfox", "Floorp", "Zen", "Mullvad Browser", "Tor Browser", "Opera", "Vivaldi")

def running_browsers(procs):
    """{label: (earliest start time, [main pids], flatpak?)} for every browser family found running."""
    now, out = time.time(), {}
    for pid, et, args in procs:
        if "--type=" in args: continue              # renderer / gpu / utility helpers
        ex = _exe(args)
        for pat, label, _ in CHROMIUM + GECKO:
            if re.match(pat, ex):
                fp = args.split()[0].startswith("/app/")   # flatpak: the browser runs from /app inside its sandbox
                s, pids, f = out.get(label, (now - et, [], False))
                out[label] = (min(s, now - et), pids + [pid], f or fp)
                break
    return out

# ---------- Chromium SNSS session file ----------
def _pickle_str(b, off):
    n = struct.unpack_from("<I", b, off)[0]; off += 4
    s = b[off:off + n]; off += (n + 3) & ~3
    return s, off

def snss_urls(data):
    """Current URL of every open tab in a Chromium session file (commands 6 = navigation,
    7 = selected index, 16 = tab closed)."""
    if data[:4] != b"SNSS": return []
    off, tabs = 8, {}
    while off + 3 <= len(data):
        size = struct.unpack_from("<H", data, off)[0]; off += 2
        if size == 0 or off + size > len(data): break
        cid, body = data[off], data[off + 1:off + size]; off += size
        try:
            if cid == 6 and len(body) >= 12:
                p = 4   # pickle payload size
                tid, idx = struct.unpack_from("<ii", body, p); p += 8
                url, p = _pickle_str(body, p)
                t = tabs.setdefault(tid, {"nav": {}, "sel": None, "closed": False})
                t["nav"][idx] = url.decode("utf-8", "replace"); t["closed"] = False
            elif cid == 7 and len(body) >= 8:
                tid, idx = struct.unpack_from("<ii", body, 0)
                tabs.setdefault(tid, {"nav": {}, "sel": None, "closed": False})["sel"] = idx
            elif cid == 16 and len(body) >= 4:
                tid = struct.unpack_from("<i", body, 0)[0]
                if tid in tabs: tabs[tid]["closed"] = True
        except Exception:
            continue
    out = []
    for t in tabs.values():
        if t["closed"] or not t["nav"]: continue
        u = t["nav"].get(t["sel"]) if t["sel"] is not None else None
        out.append(u or t["nav"][max(t["nav"])])
    return out

def chromium_session_file(profile_root):
    """Newest Sessions/Session_* (or the legacy 'Current Session') across the profiles of one install."""
    best = None
    for prof in glob.glob(os.path.join(profile_root, "*")):
        if not os.path.isdir(prof): continue
        for p in glob.glob(os.path.join(prof, "Sessions", "Session_*")) + [os.path.join(prof, "Current Session")]:
            try: m = os.path.getmtime(p)
            except Exception: continue
            if best is None or m > best[0]: best = (m, p)
    return best

def browser_tabs():
    """-> [(app, -1, -1, url)] across every running browser."""
    procs = ps_procs(); running = running_browsers(procs); tabs = []
    for pat, label, roots in CHROMIUM:
        if label not in running: continue
        started = running[label][0]
        for r in roots:
            f = chromium_session_file(os.path.expanduser(r))
            if not f or f[0] < started - 5: continue
            try:
                with open(f[1], "rb") as fh: data = fh.read()
                for u in snss_urls(data): tabs.append((label, -1, -1, u))
            except Exception: pass
    for pat, label, roots in GECKO:
        if label not in running: continue
        started = running[label][0]
        for r in roots:
            for p in glob.glob(os.path.expanduser(r) + "/sessionstore-backups/recovery.jsonlz4"):
                try:
                    if os.path.getmtime(p) < started - 5: continue
                    for u in M.firefox_urls(M.mozlz4_json(p)): tabs.append((label, -1, -1, u))
                except Exception: pass
    return tabs
M.browser_tabs = browser_tabs

# nothing is "unpoliced by bundle id" on Linux; the tick's Opera/unpoliced re-close uses these:
def no_policy_pids(procs, keep_app):
    out = []
    for label, (_, pids, fp) in running_browsers(procs).items():
        if label == keep_app: continue
        if label in ("Opera", "Vivaldi") or fp: out += [(p, label) for p in pids]
    return out
M.no_policy_pids = no_policy_pids
M.unpoliced_browser_pids = lambda procs, keep_app, denied=(): []

class Agent(M.Agent):
    def close_for_quiz(self, app):
        """At lock: close the browsers that read their quiz policy only at start (Firefox family), the
        ones no policy reaches (Opera, Vivaldi, flatpak builds) - except the browser the quiz is in."""
        procs = ps_procs(); pids, names = [], []
        for label, (_, ps, fp) in running_browsers(procs).items():
            if label == app: continue
            if label in CLOSE_AT_LOCK or fp:
                pids += [(p, label) for p in ps]; names.append(label)
        M.close_pids(pids)
        self.opera_check = time.time() + 5
        if not names: return ""
        if len(names) == 1: return "\n\n%s was closed for the quiz so its AI stays off. You can reopen it; your tabs come back." % names[0]
        return "\n\n%s were closed for the quiz so their AI stays off. You can reopen them; your tabs come back." % (", ".join(names[:-1]) + " and " + names[-1])

    def payment(self, r):
        pay = r.get("pay") if isinstance(r, dict) else None
        if not isinstance(pay, dict): return False
        if not getattr(self, "pay_shown", False):
            self.pay_shown = True
            u = str(pay.get("url") or "https://lockqz.pages.dev/pay")
            if u.startswith("https://lockqz.pages.dev/"):
                try: subprocess.run(["xdg-open", u], timeout=10, capture_output=True)
                except Exception: pass
            dialog("Pay $%s for LOCKqz this semester to get the quiz password.\n\nMemo:  %s\n\nThe payment page is open. LOCKqz shows the password here as soon as your payment arrives."
                   % (pay.get("amount") or 5, pay.get("code") or ""))
        return True

    def ready_notice(self, urls):
        if self.ready_told or not any("/d2l/" in (u or "") for u in urls): return
        now = time.time()
        if getattr(self, "ready_busy", False) or now < getattr(self, "ready_next", 0.0): return
        self.ready_busy, self.ready_next = True, now + 1800
        def run():
            try:
                st = self.verify_call("status")
                if not st: return
                ok = st.get("status") == 200 and st.get("verified") is True and st.get("paid") is True
                if ok:
                    self.ready_told = True
                    try:
                        os.makedirs(M.USER_DIR, exist_ok=True)
                        with open(M.READY_FLAG, "w") as f: f.write(time.strftime("%Y-%m-%dT%H:%M:%S"))
                    except Exception as e: log("ready flag: %s" % e)
                elif now - getattr(self, "setup_told", 0.0) < 6 * 3600: return
                else: self.setup_told = now
                notify(M.READY_TEXT if ok else M.SETUP_TEXT)
            finally: self.ready_busy = False
        threading.Thread(target=run, daemon=True).start()

if __name__ == "__main__":
    Agent().run()
