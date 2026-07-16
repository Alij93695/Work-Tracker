const fs = require('fs');

function pad(n) {
    return String(n).padStart(2, '0');
}

// Local calendar date (yyyy-MM-dd). The old code used toISOString(), which is
// UTC — early-morning activity used to land in the previous day's file.
function localDateStr(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Local wall-clock timestamp without timezone suffix; new Date(str) parses it
// back as local time, matching what the dashboard displays.
function localTimestamp(d = new Date()) {
    return `${localDateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function readJsonSafe(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return fallback;
    }
}

// Write via temp file + rename so a crash mid-write can't corrupt the file.
function writeJsonSafe(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
}

module.exports = { localDateStr, localTimestamp, readJsonSafe, writeJsonSafe };
