const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const csv = require('csv-parser');
const { Notification } = require('electron');
const log = require('./logger');
const ai = require('./ai');
const { readJsonSafe, writeJsonSafe } = require('./util');

const PORT = 3001;

function startApiServer({ logsDir, tracker, meetings, getPowerStatus, trayIconPath }) {
    const apiApp = express();
    apiApp.use(cors());
    apiApp.use(express.json({ limit: '5mb' }));

    const tasksFile = path.join(logsDir, 'tasks.json');
    const summariesFile = path.join(logsDir, 'summaries.json');

    // Small helper so an async handler that throws returns JSON instead of
    // killing the request (or worse, the process).
    const wrap = (fn) => (req, res) => {
        Promise.resolve(fn(req, res)).catch(err => {
            log.error(`[API] ${req.method} ${req.path} failed:`, err);
            let errMsg = err.message || 'Internal error';
            if (err.status === 429) {
                errMsg = 'All AI model quotas are currently exhausted. Please try again later or add more API keys.';
            } else if (err.status === 503) {
                errMsg = 'The AI model is currently experiencing high demand. Please try again in a few minutes.';
            }
            if (!res.headersSent) res.status(err.status || 500).json({ error: errMsg });
        });
    };

    // ---------- health / status ----------
    apiApp.get('/api/status', (req, res) => {
        res.json({
            ok: true,
            tracker: tracker.getStatus(),
            meeting: meetings.status(),
            power: getPowerStatus(),
            aiConfigured: ai.isConfigured(),
        });
    });

    // ---------- tasks ----------
    apiApp.get('/api/tasks', (req, res) => {
        res.json(readJsonSafe(tasksFile, []));
    });

    apiApp.post('/api/tasks', (req, res) => {
        writeJsonSafe(tasksFile, req.body || []);
        res.json({ success: true });
    });

    apiApp.post('/api/reminders/clear/:taskId', (req, res) => {
        const tasks = readJsonSafe(tasksFile, []);
        const updated = tasks.map(t => {
            if (String(t.id) === String(req.params.taskId)) {
                const { reminderAt, ...rest } = t;
                return rest;
            }
            return t;
        });
        writeJsonSafe(tasksFile, updated);
        res.json({ success: true });
    });

    // ---------- saved summaries ----------
    apiApp.get('/api/saved-summary/:date', (req, res) => {
        const summaries = readJsonSafe(summariesFile, {});
        res.json({ summary: summaries[req.params.date] || null });
    });

    apiApp.post('/api/saved-summary/:date', (req, res) => {
        const summaries = readJsonSafe(summariesFile, {});
        summaries[req.params.date] = req.body.summary;
        writeJsonSafe(summariesFile, summaries);
        res.json({ success: true });
    });

    // ---------- activity logs ----------
    function readCsvLogs(dateStr) {
        return new Promise((resolve) => {
            const logFilePath = path.join(logsDir, `${String(dateStr).replace(/[^\d-]/g, '')}.csv`);
            if (!fs.existsSync(logFilePath)) return resolve([]);
            const results = [];
            fs.createReadStream(logFilePath)
                .pipe(csv(['timestamp', 'application', 'title']))
                .on('data', (data) => {
                    if (data.timestamp !== 'Timestamp') results.push(data);
                })
                .on('error', () => resolve(results))
                .on('end', () => resolve(results));
        });
    }

    function processLogs(logs) {
        if (logs.length === 0) return {};
        const summary = {};
        for (let i = 0; i < logs.length - 1; i++) {
            const current = logs[i];
            const next = logs[i + 1];
            const durationSeconds = (new Date(next.timestamp).getTime() - new Date(current.timestamp).getTime()) / 1000;
            if (durationSeconds > 900 || durationSeconds < 0) continue;
            summary[current.application] = (summary[current.application] || 0) + durationSeconds;
        }
        const last = logs[logs.length - 1];
        const tailSeconds = (Date.now() - new Date(last.timestamp).getTime()) / 1000;
        if (tailSeconds >= 0 && tailSeconds < 900) {
            summary[last.application] = (summary[last.application] || 0) + tailSeconds;
        }
        return Object.entries(summary)
            .sort(([, a], [, b]) => b - a)
            .reduce((r, [k, v]) => ({ ...r, [k]: v }), {});
    }

    function buildTaskMap(logs, taskMap = {}) {
        for (let i = 0; i < logs.length - 1; i++) {
            const current = logs[i];
            const next = logs[i + 1];
            const duration = (new Date(next.timestamp).getTime() - new Date(current.timestamp).getTime()) / 1000;
            if (duration > 900 || duration < 0) continue;
            const key = `[${current.application}] ${current.title}`;
            taskMap[key] = (taskMap[key] || 0) + duration;
        }
        return taskMap;
    }

    apiApp.get('/api/summary/:date', wrap(async (req, res) => {
        const logs = await readCsvLogs(req.params.date);
        res.json({ logs, summary: processLogs(logs) });
    }));

    apiApp.get('/api/analyze/:date', wrap(async (req, res) => {
        const logs = await readCsvLogs(req.params.date);
        if (logs.length === 0) return res.json({ analysis: 'No logs found for this date.' });

        const taskMap = buildTaskMap(logs);
        const manualTasks = readJsonSafe(tasksFile, []);

        const promptText = `
Here is a breakdown of my computer usage today by application and window title, along with the duration in seconds:
${JSON.stringify(taskMap, null, 2)}

Here are my manually recorded tasks/goals for reference:
${JSON.stringify(manualTasks, null, 2)}

Please act as an intelligent productivity assistant. Analyze these raw window titles and durations against my manual tasks.
Provide a concise, human-readable summary of the actual tasks I accomplished today.
Group related activities together. Format the response in clean Markdown with bullet points. Do not mention the raw seconds, convert them to minutes/hours.
`;
        res.json({ analysis: await ai.generateText(promptText) });
    }));

    // Cache for morning tasks (valid for 1 hour)
    let morningTasksCache = { data: null, timestamp: 0 };
    const MORNING_CACHE_TTL = 60 * 60 * 1000;

    apiApp.get('/api/morning-tasks', wrap(async (req, res) => {
        const forceRefresh = req.query.refresh === 'true';
        if (!forceRefresh && morningTasksCache.data && (Date.now() - morningTasksCache.timestamp < MORNING_CACHE_TTL)) {
            return res.json({ analysis: morningTasksCache.data });
        }

        const taskMap = {};
        for (let i = 0; i < 7; i++) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
            buildTaskMap(await readCsvLogs(dateStr), taskMap);
        }

        if (Object.keys(taskMap).length === 0) {
            return res.json({ analysis: 'Not enough data from the past week.' });
        }

        const manualTasks = readJsonSafe(tasksFile, []);
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
        const analysisText = await ai.generateText(promptText);
        morningTasksCache = { data: analysisText, timestamp: Date.now() };
        res.json({ analysis: analysisText });
    }));

    // ---------- AI chat ----------
    apiApp.post('/api/chat', wrap(async (req, res) => {
        const { message, date } = req.body || {};
        if (!message) return res.status(400).json({ error: 'Message is required.' });

        const now = new Date();
        const dateStr = date || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const logs = await readCsvLogs(dateStr);
        const summary = processLogs(logs);
        const manualTasks = readJsonSafe(tasksFile, []);

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
        res.json({ response: await ai.generateText(contextPrompt) });
    }));

    // ---------- meetings ----------
    apiApp.get('/api/meetings', (req, res) => {
        res.json(meetings.list());
    });

    apiApp.get('/api/meetings/current', (req, res) => {
        res.json(meetings.status());
    });

    apiApp.post('/api/meetings/start', wrap(async (req, res) => {
        const meeting = await meetings.start((req.body || {}).title);
        res.json({ success: true, meeting });
    }));

    apiApp.post('/api/meetings/stop', wrap(async (req, res) => {
        const meeting = await meetings.stop();
        res.json({ success: true, meeting });
    }));

    apiApp.get('/api/meetings/:id', (req, res) => {
        const meeting = meetings.get(req.params.id);
        if (!meeting) return res.status(404).json({ error: 'Meeting not found.' });
        res.json(meeting);
    });

    apiApp.post('/api/meetings/:id/summarize', wrap(async (req, res) => {
        const summary = await meetings.summarize(req.params.id);
        res.json({ success: true, summary });
    }));

    apiApp.delete('/api/meetings/:id', wrap(async (req, res) => {
        meetings.delete(req.params.id);
        res.json({ success: true });
    }));

    // ---------- listen (with EADDRINUSE retry) ----------
    let server = null;
    let retries = 0;
    function listen() {
        server = apiApp.listen(PORT, '127.0.0.1', () => {
            log.info(`[API] Express server running on http://localhost:${PORT}`);
        });
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE' && retries < 30) {
                retries++;
                log.warn(`[API] Port ${PORT} in use (attempt ${retries}), retrying in 5s...`);
                setTimeout(listen, 5000);
            } else {
                log.error('[API] Server failed to start:', err);
            }
        });
    }
    listen();

    // ---------- reminder checker (every 30s) ----------
    setInterval(() => {
        try {
            const tasks = readJsonSafe(tasksFile, null);
            if (!tasks) return;
            const now = Date.now();
            let changed = false;

            const updated = tasks.map(t => {
                if (t.reminderAt && !t.completed && new Date(t.reminderAt).getTime() <= now) {
                    new Notification({
                        title: '⏰ Task Reminder',
                        body: t.text,
                        icon: trayIconPath,
                    }).show();
                    log.info(`[Reminder] Fired notification for: ${t.text}`);
                    const { reminderAt, ...rest } = t;
                    changed = true;
                    return { ...rest, reminderFired: true };
                }
                return t;
            });

            if (changed) writeJsonSafe(tasksFile, updated);
        } catch (err) {
            log.error('[Reminder Checker Error]', err);
        }
    }, 30000);

    return { app: apiApp, getServer: () => server };
}

module.exports = { startApiServer, PORT };
