const { GoogleGenAI } = require('@google/genai');
const log = require('./logger');

// Provider configurations & keys
let providersList = [];
let geminiClients = [];

const TEXT_MODEL_CHAIN = [
    'gemini-2.5-flash',
    'gemini-3.5-flash-lite',
];

const AUDIO_MODEL_CHAIN = [
    'gemini-3.5-flash-lite',
    'gemini-2.5-flash',
];

// The gateway rejects bare model names with 400 "Ambiguous model ... use provider/model prefix".
const OMNIROUTE_DEFAULT_MODEL = 'auto/best-fast';

function isPlaceholder(key) {
    if (!key) return true;
    const str = String(key).trim();
    return !str || str.includes('YOUR_') || str.includes('paste');
}

function init() {
    providersList = [];

    // Helper to add OpenAI-compatible providers
    const addOpenAiProvider = (name, envKey, endpoint, defaultModel, modelEnvKey, extraHeaders = {}, allowEmptyKey = false) => {
        let keys = [];
        if (process.env[envKey + 'S']) {
            keys = process.env[envKey + 'S'].split(',').map(k => k.trim()).filter(k => !isPlaceholder(k));
        } else if (process.env[envKey]) {
            const k = process.env[envKey].trim();
            if (!isPlaceholder(k)) keys = [k];
        } else if (allowEmptyKey) {
            keys = ['sk-omniroute'];
        }

        const model = (modelEnvKey && process.env[modelEnvKey]) || defaultModel;
        keys.forEach((apiKey, index) => {
            providersList.push({
                name: keys.length > 1 ? `${name} (Key ${index + 1})` : name,
                type: 'openai-compatible',
                endpoint,
                apiKey,
                model,
                extraHeaders
            });
        });
    };

    // 1. OpenRouter
    addOpenAiProvider('OpenRouter', 'OPENROUTER_API_KEY', 'https://openrouter.ai/api/v1/chat/completions', 'google/gemini-2.5-flash', 'OPENROUTER_MODEL', {
        'HTTP-Referer': 'https://worktracker.app',
        'X-Title': 'Work Tracker Desktop'
    });

    // 2. Groq
    addOpenAiProvider('Groq', 'GROQ_API_KEY', 'https://api.groq.com/openai/v1/chat/completions', 'llama-3.3-70b-versatile', 'GROQ_MODEL');

    // 3. GitHub Models
    addOpenAiProvider('GitHub Models', 'GITHUB_TOKEN', 'https://models.inference.ai.azure.com/chat/completions', 'gpt-4o-mini', 'GITHUB_MODEL');

    // 4. Cerebras
    addOpenAiProvider('Cerebras', 'CEREBRAS_API_KEY', 'https://api.cerebras.ai/v1/chat/completions', 'llama3.1-70b', 'CEREBRAS_MODEL');

    // 5. SambaNova
    addOpenAiProvider('SambaNova', 'SAMBANOVA_API_KEY', 'https://api.sambanova.ai/v1/chat/completions', 'Meta-Llama-3.3-70B-Instruct', 'SAMBANOVA_MODEL');

    // 6. Mistral AI
    addOpenAiProvider('Mistral AI', 'MISTRAL_API_KEY', 'https://api.mistral.ai/v1/chat/completions', 'mistral-small-latest', 'MISTRAL_MODEL');

    // 7. Cohere
    addOpenAiProvider('Cohere', 'COHERE_API_KEY', 'https://api.cohere.com/v2/chat', 'command-r-plus', 'COHERE_MODEL');

    // 8. Google Gemini (Native SDK)
    let gKeys = [];
    if (process.env.GEMINI_API_KEYS) {
        gKeys = process.env.GEMINI_API_KEYS.split(',').map(k => k.trim()).filter(k => !isPlaceholder(k));
    } else if (process.env.GEMINI_API_KEY) {
        const k = process.env.GEMINI_API_KEY.trim();
        if (!isPlaceholder(k)) gKeys = [k];
    }
    geminiClients = gKeys.map(apiKey => new GoogleGenAI({ apiKey }));
    if (geminiClients.length > 0) {
        providersList.push({
            name: `Google Gemini (${geminiClients.length} key(s))`,
            type: 'gemini',
            clients: geminiClients
        });
    }

    // 9. OmniRoute Gateway (diegosouzapw/OmniRoute - 290+ providers & 500+ models).
    // Registered last: the gateway routes to free backends that answer in 7-14s, so it is a
    // safety net for when the direct providers above are exhausted, not a fast path.
    const omniBase = process.env.OMNIROUTE_BASE_URL ? process.env.OMNIROUTE_BASE_URL.replace(/\/$/, '') : 'http://localhost:8080/v1';
    const omniEndpoint = process.env.OMNIROUTE_ENDPOINT || `${omniBase}/chat/completions`;
    const hasOmniConfig = process.env.OMNIROUTE_BASE_URL || process.env.OMNIROUTE_ENDPOINT || (process.env.OMNIROUTE_API_KEY && !isPlaceholder(process.env.OMNIROUTE_API_KEY));
    if (hasOmniConfig) {
        // A machine-level OMNIROUTE_MODEL overrides .env (dotenv never replaces an existing
        // process.env value), so an unprefixed id has to be corrected here rather than in .env.
        let omniModel = process.env.OMNIROUTE_MODEL;
        if (omniModel && !omniModel.includes('/')) {
            log.warn(`[AI Engine] OMNIROUTE_MODEL='${omniModel}' has no provider/model prefix — using '${OMNIROUTE_DEFAULT_MODEL}'.`);
            omniModel = null;
        }
        addOpenAiProvider('OmniRoute Gateway', 'OMNIROUTE_API_KEY', omniEndpoint, omniModel || OMNIROUTE_DEFAULT_MODEL, null, {
            'X-Title': 'Work Tracker Desktop'
        }, true);
    }

    if (providersList.length === 0) {
        log.warn('[AI Engine] No API keys configured in environment variables — AI features disabled.');
    } else {
        const providerNames = providersList.map(p => p.name).join(', ');
        log.info(`[AI Engine] Initialized with ${providersList.length} provider pipeline: [${providerNames}]`);
    }
}

