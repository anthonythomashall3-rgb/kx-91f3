#!/usr/bin/env python3
"""LOCKqz browser policy (macOS). No MDM profile, nothing for the student to add.

Writes managed-preference plists that Chrome, Edge, Brave, Chromium, Vivaldi and
Firefox honour on an unmanaged Mac (same files a configuration profile would
create). Applied ONLY while a quiz is locked and removed at unlock, so the
student's browser AI is back the moment the quiz ends.

While locked, per browser:
  * built-in AI off (Gemini / Copilot / Leo / Firefox AI chat, on-device AI APIs)
  * encrypted-DNS bypass off (so the /etc/hosts block holds)
  * AI answers in search off: web search is pinned to Google "Web" results
    (udm=14 = no AI Overview, no AI Mode); Bing/DDG/Brave/You/Kagi/Yahoo search blocked
  * all browser extensions disabled (AI sidebars, Grammarly-type writers), except a short fixed
    list of password managers / Docs Offline / Zotero (so a logged-out student can still sign in)
  * every blocklist host is also blocked inside the browser (URLBlocklist / WebsiteFilter), so a
    browser-level bypass of /etc/hosts (--host-resolver-rules, a proxy add-on, Tor/VPN windows)
    still cannot open an AI site; Brave Tor windows + Brave VPN and Firefox's built-in VPN off
  * LOCKqz's own extension is added to Google Chrome and Brave for the length of the quiz (the browser's
    managed list; it comes out again at unlock): it enters the quiz password in the quiz page, so the
    student never types or pastes it. A browser that does not add it changes nothing: LOCKqz then shows
    the password as before.
Also Microsoft Office: "connected experiences that analyze content" off (Microsoft: Copilot is then
unavailable in Word, Excel, PowerPoint, OneNote, Outlook) - Office reads it when an app starts.
And Adobe Acrobat / Reader: AI Assistant off (FeatureLockdown bEnableGentech = false in the machine-level
/Library/Preferences/com.adobe.{Acrobat.Pro,Reader}.plist - Adobe reads it there, not from managed
preferences); also read when the app starts. Backed up and restored byte-for-byte like the browser files.

A managed-preferences file that already exists (a school MDM profile, the student's own policies)
is backed up to a root-only folder before LOCKqz adds its keys, and put back byte-for-byte at
unlock - it is never deleted. Root only ever writes to <policy dir>/<bundle id>.plist for bundle
ids in the fixed lists below; no path or name ever comes from a user-writable place.

Exit status: lock/unlock exit 1 if they could not complete (the engine then retries).

Usage: browser-policy.py {lock|unlock|status}   (root; LOCKQZ_POLICY_DIR / LOCKQZ_POLICY_BACKUP for tests)
"""
import json, os, plistlib, re, subprocess, sys

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
OFFICE = "com.microsoft.office"   # Word/Excel/PowerPoint/OneNote/Outlook read this managed domain
# Adobe Acrobat (Pro/Standard) and Acrobat Reader: their lockable settings live in the MACHINE-level
# preferences folder (not Managed Preferences). Fixed ids only.
ADOBE = ["com.adobe.Acrobat.Pro", "com.adobe.Reader"]
def prefs_dir():
    # Real runs: /Library/Preferences. Tests (LOCKQZ_POLICY_DIR / P.DIR pointed at a temp folder) never
    # touch the machine: the Adobe files then go to that same temp folder unless LOCKQZ_PREFS_DIR says.
    return os.environ.get("LOCKQZ_PREFS_DIR") or ("/Library/Preferences" if DIR == "/Library/Managed Preferences" else DIR)
