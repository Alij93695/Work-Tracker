using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Foreground-window reporter.
//   ActiveWindow.exe            -> print current window once and exit (legacy mode)
//   ActiveWindow.exe --watch N  -> print "app|title" every N ms until stdout closes
// Watch mode prints a "~" heartbeat when no window is resolvable so the parent
// process can distinguish "no data" from "watcher died".
class Program
{
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    static string Sample()
    {
        try
        {
            IntPtr handle = GetForegroundWindow();
            if (handle == IntPtr.Zero) return null;

            StringBuilder title = new StringBuilder(512);
            GetWindowText(handle, title, 512);

            uint pid;
            GetWindowThreadProcessId(handle, out pid);
            if (pid == 0) return null;

            string name;
            using (Process process = Process.GetProcessById((int)pid))
            {
                name = process.ProcessName;
            }

            string t = title.ToString().Replace("\r", " ").Replace("\n", " ").Trim();
            if (t.Length == 0) t = name;
            return name + "|" + t;
        }
        catch
        {
            return null;
        }
    }

    static void Main(string[] args)
    {
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }

        bool watch = args.Length > 0 && args[0] == "--watch";
        if (!watch)
        {
            string once = Sample();
            if (once != null) Console.WriteLine(once);
            return;
        }

        int intervalMs = 1000;
        if (args.Length > 1) int.TryParse(args[1], out intervalMs);
        if (intervalMs < 250) intervalMs = 250;

        while (true)
        {
            string line = Sample();
            try
            {
                Console.WriteLine(line ?? "~");
                Console.Out.Flush();
            }
            catch
            {
                // stdout pipe closed -> parent is gone, exit quietly
                return;
            }
            Thread.Sleep(intervalMs);
        }
    }
}
