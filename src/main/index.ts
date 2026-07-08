import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'node:path'
import os from 'node:os'
import { existsSync } from 'node:fs'
import * as pty from 'node-pty'
import { scanLiveSessions, hasTranscript, purgeDeadSessionFiles } from './engine/sessions'
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
  deleteNode,
  setAppState,
  getAppState,
  type Category,
  type Edge,
} from './registry'

let win: BrowserWindow | null = null
let pollTimer: NodeJS.Timeout | null = null

// ---------- session polling (status board) ----------
type EnrichedSession = LiveSession & {
  categoryId: number | null
  theme: string | null
  dormant?: boolean // registry node with no live process — resumable, survives restart
}
interface Snapshot {
  home: string
  scannedAt: number
  sessions: EnrichedSession[]
  categories: Category[]
  edges: Edge[]
}

// Sessions the user explicitly removed. A ghost that is still "alive" but has no
// transcript can't be dropped by deleting its node alone (the scan re-adopts it),
// so we also keep this deny-list and filter it out of every snapshot.
function getRemovedSet(): Set<string> {
  try {
    return new Set(JSON.parse(getAppState('removedSessions') || '[]') as string[])
  } catch {
    return new Set()
  }
}

function snapshot(): Snapshot {
  let sessions: LiveSession[] = []
  try {
    sessions = scanLiveSessions()
  } catch (e) {
    console.error('[main] scan error', e)
  }
  const removed = getRemovedSet()
  sessions = sessions.filter((s) => !removed.has(s.sessionId))
  for (const s of sessions) {
    if (s.sessionId) ensureNode(s.sessionId, { cwd: s.cwd, name: s.name, origin: 'adopted' })
  }
  reconcilePendingChildren(sessions)
  const nodes = getNodeMap()
  const enriched: EnrichedSession[] = sessions.map((s) => ({
    ...s,
    categoryId: nodes.get(s.sessionId)?.category_id ?? null,
    theme: nodes.get(s.sessionId)?.theme ?? null,
  }))

  // Dormant nodes: sessions the user gave meaning to (categorized or placed in a
  // task tree) that aren't currently running. Keep them in the list so they
  // survive a quit/restart and can be resumed. Uncategorized, edge-less dead
  // sessions are dropped to avoid clutter.
  const edges = getEdges()
  const liveIds = new Set(sessions.map((s) => s.sessionId))
  const edgeIds = new Set<string>()
  for (const e of edges) {
    edgeIds.add(e.child_id)
    edgeIds.add(e.parent_id)
  }
  for (const [sid, node] of nodes) {
    if (liveIds.has(sid) || removed.has(sid)) continue
    if (node.category_id == null && !edgeIds.has(sid)) continue
    enriched.push({
      pid: 0,
      sessionId: sid,
      cwd: node.cwd ?? '',
      name: node.name ?? undefined,
      alive: false,
      isSpare: false,
      state: 'idle',
      stateReason: 'not running — click to resume',
      categoryId: node.category_id,
      theme: node.theme ?? null,
      dormant: true,
    })
  }

  return {
    home: os.homedir(),
    scannedAt: Date.now(),
    sessions: enriched,
    categories: listCategories(),
    edges,
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
  key: string // mutable: a new:<pid> terminal is rehomed to its session id on adoption
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
  pid?: number
  cwd: string
  resume: boolean
  cols: number
  rows: number
}

function wireTerm(key: string, p: pty.IPty, meta: { sessionId?: string; cwd: string }): Term {
  // Handlers read term.key (mutable) rather than the captured key, so a terminal
  // rehomed from new:<pid> to its session id keeps routing correctly.
  const term: Term = { pty: p, buffer: '', exited: false, sessionId: meta.sessionId, cwd: meta.cwd, key }
  terminals.set(key, term)
  p.onData((data) => {
    term.buffer = (term.buffer + data).slice(-BUFFER_CAP)
    if (attachedKey === term.key) win?.webContents.send('term:data', { key: term.key, data })
  })
  p.onExit(({ exitCode }) => {
    term.exited = true
    pendingChildren.delete(p.pid) // a child that died before adoption: drop its intent
    win?.webContents.send('term:exit', { key: term.key, code: exitCode })
  })
  return term
}

function openTerminal(key: string, opts: OpenOpts): void {
  let term = terminals.get(key)
  if (term?.exited) {
    terminals.delete(key) // the process died; re-spawn a fresh one below
    term = undefined
  }
  // A session launched in-app runs under a new:<pid> key. Once the scan adopts
  // it and the user re-opens it by session id, rehome that live terminal instead
  // of forking a second `claude --resume` (the Q5 duplicate, new-session path).
  if (!term && opts.sessionId && opts.pid != null) {
    const prior = terminals.get(`new:${opts.pid}`)
    if (prior && !prior.exited) {
      terminals.delete(`new:${opts.pid}`)
      prior.key = key
      prior.sessionId = opts.sessionId
      terminals.set(key, prior)
      if (attachedKey === `new:${opts.pid}`) attachedKey = key
      term = prior
    }
  }
  const fresh = !term
  // Q4 recovery: never blindly `claude --resume` a session whose transcript is
  // gone — it just prints "No conversation found" and exits 1. Paint whatever
  // scrollback we saved and hand the pane a recovery affordance instead.
  if (fresh && opts.resume && opts.sessionId && !hasTranscript(opts.sessionId, opts.cwd)) {
    attachedKey = key
    const sb = getScrollback(opts.sessionId)
    if (sb) win?.webContents.send('term:data', { key, data: sb })
    win?.webContents.send('term:recover', { key, sessionId: opts.sessionId, cwd: opts.cwd })
    return
  }
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
  // scrollback from the last run before the resumed session repaints. No marker
  // line — it would otherwise be re-serialized into the next snapshot and stack
  // up across restarts. (Restored content itself is still re-captured; that
  // staleness is bounded by the 1000-line cap and is a known cosmetic limit.)
  if (fresh && opts.sessionId) {
    const sb = getScrollback(opts.sessionId)
    if (sb) win?.webContents.send('term:data', { key, data: sb })
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
  win?.webContents.send('term:show', { key, pid: p.pid, name: 'new session', cwd })
  return p.pid
}

// Children spawned from an active session. The typed edge can't be set until the
// new session gets its own Claude session id (written on adoption ~1.5s later),
// so we stash the intent keyed by the child's pid and resolve it in the scan.
interface PendingChild {
  parentSessionId: string
  type: 'blocking' | 'tangential'
  note?: string
  at: number
}
// Keyed by the child's pid. Entries expire so a child that dies before adoption
// can't mislink an unrelated process that later reuses its pid.
const pendingChildren = new Map<number, PendingChild>()
const PENDING_TTL_MS = 60_000

function findTermByPid(pid: number): Term | undefined {
  for (const t of terminals.values()) if (t.pty.pid === pid) return t
  return undefined
}

function spawnChild(
  parentSessionId: string,
  cwd: string,
  type: 'blocking' | 'tangential',
  note?: string,
): number {
  const pid = launchSession(cwd)
  pendingChildren.set(pid, { parentSessionId, type, note: note?.trim() || undefined, at: Date.now() })
  return pid
}

// Best-effort deliver a handoff note as the child's first message. Waits until
// the child has actually painted output (its input is up) before pasting — the
// session-id file is written very early in startup, well before Ink is ready.
function deliverHandoffNote(childPid: number, note: string): void {
  const start = Date.now()
  const tryDeliver = (): void => {
    const term = findTermByPid(childPid)
    if (!term || term.exited) return
    if (term.buffer.length > 200 || Date.now() - start > 6000) {
      try {
        term.pty.write(`\x1b[200~${note}\x1b[201~`) // bracketed paste (Ink needs the envelope)
        setTimeout(() => {
          try {
            term.pty.write('\r') // separate CR submits; a raw CR alone does not
          } catch {
            /* gone */
          }
        }, 400)
      } catch {
        /* gone */
      }
      return
    }
    setTimeout(tryDeliver, 300)
  }
  setTimeout(tryDeliver, 400)
}

// Once a pending child has been adopted (has a session id), wire the typed edge
// to its parent and best-effort deliver the handoff note.
function reconcilePendingChildren(sessions: LiveSession[]): void {
  if (pendingChildren.size === 0) return
  const now = Date.now()
  for (const [pid, pend] of pendingChildren) {
    if (now - pend.at > PENDING_TTL_MS) pendingChildren.delete(pid)
  }
  for (const s of sessions) {
    if (!s.sessionId) continue
    const pend = pendingChildren.get(s.pid)
    if (!pend) continue
    pendingChildren.delete(s.pid)
    try {
      ensureNode(s.sessionId, { cwd: s.cwd, name: s.name })
      setParent(s.sessionId, pend.parentSessionId, pend.type)
    } catch (e) {
      // e.g. the parent was removed between spawn and adoption — leave the child
      // unlinked rather than letting the poll throw.
      console.error('[main] link spawned child failed', e)
    }
    if (pend.note) deliverHandoffNote(s.pid, pend.note)
  }
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
// Start a fresh Claude session in a known cwd (used by the recovery affordance
// when a session's transcript is gone).
ipcMain.handle('session:startFresh', (_e, cwd: string) => {
  if (!cwd) return null
  return { pid: launchSession(cwd), cwd }
})
// Spawn a child session from an active one, auto-linking the typed edge (and an
// optional handoff note) once the child is adopted.
ipcMain.handle(
  'session:spawnChild',
  (_e, parentSessionId: string, cwd: string, type: 'blocking' | 'tangential', note?: string) => {
    if (!parentSessionId || !cwd) return null
    return { pid: spawnChild(parentSessionId, cwd, type, note), cwd }
  },
)
// Pick a folder without launching anything (used by the spawn-child composer).
ipcMain.handle('dialog:pickFolder', async () => {
  if (!win) return null
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Folder for the new session…',
  })
  return r.canceled ? null : (r.filePaths[0] ?? null)
})
// Remove a terminated session from the list: kill any managed terminal, purge
// its dead ~/.claude/sessions files, and drop the registry node.
ipcMain.handle('session:remove', (_e, sessionId: string) => {
  if (!sessionId) return false
  const t = terminals.get(sessionId)
  if (t) {
    try {
      t.pty.kill()
    } catch {
      /* already gone */
    }
    terminals.delete(sessionId)
  }
  if (attachedKey === sessionId) attachedKey = null
  purgeDeadSessionFiles(sessionId)
  deleteNode(sessionId)
  // Also deny-list it so an alive-but-transcript-gone ghost can't be re-adopted.
  const set = getRemovedSet()
  set.add(sessionId)
  setAppState('removedSessions', JSON.stringify([...set]))
  pushSessions()
  return true
})
// Workspace state (last-active session for restore-on-launch, etc.)
ipcMain.handle('state:get', (_e, key: string) => getAppState(key))
ipcMain.on('state:set', (_e, key: string, value: string) => setAppState(key, value))

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
