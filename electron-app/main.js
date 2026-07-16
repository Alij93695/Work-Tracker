const { app, Tray, Menu, nativeImage, BrowserWindow, Notification, powerMonitor, powerSaveBlocker, session, desktopCapturer, shell } = require('electron');
const path = require('path');
const fs = require('fs');

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
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
log.init(logsDir);

const settingsFile = path.join(logsDir, 'settings.json');
const settings = Object.assign({ keepAwake: true, launchAtLogin: true }, readJsonSafe(settingsFile, {}));
function saveSettings() {
    try { writeJsonSafe(settingsFile, settings); } catch (e) { log.error('Failed to save settings:', e); }
}

let tray = null;
let dashboardWindow = null;
let tracker = null;
let meetings = null;
let firebaseAdd = null;

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

// ------------- firebase (optional) -------------
function initFirebase() {
    try {
        if (process.env.FIREBASE_API_KEY && !process.env.FIREBASE_API_KEY.includes('paste')) {
            const { initializeApp } = require('firebase/app');
            const { getFirestore, collection, addDoc } = require('firebase/firestore');
            const firebaseApp = initializeApp({
                apiKey: process.env.FIREBASE_API_KEY,
                authDomain: process.env.FIREBASE_AUTH_DOMAIN,
                projectId: process.env.FIREBASE_PROJECT_ID,
            });
            const db = getFirestore(firebaseApp);
            firebaseAdd = (row) => addDoc(collection(db, 'logs'), row);
            log.info('Firebase initialized successfully.');
        }
    } catch (error) {
        log.error('Firebase initialization failed:', error);
    }
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
    dashboardWindow.loadFile(path.join(__dirname, 'dashboard', 'index.html'));
    dashboardWindow.on('closed', () => { dashboardWindow = null; });
}

// ------------- tray -------------
function rebuildTrayMenu() {
    if (!tray) return;
    const meetingActive = meetings && meetings.isActive();
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Open Dashboard', click: createDashboard },
        { type: 'separator' },
        {
            label: meetingActive ? '⏹ Stop Meeting Capture' : '🎙 Start Meeting Capture',
            click: async () => {
                try {
                    if (meetings.isActive()) {
                        await meetings.stop();
                        new Notification({ title: 'Work Tracker', body: 'Meeting capture stopped. Summary is being generated.', icon: trayIconPath }).show();
                    } else {
                        await meetings.start();
                        new Notification({ title: 'Work Tracker', body: 'Meeting capture started — live transcript available on the dashboard.', icon: trayIconPath }).show();
                    }
                } catch (err) {
                    log.error('[Tray] Meeting toggle failed:', err);
                    new Notification({ title: 'Work Tracker', body: `Meeting capture error: ${err.message}`, icon: trayIconPath }).show();
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
    tray.setToolTip(meetingActive ? 'Work Tracker — recording meeting' : 'Work Tracker is running');
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
        callback(permission === 'media'); // mic for meeting capture; deny the rest
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
    app.on('second-instance', () => createDashboard());

    app.whenReady().then(() => {
        log.info(`Work Tracker starting (v${app.getVersion()}, packaged: ${app.isPackaged})`);

        ai.init();
        initFirebase();
        setupMediaHandlers();

        const icon = fs.existsSync(trayIconPath)
            ? nativeImage.createFromPath(trayIconPath).resize({ width: 16, height: 16 })
            : nativeImage.createEmpty();
        tray = new Tray(icon);
        tray.on('double-click', createDashboard);

        meetings = new MeetingManager({ logsDir });

        const exePath = app.isPackaged
            ? path.join(process.resourcesPath, 'ActiveWindow.exe')
            : path.join(__dirname, 'ActiveWindow.exe');
        tracker = new Tracker({
            logsDir,
            exePath,
            powerMonitor,
            firebaseAdd: (row) => (firebaseAdd ? firebaseAdd(row) : Promise.resolve()),
        });
        tracker.start();

        startApiServer({ logsDir, tracker, meetings, getPowerStatus, trayIconPath });

        applyKeepAwake();
        applyLoginItem();
        rebuildTrayMenu();

        // Keep the tray label in sync if a meeting is started/stopped via the API
        setInterval(rebuildTrayMenu, 10000);
    });
}

// Background app: keep running when all windows are closed
app.on('window-all-closed', (e) => {
    e.preventDefault();
});

app.on('before-quit', async () => {
    try { if (tracker) tracker.stop(); } catch (e) { /* shutting down */ }
    try { if (meetings && meetings.isActive()) await meetings.stop(); } catch (e) { /* shutting down */ }
});
