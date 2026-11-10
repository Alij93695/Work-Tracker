const { app, Tray, Menu, nativeImage, BrowserWindow, Notification, powerMonitor, powerSaveBlocker, session, desktopCapturer, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

// Optimize Chromium engine for background audio capture and laptop efficiency
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Load environment variables (UserOverride > ExecutableDir > BundledAsar)
try {
    require('dotenv').config({ path: path.join(app.getPath('userData'), 'logs', '.env') });
} catch (e) { /* optional */ }
try {
    require('dotenv').config({ path: path.join(path.dirname(process.execPath), '.env') });
} catch (e) { /* optional */ }
require('dotenv').config({ path: path.join(__dirname, '.env') });

const log = require('./src/logger');
const ai = require('./src/ai');
const { Tracker } = require('./src/tracker');
const { MeetingManager } = require('./src/meetings');
const { DictationManager } = require('./src/dictationManager');
const { startApiServer } = require('./src/apiServer');
const { readJsonSafe, writeJsonSafe } = require('./src/util');

// ------------- crash guards: the tracker must never silently die -------------
process.on('uncaughtException', (err) => {
    try { log.error('[FATAL] Uncaught exception (recovered):', err); } catch (e) { /* last resort */ }
});
process.on('unhandledRejection', (reason) => {
    try { log.error('[FATAL] Unhandled rejection (recovered):', reason); } catch (e) { /* last resort */ }
});

const logsDir = path.join(app.getPath('userData'), 'logs');

// One-time migration: the app used to be named "electron-app" (dev) /
// "Work Tracker" (installed). Copy — never move or delete — all saved data
// (daily CSVs, tasks, summaries, meetings, settings) from the legacy
// locations the first time the renamed app starts.
let migratedFrom = null;
(function migrateLegacyData() {
    try {
        const hasData = fs.existsSync(logsDir) && fs.readdirSync(logsDir).some(f => f.endsWith('.csv'));
        if (hasData) return;
        const appData = app.getPath('appData');
        const legacyDirs = [
            path.join(appData, 'electron-app', 'logs'),
            path.join(appData, 'Work Tracker', 'logs'),
            path.join(appData, 'work-tracker', 'logs'),
        ];
        for (const legacy of legacyDirs) {
            if (path.resolve(legacy) === path.resolve(logsDir)) continue;
            if (!fs.existsSync(legacy)) continue;
            fs.mkdirSync(logsDir, { recursive: true });
            fs.cpSync(legacy, logsDir, { recursive: true, force: false, errorOnExist: false });
            migratedFrom = legacy;
            return;
        }
    } catch (e) {
        console.error('Legacy data migration failed:', e);
    }
})();

if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
log.init(logsDir);
if (migratedFrom) log.info(`[Migration] Copied legacy data from ${migratedFrom} (originals left untouched).`);

const settingsFile = path.join(logsDir, 'settings.json');
const settings = Object.assign({ keepAwake: true, launchAtLogin: true, hideFromScreenShare: true }, readJsonSafe(settingsFile, {}));
function saveSettings() {
    try { writeJsonSafe(settingsFile, settings); } catch (e) { log.error('Failed to save settings:', e); }
}

let tray = null;
let dashboardWindow = null;
let tracker = null;
let meetings = null;
let dictationManager = null;

const trayIconPath = path.join(__dirname, 'tray-icon.png');

// ------------- keep-awake -------------
// Holds a power request through the OS so Windows won't sleep while tracking
// is running. During meetings the MeetingManager additionally blocks display
// sleep. (This is scoped to the app — no system power settings are changed.)
let appSuspensionBlockerId = null;
function applyKeepAwake() {
    if (settings.keepAwake && appSuspensionBlockerId === null) {
        appSuspensionBlockerId = powerSaveBlocker.start('prevent-app-suspension');
        log.info(`[Power] Keep-awake enabled (blocker ${appSuspensionBlockerId}).`);
    } else if (!settings.keepAwake && appSuspensionBlockerId !== null) {
        powerSaveBlocker.stop(appSuspensionBlockerId);
        log.info('[Power] Keep-awake disabled.');
        appSuspensionBlockerId = null;
    }
}
function getPowerStatus() {
    return {
        keepAwake: settings.keepAwake,
        keepAwakeActive: appSuspensionBlockerId !== null && powerSaveBlocker.isStarted(appSuspensionBlockerId),
        meetingDisplayBlocker: !!(meetings && meetings.displayBlocker !== null),
    };
}

// ------------- dashboard window -------------
function createDashboard() {
    if (dashboardWindow) {
        if (dashboardWindow.isMinimized()) dashboardWindow.restore();
        dashboardWindow.focus();
        return;
    }
    dashboardWindow = new BrowserWindow({
        width: 1240,
        height: 860,
        icon: trayIconPath,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: false,
        },
    });
    dashboardWindow.setMenuBarVisibility(false);
    // Invisible to screen shares/recordings (Zoom, Teams, VooV, OBS...):
    // Windows renders the window black/absent in captured frames.
    dashboardWindow.setContentProtection(settings.hideFromScreenShare);
    dashboardWindow.loadFile(path.join(__dirname, 'dashboard', 'index.html'));
    dashboardWindow.on('closed', () => { dashboardWindow = null; });
}

