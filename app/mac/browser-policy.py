#!/usr/bin/env python3
"""LOCKqz browser policy (macOS). No extension, no Web Store, no MDM profile.

Writes managed-preference plists that Chrome, Edge, Brave, Chromium, Vivaldi and
Firefox honour on an unmanaged Mac (same files a configuration profile would
create). Applied ONLY while a quiz is locked and removed at unlock, so the
student's browser AI is back the moment the quiz ends.

While locked, per browser:
  * built-in AI off (Gemini / Copilot / Leo / Firefox AI chat, on-device AI APIs)
  * encrypted-DNS bypass off (so the /etc/hosts block holds)
  * AI answers in search off: web search is pinned to Google "Web" results
    (udm=14 = no AI Overview, no AI Mode); Bing/DDG/Brave/You/Kagi/Yahoo search blocked
  * all browser extensions disabled (AI sidebars, Grammarly-type writers)

A managed-preferences file that already exists (a school MDM profile, the student's own policies)
is backed up to a root-only folder before LOCKqz adds its keys, and put back byte-for-byte at
unlock - it is never deleted. Root only ever writes to <policy dir>/<bundle id>.plist for bundle
ids in the fixed lists below; no path or name ever comes from a user-writable place.

Exit status: lock/unlock exit 1 if they could not complete (the engine then retries).

Usage: browser-policy.py {lock|unlock|status}   (root; LOCKQZ_POLICY_DIR / LOCKQZ_POLICY_BACKUP for tests)
"""
import os, plistlib, re, subprocess, sys

DIR = os.environ.get("LOCKQZ_POLICY_DIR", "/Library/Managed Preferences")
BACKUP = os.environ.get("LOCKQZ_POLICY_BACKUP", "/Library/Application Support/LOCKqz/policy-backup")
HERE = os.path.dirname(os.path.abspath(__file__))
BLOCKLIST = os.environ.get("LOCKQZ_BLOCKLIST") or os.path.join(HERE, "blocklist.txt")
ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9_-]+)+")
# Every Chromium browser + channel that reads managed prefs on macOS. All take the same policy keys,
# so a student can't dodge the search/AI/DoH policy by using a beta/dev channel or a less common build.
CHROMIUM = ["com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary",
            "com.microsoft.Edge", "com.microsoft.Edge.Beta", "com.microsoft.Edge.Dev", "com.microsoft.Edge.Canary",
            "com.brave.Browser", "com.brave.Browser.beta", "com.brave.Browser.nightly",
            "org.chromium.Chromium", "com.vivaldi.Vivaldi",
            "com.operasoftware.Opera", "com.operasoftware.OperaGX", "com.operasoftware.OperaDeveloper",
            "company.thebrowser.Browser", "ai.perplexity.comet", "com.sigmaos.sigmaos.macos"]
FIREFOX = "org.mozilla.firefox"
# Firefox and the Gecko forks read macOS policies from their OWN bundle id. Fixed list (never taken
# from an app's Info.plist: a user-made app bundle must not steer where root writes).
GECKO = ["org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition", "org.mozilla.nightly",
         "org.mozilla.librewolf", "io.gitlab.librewolf-community", "net.waterfox.waterfox",
         "org.waterfoxproject.waterfox", "one.ablaze.floorp", "app.zen-browser.zen", "app.zen_browser.zen",
         "net.mullvad.mullvadbrowser", "org.torproject.torbrowser"]
MARK = "LOCKqzManaged"

SEARCH_BLOCK = ["google.com/search", "google.com/webhp", "bing.com/search", "bing.com/copilotsearch",
                "bing.com/chat", "copilot.microsoft.com", "duckduckgo.com", "duck.ai",
                "search.yahoo.com", "search.brave.com", "you.com", "kagi.com",
                "yandex.com/search", "ecosia.org/search", "startpage.com"]
# Google verticals that carry no AI answer: Web, Images, News, Video, Books.
SEARCH_ALLOW = ["google.com/search@udm=14", "google.com/search@udm=2", "google.com/search@udm=12",
                "google.com/search@udm=7", "google.com/search@udm=36",
                "google.com/search@tbm=isch", "google.com/search@tbm=nws",
                "google.com/search@tbm=vid", "google.com/search@tbm=bks"]
WEB_SEARCH = "https://www.google.com/search?udm=14&q={searchTerms}"