function isConfigured() {
    return providersList.length > 0;
}

function getProviderInfo() {
    return {
        configuredCount: providersList.length,
        providers: providersList.map(p => ({ name: p.name, type: p.type, model: p.model || 'multi-model' }))
    };
}

async function callOpenAiCompatibleApi(provider, contents) {
    let messages = [];
    if (typeof contents === 'string') {
        messages = [{ role: 'user', content: contents }];
    } else if (Array.isArray(contents)) {
        messages = contents.map(item => {
            if (typeof item === 'string') return { role: 'user', content: item };
            if (item.role && item.parts) {
                const textPart = item.parts.find(p => p.text);
                const audioPart = item.parts.find(p => p.inlineData && p.inlineData.mimeType && p.inlineData.mimeType.startsWith('audio/'));
                const imagePart = item.parts.find(p => p.inlineData && p.inlineData.mimeType && p.inlineData.mimeType.startsWith('image/'));
                if (audioPart) {
                    return {
                        role: 'user',
                        content: [
                            { type: 'text', text: textPart ? textPart.text : '' },
                            {
                                type: 'input_audio',
                                input_audio: {
                                    data: audioPart.inlineData.data,
                                    format: 'wav'
                                }
                            }
                        ]
                    };
                }
                if (imagePart) {
                    return {
                        role: 'user',
                        content: [
                            { type: 'text', text: textPart ? textPart.text : '' },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`
                                }
                            }
                        ]
                    };
                }
                return { role: item.role === 'user' ? 'user' : 'assistant', content: textPart ? textPart.text : '' };
            }
            return item;
        });
    }

    const headers = Object.assign({
        'Authorization': `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json'
    }, provider.extraHeaders || {});

    const response = await fetch(provider.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: provider.model,
            messages: messages,
            stream: false
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        const err = new Error(`${provider.name} API error ${response.status}: ${errorText}`);
        err.status = response.status;
        throw err;
    }

    const data = await response.json();
    if (data.choices && data.choices[0] && data.choices[0].message) {
        return data.choices[0].message.content;
    }
    // Cohere v2 structure fallback
    if (data.message && data.message.content && data.message.content[0]) {
        return data.message.content[0].text;
    }
    throw new Error(`${provider.name} API response did not contain text content.`);
}

async function generate(contents, { models = TEXT_MODEL_CHAIN, retries = 2, label = 'AI' } = {}) {
    if (providersList.length === 0) {
        const err = new Error('No API keys configured. Please add API keys to your .env file.');
        err.status = 500;
        throw err;
    }

    let lastError = null;

    // Iterate through all active providers in order
    for (let pIdx = 0; pIdx < providersList.length; pIdx++) {
        const provider = providersList[pIdx];

        if (provider.type === 'openai-compatible') {
            for (let attempt = 0; attempt < retries; attempt++) {
                try {
                    const result = await callOpenAiCompatibleApi(provider, contents);
                    log.info(`[${label}] ✓ ${provider.name} → ${provider.model}`);
                    return result;
                } catch (err) {
                    lastError = err;
                    log.warn(`[${label}] ${provider.name} attempt ${attempt + 1} failed: ${err.message}`);
                    if (err.status === 429 || err.status === 503) {
                        const waitMs = Math.pow(2, attempt) * 1500;
                        await new Promise(r => setTimeout(r, waitMs));
                        continue;
                    }
                    break; // Non-retryable error → rotate to next provider
                }
            }
            log.warn(`[${label}] ${provider.name} exhausted, rotating to next provider...`);
        } else if (provider.type === 'gemini') {
            for (let keyIdx = 0; keyIdx < provider.clients.length; keyIdx++) {
                const aiClient = provider.clients[keyIdx];
                for (const model of models) {
                    for (let attempt = 0; attempt < retries; attempt++) {
                        try {
                            const response = await aiClient.models.generateContent({ model, contents });
                            log.info(`[${label}] ✓ Google Gemini Key ${keyIdx + 1}/${provider.clients.length} → ${model}`);
                            return response.text;
                        } catch (err) {
                            lastError = err;
                            if (err.status === 429 && err.message && err.message.includes('PerDay')) {
                                log.warn(`[${label}] Gemini Key ${keyIdx + 1} daily quota exhausted for ${model}, trying next model...`);
                                break;
                            }
                            if (err.status === 429 || err.status === 503) {
                                const waitMs = Math.pow(2, attempt) * 1500;
                                await new Promise(r => setTimeout(r, waitMs));
                                continue;
                            }
                            log.warn(`[${label}] Gemini Key ${keyIdx + 1} error on ${model}: ${err.message}`);
                            break;
                        }
                    }
                }
            }
            log.warn(`[${label}] Google Gemini provider exhausted, rotating to next provider...`);
        }
    }

    throw lastError || new Error('All AI providers in rotation chain exhausted. Please check your API keys or quotas.');
}

function generateText(promptText, opts = {}) {
    return generate(promptText, opts);
}

const TRANSCRIBE_PROMPT =
    'Transcribe the spoken audio in this recording verbatim. ' +
    'Write each speaker turn on its own line. Do not add commentary, labels, or timestamps. ' +
    'If there is no intelligible human speech (silence, music, or noise only), output exactly: [SILENCE]';

function transcribeAudio(base64Wav) {
    const contents = [{
        role: 'user',
        parts: [
            { inlineData: { mimeType: 'audio/wav', data: base64Wav } },
            { text: TRANSCRIBE_PROMPT },
        ],
    }];
    return generate(contents, { models: AUDIO_MODEL_CHAIN, retries: 2, label: 'Transcribe' });
}

function analyzeImage(base64Png, promptText) {
    const contents = [{
        role: 'user',
        parts: [
            { inlineData: { mimeType: 'image/png', data: base64Png } },
            { text: promptText },
        ],
    }];
    return generate(contents, { models: TEXT_MODEL_CHAIN, retries: 2, label: 'Vision' });
}

module.exports = { init, isConfigured, getProviderInfo, generateText, transcribeAudio, analyzeImage };
