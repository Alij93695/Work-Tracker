const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const log = require('./logger');
const { readJsonSafe, writeJsonSafe } = require('./util');

class WhisperEngine {
    constructor() {
        this.logsDir = null;
        this.settingsFile = null;
        this.workerProcess = null;
        this.readlineInterface = null;
        this.pendingRequests = new Map();
        this.requestId = 0;
        this.isReady = false;
        this.isStarting = false;
        this.model = 'base'; // 'tiny', 'base', 'small'
        this.mode = 'auto';  // 'auto', 'local', 'groq', 'openai', 'gemini'
        this.language = 'auto';
        this.lastUsed = Date.now();
        this.idleTimeout = null;
    }

    getPythonCommand() {
        const candidates = [
            'C:\\Users\\alij9\\AppData\\Local\\Programs\\Python\\Python311\\python.exe',
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe')
        ];
        for (const p of candidates) {
            if (p && fs.existsSync(p)) return p;
        }
        return process.platform === 'win32' ? 'python' : 'python3';
    }

    resolveWorkerPath() {
        // In both dev and packaged modes, copy/sync worker script to logsDir on physical disk
        if (this.logsDir) {
            const destInLogs = path.join(this.logsDir, 'whisper_worker.py');
            try {
                const srcPath = path.join(__dirname, 'whisper_worker.py');
                if (fs.existsSync(srcPath)) {
                    const srcContent = fs.readFileSync(srcPath, 'utf8');
                    if (!fs.existsSync(destInLogs) || fs.readFileSync(destInLogs, 'utf8') !== srcContent) {
                        fs.writeFileSync(destInLogs, srcContent, 'utf8');
                        log.info(`[WhisperEngine] Synced whisper_worker.py to ${destInLogs}`);
                    }
                    return destInLogs;
                }
            } catch (e) {
                log.warn('[WhisperEngine] Note on syncing worker to logsDir:', e.message);
            }
            if (fs.existsSync(destInLogs)) return destInLogs;
        }

        if (process.resourcesPath) {
            const p1 = path.join(process.resourcesPath, 'whisper_worker.py');
            if (fs.existsSync(p1)) return p1;
            const p2 = path.join(process.resourcesPath, 'src', 'whisper_worker.py');
            if (fs.existsSync(p2)) return p2;
        }

        return path.join(__dirname, 'whisper_worker.py');
    }

    init({ logsDir }) {
        this.logsDir = logsDir;
        this.settingsFile = path.join(logsDir, 'whisper_settings.json');

        const savedSettings = readJsonSafe(this.settingsFile, {
            mode: 'auto',
            model: 'base',
            language: 'auto'
        });

        this.mode = savedSettings.mode || 'auto';
        this.model = savedSettings.model || 'base';
        this.language = savedSettings.language || 'auto';

        log.info(`[WhisperEngine] Initialized with mode='${this.mode}', model='${this.model}', language='${this.language}'`);

        // Warm up local worker in background
        this.ensureWorker().catch(err => {
            log.warn('[WhisperEngine] Background worker warmup note:', err.message);
        });
    }

    getSettings() {
        return {
            mode: this.mode,
            model: this.model,
            language: this.language,
            isReady: this.isReady,
            workerRunning: !!this.workerProcess
        };
    }

    async saveSettings(newSettings = {}) {
        if (newSettings.mode) this.mode = newSettings.mode;
        if (newSettings.language) this.language = newSettings.language;
        
        let modelChanged = false;
        if (newSettings.model && newSettings.model !== this.model) {
            this.model = newSettings.model;
            modelChanged = true;
        }

        const toSave = {
            mode: this.mode,
            model: this.model,
            language: this.language
        };
        writeJsonSafe(this.settingsFile, toSave);
        log.info('[WhisperEngine] Saved settings:', toSave);

        if (modelChanged && this.workerProcess) {
            await this.restartWorker();
        }

        return this.getSettings();
    }

