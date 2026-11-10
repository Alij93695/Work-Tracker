const { BrowserWindow, ipcMain, Notification } = require('electron');
const path = require('path');
const log = require('./logger');
const whisperEngine = require('./whisperEngine');
const dictationAi = require('./dictationAi');
const DictationStore = require('./dictationStore');
const keyboardInjector = require('./keyboardInjector');

class DictationManager {
    constructor({ trayIconPath, logsDir }) {
        this.trayIconPath = trayIconPath;
        this.logsDir = logsDir;
        this.dictationStore = new DictationStore({ logsDir });
        this.isRecording = false;
        this.isProcessing = false;
        this.win = null;
        this.timeoutTimer = null;

        ipcMain.on('dictation:audio-ready', (event, { audioBase64 }) => {
            this.handleAudioReady(audioBase64);
        });

        ipcMain.on('dictation:error', (event, err) => {
            log.error('[DictationManager] Recording error:', err);
            this.cleanup();
            try {
                new Notification({
                    title: '🎙 Dictation Error',
                    body: `Could not record audio: ${err}`,
                    icon: this.trayIconPath
                }).show();
            } catch (e) {}
        });

        ipcMain.on('dictation:log', (event, msg) => {
            log.info('[Dictation/renderer]', msg);
        });
    }

    async toggle() {
        if (this.isProcessing) {
            log.info('[DictationManager] Currently processing dictation, ignoring toggle.');
            return;
        }

        if (this.isRecording) {
            await this.stopAndInject();
        } else {
            await this.startRecording();
        }
    }

    async startRecording() {
        this.isRecording = true;
        log.info('[DictationManager] Starting voice dictation recording...');

        if (this.win) {
            try { this.win.destroy(); } catch (e) {}
            this.win = null;
        }

        this.win = new BrowserWindow({
            show: false,
            skipTaskbar: true,
            webPreferences: {
                preload: path.join(__dirname, '..', 'capture', 'dictation-preload.js'),
                backgroundThrottling: false,
                contextIsolation: true,
                nodeIntegration: false,
            },
        });

        this.win.on('closed', () => { this.win = null; });
        await this.win.loadFile(path.join(__dirname, '..', 'capture', 'dictation.html'));

        // Play start notification
        try {
            new Notification({
                title: '🎙️ Scribe Dictation: Listening...',
                body: 'Speak now. Press Ctrl+Alt+D or Alt+D again when finished to paste.',
                icon: this.trayIconPath,
                silent: false
            }).show();
        } catch (e) {}

        // Auto-stop after 45 seconds max so it doesn't run forever if forgotten
        if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
        this.timeoutTimer = setTimeout(() => {
            if (this.isRecording) {
                log.info('[DictationManager] Auto-stopping dictation recording after 45s timeout.');
                this.stopAndInject();
            }
        }, 45000);
    }

    async stopAndInject() {
        if (!this.isRecording) return;
        this.isRecording = false;
        this.isProcessing = true;
        if (this.timeoutTimer) clearTimeout(this.timeoutTimer);

        log.info('[DictationManager] Stopping voice dictation and transcribing...');

        if (this.win && !this.win.isDestroyed()) {
            this.win.webContents.send('dictation:stop-capture');
        } else {
            this.cleanup();
            this.isProcessing = false;
        }
    }

    async handleAudioReady(audioBase64) {
        try {
            this.cleanup();
            if (!audioBase64) {
                log.warn('[DictationManager] No audio data received.');
                this.isProcessing = false;
                return;
            }

            log.info('[DictationManager] Transcribing dictation audio with Whisper...');
            const wRes = await whisperEngine.transcribe(audioBase64);
            const rawSpeech = (wRes.text || '').replace(/\[SILENCE\]/g, '').trim();

            if (!rawSpeech) {
                log.info('[DictationManager] No speech detected in audio.');
                try {
                    new Notification({
                        title: '🎙 Dictation',
                        body: 'No speech detected.',
                        icon: this.trayIconPath
                    }).show();
                } catch (e) {}
                this.isProcessing = false;
                return;
            }

            log.info(`[DictationManager] Raw speech: "${rawSpeech}" -> Polishing with AI...`);
            const dictionary = this.dictationStore.getDictionary();
            const snippets = this.dictationStore.getSnippets();
            const settings = this.dictationStore.getSettings();

            const processed = await dictationAi.processDictation(rawSpeech, {
                dictionary,
                snippets,
                ...settings
            });

            const finalPastedText = processed.text || rawSpeech;
            log.info(`[DictationManager] Polished text: "${finalPastedText}" -> Injecting into active window...`);

            await keyboardInjector.injectText(finalPastedText);

            try {
                new Notification({
                    title: '✅ Scribe Dictated & Injected',
                    body: `"${finalPastedText.slice(0, 100)}${finalPastedText.length > 100 ? '...' : ''}"`,
                    icon: this.trayIconPath
                }).show();
            } catch (e) {}

        } catch (err) {
            log.error('[DictationManager] Failed to process dictation:', err);
            try {
                new Notification({
                    title: '🎙 Dictation Error',
                    body: `Failed to process speech: ${err.message}`,
                    icon: this.trayIconPath
                }).show();
            } catch (e) {}
        } finally {
            this.isProcessing = false;
        }
    }

    cleanup() {
        if (this.win) {
            try { this.win.destroy(); } catch (e) {}
            this.win = null;
        }
        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        }
    }
}

module.exports = { DictationManager };
