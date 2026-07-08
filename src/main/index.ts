import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'node:path'
import os from 'node:os'
import { existsSync } from 'node:fs'
import * as pty from 'node-pty'
import { scanLiveSessions } from './engine/sessions'
import type { LiveSession } from './engine/types'
import { installAppMenu, setAboutPanel } from './about'
import { APP_VERSION, BUILD_HASH, BUILD_TIME, FULL_VERSION } from '../shared/version'
import {
  initRegistry,
  listCategories,
  createCategory,
  renameCategory,
  deleteCategory,
  ensureNode,
  assignCategory,
  getNodeMap,
  setParent,
  clearParent,
  getEdges,
  setTheme,
  setScrollback,
  getScrollback,
  type Category,
  type Edge,
} from './registry'

let win: BrowserWindow | null = null
let pollTimer: NodeJS.Timeout | null = null

// ---------- session polling (status board) ----------
type EnrichedSession = LiveSession & { categoryId: number | null; theme: string | null }
interface Snapshot {
  home: string
  scannedAt: number
  sessions: EnrichedSession[]
  categories: Category[]
  edges: Edge[]
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
    theme: nodes.get(s.sessionId)?.theme ?? null,
  }))
  return {
    home: os.homedir(),
    scannedAt: Date.now(),
    sessions: enriched,
    categories: listCategories(),
    edges: getEdges(),
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
    const client: string[] = []
    for (const s of scanLiveSessions()) {
      if (!s.sessionId) continue
      ensureNode(s.sessionId, { cwd: s.cwd, name: s.name })
      if (s.cwd.includes('client')) {
        assignCategory(s.sessionId, sf.id)
        client.push(s.sessionId)
      } else if (s.cwd.includes('/experiments/')) assignCategory(s.sessionId, exp.id)
      else if (s.cwd.includes('claude-command-center')) assignCategory(s.sessionId, proj.id)
    }
    // demo tree: a blocking child and a tangential offshoot under one session
    if (client.length >= 3) {
      setParent(client[1], client[0], 'blocking')
      setParent(client[2], client[0], 'tangential')
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
  sessionId?: string
  cwd: string
}
// Managed terminals keyed by a STABLE string key: the Claude session id for a
// scanned session, or `new:<pid>` for a freshly-launched one not yet adopted.
// Keying by session id (not pid) makes open idempotent — clicking a session
// that is already open re-attaches instead of forking a second `claude --resume`.
const terminals = new Map<string, Term>()
let attachedKey: string | null = null

function buildEnv(): NodeJS.ProcessEnv {
  const home = os.homedir()
  const extra = [join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    // Strip Claude Code / agent env so spawned sessions run as fresh TOP-LEVEL
    // sessions. If they inherit CLAUDECODE / CLAUDE_CODE_SESSION_ID /
    // CLAUDE_CODE_CHILD_SESSION (which they do when this app is itself launched
    // from a Claude Code session), the spawned claude registers as a nested
    // child and never writes ~/.claude/sessions — so it never shows in the list.
    if (/^(CLAUDE|ANTHROPIC)/i.test(k) || k === 'AI_AGENT' || k === 'BAGGAGE') continue
    env[k] = v
  }
  env.PATH = [...extra, process.env.PATH || ''].join(':')
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  return env
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

function wireTerm(key: string, p: pty.IPty, meta: { sessionId?: string; cwd: string }): Term {
  const term: Term = { pty: p, buffer: '', exited: false, sessionId: meta.sessionId, cwd: meta.cwd }
  terminals.set(key, term)
  p.onData((data) => {
    const t = terminals.get(key)
    if (!t) return
    t.buffer = (t.buffer + data).slice(-BUFFER_CAP)
    if (attachedKey === key) win?.webContents.send('term:data', { key, data })
  })
  p.onExit(({ exitCode }) => {
    const t = terminals.get(key)
    if (t) t.exited = true
    win?.webContents.send('term:exit', { key, code: exitCode })
  })
  return term
}

function openTerminal(key: string, opts: OpenOpts): void {
  let term = terminals.get(key)
  if (term?.exited) {
    terminals.delete(key) // the process died; re-spawn a fresh one below
    term = undefined
  }
  const fresh = !term
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
    console.log(`[main] terminal ${key}: spawned ${cmd} ${args.join(' ')} in ${opts.cwd}`)
    term = wireTerm(key, p, { sessionId: opts.sessionId, cwd: opts.cwd })
  }
  attachedKey = key
  // On a fresh spawn (e.g. first open after an app restart), paint the persisted
  // scrollback from the last run before the resumed session repaints its screen.
  if (fresh && opts.sessionId) {
    const sb = getScrollback(opts.sessionId)
    if (sb) {
      win?.webContents.send('term:data', {
        key,
        data: sb + '\r\n\x1b[90m— restored scrollback; resuming… —\x1b[0m\r\n',
      })
    }
  }
  if (term.buffer) win?.webContents.send('term:data', { key, data: term.buffer }) // replay live buffer
}

// Launch a brand-new managed Claude session in a folder. Keyed by `new:<pid>`
// until the next scan adopts it (Claude writes ~/.claude/sessions/<pid>.json,
// so the sidebar row appears and, once opened, reconciles by session id).
function launchSession(cwd: string, args: string[] = []): number {
  const cmd = resolveClaude()
  const p = pty.spawn(cmd, args, { name: 'xterm-256color', cols: 120, rows: 30, cwd, env: buildEnv() })
  const key = `new:${p.pid}`
  console.log(`[main] new session: spawned ${cmd} ${args.join(' ')} in ${cwd} pid=${p.pid}`)
  wireTerm(key, p, { cwd })
  attachedKey = key
  win?.webContents.send('term:show', { key, name: 'new session', cwd })
  return p.pid
}

ipcMain.handle('term:open', (_e, key: string, opts: OpenOpts) => {
  openTerminal(key, opts)
  return true
})
ipcMain.on('term:attach', (_e, key: string) => {
  attachedKey = key
  const t = terminals.get(key)
  if (t?.buffer) win?.webContents.send('term:data', { key, data: t.buffer })
})
ipcMain.on('term:input', (_e, key: string, data: string) => {
  terminals.get(key)?.pty.write(data)
})
ipcMain.on('term:resize', (_e, key: string, cols: number, rows: number) => {
  try {
    terminals.get(key)?.pty.resize(cols, rows)
  } catch {
    /* resize before spawn or after exit */
  }
})
ipcMain.on('term:close', (_e, key: string) => {
  const t = terminals.get(key)
  if (t) {
    try {
      t.pty.kill()
    } catch {
      /* already gone */
    }
    terminals.delete(key)
  }
  if (attachedKey === key) attachedKey = null
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
      const key = 'new:demo'
      openTerminal(key, { cwd: demoCwd, resume: false, cols: 120, rows: 30 })
      win?.webContents.send('term:show', { key, name: 'demo (scratchpad)', cwd: demoCwd })
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

ipcMain.handle('app:version', () => ({
  full: FULL_VERSION,
  version: APP_VERSION,
  hash: BUILD_HASH,
  time: BUILD_TIME,
}))
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
ipcMain.handle('edge:set', (_e, childId: string, parentId: string, type: 'blocking' | 'tangential') => {
  const ok = setParent(childId, parentId, type)
  if (ok) pushSessions()
  return ok
})
ipcMain.handle('edge:clear', (_e, childId: string) => {
  clearParent(childId)
  pushSessions()
  return true
})
ipcMain.handle('theme:set', (_e, sessionId: string, theme: string | null) => {
  if (!sessionId) return false
  setTheme(sessionId, theme)
  pushSessions()
  return true
})
ipcMain.on('snapshot:save', (_e, sessionId: string, data: string) => {
  if (!sessionId || !data) return
  try {
    setScrollback(sessionId, data, Date.now())
  } catch {
    /* node may not exist yet (session not adopted) — ignore */
  }
})
ipcMain.handle('session:new', async () => {
  if (!win) return null
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Start a Claude session in…',
  })
  if (r.canceled || !r.filePaths[0]) return null
  const cwd = r.filePaths[0]
  return { pid: launchSession(cwd), cwd }
})

app.setName('Claude Command Center')

app.whenReady().then(() => {
  setAboutPanel()
  installAppMenu(() => win)
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
