const { desktopCapturer } = require('electron');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require('./logger');
const ai = require('./ai');

/**
 * Capture screen thumbnail using Electron's desktopCapturer.
 * Fallback to PowerShell screen capture if desktopCapturer yields empty sources.
 */
async function captureScreenBase64() {
    try {
        const sources = await desktopCapturer.getSources({
            types: ['screen', 'window'],
            thumbnailSize: { width: 1280, height: 720 }
        });

        if (sources && sources.length > 0) {
            // Find active or primary display source
            const primarySource = sources.find(s => s.id.startsWith('screen:')) || sources[0];
            const pngBuffer = primarySource.thumbnail.toPNG();
            if (pngBuffer && pngBuffer.length > 100) {
                return pngBuffer.toString('base64');
            }
        }
    } catch (err) {
        log.warn('[ScreenScanner] desktopCapturer capture failed, trying fallback:', err.message);
    }

    // PowerShell fallback for capturing screen to base64 PNG
    return new Promise((resolve, reject) => {
        const psScript = `
        Add-Type -AssemblyName System.Windows.Forms, System.Drawing;
        $screen = [System.Windows.Forms.Screen]::PrimaryScreen;
        $bitmap = New-Object System.Drawing.Bitmap $screen.Bounds.Width, $screen.Bounds.Height;
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap);
        $graphics.CopyFromScreen($screen.Bounds.X, $screen.Bounds.Y, 0, 0, $bitmap.Size);
        $ms = New-Object System.IO.MemoryStream;
        $bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png);
        [Convert]::ToBase64String($ms.ToArray());
        $graphics.Dispose();
        $bitmap.Dispose();
        $ms.Dispose();
        `;
        exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/\n/g, ' ')}"`, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
            if (error || !stdout) {
                return reject(new Error('Failed to capture screen via PowerShell: ' + (error ? error.message : 'Empty output')));
            }
            resolve(stdout.trim());
        });
    });
}

/**
 * Analyze screen context using Gemini Multimodal Vision.
 * Detects chat context, WeChat conversations, country trainers, meeting dates & times.
 */
async function analyzeCurrentScreen(trackerSample = null) {
    log.info('[ScreenScanner] Capturing active screen image...');
    const base64Image = await captureScreenBase64();

    const appTitleContext = trackerSample ? `Current Active Window: ${trackerSample.application} - ${trackerSample.title}` : '';

    const promptText = `
You are an intelligent vision assistant for Scribe Work Tracker.
Analyze this screenshot of the user's active computer screen.

${appTitleContext}

Determine what the user is doing. Specifically look for messaging/chat applications like WeChat, Teams, WhatsApp, Slack, Outlook, or web browsers where a conversation or meeting discussion is occurring.

Extract and output ONLY a valid JSON object matching this schema (no markdown, no code fences):
{
  "isChat": true or false,
  "appName": "Name of app (e.g. WeChat, Outlook, Browser)",
  "contactName": "Name or title of the person/country trainer being spoken with (e.g. Country Trainer John, Alex Lin)",
  "topic": "Concise meeting topic or task title (e.g. Country Training Session, Q3 Expansion Review)",
  "proposedDate": "YYYY-MM-DD format (if mentioned or implied, otherwise tomorrow's date)",
  "proposedTime": "HH:MM 24hr format (if mentioned, e.g. 14:00, or default 10:00)",
  "durationMinutes": 30 or 60,
  "summaryText": "1-2 sentence description of what the user is currently doing on screen",
  "confidence": "high", "medium", or "low"
}
`;

    const rawResult = await ai.analyzeImage(base64Image, promptText);
    log.info('[ScreenScanner] Screen Vision analysis complete.');

    try {
        const cleanedJson = String(rawResult).replace(/```(?:json)?/gi, '').trim();
        const parsed = JSON.parse(cleanedJson);
        return {
            raw: rawResult,
            data: parsed,
            capturedAt: new Date().toISOString()
        };
    } catch (e) {
        log.warn('[ScreenScanner] Could not parse vision JSON output:', String(rawResult).slice(0, 200));
        return {
            raw: rawResult,
            data: {
                isChat: false,
                appName: trackerSample?.application || 'Desktop',
                contactName: 'Country Trainer',
                topic: 'Sync Meeting',
                proposedDate: new Date(Date.now() + 86400000).toISOString().split('T')[0],
                proposedTime: '10:00',
                durationMinutes: 30,
                summaryText: String(rawResult).slice(0, 250),
                confidence: 'medium'
            },
            capturedAt: new Date().toISOString()
        };
    }
}

module.exports = {
    captureScreenBase64,
    analyzeCurrentScreen
};
