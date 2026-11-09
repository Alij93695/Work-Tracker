const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const csv = require('csv-parser');
const { Notification } = require('electron');
const log = require('./logger');
const ai = require('./ai');
const screenScanner = require('./screenScanner');
const outlookManager = require('./outlookManager');
const ReminderEngine = require('./reminderEngine');
const keyboardInjector = require('./keyboardInjector');
const dictationAi = require('./dictationAi');
const DictationStore = require('./dictationStore');
const whisperEngine = require('./whisperEngine');
const { readJsonSafe, writeJsonSafe } = require('./util');

const PORT = 3001;

function startApiServer({ logsDir, tracker, meetings, getPowerStatus, trayIconPath, createDashboard }) {
    const apiApp = express();
    apiApp.use(cors());
    apiApp.use(express.json({ limit: '5mb' }));

    const reminderEngine = new ReminderEngine({ logsDir, trayIconPath });
    reminderEngine.start();

    const dictationStore = new DictationStore({ logsDir });

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
    apiApp.post('/api/open-dashboard', (req, res) => {
        if (typeof createDashboard === 'function') {
            createDashboard();
            res.json({ success: true, opened: true });
        } else {
            res.json({ success: false, error: 'Dashboard handler unavailable' });
        }
    });
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

    // Approve a meeting-suggested task → it gets added to My Tasks.
    // Nothing is added without this explicit approval.
    apiApp.post('/api/meetings/:id/suggested/:sid/approve', wrap(async (req, res) => {
        const meeting = meetings.get(req.params.id);
        if (!meeting) return res.status(404).json({ error: 'Meeting not found.' });
        const suggestion = (meeting.suggestedTasks || []).find(s => String(s.id) === String(req.params.sid));
        if (!suggestion) return res.status(404).json({ error: 'Suggestion not found.' });

        const tasks = readJsonSafe(tasksFile, []);
        tasks.push({
            id: Date.now(),
            text: suggestion.text,
            completed: false,
            source: 'meeting',
            meetingId: meeting.id,
        });
        writeJsonSafe(tasksFile, tasks);
        meetings.setSuggestionStatus(req.params.id, req.params.sid, 'added');
        res.json({ success: true });
    }));

    apiApp.post('/api/meetings/:id/suggested/:sid/dismiss', wrap(async (req, res) => {
        meetings.setSuggestionStatus(req.params.id, req.params.sid, 'dismissed');
        res.json({ success: true });
    }));

    apiApp.post('/api/meetings/:id/summarize', wrap(async (req, res) => {
        const summary = await meetings.summarize(req.params.id);
        res.json({ success: true, summary });
    }));

    apiApp.post('/api/meetings/:id/live-notes', wrap(async (req, res) => {
        const liveNotes = await meetings.generateLiveNotes(req.params.id);
        res.json({ success: true, liveNotes });
    }));

    apiApp.delete('/api/meetings/:id', wrap(async (req, res) => {
        meetings.delete(req.params.id);
        res.json({ success: true });
    }));

    // ---------- computer use & outlook automation ----------
    apiApp.get('/api/notifications/upcoming', (req, res) => {
        res.json(reminderEngine.getUpcomingAlerts());
    });

    apiApp.post('/api/test-notification', (req, res) => {
        const body = req.body || {};
        reminderEngine.notify(
            body.title || '⏰ Upcoming Task / Meeting Alert',
            body.body || 'This is a test desktop notification from Scribe.'
        );
        res.json({ success: true });
    });

    apiApp.post('/api/screen/analyze', wrap(async (req, res) => {
        const lastSample = tracker ? tracker.getStatus().lastSample : null;
        const analysis = await screenScanner.analyzeCurrentScreen(lastSample);
        res.json(analysis);
    }));

    apiApp.post('/api/outlook/book', wrap(async (req, res) => {
        const booking = req.body || {};
        const result = await outlookManager.bookMeeting({ ...booking, logsDir });
        if (result.success) {
            reminderEngine.addScheduledMeeting(booking);
            reminderEngine.notify(
                '📅 Meeting Booked & Scheduled',
                `Scheduled: ${booking.subject || 'Sync'} with ${booking.contactName || 'Trainer'}`
            );
        }
        res.json(result);
    }));

    apiApp.post('/api/screen/quick-book', wrap(async (req, res) => {
        log.info('[API] 1-Tab Quick Book triggered from client...');
        const lastSample = tracker ? tracker.getStatus().lastSample : null;
        const analysis = await screenScanner.analyzeCurrentScreen(lastSample);
        const data = analysis.data || {};

        const bookingDetails = {
            subject: data.topic || `Meeting with ${data.contactName || 'Country Trainer'}`,
            body: `Context extracted from active screen (${data.appName || 'WeChat'}):\n\n` +
                  `Summary: ${data.summaryText || 'Discussion with country trainer'}\n` +
                  `Contact: ${data.contactName || 'Country Trainer'}\n` +
                  `Confidence: ${data.confidence || 'high'}\n\n` +
                  `Generated by Scribe 1-Tab Meeting Automation.`,
            date: data.proposedDate,
            time: data.proposedTime,
            durationMinutes: data.durationMinutes || 30,
            contactName: data.contactName || 'Country Trainer',
            location: 'WeChat / Online Sync',
            logsDir
        };

        const result = await outlookManager.bookMeeting(bookingDetails);

        if (result.success) {
            reminderEngine.addScheduledMeeting(bookingDetails);
            reminderEngine.notify(
                '⚡ 1-Tab Meeting Booked',
                `Opened Outlook meeting for ${bookingDetails.contactName} (${bookingDetails.subject})`
            );
        }

        res.json({
            success: result.success,
            method: result.method,
            analysis: data,
            bookingDetails
        });
    }));

    // ---------- universal voice dictation & intelligence ----------
    apiApp.post('/api/dictation/process', wrap(async (req, res) => {
        const { text, audioBase64, autoInject = true, options = {} } = req.body || {};
        let rawInput = text;

        if (audioBase64) {
            const wRes = await whisperEngine.transcribe(audioBase64);
            rawInput = wRes.text;
        }

        if (!rawInput || !rawInput.trim()) {
            return res.json({ success: false, error: 'No audio or text provided for dictation.' });
        }

        const dictionary = dictationStore.getDictionary();
        const snippets = dictationStore.getSnippets();
        const settings = dictationStore.getSettings();

        const result = await dictationAi.processDictation(rawInput, {
            dictionary,
            snippets,
            ...settings,
            ...options
        });

        let injectionResult = null;
        if (autoInject && result.text) {
            injectionResult = await keyboardInjector.injectText(result.text);
            new Notification({
                title: '🎙 Universal Voice Dictation',
                body: `Injected: "${result.text.slice(0, 80)}${result.text.length > 80 ? '...' : ''}"`,
                icon: trayIconPath
            }).show();
        }

        res.json({
            success: true,
            result,
            injectionResult
        });
    }));

    apiApp.post('/api/dictation/inject', wrap(async (req, res) => {
        const { text } = req.body || {};
        if (!text) return res.status(400).json({ error: 'Text parameter is required.' });
        const result = await keyboardInjector.injectText(text);
        res.json(result);
    }));

    apiApp.get('/api/dictation/dictionary', (req, res) => {
        res.json(dictationStore.getDictionary());
    });

    apiApp.post('/api/dictation/dictionary', (req, res) => {
        const { term } = req.body || {};
        if (!term) return res.status(400).json({ error: 'Term parameter is required.' });
        const updated = dictationStore.addDictionaryTerm(term);
        res.json({ success: true, dictionary: updated });
    });

    apiApp.delete('/api/dictation/dictionary/:term', (req, res) => {
        const updated = dictationStore.removeDictionaryTerm(req.params.term);
        res.json({ success: true, dictionary: updated });
    });

    apiApp.get('/api/dictation/snippets', (req, res) => {
        res.json(dictationStore.getSnippets());
    });

    apiApp.post('/api/dictation/snippets', (req, res) => {
        const snippet = req.body || {};
        if (!snippet.trigger || !snippet.expansion) {
            return res.status(400).json({ error: 'Trigger and expansion are required.' });
        }
        const updated = dictationStore.addOrUpdateSnippet(snippet);
        res.json({ success: true, snippets: updated });
    });

    apiApp.delete('/api/dictation/snippets/:id', (req, res) => {
        const updated = dictationStore.deleteSnippet(req.params.id);
        res.json({ success: true, snippets: updated });
    });

    apiApp.get('/api/dictation/settings', (req, res) => {
        res.json(dictationStore.getSettings());
    });

    apiApp.post('/api/dictation/settings', (req, res) => {
        const updated = dictationStore.saveSettings(req.body || {});
        res.json({ success: true, settings: updated });
    });

    // ---------- open whisper engine status & configuration ----------
    apiApp.get('/api/whisper/status', (req, res) => {
        res.json(whisperEngine.getSettings());
    });

    apiApp.post('/api/whisper/settings', wrap(async (req, res) => {
        const updated = await whisperEngine.saveSettings(req.body || {});
        res.json({ success: true, settings: updated });
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
