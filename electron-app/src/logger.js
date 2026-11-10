const fs = require('fs');
const path = require('path');

const MAX_LOG_BYTES = 5 * 1024 * 1024;

let logFile = null;

function init(dir) {
    logFile = path.join(dir, 'app.log');
    rotateIfNeeded();
}

function rotateIfNeeded() {
    if (!logFile) return;
    try {
        const stat = fs.statSync(logFile);
        if (stat.size > MAX_LOG_BYTES) {
            fs.renameSync(logFile, logFile + '.1');
        }
    } catch (e) { /* file missing or locked — ignore */ }
}

function fmt(a) {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object' && a !== null) {
        try { return JSON.stringify(a); } catch (e) { return String(a); }
    }
    return String(a);
}

function line(level, args) {
    const msg = `[${new Date().toISOString()}] [${level}] ${args.map(fmt).join(' ')}`;
    try { console.log(msg); } catch (e) { /* no console stream */ }
    if (logFile) {
        try {
            fs.appendFileSync(logFile, msg + '\n');
        } catch (e) { /* disk unavailable — keep running */ }
    }
}

setInterval(rotateIfNeeded, 10 * 60 * 1000).unref();

module.exports = {
    init,
    info: (...a) => line('INFO', a),
    warn: (...a) => line('WARN', a),
    error: (...a) => line('ERROR', a),
};
