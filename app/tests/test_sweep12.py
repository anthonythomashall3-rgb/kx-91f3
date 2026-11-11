#!/usr/bin/env python3
"""Bug sweep 12 (11 Nov 2026), the Mac / Linux helper (lockqzd.py), no root, no network:
  H1 a blocklist addition from the server that arrives DURING a quiz is applied to the block in the same step,
     so the helper's "is the whole block in place" check never reports a missing block for it.
  H2 with no quiz running the list is merged and nothing else happens.
  H3 a control request whose token header holds any text (accents, symbols) gets a plain 401.
"""
import importlib.util, io, json, os, sys, tempfile, threading, http.client
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__)); MAC = os.path.join(HERE, "..", "mac")
PASS = FAIL = 0
def check(m, c, extra=""):
    global PASS, FAIL
    if c: PASS += 1; print("  ok:", m)
    else: FAIL += 1; print("  FAIL:", m, extra)

TMP = tempfile.mkdtemp()
bl = os.path.join(TMP, "blocklist.txt")
with open(bl, "w") as f: f.write("# list\nchatgpt.com\nclaude.ai\ngemini.google.com\n")
cfg = os.path.join(TMP, "config.json")
with open(cfg, "w") as f: json.dump({"port": 18797, "api_base": "https://example.invalid/api", "device_id": "mac-sweep12"}, f)
os.environ.update(LOCKQZ_DRYRUN="1", LOCKQZ_CONFIG=cfg, LOCKQZ_BLOCKLIST=bl, LOCKQZ_LOCKFILE=os.path.join(TMP, "active_lock.json"),
                  LOCKQZ_TOKEN_FILE=os.path.join(TMP, "helper.token"), LOCKQZ_TOKEN_DIR=os.path.join(TMP, "tokens"), LOCKQZ_NO_DEVMODE="1")
spec = importlib.util.spec_from_file_location("lockqzd_s12", os.path.join(MAC, "lockqzd.py"))
D = importlib.util.module_from_spec(spec); spec.loader.exec_module(D)

served = ["chatgpt.com", "claude.ai", "gemini.google.com"] + ["ai%d.example.com" % i for i in range(20)] + ["newai.example"]
calls = []
def fake_engine(cmd):
    # what the real engine sees at that moment: the list file, and whether the helper holds its lock
    with open(bl) as f: n = sum(1 for l in f if l.strip() and not l.startswith("#"))
    calls.append((cmd, n, D.LOCK.locked())); return True
D.engine = fake_engine
class Resp(io.BytesIO): status = 200
D.urllib.request.urlopen = lambda *a, **k: Resp(json.dumps({"domains": served}).encode())

D.STATE.update(state="unlocked", quiz_id=None)
D.refresh_blocklist()
with open(bl) as f: have = [l.strip() for l in f if l.strip() and not l.startswith("#")]
check("H2 no quiz running: the served additions are merged into the list, the engine is not run", "newai.example" in have and len(have) == len(served) and calls == [], str(calls))

served.append("another-ai.example")
D.STATE.update(state="locked", quiz_id="500-1")
D.refresh_blocklist()
check("H1 during a quiz the block is re-applied with the new list in the same step (under the helper's lock)",
      calls == [("lock", len(served), True)], str(calls))
calls.clear(); D.refresh_blocklist()
check("H1 an unchanged list does nothing more", calls == [], str(calls))
D.STATE.update(state="unlocked", quiz_id=None)

srv = ThreadingHTTPServer(("127.0.0.1", 0), D.H); port = srv.server_address[1]; D.PORT = port
threading.Thread(target=srv.serve_forever, daemon=True).start()
def req(token):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    c.putrequest("GET", "/status", skip_host=True); c.putheader("Host", "127.0.0.1:%d" % port)
    c.putheader("X-LOCKqz-Token", token); c.endheaders()
    r = c.getresponse(); body = r.read(); c.close(); return r.status, body
try: st, _ = req("caf\xe9-\xfc\xdf".encode("latin-1"))
except Exception as e: st = "no answer: %s" % e
check("H3 a token header with accented text gets a plain 401, not a dropped connection", st == 401, str(st))
st, body = req(D.TOKEN)
check("H3 the real token still works", st == 200 and json.loads(body).get("state") == "unlocked", str(st))
srv.shutdown()

print("\nRESULT: %d passed, %d failed" % (PASS, FAIL)); sys.exit(1 if FAIL else 0)