// ------------- tray -------------
function rebuildTrayMenu() {
    if (!tray) return;
    const meetingActive = meetings && meetings.isActive();
    const contextMenu = Menu.buildFromTemplate([
        {
            label: '⚡ 1-Tab Book Outlook Meeting (Ctrl+Alt+M / F9)',
            click: async () => {
                try {
                    await fetch('http://127.0.0.1:3001/api/screen/quick-book', { method: 'POST' });
                } catch (err) {
                    log.error('[Tray] Quick book failed:', err);
                }
            }
        },
        { type: 'separator' },
        {
            label: meetingActive ? '⏹ Stop Meeting Capture' : '🎙 Start Meeting Capture',
            click: async () => {
                try {
                    if (meetings.isActive()) {
                        await meetings.stop();
                        new Notification({ title: 'Scribe', body: 'Meeting capture stopped. Summary is being generated.', icon: trayIconPath }).show();
                    } else {
                        await meetings.start();
                        new Notification({ title: 'Scribe', body: 'Meeting capture started — live transcript available on the dashboard.', icon: trayIconPath }).show();
                    }
                } catch (err) {
                    log.error('[Tray] Meeting toggle failed:', err);
                    new Notification({ title: 'Scribe', body: `Meeting capture error: ${err.message}`, icon: trayIconPath }).show();
                }
                rebuildTrayMenu();
            },
        },
        { type: 'separator' },
        {
            label: 'Keep System Awake',
            type: 'checkbox',
            checked: settings.keepAwake,
            click: (item) => {
                settings.keepAwake = item.checked;
                saveSettings();
                applyKeepAwake();
            },
        },
        {
            label: 'Invisible in Screen Shares',
            type: 'checkbox',
            checked: settings.hideFromScreenShare,
            click: (item) => {
                settings.hideFromScreenShare = item.checked;
                saveSettings();
                if (dashboardWindow) dashboardWindow.setContentProtection(settings.hideFromScreenShare);
            },
        },
        {
            label: 'Launch at Login',
            type: 'checkbox',
            checked: settings.launchAtLogin,
            enabled: app.isPackaged,
            click: (item) => {
                settings.launchAtLogin = item.checked;
                saveSettings();
                applyLoginItem();
            },
        },
        { label: 'Open Logs Folder', click: () => shell.openPath(logsDir) },
        { type: 'separator' },
        { label: 'Quit', click: () => { app.quit(); } },
    ]);
    tray.setContextMenu(contextMenu);
    tray.setToolTip(meetingActive ? 'Scribe — recording meeting' : 'Scribe is running');
}

function applyLoginItem() {
    if (!app.isPackaged) return; // dev runs shouldn't register electron.exe
    try {
        app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, path: process.execPath });
        log.info(`[Startup] Launch at login: ${settings.launchAtLogin}`);
    } catch (err) {
        log.error('[Startup] Failed to set login item:', err);
    }
}

// ------------- media handlers (system loopback audio for meetings) -------------
function setupMediaHandlers() {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        callback(permission === 'media' || permission === 'display-capture');
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
        return permission === 'media' || permission === 'display-capture';
    });
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
        try {
            const sources = await desktopCapturer.getSources({ types: ['screen'] });
            if (sources.length > 0) {
                // audio:'loopback' = Windows system audio (what the speakers play)
                callback({ video: sources[0], audio: 'loopback' });
                return;
            }
        } catch (err) {
            log.error('[Media] Display media handler failed:', err);
        }
        try { callback({}); } catch (e) { /* denied */ }
    });
}

