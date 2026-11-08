using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Reflection;

[assembly: AssemblyTitle("NovaRec")]
[assembly: AssemblyProduct("NovaRec")]
[assembly: AssemblyDescription("NovaRec 启动器")]
[assembly: AssemblyVersion("1.1.0.0")]
[assembly: AssemblyFileVersion("1.1.0.0")]

static class Launcher {
    static string Quote(string s) {
        if (s == null) return "\"\"";
        if (s.Length == 0) return "\"\"";
        if (s.IndexOf(' ') < 0 && s.IndexOf('\t') < 0 && s.IndexOf('"') < 0) return s;
        var sb = new StringBuilder("\"");
        foreach (char c in s) { if (c == '"') sb.Append("\\\""); else sb.Append(c); }
        sb.Append('"');
        return sb.ToString();
    }
    [STAThread]
    static int Main(string[] args) {
        try {
            string self = Process.GetCurrentProcess().MainModule.FileName;
            string dir = Path.GetDirectoryName(self);
            string appExe = Path.Combine(dir, "NovaRecApp.exe");
            if (!File.Exists(appExe)) return 2;
            var sb = new StringBuilder("--no-sandbox");
            foreach (string a in args) sb.Append(' ').Append(Quote(a));
            var psi = new ProcessStartInfo(appExe, sb.ToString());
            psi.WorkingDirectory = dir;
            psi.UseShellExecute = false;
            var p = Process.Start(psi);
            if (p == null) return 3;
            p.WaitForExit();
            return p.ExitCode;
        } catch (Exception ex) {
            try {
                string self = Process.GetCurrentProcess().MainModule.FileName;
                File.AppendAllText(Path.Combine(Path.GetDirectoryName(self), "launcher-error.log"), DateTime.Now.ToString("s") + " " + ex + Environment.NewLine);
            } catch {}
            return 1;
        }
    }
}
