const ai = require('./ai');
const log = require('./logger');

/**
 * AI Transformation Engine for Dictation.
 * Cleans up raw spoken text, handles backtrack intent resolution,
 * developer syntax formatting, voice snippets, and list structuring.
 */
async function processDictation(rawSpeechText, {
    dictionary = [],
    snippets = [],
    whisperMode = false,
    developerMode = true,
    autoPunctuation = true,
    fillerRemoval = true,
    backtrackParsing = true
} = {}) {
    if (!rawSpeechText || typeof rawSpeechText !== 'string' || !rawSpeechText.trim()) {
        return { text: '', raw: rawSpeechText || '' };
    }

    const trimmedInput = rawSpeechText.trim();
    log.info(`[DictationAi] Processing speech input (${trimmedInput.length} chars): "${trimmedInput}"`);

    // 1. Direct Voice Snippet Trigger Check
    // If the spoken text matches a custom voice trigger exactly or starts with "insert/paste [trigger]"
    const lowerInput = trimmedInput.toLowerCase().replace(/^(?:insert|paste|expand)\s+/i, '').trim();
    const matchedSnippet = snippets.find(s => s.trigger.toLowerCase() === lowerInput || s.trigger.toLowerCase() === trimmedInput.toLowerCase());

    if (matchedSnippet) {
        log.info(`[DictationAi] Matched voice snippet trigger: "${matchedSnippet.trigger}" -> expanding.`);
        return {
            text: matchedSnippet.expansion,
            raw: rawSpeechText,
            isSnippet: true,
            snippetTrigger: matchedSnippet.trigger
        };
    }

    // Prepare dictionary terms string
    const dictionaryContext = dictionary && dictionary.length > 0
        ? `Preserve and use these exact specialized terms/spelling if mentioned: [${dictionary.join(', ')}].`
        : '';

    // Prepare snippets lookup string for inline snippet replacements
    const snippetsContext = snippets && snippets.length > 0
        ? `If the user speaks a snippet trigger phrase like ${snippets.map(s => `"${s.trigger}"`).join(', ')}, replace that phrase with its exact expansion.`
        : '';

    const promptText = `
You are Scribe AI, an elite real-time speech editor and developer dictation assistant.
Your job is to transform raw spoken audio text into polished, publication-ready text or code syntax.

RAW SPOKEN INPUT:
"${trimmedInput}"

RULES & TRANSFORMATION PIPELINE:
1. FILLER REMOVAL: Remove all spoken fillers, stutters, and pauses ("um", "uh", "er", "you know", "like", "so basically", repeated words, false starts).
2. BACKTRACK & INTENT RESOLUTION: Recognize when the speaker changes their mind mid-sentence (e.g. "Let's schedule for 2 PM... actually scratch that, 3 PM tomorrow"). Resolve the sentence to ONLY state the final intended meaning ("Let's schedule for 3 PM tomorrow").
3. CONTEXTUAL FORMATTING & LISTS: Convert spoken structure cues ("new line", "new paragraph", "bullet one", "bullet two", "numbered list") into clean formatted paragraphs or markdown lists.
4. DEVELOPER & SYNTAX AWARENESS:
   - If the speaker dictates code identifiers, apply the requested casing:
     - "camel case [name]" -> camelCase (e.g. "camel case user profile" -> userProfile)
     - "snake case [name]" -> snake_case (e.g. "snake case order count" -> order_count)
     - "kebab case [name]" -> kebab-case (e.g. "kebab case main container" -> main-container)
     - "pascal case [name]" -> PascalCase (e.g. "pascal case payment gateway" -> PaymentGateway)
   - Convert spoken CLI commands ("git commit message fix login bug") to exact terminal syntax (\`git commit -m "fix login bug"\`).
   - Parse spoken Cursor/Windsurf file tags ("at file index dot jsx") to \`@index.jsx\`.
5. PUNCTUATION & CAPITALIZATION: Add natural, accurate punctuation and sentence capitalization.
6. DICTIONARY & VOCABULARY: ${dictionaryContext}
7. MULTI-LANGUAGE & CODE-SWITCHING: Keep the spoken language intact (including mixed English/other language switching). Do not translate unless explicitly commanded.
${snippetsContext}

IMPORTANT: Output ONLY the final polished result text. Do NOT include commentary, quotes around the output, or explanations.
`;

    try {
        const polishedText = await ai.generateText(promptText, { label: 'Dictation AI' });
        const cleanedResult = String(polishedText || '')
            .replace(/^["'`]|["'`]$/g, '') // remove surrounding quotes if any
            .trim();

        log.info(`[DictationAi] Polished Result (${cleanedResult.length} chars): "${cleanedResult}"`);

        return {
            text: cleanedResult,
            raw: rawSpeechText,
            isSnippet: false
        };
    } catch (err) {
        log.error('[DictationAi] Transformation failed, returning original input:', err.message);
        return {
            text: trimmedInput,
            raw: rawSpeechText,
            error: err.message
        };
    }
}

module.exports = {
    processDictation
};
