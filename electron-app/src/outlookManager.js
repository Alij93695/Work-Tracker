const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { shell } = require('electron');
const log = require('./logger');

/**
 * Creates an Outlook meeting using Outlook Desktop COM automation via PowerShell.
 * Opens the pre-filled Outlook Appointment window directly for the user.
 */
function createOutlookDesktopMeeting({ subject, body, startDateTime, durationMinutes = 30, location = 'Online / WeChat Sync' }) {
    return new Promise((resolve, reject) => {
        const safeSubject = String(subject || 'Meeting').replace(/["`$]/g, "'");
        const safeBody = String(body || 'Created via Scribe 1-Tab Meeting Automation').replace(/["`$]/g, "'").replace(/\r?\n/g, '`n');
        const safeLocation = String(location || 'Online').replace(/["`$]/g, "'");

        const psScript = `
        try {
            $outlook = New-Object -ComObject Outlook.Application;
            $appt = $outlook.CreateItem(1); # 1 = olAppointmentItem
            $appt.Subject = "${safeSubject}";
            $appt.Body = "${safeBody}";
            $appt.Location = "${safeLocation}";
            $appt.Start = [DateTime]::Parse("${startDateTime}");
            $appt.Duration = ${parseInt(durationMinutes, 10) || 30};
            $appt.MeetingStatus = 1; # olMeeting
            $appt.Display();
            Write-Output "SUCCESS";
        } catch {
            Write-Error $_.Exception.Message;
        }
        `;

        exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/\n/g, ' ')}"`, (error, stdout, stderr) => {
            if (error || stderr || !stdout.includes('SUCCESS')) {
                log.warn('[OutlookManager] Desktop COM automation returned error/fallback:', stderr || error?.message);
                return resolve({ success: false, method: 'com_failed', error: stderr || error?.message });
            }
            log.info('[OutlookManager] Opened Outlook Desktop meeting window successfully.');
            resolve({ success: true, method: 'outlook_desktop' });
        });
    });
}

/**
 * Creates an Outlook Web Compose Deep-Link and opens it in the browser.
 */
async function openOutlookWebMeeting({ subject, body, startDateTime, durationMinutes = 30, location = 'Online' }) {
    try {
        const startIso = new Date(startDateTime).toISOString();
        const endIso = new Date(new Date(startDateTime).getTime() + durationMinutes * 60000).toISOString();

        const params = new URLSearchParams({
            path: '/calendar/action/compose',
            rru: 'addevent',
            subject: subject || 'Meeting',
            body: body || 'Created via Scribe',
            location: location || 'Online',
            startdt: startIso,
            enddt: endIso
        });

        const webUrl = `https://outlook.office.com/calendar/0/deeplink/compose?${params.toString()}`;
        await shell.openExternal(webUrl);
        log.info('[OutlookManager] Opened Outlook Web deep-link in browser.');
        return { success: true, method: 'outlook_web', url: webUrl };
    } catch (err) {
        log.error('[OutlookManager] Failed to open Outlook Web URL:', err);
        return { success: false, method: 'outlook_web_failed', error: err.message };
    }
}

/**
 * Creates an .ics file and opens it with the OS default calendar handler.
 */
async function createIcsMeetingFile({ subject, body, startDateTime, durationMinutes = 30, location = 'Online', logsDir }) {
    try {
        const startDate = new Date(startDateTime);
        const endDate = new Date(startDate.getTime() + durationMinutes * 60000);

        const formatIcsDate = (d) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

        const icsContent = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Scribe Work Tracker//EN',
            'BEGIN:VEVENT',
            `UID:${Date.now()}@scribe.app`,
            `DTSTAMP:${formatIcsDate(new Date())}`,
            `DTSTART:${formatIcsDate(startDate)}`,
            `DTEND:${formatIcsDate(endDate)}`,
            `SUMMARY:${subject}`,
            `DESCRIPTION:${body.replace(/\n/g, '\\n')}`,
            `LOCATION:${location}`,
            'END:VEVENT',
            'END:VCALENDAR'
        ].join('\r\n');

        const tempIcsPath = path.join(logsDir || process.cwd(), `scribe-meeting-${Date.now()}.ics`);
        fs.writeFileSync(tempIcsPath, icsContent, 'utf8');
        await shell.openPath(tempIcsPath);
        log.info(`[OutlookManager] Created and launched .ics calendar file: ${tempIcsPath}`);
        return { success: true, method: 'ics_file', path: tempIcsPath };
    } catch (err) {
        log.error('[OutlookManager] Failed to create/open .ics file:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Master Book Meeting function: Tries Desktop COM first, fallbacks to Outlook Web & .ics file.
 */
async function bookMeeting({ subject, body, date, time, durationMinutes = 30, contactName = 'Country Trainer', location = 'Online / WeChat Sync', logsDir }) {
    // Default date/time formatting
    let targetDateTime = null;
    try {
        const dateStr = date || new Date(Date.now() + 86400000).toISOString().split('T')[0];
        const timeStr = time || '10:00';
        targetDateTime = new Date(`${dateStr}T${timeStr}:00`).toISOString();
    } catch (e) {
        targetDateTime = new Date(Date.now() + 86400000).toISOString();
    }

    const meetingSubject = subject || `Sync Meeting with ${contactName}`;
    const meetingBody = body || `Scheduled via Scribe 1-Tab Meeting Automation.\nContact: ${contactName}\nContext: Meeting with country trainer regarding recent discussions.`;

    log.info(`[OutlookManager] Booking meeting: "${meetingSubject}" at ${targetDateTime}`);

    // Try 1: Outlook Desktop COM Automation
    const desktopResult = await createOutlookDesktopMeeting({
        subject: meetingSubject,
        body: meetingBody,
        startDateTime: targetDateTime,
        durationMinutes,
        location
    });

    if (desktopResult.success) {
        return desktopResult;
    }

    // Try 2: Outlook Web Deep-Link
    const webResult = await openOutlookWebMeeting({
        subject: meetingSubject,
        body: meetingBody,
        startDateTime: targetDateTime,
        durationMinutes,
        location
    });

    if (webResult.success) {
        return webResult;
    }

    // Try 3: .ics File launch fallback
    return await createIcsMeetingFile({
        subject: meetingSubject,
        body: meetingBody,
        startDateTime: targetDateTime,
        durationMinutes,
        location,
        logsDir
    });
}

module.exports = {
    bookMeeting,
    createOutlookDesktopMeeting,
    openOutlookWebMeeting,
    createIcsMeetingFile
};
