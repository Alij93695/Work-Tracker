$WshShell = New-Object -comObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("C:\Users\alij9\OneDrive\Desktop\Scribe.lnk")
$Shortcut.TargetPath = "C:\Users\alij9\ScribeApp\Scribe.exe"
$Shortcut.WorkingDirectory = "C:\Users\alij9\ScribeApp"
$Shortcut.Save()
