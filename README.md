# Scribe

Scribe is a Windows desktop app that silently tracks your work in the background and
listens to your meetings locally — no bot ever joins your calls, and your microphone stays off.

## Features

- **Background work tracking** — a persistent native watcher streams the foreground window
  once per second; the app logs window switches to daily CSV files and never silently dies
  (watchdog + auto-respawn, crash guards, idle/lock/sleep awareness).
- **Meetings (listen-only, no bot)** — captures Windows **system loopback audio** (whatever
  you hear in Zoom/Teams/VooV/Meet) locally on your PC. The microphone is never opened and
  the meeting app cannot detect the capture. Live transcripts stream to the dashboard every
  ~20 seconds; stopping generates an AI summary plus **suggested tasks that are only added
  to your task list after you approve them**.
- **AI insights** — daily smart summaries, morning action plans, and a chat assistant over
  your activity data (Gemini, with multi-key rotation and model fallback).
- **Tasks & reminders** — manual task list with desktop notification reminders.
- **Keep-awake** — while tracking (and especially during meetings) the app holds an OS power
  request so the laptop doesn't sleep mid-capture. Toggle from the tray menu.
- **Invisible in screen shares** — the dashboard uses Windows content protection, so it is
  excluded from Zoom/Teams/OBS screen captures (tray toggle).

## Architecture

```
electron-app/
  main.js               App lifecycle: tray, windows, power, crash guards
  ActiveWindow.cs/.exe  Native foreground-window watcher (--watch mode streams once/sec)
  src/
    tracker.js          Persistent watcher + watchdog + idle/lock/sleep handling + CSV
    meetings.js         Meeting sessions: capture window, transcription queue, summaries
    apiServer.js        Local Express API on http://localhost:3001
    ai.js               Gemini client: key rotation + model fallback (text + audio)
    logger.js           Rotating file logger (userData/logs/app.log)
    util.js             Local-time helpers, atomic JSON read/write
  capture/
    capture.html/.js    Hidden window: system loopback → 16kHz WAV chunks → main process
frontend/               React dashboard (Vite) — built into electron-app/dashboard
```

Data lives in `%APPDATA%/scribe/logs/` (dev) or `%APPDATA%/Scribe/logs/` (installed). On
first run Scribe copies (never deletes) legacy data from the old `electron-app`/`Work Tracker`
folders — daily `yyyy-MM-dd.csv` activity logs,
`meetings/*.json`, `tasks.json`, `summaries.json`, `settings.json`, `app.log`.

## Setup

1. `electron-app/.env` — Gemini keys (already configured):
   ```
   GEMINI_API_KEY=...
   GEMINI_API_KEYS=key1,key2
   ```
2. Install and run:
   ```
   cd frontend && npm install && npm run build
   cd ../electron-app && npm install && npm run sync-dashboard && npm start
   ```
3. Rebuild the native watcher after editing `ActiveWindow.cs`:
   ```
   npm run build-watcher
   ```
4. Package the installer: `npm run build` (electron-builder, NSIS).

## Meetings — how it works

1. Start capture from the tray menu or the dashboard's **Meetings** tab (before or during a call).
2. A hidden window captures system loopback audio only (mic stays off) via WebAudio at
   16 kHz mono and emits ~20-second WAV chunks. Silent chunks are dropped locally.
3. The main process transcribes each chunk with Gemini and appends segments to the live
   transcript (visible in the dashboard within ~20–40 s of speech).
4. Stop capture → remaining chunks finish transcribing → a Markdown summary (Summary,
   Key Points, Decisions, Action Items) is generated automatically, plus suggested tasks
   you can approve or dismiss. Everything is stored locally in `meetings/<id>.json`.

## Reliability design

- One persistent watcher process instead of spawning a new process every 2 s.
- Watchdog respawns the watcher (with backoff) if it exits or goes quiet for 45 s.
- `powerMonitor` marks `(Idle)`, `(Locked)`, `(Suspended)` periods so durations stay honest.
- Timestamps and file names use **local time** (the old UTC scheme put early-morning
  activity in the previous day's file).
- `uncaughtException`/`unhandledRejection` are logged and recovered, never fatal.
- Express port conflicts retry; JSON files are written atomically (temp + rename).
- `powerSaveBlocker` keeps the machine awake while tracking; display-sleep is additionally
  blocked during meetings.
