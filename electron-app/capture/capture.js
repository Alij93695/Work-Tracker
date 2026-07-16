// Meeting audio capture (runs in a hidden window).
//
// LISTEN-ONLY: the single source is system loopback audio — everything the
// machine is playing (the meeting audio from Zoom/Teams/VooV/Meet). The
// microphone is never opened; nothing is recorded from or emitted into the
// call, and the meeting apps cannot see this capture. Preferred path is
// getDisplayMedia, which the main process answers with audio:'loopback';
// the legacy chromeMediaSource:'desktop' path is the fallback.
//
// Audio is resampled by WebAudio at 16 kHz mono, accumulated into ~20s
// PCM chunks, encoded as WAV, and shipped to the main process for
// transcription. Chunks whose RMS is below the silence threshold are
// dropped locally so silent stretches never burn API quota.

const CHUNK_SECONDS = 20;
const TARGET_RATE = 16000;
const SILENCE_RMS = 0.0015;

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
    // Preferred: getDisplayMedia — main process answers with audio:'loopback'
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        stream.getVideoTracks().forEach(t => t.stop());
        if (stream.getAudioTracks().length > 0) return stream;
        window.captureAPI.log('getDisplayMedia returned no audio track, trying legacy path...');
    } catch (err) {
        window.captureAPI.log('getDisplayMedia failed (' + err.message + '), trying legacy path...');
    }
    // Fallback: legacy desktop capture (loopback audio on Windows)
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { mandatory: { chromeMediaSource: 'desktop' } },
            video: { mandatory: { chromeMediaSource: 'desktop' } },
        });
        stream.getVideoTracks().forEach(t => t.stop());
        if (stream.getAudioTracks().length > 0) return stream;
    } catch (err) {
        window.captureAPI.log('Legacy desktop audio capture failed: ' + err.message);
    }
    return null;
}

async function start() {
    const systemStream = await getSystemAudio();

    const hasSystem = !!(systemStream && systemStream.getAudioTracks().length > 0);
    if (!hasSystem) {
        window.captureAPI.error('Could not capture system audio.');
        return;
    }

    const ctx = new AudioContext({ sampleRate: TARGET_RATE });
    const processor = ctx.createScriptProcessor(4096, 1, 1);

    ctx.createMediaStreamSource(systemStream).connect(processor);

    // ScriptProcessor only fires when routed to the destination; a zero-gain
    // sink keeps it silent so captured system audio isn't replayed (feedback).
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

    window.captureAPI.started({ system: true, mic: false, sampleRate: ctx.sampleRate });
}

start().catch(err => window.captureAPI.error(err && err.message ? err.message : String(err)));
