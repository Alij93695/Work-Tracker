const { GoogleGenAI } = require('@google/genai');
const log = require('./logger');

// Multi-key rotation — keys come from GEMINI_API_KEYS (comma separated) or
// GEMINI_API_KEY. Each key × model combo is tried with retry + backoff.
let clients = [];

// Each model has its own free-tier quota, so falling through the chain
// effectively multiplies the daily budget.
const TEXT_MODEL_CHAIN = [
    'gemini-2.5-flash',
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash',
];

// Transcription is latency-sensitive and fires every ~20s during meetings,
// so prefer the cheap high-rate-limit models first.
const AUDIO_MODEL_CHAIN = [
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
];

function init() {
    let keys = [];
    if (process.env.GEMINI_API_KEYS) {
        keys = process.env.GEMINI_API_KEYS.split(',').map(k => k.trim()).filter(Boolean);
    } else if (process.env.GEMINI_API_KEY) {
        keys = [process.env.GEMINI_API_KEY.trim()];
    }
    clients = keys.map(apiKey => new GoogleGenAI({ apiKey }));
    if (clients.length === 0) {
        log.warn('[AI] No Gemini API keys found in environment variables — AI features disabled.');
    } else {
        log.info(`[AI] Initialized with ${clients.length} API key(s).`);
    }
}

function isConfigured() {
    return clients.length > 0;
}

async function generate(contents, { models = TEXT_MODEL_CHAIN, retries = 3, label = 'AI' } = {}) {
    if (clients.length === 0) {
        const err = new Error('No Gemini API keys configured. Add GEMINI_API_KEYS to the .env file.');
        err.status = 500;
        throw err;
    }
    let lastError = null;
    for (let keyIdx = 0; keyIdx < clients.length; keyIdx++) {
        const ai = clients[keyIdx];
        for (const model of models) {
            for (let attempt = 0; attempt < retries; attempt++) {
                try {
                    const response = await ai.models.generateContent({ model, contents });
                    log.info(`[${label}] ✓ Key ${keyIdx + 1}/${clients.length} → ${model}`);
                    return response.text;
                } catch (err) {
                    lastError = err;
                    // Daily quota exhausted → this model is dead for this key today
                    if (err.status === 429 && err.message && err.message.includes('PerDay')) {
                        log.warn(`[${label}] Key ${keyIdx + 1} daily quota exhausted for ${model}, trying next model...`);
                        break;
                    }
                    // Per-minute rate limit / overload → wait and retry same combo
                    if (err.status === 429 || err.status === 503) {
                        const waitMs = Math.pow(2, attempt) * 2000;
                        log.warn(`[${label}] Key ${keyIdx + 1} rate limited on ${model}, retrying in ${waitMs}ms...`);
                        await new Promise(r => setTimeout(r, waitMs));
                        continue;
                    }
                    log.warn(`[${label}] Key ${keyIdx + 1} error on ${model}: ${err.message}`);
                    break;
                }
            }
        }
        log.warn(`[${label}] Key ${keyIdx + 1} fully exhausted, trying next key...`);
    }
    throw lastError || new Error('All AI keys and models exhausted. Please try again later.');
}

function generateText(promptText, opts = {}) {
    return generate(promptText, opts);
}

const TRANSCRIBE_PROMPT =
    'Transcribe the spoken audio in this recording verbatim. ' +
    'Write each speaker turn on its own line. Do not add commentary, labels, or timestamps. ' +
    'If there is no intelligible human speech (silence, music, or noise only), output exactly: [SILENCE]';

// base64Wav: 16-bit PCM WAV audio, base64 encoded
function transcribeAudio(base64Wav) {
    const contents = [{
        role: 'user',
        parts: [
            { inlineData: { mimeType: 'audio/wav', data: base64Wav } },
            { text: TRANSCRIBE_PROMPT },
        ],
    }];
    // Only 1 retry pass per combo — a meeting produces a chunk every ~20s and
    // we'd rather drop one chunk than fall behind the live audio.
    return generate(contents, { models: AUDIO_MODEL_CHAIN, retries: 2, label: 'Transcribe' });
}

module.exports = { init, isConfigured, generateText, transcribeAudio };
