using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

class Program
{
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll", SetLastError=true)]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    static void Main(string[] args)
    {
        try
        {
            IntPtr handle = GetForegroundWindow();
            if (handle == IntPtr.Zero) return;

            StringBuilder title = new StringBuilder(256);
            if (GetWindowText(handle, title, 256) > 0)
            {
                uint processId;
                GetWindowThreadProcessId(handle, out processId);
                Process process = Process.GetProcessById((int)processId);
                Console.WriteLine(string.Format("{0}|{1}", process.ProcessName, title));
            }
        }
        catch (Exception) { }
    }
}
