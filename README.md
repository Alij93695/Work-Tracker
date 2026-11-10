# Scribe

**Scribe** (formerly *Work Tracker*) is an intelligent Windows desktop application for **Universal AI Voice Dictation**, **Automated 1-Tab Outlook Meeting Booking**, **Local Meeting Capture & Summarization**, and **Silent Background Activity Tracking**.

---

## 🚀 Key Features

### 🎙️ 1. Universal AI Voice Dictation & Intelligence
- **Works Everywhere You Type**: Pastes AI-cleaned text directly into **Cursor IDE, Notion, Gmail, Google Docs, WhatsApp, Slack, and Terminals** without plugins or browser extensions.
- **Real-Time AI Polish**: Automatically strips filler words ("um", "uh", pauses, false starts) and formats punctuation and capitalization.
- **Backtrack & Intent Parsing**: Resolves mid-sentence mind-changes (*"Let's meet at 2... actually scratch that, 3 PM"* ──► *"Let's meet at 3 PM"*).
- **Developer Syntax Awareness**: Spoken casing (`camelCase`, `snake_case`, `kebab-case`, `PascalCase`), CLI commands (`git commit -m "..."`), and Cursor `@file` tags (`@index.jsx`).
- **Personal Dictionary & Voice Shortcuts**: Store custom terms/jargon (`dictionary.json`) and voice snippets (*"my link"* ──► `https://calendly.com/...`).
- **Global Hotkeys**: **`Ctrl` + `Alt` + `D`** or **`Alt` + `D`**.

### 📅 2. 1-Tab Outlook Meeting Booking & Screen Vision
- **Active Chat Understanding**: Captures WeChat (or any messaging app) chat screenshots and uses Gemini Multimodal Vision API to extract country trainer names, topics, and proposed dates/times.
- **Automated Outlook Window Creation**: Launches and pre-fills an Outlook Appointment/Meeting window via native Windows COM automation.
- **Global Hotkeys**: **`Ctrl` + `Alt` + `M`** or **`F9`**.

### 🔔 3. 15m / 5m Advance Desktop Notifications
- **Smart Upcoming Scheduler**: Monitors tasks and scheduled meetings to fire native Windows desktop alerts at **15 minutes before**, **5 minutes before**, and **at start/due time**.
- **Dashboard Alerts Panel**: Real-time countdown list (`In 12 mins`, `DUE NOW`) for all upcoming items.

### 🎙️ 4. Local Meeting Capture (Dual-Source, No Bot)
- Captures Windows **system loopback audio** (Zoom, Teams, VooV, Meet) mixed with **local microphone** so both sides of the call are captured locally without any external bot joining.
- Real-time offline **Local Open Whisper** transcription (`tiny` engine optimized for laptop efficiency with int8 quantization and 4 CPU threads) + automatic fallback to cloud/Gemini.
- Rolling real-time meeting notes, automatic Executive Summary, Action Items matrix, and copyable follow-up email draft.

### 📊 5. Background Work Tracking & Reliability
- Persistent native window watcher (`ActiveWindow.exe --watch`) tracks foreground applications once per second into local daily CSV logs.
- Watchdog auto-respawn, idle/lock/sleep awareness, keep-awake OS power blocker, and screen-share invisibility protection.

---

## 🏗️ Architecture

```
electron-app/
  main.js               App lifecycle, tray, global hotkeys, power, crash guards
  ActiveWindow.cs/.exe  Native foreground window watcher (--watch streams once/sec)
  src/
    keyboardInjector.js Universal Windows SendKeys / Clipboard text injector
    dictationAi.js      AI speech polish, backtrack resolution, developer syntax
    dictationStore.js   Personal dictionary & voice snippets persistence store
    screenScanner.js    Desktop/window screenshot capture + Gemini Multimodal Vision AI
    outlookManager.js   Windows Outlook COM automation & Outlook Web deep-links
    reminderEngine.js   15m/5m advance upcoming task & meeting notifications
    tracker.js          Persistent watcher + watchdog + idle/lock/sleep handling + CSV
    meetings.js         Meeting capture, transcription queue, summaries
    apiServer.js        Local Express API on http://localhost:3001
    ai.js               Multi-provider AI rotation & fallback chain
frontend/               React Vite dashboard — built into electron-app/dashboard
```

---

## ⚡ Setup & Launch

1. Configure `.env` in `electron-app/.env`:
   ```env
   GEMINI_API_KEY=your_gemini_key
   ```
2. Build frontend and start app:
   ```bash
   cd frontend && npm install && npm run build
   cd ../electron-app && npm install && npm run sync-dashboard && npm start
   ```
3. Rebuild C# native watcher:
   ```bash
   npm run build-watcher
   ```

---

## ⌨️ Global Windows Shortcuts Summary

| Action | Shortcut |
| :--- | :--- |
| **Universal AI Voice Dictation** | `Ctrl` + `Alt` + `D` / `Alt` + `D` |
| **1-Tab Outlook Meeting Booking** | `Ctrl` + `Alt` + `M` / `F9` |
