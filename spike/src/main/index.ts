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
    cwd: process.env.CCC_CWD || process.env.HOME,
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
    const cap = async (name: string) => {
      try {
        const img = await win!.webContents.capturePage()
        const { writeFileSync } = await import('node:fs')
        writeFileSync(`${dir}/${name}`, img.toPNG())
        console.log(`[main] captured ${name}`)
      } catch (e) {
        console.error('[main] capture failed', e)
      }
    }
    if (process.env.CCC_AUTODRIVE) {
      // Accept the trust prompt (option 1 is preselected), start a turn, then
      // burst-capture during the working state to check the spinner animates in
      // place, then resize the window to check the alt-screen reflows.
      const PASTE_START = '\x1b[200~'
      const PASTE_END = '\x1b[201~'
      const prompt = 'List five benefits of terminal multiplexers, one short line each.'
      setTimeout(() => term?.write('\r'), 1500) // accept trust prompt
      // Bracketed-paste the text, then send Enter as a separate keypress so Ink
      // treats it as submit rather than a newline (research Fact 3).
      setTimeout(() => term?.write(PASTE_START + prompt + PASTE_END), 3000)
      setTimeout(() => term?.write('\r'), 3500)
      let t = 4000
      for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const nm = `spike-work${n}.png`
        setTimeout(() => cap(nm), t)
        t += 350
      }
      setTimeout(() => {
        win?.setSize(820, 560)
        console.log('[main] resized window to 820x560')
      }, 7600)
      setTimeout(() => cap('spike-resize.png'), 8800)
    } else {
      setTimeout(() => cap('spike-frame1.png'), 3500)
      setTimeout(() => cap('spike-frame2.png'), 6500)
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
