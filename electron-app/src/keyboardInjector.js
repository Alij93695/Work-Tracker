const { exec, execSync } = require('child_process');
const { clipboard } = require('electron');
const log = require('./logger');

/**
 * Universal Windows Text Injector.
 * Pastes text into the currently focused window in any application (Cursor, Notion, Gmail, WhatsApp, Docs, Terminals).
 * Uses Clipboard + native SendKeys Ctrl+V injection.
 */
async function injectText(text, { restoreClipboard = true } = {}) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
        log.warn('[KeyboardInjector] Empty text supplied to injectText.');
        return { success: false, error: 'Empty text' };
    }

    log.info(`[KeyboardInjector] Injecting text (${text.length} chars) into focused window...`);

    // Backup current clipboard content
    let previousClipboardText = null;
    try {
        if (restoreClipboard) {
            previousClipboardText = clipboard.readText();
        }
    } catch (e) {
        /* ignore */
    }

    // Set target text to Windows clipboard
    clipboard.writeText(text);

    return new Promise((resolve) => {
        // Send Ctrl+V using PowerShell SendKeys
        const psScript = `
        Add-Type -AssemblyName System.Windows.Forms;
        [System.Windows.Forms.SendKeys]::SendWait("^v");
        `;

        exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/\n/g, ' ')}"`, (error, stdout, stderr) => {
            if (error) {
                log.error('[KeyboardInjector] SendKeys Ctrl+V failed:', error.message);
                // Fallback attempt: native cmd paste
                try {
                    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "[System.Windows.Forms.SendKeys]::SendWait('^v')"`);
                } catch (err) {
                    /* ignore */
                }
            } else {
                log.info('[KeyboardInjector] Text injected successfully via Ctrl+V SendKeys.');
            }

            // Asynchronously restore previous clipboard content after 250ms
            if (restoreClipboard && previousClipboardText !== null) {
                setTimeout(() => {
                    try {
                        clipboard.writeText(previousClipboardText);
                    } catch (e) {
                        /* ignore */
                    }
                }, 600);
            }

            resolve({ success: true, injectedLength: text.length });
        });
    });
}

/**
 * Type keys character-by-character (useful for strict raw terminal inputs).
 */
function typeKeysDirectly(text) {
    const safeText = String(text).replace(/[{}+^%~()\[\]]/g, '{$&}');
    const psScript = `
    Add-Type -AssemblyName System.Windows.Forms;
    [System.Windows.Forms.SendKeys]::SendWait("${safeText}");
    `;
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/\n/g, ' ')}"`, (error) => {
        if (error) log.error('[KeyboardInjector] typeKeysDirectly failed:', error.message);
    });
}

module.exports = {
    injectText,
    typeKeysDirectly
};
