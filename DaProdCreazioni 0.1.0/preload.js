const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // Settings
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),

  // AI fetch
  fetchAI: (url, options) => ipcRenderer.invoke('fetch:ai', { url, options }),

  // Project folder management
  initProject: (sessionId, title) => ipcRenderer.invoke('project:init', { sessionId, title }),
  readProject: (sessionId) => ipcRenderer.invoke('project:read', { sessionId }),
  writeProject: (sessionId, data) => ipcRenderer.invoke('project:write', { sessionId, data }),
  readNotes: (sessionId) => ipcRenderer.invoke('project:read-notes', { sessionId }),
  writeNotes: (sessionId, content) => ipcRenderer.invoke('project:write-notes', { sessionId, content }),
  listProjectFiles: (sessionId) => ipcRenderer.invoke('project:list-files', { sessionId }),
  openProjectFolder: (sessionId) => ipcRenderer.invoke('project:open-folder', { sessionId }),

  // Media
  saveMedia: (sessionId, clipNumber, dataUrl, sourcePath) =>
    ipcRenderer.invoke('project:save-media', { sessionId, clipNumber, dataUrl, sourcePath }),
  listMedia: (sessionId) =>
    ipcRenderer.invoke('project:list-media', { sessionId }),
  getMedia: (sessionId, filename) =>
    ipcRenderer.invoke('project:get-media', { sessionId, filename }),
  deleteMedia: (sessionId, clipNumber) =>
    ipcRenderer.invoke('project:delete-media', { sessionId, clipNumber }),
  getFilePath: (sessionId, filename) =>
    ipcRenderer.invoke('project:get-filepath', { sessionId, filename }),

  // Dialogs
  openFileDialog: (filters) => ipcRenderer.invoke('dialog:open-file', { filters })
})
