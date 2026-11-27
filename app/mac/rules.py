#!/usr/bin/env python3
"""LOCKqz exam rules (Mac and Linux): what the professor lets students use in this exam, applied to LOCKqz's lists.

The helper writes rules.json (root-only) from the server's /password answer: the blocked row keys, the sites the
professor also allows, the sites or programs the professor also blocks. Every program name and address of a row is
LOCKqz's own (rules-catalog.json, shipped with the app); a key the catalog does not know is ignored, and nothing the
server sends is ever run or used as a path.

    rules.py build <rules.json> <blocklist.txt> <out dir> <mac|linux>

writes three files (0644) for the engine, the browser policy and the agent:
  exam-blocklist.txt  this exam's blocklist: LOCKqz's list without the allowed rows' own entries, with the blocked
                      rows' entries and the professor's blocked sites (no other entry ever leaves the list)
  exam-apps.txt       one "close|keep|typed<TAB>name" per line: programs the blocked rows close, programs of LOCKqz's
                      own list that an allowed row keeps open, and programs the professor typed (closed only when safe)
  exam.json           {"v", "label", "b", "web", "search", "translate"}: web = what browsers may open when all other
                      websites are blocked (null otherwise); search / translate = web search / translators allowed
Exit 1 and nothing written when rules.json or the catalog cannot be read: the engine then locks as without rules.
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOG = os.environ.get("LOCKQZ_RULES_CATALOG") or os.path.join(HERE, "rules-catalog.json")
HOST_RE = re.compile(r"[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]+")
PATH_RE = re.compile(r"[a-z0-9.-]+\.[a-z]{2,}/[a-z0-9._~%/-]*")
NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9 ._&+()'-]{0,59}")
NAMES = ("close", "keep", "typed")

def catalog(path=None):
    with open(path or CATALOG) as f: c = json.load(f)
    rows = c.get("rows") if isinstance(c, dict) else None
    if not isinstance(rows, dict) or not rows: raise ValueError("no rows")
    return c

def load(path, cat):
    """rules.json -> {"label", "b": set of known blocked keys, "allow": [hosts], "block": [hosts or names]}; None if unreadable."""
    try:
        with open(path) as f: r = json.load(f)
    except Exception: return None
    q = str(r.get("quiz_host") or "").lower() if isinstance(r, dict) else ""
    r = r.get("rules") if isinstance(r, dict) and isinstance(r.get("rules"), dict) else r
    if not isinstance(r, dict) or not isinstance(r.get("b"), list): return None
    keys = set(cat["rows"])
    b = {k for k in r["b"] if isinstance(k, str) and k in keys}
    allow = [h for h in (host(x) for x in (r.get("allow") if isinstance(r.get("allow"), list) else [])[:20]) if h]
    block = []
    for x in (r.get("block") if isinstance(r.get("block"), list) else [])[:20]:
        x = str(x or "").strip()
        if x and (host(x) or NAME_RE.fullmatch(x)) and x not in block: block.append(x)
    label = str(r.get("label") or "")[:40]
    q = q if re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+", q) else ""   # the quiz's own site: always open
    return {"label": label, "b": b, "allow": allow, "block": block, "quiz_host": q}

def host(v):
    """A site typed by the professor -> its host (no scheme, path, port or "www."), "" when it is not a site."""
    s = str(v or "").strip().lower()
    s = re.sub(r"^[a-z][a-z0-9+.-]*://", "", s)
    s = re.split(r"[/?#]", s, maxsplit=1)[0]
    s = re.sub(r":\d+$", "", s).rstrip(".")
    if s.startswith("www."): s = s[4:]
    return s if len(s) <= 100 and HOST_RE.fullmatch(s) else ""

def under(h, d):
    return h == d or h.endswith("." + d)

def program(x):
    """A program the professor typed ("Spotify", "Spotify.app", "spotify.exe") -> its name, "" when it is a site."""
    if re.search(r"\.(app|exe)$", x, re.I): return re.sub(r"\.(app|exe)$", "", x, flags=re.I)
    return "" if host(x) else x

def entries(lines):
    out = []
    for l in lines:
        l = l.strip().lower()
        if l and not l.startswith("#") and " " not in l and l not in out: out.append(l)
    return out

def build(rules, base_lines, cat, plat):
    """-> (blocklist entries, [(kind, name)], exam dict) for this exam."""
    rows, b = cat["rows"], rules["b"]
    allowed = [k for k in rows if k not in b]
    blocked = [k for k in rows if k in b]
    base = entries(base_lines)
    gone = set()
    for k in allowed: gone.update(e.lower() for e in rows[k].get("hosts", []) + rows[k].get("paths", []))
    out = [e for e in base if e not in gone]
    have = set(out)
    add = [e.lower() for k in blocked for e in rows[k].get("hosts", []) + rows[k].get("paths", [])]
    if "search" in b: add += [e.lower() for e in cat.get("search_hosts", [])]
    keep_sites = [e.split("/")[0] for e in cat.get("base_allow", [])]
    for x in rules["block"]:
        h = "" if re.search(r"\.exe$", x, re.I) else host(x)
        # never the exam, sign-in or LOCKqz (the server refuses them too)
        if h and not any(under(k, h) or under(h, k) for k in keep_sites): add.append(h)
    for e in add:
        if (HOST_RE.fullmatch(e) or PATH_RE.fullmatch(e)) and e not in have: out.append(e); have.add(e)
    never = {n.lower() for n in cat.get("never_close", [])}
    apps = []
    for k in blocked:
        for n in rows[k].get(plat, []): apps.append(("close", n))
    for k in allowed:
        for n in rows[k].get(plat, []): apps.append(("keep", n))
    for x in rules["block"]:
        n = program(x)
        if n and NAME_RE.fullmatch(n) and n.lower() not in never: apps.append(("typed", n))
    web = None
    if "web" in b:
        blocked_hosts = [e for e in out if "/" not in e]
        web = []
        for e in cat.get("base_allow", []) + [e for k in allowed for e in rows[k].get("hosts", []) + rows[k].get("paths", []) + rows[k].get("web", [])] + \
                 ([rules["quiz_host"]] if rules.get("quiz_host") else []) + rules["allow"]:
            e = e.lower()
            if e in web: continue
            if e in rules["allow"] and any(under(e.split("/")[0], d) for d in blocked_hosts): continue   # a typed site never opens a blocked one
            web.append(e)
    exam = {"v": 1, "label": rules["label"], "b": sorted(b), "web": web, "search": "search" not in b, "translate": "translate" not in b}
    return out, apps, exam

def _write(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w") as f: f.write(text)
    os.chmod(tmp, 0o644); os.replace(tmp, path)

def main(argv):
    if len(argv) != 6 or argv[1] != "build" or argv[5] not in ("mac", "linux"):
        print(__doc__.strip().splitlines()[0]); return 2
    try: cat = catalog()
    except Exception as e: print("rules: catalog: %s" % e, file=sys.stderr); return 1
    rules = load(argv[2], cat)
    if rules is None: print("rules: could not read %s" % argv[2], file=sys.stderr); return 1
    try:
        with open(argv[3]) as f: base = f.readlines()
    except Exception as e: print("rules: blocklist: %s" % e, file=sys.stderr); return 1
    out, apps, exam = build(rules, base, cat, argv[5])
    d = argv[4]
    _write(os.path.join(d, "exam-blocklist.txt"), "".join(e + "\n" for e in out))
    _write(os.path.join(d, "exam-apps.txt"), "".join("%s\t%s\n" % a for a in apps))
    _write(os.path.join(d, "exam.json"), json.dumps(exam))   # last: the engine rebuilds when it is older than rules.json
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv))
