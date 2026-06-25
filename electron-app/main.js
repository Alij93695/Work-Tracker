const { app, Tray, Menu, nativeImage, BrowserWindow, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

// Load environment variables from multiple paths (UserOverride > ExecutableDir > BundledAsar)
try {
    require('dotenv').config({ path: path.join(app.getPath('userData'), 'logs', '.env') });
} catch (e) {}
try {
    require('dotenv').config({ path: path.join(path.dirname(process.execPath), '.env') });
} catch (e) {}
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { exec } = require('child_process');
const { createObjectCsvWriter } = require('csv-writer');

// Firebase imports
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, addDoc } = require('firebase/firestore');

// Express API imports
const express = require('express');
const cors = require('cors');
const csv = require('csv-parser');
const { GoogleGenAI } = require('@google/genai');

let tray = null;
let dashboardWindow = null;
let firebaseApp = null;
let db = null;

const logsDir = path.join(app.getPath('userData'), 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
}

// Initialize Firebase if config exists
try {
    if (process.env.FIREBASE_API_KEY && !process.env.FIREBASE_API_KEY.includes('paste')) {
        const firebaseConfig = {
            apiKey: process.env.FIREBASE_API_KEY,
            authDomain: process.env.FIREBASE_AUTH_DOMAIN,
            projectId: process.env.FIREBASE_PROJECT_ID,
        };
        firebaseApp = initializeApp(firebaseConfig);
        db = getFirestore(firebaseApp);
        console.log('Firebase initialized successfully.');
    }
} catch (error) {
    console.error('Firebase initialization failed:', error);
}

function createDashboard() {
    if (dashboardWindow) {
        dashboardWindow.focus();
        return;
    }
    dashboardWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        icon: path.join(__dirname, 'tray-icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });
    
    // Load the React app from the copied dist folder
    dashboardWindow.loadFile(path.join(__dirname, 'dashboard', 'index.html'));
    
    dashboardWindow.on('closed', () => {
        dashboardWindow = null;
    });
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        if (dashboardWindow) {
            if (dashboardWindow.isMinimized()) dashboardWindow.restore();
            dashboardWindow.focus();
        } else {
            createDashboard();
        }
    });

    app.whenReady().then(() => {
        // Hide the dock icon on macOS, hide completely on Windows
        // if (app.dock) app.dock.hide();

        // Setup Tray
        const iconPath = path.join(__dirname, 'tray-icon.png');
        // If icon doesn't exist, use an empty NativeImage
        const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
        tray = new Tray(icon);
        
        const contextMenu = Menu.buildFromTemplate([
            { label: 'Open Dashboard', click: createDashboard },
            { type: 'separator' },
            { label: 'Quit', click: () => { app.quit(); } }
        ]);
        
        tray.setToolTip('Work Tracker is Running');
        tray.setContextMenu(contextMenu);

        // Open Dashboard on double click
        tray.on('double-click', createDashboard);

        // Start Express API
        startApiServer();

        // Start tracking
        startTracking();
    });
}

// Avoid app quitting when window is closed
app.on('window-all-closed', (e) => {
    e.preventDefault();
});