def chromium_policy(domain):
    p = {MARK: True,
         "GenAiDefaultSettings": 2, "GeminiSettings": 1, "BuiltInAIAPIsEnabled": False,
         "DnsOverHttpsMode": "off", "ProxyMode": "direct",   # a proxy would resolve AI sites past hosts
         "URLBlocklist": SEARCH_BLOCK, "URLAllowlist": SEARCH_ALLOW,
         "DefaultSearchProviderEnabled": True, "DefaultSearchProviderName": "Google (Web)",
         "DefaultSearchProviderSearchURL": WEB_SEARCH,
         "DefaultSearchProviderSuggestURL": "https://www.google.com/complete/search?output=chrome&q={searchTerms}",
         "ExtensionInstallBlocklist": ["*"]}
    if domain.startswith("com.microsoft.Edge"):
        p.update({"HubsSidebarEnabled": False, "CopilotCDPPageContext": False,
                  "EdgeEntraCopilotPageContext": False, "ComposeInlineEnabled": False,
                  "Microsoft365CopilotChatIconEnabled": False,
                  "GenAILocalFoundationalModelSettings": 1})
    if domain.startswith("com.brave.Browser"):
        p.update({"BraveAIChatEnabled": False})
    return p

def firefox_policy():
    exc = ["https://www.google.com/search?*udm=14*", "https://www.google.com/search?*udm=2*",
           "https://www.google.com/search?*udm=12*", "https://www.google.com/search?*udm=7*",
           "https://www.google.com/search?*udm=36*", "https://www.google.com/search?*tbm=isch*",
           "https://www.google.com/search?*tbm=nws*", "https://www.google.com/search?*tbm=vid*",
           "https://www.google.com/search?*tbm=bks*"]
    blk = ["https://www.google.com/search*", "https://www.google.com/webhp*", "https://www.bing.com/*search*",
           "https://www.bing.com/chat*", "https://copilot.microsoft.com/*", "https://duckduckgo.com/*",
           "https://duck.ai/*", "https://search.yahoo.com/*", "https://search.brave.com/*",
           "https://you.com/*", "https://kagi.com/*", "https://yandex.com/search*",
           "https://www.ecosia.org/search*", "https://www.startpage.com/*"]
    return {MARK: True, "EnterprisePoliciesEnabled": True,
            "DNSOverHTTPS": {"Enabled": False, "Locked": True},
            "Proxy": {"Mode": "none", "Locked": True},
            "WebsiteFilter": {"Block": blk, "Exceptions": exc},
            "Preferences": {"browser.ml.chat.enabled": {"Value": False, "Status": "locked"},
                            "browser.ml.enable": {"Value": False, "Status": "locked"},
                            "browser.ml.linkPreview.enabled": {"Value": False, "Status": "locked"}}}

def firefox_family_ids():
    """Bundle ids that get the Firefox policy: the fixed GECKO list. LOCKQZ_FF_IDS (comma list,
    tests) can only choose among the fixed ids or ids of the same reverse-DNS shape."""
    override = os.environ.get("LOCKQZ_FF_IDS")
    ids = [x for x in override.split(",") if x] if override is not None else list(GECKO)
    return sorted(i for i in set(ids) if ID_RE.fullmatch(i))

def path_entries():
    """host/path entries from the blocklist (e.g. huggingface.co/chat, x.com/i/grok): /etc/hosts can
    only block whole hosts, so these are enforced by the browser policy."""
    out = []
    try:
        with open(BLOCKLIST) as f:
            for l in f:
                l = l.strip()
                if l and not l.startswith("#") and "/" in l and \
                   re.fullmatch(r"[A-Za-z0-9.-]+\.[A-Za-z]{2,}/[A-Za-z0-9._~%/-]*", l):
                    out.append(l.lower().rstrip("/"))
    except Exception:
        pass
    return list(dict.fromkeys(out))

def _union(a, b):
    a = a if isinstance(a, list) else []
    return list(dict.fromkeys(list(a) + list(b)))

def merge_chromium(base, ours):
    """The student's/MDM's existing policy with ours on top for the quiz. Lists that block are
    merged; the allowlists that would exempt AI from our blocks are replaced for the quiz only
    (restored from the backup at unlock). Force-installed extensions are left alone (removing
    them would uninstall them); every other extension is only DISABLED by the "*" blocklist."""
    out = dict(base or {})
    out.pop("ExtensionInstallAllowlist", None)
    out.update(ours)
    out["URLBlocklist"] = _union((base or {}).get("URLBlocklist"), ours["URLBlocklist"])
    return out

def merge_firefox(base, ours):
    out = dict(base or {})
    out.update({k: v for k, v in ours.items() if k not in ("WebsiteFilter", "Preferences")})
    wf = (base or {}).get("WebsiteFilter") if isinstance((base or {}).get("WebsiteFilter"), dict) else {}
    out["WebsiteFilter"] = {"Block": _union(wf.get("Block"), ours["WebsiteFilter"]["Block"]),
                            "Exceptions": ours["WebsiteFilter"]["Exceptions"]}
    prefs = dict((base or {}).get("Preferences") or {}) if isinstance((base or {}).get("Preferences"), dict) else {}
    prefs.update(ours["Preferences"]); out["Preferences"] = prefs
    return out

