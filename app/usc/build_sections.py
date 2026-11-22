#!/usr/bin/env python3
"""Build sections.sql from USC's public Schedule of Classes (classes.usc.edu).

For the current term and the next two (as soon as USC publishes them): every section and its
instructor(s). No AI, no login.
Usage: python3 build_sections.py OUT.sql [CURRENT.json]
       python3 build_sections.py --first-term      (prints the current term code)
With CURRENT.json (the rows already in D1) only the changes are written: one SQL statement per line,
at most LIMIT a run (the free D1 write limit), the current term first; what is left goes in the next run.
"""
import json, sys, time, datetime, urllib.request, urllib.error, concurrent.futures as cf

API = "https://classes.usc.edu/api"
UA = {"User-Agent": "LOCKqz-sections/1.0 (+https://lockqz.com)"}
LIMIT = 3000          # statements a run (each writes a few D1 rows with the indexes)
DROP_SHARE = 0.2      # more than this share of a term's sections gone in one run = USC's data looks broken
DROP_FLOOR = 200      # ... but up to this many may always go (normal cancellations and instructor changes)

class NotPublished(Exception):
    """USC answers 500 "Configuration does not exist for <term>" for a term it has not published yet."""

def get(path, tries=4, pause=2.0):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(API + path, headers=UA), timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            try: body = e.read().decode("utf-8", "replace")
            except Exception: body = ""
            if "does not exist" in body: raise NotPublished(path)
            if i == tries - 1: raise
        except Exception:
            if i == tries - 1: raise
        time.sleep(pause * (2 ** i))
    return None

def terms_now(today=None):
    d = today or datetime.date.today()
    s = 1 if d.month <= 5 else (2 if d.month <= 7 else 3)
    out = [d.year * 10 + s]
    for _ in range(2): y, t = divmod(out[-1], 10); out.append(y * 10 + t + 1 if t < 3 else (y + 1) * 10 + 1)
    return out

def q(v):
    return "NULL" if v is None else "'" + str(v).replace("'", "''") + "'"

def fetch_term(term, getter=get):
    """(rows, complete). rows is None when USC has not published the term (or its program list failed):
    that term is then left exactly as it is. complete is False when some program could not be read."""
    try: progs = getter(f"/Programs/TermCode?termCode={term}") or []
    except NotPublished:
        print(f"term {term}: not published yet", file=sys.stderr); return None, False
    except Exception as e:
        print(f"term {term}: program list unreadable ({e}); left as it is", file=sys.stderr); return None, False
    pairs = sorted({(s["prefix"], p["prefix"]) for p in progs for s in (p.get("schools") or [])})
    if not pairs: return None, False
    def one(pair):
        school, prog = pair
        try: return getter(f"/Courses/CoursesByTermSchoolProgram?termCode={term}&school={school}&program={prog}") or {}
        except Exception as e: return e
    rows, failed = [], 0
    with cf.ThreadPoolExecutor(8) as ex:
        for d in ex.map(one, pairs):
            if isinstance(d, Exception): failed += 1; continue
            for c in d.get("courses") or []:
                course = " ".join(str(c.get("fullCourseName") or "").split())
                title = " ".join(str(c.get("name") or "").split())
                for s in c.get("sections") or []:
                    if s.get("isCancelled"): continue
                    for i in s.get("instructors") or []:
                        f, l = (i.get("firstName") or "").strip(), (i.get("lastName") or "").strip()
                        if not l: continue
                        rows.append((str(term), str(s.get("sisSectionId")), course, title, f, l, None, None))
    print(f"term {term}: {len(pairs)} programs" + (f", {failed} unreadable (nothing removed from this term)" if failed else ""), file=sys.stderr)
    return rows, failed == 0

def main(out, current=None, getter=get, today=None, limit=LIMIT):
    rows, terms, full = [], [], set()
    for term in terms_now(today):
        r, complete = fetch_term(term, getter)
        if r is None: continue
        rows += r; terms.append(str(term))
        if complete: full.add(str(term))
    rows = sorted(set(rows))
    if len(rows) < 1000: sys.exit(f"only {len(rows)} sections found; refusing to replace the index")
    stmts, held = diff(rows, terms, load_current(current), full)
    for t, n in held: print(f"::warning::term {t}: {n} sections would be removed at once; kept until USC's data looks normal", file=sys.stderr)
    if len(stmts) > limit:
        print(f"::notice::{len(stmts)} changes; {limit} written now, the rest in the next runs (free D1 limit)", file=sys.stderr)
        stmts = stmts[:limit]
    with open(out, "w") as fh:
        for st in stmts: fh.write(st + "\n")
    print(f"{len(rows)} instructor-section rows, terms {terms}; {len(stmts)} changes written", file=sys.stderr)

KEY = lambda r: (r[0], r[1], r[5], r[4])                   # term, section, last, first (the table's key)

def load_current(path):
    """Rows already in D1 (wrangler d1 execute --json output); none given = an empty table."""
    if not path: return {}
    d = json.load(open(path))
    res = d[0]["results"] if isinstance(d, list) else d.get("results", [])
    return {(str(x["term"]), str(x["section"]), x["last"] or "", x["first"] or ""):
            (str(x["term"]), str(x["section"]), x["course"], x["title"], x["first"] or "", x["last"] or "", None, None) for x in res}

def diff(rows, terms, cur, full=None):
    """Only the writes needed, term by term in the order given (the current term first): new or changed
    sections (course, title, instructor), then the ones gone. Gone sections are removed only for a term
    read completely (full), and not when an implausible share of the term would go at once (held).
    Seat and enrollment counts are not kept (LOCKqz does not use them). -> (statements, held)"""
    cur = cur or {}
    full = set(terms) if full is None else set(full)
    want = {KEY(r): r for r in rows}
    out, held = [], []
    for t in terms:
        mine = sorted(k for k in want if k[0] == t)
        out += [ins(want[k]) for k in mine if cur.get(k) is None or not same(cur[k], want[k])]
        if t not in full: continue
        have = [k for k in cur if k[0] == t]
        gone = sorted(k for k in have if k not in want)
        if len(gone) > max(DROP_FLOOR, DROP_SHARE * len(have)): held.append((t, len(gone))); continue
        out += ["DELETE FROM usc_sections WHERE term=%s AND section=%s AND last=%s AND first=%s;" % (q(k[0]), q(k[1]), q(k[2]), q(k[3])) for k in gone]
    return out, held

def same(old, r):
    norm = lambda v: None if v is None else str(v)
    return [norm(x) for x in old[:6]] == [norm(x) for x in r[:6]]

def ins(r):
    return "INSERT OR REPLACE INTO usc_sections (term,section,course,title,first,last,seats,registered) VALUES (%s);" % ",".join(q(v) for v in r)

if __name__ == "__main__":
    if sys.argv[1:2] == ["--first-term"]: print(terms_now()[0]); sys.exit(0)
    main(sys.argv[1] if len(sys.argv) > 1 else "sections.sql", sys.argv[2] if len(sys.argv) > 2 else None)
