const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')

// Settings stored in userData
const settingsPath = path.join(app.getPath('userData'), 'settings.json')

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    }
  } catch (e) {}
  return {}
}

function saveSettings(data) {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2))
    return true
  } catch (e) {
    return false
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0f0f0f',
      symbolColor: '#ffffff',
      height: 38
    },
    backgroundColor: '#0f0f0f',
    show: false
  })

  win.loadFile('renderer/index.html')
  win.once('ready-to-show', () => win.show())
}

// IPC — settings
ipcMain.handle('settings:load', () => loadSettings())
ipcMain.handle('settings:save', (_, data) => saveSettings(data))

// IPC — AI fetch with timeout
ipcMain.handle('fetch:ai', async (_, { url, options }) => {
  try {
    const timeoutMs = (options && options.timeout) ? options.timeout : 120000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const fetchOptions = { ...options, signal: controller.signal }
    delete fetchOptions.timeout
    const response = await fetch(url, fetchOptions)
    clearTimeout(timer)
    const text = await response.text()
    return { ok: response.ok, status: response.status, body: text }
  } catch (e) {
    return { ok: false, status: 0, body: e.name === 'AbortError' ? 'Request timed out' : e.message }
  }
})

// ─── IPC — project folders ─────────────────────────────────────────────────
const PROJECTS_ROOT = path.join(app.getPath('userData'), 'projects')