// ------------- app lifecycle -------------
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine) => {
        // A keepalive relaunch (scheduled task) just confirms we're alive —
        // don't pop the dashboard for it. Real user launches open it.
        if (commandLine && commandLine.includes('--keepalive')) return;
        createDashboard();
    });

    app.whenReady().then(() => {
        log.info(`Scribe starting (v${app.getVersion()}, packaged: ${app.isPackaged})`);

        ai.init();
        setupMediaHandlers();

        const icon = fs.existsSync(trayIconPath)
            ? nativeImage.createFromPath(trayIconPath).resize({ width: 16, height: 16 })
            : nativeImage.createEmpty();
        tray = new Tray(icon);
        tray.on('double-click', createDashboard);

        meetings = new MeetingManager({ logsDir });
        dictationManager = new DictationManager({ trayIconPath, logsDir });

        const exePath = app.isPackaged
            ? path.join(process.resourcesPath, 'ActiveWindow.exe')
            : path.join(__dirname, 'ActiveWindow.exe');
        tracker = new Tracker({
            logsDir,
            exePath,
            powerMonitor,
        });
        tracker.start();

        applyKeepAwake();
        applyLoginItem();
        rebuildTrayMenu();

        // Automatically open the Scribe Dashboard window on app startup
        createDashboard();

        startApiServer({ logsDir, tracker, meetings, getPowerStatus, trayIconPath, createDashboard });

        // Register Global Hotkeys for 1-Tab Outlook Meeting Booking
        const hotkeys = ['Ctrl+Alt+M', 'Ctrl+Shift+M', 'Alt+Shift+M', 'F9'];
        const runQuickBook = async (key) => {
            log.info(`[Hotkey] ${key} triggered! Executing 1-Tab Outlook Meeting Booking...`);
            try {
                new Notification({
                    title: `⚡ 1-Tab Hotkey (${key})`,
                    body: 'Scanning WeChat/Screen & opening Outlook meeting window...',
                    icon: trayIconPath
                }).show();
            } catch (e) { /* ignore */ }

            try {
                const res = await fetch('http://127.0.0.1:3001/api/screen/quick-book', { method: 'POST' });
                const data = await res.json();
                log.info('[Hotkey] Quick book result:', data);
            } catch (err) {
                log.error('[Hotkey] Quick book error:', err);
                try {
                    new Notification({
                        title: '❌ Quick Book Error',
                        body: err.message,
                        icon: trayIconPath
                    }).show();
                } catch (e) { /* ignore */ }
            }
        };

        hotkeys.forEach(key => {
            try {
                const registered = globalShortcut.register(key, () => runQuickBook(key));
                log.info(`[Hotkey] Registered ${key}: ${registered}`);
            } catch (err) {
                log.warn(`[Hotkey] Could not register ${key}:`, err.message);
            }
        });

        // Register Global Hotkeys for Universal Voice Dictation (Ctrl+Alt+D / Alt+D)
        const dictationKeys = ['Ctrl+Alt+D', 'Alt+D'];
        dictationKeys.forEach(key => {
            try {
                const ret = globalShortcut.register(key, () => {
                    log.info(`[Hotkey] Universal Dictation ${key} triggered!`);
                    if (dictationManager) {
                        dictationManager.toggle();
                    }
                });
                log.info(`[Hotkey] Registered Dictation ${key}: ${ret}`);
            } catch (err) {
                log.warn(`[Hotkey] Could not register Dictation ${key}:`, err.message);
            }
        });

        // Keep the tray label in sync if a meeting is started/stopped via the API
        setInterval(rebuildTrayMenu, 10000);
    });
}

// Background app: keep running when all windows are closed
app.on('window-all-closed', (e) => {
    e.preventDefault();
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

app.on('before-quit', async () => {
    try { if (tracker) tracker.stop(); } catch (e) { /* shutting down */ }
    try { if (meetings && meetings.isActive()) await meetings.stop(); } catch (e) { /* shutting down */ }
});