MARK = "LOCKqzManaged"
# Written by extra-block.sh when the network only works through the student's proxy (campus /
# workplace proxy): then the browsers keep their proxy setting so Brightspace still loads.
PROXY_KEPT = os.environ.get("LOCKQZ_PROXY_KEPT") or os.path.join(os.path.dirname(BACKUP), "proxy.kept")
# Extensions that stay ON during the quiz (no AI in them): Bitwarden, 1Password, LastPass, Dashlane,
# Proton Pass, iCloud Passwords, Google Docs Offline, Zotero Connector (Chrome Web Store ids) and
# Bitwarden, 1Password, LastPass, Dashlane (Edge Add-ons ids). Fixed list - never read from the user.
SAFE_EXTENSIONS = ["nngceckbapebfimnlniiiahkandclblb", "aeblfdkhhhdcdjpifhhbdiojplfjncoa",
                   "hdokiejnpimakedhajhdlcegeplioahd", "fdjamakpfbbddfjaooikfcpapjohcfmg",
                   "ghmbeldphafepmbegfdlkpapadhbakde", "pejdijmoenmkgeppbflobdenhhabjlaj",
                   "ghbmnnjooekpmoecnnnilnnbdlolhkhi", "ekhagklcjbdpajgpjgmbionohlpdbjgc",
                   "jbkfoedolllekgbhcbcoahefnbanhhlh", "dppgmdbiimibapkepcbdbmkaabgiofem",
                   "bbcinlkgjjkejfdpemiealijmmooekmp", "gehmmocbbkpblljhkekmfhjpfbkclbph",
                   # Low-vision / dyslexia display aids (no AI, no text generation): Dark Reader,
                   # Google's High Contrast, OpenDyslexic. Always on, so no student needs to ask.
                   "eimadpbcbfnmbkopoojfekhnkhdbieeh", "djcfdncoelnlbldjfhinnjlhdjlikmph", "cdnapgfjopgaggbmfgbiinmmbdcglnam"]
# Assistive extensions a professor may allow ONE student (OSAS accommodation; the server sends only
# these keys, see ASSIST_TOOLS in [[route]].js). Fixed key -> Chrome Web Store id map: an id never comes
# from the network or a user-writable file. Desktop screen readers (VoiceOver), Dictation, Zoom and
# Spoken Content are never touched by LOCKqz, so they need no entry.
ASSIST_EXTENSIONS = {"readwrite": ["inoeonmfapjbbkmdafoankkfajkcphgd"], "equatio": ["hjngolefdpdnooamgdldlkjgmdcmcjnc"],
                     "cowriter": ["ifajfiofeifbbhbionejdliodenmecna"], "snapread": ["mloajfnmjckfjbeeofcdaecbelnblden"],
                     "readaloud": ["hdhinadidafjejdhmfkjgnolgimiaplp"]}
# Written by the helper (root, root-only folder) from the server's /password answer for the locked quiz;
# removed at unlock. Owned by root or ignored.
ASSIST_FILE = os.environ.get("LOCKQZ_ASSIST_FILE") or os.path.join(os.path.dirname(BACKUP), "assist.json")

# Exam rules (27 Nov 2026): what the engine built from the professor's rules for this exam (exam.json, root-owned; the
# engine names it in LOCKQZ_EXAM and hands this exam's blocklist as LOCKQZ_BLOCKLIST). None: no rules, policy as always.
EXAM_FILE = os.environ.get("LOCKQZ_EXAM") or ""

def exam():
    """{"web": [sites] or None, "search": bool, "translate": bool, ...} for this exam, {} without rules."""
    if not EXAM_FILE: return {}
    try:
        st = os.stat(EXAM_FILE)
        if os.geteuid() == 0 and (st.st_uid != 0 or st.st_mode & 0o022): return {}
        with open(EXAM_FILE) as f: d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception: return {}