def path(domain): return os.path.join(DIR, domain + ".plist")
def bpath(domain): return os.path.join(BACKUP, domain + ".plist")

def _read(p):
    try:
        with open(p, "rb") as f: d = plistlib.load(f)
        return d if isinstance(d, dict) else None
    except Exception:
        return None

def ours(domain):
    d = _read(path(domain)); return bool(d and d.get(MARK))

def _atomic(p, data, mode):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".lockqz.tmp"
    try: os.unlink(tmp)
    except FileNotFoundError: pass
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), mode)
    with os.fdopen(fd, "wb") as f: f.write(data)
    os.chmod(tmp, mode); os.replace(tmp, p)

def write(domain, pol, merge):
    """Apply our policy for one browser. Returns True when the file changed."""
    if not ID_RE.fullmatch(domain): return False
    cur_bytes = None
    try:
        with open(path(domain), "rb") as f: cur_bytes = f.read()
    except FileNotFoundError: pass
    cur = _read(path(domain)) if cur_bytes is not None else None
    if cur_bytes is not None and not (cur and cur.get(MARK)):
        # Someone else's policy (MDM, the student): keep an exact copy to put back at unlock.
        os.makedirs(BACKUP, mode=0o700, exist_ok=True)
        _atomic(bpath(domain), cur_bytes, 0o600)
    base = _read(bpath(domain)) if os.path.exists(bpath(domain)) else None
    new = plistlib.dumps(merge(base, pol))
    if new == cur_bytes: return False   # already in place: no rewrite, no cfprefsd restart
    _atomic(path(domain), new, 0o644)
    return True

def refresh():
    # Make cfprefsd drop its cache so the browsers see the change immediately.
    if DIR == "/Library/Managed Preferences":
        subprocess.run(["killall", "cfprefsd"], capture_output=True)

def _candidates():
    try: present = [f[:-6] for f in os.listdir(DIR) if f.endswith(".plist")]
    except Exception: present = []
    try: saved = [f[:-6] for f in os.listdir(BACKUP) if f.endswith(".plist")]
    except Exception: saved = []
    return sorted(d for d in set(CHROMIUM + GECKO + firefox_family_ids() + present + saved) if ID_RE.fullmatch(d))

def lock():
    changed, failed, extra = False, False, path_entries()
    jobs = [(d, chromium_policy(d), merge_chromium) for d in CHROMIUM] + \
           [(d, firefox_policy(), merge_firefox) for d in firefox_family_ids()]
    for d, pol, merge in jobs:
        if extra:
            if "URLBlocklist" in pol: pol["URLBlocklist"] = _union(pol["URLBlocklist"], extra)
            if "WebsiteFilter" in pol:
                pol["WebsiteFilter"]["Block"] = _union(pol["WebsiteFilter"]["Block"],
                    [p for e in extra for p in ("*://%s*" % e, "*://*.%s*" % e)])
        try: changed = write(d, pol, merge) or changed
        except Exception as e:
            failed = True; print("LOCKqz policy: %s: %s" % (d, e), file=sys.stderr)
    if changed: refresh()
    return not failed

def unlock():
    """Put every browser back exactly as before the quiz: restore the backed-up file, or remove ours
    if there was none. True only when no LOCKqz policy is left."""
    changed = False
    for d in _candidates():
        try:
            if ours(d):
                if os.path.exists(bpath(d)):
                    with open(bpath(d), "rb") as f: _atomic(path(d), f.read(), 0o644)
                else:
                    os.remove(path(d))
                changed = True
            if os.path.exists(bpath(d)): os.remove(bpath(d))   # restored, or replaced by someone else
        except Exception as e:
            print("LOCKqz policy: restore %s: %s" % (d, e), file=sys.stderr)
    if changed: refresh()
    try:
        if os.path.isdir(BACKUP) and not os.listdir(BACKUP): os.rmdir(BACKUP)
    except Exception: pass
    return not any(ours(d) for d in _candidates())

def status():
    on = [d for d in _candidates() if ours(d)]
    print("LOCKqz browser policy: " + ("LOCKED (%d browsers)" % len(on) if on else "off"))
    return True

if __name__ == "__main__":
    ok = {"lock": lock, "unlock": unlock, "status": status}.get(sys.argv[1] if len(sys.argv) > 1 else "", status)()
    sys.exit(0 if ok else 1)