    ensureWorker() {
        if (this.workerProcess && this.isReady) {
            return Promise.resolve();
        }
        if (this.isStarting) {
            return new Promise((resolve, reject) => {
                const interval = setInterval(() => {
                    if (this.isReady) {
                        clearInterval(interval);
                        resolve();
                    } else if (!this.isStarting) {
                        clearInterval(interval);
                        reject(new Error('Worker failed to start'));
                    }
                }, 100);
            });
        }

        this.isStarting = true;
        return new Promise((resolve, reject) => {
            try {
                const pyCmd = this.getPythonCommand();
                const workerFile = this.resolveWorkerPath();
                log.info(`[WhisperEngine] Spawning ${pyCmd} with worker=${workerFile} (${this.model})...`);

                this.workerProcess = spawn(pyCmd, [workerFile, this.model], {
                    stdio: ['pipe', 'pipe', 'pipe']
                });

                this.workerProcess.stderr.on('data', (data) => {
                    log.info(`[WhisperEngine/py] ${data.toString().trim()}`);
                });

                this.readlineInterface = readline.createInterface({
                    input: this.workerProcess.stdout,
                    crlfDelay: Infinity
                });

                const startTimeout = setTimeout(() => {
                    if (!this.isReady) {
                        this.isStarting = false;
                        reject(new Error('Worker spawn timed out after 30s'));
                    }
                }, 30000);

                this.readlineInterface.on('line', (line) => {
                    const trimmed = line.trim();
                    if (!trimmed) return;
                    try {
                        const parsed = JSON.parse(trimmed);
                        if (parsed.status === 'ready') {
                            clearTimeout(startTimeout);
                            this.isReady = true;
                            this.isStarting = false;
                            log.info(`[WhisperEngine] Local faster-whisper worker is READY (model: ${parsed.model}).`);
                            resolve();
                            return;
                        }
                        if (parsed.status === 'error') {
                            clearTimeout(startTimeout);
                            this.isStarting = false;
                            reject(new Error(parsed.error || 'Worker init error'));
                            return;
                        }

                        // Match response by request id
                        if (parsed.id !== undefined && this.pendingRequests.has(parsed.id)) {
                            const handler = this.pendingRequests.get(parsed.id);
                            this.pendingRequests.delete(parsed.id);
                            handler(parsed);
                        }
                    } catch (err) {
                        log.warn('[WhisperEngine] Failed to parse worker output line:', trimmed);
                    }
                });

                this.workerProcess.on('error', (err) => {
                    log.error('[WhisperEngine] Worker process error:', err.message);
                    this.cleanupWorker();
                    if (this.isStarting) {
                        this.isStarting = false;
                        reject(err);
                    }
                });

                this.workerProcess.on('exit', (code, signal) => {
                    log.warn(`[WhisperEngine] Worker process exited with code=${code}, signal=${signal}`);
                    this.cleanupWorker();
                });

            } catch (err) {
                this.isStarting = false;
                this.cleanupWorker();
                reject(err);
            }
        });
    }

    cleanupWorker() {
        this.isReady = false;
        this.isStarting = false;
        if (this.readlineInterface) {
            try { this.readlineInterface.close(); } catch (e) { /* ignore */ }
            this.readlineInterface = null;
        }
        if (this.workerProcess) {
            try { this.workerProcess.kill(); } catch (e) { /* ignore */ }
            this.workerProcess = null;
        }
        // Fail any pending requests
        for (const [id, handler] of this.pendingRequests.entries()) {
            handler({ success: false, error: 'Worker exited unexpectedly' });
        }
        this.pendingRequests.clear();
    }

    async restartWorker() {
        this.cleanupWorker();
        await this.ensureWorker();
    }

    resetIdleTimer() {
        this.lastUsed = Date.now();
        if (this.idleTimeout) clearTimeout(this.idleTimeout);
        // Spin down worker after 15 minutes of inactivity to release memory
        this.idleTimeout = setTimeout(() => {
            log.info('[WhisperEngine] Idle timeout reached, spinning down local worker to conserve RAM...');
            this.cleanupWorker();
        }, 15 * 60 * 1000);
    }

