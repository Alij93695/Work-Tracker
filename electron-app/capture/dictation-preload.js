const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dictationAPI', {
    onStopCapture: (callback) => ipcRenderer.on('dictation:stop-capture', callback),
    sendAudioReady: (payload) => ipcRenderer.send('dictation:audio-ready', payload),
    sendError: (err) => ipcRenderer.send('dictation:error', String(err)),
    log: (msg) => ipcRenderer.send('dictation:log', String(msg))
});
