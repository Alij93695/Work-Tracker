Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('C:\Users\alij9\.gemini\antigravity\brain\8231ab9b-06c9-4d31-bf4d-b10543d24917\media__1780983342723.jpg')
$img.Save('C:\Users\alij9\OneDrive\Desktop\Personal Dev\Work Tracker\electron-app\tray-icon.png', [System.Drawing.Imaging.ImageFormat]::Png)
$img.Save('C:\Users\alij9\OneDrive\Desktop\Personal Dev\Work Tracker\electron-app\build\icon.png', [System.Drawing.Imaging.ImageFormat]::Png)
$img.Dispose()
