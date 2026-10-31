// LOCKqz Store launcher (Microsoft Store / MSIX). Student clicks Get -> Open -> Yes; done forever.
// Runs the bundled payload\install.ps1 elevated (one Windows "Yes" prompt). Plain C# 5 so the
// .NET Framework compiler on every Windows machine builds it: no SDK, no NuGet.
// "Test it now": the installed helper blocks AI for 2 minutes exactly as during a quiz (no account needed),
// so anyone - Microsoft's reviewers, a student before an exam - can see it work.
// Flags (CI only): /install  /uninstall  /screenshot <png>  /test <secs>
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

static class LOCKqz {
  static readonly Color Usc = Color.FromArgb(153, 0, 0);
  static string Payload { get { return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "payload"); } }
  static string Dest { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "LOCKqz"); } }
  static bool Installed { get { return File.Exists(Path.Combine(Dest, "config.json")) && File.Exists(Path.Combine(Dest, "lockqzd.ps1")); } }

  static string StorePackage() {
    string f = Path.Combine(Payload, "store_package.txt");
    return File.Exists(f) ? File.ReadAllText(f).Trim() : "";
  }

  // Returns the script's exit code; -2 when the student said No to the Windows prompt.
  static int Elevated(string script, string args) {
    var psi = new ProcessStartInfo("powershell.exe",
      "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + script + "\" " + args);
    psi.UseShellExecute = true; psi.Verb = "runas"; psi.WindowStyle = ProcessWindowStyle.Hidden;
    try { var p = Process.Start(psi); p.WaitForExit(); return p.ExitCode; }
    catch (Win32Exception) { return -2; }
  }

  static int Install() {
    string token = "lqz-" + Guid.NewGuid().ToString("N").Substring(0, 20);
    string pkg = StorePackage();
    string args = "-Token " + token + " -Api https://lockqz.pages.dev/api" + (pkg.Length > 0 ? " -StorePackage " + pkg : "");
    return Elevated(Path.Combine(Payload, "install.ps1"), args);
  }

  static int Uninstall() { return Elevated(Path.Combine(Dest, "uninstall.ps1"), ""); }

  // The installed helper's loopback API, with the token the LOCKqz agent reads from the same config.json.
  // -> the JSON answer (null when the helper is not reachable); code = HTTP status (0 = no answer).
  static string Helper(string path, string body, int timeoutMs, out int code) {
    code = 0;
    try {
      string cfg = File.ReadAllText(Path.Combine(Dest, "config.json"));
      string token = Regex.Match(cfg, "\"token\"\\s*:\\s*\"([^\"]+)\"").Groups[1].Value;
      Match pm = Regex.Match(cfg, "\"port\"\\s*:\\s*(\\d+)");
      var rq = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + (pm.Success ? pm.Groups[1].Value : "8787") + path);
      rq.Proxy = null; rq.Timeout = timeoutMs; rq.ReadWriteTimeout = timeoutMs;
      rq.Headers["X-LOCKqz-Token"] = token;
      if (body != null) {
        rq.Method = "POST"; rq.ContentType = "application/json";
        byte[] b = Encoding.UTF8.GetBytes(body); rq.ContentLength = b.Length;
        using (Stream s = rq.GetRequestStream()) s.Write(b, 0, b.Length);
      }
      HttpWebResponse r;
      try { r = (HttpWebResponse)rq.GetResponse(); }
      catch (WebException e) { r = e.Response as HttpWebResponse; if (r == null) return null; }
      using (r) {
        code = (int)r.StatusCode;
        using (var sr = new StreamReader(r.GetResponseStream())) return sr.ReadToEnd();
      }
    } catch { return null; }
  }

  // One value from the helper's flat JSON answer ("" when absent).
  static string Field(string json, string key) {
    if (json == null) return "";
    Match m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*(?:\"([^\"]*)\"|([-0-9.]+|true|false|null))");
    return !m.Success ? "" : (m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value);
  }

  // CI: start a test lock of <secs>, print the helper's answer, exit 0 when it is running.
  static int TestCli(string secs) {
    int code; string r = Helper("/test", "{\"secs\":" + secs + "}", 120000, out code);
    Console.WriteLine(code + " " + r);
    return (code == 200 && Field(r, "state") == "test") ? 0 : 1;
  }

  [STAThread]
  static int Main(string[] a) {
    if (a.Length > 0 && a[0] == "/install") return Install();
    if (a.Length > 0 && a[0] == "/uninstall") return Uninstall();
    if (a.Length > 1 && a[0] == "/test") return TestCli(a[1]);
    Application.EnableVisualStyles();
    if (a.Length > 1 && a[0] == "/screenshot") { Shot(a[1]); return 0; }
    var f = new Win();
    f.Shown += delegate { if (!Installed) f.DoInstall(); };
    Application.Run(f);
    return 0;
  }

  static void Shot(string path) {
    var f = new Win(); f.ShowAll("on");
    f.CreateControl(); f.Show(); Application.DoEvents();
    var b = new Bitmap(f.Width, f.Height); f.DrawToBitmap(b, new Rectangle(0, 0, f.Width, f.Height));
    var c = new Bitmap(1366, 768);
    using (var g = Graphics.FromImage(c)) {
      g.Clear(Color.FromArgb(240, 240, 240));
      g.DrawImage(b, (1366 - b.Width) / 2, (768 - b.Height) / 2);
    }
    c.Save(path, ImageFormat.Png); f.Close();
  }

  class Win : Form {
    Label title = new Label(), msg = new Label();
    Button main = new Button(), remove = new Button();
    public Win() {
      Text = "LOCKqz"; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false;
      StartPosition = FormStartPosition.CenterScreen; ClientSize = new Size(420, 230); BackColor = Color.White;
      Font = new Font("Segoe UI", 10f);
      try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
      title.Text = "LOCKqz"; title.ForeColor = Usc; title.Font = new Font("Segoe UI", 26f, FontStyle.Bold);
      title.TextAlign = ContentAlignment.MiddleCenter; title.SetBounds(0, 18, 420, 56);
      msg.TextAlign = ContentAlignment.MiddleCenter; msg.SetBounds(20, 80, 380, 60);
      main.SetBounds(130, 150, 160, 38); main.BackColor = Usc; main.ForeColor = Color.White;
      main.FlatStyle = FlatStyle.Flat; main.Font = new Font("Segoe UI", 10.5f, FontStyle.Bold);
      remove.SetBounds(150, 196, 120, 26); remove.Text = "Remove LOCKqz"; remove.FlatStyle = FlatStyle.Flat;
      remove.ForeColor = Color.Gray; remove.FlatAppearance.BorderSize = 0; remove.Font = new Font("Segoe UI", 8.5f);
      main.Click += delegate {
        if (state == "setup") DoInstall();
        else if (state == "on") StartTest();
        else if (state == "testing") StopTest();
        else Close();
      };
      tick.Interval = 1000;
      tick.Tick += delegate {
        left--;
        if (left > 0) { msg.Text = TestText(left); return; }
        tick.Stop(); AwaitEnd();
      };
      FormClosing += delegate { tick.Stop(); };
      remove.Click += delegate {
        if (MessageBox.Show(this, "Remove LOCKqz from this computer?", "LOCKqz", MessageBoxButtons.YesNo) != DialogResult.Yes) return;
        int r = Uninstall();
        if (r == 0 && !Installed) { ShowAll("removed"); } else if (r == -2) { msg.Text = "Click Yes on the Windows prompt to remove LOCKqz."; }
        else msg.Text = "Could not remove LOCKqz (code " + r + "). Try again.";
      };
      Controls.AddRange(new Control[] { title, msg, main, remove });
      ShowAll(Installed ? "on" : "setup");
    }
    string state = "setup";
    System.Windows.Forms.Timer tick = new System.Windows.Forms.Timer();
    int left = 0;
    public void ShowAll(string s) {
      state = s; remove.Visible = s == "on"; main.Enabled = true;
      if (s == "on") { msg.Text = "LOCKqz is on.\nAI turns off only during your quizzes."; main.Text = "Test it now"; }
      else if (s == "testing") { msg.Text = TestText(left); main.Text = "Stop test"; }
      else if (s == "removed") { msg.Text = "LOCKqz was removed.\nYou can uninstall this app."; main.Text = "Close"; }
      else { msg.Text = "Setting up...\nClick Yes on the Windows prompt."; main.Text = "Set up"; }
    }
    static string TestText(int s) { return "AI is off for " + (s / 60) + ":" + (s % 60).ToString("00") + ".\nTry chatgpt.com: it won't open."; }
    void Bg(ThreadStart f) { var t = new Thread(f); t.IsBackground = true; t.Start(); }
    void Ui(MethodInvoker f) { try { if (IsHandleCreated && !IsDisposed) BeginInvoke(f); } catch (InvalidOperationException) { } }
    void StartTest() {
      main.Enabled = false; remove.Visible = false; msg.Text = "Turning AI off..."; Refresh();
      Bg(delegate {
        int code; string r = Helper("/test", "{\"secs\":120}", 120000, out code);
        Ui(delegate {
          int n;
          if (code == 200 && Field(r, "state") == "test") { left = int.TryParse(Field(r, "secs"), out n) ? n : 120; ShowAll("testing"); tick.Start(); }
          else { ShowAll("on"); msg.Text = code == 409 ? "A quiz is running.\nAI comes back when it ends." : "LOCKqz is starting.\nTry again in a minute."; }
        });
      });
    }
    void StopTest() {
      tick.Stop(); main.Enabled = false; msg.Text = "Turning AI back on..."; Refresh();
      Bg(delegate {
        int code; Helper("/test", "{\"stop\":true}", 120000, out code);
        Ui(delegate { ShowAll("on"); msg.Text = "Test done. AI is back on."; });
      });
    }
    void AwaitEnd() {
      // The helper ends the test by itself (within a few seconds of 0:00): wait for it to say so.
      main.Enabled = false; msg.Text = "Turning AI back on...";
      Bg(delegate {
        string st = ""; int code;
        for (int i = 0; i < 40; i++) { st = Field(Helper("/status", null, 5000, out code), "state"); if (st != "test") break; Thread.Sleep(1000); }
        Ui(delegate {
          ShowAll("on");
          if (st == "unlocked") msg.Text = "Test done. AI is back on.";
          else if (st == "locked" || st == "locking") msg.Text = "A quiz is running.\nAI comes back when it ends.";
          else msg.Text = "AI comes back in a moment.";
        });
      });
    }
    public void DoInstall() {
      ShowAll("setup"); main.Enabled = false; Refresh();
      // Run setup off the window thread so the window never shows "Not responding".
      var t = new System.Threading.Thread(delegate () {
        int r = Install();
        BeginInvoke((MethodInvoker)delegate {
          main.Enabled = true;
          if (r == 0 && Installed) ShowAll("on");
          else if (r == -2) msg.Text = "Click Set up, then Yes on the Windows prompt.";
          else msg.Text = "Setup did not finish (code " + r + ").\nClick Set up to try again.";
        });
      });
      t.SetApartmentState(System.Threading.ApartmentState.STA); t.IsBackground = true; t.Start();
    }
  }
}
