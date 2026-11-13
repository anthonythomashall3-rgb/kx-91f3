#!/usr/bin/env python3
"""Add a school to the Cloudflare site. Each school gets its own D1 database.

  python3 add-school.py --name "State University" --brightspace learn.stateu.edu --domain stateu.edu

It checks that the address answers as a Brightspace, creates the database lockqz-<id>, and writes the school
into wrangler.toml (the binding DB_<ID> and the SCHOOLS setting). Commit and push: the release creates the
tables in the new database and the school answers from then on. See SCHOOLS.md.
  --id          made from the name unless given        --no-check    skip the Brightspace check
  --db-id ID    use this database id (do not create one)   --toml FILE   another wrangler.toml (tests)
"""
import argparse, json, re, subprocess, sys, unicodedata, urllib.request
from pathlib import Path

USC = {"id": "usc", "name": "University of Southern California", "brightspace": ["brightspace.usc.edu", "usc.brightspace.com"], "domains": ["usc.edu"]}
HOST = re.compile(r"^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$")

def host_only(v):
    t = str(v or "").strip().lower()
    t = re.sub(r"^https?://", "", t).split("/")[0]
    return t if HOST.match(t) and "." in t else ""

def id_from(name):
    t = unicodedata.normalize("NFKD", str(name).lower())
    t = "".join(c for c in t if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "-", t).strip("-")[:31].rstrip("-")

def is_brightspace(host):
    try:
        with urllib.request.urlopen(f"https://{host}/d2l/api/versions/", timeout=15) as r:
            d = json.load(r)
        return isinstance(d, list) and any(isinstance(x, dict) and x.get("ProductCode") == "lp" for x in d)
    except Exception:
        return False

def add(toml_text, sid, name, hosts, domains, db_id):
    m = re.search(r"^SCHOOLS = '(.*)'$", toml_text, re.M)
    cfg = json.loads(m.group(1)) if m else {"default": "usc", "schools": [dict(USC)]}
    for s in cfg["schools"]:
        if s["id"] == sid: raise ValueError(f"a school with the id {sid} is already listed")
        for h in hosts:
            if h in s.get("brightspace", []): raise ValueError(f"{h} is already listed for {s['id']}")
        for d in domains:
            if d in s.get("domains", []): raise ValueError(f"{d} is already listed for {s['id']}")
    cfg["schools"].append({"id": sid, "name": name, "brightspace": hosts, "domains": domains})
    line = "SCHOOLS = '" + json.dumps(cfg, separators=(",", ":"), ensure_ascii=True) + "'"
    if "'" in line[11:-1]: raise ValueError("names cannot contain an apostrophe")
    if m: toml_text = toml_text[:m.start()] + line + toml_text[m.end():]
    else:
        if not re.search(r"^\[vars\]$", toml_text, re.M): raise ValueError("wrangler.toml has no [vars] section")
        toml_text = re.sub(r"^\[vars\]$", lambda _: "[vars]\n# The schools on this site (add-school.py writes this line; see SCHOOLS.md).\n" + line, toml_text, count=1, flags=re.M)
    binding = "DB_" + sid.upper().replace("-", "_")
    toml_text = toml_text.rstrip("\n") + f'\n\n[[d1_databases]]\nbinding = "{binding}"\ndatabase_name = "lockqz-{sid}"\ndatabase_id = "{db_id}"\n'
    return toml_text, binding

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", required=True); ap.add_argument("--id"); ap.add_argument("--brightspace", action="append", required=True)
    ap.add_argument("--domain", action="append", default=[]); ap.add_argument("--no-check", action="store_true")
    ap.add_argument("--db-id"); ap.add_argument("--toml", default=str(Path(__file__).with_name("wrangler.toml")))
    a = ap.parse_args()
    try:
        name = a.name.strip(); sid = (a.id or id_from(name)).lower()
        hosts = [host_only(h) for h in a.brightspace]; domains = [d.strip().lower().lstrip("@") for d in a.domain]
        if not name: raise ValueError("the school needs a name")
        if not re.match(r"^[a-z0-9][a-z0-9-]{0,30}$", sid): raise ValueError("--id: small letters, digits and dashes only")
        if "" in hosts: raise ValueError("--brightspace is the school's Brightspace address (learn.school.edu)")
        if any(not HOST.match(d) or "." not in d for d in domains): raise ValueError("--domain is the part of the school's email addresses after @ (school.edu)")
        if not a.no_check:
            for h in hosts:
                if not is_brightspace(h): raise ValueError(f"{h} does not answer as a Brightspace (use --no-check to add it anyway)")
        p = Path(a.toml); text = p.read_text()
        add(text, sid, name, hosts, domains, "0")   # every refusal comes before a database is created
        db_id = a.db_id
        if not db_id:
            out = subprocess.run(["npx", "wrangler", "d1", "create", f"lockqz-{sid}"], capture_output=True, text=True)
            m = re.search(r'database_id"?\s*[=:]\s*"([0-9a-f-]{36})"', out.stdout + out.stderr)
            if not m: raise ValueError("the database could not be created:\n" + (out.stdout + out.stderr)[-600:])
            db_id = m.group(1)
        text, binding = add(text, sid, name, hosts, domains, db_id)
        p.write_text(text)
        print(f'added school "{sid}" (database lockqz-{sid}, binding {binding}) to {p}\nnow commit and push wrangler.toml: the release sets up its tables and switches it on')
    except ValueError as e:
        print("not added: " + str(e), file=sys.stderr); sys.exit(1)

if __name__ == "__main__":
    main()