    /**
     * Transcribe via local faster-whisper worker
     */
    async transcribeLocal(audioBase64, { initialPrompt = null, language = null } = {}) {
        await this.ensureWorker();
        this.resetIdleTimer();

        const id = ++this.requestId;
        const reqPayload = {
            id,
            action: 'transcribe',
            audioBase64,
            initialPrompt: initialPrompt || undefined,
            language: language || (this.language !== 'auto' ? this.language : undefined)
        };

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error('Local whisper transcription timed out (45s)'));
                }
            }, 45000);

            this.pendingRequests.set(id, (res) => {
                clearTimeout(timeout);
                if (res.success) {
                    resolve({
                        text: res.text || '',
                        engine: 'local-whisper',
                        model: this.model,
                        language: res.language || 'unknown',
                        durationSec: res.durationSec || 0
                    });
                } else {
                    reject(new Error(res.error || 'Local whisper transcription failed'));
                }
            });

            try {
                this.workerProcess.stdin.write(JSON.stringify(reqPayload) + '\n');
            } catch (err) {
                this.pendingRequests.delete(id);
                clearTimeout(timeout);
                reject(err);
            }
        });
    }

    /**
     * Transcribe via Cloud Whisper (Groq or OpenAI) if configured
     */
    async transcribeCloud(audioBase64, provider = 'groq') {
        const apiKey = provider === 'groq' ? process.env.GROQ_API_KEY : process.env.OPENAI_API_KEY;
        if (!apiKey || apiKey.includes('YOUR_')) {
            throw new Error(`Cloud Whisper ${provider} API key not configured`);
        }

        const endpoint = provider === 'groq'
            ? 'https://api.groq.com/openai/v1/audio/transcriptions'
            : 'https://api.openai.com/v1/audio/transcriptions';
        const model = provider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1';

        const buffer = Buffer.from(audioBase64, 'base64');
        const formData = new FormData();
        const blob = new Blob([buffer], { type: 'audio/wav' });
        formData.append('file', blob, 'audio.wav');
        formData.append('model', model);
        if (this.language && this.language !== 'auto') {
            formData.append('language', this.language);
        }

        const resp = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`
            },
            body: formData
        });

        if (!resp.ok) {
            const errTxt = await resp.text();
            throw new Error(`${provider} Whisper error ${resp.status}: ${errTxt}`);
        }

        const data = await resp.json();
        return {
            text: (data.text || '').trim(),
            engine: `${provider}-whisper`,
            model,
            language: this.language
        };
    }

    /**
     * Universal transcribe method with auto-failover:
     * 1. Local Whisper (faster-whisper) - 100% Free, Private & Offline
     * 2. Cloud Whisper (Groq/OpenAI if configured)
     * 3. Gemini Multimodal Audio fallback
     */
    async transcribe(audioBase64, opts = {}) {
        if (!audioBase64) return { text: '', engine: 'none' };

        // 1. If user explicitly selected Groq or OpenAI
        if (this.mode === 'groq') {
            try {
                return await this.transcribeCloud(audioBase64, 'groq');
            } catch (err) {
                log.warn('[WhisperEngine] Groq Whisper failed, trying local fallback:', err.message);
            }
        }
        if (this.mode === 'openai') {
            try {
                return await this.transcribeCloud(audioBase64, 'openai');
            } catch (err) {
                log.warn('[WhisperEngine] OpenAI Whisper failed, trying local fallback:', err.message);
            }
        }

        // 2. Primary / Default: Local faster-whisper (Free, Private, Local)
        try {
            const result = await this.transcribeLocal(audioBase64, opts);
            log.info(`[WhisperEngine] ✓ Local Whisper [${this.model}]: "${result.text.slice(0, 60)}${result.text.length > 60 ? '...' : ''}" (${result.durationSec?.toFixed(2)}s)`);
            return result;
        } catch (localErr) {
            log.warn('[WhisperEngine] Local faster-whisper error:', localErr.message);

            // 3. Fallback to Groq if key exists
            if (process.env.GROQ_API_KEY && !process.env.GROQ_API_KEY.includes('YOUR_')) {
                try {
                    log.info('[WhisperEngine] Falling back to Groq Cloud Whisper...');
                    return await this.transcribeCloud(audioBase64, 'groq');
                } catch (groqErr) {
                    log.warn('[WhisperEngine] Groq fallback failed:', groqErr.message);
                }
            }

            // 4. Fallback to Gemini Multimodal Audio
            log.warn('[WhisperEngine] Falling back to Gemini Multimodal Audio pipeline...');
            const ai = require('./ai');
            const geminiText = await ai.transcribeAudio(audioBase64);
            return {
                text: (geminiText || '').replace(/\[SILENCE\]/g, '').trim(),
                engine: 'gemini-fallback',
                model: 'gemini-flash'
            };
        }
    }
}

// Singleton instance
const instance = new WhisperEngine();

module.exports = instance;