// ------------- EXPRESS API -------------
function startApiServer() {
    const apiApp = express();
    apiApp.use(cors());
    apiApp.use(express.json());

    const tasksFile = path.join(logsDir, 'tasks.json');
    const summariesFile = path.join(logsDir, 'summaries.json');

    apiApp.get('/api/tasks', (req, res) => {
        if (!fs.existsSync(tasksFile)) return res.json([]);
        res.json(JSON.parse(fs.readFileSync(tasksFile, 'utf8')));
    });

    apiApp.post('/api/tasks', (req, res) => {
        fs.writeFileSync(tasksFile, JSON.stringify(req.body));
        res.json({ success: true });
    });

    apiApp.get('/api/saved-summary/:date', (req, res) => {
        if (!fs.existsSync(summariesFile)) return res.json({ summary: null });
        const summaries = JSON.parse(fs.readFileSync(summariesFile, 'utf8'));
        res.json({ summary: summaries[req.params.date] || null });
    });

    apiApp.post('/api/saved-summary/:date', (req, res) => {
        let summaries = {};
        if (fs.existsSync(summariesFile)) {
            summaries = JSON.parse(fs.readFileSync(summariesFile, 'utf8'));
        }
        summaries[req.params.date] = req.body.summary;
        fs.writeFileSync(summariesFile, JSON.stringify(summaries));
        res.json({ success: true });
    });

    // Multi-key rotation — loaded from environment variables (keys separated by commas)
    let API_KEYS = [];
    if (process.env.GEMINI_API_KEYS) {
        API_KEYS = process.env.GEMINI_API_KEYS.split(',').map(key => key.trim()).filter(Boolean);
    } else if (process.env.GEMINI_API_KEY) {
        API_KEYS = [process.env.GEMINI_API_KEY.trim()];
    }
    const aiClients = API_KEYS.map(apiKey => new GoogleGenAI({ apiKey }));
    if (aiClients.length === 0) {
        console.warn('Warning: No Gemini API keys found in environment variables.');
    }

    // Model fallback chain — each model has its own daily free-tier quota
    const MODEL_CHAIN = [
        'gemini-2.5-flash',
        'gemini-2.0-flash-lite',
        'gemini-2.0-flash',
    ];

    // Resilient generation: tries every key × model combo with retry + backoff
    async function generateWithFallback(promptText) {
        let lastError = null;
        for (let keyIdx = 0; keyIdx < aiClients.length; keyIdx++) {
            const ai = aiClients[keyIdx];
            for (const model of MODEL_CHAIN) {
                for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                        console.log(`[AI] Key ${keyIdx + 1}/${aiClients.length} → ${model} (attempt ${attempt + 1})...`);
                        const response = await ai.models.generateContent({
                            model,
                            contents: promptText,
                        });
                        console.log(`[AI] ✓ Success with Key ${keyIdx + 1} → ${model}`);
                        return response.text;
                    } catch (err) {
                        lastError = err;
                        // Daily quota exhausted → skip to next model
                        if (err.status === 429 && err.message && err.message.includes('PerDay')) {
                            console.log(`[AI] Key ${keyIdx + 1} daily quota exhausted for ${model}, trying next...`);
                            break;
                        }
                        // Per-minute rate limit → wait and retry same key+model
                        if (err.status === 429 || err.status === 503) {
                            const waitMs = Math.pow(2, attempt) * 2000;
                            console.log(`[AI] Key ${keyIdx + 1} rate limited on ${model}, retrying in ${waitMs}ms...`);
                            await new Promise(r => setTimeout(r, waitMs));
                            continue;
                        }
                        // Other error → skip to next model
                        console.log(`[AI] Key ${keyIdx + 1} error on ${model}: ${err.message}`);
                        break;
                    }
                }
            }
            console.log(`[AI] Key ${keyIdx + 1} fully exhausted, trying next key...`);
        }
        throw lastError || new Error('All AI keys and models exhausted. Please try again later.');
    }

    // Cache for morning tasks (valid for 1 hour)
    let morningTasksCache = { data: null, timestamp: 0 };
    const MORNING_CACHE_TTL = 60 * 60 * 1000; // 1 hour

    function readCsvLogs(dateStr) {
        return new Promise((resolve) => {
            const logFilePath = path.join(logsDir, `${dateStr}.csv`);
            if (!fs.existsSync(logFilePath)) {
                return resolve([]);
            }
            const results = [];
            fs.createReadStream(logFilePath)
                .pipe(csv(['timestamp', 'application', 'title']))
                .on('data', (data) => {
                    if (data.timestamp !== 'Timestamp') results.push(data);
                })
                .on('end', () => resolve(results));
        });
    }

    function processLogs(logs) {
        if (logs.length === 0) return {};
        const summary = {};
        for (let i = 0; i < logs.length - 1; i++) {
            const current = logs[i];
            const next = logs[i + 1];
            const startTime = new Date(current.timestamp).getTime();
            const endTime = new Date(next.timestamp).getTime();
            const durationSeconds = (endTime - startTime) / 1000;
            
            if (durationSeconds > 900) continue; 
            
            if (!summary[current.application]) summary[current.application] = 0;
            summary[current.application] += durationSeconds;
        }
        
        if (logs.length > 0) {
            const last = logs[logs.length - 1];
            const startTime = new Date(last.timestamp).getTime();
            const endTime = Date.now();
            const durationSeconds = (endTime - startTime) / 1000;
            if (durationSeconds < 900) {
                if (!summary[last.application]) summary[last.application] = 0;
                summary[last.application] += durationSeconds;
            }
        }
        
        return Object.entries(summary)
            .sort(([, a], [, b]) => b - a)
            .reduce((r, [k, v]) => ({ ...r, [k]: v }), {});
    }

    apiApp.get('/api/summary/:date', async (req, res) => {
        const logs = await readCsvLogs(req.params.date);
        const summary = processLogs(logs);
        res.json({ logs, summary });
    });

    apiApp.get('/api/analyze/:date', async (req, res) => {
        try {
            // Environment variables check removed
            
            const logs = await readCsvLogs(req.params.date);
            if (logs.length === 0) return res.json({ analysis: "No logs found for this date." });

            const taskMap = {};
            for (let i = 0; i < logs.length - 1; i++) {
                const current = logs[i];
                const next = logs[i + 1];
                const duration = (new Date(next.timestamp).getTime() - new Date(current.timestamp).getTime()) / 1000;
                if (duration > 900) continue;

                const key = `[${current.application}] ${current.title}`;
                taskMap[key] = (taskMap[key] || 0) + duration;
            }

            let manualTasks = [];
            if (fs.existsSync(tasksFile)) {
                manualTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
            }

            const promptText = `
            Here is a breakdown of my computer usage today by application and window title, along with the duration in seconds:
            ${JSON.stringify(taskMap, null, 2)}
            
            Here are my manually recorded tasks/goals for reference:
            ${JSON.stringify(manualTasks, null, 2)}
            
            Please act as an intelligent productivity assistant. Analyze these raw window titles and durations against my manual tasks.
            Provide a concise, human-readable summary of the actual tasks I accomplished today. 
            Group related activities together. Format the response in clean Markdown with bullet points. Do not mention the raw seconds, convert them to minutes/hours.
            `;

            const analysisText = await generateWithFallback(promptText);

            res.json({ analysis: analysisText });
        } catch (err) {
            console.error(err);
            let errMsg = 'Failed to generate AI analysis.';
            if (err.status === 429) {
                errMsg = 'All AI model quotas are currently exhausted. The free tier allows 20 requests/day per model. Please try again tomorrow or upgrade your API key.';
            } else if (err.status === 503) {
                errMsg = 'The AI model is currently experiencing high demand. Please try again in a few minutes.';
            } else if (err.message) {
                errMsg = err.message;
            }
            res.status(err.status || 500).json({ error: errMsg });
        }
    });

    apiApp.get('/api/morning-tasks', async (req, res) => {
        try {
            // Return cached morning tasks if still fresh (unless force refresh)
            const forceRefresh = req.query.refresh === 'true';
            if (!forceRefresh && morningTasksCache.data && (Date.now() - morningTasksCache.timestamp < MORNING_CACHE_TTL)) {
                console.log('[AI] Returning cached morning tasks');
                return res.json({ analysis: morningTasksCache.data });
            }

            const taskMap = {};
            for (let i = 0; i < 7; i++) {
                const date = new Date();
                date.setDate(date.getDate() - i);
                const dateStr = date.toISOString().split('T')[0];
                const logs = await readCsvLogs(dateStr);
                
                for (let j = 0; j < logs.length - 1; j++) {
                    const current = logs[j];
                    const next = logs[j + 1];
                    const duration = (new Date(next.timestamp).getTime() - new Date(current.timestamp).getTime()) / 1000;
                    if (duration > 900) continue;

                    const key = `[${current.application}] ${current.title}`;
                    taskMap[key] = (taskMap[key] || 0) + duration;
                }
            }

            if (Object.keys(taskMap).length === 0) {
                return res.json({ analysis: "Not enough data from the past week." });
            }

            let manualTasks = [];
            if (fs.existsSync(tasksFile)) {
                manualTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
            }

            const promptText = `
            Here is a breakdown of my computer usage over the past week by application and window title, along with the duration in seconds:
            ${JSON.stringify(taskMap, null, 2)}
            
            Here are my manually recorded tasks/goals for reference:
            ${JSON.stringify(manualTasks, null, 2)}
            
            Please act as an intelligent productivity assistant. Analyze this usage data.
            Identify tasks that seem to be ongoing or unfinished based on the context.
            Suggest 1 to 3 "Morning Tasks" for me to start with today.
            Keep it concise, encouraging, and format in Markdown.
            `;

            const analysisText = await generateWithFallback(promptText);

            // Cache the result
            morningTasksCache = { data: analysisText, timestamp: Date.now() };

            res.json({ analysis: analysisText });
        } catch (err) {
            console.error(err);
            let errMsg = 'Failed to generate Morning Tasks.';
            if (err.status === 429) {
                errMsg = 'All AI model quotas are currently exhausted. The free tier allows 20 requests/day per model. Please try again tomorrow or upgrade your API key.';
            } else if (err.status === 503) {
                errMsg = 'The AI model is currently experiencing high demand. Please try again in a few minutes.';
            } else if (err.message) {
                errMsg = err.message;
            }
            res.status(err.status || 500).json({ error: errMsg });
        }
    });

    // ------------- AI CHAT ENDPOINT -------------
    apiApp.post('/api/chat', async (req, res) => {
        try {
            const { message, date } = req.body;
            if (!message) return res.status(400).json({ error: 'Message is required.' });

            const dateStr = date || new Date().toISOString().split('T')[0];
            const logs = await readCsvLogs(dateStr);
            const summary = processLogs(logs);

            let manualTasks = [];
            if (fs.existsSync(tasksFile)) {
                manualTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
            }

            const contextPrompt = `
You are an intelligent productivity assistant embedded inside a Work Tracker desktop application.
The user is viewing their data for date: ${dateStr}.

Here is their computer activity log for that day (application → duration in seconds):
${JSON.stringify(summary, null, 2)}

Here is the detailed timeline of window switches:
${JSON.stringify(logs.slice(-50), null, 2)}

Here are their manually recorded tasks:
${JSON.stringify(manualTasks, null, 2)}

The user asks: "${message}"

Provide a helpful, concise response. Use Markdown formatting. If they ask for a summary of specific apps or time ranges, analyze the data above. If they ask general productivity questions, give practical advice. Be conversational and friendly.
            `;

            const responseText = await generateWithFallback(contextPrompt);
            res.json({ response: responseText });
        } catch (err) {
            console.error('[Chat Error]', err);
            let errMsg = 'Failed to generate response.';
            if (err.status === 429) {
                errMsg = 'AI quota exhausted. Please try again later.';
            } else if (err.status === 503) {
                errMsg = 'AI model is experiencing high demand. Please try again in a few minutes.';
            }
            res.status(err.status || 500).json({ error: errMsg });
        }
    });

    // ------------- REMINDER CLEAR ENDPOINT -------------
    apiApp.post('/api/reminders/clear/:taskId', (req, res) => {
        if (!fs.existsSync(tasksFile)) return res.json({ success: true });
        const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
        const updated = tasks.map(t => {
            if (String(t.id) === String(req.params.taskId)) {
                const { reminderAt, ...rest } = t;
                return rest;
            }
            return t;
        });
        fs.writeFileSync(tasksFile, JSON.stringify(updated));
        res.json({ success: true });
    });

    const PORT = 3001;
    apiApp.listen(PORT, () => {
        console.log(`Express Server running on http://localhost:${PORT}`);
    });

    // ------------- REMINDER CHECKER (runs every 30s) -------------
    setInterval(() => {
        try {
            if (!fs.existsSync(tasksFile)) return;
            const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
            const now = Date.now();
            let changed = false;

            const updated = tasks.map(t => {
                if (t.reminderAt && !t.completed && new Date(t.reminderAt).getTime() <= now) {
                    // Fire notification
                    const notification = new Notification({
                        title: '⏰ Task Reminder',
                        body: t.text,
                        icon: path.join(__dirname, 'tray-icon.png'),
                    });
                    notification.show();
                    console.log(`[Reminder] Fired notification for: ${t.text}`);

                    // Clear the reminder so it doesn't fire again
                    const { reminderAt, ...rest } = t;
                    changed = true;
                    return { ...rest, reminderFired: true };
                }
                return t;
            });

            if (changed) {
                fs.writeFileSync(tasksFile, JSON.stringify(updated));
            }
        } catch (err) {
            console.error('[Reminder Checker Error]', err);
        }
    }, 30000);
}

