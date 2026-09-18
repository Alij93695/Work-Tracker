const path = require('path');
const fs = require('fs');
const { Notification } = require('electron');
const log = require('./logger');
const { readJsonSafe, writeJsonSafe } = require('./util');

class ReminderEngine {
    constructor({ logsDir, trayIconPath }) {
        this.logsDir = logsDir;
        this.trayIconPath = trayIconPath;
        this.tasksFile = path.join(logsDir, 'tasks.json');
        this.scheduledMeetingsFile = path.join(logsDir, 'scheduled_meetings.json');
        this.timer = null;
    }

    start() {
        if (this.timer) clearInterval(this.timer);
        log.info('[ReminderEngine] Started upcoming meeting & task notification engine (15s interval).');
        this.check();
        this.timer = setInterval(() => this.check(), 15000);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        log.info('[ReminderEngine] Stopped.');
    }

    addScheduledMeeting({ subject, contactName, date, time, durationMinutes = 30, location = 'Online' }) {
        const meetings = readJsonSafe(this.scheduledMeetingsFile, []);
        let startIso = null;
        try {
            const d = date || new Date(Date.now() + 86400000).toISOString().split('T')[0];
            const t = time || '10:00';
            startIso = new Date(`${d}T${t}:00`).toISOString();
        } catch (e) {
            startIso = new Date(Date.now() + 3600000).toISOString();
        }

        const newMeeting = {
            id: String(Date.now()),
            subject: subject || `Meeting with ${contactName || 'Trainer'}`,
            contactName: contactName || 'Country Trainer',
            date: date || startIso.split('T')[0],
            time: time || '10:00',
            startDateTime: startIso,
            durationMinutes,
            location,
            createdAt: new Date().toISOString(),
            alerted15m: false,
            alerted5m: false,
            alertedStart: false
        };

        meetings.push(newMeeting);
        writeJsonSafe(this.scheduledMeetingsFile, meetings);
        log.info(`[ReminderEngine] Scheduled meeting saved for notifications: "${newMeeting.subject}" at ${newMeeting.startDateTime}`);
        return newMeeting;
    }

    check() {
        try {
            const now = Date.now();
            this.checkTasks(now);
            this.checkMeetings(now);
        } catch (err) {
            log.error('[ReminderEngine] Check error:', err);
        }
    }

    checkTasks(now) {
        const tasks = readJsonSafe(this.tasksFile, null);
        if (!tasks || !Array.isArray(tasks)) return;

        let changed = false;
        const updated = tasks.map(task => {
            if (task.completed || !task.reminderAt) return task;

            const remTime = new Date(task.reminderAt).getTime();
            if (isNaN(remTime)) return task;

            const diffMs = remTime - now;

            // 15-minute advance task warning
            if (diffMs > 5 * 60 * 1000 && diffMs <= 15 * 60 * 1000 && !task.alerted15m) {
                const mins = Math.round(diffMs / 60000);
                this.notify('⏰ Task Due Soon (in ' + mins + ' mins)', task.text);
                changed = true;
                return { ...task, alerted15m: true };
            }

            // 5-minute advance task warning
            if (diffMs > 0 && diffMs <= 5 * 60 * 1000 && !task.alerted5m) {
                const mins = Math.max(1, Math.round(diffMs / 60000));
                this.notify('⚠️ Task Urgent (Due in ' + mins + ' mins)', task.text);
                changed = true;
                return { ...task, alerted5m: true };
            }

            // At due time
            if (diffMs <= 0 && !task.reminderFired) {
                this.notify('🔔 Task Due Right Now!', task.text);
                const { reminderAt, ...rest } = task;
                changed = true;
                return { ...rest, reminderFired: true, alerted15m: true, alerted5m: true };
            }

            return task;
        });

        if (changed) writeJsonSafe(this.tasksFile, updated);
    }

    checkMeetings(now) {
        const meetings = readJsonSafe(this.scheduledMeetingsFile, null);
        if (!meetings || !Array.isArray(meetings)) return;

        let changed = false;
        const updated = meetings.map(m => {
            const startMs = new Date(m.startDateTime).getTime();
            if (isNaN(startMs)) return m;

            const diffMs = startMs - now;

            // 15-minute advance meeting notification
            if (diffMs > 5 * 60 * 1000 && diffMs <= 15 * 60 * 1000 && !m.alerted15m) {
                const mins = Math.round(diffMs / 60000);
                this.notify(`📅 Upcoming Meeting in ${mins} Mins`, `${m.subject} with ${m.contactName}`);
                changed = true;
                return { ...m, alerted15m: true };
            }

            // 5-minute advance meeting notification
            if (diffMs > 0 && diffMs <= 5 * 60 * 1000 && !m.alerted5m) {
                const mins = Math.max(1, Math.round(diffMs / 60000));
                this.notify(`🚨 Meeting Starting in ${mins} Mins!`, `${m.subject} with ${m.contactName}`);
                changed = true;
                return { ...m, alerted5m: true };
            }

            // At meeting start time
            if (diffMs <= 0 && !m.alertedStart) {
                this.notify(`🔴 Meeting Starting NOW!`, `${m.subject} (${m.contactName})`);
                changed = true;
                return { ...m, alertedStart: true, alerted15m: true, alerted5m: true };
            }

            return m;
        });

        if (changed) writeJsonSafe(this.scheduledMeetingsFile, updated);
    }

    notify(title, body) {
        try {
            new Notification({
                title,
                body: String(body || '').slice(0, 150),
                icon: this.trayIconPath,
                urgency: 'critical'
            }).show();
            log.info(`[ReminderEngine] Fired notification: "${title}" - "${body}"`);
        } catch (err) {
            log.error('[ReminderEngine] Notification failed:', err);
        }
    }

    getUpcomingAlerts() {
        const now = Date.now();
        const tasks = readJsonSafe(this.tasksFile, []);
        const meetings = readJsonSafe(this.scheduledMeetingsFile, []);

        const upcomingTasks = tasks
            .filter(t => !t.completed && t.reminderAt && new Date(t.reminderAt).getTime() > now && new Date(t.reminderAt).getTime() <= now + 24 * 3600 * 1000)
            .map(t => ({
                id: t.id,
                type: 'task',
                title: t.text,
                dueAt: t.reminderAt,
                dueMs: new Date(t.reminderAt).getTime(),
                minsLeft: Math.round((new Date(t.reminderAt).getTime() - now) / 60000)
            }));

        const upcomingMeetings = meetings
            .filter(m => new Date(m.startDateTime).getTime() > now - 1800000 && new Date(m.startDateTime).getTime() <= now + 24 * 3600 * 1000)
            .map(m => ({
                id: m.id,
                type: 'meeting',
                title: m.subject,
                contactName: m.contactName,
                dueAt: m.startDateTime,
                dueMs: new Date(m.startDateTime).getTime(),
                minsLeft: Math.round((new Date(m.startDateTime).getTime() - now) / 60000)
            }));

        const all = [...upcomingTasks, ...upcomingMeetings].sort((a, b) => a.dueMs - b.dueMs);
        return all;
    }
}

module.exports = ReminderEngine;
