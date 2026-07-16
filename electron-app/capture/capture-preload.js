const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('captureAPI', {
    chunk: (payload) => ipcRenderer.send('meeting:chunk', payload),
    started: (info) => ipcRenderer.send('meeting:capture-started', info),
    error: (msg) => ipcRenderer.send('meeting:capture-error', String(msg)),
    log: (msg) => ipcRenderer.send('meeting:capture-log', String(msg)),
});
