import { app, BrowserWindow, ipcMain, dialog, nativeImage, clipboard } from 'electron'
import { join } from 'node:path'
import os from 'node:os'
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs'
import * as pty from 'node-pty'
import {
  scanLiveSessions,
  hasTranscript,
  purgeDeadSessionFiles,
  findTranscript,
} from './engine/sessions'
import { readLastAssistantText } from './engine/transcript'
import type { LiveSession } from './engine/types'
import { installAppMenu, setAboutPanel } from './about'
import { APP_VERSION, BUILD_HASH, BUILD_TIME, FULL_VERSION } from '../shared/version'
import {
  initRegistry,
  listCategories,
  createCategory,
  renameCategory,
  deleteCategory,
  setCategoryLabel,
  setCategoryColor,
  ensureNode,
  assignCategory,
  getNodeMap,
  setParent,
  clearParent,
  getEdges,
  setEdgeTrust,
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
const DORMANT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // dormant/resumable sessions age out after a week

// ---------- session polling (status board) ----------
type EnrichedSession = LiveSession & {
  categoryId: number | null
  theme: string | null
  dormant?: boolean // registry node with no live process — resumable, survives restart
  managed?: boolean // the app owns this session's PTY, so it can receive injected prompts
}
interface Snapshot {
  home: string
  scannedAt: number
  sessions: EnrichedSession[]
  categories: Category[]
  edges: Edge[]
  messages: MsgLogEntry[]
  awarenessPaused: boolean
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

// User-given session names, kept in app_state so the periodic scan (which reads
// Claude's own generated title) can't clobber them.
function getSessionNames(): Record<string, string> {
  try {
    return JSON.parse(getAppState('sessionNames') || '{}') as Record<string, string>
  } catch {
    return {}
  }
}
function setSessionName(sessionId: string, name: string): void {
  const m = getSessionNames()
  m[sessionId] = name
  setAppState('sessionNames', JSON.stringify(m))
}

// Split a flags string into argv, respecting simple quotes.
function parseArgs(s: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3])
  return out
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
    // Skip --bg-spare processes: they're not real interactive sessions, and a
    // node for one would resurface as a bogus dormant "resume" row once it dies.
    if (s.sessionId && !s.isSpare) ensureNode(s.sessionId, { cwd: s.cwd, name: s.name, origin: 'adopted' })
  }
  reconcilePendingChildren(sessions)
  reconcilePendingNew(sessions)
  processMailbox(sessions)
  tryDeliveries(sessions)
  deliverPendingNotes(sessions)
  const nodes = getNodeMap()
  const edges = getEdges()
  const now = Date.now()

  // Effective category: a BLOCKING child inherits its parent's category (walk up
  // the blocking chain to the root), so categorizing a parent brings its whole
  // blocking subtree, and a blocking child can't drift into another category.
  // Tangential offshoots and unlinked sessions keep their own.
  const edgeByChild = new Map(edges.map((e) => [e.child_id, e]))
  const catCache = new Map<string, number | null>()
  const categoryOf = (sid: string): number | null => {
    const cached = catCache.get(sid)
    if (cached !== undefined) return cached
    const own = nodes.get(sid)?.category_id ?? null
    catCache.set(sid, own) // pre-seed so an accidental cycle resolves to own
    const e = edgeByChild.get(sid)
    const val = e && e.type === 'blocking' && nodes.has(e.parent_id) ? categoryOf(e.parent_id) : own
    catCache.set(sid, val)
    return val
  }

  const managedIds = managedSessionIds()
  const names = getSessionNames()
  const enriched: EnrichedSession[] = sessions.map((s) => ({
    ...s,
    name: names[s.sessionId] || s.name,
    categoryId: categoryOf(s.sessionId),
    theme: nodes.get(s.sessionId)?.theme ?? null,
    managed: managedIds.has(s.sessionId),
  }))

  // Dormant nodes: sessions the user gave meaning to (categorized or placed in a
  // task tree) that aren't currently running. Keep them in the list so they
  // survive a quit/restart and can be resumed. Uncategorized, edge-less dead
  // sessions are dropped to avoid clutter.
  const liveIds = new Set(sessions.map((s) => s.sessionId))
  const edgeIds = new Set<string>()
  for (const e of edges) {
    edgeIds.add(e.child_id)
    edgeIds.add(e.parent_id)
  }
  for (const [sid, node] of nodes) {
    if (liveIds.has(sid) || removed.has(sid)) continue
    if (node.category_id == null && !edgeIds.has(sid)) continue
    // Recency gate: only recently-active sessions stay resumable, so the dormant
    // list can't grow without bound as sessions accumulate in a categorized cwd.
    if (node.last_seen && now - node.last_seen > DORMANT_MAX_AGE_MS) continue
    enriched.push({
      pid: 0,
      sessionId: sid,
      cwd: node.cwd ?? '',
      name: names[sid] || node.name || undefined,
      alive: false,
      isSpare: false,
      state: 'idle',
      stateReason: 'not running — click to resume',
      categoryId: categoryOf(sid),
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
    messages: messageLog.slice(-40),
    awarenessPaused,
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
    // Prune this session's outbox so a later process reusing its pid can't inherit
    // stale, unrouted messages (and remove the file + any held segments).
    const ob = outboxByPid.get(p.pid)
    if (ob) {
      outboxOwner.delete(ob.token)
      outboxByPid.delete(p.pid)
      heldMessages.delete(ob.token)
      try {
        unlinkSync(ob.path)
      } catch {
        /* already gone */
      }
    }
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
function launchSession(cwd: string, args: string[] = [], extraEnv: Record<string, string> = {}): number {
  const cmd = resolveClaude()
  // Every app-spawned session gets an outbox so it can take part in the awareness
  // bus in BOTH directions — message its parent (plain text) or a named child
  // (@name). The file is created lazily when the session first writes to it.
  const token = `cc-${Date.now()}-${outboxCounter++}`
  const outboxPath = join(MAIL_DIR, `${token}.msg`)
  const p = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: { ...buildEnv(), ...extraEnv, CC_OUTBOX: outboxPath },
  })
  outboxOwner.set(token, p.pid)
  outboxByPid.set(p.pid, { token, path: outboxPath })
  const key = `new:${p.pid}`
  console.log(`[main] new session: spawned ${cmd} ${args.join(' ')} in ${cwd} pid=${p.pid}`)
  wireTerm(key, p, { cwd })
  attachedKey = key
  win?.webContents.send('term:show', { key, pid: p.pid, name: 'new session', cwd })
  return p.pid
}

// ---------- awareness bus: autonomous cross-session messaging ----------
// A child writes a message to its outbox file (taught via the spawn preamble);
// each scan the app reads it, routes to the parent via the edge graph, and — if
// the link is trusted — injects it into the parent as a new turn when the parent
// is free. Every hop is logged; a rate/hop guard stops runaway loops.
const MAIL_DIR = join(os.homedir(), '.claude', 'ccc', app.isPackaged ? 'mail' : 'mail-dev')
const HOP_MAX = 6
const RATE_WINDOW_MS = 60_000
const RATE_MAX = 6
const HELD_TTL_MS = 30 * 60_000 // a message that never becomes routable expires
let outboxCounter = 0
let awarenessPaused = false // global kill switch — hold all routing + delivery
const outboxOwner = new Map<string, number>() // outbox token -> owning session pid
const outboxByPid = new Map<number, { token: string; path: string }>() // pid -> its outbox

interface Delivery {
  to: string // target session id
  fromSessionId: string // sender session id — rate key + edge-pair validation
  edgeChildId: string // child_id of the governing edge — for the trust re-check
  fromName: string
  text: string
  hops: number
  at: number
}
export interface MsgLogEntry {
  from: string
  to: string
  text: string
  status: string
  at: number
}
const deliveryQueue: Delivery[] = []
const messageLog: MsgLogEntry[] = []
const linkRate = new Map<string, number[]>()
// Messages drained from a child outbox but not yet routable (link unblessed, or
// child not yet adopted). Buffered here — NOT dropped on read — so they survive
// until the link is trusted / the child is adopted, then flush. Keyed by token.
// Per-token FIFO of pending messages. Each outbox write is its own segment —
// never concatenated — so a directed and a plain message written back to back are
// classified and routed independently rather than merged in one direction.
const heldMessages = new Map<string, { text: string; at: number; logged: boolean }[]>()

function awarenessPreamble(outbox: string): string {
  return (
    `[CC Command Center — fleet] You are a session in a managed fleet. To message a linked ` +
    `session, write to this file:\n${outbox}\n` +
    `• Plain text goes to your PARENT session.\n` +
    `• A message starting with "@<name> " goes to your child session named <name>.\n` +
    `Delivered when the recipient is free. Message only on a genuine need — a real update, ` +
    `question, or instruction. (No acknowledgement needed for this note.)`
  )
}

// Self-contained note injected into a PARENT when a link is blessed, so it learns
// it can now message that specific child down the link (a top-level parent may
// never have seen a spawn preamble).
function parentBlessNote(childName: string, outbox: string): string {
  return (
    `[CC Command Center — fleet] The link with your child session "${childName}" is now trusted. ` +
    `To message it, write to this file:\n${outbox}\n` +
    `Start the message with "@${childName} " to send it to that child (plain text without an @ goes ` +
    `to YOUR parent). Delivered when the child is free. Only message on a genuine need. ` +
    `(No acknowledgement needed for this note.)`
  )
}

// The display name a human sees for a session (user override, else Claude's title,
// else the pid) — used for @-addressing resolution and the message log.
function displayName(s: LiveSession): string {
  const named = s.sessionId ? getSessionNames()[s.sessionId] : undefined
  return named ?? s.name ?? `pid ${s.pid}`
}

// A directed message targets a child: it starts with "@". Returns the text after
// the "@" (the child name is resolved by prefix-match against the sender's
// children) plus a first-word hint for logging. Plain messages return null (→ up).
function parseDirective(text: string): { rest: string; handleHint: string } | null {
  const t = text.trimStart()
  if (!t.startsWith('@')) return null
  const rest = t.slice(1)
  return { rest, handleHint: rest.split(/[\s:,]/, 1)[0] ?? '' }
}

function logMsg(from: string, to: string, text: string, status: string): void {
  messageLog.push({ from, to, text: text.slice(0, 500), status, at: Date.now() })
  if (messageLog.length > 60) messageLog.shift()
}

export function setAwarenessPaused(paused: boolean): void {
  awarenessPaused = paused
}

// Drain each child outbox into the held buffer. Reading empties the file (a child
// writes fresh each time), but the content is preserved in memory — never lost on
// read, so an un-blessed link's message waits for the bless instead of vanishing.
function drainOutboxes(): void {
  let files: string[] = []
  try {
    files = readdirSync(MAIL_DIR).filter((f) => f.endsWith('.msg'))
  } catch {
    return
  }
  for (const f of files) {
    const fp = join(MAIL_DIR, f)
    let content = ''
    try {
      content = readFileSync(fp, 'utf8').trim()
    } catch {
      continue
    }
    if (!content) continue
    try {
      writeFileSync(fp, '')
    } catch {
      /* ignore */
    }
    const token = f.replace(/\.msg$/, '')
    const arr = heldMessages.get(token) ?? []
    arr.push({ text: content.slice(-4000), at: Date.now(), logged: false })
    if (arr.length > 30) arr.splice(0, arr.length - 30) // bound a runaway writer
    heldMessages.set(token, arr)
  }
}

// Resolve an "@name …" directive against the sender's children by display-name
// prefix, requiring a word boundary after the name (so "@apidoc" can't match a
// child named "a"); longest match wins. Returns undefined if no child matches.
function matchDirectedChild(
  sessions: LiveSession[],
  edges: Edge[],
  senderId: string,
  rest: string,
): { child: LiveSession; body: string; trusted: boolean } | undefined {
  let best: { child: LiveSession; body: string; trusted: boolean } | undefined
  const lower = rest.toLowerCase()
  for (const e of edges) {
    if (e.parent_id !== senderId) continue
    const child = sessions.find((s) => s.sessionId === e.child_id)
    if (!child) continue
    const nm = displayName(child)
    if (!nm || !lower.startsWith(nm.toLowerCase())) continue
    const after = rest.charAt(nm.length) // '' at end-of-string is fine (exact match)
    if (after && !/[\s:,]/.test(after)) continue // reject mid-word prefix hits
    if (!best || nm.length > displayName(best.child).length) {
      best = {
        child,
        body: rest.slice(nm.length).replace(/^[\s:,-]+/, '').trim(),
        trusted: !!e.trusted,
      }
    }
  }
  return best
}

// Route each held segment independently: "@name …" DOWN to the named child (if one
// matches AND the link is trusted), everything else UP to the sender's parent — so
// an "@scoped/pkg" that matches no child still reaches the parent instead of being
// lost. Routed/expired segments are removed; the rest stay held for the next scan.
function routeHeld(sessions: LiveSession[]): void {
  const now = Date.now()
  for (const [token, arr] of heldMessages) {
    const senderPid = outboxOwner.get(token)
    const sender = senderPid
      ? sessions.find((s) => s.pid === senderPid && s.sessionId)
      : undefined
    const edges = getEdges()
    for (let i = 0; i < arr.length; ) {
      const held = arr[i]
      if (now - held.at > HELD_TTL_MS) {
        logMsg('?', '?', held.text, 'expired: never routable')
        arr.splice(i, 1)
        continue
      }
      if (!sender || !sender.sessionId) {
        i++
        continue
      } // sender not adopted yet — keep held
      const senderId = sender.sessionId

      const directed = parseDirective(held.text)
      const match = directed ? matchDirectedChild(sessions, edges, senderId, directed.rest) : undefined
      if (match) {
        if (!match.trusted) {
          if (!held.logged) {
            logMsg(displayName(sender), displayName(match.child), held.text, 'held: link not trusted')
            held.logged = true
          }
          i++
          continue
        }
        if (!match.body) {
          logMsg(displayName(sender), displayName(match.child), held.text, 'dropped: empty directed message')
          arr.splice(i, 1)
          continue
        }
        deliveryQueue.push({
          to: match.child.sessionId!,
          fromSessionId: senderId,
          edgeChildId: match.child.sessionId!,
          fromName: displayName(sender),
          text: match.body,
          hops: 1,
          at: now,
        })
        arr.splice(i, 1)
        continue
      }

      // Plain, or a directive that matched no child → UP to the sender's parent.
      const edge = edges.find((e) => e.child_id === senderId)
      if (!edge || !edge.trusted) {
        if (!held.logged) {
          logMsg(
            displayName(sender),
            edge ? 'parent' : '?',
            held.text,
            edge ? 'held: link not trusted' : 'held: no parent link',
          )
          held.logged = true
        }
        i++
        continue
      }
      deliveryQueue.push({
        to: edge.parent_id,
        fromSessionId: senderId,
        edgeChildId: senderId,
        fromName: displayName(sender),
        text: held.text,
        hops: 1,
        at: now,
      })
      arr.splice(i, 1)
    }
    if (arr.length === 0) heldMessages.delete(token)
  }
}

function processMailbox(sessions: LiveSession[]): void {
  drainOutboxes()
  if (!awarenessPaused) routeHeld(sessions)
}

// Deliver queued messages to free targets. One message per target per pass so
// distinct messages land as distinct turns (not merged by deferred paste-CRs);
// trust re-checked at delivery so an untrust stops in-flight; rate guard keyed on
// the stable session id; delivered only when the target is affirmatively free.
function tryDeliveries(sessions: LiveSession[]): void {
  if (awarenessPaused || deliveryQueue.length === 0) return
  const now = Date.now()
  const deliveredTo = new Set<string>()
  let i = 0
  while (i < deliveryQueue.length) {
    const d = deliveryQueue[i]
    if (deliveredTo.has(d.to)) {
      i++ // already delivered to this target this pass — next one waits a scan
      continue
    }
    const target = sessions.find((s) => s.sessionId === d.to)
    const term = findManagedTerm(d.to)
    if (!target || !term) {
      if (now - d.at > 120_000) {
        deliveryQueue.splice(i, 1)
        logMsg(d.fromName, d.to, d.text, 'expired: target not open')
      } else i++
      continue
    }
    // re-check trust at delivery: an untrust (or re-parent) drops in-flight. Find
    // the governing edge by edgeChildId; it must still be trusted AND connect
    // sender↔target (either direction — parent→child or child→parent).
    const edge = getEdges().find((e) => e.child_id === d.edgeChildId)
    const connectsPair =
      !!edge &&
      ((edge.child_id === d.fromSessionId && edge.parent_id === d.to) ||
        (edge.parent_id === d.fromSessionId && edge.child_id === d.to))
    if (!edge || !edge.trusted || !connectsPair) {
      deliveryQueue.splice(i, 1)
      logMsg(d.fromName, target.name ?? d.to, d.text, 'dropped: link no longer trusted')
      continue
    }
    // only deliver when the target is affirmatively free (fail-safe on unknown)
    if (target.state !== 'idle' && target.state !== 'waiting') {
      i++
      continue
    }
    // Rate guard keyed on the LINK (both directions share one budget), so a
    // bidirectional parent↔child ping-pong is capped at RATE_MAX per window total,
    // not RATE_MAX per direction. (The hop guard is unused in this mailbox model.)
    const pair = [d.fromSessionId, d.to].sort()
    const key = `${pair[0]}|${pair[1]}`
    const stamps = (linkRate.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS)
    if (d.hops > HOP_MAX || stamps.length >= RATE_MAX) {
      deliveryQueue.splice(i, 1)
      logMsg(d.fromName, target.name ?? d.to, d.text, 'dropped: loop/rate guard')
      continue
    }
    injectPrompt(term, `[message from ${d.fromName}]\n${d.text}`)
    stamps.push(now)
    linkRate.set(key, stamps)
    deliveredTo.add(d.to)
    deliveryQueue.splice(i, 1)
    logMsg(d.fromName, target.name ?? d.to, d.text, 'delivered')
  }
}

// Children spawned from an active session. The typed edge can't be set until the
// new session gets its own Claude session id (written on adoption ~1.5s later),
// so we stash the intent keyed by the child's pid and resolve it in the scan.
interface PendingChild {
  parentSessionId: string
  type: 'blocking' | 'tangential'
  note?: string
  name?: string // user-set name applied on adoption; stable @-handle for the bus
  at: number
}
// Keyed by the child's pid. Entries expire so a child that dies before adoption
// can't mislink an unrelated process that later reuses its pid.
const pendingChildren = new Map<number, PendingChild>()
const PENDING_TTL_MS = 60_000

// A session created via the New-session modal, awaiting adoption to apply its
// category / name / initial instructions.
interface PendingNew {
  categoryId: number | null
  name?: string
  instructions?: string
  at: number
}
const pendingNew = new Map<number, PendingNew>()

function findTermByPid(pid: number): Term | undefined {
  for (const t of terminals.values()) if (t.pty.pid === pid) return t
  return undefined
}

function spawnChild(
  parentSessionId: string,
  cwd: string,
  type: 'blocking' | 'tangential',
  note?: string,
  name?: string,
): number {
  const pid = launchSession(cwd, [], { CC_ROLE: 'child' })
  const outbox = outboxByPid.get(pid)?.path ?? ''
  const userNote = note?.trim()
  const preamble = awarenessPreamble(outbox)
  pendingChildren.set(pid, {
    parentSessionId,
    type,
    note: userNote ? `${preamble}\n\n— — —\n\n${userNote}` : preamble,
    name: name?.trim() || undefined,
    at: Date.now(),
  })
  return pid
}

// Type text into a session's input as if pasted, then submit. Claude's Ink input
// needs the bracketed-paste envelope; a raw CR alone does not submit, so the CR
// is sent separately after a beat. This is the transport for every cross-session
// send (Channels injection is blocked in this environment).
function injectPrompt(term: Term, text: string, crDelay = 150): void {
  term.pty.write(`\x1b[200~${text}\x1b[201~`)
  setTimeout(() => {
    try {
      term.pty.write('\r')
    } catch {
      /* terminal gone */
    }
  }, crDelay)
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
      injectPrompt(term, note, 400)
      return
    }
    setTimeout(tryDeliver, 300)
  }
  setTimeout(tryDeliver, 400)
}