// ------------- TRACKER -------------
function getCsvWriter() {
    const today = new Date().toISOString().split('T')[0];
    const logFilePath = path.join(logsDir, `${today}.csv`);
    const fileExists = fs.existsSync(logFilePath);

    return createObjectCsvWriter({
        path: logFilePath,
        header: [
            { id: 'timestamp', title: 'Timestamp' },
            { id: 'application', title: 'Application' },
            { id: 'title', title: 'Title' }
        ],
        append: fileExists
    });
}

function getActiveWindow() {
    return new Promise((resolve) => {
        const activeWinExe = app.isPackaged 
            ? path.join(process.resourcesPath, 'ActiveWindow.exe') 
            : path.join(__dirname, 'ActiveWindow.exe');

        require('child_process').execFile(activeWinExe, (error, stdout) => {
            if (error || !stdout) {
                return resolve(null);
            }
            try {
                const text = stdout.trim();
                const pipeIndex = text.indexOf('|');
                if (pipeIndex > 0) {
                    resolve({
                        app: text.substring(0, pipeIndex).trim(),
                        title: text.substring(pipeIndex + 1).trim()
                    });
                } else {
                    resolve(null);
                }
            } catch (e) {
                resolve(null);
            }
        });
    });
}

let lastWindow = null;

async function startTracking() {
    setInterval(async () => {
        try {
            const window = await getActiveWindow();
            if (window) {
                const currentApp = window.app || 'Unknown';
                const currentTitle = window.title || 'Unknown';
                
                if (!lastWindow || lastWindow.app !== currentApp || lastWindow.title !== currentTitle) {
                    const currentData = {
                        timestamp: new Date().toISOString(),
                        application: currentApp,
                        title: currentTitle
                    };
                    
                    // 1. Write to local CSV
                    const csvWriter = getCsvWriter();
                    await csvWriter.writeRecords([currentData]);
                    
                    // 2. Sync to Firebase if configured
                    if (db) {
                        try {
                            await addDoc(collection(db, 'logs'), currentData);
                        } catch (fbErr) {
                            console.error('Firebase sync failed:', fbErr);
                        }
                    }
                    
                    lastWindow = { app: currentApp, title: currentTitle };
                }
            }
        } catch (error) {
            console.error('Error tracking window:', error.message);
        }
    }, 2000);
}
