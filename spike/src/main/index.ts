import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import * as pty from 'node-pty'

let win: BrowserWindow | null = null
let term: pty.IPty | null = null

// GUI-launched apps on macOS get a minimal PATH. Prepend the usual bins so
// `claude` resolves whether the app is launched from a terminal or Finder.
function buildEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME || ''
  const extra = [join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']
  const path = [...extra, process.env.PATH || ''].join(':')
  return { ...process.env, PATH: path, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
}

function resolveClaude(): string {
  const home = process.env.HOME || ''
  const candidates = [
    join(home, '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return 'claude'
}

function startPty(cols: number, rows: number): void {
  if (term) return
  const cmd = resolveClaude()
  term = pty.spawn(cmd, [], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: process.env.HOME,
    env: buildEnv(),
  })
  console.log(`[main] spawned ${cmd} ${cols}x${rows} pid=${term.pid}`)
  win?.webContents.send('pty:info', `spawned: ${cmd} (${cols}x${rows})`)
  term.onData((data) => win?.webContents.send('pty:data', data))
  term.onExit(({ exitCode }) => {
    console.log(`[main] pty exit code=${exitCode}`)
    win?.webContents.send('pty:exit', exitCode)
    term = null
  })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    backgroundColor: '#1e1e1e',
    title: 'CCC Spike — terminal host',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.webContents.on('did-fail-load', (_e, code, desc) =>
    console.error(`[main] did-fail-load ${code} ${desc}`),
  )
  win.webContents.on('render-process-gone', (_e, details) =>
    console.error(`[main] render-process-gone ${JSON.stringify(details)}`),
  )
  win.webContents.on('did-finish-load', () => {
    console.log('[main] renderer loaded')
    // Debug: capture our own web contents (only this window) when asked, to
    // verify the TUI renders. Harmless when CCC_CAPTURE_DIR is unset.
    const dir = process.env.CCC_CAPTURE_DIR
    if (!dir) return
    for (const [at, name] of [[3500, 'spike-frame1.png'], [6500, 'spike-frame2.png']] as const) {
      setTimeout(async () => {
        try {
          const img = await win!.webContents.capturePage()
          const { writeFileSync } = await import('node:fs')
          writeFileSync(`${dir}/${name}`, img.toPNG())
          console.log(`[main] captured ${name}`)
        } catch (e) {
          console.error('[main] capture failed', e)
        }
      }, at)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.on('ready', () => console.log('[main] app ready'))

ipcMain.on('pty:start', (_e, { cols, rows }: { cols: number; rows: number }) => startPty(cols, rows))
ipcMain.on('pty:input', (_e, data: string) => term?.write(data))
ipcMain.on('pty:resize', (_e, { cols, rows }: { cols: number; rows: number }) => {
  try {
    term?.resize(cols, rows)
  } catch {
    /* resize before spawn or after exit — ignore */
  }
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  term?.kill()
  if (process.platform !== 'darwin') app.quit()
})
