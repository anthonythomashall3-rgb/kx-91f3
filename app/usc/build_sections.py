#!/usr/bin/env python3
"""Build sections.sql from USC's public Schedule of Classes (classes.usc.edu).

For the current and next terms: every section and its instructor(s). No AI, no login.
Usage: python3 build_sections.py OUT.sql [CURRENT.json]
With CURRENT.json (the rows already in D1) only the changes are written: one SQL statement per line.
"""
import json, sys, datetime, urllib.request, concurrent.futures as cf

API = "https://classes.usc.edu/api"
UA = {"User-Agent": "LOCKqz-sections/1.0 (+https://lockqz.pages.dev)"}

def get(path, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(API + path, headers=UA), timeout=60) as r:
                return json.load(r)
        except Exception as e:
            if i == tries - 1: raise
    return None

def terms_now():
    d = datetime.date.today()
    s = 1 if d.month <= 5 else (2 if d.month <= 7 else 3)
    cur = d.year * 10 + s
    nxt = cur + 1 if s < 3 else (d.year + 1) * 10 + 1
    return [cur, nxt]

def q(v):
    return "NULL" if v is None else "'" + str(v).replace("'", "''") + "'"

def main(out, current=None):
    rows = []
    for term in terms_now():
        progs = get(f"/Programs/TermCode?termCode={term}") or []
        pairs = sorted({(s["prefix"], p["prefix"]) for p in progs for s in (p.get("schools") or [])})
        if not pairs: continue
        def one(pair):
            school, prog = pair
            return get(f"/Courses/CoursesByTermSchoolProgram?termCode={term}&school={school}&program={prog}") or {}
        with cf.ThreadPoolExecutor(8) as ex:
            for d in ex.map(one, pairs):
                for c in d.get("courses") or []:
                    course = " ".join(str(c.get("fullCourseName") or "").split())
                    title = " ".join(str(c.get("name") or "").split())
                    for s in c.get("sections") or []:
                        if s.get("isCancelled"): continue
                        for i in s.get("instructors") or []:
                            f, l = (i.get("firstName") or "").strip(), (i.get("lastName") or "").strip()
                            if not l: continue
                            rows.append((str(term), str(s.get("sisSectionId")), course, title, f, l, s.get("totalSeats"), s.get("registeredSeats")))
        print(f"term {term}: {len(pairs)} programs", file=sys.stderr)
    rows = sorted(set(rows))
    if len(rows) < 1000: sys.exit(f"only {len(rows)} sections found; refusing to replace the index")
    terms = sorted({r[0] for r in rows})
    stmts = diff(rows, terms, load_current(current))
    with open(out, "w") as fh:
        for st in stmts: fh.write(st + "\n")
    print(f"{len(rows)} instructor-section rows, terms {terms}; {len(stmts)} changes", file=sys.stderr)

KEY = lambda r: (r[0], r[1], r[5], r[4])                   # term, section, last, first (the table's key)

def load_current(path):
    """Rows already in D1 (wrangler d1 execute --json output), or None for a full load."""
    if not path: return None
    d = json.load(open(path))
    res = d[0]["results"] if isinstance(d, list) else d.get("results", [])
    return {(str(x["term"]), str(x["section"]), x["last"] or "", x["first"] or ""):
            (str(x["term"]), str(x["section"]), x["course"], x["title"], x["first"] or "", x["last"] or "", x["seats"], x["registered"]) for x in res}

def diff(rows, terms, cur):
    """Only the writes needed: new or changed sections, removed ones. Enrollment counts move every day
    during registration, so a count change alone is written only when it moved by 5 or more."""
    if cur is None:
        out = ["DELETE FROM usc_sections WHERE term IN (%s);" % ",".join(q(t) for t in terms)]
        return out + [ins(r) for r in rows]
    want = {KEY(r): r for r in rows}
    out = []
    for k, r in want.items():
        old = cur.get(k)
        if old is None or not same(old, r) or big_move(old, r):
            out.append(ins(r))
    for k in cur:
        if k[0] in terms and k not in want:
            out.append("DELETE FROM usc_sections WHERE term=%s AND section=%s AND last=%s AND first=%s;" % (q(k[0]), q(k[1]), q(k[2]), q(k[3])))
    return out

def same(old, r):
    norm = lambda v: None if v is None else str(v)
    return [norm(x) for x in old[:7]] == [norm(x) for x in r[:7]]

def big_move(old, r):
    if old is None: return False
    try: return abs(int(old[7] or 0) - int(r[7] or 0)) >= 5
    except Exception: return str(old[7]) != str(r[7])

def ins(r):
    return "INSERT OR REPLACE INTO usc_sections (term,section,course,title,first,last,seats,registered) VALUES (%s);" % ",".join(q(v) for v in r)

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "sections.sql", sys.argv[2] if len(sys.argv) > 2 else None)
