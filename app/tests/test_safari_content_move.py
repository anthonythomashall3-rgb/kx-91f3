"""Real-browser test of the Content-quiz move on a Mac (Safari by default; pass other browser names to
test them too, e.g. "Google Chrome"). Runs the agent's OWN browser_tabs() + move_content_quizzes()
against a stand-in Brightspace (fake_content_server.py) on 127.0.0.1, then closes the test tabs.

  python3 test_safari_content_move.py [Safari] ["Google Chrome"] ...

Needs a logged-in Mac with the browser installed (not CI): the first run may ask once to let the
terminal control the browser (System Settings -> Privacy & Security -> Automation).
"""
import importlib.util, json, os, subprocess, sys, tempfile, time, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("lqz_agent", os.path.join(HERE, "..", "mac", "lockqz-agent.py"))
agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
moves = []
agent.log = lambda m: moves.append(m)          # never write to the real agent log

import socket
_s = socket.socket(); _s.bind(("127.0.0.1", 0)); PORT = _s.getsockname()[1]; _s.close()   # a free port
tmp = tempfile.mkdtemp(prefix="lqz-move-")
HITS = os.path.join(tmp, "hits.log"); open(HITS, "w").close()
srv = subprocess.Popen([sys.executable, os.path.join(HERE, "fake_content_server.py"), str(PORT), HITS])
time.sleep(1)
BASE = "http://127.0.0.1:%d" % PORT
QUIZ = "/d2l/lms/quizzing/user/quiz_summary.d2l?qi=77&ou=123"
CONTENT_QUIZ = BASE + "/d2l/le/content/123/fullscreen/456/ViewLocation?tId=456&location=" + urllib.parse.quote(QUIZ, safe="")
CONTENT_FILE = BASE + "/d2l/le/content/123/fullscreen/457/ViewLocation?tId=457&location=" + urllib.parse.quote("/d2l/le/content/123/viewContent/457/View", safe="")

fail = 0
def check(ok, what):
    global fail
    print(("  ok   " if ok else "  FAIL ") + what)
    if not ok: fail += 1

def hits(): return open(HITS).read()
def ours(app): return [t for t in agent.browser_tabs() if t[0] == app and "127.0.0.1:%d" % PORT in t[3]]
def close_ours(app):
    js = ('var a=Application(%s);a.windows().forEach(function(w){w.tabs().forEach(function(t){'
          'if((t.url()||"").indexOf("127.0.0.1:%d")>=0)t.close();});});' % (json.dumps(app), PORT))
    try: agent.osa(js)
    except Exception: pass

def watch(app, secs):
    for _ in range(secs):
        time.sleep(1)
        agent.move_content_quizzes(ours(app))

try:
    for app in (sys.argv[1:] or ["Safari"]):
        print("== " + app)
        agent._moved.clear(); del moves[:]
        # 1) a Content page that is not a quiz: left alone
        open(HITS, "w").close()
        subprocess.run(["open", "-a", app, CONTENT_FILE], check=True)
        watch(app, 8)
        check("/fullscreen/457/" in hits(), app + ": the Content page loaded")
        check(not any("fullscreen/457" in m or "457" in m for m in moves), app + ": a non-quiz Content page is left alone")
        t = ours(app); check(bool(t) and all("/fullscreen/457/" in x[3] for x in t), app + ": its address bar is unchanged")
        close_ours(app); time.sleep(1)
        # 2) a quiz opened from Content: moved to its own page, once
        open(HITS, "w").close(); del moves[:]
        subprocess.run(["open", "-a", app, CONTENT_QUIZ], check=True)
        moved_at = None
        for i in range(30):
            watch(app, 1)
            if any("/d2l/lms/quizzing/user/quiz_summary.d2l?qi=77" in t[3] for t in ours(app)): moved_at = i; break
        watch(app, 12)                                    # keep watching: no second move, no reload loop
        tabs = ours(app)
        check("iframe " + QUIZ in hits() or hits().count(QUIZ) >= 1, app + ": the quiz first ran inside the Content frame")
        check(moved_at is not None, app + ": the tab now shows the quiz as its own page (%s)" % [t[3] for t in tabs])
        check(sum("moved to its own page (123-77)" in m for m in moves) == 1, app + ": moved exactly once (%s)" % moves)
        check(hits().count("document " + QUIZ) <= 1 and hits().count(QUIZ) <= 2, app + ": the quiz page loaded once (no reload loop)")
        check(any(agent.is_quiz(agent.inner_url(t[3])) for t in tabs), app + ": the agent still sees the quiz (lock stays on)")
        close_ours(app)
finally:
    srv.terminate()
print(("%d check(s) FAILED" % fail) if fail else "Content-quiz move: all checks passed")
sys.exit(1 if fail else 0)
