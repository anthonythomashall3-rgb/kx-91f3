"""A stand-in for Brightspace's Content viewer, for the real-browser tests of the Content-quiz move
(test_windows_content_move.ps1, test_safari_content_move.py).

  /d2l/le/content/123/fullscreen/456/ViewLocation?...&location=<quiz>  -> a page that shows <quiz> in a frame
  /d2l/lms/quizzing/user/quiz_summary.d2l?qi=77&ou=123                  -> the quiz page

Every request is appended to the log file as "<Sec-Fetch-Dest> <path>", so a test can tell the quiz
loaded as the PAGE itself ("document") from the quiz loaded inside the frame ("iframe").
Usage: python fake_content_server.py <port> <logfile> [<certfile> <keyfile>]   (cert/key = HTTPS)
"""
import http.server, ssl, sys, urllib.parse

PORT, LOG = int(sys.argv[1]), sys.argv[2]
CERT = sys.argv[3] if len(sys.argv) > 4 else None
KEY = sys.argv[4] if len(sys.argv) > 4 else None


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        dest = self.headers.get("Sec-Fetch-Dest") or "-"
        with open(LOG, "a") as f:
            f.write("%s %s\n" % (dest, self.path))
        u = urllib.parse.urlsplit(self.path)
        if u.path.startswith("/d2l/le/content/"):
            loc = (urllib.parse.parse_qs(u.query).get("location") or [""])[0]
            body = ("<!doctype html><title>Test Quiz - Test Course - USC Brightspace</title>"
                    "<h1>Content viewer</h1><iframe src='%s' style='width:90%%;height:400px'></iframe>"
                    % loc.replace("'", "%27"))
        elif u.path == "/pwlog":
            self.send_response(204); self.end_headers(); return
        elif u.path.startswith("/d2l/lms/quizzing/user/") and "quiz_start" in u.path:
            # The quiz's start page with its password box. Every change of the box is reported to /pwlog,
            # so a test can tell what really reached the page.
            body = ("<!doctype html><title>Quiz Start - Test Quiz - USC Brightspace</title><h1>Test Quiz</h1>"
                    "<form onsubmit='return false'><label for=p>Password</label> <input id=p type=%s name=p autocomplete=off> "
                    "<label for=t>Notes</label> <input id=t type=text name=t> <button>Start Quiz!</button></form>"
                    "<script>var p=document.getElementById('p'),t=document.getElementById('t');"
                    "function r(k,e){fetch('/pwlog?'+k+'='+encodeURIComponent(e.value))}"
                    "['input','change'].forEach(function(n){p.addEventListener(n,function(){r('pw',p)});t.addEventListener(n,function(){r('text',t)})});"
                    "setInterval(function(){if(p.value)r('poll',p)},1000)</script>"
                    % ("text" if "kind=text" in u.query else "password"))
        elif u.path.startswith("/d2l/lms/quizzing/"):
            body = "<!doctype html><title>Quiz Summary - Test Quiz - USC Brightspace</title><h1>Quiz summary</h1>"
        else:
            self.send_response(404); self.end_headers(); return
        b = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *a):
        pass


s = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H)
if CERT:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)
    s.socket = ctx.wrap_socket(s.socket, server_side=True)
s.serve_forever()
