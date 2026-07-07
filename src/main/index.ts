import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import os from 'node:os'
import { scanLiveSessions } from './engine/sessions'
import type { LiveSession } from './engine/types'

let win: BrowserWindow | null = null
let pollTimer: NodeJS.Timeout | null = null

interface Snapshot {
  home: string
  scannedAt: number
  sessions: LiveSession[]
}

function snapshot(): Snapshot {
  let sessions: LiveSession[] = []
  try {
    sessions = scanLiveSessions()
  } catch (e) {
    console.error('[main] scan error', e)
  }
  return { home: os.homedir(), scannedAt: Date.now(), sessions }
}

function pushSessions(): void {
  win?.webContents.send('cc:sessions', snapshot())
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 680,
    backgroundColor: '#0f1115',
    title: 'Claude Command Center',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.webContents.on('did-finish-load', () => {
    pushSessions()
    // Dev affordance: capture just this window (not the whole screen) when asked.
    // Inert unless CCC_CAPTURE points at an output path.
    const capPath = process.env.CCC_CAPTURE
    if (capPath) {
      setTimeout(async () => {
        try {
          const img = await win!.webContents.capturePage()
          const { writeFileSync } = await import('node:fs')
          writeFileSync(capPath, img.toPNG())
          console.log(`[main] captured ${capPath}`)
        } catch (e) {
          console.error('[main] capture failed', e)
        }
      }, 2500)
    }
  })
}

ipcMain.handle('cc:getSessions', () => snapshot())

app.whenReady().then(() => {
  createWindow()
  pollTimer = setInterval(pushSessions, 1500)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (pollTimer) clearInterval(pollTimer)
  if (process.platform !== 'darwin') app.quit()
})
