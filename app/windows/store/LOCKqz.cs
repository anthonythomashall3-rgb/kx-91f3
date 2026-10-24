// LOCKqz Store launcher (Microsoft Store / MSIX). Student clicks Get -> Open -> Yes; done forever.
// Runs the bundled payload\install.ps1 elevated (one Windows "Yes" prompt). Plain C# 5 so the
// .NET Framework compiler on every Windows machine builds it: no SDK, no NuGet.
// Flags (CI only): /install  /uninstall  /screenshot <png>
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
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

  [STAThread]
  static int Main(string[] a) {
    if (a.Length > 0 && a[0] == "/install") return Install();
    if (a.Length > 0 && a[0] == "/uninstall") return Uninstall();
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
      main.Click += delegate { if (state == "setup") DoInstall(); else Close(); };
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
    public void ShowAll(string s) {
      state = s; remove.Visible = s == "on";
      if (s == "on") { msg.Text = "LOCKqz is on.\nNothing else to do."; main.Text = "Close"; }
      else if (s == "removed") { msg.Text = "LOCKqz was removed.\nYou can uninstall this app."; main.Text = "Close"; }
      else { msg.Text = "Setting up...\nClick Yes on the Windows prompt."; main.Text = "Set up"; }
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