function getProjectDir(sessionId) {
  const dir = path.join(PROJECTS_ROOT, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// Initialize a project folder with template files
ipcMain.handle('project:init', async (_, { sessionId, title }) => {
  try {
    const dir = getProjectDir(sessionId)
    const projectFile = path.join(dir, 'project.json')
    if (!fs.existsSync(projectFile)) {
      const project = {
        title: title || 'New Project',
        created: new Date().toISOString(),
        status: 'in-progress',
        plans: [],
        notes: ''
      }
      fs.writeFileSync(projectFile, JSON.stringify(project, null, 2))
    }
    const notesFile = path.join(dir, 'notes.md')
    if (!fs.existsSync(notesFile)) {
      fs.writeFileSync(notesFile, `# ${title || 'New Project'}\n\nNotes and ideas for this project.\n`)
    }
    return { ok: true, path: dir }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// Read project.json
ipcMain.handle('project:read', async (_, { sessionId }) => {
  try {
    const filePath = path.join(PROJECTS_ROOT, sessionId, 'project.json')
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (e) {
    return null
  }
})

// Write project.json
ipcMain.handle('project:write', async (_, { sessionId, data }) => {
  try {
    const dir = getProjectDir(sessionId)
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(data, null, 2))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// Read notes.md
ipcMain.handle('project:read-notes', async (_, { sessionId }) => {
  try {
    const filePath = path.join(PROJECTS_ROOT, sessionId, 'notes.md')
    if (!fs.existsSync(filePath)) return ''
    return fs.readFileSync(filePath, 'utf8')
  } catch (e) {
    return ''
  }
})

// Write notes.md
ipcMain.handle('project:write-notes', async (_, { sessionId, content }) => {
  try {
    const dir = getProjectDir(sessionId)
    fs.writeFileSync(path.join(dir, 'notes.md'), content)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// List all files in project folder (for AI exploration)
ipcMain.handle('project:list-files', async (_, { sessionId }) => {
  try {
    const dir = path.join(PROJECTS_ROOT, sessionId)
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir).map(f => {
      const stat = fs.statSync(path.join(dir, f))
      return { name: f, size: stat.size, isDir: stat.isDirectory() }
    })
  } catch (e) {
    return []
  }
})

// Open project folder in system explorer
ipcMain.handle('project:open-folder', async (_, { sessionId }) => {
  try {
    const dir = path.join(PROJECTS_ROOT, sessionId)
    if (fs.existsSync(dir)) shell.openPath(dir)
    return { ok: true }
  } catch (e) {
    return { ok: false }
  }
})

// ─── IPC — project media (images + videos) ──────────────────────────────────
const MEDIA_EXTS = /\.(png|jpg|jpeg|webp|gif|mp4|webm|mov|avi|mkv)$/i
const IMAGE_EXTS = /\.(png|jpg|jpeg|webp|gif)$/i
const VIDEO_EXTS = /\.(mp4|webm|mov|avi|mkv)$/i

function getMimeType(ext) {
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    webp: 'image/webp', gif: 'image/gif',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    avi: 'video/x-msvideo', mkv: 'video/x-matroska'
  }
  return map[ext.toLowerCase()] || 'application/octet-stream'
}

// Save media from dataUrl (base64) OR copy from file path
ipcMain.handle('project:save-media', async (_, { sessionId, clipNumber, dataUrl, sourcePath }) => {
  try {
    const dir = getProjectDir(sessionId)

    // Remove any existing media for this clip
    const existing = fs.readdirSync(dir).filter(f => f.startsWith(`clip_${clipNumber}.`))
    existing.forEach(f => fs.unlinkSync(path.join(dir, f)))

    if (sourcePath) {
      const ext = path.extname(sourcePath).slice(1).toLowerCase()
      const filename = `clip_${clipNumber}.${ext}`
      fs.copyFileSync(sourcePath, path.join(dir, filename))
      return { ok: true, filename, mediaType: VIDEO_EXTS.test(sourcePath) ? 'video' : 'image' }
    } else if (dataUrl) {
      const matches = dataUrl.match(/^data:(image|video)\/(\w+);base64,(.+)$/)
      if (!matches) return { ok: false, error: 'Invalid data URL' }
      const mediaType = matches[1]
      let ext = matches[2]
      if (ext === 'jpeg') ext = 'jpg'
      if (ext === 'quicktime') ext = 'mov'
      const buffer = Buffer.from(matches[3], 'base64')
      const filename = `clip_${clipNumber}.${ext}`
      fs.writeFileSync(path.join(dir, filename), buffer)
      return { ok: true, filename, mediaType }
    }
    return { ok: false, error: 'No source provided' }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// List all media for a session
ipcMain.handle('project:list-media', async (_, { sessionId }) => {
  try {
    const dir = path.join(PROJECTS_ROOT, sessionId)
    if (!fs.existsSync(dir)) return []
    const files = fs.readdirSync(dir).filter(f => MEDIA_EXTS.test(f))
    return files.map(f => {
      const match = f.match(/clip_(\d+)/)
      const ext = path.extname(f).slice(1).toLowerCase()
      return {
        clipNumber: match ? parseInt(match[1]) : null,
        filename: f,
        mediaType: VIDEO_EXTS.test(f) ? 'video' : 'image',
        ext
      }
    })
  } catch (e) {
    return []
  }
})

// Get media as data URL (for display) or file path (for video)
ipcMain.handle('project:get-media', async (_, { sessionId, filename }) => {
  try {
    const filePath = path.join(PROJECTS_ROOT, sessionId, filename)
    if (!fs.existsSync(filePath)) return null
    const ext = path.extname(filename).slice(1).toLowerCase()
    const mime = getMimeType(ext)
    const isVideo = VIDEO_EXTS.test(filename)

    if (isVideo) {
      return { type: 'video', path: filePath, mime }
    } else {
      const buffer = fs.readFileSync(filePath)
      return { type: 'image', dataUrl: `data:${mime};base64,${buffer.toString('base64')}` }
    }
  } catch (e) {
    return null
  }
})

// Delete media for a clip
ipcMain.handle('project:delete-media', async (_, { sessionId, clipNumber }) => {
  try {
    const dir = path.join(PROJECTS_ROOT, sessionId)
    if (!fs.existsSync(dir)) return { ok: true }
    const files = fs.readdirSync(dir).filter(f => f.startsWith(`clip_${clipNumber}.`))
    files.forEach(f => fs.unlinkSync(path.join(dir, f)))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// Get file path for video playback
ipcMain.handle('project:get-filepath', async (_, { sessionId, filename }) => {
  const filePath = path.join(PROJECTS_ROOT, sessionId, filename)
  if (fs.existsSync(filePath)) return filePath
  return null
})

// File picker for videos (Electron dialog)
ipcMain.handle('dialog:open-file', async (_, { filters }) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: filters || [
      { name: 'Media', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov', 'avi', 'mkv'] }
    ]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
