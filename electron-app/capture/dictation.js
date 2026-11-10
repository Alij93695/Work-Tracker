// Universal Voice Dictation Microphone Audio Capture (runs in a hidden window).
const TARGET_RATE = 16000;

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

let micStream = null;
let audioCtx = null;
let processor = null;
let recordedChunks = [];
let totalSamples = 0;

async function startRecording() {
    try {
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            }
        });

        audioCtx = new AudioContext({ sampleRate: TARGET_RATE });
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }

        const source = audioCtx.createMediaStreamSource(micStream);
        processor = audioCtx.createScriptProcessor(4096, 1, 1);

        recordedChunks = [];
        totalSamples = 0;

        processor.onaudioprocess = (e) => {
            const input = e.inputBuffer.getChannelData(0);
            recordedChunks.push(new Float32Array(input));
            totalSamples += input.length;
        };

        source.connect(processor);
        const sink = audioCtx.createGain();
        sink.gain.value = 0;
        processor.connect(sink);
        sink.connect(audioCtx.destination);

    } catch (err) {
        window.dictationAPI.sendError(err.message || String(err));
    }
}

function stopAndSend() {
    try {
        if (micStream) {
            micStream.getTracks().forEach(t => t.stop());
            micStream = null;
        }
        if (processor) {
            processor.disconnect();
            processor = null;
        }
        if (audioCtx) {
            audioCtx.close();
            audioCtx = null;
        }

        if (totalSamples === 0) {
            window.dictationAPI.sendAudioReady({ audioBase64: null });
            return;
        }

        const merged = new Float32Array(totalSamples);
        let offset = 0;
        for (const c of recordedChunks) {
            merged.set(c, offset);
            offset += c.length;
        }

        const wav = encodeWav(merged, TARGET_RATE);
        const b64 = bufferToBase64(wav);
        window.dictationAPI.sendAudioReady({ audioBase64: b64 });
    } catch (err) {
        window.dictationAPI.sendError(err.message || String(err));
    }
}

window.dictationAPI.onStopCapture(() => {
    stopAndSend();
});

startRecording();
