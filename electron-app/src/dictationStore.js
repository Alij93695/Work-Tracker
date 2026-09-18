const path = require('path');
const fs = require('fs');
const log = require('./logger');
const { readJsonSafe, writeJsonSafe } = require('./util');

class DictationStore {
    constructor({ logsDir }) {
        this.dictionaryFile = path.join(logsDir, 'dictionary.json');
        this.snippetsFile = path.join(logsDir, 'snippets.json');
        this.settingsFile = path.join(logsDir, 'dictation_settings.json');

        this.initDefaults();
    }

    initDefaults() {
        // Default dictionary terms
        if (!fs.existsSync(this.dictionaryFile)) {
            const defaultDictionary = [
                'Scribe',
                'Antigravity',
                'Gemini',
                'WeChat',
                'VooV',
                'Cursor',
                'Windsurf',
                'Notion',
                'React',
                'Electron',
                'PowerShell',
                'TypeScript'
            ];
            writeJsonSafe(this.dictionaryFile, defaultDictionary);
        }

        // Default voice snippets
        if (!fs.existsSync(this.snippetsFile)) {
            const defaultSnippets = [
                {
                    id: '1',
                    trigger: 'my link',
                    expansion: 'https://calendly.com/meeting-schedule',
                    description: 'Calendly scheduling link'
                },
                {
                    id: '2',
                    trigger: 'my bio',
                    expansion: 'Product Engineer specializing in AI automation, desktop software, and full-stack development.',
                    description: 'Short professional bio'
                },
                {
                    id: '3',
                    trigger: 'react component',
                    expansion: 'export default function MyComponent() {\n  return (\n    <div>\n      <h2>Hello World</h2>\n    </div>\n  );\n}',
                    description: 'React component boilerplate template'
                }
            ];
            writeJsonSafe(this.snippetsFile, defaultSnippets);
        }

        // Default dictation settings
        if (!fs.existsSync(this.settingsFile)) {
            const defaultSettings = {
                hotkey: 'Ctrl+Alt+D',
                whisperMode: false,
                developerMode: true,
                autoPunctuation: true,
                fillerRemoval: true,
                backtrackParsing: true,
                autoInject: true
            };
            writeJsonSafe(this.settingsFile, defaultSettings);
        }
    }

    getDictionary() {
        return readJsonSafe(this.dictionaryFile, []);
    }

    saveDictionary(termsList) {
        const cleaned = Array.from(new Set((termsList || []).map(t => String(t).trim()).filter(Boolean)));
        writeJsonSafe(this.dictionaryFile, cleaned);
        log.info(`[DictationStore] Saved ${cleaned.length} dictionary terms.`);
        return cleaned;
    }

    addDictionaryTerm(term) {
        const terms = this.getDictionary();
        const cleanTerm = String(term || '').trim();
        if (cleanTerm && !terms.includes(cleanTerm)) {
            terms.push(cleanTerm);
            this.saveDictionary(terms);
        }
        return terms;
    }

    removeDictionaryTerm(term) {
        const terms = this.getDictionary();
        const updated = terms.filter(t => t.toLowerCase() !== String(term).toLowerCase());
        this.saveDictionary(updated);
        return updated;
    }

    getSnippets() {
        return readJsonSafe(this.snippetsFile, []);
    }

    saveSnippets(snippetsList) {
        writeJsonSafe(this.snippetsFile, snippetsList || []);
        log.info(`[DictationStore] Saved ${(snippetsList || []).length} voice snippets.`);
        return snippetsList;
    }

    addOrUpdateSnippet(snippet) {
        const snippets = this.getSnippets();
        const existingIdx = snippets.findIndex(s => s.id === snippet.id || s.trigger.toLowerCase() === snippet.trigger.toLowerCase());

        const newSnippet = {
            id: snippet.id || String(Date.now()),
            trigger: String(snippet.trigger || '').trim().toLowerCase(),
            expansion: String(snippet.expansion || '').trim(),
            description: String(snippet.description || '').trim()
        };

        if (existingIdx >= 0) {
            snippets[existingIdx] = newSnippet;
        } else {
            snippets.push(newSnippet);
        }

        this.saveSnippets(snippets);
        return snippets;
    }

    deleteSnippet(id) {
        const snippets = this.getSnippets();
        const updated = snippets.filter(s => String(s.id) !== String(id));
        this.saveSnippets(updated);
        return updated;
    }

    getSettings() {
        return readJsonSafe(this.settingsFile, {
            hotkey: 'Ctrl+Alt+D',
            whisperMode: false,
            developerMode: true,
            autoPunctuation: true,
            fillerRemoval: true,
            backtrackParsing: true,
            autoInject: true
        });
    }

    saveSettings(newSettings) {
        const current = this.getSettings();
        const updated = Object.assign({}, current, newSettings);
        writeJsonSafe(this.settingsFile, updated);
        return updated;
    }
}

module.exports = DictationStore;
