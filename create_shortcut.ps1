$WshShell = New-Object -comObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("C:\Users\alij9\OneDrive\Desktop\Work Tracker.lnk")
$Shortcut.TargetPath = "C:\Users\alij9\WorkTrackerApp\Work Tracker.exe"
$Shortcut.WorkingDirectory = "C:\Users\alij9\WorkTrackerApp"
$Shortcut.Save()