def _web(ex):
    """The sites a browser may open when the professor blocked all other websites ([] = none), None when not."""
    w = ex.get("web") if isinstance(ex, dict) else None
    if not isinstance(w, list): return None
    return [x.lower() for x in w if isinstance(x, str) and (re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+", x.lower()) or
            re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}/[a-z0-9._~%/-]*", x.lower()))]

def exam_chromium(p, ex):
    """The professor's rules on a Chromium policy: no web search (no Google "Web" results either), no translation,
    and with all other websites blocked only the open sites ("*" blocked; a listed AI page stays blocked: the most
    specific entry wins in Chromium, and the AI list is more specific than any open site)."""
    if not ex: return
    if ex.get("search") is False: p["URLAllowlist"] = [x for x in p.get("URLAllowlist", []) if x not in SEARCH_ALLOW]
    if ex.get("translate") is False: p["TranslateEnabled"] = False
    web = _web(ex)
    if web is not None:
        p["URLBlocklist"] = _union(["*"], p.get("URLBlocklist", []))
        p["URLAllowlist"] = _union(p.get("URLAllowlist", []), web + ["file://*"])

def exam_firefox(pol, ex, blocked):
    """The same on a Firefox policy. Firefox's exceptions beat every block, so a site whose part is blocked (an AI page
    under it, a blocked row's page) is not opened there at all. blocked = this exam's blocklist entries."""
    if not ex: return
    wf = pol["WebsiteFilter"]
    if ex.get("search") is False: wf["Exceptions"] = []
    if ex.get("translate") is False: pol["Preferences"]["browser.translations.enable"] = {"Value": False, "Status": "locked"}
    web = _web(ex)
    if web is None: return
    def inside(b, w):   # blocklist entry b is the open site w or a part of it
        bh, _, bp = b.partition("/"); wh, _, wp = w.partition("/")
        return (bh == wh or bh.endswith("." + wh)) and (not wp or (bh == wh and ("/" + bp).startswith("/" + wp)))
    exc = []
    for w in web:
        if any(inside(b, w) for b in blocked): continue
        exc.append("*://*.%s*" % w if "/" in w else "*://*.%s/*" % w)
    wf["Block"] = _union(["<all_urls>"], wf["Block"])
    wf["Exceptions"] = _union(wf["Exceptions"], exc + ["file:///*"])

def all_entries():
    """Every entry of this exam's blocklist (hosts and host/paths), lower case."""
    out = []
    try:
        with open(BLOCKLIST) as f:
            for l in f:
                l = l.strip().lower()
                if l and not l.startswith("#") and " " not in l: out.append(l)
    except Exception: pass
    return out

def assist_extensions():
    """Extra extension ids allowed for this student's locked quiz (professor's allowance), [] if none."""
    try:
        st = os.stat(ASSIST_FILE)
        if os.geteuid() == 0 and (st.st_uid != 0 or st.st_mode & 0o022): return []
        with open(ASSIST_FILE) as f: tools = json.load(f).get("tools") or []
    except Exception: return []
    out = []
    for k in tools if isinstance(tools, list) else []:
        for i in ASSIST_EXTENSIONS.get(k if isinstance(k, str) else "", []):
            if i not in out: out.append(i)
    return out

# Google's country sites carry the same AI Overviews / AI Mode (google.com.qa/search?udm=50): every
# country site Google runs (google.com/supported_domains) is closed for the quiz; plain web search keeps
# working on google.com through the default engine. One whole-host entry each (www.google.<cc>) keeps the
# browsers' 1000-entry filter lists small; accounts.google.<cc> (sign-in) is left alone.
GOOGLE_CC = ["ad", "ae", "com.af", "com.ag", "al", "am", "co.ao", "com.ar", "as", "at", "com.au", "az", "ba",
             "com.bd", "be", "bf", "bg", "com.bh", "bi", "bj", "com.bn", "com.bo", "com.br", "bs", "bt",
             "co.bw", "by", "com.bz", "ca", "cd", "cf", "cg", "ch", "ci", "co.ck", "cl", "cm", "cn",
             "com.co", "co.cr", "com.cu", "cv", "com.cy", "cz", "de", "dj", "dk", "dm", "com.do", "dz",
             "com.ec", "ee", "com.eg", "es", "com.et", "fi", "com.fj", "fm", "fr", "ga", "ge", "gg",
             "com.gh", "com.gi", "gl", "gm", "gr", "com.gt", "gy", "com.hk", "hn", "hr", "ht", "hu", "co.id",
             "ie", "co.il", "im", "co.in", "iq", "is", "it", "je", "com.jm", "jo", "co.jp", "co.ke",
             "com.kh", "ki", "kg", "co.kr", "com.kw", "kz", "la", "com.lb", "li", "lk", "co.ls", "lt", "lu",
             "lv", "com.ly", "co.ma", "md", "me", "mg", "mk", "ml", "com.mm", "mn", "com.mt", "mu", "mv",
             "mw", "com.mx", "com.my", "co.mz", "com.na", "com.ng", "com.ni", "ne", "nl", "no", "com.np",
             "nr", "nu", "co.nz", "com.om", "com.pa", "com.pe", "com.pg", "com.ph", "com.pk", "pl", "pn",
             "com.pr", "ps", "pt", "com.py", "com.qa", "ro", "ru", "rw", "com.sa", "com.sb", "sc", "se",
             "com.sg", "sh", "si", "sk", "com.sl", "sn", "so", "sm", "sr", "st", "com.sv", "td", "tg",
             "co.th", "com.tj", "tl", "tm", "tn", "to", "com.tr", "tt", "com.tw", "co.tz", "com.ua", "co.ug",
             "co.uk", "com.uy", "co.uz", "com.vc", "co.ve", "co.vi", "com.vn", "vu", "ws", "rs", "co.za",
             "co.zm", "co.zw", "cat"]
SEARCH_BLOCK = ["www.google.%s" % c for c in GOOGLE_CC] + ["google.com/search", "google.com/webhp", "bing.com/search", "bing.com/copilotsearch",
                "bing.com/chat", "copilot.microsoft.com", "duckduckgo.com", "duck.ai",
                "search.yahoo.com", "search.brave.com", "you.com", "kagi.com",
                "yandex.com/search", "ecosia.org/search", "startpage.com",
                # more engines that answer with AI
                "yandex.ru/search", "ya.ru/search", "baidu.com/s", "search.naver.com", "ask.com", "yep.com",
                "search.aol.com", "ecosia.org/chat", "sogou.com/web", "so.com/s"]
# Google verticals that carry no AI answer: Web, Images, News, Video, Books; DuckDuckGo's no-AI
# site (Search Assist, Duck.ai and AI images off).
SEARCH_ALLOW = ["noai.duckduckgo.com", "google.com/search?udm=14", "google.com/search?udm=2", "google.com/search?udm=12",
                "google.com/search?udm=7", "google.com/search?udm=36",
                "google.com/search?tbm=isch", "google.com/search?tbm=nws",
                "google.com/search?tbm=vid", "google.com/search?tbm=bks"]
WEB_SEARCH = "https://www.google.com/search?udm=14&q={searchTerms}"
FF_OK_PARAMS = ["udm=14", "udm=2", "udm=12", "udm=7", "udm=36", "tbm=isch", "tbm=nws", "tbm=vid", "tbm=bks"]

def keep_proxy():
    return os.path.exists(PROXY_KEPT)

# Every Chrome AI feature switched off one by one. Chrome takes GenAiDefaultSettings only from a cloud
# source (Google Admin console): written on the computer it is ignored ("not set by a cloud source"), so a
# feature with no policy of its own here stays on. Values from chromium policy_definitions/GenerativeAI
# (2 / 1 / false = do not allow); policies newer than a browser are ignored by it.
CHROMIUM_AI_OFF = {
    "AIModeSettings": 1, "GeminiActOnWebSettings": 1, "GeminiSparkSettings": 1,
    "GeminiChromeFileUploadSettings": 1, "HelpMeWriteSettings": 2, "HistorySearchSettings": 2,
    "TabCompareSettings": 2, "TabOrganizerSettings": 2, "CreateThemesSettings": 2,
    "DevToolsGenAiSettings": 2, "AutofillGenAiSettings": 2, "AutofillPredictionSettings": 2,
    "SearchContentSharingSettings": 1, "SmartTabSharingSettings": 1, "ThirdPartyAiChatSettings": 1,
    "TryOnYouSettings": 2, "ChromeSuggestionsSettings": 1, "GenAILocalFoundationalModelSettings": 1,
    # Talk to type (AI dictation and editing, Chrome 151+), Find and Fill with Gemini, Indigo (AI image changes).
    "VoiceTypingSettings": 2, "FindAndFillWithGeminiSettings": 2, "Indigo": 2,
    "LensOverlaySettings": 1, "LensRegionSearchEnabled": False, "LensDesktopNTPSearchEnabled": False,
    "GoogleSearchSidePanelEnabled": False,
    # Extensions: no developer-mode (unpacked) extensions and no externally installed ones either.
    "ExtensionDeveloperModeSettings": 1, "BlockExternalExtensions": True,
}

# Edge's own AI switches (Microsoft Edge policy list): the sidebar, Copilot reading the page, Copilot
# taking actions in the browser (Cowork 152+, browsing with Copilot 148+, browser use 158+), the Copilot
# new tab page, Bing chat on the new tab page and Copilot answers in the address bar, Web Remix (AI page
# rewrites, 156+), AI history search, DALL-E themes, Copilot opening by itself from Outlook links.
EDGE_AI_OFF = {
    "HubsSidebarEnabled": False, "StandaloneHubsSidebarEnabled": False,
    "CopilotCDPPageContext": False, "CopilotPageContext": False, "EdgeEntraCopilotPageContext": False,
    "ComposeInlineEnabled": False, "Microsoft365CopilotChatIconEnabled": False,
    "CopilotCoworkToolActionsEnabled": False, "AllowBrowsingWithCopilot": False,
    "CopilotBrowserUseBlockList": ["*"], "CopilotNewTabPageEnabled": False,
    "NewTabPageBingChatEnabled": False, "CopilotAddressBarSuggestionsEnabled": False,
    "M365LinksAutoOpenCopilotEnabled": False, "ShareBrowsingHistoryWithCopilotSearchAllowed": False,
    "EdgeHistoryAISearchEnabled": False, "AIGenThemesEnabled": False, "RemixAvailability": 0,
    "GenAILocalFoundationalModelSettings": 1,
}

# LOCKqz's own extension (Chrome Web Store; Edge takes Chrome Web Store extensions by this update address too).
# Added while a quiz is locked; a student's or an MDM's own managed extensions stay as they are (merge_chromium).
# It enters the quiz password, which the agent hands to it in the tab's address: no history is saved during the
# quiz (SavingBrowserHistoryDisabled), so that address is kept nowhere.
PW_EXT = "bidlfpkdggdpmfbfkpjcnbjhfkfligkk"
PW_EXT_FORCE = PW_EXT + ";https://clients2.google.com/service/update2/crx"
def chromium_policy(domain):
    p = {MARK: True,
         "GenAiDefaultSettings": 2, "GeminiSettings": 1, "BuiltInAIAPIsEnabled": False,
         "DnsOverHttpsMode": "off", "ProxyMode": "direct",   # a proxy would resolve AI sites past hosts
         # No developer tools, page-source view or javascript: addresses (bookmarklets) during the quiz: the exam
         # page and the password LOCKqz entered stay as Brightspace made them.
         "DeveloperToolsAvailability": 2,
         "URLBlocklist": list(SEARCH_BLOCK) + ["javascript://*", "view-source:*"], "URLAllowlist": list(SEARCH_ALLOW),
         "DefaultSearchProviderEnabled": True, "DefaultSearchProviderName": "Google (Web)",
         "DefaultSearchProviderSearchURL": WEB_SEARCH,
         "DefaultSearchProviderSuggestURL": "https://www.google.com/complete/search?output=chrome&q={searchTerms}",
         "ExtensionInstallBlocklist": ["*"], "ExtensionInstallAllowlist": list(SAFE_EXTENSIONS) + [i for i in assist_extensions() if i not in SAFE_EXTENSIONS],
         "SavingBrowserHistoryDisabled": True}
    if domain.startswith(("com.google.Chrome", "com.brave.Browser", "com.microsoft.Edge")): p["ExtensionInstallForcelist"] = [PW_EXT_FORCE]
    p.update(CHROMIUM_AI_OFF)
    if keep_proxy(): p.pop("ProxyMode")
    if domain.startswith("com.microsoft.Edge"):
        p.update({k: list(v) if isinstance(v, list) else v for k, v in EDGE_AI_OFF.items()})
    if domain.startswith("com.brave.Browser"):
        # Tor windows and Brave VPN look names up remotely, past /etc/hosts.
        p.update({"BraveAIChatEnabled": False, "TorDisabled": True, "BraveVPNDisabled": True})
    return p

def firefox_policy():
    # Each allowed vertical must be a real query parameter (?udm=14 / &udm=14), not text that merely
    # contains it (&x=udm=14 next to udm=50 opens AI Mode). With a real udm=14 Google answers Web results.
    exc = [p % v for v in FF_OK_PARAMS for p in ("https://www.google.com/search?%s", "https://www.google.com/search?%s&*",
                                                  "https://www.google.com/search?*&%s", "https://www.google.com/search?*&%s&*")]
    blk = ["https://www.google.%s/*" % c for c in GOOGLE_CC] + ["https://www.google.com/search*", "https://www.google.com/webhp*", "https://www.bing.com/*search*",
           "https://www.bing.com/chat*", "https://copilot.microsoft.com/*", "https://duckduckgo.com/*",
           "https://duck.ai/*", "https://search.yahoo.com/*", "https://search.brave.com/*",
           "https://you.com/*", "https://kagi.com/*", "https://yandex.com/search*",
           "https://www.ecosia.org/search*", "https://www.startpage.com/*",
           "https://yandex.ru/search*", "https://ya.ru/search*", "https://www.baidu.com/s*", "https://search.naver.com/*",
           "https://www.ask.com/*", "https://yep.com/*", "https://search.aol.com/*", "https://www.ecosia.org/chat*",
           "https://www.sogou.com/web*", "https://www.so.com/s*"]
    pol = {MARK: True, "EnterprisePoliciesEnabled": True,
           "DNSOverHTTPS": {"Enabled": False, "Locked": True},
           "Proxy": {"Mode": "none", "Locked": True},
           "IPProtectionAvailable": False,          # Firefox's built-in VPN (149+)
           "DisableDeveloperTools": True,
           "WebsiteFilter": {"Block": blk, "Exceptions": exc},
           # GenerativeAI (144+); Firefox ignores it when AIControls (149+) is present, so the
           # chatbot and Smart Window are blocked there too. Never AIControls "Default": "blocked"
           # deletes downloaded on-device models; the on-device features are off by the prefs below.
           "GenerativeAI": {"Enabled": False, "Chatbot": False, "LinkPreviews": False, "TabGroups": False,
                            "SmartWindow": False, "Locked": True},
           "AIControls": {"SidebarChatbot": {"Value": "blocked", "Locked": True},
                          "SmartWindow": {"Value": "blocked", "Locked": True}},
           "Preferences": {"browser.ml.chat.enabled": {"Value": False, "Status": "locked"},
                           "browser.ml.enable": {"Value": False, "Status": "locked"},
                           "browser.ml.linkPreview.enabled": {"Value": False, "Status": "locked"},
                           "browser.smartwindow.enabled": {"Value": False, "Status": "locked"},
                           # Open tabs written every 2 s (was 15 s) while the quiz is on: LOCKqz reads them there, so
                           # the exam's start, its submission and a search are seen within seconds.
                           "browser.sessionstore.interval": {"Value": 2000, "Status": "locked"}}}
    if keep_proxy(): pol.pop("Proxy")
    return pol

def office_policy():
    # Microsoft: with this FALSE, Copilot is unavailable in Word, Excel, PowerPoint, OneNote, Outlook.
    return {MARK: True, "OfficeExperiencesAnalyzingContentPreference": False}

def adobe_policy():
    # FeatureLockdown (track "DC") bEnableGentech = false: generative AI (AI Assistant) off and locked.
    return {MARK: True, "DC": {"FeatureLockdown": {"bEnableGentech": False}}}

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

def host_entries():
    """Plain host lines of the blocklist (the /etc/hosts entries), mirrored into the browsers' own
    URL filters: a browser that skips /etc/hosts (--host-resolver-rules, proxy add-on) is still
    blocked. Chromium matches subdomains too."""
    out = []
    try:
        with open(BLOCKLIST) as f:
            for l in f:
                l = l.strip().lower()
                if l and not l.startswith("#") and re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+", l):
                    out.append(l)
    except Exception:
        pass
    out = list(dict.fromkeys(out))
    # A listed host already covers its subdomains in every browser filter, so chat.openai.com next to
    # openai.com only spends one of the 1000 entries the browsers read (the hosts file keeps both).
    out = [h for h in out if not api_only(h)]
    have = set(out)
    return [h for h in out if not any(".".join(h.split(".")[i:]) in have for i in range(1, h.count(".")))]

def api_only(h):
    """A host that only answers programs, or one under such a host (firefox.dns.nextdns.io, us.api.inference.net)."""
    p = h.split(".")
    return any(API_ONLY.fullmatch(".".join(p[i:])) for i in range(0, len(p) - 2))

# Hosts that only answer programs (model APIs, DNS-over-HTTPS servers) stay in the hosts file and the firewall
# tables, which have no size limit, but leave the browsers' URL filters (1,000 entries each): no page opens on
# them, and those filters only stop pages and frames anyway.
API_ONLY = re.compile(r"(api\d*|api-inference|inference|bedrock-runtime|bedrock-mantle|aiplatform|generativelanguage|dashscope"
                      r"|dashscope-intl|copilot-proxy|router|integrate|appsgenaiserver-pa|grazie|llm|models|dns|doh)(\.[a-z0-9-]+){2,}")

def firefox_blocks(extra, hosts):
    """Firefox WebsiteFilter patterns for the blocklist: one per entry, as on Windows. In Firefox's match
    patterns *.host also matches host itself, so *://*.huggingface.co/chat* covers huggingface.co/chat."""
    return ["*://*.%s*" % e for e in extra] + ["*://*.%s/*" % h for h in hosts]

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
    if (base or {}).get("ExtensionInstallForcelist") or ours.get("ExtensionInstallForcelist"):
        out["ExtensionInstallForcelist"] = _union((base or {}).get("ExtensionInstallForcelist"), ours.get("ExtensionInstallForcelist") or [])
    return out

def merge_plain(base, ours):
    out = dict(base or {}); out.update(ours); return out

def merge_adobe(base, ours):
    """Their Acrobat machine prefs with only DC/FeatureLockdown/bEnableGentech (+ our mark) set on top."""
    out = dict(base or {}); out[MARK] = True
    dc = out.get("DC") if isinstance(out.get("DC"), dict) else {}
    dc = dict(dc)
    fl = dc.get("FeatureLockdown") if isinstance(dc.get("FeatureLockdown"), dict) else {}
    fl = dict(fl); fl.update(ours["DC"]["FeatureLockdown"])
    dc["FeatureLockdown"] = fl; out["DC"] = dc
    return out

def merge_firefox(base, ours):
    out = dict(base or {})
    out.update({k: v for k, v in ours.items() if k not in ("WebsiteFilter", "Preferences", "AIControls", "GenerativeAI")})
    for k in ("AIControls", "GenerativeAI"):   # their other AI settings stay; ours on top
        if k in ours:
            have = (base or {}).get(k)
            d = dict(have) if isinstance(have, dict) else {}
            d.update(ours[k]); out[k] = d
    wf = (base or {}).get("WebsiteFilter") if isinstance((base or {}).get("WebsiteFilter"), dict) else {}
    out["WebsiteFilter"] = {"Block": _union(wf.get("Block"), ours["WebsiteFilter"]["Block"]),
                            "Exceptions": ours["WebsiteFilter"]["Exceptions"]}
    prefs = dict((base or {}).get("Preferences") or {}) if isinstance((base or {}).get("Preferences"), dict) else {}
    prefs.update(ours["Preferences"]); out["Preferences"] = prefs
    return out

def path(domain): return os.path.join(prefs_dir() if domain in ADOBE else DIR, domain + ".plist")
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
        # Inside a lock / unlock the engine restarts the preferences service once, as its last step (it names
        # a flag file to leave); on its own this does it at once.
        flag = os.environ.get("LOCKQZ_PREFS_DIRTY")
        if flag:
            try: open(flag, "w").close(); return
            except Exception: pass
        subprocess.run(["killall", "cfprefsd"], capture_output=True)

def _candidates():
    try: present = [f[:-6] for f in os.listdir(DIR) if f.endswith(".plist")]
    except Exception: present = []
    try: saved = [f[:-6] for f in os.listdir(BACKUP) if f.endswith(".plist")]
    except Exception: saved = []
    return sorted(d for d in set(CHROMIUM + GECKO + [OFFICE] + ADOBE + firefox_family_ids() + present + saved) if ID_RE.fullmatch(d))

def lock():
    changed, failed, extra, hosts = False, False, path_entries(), host_entries()
    ex = exam(); blocked = all_entries() if ex else []
    jobs = [(d, chromium_policy(d), merge_chromium) for d in CHROMIUM] + \
           [(d, firefox_policy(), merge_firefox) for d in firefox_family_ids()] + \
           [(OFFICE, office_policy(), merge_plain)] + \
           [(d, adobe_policy(), merge_adobe) for d in ADOBE]
    for d, pol, merge in jobs:
        if "URLBlocklist" in pol:   # Chromium: <= 1000 entries (ours ~330)
            pol["URLBlocklist"] = _union(pol["URLBlocklist"], extra + hosts)
            exam_chromium(pol, ex)
        if "WebsiteFilter" in pol:  # Firefox: <= 1000 entries each list
            pol["WebsiteFilter"]["Block"] = _union(pol["WebsiteFilter"]["Block"], firefox_blocks(extra, hosts))
            exam_firefox(pol, ex, blocked)
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
