Add-Type @"
  using System;
  using System.Runtime.InteropServices;
  using System.Text;
  public class Win32 {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll", SetLastError=true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  }
"@

$hwnd = [Win32]::GetForegroundWindow()
if ($hwnd -eq 0) {
    $result = @{ title = "Unknown"; app = "Unknown" }
    $result | ConvertTo-Json -Compress
    exit
}

$title = New-Object System.Text.StringBuilder 256
[Win32]::GetWindowText($hwnd, $title, 256) | Out-Null
$processId = 0
[Win32]::GetWindowThreadProcessId($hwnd, [ref]$processId) | Out-Null
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue

$result = @{
    title = $title.ToString()
    app = if ($process) { $process.ProcessName } else { "Unknown" }
}

$result | ConvertTo-Json -Compress
