const { BrowserWindow, ipcMain, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('./logger');
const ai = require('./ai');
const whisperEngine = require('./whisperEngine');
const { readJsonSafe, writeJsonSafe, localTimestamp } = require('./util');

// Meeting capture manager.
//
// No bot joins the call. A hidden renderer window captures Windows system
// loopback audio (whatever is playing — Zoom/Teams/Meet/browser) mixed with
// the microphone, chops it into ~20s WAV chunks, and the main process
// transcribes each chunk with Local Open Whisper (faster-whisper, 100% offline & free).
// Live transcript segments and live rolling notes stream to the dashboard live,
// and a comprehensive report + follow-up email draft is generated on demand or at finish.
class MeetingManager {
    constructor({ logsDir }) {
        this.logsDir = logsDir;
        this.dir = path.join(logsDir, 'meetings');
        if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });

        // Initialize Whisper Engine with logsDir
        whisperEngine.init({ logsDir });

        this.current = null;
        this.win = null;
        this.displayBlocker = null;
        this.captureInfo = null;

        this.queue = [];
        this.processing = false;
        this.failedChunks = 0;
        this.liveNotesBusy = false;
        this.segmentsSinceLiveNotes = 0;

        if (ipcMain) {
            ipcMain.on('meeting:chunk', (event, payload) => this.onChunk(payload));
            ipcMain.on('meeting:capture-started', (event, info) => {
                this.captureInfo = info;
                log.info('[Meeting] Capture pipeline running:', info);
                if (this.current) {
                    this.current.capture = info;
                    this.save(this.current);
                }
            });
            ipcMain.on('meeting:capture-error', (event, msg) => {
                log.error('[Meeting] Capture error:', msg);
                if (this.current) {
                    this.current.error = String(msg);
                    this.save(this.current);
                }
            });
            ipcMain.on('meeting:capture-log', (event, msg) => log.info('[Meeting/renderer]', msg));
        }
    }

    isActive() {
        return !!this.current && this.current.status === 'recording';
    }

    filePath(id) {
        return path.join(this.dir, `${String(id).replace(/[^\w-]/g, '')}.json`);
    }

    save(meeting) {
        try {
            writeJsonSafe(this.filePath(meeting.id), meeting);
        } catch (err) {
            log.error('[Meeting] Failed to save meeting file:', err);
        }
    }

    load(id) {
        return readJsonSafe(this.filePath(id), null);
    }

    async start(title) {
        if (this.isActive()) throw new Error('A meeting capture is already running.');

        // Pre-warm local Whisper worker so the first chunk is transcribed immediately
        whisperEngine.ensureWorker().catch(err => {
            log.warn('[Meeting] Pre-warming Whisper note:', err.message);
        });

        const id = String(Date.now());
        this.current = {
            id,
            title: (title && title.trim()) || `Meeting ${localTimestamp().replace('T', ' ')}`,
            startedAt: localTimestamp(),
            endedAt: null,
            status: 'recording',
            engine: 'whisper',
            segments: [],
            liveNotes: {
                summary: 'Listening to meeting...',
                keyPoints: [],
                decisions: [],
                actionItems: [],
                lastUpdated: null
            },
            summary: null,
            emailDraft: null,
            capture: null,
            error: null,
        };
        this.captureInfo = null;
        this.failedChunks = 0;
        this.segmentsSinceLiveNotes = 0;
        this.save(this.current);

        this.win = new BrowserWindow({
            show: false,
            skipTaskbar: true,
            webPreferences: {
                preload: path.join(__dirname, '..', 'capture', 'capture-preload.js'),
                backgroundThrottling: false,
                contextIsolation: true,
                nodeIntegration: false,
            },
        });
        this.win.on('closed', () => { this.win = null; });
        await this.win.loadFile(path.join(__dirname, '..', 'capture', 'capture.html'));

        // Keep the machine (and screen) awake for the whole meeting
        if (this.displayBlocker === null) {
            this.displayBlocker = powerSaveBlocker.start('prevent-display-sleep');
        }

        log.info(`[Meeting] Started capture: ${this.current.title} (${id})`);
        return this.publicMeeting(this.current);
    }

    async stop() {
        if (!this.current) throw new Error('No meeting capture is running.');
        const meeting = this.current;
        meeting.status = 'processing';
        meeting.endedAt = localTimestamp();
        this.save(meeting);

        if (this.win) {
            try { this.win.destroy(); } catch (e) { /* already gone */ }
            this.win = null;
        }
        if (this.displayBlocker !== null) {
            try { powerSaveBlocker.stop(this.displayBlocker); } catch (e) { /* ignore */ }
            this.displayBlocker = null;
        }
        this.captureInfo = null;
        this.current = null;

        log.info(`[Meeting] Stopped capture: ${meeting.title} (${meeting.id})`);

        // Finish transcribing queued chunks, then auto-summarize
        this.finalize(meeting.id).catch(err => log.error('[Meeting] Finalize failed:', err));

        return this.publicMeeting(meeting);
    }

    async finalize(id) {
        await this.drainQueue(120000);
        const meeting = this.load(id);
        if (!meeting) return;
        meeting.status = 'ended';
        this.save(meeting);
        if (meeting.segments.length > 0 && ai.isConfigured()) {
            try {
                await this.summarize(id);
            } catch (err) {
                log.error('[Meeting] Auto-summary failed:', err);
            }
        }
    }

    async drainQueue(timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while ((this.queue.length > 0 || this.processing) && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 500));
        }
    }

    onChunk(payload) {
        if (!this.current || !payload) return;
        if (payload.silent) return; // renderer already skipped silence
        this.queue.push({ ...payload, meetingId: this.current.id });
        this.processQueue();
    }

    async processQueue() {
        if (this.processing) return;
        this.processing = true;
        try {
            while (this.queue.length > 0) {
                const chunk = this.queue.shift();
                try {
                    // Transcribe using Whisper Engine (Local faster-whisper first, then cloud/Gemini fallback)
                    const res = await whisperEngine.transcribe(chunk.data);
                    const rawText = res && res.text ? res.text : '';
                    const text = rawText.replace(/\[SILENCE\]/g, '').trim();

                    if (text) {
                        this.appendSegment(chunk.meetingId, {
                            start: chunk.startedAt,
                            end: chunk.endedAt,
                            text,
                            engine: res.engine || 'local-whisper'
                        });

                        this.segmentsSinceLiveNotes++;
                        // Auto-generate rolling live notes every 3 non-empty chunks (~36s speech)
                        if (this.segmentsSinceLiveNotes >= 3) {
                            this.segmentsSinceLiveNotes = 0;
                            this.generateLiveNotes(chunk.meetingId).catch(err => {
                                log.warn('[Meeting] Rolling live notes update error:', err.message);
                            });
                        }
                    }
                } catch (err) {
                    this.failedChunks++;
                    log.error(`[Meeting] Transcription failed for a chunk (${this.failedChunks} total):`, err.message || err);
                }
            }
        } finally {
            this.processing = false;
        }
    }

    appendSegment(meetingId, segment) {
        if (this.current && this.current.id === meetingId) {
            this.current.segments.push(segment);
            this.save(this.current);
        } else {
            const meeting = this.load(meetingId);
            if (!meeting) return;
            meeting.segments.push(segment);
            this.save(meeting);
        }
    }

    /**
     * Generate or update live structured notes during an active meeting
     */
    async generateLiveNotes(id) {
        const meeting = (this.current && this.current.id === String(id)) ? this.current : this.load(id);
        if (!meeting || !meeting.segments || meeting.segments.length < 1) return null;
        if (this.liveNotesBusy) return meeting.liveNotes;
        this.liveNotesBusy = true;

        try {
            const transcript = meeting.segments.map(s => s.text).join('\n');
            const prompt = `
You are an intelligent real-time executive meeting notes assistant.
Below is the live transcript captured so far from an active meeting titled "${meeting.title}" (started ${meeting.startedAt}).

TRANSCRIPT SO FAR:
${transcript}

Synthesize what has been discussed into clean, structured live notes.
Respond with ONLY valid JSON with this exact schema (no markdown, no code blocks):
{
  "summary": "1-2 sentence quick status of current discussion",
  "keyPoints": ["concise bullet of major point discussed", "..."],
  "decisions": ["concrete decision agreed upon so far (omit if none)", "..."],
  "actionItems": ["owner / person: specific task or follow-up", "..."]
}
`;
            const raw = await ai.generateText(prompt, { label: 'Live meeting notes' });
            const cleaned = String(raw).replace(/```(?:json)?/gi, '').trim();
            const parsed = JSON.parse(cleaned);

            const liveNotes = {
                summary: parsed.summary || 'Discussion ongoing...',
                keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
                decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
                actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
                lastUpdated: localTimestamp()
            };

            meeting.liveNotes = liveNotes;
            this.save(meeting);
            log.info(`[Meeting] Updated live notes for ${meeting.id} (${liveNotes.keyPoints.length} points, ${liveNotes.decisions.length} decisions, ${liveNotes.actionItems.length} action items).`);
            return liveNotes;
        } catch (err) {
            log.warn('[Meeting] Could not generate live notes:', err.message);
            return meeting.liveNotes || null;
        } finally {
            this.liveNotesBusy = false;
        }
    }

    /**
     * Post-meeting comprehensive notes and follow-up email generator
     */
    async summarize(id) {
        const meeting = (this.current && this.current.id === id) ? this.current : this.load(id);
        if (!meeting) throw Object.assign(new Error('Meeting not found.'), { status: 404 });
        if (meeting.segments.length === 0) {
            throw Object.assign(new Error('No transcript captured for this meeting yet.'), { status: 400 });
        }

        const transcript = meeting.segments.map(s => s.text).join('\n');
        const prompt = `
You are an expert executive meeting assistant. Below is the transcript captured from system audio during a meeting titled "${meeting.title}" (started ${meeting.startedAt}).

TRANSCRIPT:
${transcript}

Write a comprehensive, professional meeting report in Markdown with these exact sections:
## Executive Summary
2-4 sentences summarizing the core objective, major topics discussed, and final consensus.

## Key Discussion Points & Context
Bulleted, detailed breakdown of all significant points, updates, and arguments raised during the conversation.

## Decisions & Agreements
Clear list of all decisions finalized during the call.

## Action Items Matrix
Bulleted list with Owner, Action Item, and Deadline (if mentioned).
Format: - **[Owner / Team]**: [Action description] (Due: [Deadline or TBD])

## Next Steps
Immediate next milestones or subsequent meeting plans.
`;
        const summary = await ai.generateText(prompt, { label: 'Meeting summary' });
        meeting.summary = summary;

        // Also generate a ready-to-send follow-up email draft
        try {
            const emailPrompt = `
Based on the meeting titled "${meeting.title}" and its transcript:
${transcript.slice(0, 4000)}

Draft a crisp, polite follow-up email that the meeting organizer can send immediately to all attendees.
Include:
- Subject line
- Brief greeting and thank-you
- Key Takeaways bulleted
- Action Items with Owners
- Closing

Format the email cleanly in plain text so it can be copied directly.
`;
            const emailDraft = await ai.generateText(emailPrompt, { label: 'Follow-up email draft' });
            meeting.emailDraft = emailDraft;
        } catch (e) {
            log.warn('[Meeting] Failed to generate email draft:', e.message);
        }

        this.save(meeting);

        // Extract action items as task suggestions for My Tasks
        try {
            await this.extractSuggestedTasks(meeting, transcript);
        } catch (err) {
            log.error('[Meeting] Task extraction failed:', err);
        }
        return { summary, emailDraft: meeting.emailDraft };
    }

    async extractSuggestedTasks(meeting, transcript) {
        const prompt = `
Below is a meeting transcript. Extract any concrete action items or tasks that were mentioned or assigned.

TRANSCRIPT:
${transcript}

Respond with ONLY a JSON array of short task strings (no markdown, no code fences, no commentary).
Example: ["Review the Q3 budget by Friday", "Send the design doc to the team"]
If there are no action items, respond with: []
`;
        const raw = await ai.generateText(prompt, { label: 'Task extraction' });
        let texts = [];
        try {
            const cleaned = String(raw).replace(/```(?:json)?/gi, '').trim();
            const parsed = JSON.parse(cleaned);
            if (Array.isArray(parsed)) {
                texts = parsed.map(t => String(t).trim()).filter(t => t.length > 0 && t.length < 300);
            }
        } catch (e) {
            log.warn('[Meeting] Could not parse task extraction output:', String(raw).slice(0, 200));
        }

        // Preserve decisions the user already made on identical suggestions
        const previous = meeting.suggestedTasks || [];
        meeting.suggestedTasks = texts.map((text, i) => {
            const prior = previous.find(p => p.text === text && p.status !== 'suggested');
            return prior || { id: `${meeting.id}-${i}`, text, status: 'suggested' };
        });
        this.save(meeting);
        log.info(`[Meeting] Extracted ${texts.length} suggested task(s) for ${meeting.id}.`);
    }

    setSuggestionStatus(meetingId, suggestionId, status) {
        const meeting = (this.current && this.current.id === String(meetingId)) ? this.current : this.load(meetingId);
        if (!meeting) throw Object.assign(new Error('Meeting not found.'), { status: 404 });
        const suggestion = (meeting.suggestedTasks || []).find(s => String(s.id) === String(suggestionId));
        if (!suggestion) throw Object.assign(new Error('Suggestion not found.'), { status: 404 });
        suggestion.status = status;
        this.save(meeting);
        return suggestion;
    }

    publicMeeting(meeting) {
        if (!meeting) return null;
        return { ...meeting };
    }

    list() {
        try {
            return fs.readdirSync(this.dir)
                .filter(f => f.endsWith('.json'))
                .map(f => readJsonSafe(path.join(this.dir, f), null))
                .filter(Boolean)
                .map(m => ({
                    id: m.id,
                    title: m.title,
                    startedAt: m.startedAt,
                    endedAt: m.endedAt,
                    status: m.status,
                    segmentCount: (m.segments || []).length,
                    hasSummary: !!m.summary,
                    hasLiveNotes: !!(m.liveNotes && m.liveNotes.keyPoints && m.liveNotes.keyPoints.length > 0),
                    hasEmailDraft: !!m.emailDraft
                }))
                .sort((a, b) => Number(b.id) - Number(a.id));
        } catch (err) {
            log.error('[Meeting] Failed to list meetings:', err);
            return [];
        }
    }

    get(id) {
        if (this.current && this.current.id === String(id)) return this.publicMeeting(this.current);
        return this.load(id);
    }

    delete(id) {
        if (this.current && this.current.id === String(id)) {
            throw new Error('Cannot delete a meeting while it is recording.');
        }
        const file = this.filePath(id);
        if (fs.existsSync(file)) fs.unlinkSync(file);
    }

    status() {
        return {
            active: this.isActive(),
            capture: this.captureInfo,
            pendingChunks: this.queue.length + (this.processing ? 1 : 0),
            failedChunks: this.failedChunks,
            meeting: this.publicMeeting(this.current),
            whisper: whisperEngine.getSettings()
        };
    }
}

module.exports = { MeetingManager };