// Sessions the app owns a live PTY for (keyed by session id or new:<pid>). Only
// these can receive an injected prompt; adopted/external sessions are read-only.
function managedSessionIds(): Set<string> {
  const ids = new Set<string>()
  for (const [k, t] of terminals) {
    if (t.exited) continue
    ids.add(k)
    if (t.sessionId) ids.add(t.sessionId)
  }
  return ids
}

function findManagedTerm(sessionId: string): Term | undefined {
  const direct = terminals.get(sessionId)
  if (direct && !direct.exited) return direct
  for (const t of terminals.values()) if (!t.exited && t.sessionId === sessionId) return t
  return undefined
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
      // A user-set name is the child's stable, @-addressable handle (the bus
      // resolves @name on the user name before Claude's drifting auto-title).
      if (pend.name) setSessionName(s.sessionId, pend.name)
    } catch (e) {
      // e.g. the parent was removed between spawn and adoption — leave the child
      // unlinked rather than letting the poll throw.
      console.error('[main] link spawned child failed', e)
    }
    if (pend.note) deliverHandoffNote(s.pid, pend.note)
  }
}

// Apply a New-session modal's category / name / initial instructions once the
// session is adopted and has a session id.
function reconcilePendingNew(sessions: LiveSession[]): void {
  if (pendingNew.size === 0) return
  const now = Date.now()
  for (const [pid, p] of pendingNew) if (now - p.at > PENDING_TTL_MS) pendingNew.delete(pid)
  for (const s of sessions) {
    if (!s.sessionId) continue
    const p = pendingNew.get(s.pid)
    if (!p) continue
    pendingNew.delete(s.pid)
    try {
      ensureNode(s.sessionId, { cwd: s.cwd, name: s.name })
      if (p.categoryId != null) assignCategory(s.sessionId, p.categoryId)
      if (p.name) setSessionName(s.sessionId, p.name)
    } catch (e) {
      console.error('[main] configure new session failed', e)
    }
    if (p.instructions) deliverHandoffNote(s.pid, p.instructions)
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
    backgroundColor: '#0e0d0b',
    title: 'CC Command Center',
    icon: join(app.getAppPath(), 'resources/icon.png'),
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
ipcMain.handle('cat:setLabel', (_e, id: number, label: string | null) => {
  setCategoryLabel(id, label)
  pushSessions()
  return true
})
ipcMain.handle('cat:setColor', (_e, id: number, color: string) => {
  setCategoryColor(id, color)
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
ipcMain.handle('edge:trust', (_e, childId: string, trusted: boolean) => {
  setEdgeTrust(childId, trusted)
  if (trusted) notifyParentOfTrustedChild(childId)
  pushSessions()
  return true
})

// When a link is blessed, tell the (app-managed) parent it can now message this
// child down the link. Parent→child needs the parent to have an outbox, which
// only app-spawned sessions do — adopted parents keep child→parent only.
function notifyParentOfTrustedChild(childId: string): void {
  try {
    const edge = getEdges().find((e) => e.child_id === childId)
    if (!edge) return
    const parentTerm = findManagedTerm(edge.parent_id)
    if (!parentTerm || parentTerm.exited) return
    const outbox = outboxByPid.get(parentTerm.pty.pid)?.path
    if (!outbox) return
    // Resolve the child name the SAME way routeHeld matches it (user name → registry
    // name → "pid <pid>"), so the "@name" we tell the parent to use actually routes.
    const childPid = findManagedTerm(childId)?.pty.pid
    const childName =
      getSessionNames()[childId] ??
      getNodeMap().get(childId)?.name ??
      (childPid ? `pid ${childPid}` : childId)
    // Deferred, not injected now: delivered on the next scan when the parent is
    // free, so it can't corrupt a mid-turn generation.
    pendingParentNotes.push({ to: edge.parent_id, text: parentBlessNote(childName, outbox), at: Date.now() })
  } catch (e) {
    console.error('[main] notify parent of trusted child failed', e)
  }
}

// One-time app→parent notes (currently the bless note). Delivered only when the
// parent is affirmatively free, so injection never lands mid-turn.
const pendingParentNotes: Array<{ to: string; text: string; at: number }> = []
function deliverPendingNotes(sessions: LiveSession[]): void {
  if (awarenessPaused || pendingParentNotes.length === 0) return
  const now = Date.now()
  for (let i = pendingParentNotes.length - 1; i >= 0; i--) {
    const n = pendingParentNotes[i]
    if (now - n.at > 120_000) {
      pendingParentNotes.splice(i, 1)
      continue
    } // expired
    const target = sessions.find((s) => s.sessionId === n.to)
    const term = findManagedTerm(n.to)
    if (!target || !term || term.exited) continue // parent not open yet — wait
    if (target.state !== 'idle' && target.state !== 'waiting') continue // busy — wait
    injectPrompt(term, n.text, 400)
    pendingParentNotes.splice(i, 1)
  }
}
// Global kill switch for autonomous messaging. When paused, outboxes are still
// drained into the held buffer (nothing is lost) but nothing is routed or
// delivered until the operator resumes.
ipcMain.handle('awareness:pause', (_e, paused: boolean) => {
  setAwarenessPaused(!!paused)
  pushSessions()
  return awarenessPaused
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
  (
    _e,
    parentSessionId: string,
    cwd: string,
    type: 'blocking' | 'tangential',
    note?: string,
    name?: string,
  ) => {
    if (!parentSessionId || !cwd) return null
    return { pid: spawnChild(parentSessionId, cwd, type, note, name), cwd }
  },
)
// Copy-out: put the session's most recent assistant reply on the clipboard, so
// it can be handed to another session (or anywhere).
ipcMain.handle('session:copyOutput', (_e, sessionId: string, cwd: string) => {
  const path = findTranscript(sessionId, cwd)
  if (!path) return { ok: false }
  const text = readLastAssistantText(path)
  if (!text) return { ok: false }
  clipboard.writeText(text)
  return { ok: true, chars: text.length }
})

// Cross-session send: inject a prompt into another managed session. Returns a
// delivery result the UI surfaces (sent / can't reach a monitor-only session).
ipcMain.handle('session:send', (_e, sessionId: string, text: string) => {
  if (!sessionId || !text?.trim()) return { ok: false, reason: 'empty' }
  const t = findManagedTerm(sessionId)
  if (!t) return { ok: false, reason: 'monitor-only' } // not open under management here
  try {
    injectPrompt(t, text.trim())
    return { ok: true }
  } catch {
    return { ok: false, reason: 'write-failed' }
  }
})

// Pick a folder without launching anything; remembers the last location so the
// dialog reopens there instead of ~/ each time.
ipcMain.handle('dialog:pickFolder', async () => {
  if (!win) return null
  const last = getAppState('lastFolder') || undefined
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Folder for the new session…',
    defaultPath: last,
  })
  if (r.canceled || !r.filePaths[0]) return null
  setAppState('lastFolder', r.filePaths[0])
  return r.filePaths[0]
})

// Create a session from the New-session modal: launch in cwd with flags, then
// apply category / name / initial instructions once it's adopted.
ipcMain.handle(
  'session:create',
  (
    _e,
    opts: {
      cwd: string
      flags?: string
      categoryId?: number | null
      name?: string
      instructions?: string
    },
  ) => {
    if (!opts?.cwd) return null
    const pid = launchSession(opts.cwd, opts.flags ? parseArgs(opts.flags) : [])
    pendingNew.set(pid, {
      categoryId: opts.categoryId ?? null,
      name: opts.name?.trim() || undefined,
      instructions: opts.instructions?.trim() || undefined,
      at: Date.now(),
    })
    return { pid, cwd: opts.cwd }
  },
)
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

// Dev and the signed/stable build must NOT share a data dir: dev churn (killing
// terminals, DB migrations, session removal) would corrupt the real sessions you
// keep in the stable app. Packaged → "CC Command Center" (your data); dev → an
// isolated "CC Command Center Dev" sandbox. Electron derives userData from the app
// name, so this one line separates their registries. (MAIL_DIR is split the same
// way above, so two running instances never consume each other's messages.)
app.setName(app.isPackaged ? 'CC Command Center' : 'CC Command Center Dev')

// Electron derives userData from the app name, so a rename would point at a
// fresh empty dir. Carry the existing registry across: if the new location has
// no DB yet but the previous ("Claude Command Center") one does, copy it over.
function migrateUserData(fromName: string): void {
  try {
    const dest = app.getPath('userData')
    const src = join(app.getPath('appData'), fromName)
    if (existsSync(join(dest, 'registry.db')) || !existsSync(join(src, 'registry.db'))) return
    mkdirSync(dest, { recursive: true })
    for (const f of ['registry.db', 'registry.db-wal', 'registry.db-shm']) {
      const s = join(src, f)
      if (existsSync(s)) copyFileSync(s, join(dest, f))
    }
    console.log(`[main] migrated userData from "${fromName}"`)
  } catch (e) {
    console.error('[main] userData migration failed', e)
  }
}

function setDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  try {
    const img = nativeImage.createFromPath(join(app.getAppPath(), 'resources/icon.png'))
    if (!img.isEmpty()) app.dock.setIcon(img)
  } catch (e) {
    console.error('[main] dock icon failed', e)
  }
}

app.whenReady().then(() => {
  migrateUserData('Claude Command Center')
  try {
    mkdirSync(MAIL_DIR, { recursive: true })
  } catch {
    /* ignore */
  }
  setDockIcon()
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
