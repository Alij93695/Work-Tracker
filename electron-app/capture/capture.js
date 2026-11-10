// Meeting audio capture (runs in a hidden window).
//
// Dual-Source Local Capture:
// 1. System loopback audio (what the speakers/headphones play: Zoom/Teams/Meet/browser).
// 2. Local microphone (user's speech into laptop mic).
//
// Both streams are mixed by WebAudio at 16 kHz mono, accumulated into ~12s
// PCM chunks, encoded as WAV, and shipped to the main process for transcription.
// Chunks whose RMS is below the silence threshold are dropped locally so silence
// never wastes compute or storage.

const CHUNK_SECONDS = 12;
const TARGET_RATE = 16000;
const SILENCE_RMS = 0.0008;

function pad(n) { return String(n).padStart(2, '0'); }
function localTimestamp(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function encodeWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeString = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);          // PCM chunk size
    view.setUint16(20, 1, true);           // PCM format
    view.setUint16(22, 1, true);           // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);           // block align
    view.setUint16(34, 16, true);          // bits per sample
    writeString(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
}

function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(binary);
}

async function getSystemAudio() {
    // 1. Try legacy desktop capture (instant on Windows with audio: loopback)
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { mandatory: { chromeMediaSource: 'desktop' } },
            video: { mandatory: { chromeMediaSource: 'desktop' } },
        });
        stream.getVideoTracks().forEach(t => t.stop());
        if (stream.getAudioTracks().length > 0) return stream;
    } catch (err) {
        window.captureAPI.log('Desktop capture via getUserMedia failed: ' + err.message);
    }

    // 2. Fallback: getDisplayMedia with quick timeout
    try {
        const displayPromise = navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('getDisplayMedia timeout (3s)')), 3000));
        const stream = await Promise.race([displayPromise, timeoutPromise]);
        stream.getVideoTracks().forEach(t => t.stop());
        if (stream.getAudioTracks().length > 0) return stream;
    } catch (err) {
        window.captureAPI.log('getDisplayMedia failed: ' + err.message);
    }

    return null;
}

async function getMicAudio() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
        });
        if (stream && stream.getAudioTracks().length > 0) return stream;
    } catch (err) {
        window.captureAPI.log('Microphone capture failed or unavailable: ' + err.message);
    }
    return null;
}

async function start() {
    const systemStream = await getSystemAudio();
    const micStream = await getMicAudio();

    const hasSystem = !!(systemStream && systemStream.getAudioTracks().length > 0);
    const hasMic = !!(micStream && micStream.getAudioTracks().length > 0);

    if (!hasSystem && !hasMic) {
        window.captureAPI.error('Could not capture audio: neither system loopback nor microphone is available.');
        return;
    }

    const ctx = new AudioContext({ sampleRate: TARGET_RATE });
    if (ctx.state === 'suspended') {
        await ctx.resume();
    }
    const processor = ctx.createScriptProcessor(4096, 1, 1);

    if (hasSystem) {
        try {
            ctx.createMediaStreamSource(systemStream).connect(processor);
        } catch (e) {
            window.captureAPI.log('Error routing system audio: ' + e.message);
        }
    }
    if (hasMic) {
        try {
            ctx.createMediaStreamSource(micStream).connect(processor);
        } catch (e) {
            window.captureAPI.log('Error routing microphone: ' + e.message);
        }
    }

    // ScriptProcessor only fires when routed to destination; zero-gain sink keeps it silent
    const sink = ctx.createGain();
    sink.gain.value = 0;
    processor.connect(sink);
    sink.connect(ctx.destination);

    let chunks = [];
    let sampleCount = 0;
    let chunkStartedAt = localTimestamp();

    function flush() {
        if (sampleCount === 0) return;
        const merged = new Float32Array(sampleCount);
        let offset = 0;
        for (const c of chunks) { merged.set(c, offset); offset += c.length; }
        chunks = [];
        sampleCount = 0;

        const startedAt = chunkStartedAt;
        const endedAt = localTimestamp();
        chunkStartedAt = endedAt;

        let sumSquares = 0;
        for (let i = 0; i < merged.length; i++) sumSquares += merged[i] * merged[i];
        const rms = Math.sqrt(sumSquares / merged.length);

        if (rms < SILENCE_RMS) {
            window.captureAPI.chunk({ silent: true, startedAt, endedAt, rms });
            return;
        }
        const wav = encodeWav(merged, ctx.sampleRate);
        window.captureAPI.chunk({
            data: bufferToBase64(wav),
            startedAt,
            endedAt,
            rms,
            durationSec: merged.length / ctx.sampleRate,
        });
    }

    processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(input));
        sampleCount += input.length;
        if (sampleCount >= TARGET_RATE * CHUNK_SECONDS) flush();
    };

    window.addEventListener('beforeunload', () => {
        if (systemStream) systemStream.getTracks().forEach(t => t.stop());
        if (micStream) micStream.getTracks().forEach(t => t.stop());
        try { ctx.close(); } catch (e) {}
    });

    window.captureAPI.started({ system: hasSystem, mic: hasMic, sampleRate: ctx.sampleRate });
}

start().catch(err => window.captureAPI.error(err && err.message ? err.message : String(err)));
