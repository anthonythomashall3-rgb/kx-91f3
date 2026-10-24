#!/usr/bin/env python3
"""Build sections.sql from USC's public Schedule of Classes (classes.usc.edu).

For the current and next terms: every section and its instructor(s). No AI, no login.
Usage: python3 build_sections.py OUT.sql
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

def main(out):
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
    with open(out, "w") as fh:
        fh.write("DELETE FROM usc_sections WHERE term IN (%s);\n" % ",".join(q(t) for t in terms))
        for i in range(0, len(rows), 200):
            fh.write("INSERT OR REPLACE INTO usc_sections (term,section,course,title,first,last,seats,registered) VALUES\n")
            fh.write(",\n".join("(%s)" % ",".join(q(v) for v in r) for r in rows[i:i+200]) + ";\n")
    print(f"{len(rows)} instructor-section rows, terms {terms}", file=sys.stderr)

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "sections.sql")
