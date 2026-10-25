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

Usage: browser-policy.py {lock|unlock|status}   (root; LOCKQZ_POLICY_DIR for tests)
"""
import os, plistlib, subprocess, sys

DIR = os.environ.get("LOCKQZ_POLICY_DIR", "/Library/Managed Preferences")
# Every Chromium browser + channel that reads managed prefs on macOS. All take the same policy keys,
# so a student can't dodge the search/AI/DoH policy by using a beta/dev channel or a less common build.
CHROMIUM = ["com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary",
            "com.microsoft.Edge", "com.microsoft.Edge.Beta", "com.microsoft.Edge.Dev", "com.microsoft.Edge.Canary",
            "com.brave.Browser", "com.brave.Browser.beta", "com.brave.Browser.nightly",
            "org.chromium.Chromium", "com.vivaldi.Vivaldi",
            "com.operasoftware.Opera", "com.operasoftware.OperaGX", "com.operasoftware.OperaDeveloper",
            "company.thebrowser.Browser", "ai.perplexity.comet", "com.sigmaos.sigmaos.macos"]
FIREFOX = "org.mozilla.firefox"
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

def _bundle_id(app):
    """CFBundleIdentifier of an .app, or None."""
    try:
        import plistlib as _pl
        with open(os.path.join(app, "Contents", "Info.plist"), "rb") as f:
            return _pl.load(f).get("CFBundleIdentifier")
    except Exception:
        return None

def firefox_family_ids():
    """Bundle ids of every installed Firefox-family browser (any .app whose Contents/MacOS holds a
    `firefox` binary -- true for Firefox and all Gecko forks). Scans /Applications and each user's
    ~/Applications. Env LOCKQZ_FF_IDS (comma list) overrides, for tests."""
    override = os.environ.get("LOCKQZ_FF_IDS")
    if override is not None:
        return [x for x in override.split(",") if x]
    roots, ids = ["/Applications"], set()
    try:
        for u in os.listdir("/Users"):
            a = "/Users/%s/Applications" % u
            if os.path.isdir(a): roots.append(a)
    except Exception: pass
    for root in roots:
        try: entries = os.listdir(root)
        except Exception: continue
        for name in entries:
            if not name.endswith(".app"): continue
            app = os.path.join(root, name)
            mac = os.path.join(app, "Contents", "MacOS")
            try: binaries = os.listdir(mac)
            except Exception: continue
            # Gecko forks keep the `firefox` launcher name; match it (and a few known rebrands).
            if any(b.lower() in ("firefox", "librewolf", "waterfox", "floorp", "zen", "mullvadbrowser") for b in binaries):
                bid = _bundle_id(app)
                if bid: ids.add(bid)
    # Always include the canonical id even if the app wasn't found by scan.
    ids.add("org.mozilla.firefox")
    return sorted(ids)

def path(domain): return os.path.join(DIR, domain + ".plist")

def ours(domain):
    try:
        with open(path(domain), "rb") as f: return bool(plistlib.load(f).get(MARK))
    except Exception: return False

def write(domain, pol):
    os.makedirs(DIR, exist_ok=True)
    with open(path(domain), "wb") as f: plistlib.dump(pol, f)
    os.chmod(path(domain), 0o644)

def refresh():
    # Make cfprefsd drop its cache so the browsers see the change immediately.
    if DIR == "/Library/Managed Preferences":
        subprocess.run(["killall", "cfprefsd"], capture_output=True)

def lock():
    for d in CHROMIUM: write(d, chromium_policy(d))
    for d in firefox_family_ids(): write(d, firefox_policy())   # Firefox + every fork, by real bundle id
    refresh()

def unlock():
    # Remove every managed-prefs plist we wrote (chromium list + any Firefox-family id). Scanning DIR
    # for our mark catches forks even if the app has since been uninstalled.
    try: present = [f[:-6] for f in os.listdir(DIR) if f.endswith(".plist")]
    except Exception: present = []
    for d in set(CHROMIUM + [FIREFOX] + present):
        if ours(d):
            try: os.remove(path(d))
            except Exception: pass
    refresh()

def status():
    try: present = [f[:-6] for f in os.listdir(DIR) if f.endswith(".plist")]
    except Exception: present = []
    on = [d for d in set(CHROMIUM + [FIREFOX] + present) if ours(d)]
    print("LOCKqz browser policy: " + ("LOCKED (%d browsers)" % len(on) if on else "off"))

if __name__ == "__main__":
    {"lock": lock, "unlock": unlock, "status": status}.get(sys.argv[1] if len(sys.argv) > 1 else "", status)()
