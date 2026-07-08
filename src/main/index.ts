import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import os from 'node:os'
import { existsSync } from 'node:fs'
import * as pty from 'node-pty'
import { scanLiveSessions } from './engine/sessions'
import type { LiveSession } from './engine/types'
import {
  initRegistry,
  listCategories,
  createCategory,
  renameCategory,
  deleteCategory,
  ensureNode,
  assignCategory,
  getNodeMap,
  type Category,
} from './registry'

let win: BrowserWindow | null = null
let pollTimer: NodeJS.Timeout | null = null

// ---------- session polling (status board) ----------
type EnrichedSession = LiveSession & { categoryId: number | null }
interface Snapshot {
  home: string
  scannedAt: number
  sessions: EnrichedSession[]
  categories: Category[]
}

function snapshot(): Snapshot {
  let sessions: LiveSession[] = []
  try {
    sessions = scanLiveSessions()
  } catch (e) {
    console.error('[main] scan error', e)
  }
  for (const s of sessions) {
    if (s.sessionId) ensureNode(s.sessionId, { cwd: s.cwd, name: s.name, origin: 'adopted' })
  }
  const nodes = getNodeMap()
  const enriched: EnrichedSession[] = sessions.map((s) => ({
    ...s,
    categoryId: nodes.get(s.sessionId)?.category_id ?? null,
  }))
  return {
    home: os.homedir(),
    scannedAt: Date.now(),
    sessions: enriched,
    categories: listCategories(),
  }
}

// Demo only: seed a few categories and bucket current sessions by cwd so the
// grouping is visible without hand-assigning. Real use starts empty.
function maybeSeed(): void {
  if (!process.env.CCC_SEED || listCategories().length > 0) return
  const sf = createCategory('Salesforce · Client')
  const exp = createCategory('Experiments')
  const proj = createCategory('Command Center')
  try {
    for (const s of scanLiveSessions()) {
      if (!s.sessionId) continue
      ensureNode(s.sessionId, { cwd: s.cwd, name: s.name })
      if (s.cwd.includes('client')) assignCategory(s.sessionId, sf.id)
      else if (s.cwd.includes('/experiments/')) assignCategory(s.sessionId, exp.id)
      else if (s.cwd.includes('claude-command-center')) assignCategory(s.sessionId, proj.id)
    }
  } catch (e) {
    console.error('[main] seed error', e)
  }
}

function pushSessions(): void {
  win?.webContents.send('cc:sessions', snapshot())
}

// ---------- terminal hosting ----------
// The app owns the PTYs it launches. Backgrounded terminals keep running and
// their output is buffered so switching back replays the scrollback. Terminals
// are keyed by the LOGICAL session pid the user opened (a resumed session is a
// new process, but keeps the same key).
const BUFFER_CAP = 256 * 1024
interface Term {
  pty: pty.IPty
  buffer: string
  exited: boolean
}
const terminals = new Map<number, Term>()
let attachedPid: number | null = null

function buildEnv(): NodeJS.ProcessEnv {
  const home = os.homedir()
  const extra = [join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']
  return {
    ...process.env,
    PATH: [...extra, process.env.PATH || ''].join(':'),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  }
}

function resolveClaude(): string {
  const home = os.homedir()
  for (const c of [
    join(home, '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]) {
    if (existsSync(c)) return c
  }
  return 'claude'
}

interface OpenOpts {
  sessionId?: string
  cwd: string
  resume: boolean
  cols: number
  rows: number
}

function openTerminal(pid: number, opts: OpenOpts): void {
  let term = terminals.get(pid)
  if (!term) {
    const cmd = resolveClaude()
    const args = opts.resume && opts.sessionId ? ['--resume', opts.sessionId] : []
    const p = pty.spawn(cmd, args, {
      name: 'xterm-256color',
      cols: opts.cols || 120,
      rows: opts.rows || 30,
      cwd: opts.cwd || os.homedir(),
      env: buildEnv(),
    })
    console.log(`[main] terminal ${pid}: spawned ${cmd} ${args.join(' ')} in ${opts.cwd}`)
    term = { pty: p, buffer: '', exited: false }
    terminals.set(pid, term)
    p.onData((data) => {
      const t = terminals.get(pid)
      if (!t) return
      t.buffer = (t.buffer + data).slice(-BUFFER_CAP)
      if (attachedPid === pid) win?.webContents.send('term:data', { pid, data })
    })
    p.onExit(({ exitCode }) => {
      const t = terminals.get(pid)
      if (t) t.exited = true
      win?.webContents.send('term:exit', { pid, code: exitCode })
    })
  }
  attachedPid = pid
  if (term.buffer) win?.webContents.send('term:data', { pid, data: term.buffer }) // replay scrollback
}

ipcMain.handle('term:open', (_e, pid: number, opts: OpenOpts) => {
  openTerminal(pid, opts)
  return true
})
ipcMain.on('term:attach', (_e, pid: number) => {
  attachedPid = pid
  const t = terminals.get(pid)
  if (t?.buffer) win?.webContents.send('term:data', { pid, data: t.buffer })
})
ipcMain.on('term:input', (_e, pid: number, data: string) => {
  terminals.get(pid)?.pty.write(data)
})
ipcMain.on('term:resize', (_e, pid: number, cols: number, rows: number) => {
  try {
    terminals.get(pid)?.pty.resize(cols, rows)
  } catch {
    /* resize before spawn or after exit */
  }
})
ipcMain.on('term:close', (_e, pid: number) => {
  const t = terminals.get(pid)
  if (t) {
    try {
      t.pty.kill()
    } catch {
      /* already gone */
    }
    terminals.delete(pid)
  }
  if (attachedPid === pid) attachedPid = null
})

// ---------- window ----------
function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 820,
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

    // Demo: auto-open a throwaway managed terminal (fresh claude) in a given
    // cwd, so the split layout can be verified without resuming a real session.
    const demoCwd = process.env.CCC_DEMO_CWD
    if (demoCwd) {
      openTerminal(0, { cwd: demoCwd, resume: false, cols: 120, rows: 30 })
      win?.webContents.send('term:show', { pid: 0, name: 'demo (scratchpad)', cwd: demoCwd })
    }

    // Dev affordance: capture just this window (not the whole screen) when asked.
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
      }, 4500)
    }
  })
}

ipcMain.handle('cc:getSessions', () => snapshot())
ipcMain.handle('cat:list', () => listCategories())
ipcMain.handle('cat:create', (_e, name: string) => createCategory(name))
ipcMain.handle('cat:rename', (_e, id: number, name: string) => {
  renameCategory(id, name)
  pushSessions()
  return true
})
ipcMain.handle('cat:delete', (_e, id: number) => {
  deleteCategory(id)
  pushSessions()
  return true
})
ipcMain.handle('cat:assign', (_e, sessionId: string, categoryId: number | null) => {
  assignCategory(sessionId, categoryId)
  pushSessions()
  return true
})

app.whenReady().then(() => {
  initRegistry(join(app.getPath('userData'), 'registry.db'))
  maybeSeed()
  createWindow()
  pollTimer = setInterval(pushSessions, 1500)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (pollTimer) clearInterval(pollTimer)
  for (const t of terminals.values()) {
    try {
      t.pty.kill()
    } catch {
      /* ignore */
    }
  }
  if (process.platform !== 'darwin') app.quit()
})
