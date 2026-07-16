const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { createObjectCsvWriter } = require('csv-writer');
const log = require('./logger');
const { localDateStr, localTimestamp } = require('./util');

const IDLE_THRESHOLD_SECONDS = 300;   // 5 min without input → "(Idle)"
const WATCHDOG_INTERVAL_MS = 15000;
const STALE_AFTER_MS = 45000;         // no watcher output for 45s → respawn
const MAX_RESPAWN_DELAY_MS = 15000;

// Reliable foreground-window tracker.
//
// The old design spawned ActiveWindow.exe from scratch every 2 seconds —
// thousands of process launches per day, each one a chance for AV interference,
// handle exhaustion, or a silent failure that stopped tracking entirely.
//
// The new design spawns ONE persistent watcher process (ActiveWindow.exe
// --watch) that streams the foreground window once per second. A watchdog
// respawns it with backoff if it dies or goes quiet, and Electron's
// powerMonitor marks idle/lock/sleep periods so durations stay honest.
class Tracker {
    constructor({ logsDir, exePath, powerMonitor, firebaseAdd = null }) {
        this.logsDir = logsDir;
        this.exePath = exePath;
        this.powerMonitor = powerMonitor;
        this.firebaseAdd = firebaseAdd;
        this.firebaseFailures = 0;

        this.proc = null;
        this.stopping = false;
        this.lastLineAt = 0;
        this.respawnDelay = 1000;
        this.respawnTimer = null;
        this.watchdogTimer = null;

        this.state = 'active'; // active | idle | locked | suspended
        this.lastLogged = null; // { application, title }
        this.lastSample = null;
        this.writeQueue = Promise.resolve();
        this.startedAt = null;
    }

    start() {
        this.startedAt = Date.now();
        this.hookPowerEvents();
        this.spawnWatcher();
        this.watchdogTimer = setInterval(() => this.checkHealth(), WATCHDOG_INTERVAL_MS);
        log.info('[Tracker] Started.');
    }

    stop() {
        this.stopping = true;
        if (this.watchdogTimer) clearInterval(this.watchdogTimer);
        if (this.respawnTimer) clearTimeout(this.respawnTimer);
        this.killWatcher();
        log.info('[Tracker] Stopped.');
    }

    hookPowerEvents() {
        const pm = this.powerMonitor;
        pm.on('lock-screen', () => this.enterState('locked', '(Locked)', 'Screen locked'));
        pm.on('unlock-screen', () => this.exitToActive('unlock'));
        pm.on('suspend', () => this.enterState('suspended', '(Suspended)', 'System sleeping'));
        pm.on('resume', () => this.exitToActive('resume'));
    }

    enterState(state, application, title) {
        if (this.state === state) return;
        log.info(`[Tracker] State → ${state}`);
        this.state = state;
        this.record(application, title);
    }

    exitToActive(reason) {
        if (this.state === 'active') return;
        log.info(`[Tracker] State → active (${reason})`);
        this.state = 'active';
        this.lastLogged = null; // force the next sample to be recorded
    }

    spawnWatcher() {
        this.killWatcher();
        if (this.stopping) return;

        if (!fs.existsSync(this.exePath)) {
            log.error(`[Tracker] Watcher binary missing: ${this.exePath}`);
            return;
        }

        try {
            this.proc = spawn(this.exePath, ['--watch', '1000'], {
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true,
            });
        } catch (err) {
            log.error('[Tracker] Failed to spawn watcher:', err);
            this.scheduleRespawn();
            return;
        }

        this.lastLineAt = Date.now();
        const rl = readline.createInterface({ input: this.proc.stdout });
        rl.on('line', (line) => this.onLine(line));

        this.proc.on('error', (err) => log.error('[Tracker] Watcher process error:', err));
        this.proc.on('close', (code) => {
            this.proc = null;
            if (!this.stopping) {
                log.warn(`[Tracker] Watcher exited (code ${code}), respawning...`);
                this.scheduleRespawn();
            }
        });

        log.info('[Tracker] Watcher process spawned.');
    }

    killWatcher() {
        if (this.proc) {
            try { this.proc.kill(); } catch (e) { /* already dead */ }
            this.proc = null;
        }
    }

    scheduleRespawn() {
        if (this.stopping || this.respawnTimer) return;
        const delay = this.respawnDelay;
        this.respawnDelay = Math.min(this.respawnDelay * 2, MAX_RESPAWN_DELAY_MS);
        this.respawnTimer = setTimeout(() => {
            this.respawnTimer = null;
            this.spawnWatcher();
        }, delay);
    }

    checkHealth() {
        if (this.stopping) return;
        if (!this.proc || (Date.now() - this.lastLineAt) > STALE_AFTER_MS) {
            log.warn('[Tracker] Watchdog: watcher stale or dead, respawning...');
            this.spawnWatcher();
        }
    }

    onLine(line) {
        this.lastLineAt = Date.now();
        this.respawnDelay = 1000; // healthy output → reset backoff

        if (line === '~' || !line) return;
        if (this.state === 'locked' || this.state === 'suspended') return;

        // Idle detection: no keyboard/mouse input for 5 minutes
        let idleSeconds = 0;
        try { idleSeconds = this.powerMonitor.getSystemIdleTime(); } catch (e) { /* pre-ready */ }
        if (idleSeconds >= IDLE_THRESHOLD_SECONDS) {
            this.enterState('idle', '(Idle)', 'Away from computer');
            return;
        }
        if (this.state === 'idle') this.exitToActive('input');

        const pipeIndex = line.indexOf('|');
        if (pipeIndex <= 0) return;
        const application = line.substring(0, pipeIndex).trim() || 'Unknown';
        const title = line.substring(pipeIndex + 1).trim() || 'Unknown';

        this.lastSample = { application, title, at: Date.now() };

        if (!this.lastLogged || this.lastLogged.application !== application || this.lastLogged.title !== title) {
            this.record(application, title);
        }
    }

    record(application, title) {
        this.lastLogged = { application, title };
        const row = { timestamp: localTimestamp(), application, title };

        // Serialize CSV writes so concurrent appends can't interleave
        this.writeQueue = this.writeQueue
            .then(() => this.appendCsv(row))
            .catch(err => log.error('[Tracker] CSV write failed:', err));

        if (this.firebaseAdd && this.firebaseFailures < 20) {
            this.firebaseAdd(row).then(() => {
                this.firebaseFailures = 0;
            }).catch(err => {
                this.firebaseFailures++;
                if (this.firebaseFailures === 1 || this.firebaseFailures === 20) {
                    log.warn(`[Tracker] Firebase sync failing (${this.firebaseFailures}x):`, err.message);
                    if (this.firebaseFailures >= 20) log.warn('[Tracker] Firebase sync disabled until restart.');
                }
            });
        }
    }

    appendCsv(row) {
        const logFilePath = path.join(this.logsDir, `${localDateStr()}.csv`);
        const writer = createObjectCsvWriter({
            path: logFilePath,
            header: [
                { id: 'timestamp', title: 'Timestamp' },
                { id: 'application', title: 'Application' },
                { id: 'title', title: 'Title' },
            ],
            append: fs.existsSync(logFilePath),
        });
        return writer.writeRecords([row]);
    }

    getStatus() {
        return {
            running: !!this.proc,
            state: this.state,
            lastSample: this.lastSample,
            lastSampleAgoMs: this.lastLineAt ? Date.now() - this.lastLineAt : null,
            startedAt: this.startedAt,
        };
    }
}

module.exports = { Tracker };
