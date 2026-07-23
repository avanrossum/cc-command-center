import {
  Component,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { insertablePath } from './util'
import { TerminalView } from './Terminal'
import { THEMES, themeByName, DEFAULT_THEME_NAME } from './themes'
import { listMonospaceFonts, fontFamilyCss, DEFAULT_TERMINAL_FONT_SIZE } from './fonts'
import { highlightCode } from './highlight'
import { renderMarkdown } from './markdown'
import { rtfToHtml } from './rtf'
import { OverviewGrid, type OverviewSession } from './Overview'

type CoarseState = 'working' | 'waiting' | 'idle' | 'unknown'
// 'blocked' and 'permission' are DERIVED display states, not coarse engine states.
// 'blocked': a parent whose blocking child is unfinished (computed in the renderer).
// 'permission': a managed session parked on a dialog (the engine reports it via
// s.attention, scanned from the live PTY buffer — it reads as 'working' in the
// transcript, so this is the only way it surfaces as needing you).
type DisplayState = CoarseState | 'blocked' | 'permission' | 'done'

interface Session {
  pid: number
  sessionId: string
  cwd: string
  name?: string
  version?: string
  state: CoarseState
  stateReason: string
  transcriptMtimeMs?: number
  isSpare: boolean
  alive: boolean
  categoryId: number | null
  theme: string | null
  dormant?: boolean
  managed?: boolean
  // Remembered launch params, and whether they apply without asking. `claude
  // --resume` doesn't carry model/effort/permission-mode forward, so a session
  // without sticky flags is gated behind the params modal before it resumes.
  resumeFlags?: ResumeFlags
  resumeSticky?: boolean
  attention?: 'permission' | 'question' // parked on a dialog: approve (door) vs answer (brain)
  // The substance behind a needs-you moment — see EnrichedSession in main. Blocked
  // -on-child is derived here from the edge graph, not sent from main.
  whyKind?: 'permission' | 'question' | 'done'
  why?: string
  whyCoarse?: boolean
  whyGloss?: string // Arbiter seam — a plain-English gloss, rendered only when present
  subtasks?: {
    id: string
    description: string
    subagentType?: string
    background: boolean
    source: 'task' | 'workflow' | 'shell'
    status: 'running' | 'done' | 'stalled' | 'failed'
    startedAt?: number
  }[]
  workflows?: {
    runId: string
    name: string
    description?: string
    agentTotal: number
    agentDone: number
    status: 'running' | 'done'
    startedAt?: number
  }[]
  artifacts?: {
    path: string
    name: string
    kind: 'image' | 'svg' | 'pdf' | 'html' | 'markdown' | 'text' | 'audio' | 'code' | 'office' | 'rtf'
    mtimeMs: number
  }[]
  unhandled?: boolean // open gate you haven't looked at yet — shows a pip until seen
  contextPct?: number | null // context window used %, from the session's statusLine
}
interface Category {
  id: number
  name: string
  color: string
  sort: number
  label: string | null
  emoji: string | null
  arbiter_context: number // 1 → this category's session substance may go to the API
  // Per-category notification overrides. null = inherit the global switch.
  notify_permission: number | null
  notify_question: number | null
  notify_done: number | null
}
interface ArbiterPanel {
  status: 'idle' | 'running' | 'capped' | 'error' | 'off' | 'paused'
  spend: { todayUsd: number; totalUsd: number; calls: number; lastAt: number | null }
  log: { id: number; at: number; kind: string; text: string }[]
}
interface ApiKey {
  id: number
  name: string
  hint: string
  created_at: number
}
interface ChangelogEntry {
  version: string
  date?: string
  critical?: boolean
  features: string[]
}
interface UpdatePayload {
  version: string
  currentVersion: string
  critical: boolean
  features: string[]
  changelog: ChangelogEntry[]
}
interface Edge {
  child_id: string
  parent_id: string
  type: string
  source: string
  trusted?: number
}
interface MsgLogEntry {
  from: string
  to: string
  text: string
  status: string
  at: number
}
interface AppSettings {
  trustChildrenByDefault: boolean
  mailAllowGranted: boolean
  firstRunSeen: boolean
  lastModel: string
  lastEffort: string
  lastContext: string
  lastMode: string
  lastResumeSticky: boolean
  arbiterEnabled: boolean
  arbiterKeyId: number | null
  arbiterCapUsd: number
  arbiterModel: string
  arbiterPaused: boolean
  statusHooksInstalled: boolean
  spawnAutoMode: boolean
  terminalFont: string
  terminalFontSize: number
  hideUnmanaged: boolean
  notifyEnabled: boolean
  notifyPermission: boolean
  notifyQuestion: boolean
  notifyDone: boolean
}
interface Snapshot {
  home: string
  scannedAt: number
  sessions: Session[]
  categories: Category[]
  edges: Edge[]
  messages?: MsgLogEntry[]
  awarenessPaused?: boolean
  settings?: AppSettings
  recentFolders?: string[]
  apiKeys?: ApiKey[]
  arbiter?: ArbiterPanel
  usage?: {
    fiveHour: { pct: number; resetsAt: number } | null
    sevenDay: { pct: number; resetsAt: number } | null
  }
}
interface ResumeFlags {
  model: string
  context: string
  effort: string
  mode: string
}
interface Selected {
  key: string
  pid?: number
  sessionId?: string
  cwd: string
  name: string
  resume: boolean
  // True only when a live original existed elsewhere (alive but not app-managed) at
  // open time — i.e. this is genuinely a second copy. A dormant/restart resume is
  // NOT one, so the "original keeps running" notice must not claim it.
  hadLiveOriginal: boolean
  // One-shot params from the resume modal; forwarded to term:open.
  resumeFlags?: ResumeFlags
}
type MenuMode = 'root' | 'blocking' | 'tangential'
interface Menu {
  x: number
  y: number
  session: Session
  mode: MenuMode
}
interface TreeRow {
  s: Session
  depth: number
  edgeType: string | null
}

const STATE: Record<DisplayState, { label: string; color: string; order: number }> = {
  // Highest urgency: the session is parked on a dialog it can't clear itself.
  // Detected from the live PTY buffer, so it's high-signal (not a guess).
  permission: { label: 'Needs approval', color: '#f59e0b', order: -1 },
  working: { label: 'Working', color: '#34d399', order: 0 },
  // Blue = the assistant's last turn ended recently, so structurally it's the
  // human's move. It does NOT mean a question/permission was detected (a parked
  // dialog surfaces as 'permission' above) — so the honest label is "Your turn".
  waiting: { label: 'Your turn', color: '#60a5fa', order: 1 },
  blocked: { label: 'Blocked', color: '#e070c8', order: 2 },
  // A turn that ended on a statement — job complete, your move. A calm teal, and
  // lower urgency than the action gates above (awareness of completion, not a block).
  done: { label: 'Done', color: '#5eead4', order: 2.5 },
  idle: { label: 'Idle', color: '#6b7280', order: 3 },
  unknown: { label: 'Unknown', color: '#a78bfa', order: 4 },
}

function fmtAge(ms: number | undefined, now: number): string {
  if (!ms) return ''
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

// Time until a rate-limit window resets. resetsAt is unix SECONDS.
function fmtResetIn(resetsAtSec: number, nowMs: number): string {
  const ms = resetsAtSec * 1000 - nowMs
  if (ms <= 0) return 'now'
  const m = Math.floor(ms / 60000)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d${h % 24}h`
  if (h > 0) return `${h}h${m % 60}m`
  return `${m}m`
}
// >=85% is the auto-compact / near-limit danger zone the user flagged; 65% warns.
const ctxTone = (pct: number | null | undefined): '' | 'warm' | 'hot' =>
  pct == null ? '' : pct >= 85 ? 'hot' : pct >= 65 ? 'warm' : ''

// Continuous fill color for the context bar: green (empty) → amber (~65) → red
// (full), so context load reads at a glance without checking the number. Passes
// through the 65/85 warn/danger zones the chip uses.
const ctxBarColor = (pct: number): string => {
  const p = Math.max(0, Math.min(100, pct))
  const hue = 130 - 1.25 * p // 130°(green) at 0% → ~5°(red) at 100%
  return `hsl(${Math.round(hue)}, 72%, 46%)`
}

// A thin context-usage bar that spans the full width of the item it sits in, as
// if it were the item's bottom border. The parent must be position:relative.
function CtxBar({ pct }: { pct: number | null | undefined }) {
  if (typeof pct !== 'number') return null
  const p = Math.max(0, Math.min(100, pct))
  return (
    <div className="ctxbar" aria-hidden="true">
      <div className="ctxbar-fill" style={{ width: `${p}%`, background: ctxBarColor(p) }} />
    </div>
  )
}

// Account-wide 5h / 7d usage: a small bar + % + reset countdown, in the beacon.
function UsageMeter({
  usage,
  now,
}: {
  usage: Snapshot['usage']
  now: number
}): React.ReactElement | null {
  if (!usage || (!usage.fiveHour && !usage.sevenDay)) return null
  const bar = (label: string, r: { pct: number; resetsAt: number } | null): React.ReactElement | null => {
    if (!r) return null
    const tone = r.pct >= 85 ? 'hot' : r.pct >= 65 ? 'warm' : ''
    return (
      <div
        className="um-item"
        title={`${label} rate limit: ${r.pct}% used · resets in ${fmtResetIn(r.resetsAt, now)}`}
      >
        <span className="um-label">{label}</span>
        <span className="um-bar">
          <span className={`um-fill ${tone}`} style={{ width: `${Math.min(100, r.pct)}%` }} />
        </span>
        <span className={`um-pct ${tone}`}>{r.pct}%</span>
        <span className="um-reset">{fmtResetIn(r.resetsAt, now)}</span>
      </div>
    )
  }
  return (
    <div className="usagemeter">
      {bar('5h', usage.fiveHour)}
      {bar('7d', usage.sevenDay)}
    </div>
  )
}

const bySort = (a: Session, b: Session) =>
  STATE[a.state].order - STATE[b.state].order || (a.name ?? '').localeCompare(b.name ?? '')

// All descendant session ids of a node, via the edge graph (for remove-subtree
// confirmations). Matches the main-process descendantsOf.
function descendantIds(sessionId: string, edges: Edge[]): string[] {
  const out: string[] = []
  const seen = new Set<string>([sessionId])
  const stack = [sessionId]
  while (stack.length) {
    const cur = stack.pop()!
    for (const e of edges) {
      if (e.parent_id === cur && !seen.has(e.child_id)) {
        seen.add(e.child_id)
        out.push(e.child_id)
        stack.push(e.child_id)
      }
    }
  }
  return out
}

// A readable default rail word from the category name — the first word, kept as-is
// (not cryptic initials). The rail cell caps its width; the user can set a custom
// short word + an emoji for anything that doesn't read well truncated.
function autoTag(name: string): string {
  const words = name
    .split(/[\s·/|,_-]+/)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(Boolean)
  if (words.length === 0) return '?'
  return words[0].slice(0, 7)
}

const CAT_PALETTE = [
  '#e2b34a', '#4ac0e2', '#e2724a', '#9b6ff0', '#d14a9b',
  '#2fb8a0', '#e0625f', '#9bbf4a', '#6d7cf0',
]

// A curated palette of category-labelling emoji, so picking one is a click — most
// people don't know the macOS fn / ctrl-⌘-space picker. Typing/pasting still works.
const CAT_EMOJI = [
  '💼', '🏢', '📊', '💰', '📁', '🗂️', '📈', '🧾',
  '💻', '⚙️', '🔧', '🚀', '🧪', '🐛', '🖥️', '🤖',
  '☁️', '🔌', '🗄️', '📦', '🧠', '💡', '🔬', '🧩',
  '🤝', '🎯', '👥', '🏠', '🌊', '🌱', '🎨', '📚',
  '⭐', '🔥', '⚡', '🔔', '🗓️', '📝', '✈️', '🎛️',
]

export function App() {
  const [snap, setSnap] = useState<Snapshot>({
    home: '',
    scannedAt: 0,
    sessions: [],
    categories: [],
    edges: [],
  })
  const [selected, setSelected] = useState<Selected | null>(null)
  // Latest selection, readable from event subscriptions without stale closures.
  const selectedRef = useRef<Selected | null>(null)
  useEffect(() => {
    selectedRef.current = selected
  }, [selected])
  // Most-recently-opened session per category, so clicking a category rail cell
  // jumps back to where you left off in it. Keyed by categoryId (null = uncat).
  const lastByCat = useRef<Map<number | null, string>>(new Map())
  // Monotonic "user last opened this session" order, for sorting live-idle rows
  // (higher = more recent). In-memory per run; resets to mtime order on restart.
  const openOrder = useRef<Map<string, number>>(new Map())
  const openSeq = useRef(0)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [version, setVersion] = useState('')
  // The category rail selects ONE collection; its tree shows in the pane below.
  const [selectedCat, setSelectedCat] = useState<number | null>(null)
  const initCatRef = useRef(false)
  // Restore the last-selected category on launch (persisted as a string: the id,
  // or 'null' for Uncategorized). Loaded async; the init-select effect waits for it.
  const restoredCatRef = useRef<string | null>(null)
  const [catRestoreLoaded, setCatRestoreLoaded] = useState(false)
  // Drag-to-reorder categories in the rail (Uncategorized isn't draggable).
  // A session waiting on the "set the starting parameters" modal before it resumes.
  // The "50k-foot" overview grid — a fleet-wide view of every active session.
  // Toggled by ⌘⇧E / the beacon button; Esc closes; clicking a tile dives in.
  const [overviewOpen, setOverviewOpen] = useState(false)
  // Also show live-idle sessions in the grid (still never dormant/needs-resume).
  // Persisted; off by default so the grid stays focused on what's in motion.
  const [overviewIdle, setOverviewIdle] = useState(false)
  useEffect(() => {
    window.cc.stateGet('overviewIdle').then((v) => v === 'true' && setOverviewIdle(true))
  }, [])
  const toggleOverviewIdle = (): void =>
    setOverviewIdle((v) => {
      window.cc.stateSet('overviewIdle', String(!v))
      return !v
    })
  // A session waiting on the launch-parameters modal. `edit` true = opened from the
  // context menu to change stored flags (save & close); false = the gate before a
  // non-sticky resume (save optional, then open).
  const [resumeGate, setResumeGate] = useState<{ session: Session; edit: boolean } | null>(null)
  // Restore-on-launch found a session that would need the modal. Rather than
  // popping one on every app start, select it and offer a Resume button.
  const [deferredResume, setDeferredResume] = useState<Session | null>(null)
  const [dragCat, setDragCat] = useState<number | null>(null)
  const dropCat = (targetId: number | null): void => {
    const from = dragCat
    setDragCat(null)
    if (from === null || targetId === null || from === targetId) return
    const ids = groups.map((g) => g.id).filter((id): id is number => id !== null)
    const fi = ids.indexOf(from)
    const ti = ids.indexOf(targetId)
    if (fi < 0 || ti < 0) return
    ids.splice(ti, 0, ids.splice(fi, 1)[0]) // move the dragged category to the target slot
    // Optimistic: reorder the rail NOW so the drop feels instant. Without this the
    // rail only moved on the next 1.5s snapshot push — the drop looked like it did
    // nothing for a beat, so people re-dragged and it jumped. The snapshot carries
    // the same persisted order, so there's no flicker when it lands.
    const rank = new Map(ids.map((id, i) => [id, i]))
    setSnap((s) => ({
      ...s,
      categories: [...s.categories].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)),
    }))
    window.cc.catReorder(ids)
  }
  // Companion pane (right of the terminal): the cross-fleet "needs you" board.
  // Default OPEN; open/hidden state and scope persist across restarts.
  const [companionOpen, setCompanionOpen] = useState(true)
  const [companionScope, setCompanionScope] = useState<'category' | 'all'>('all')
  const [stripOpen, setStripOpen] = useState(true)
  // Strip time window in minutes — adjustable granularity. Persisted.
  const [stripWinMin, setStripWinMin] = useState(5)
  // Companion panels the user has popped out into floating cards. Persisted, so
  // a popped layout survives a restart.
  const [popped, setPopped] = useState<Set<string>>(new Set())
  const setPop = (id: string, on: boolean): void => {
    setPopped((cur) => {
      const n = new Set(cur)
      if (on) n.add(id)
      else n.delete(id)
      window.cc.stateSet('poppedPanels', [...n].join(','))
      return n
    })
  }
  const showCompanion = (open: boolean) => {
    setCompanionOpen(open)
    window.cc.stateSet('companionOpen', String(open))
  }
  const setScope = (sc: 'category' | 'all') => {
    setCompanionScope(sc)
    window.cc.stateSet('companionScope', sc)
  }
  const showStrip = (open: boolean) => {
    setStripOpen(open)
    window.cc.stateSet('stripOpen', String(open))
  }
  // Right-click a rail cell to edit it, or the ＋ to create one — same editor.
  // id === null puts the editor in create mode (name / emoji / word / color).
  const [catEdit, setCatEdit] = useState<{
    id: number | null
    name: string
    color: string
    label: string | null
    emoji: string | null
    count: number // sessions currently in it — shown before a delete
    arbiterContext: number // 1 → substance from this category may go to the API
    // Per-class notification overrides; null = inherit the global switch.
    notify: { permission: number | null; question: number | null; done: number | null }
    x: number
    y: number
  } | null>(null)
  const [nameEdit, setNameEdit] = useState<{
    sessionId: string
    name: string
    x: number
    y: number
  } | null>(null)
  // Instant theme feedback for the current terminal before the persisted value
  // round-trips back through the next snapshot. Cleared when the selection changes.
  const [themeOverride, setThemeOverride] = useState<{ key: string; name: string } | null>(null)
  // A session whose transcript is gone: the pane shows a recovery card instead
  // of a doomed `claude --resume`.
  const [recover, setRecover] = useState<{ key: string; sessionId: string; cwd: string } | null>(null)
  // Restore-on-launch: the last-active session id to reopen once it appears live.
  const [pendingRestore, setPendingRestore] = useState<string | null>(null)
  const restoredRef = useRef(false)
  // The spawn-a-child composer (folder + optional handoff note).
  const [spawn, setSpawn] = useState<SpawnState | null>(null)
  // The cross-session send composer (inject a prompt into another session).
  const [send, setSend] = useState<Session | null>(null)
  // The New-session modal.
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  // The cross-session message log (awareness bus transparency).
  const [logOpen, setLogOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Auto-update UI. `updateAvail` drives the "an update is available" modal;
  // `postUpdate` drives the one-time "you've been updated" modal on first launch
  // after an install. Download progress and terminal states feed the former.
  const [updateAvail, setUpdateAvail] = useState<UpdatePayload | null>(null)
  const [postUpdate, setPostUpdate] = useState<UpdatePayload | null>(null)
  const [updateDl, setUpdateDl] = useState<{
    state: 'downloading' | 'staged' | 'error'
    percent?: number
    message?: string
  } | null>(null)
  // Optional prompt composer under the terminal (Enter = newline, ⌘↩ = send).
  const [composerOpen, setComposerOpen] = useState(false)
  const [composerText, setComposerText] = useState('')
  // Transient confirmation toast (copy-out, etc.).
  // (composer draft is cleared on session switch below, so A's draft can't be sent to B)
  const [flash, setFlash] = useState<string | null>(null)
  const showFlash = (msg: string) => {
    setFlash(msg)
    window.setTimeout(() => setFlash((f) => (f === msg ? null : f)), 1600)
  }
  // Clear the composer draft when the open session changes — a prompt typed for
  // one session must never be sent to another.
  useEffect(() => setComposerText(''), [selected?.sessionId])

  useEffect(() => {
    window.cc.appVersion().then((v) => setVersion(v.full))
    window.cc.getSessions().then((s) => setSnap(s as Snapshot))
    window.cc.stateGet('activeSessionId').then((id) => setPendingRestore(id))
    window.cc.stateGet('companionOpen').then((v) => v === 'false' && setCompanionOpen(false))
    window.cc.stateGet('companionScope').then((v) => v === 'category' && setCompanionScope('category'))
    window.cc.stateGet('stripOpen').then((v) => v === 'false' && setStripOpen(false))
    window.cc.stateGet('poppedPanels').then((v) => {
      if (v) setPopped(new Set(v.split(',').filter(Boolean)))
    })
    window.cc.stateGet('stripWinMin').then((v) => {
      const n = v ? Number(v) : NaN
      if (Number.isFinite(n) && n > 0) setStripWinMin(n)
    })
    window.cc.stateGet('lastCategory').then((v) => {
      restoredCatRef.current = v
      setCatRestoreLoaded(true)
    })
    const offSessions = window.cc.onSessions((s) => setSnap(s as Snapshot))
    const offShow = window.cc.onTermShow((p) => {
      setRecover(null)
      setSelected({ key: p.key, pid: p.pid, cwd: p.cwd, name: p.name, resume: false, hadLiveOriginal: false })
    })
    const offRecover = window.cc.onTermRecover((p) => setRecover(p))
    // A session that exited on its own is auto-removed in main; if it was the
    // open terminal, close the pane so we're not left staring at a dead session.
    const offRemoved = window.cc.onSessionsRemoved((p) => {
      const cur = selectedRef.current
      if (cur?.sessionId && p.ids.includes(cur.sessionId)) {
        setSelected(null)
        window.cc.stateSet('activeSessionId', '')
      }
    })
    return () => {
      offSessions()
      offShow()
      offRecover()
      offRemoved()
    }
  }, [])

  // Auto-update wiring: subscribe to the main-process update events, open the
  // Settings pane when the menu asks, and ask once on mount whether this launch
  // was the first after an install (→ the post-update modal).
  useEffect(() => {
    window.cc.updateJustUpdated().then((p) => {
      if (p) setPostUpdate(p)
    })
    const offAvail = window.cc.onUpdateAvailable((p) => {
      setUpdateDl(null)
      setUpdateAvail(p as UpdatePayload)
    })
    const offNone = window.cc.onUpdateNone(() => showFlash('You are at the latest release.'))
    const offDownloading = window.cc.onUpdateDownloading(() =>
      setUpdateDl({ state: 'downloading', percent: 0 }),
    )
    const offProgress = window.cc.onUpdateProgress((p) =>
      setUpdateDl({ state: 'downloading', percent: p.percent }),
    )
    const offStaged = window.cc.onUpdateStaged(() => setUpdateDl({ state: 'staged' }))
    const offError = window.cc.onUpdateError((p) =>
      setUpdateDl({ state: 'error', message: p.message }),
    )
    const offSettings = window.cc.onMenuSettings(() => setSettingsOpen(true))
    return () => {
      offAvail()
      offNone()
      offDownloading()
      offProgress()
      offStaged()
      offError()
      offSettings()
    }
  }, [])

  // On selection change: drop the theme override (so a newly-opened terminal
  // reflects its own persisted theme) and clear any stale recovery card.
  useEffect(() => {
    setThemeOverride(null)
    setRecover(null)
  }, [selected?.key])

  // Live sessions, deduped by session id: a resumed managed copy registers its
  // own ~/.claude/sessions/<pid>.json under the SAME session id, which would
  // otherwise show the one conversation twice. Prefer an alive row.
  const live = useMemo(() => {
    // Optionally hide live Claude sessions this app doesn't own — external
    // sessions running in other terminals add noise to the needs-you bar as they
    // work, even though you're not managing them here. Only alive-unmanaged rows
    // are dropped; the app's own sessions (managed) and dormant/resumable ones stay.
    const hide = snap.settings?.hideUnmanaged ?? false
    const bySession = new Map<string, Session>()
    for (const s of snap.sessions) {
      if (s.isSpare) continue
      if (hide && s.alive && !s.managed) continue
      const existing = bySession.get(s.sessionId)
      if (!existing || (!existing.alive && s.alive)) bySession.set(s.sessionId, s)
    }
    return [...bySession.values()]
  }, [snap])
  // Derived 'blocked': a parent whose blocking child is still unfinished (child
  // working or waiting). The engine doesn't report this — we compute it here.
  const blockedSet = useMemo(() => {
    const stateById = new Map(live.map((s) => [s.sessionId, s.state]))
    const blocked = new Set<string>()
    for (const e of snap.edges) {
      if (e.type !== 'blocking') continue
      const cs = stateById.get(e.child_id)
      if (cs === 'working' || cs === 'waiting') blocked.add(e.parent_id)
    }
    return blocked
  }, [live, snap.edges])
  // Display state, most-urgent wins: a parked permission dialog (open a door) beats
  // blocked-on-child beats the coarse transcript state. A question gate (needs your
  // brain) reads as "your turn" (blue), same tier as a turn that ended asking you.
  const dstate = (s: Session): DisplayState =>
    s.dormant
      ? s.state
      : s.attention === 'permission'
        ? 'permission'
        : s.attention === 'question'
          ? 'waiting'
          : blockedSet.has(s.sessionId)
            ? 'blocked'
            : s.whyKind === 'done'
              ? 'done'
              : s.state

  const nameOf = (s: Session): string =>
    s.name ?? (s.dormant ? s.sessionId.slice(0, 8) : `pid ${s.pid}`)

  // The unfinished blocking child a blocked parent is waiting on, for the
  // "blocked → child" why-line. Same source as blockedSet (edges + child state).
  const blockingChildOf = useMemo(() => {
    const stateById = new Map(live.map((s) => [s.sessionId, s.state]))
    const nameById = new Map(live.map((s) => [s.sessionId, nameOf(s)]))
    const m = new Map<string, string>()
    for (const e of snap.edges) {
      if (e.type !== 'blocking') continue
      const cs = stateById.get(e.child_id)
      if (cs === 'working' || cs === 'waiting') m.set(e.parent_id, nameById.get(e.child_id) ?? e.child_id.slice(0, 8))
    }
    return m
  }, [live, snap.edges]) // eslint-disable-line react-hooks/exhaustive-deps

  // The needs-you substance to show under a row, or null (high-signal: only a real
  // gate, a genuine question, or a blocked parent ever gets a why-line).
  const whyOf = (
    s: Session,
  ): {
    kind: 'permission' | 'question' | 'blocked' | 'done'
    text: string
    coarse?: boolean
    gloss?: string
  } | null => {
    if (s.dormant) return null
    const d = dstate(s)
    if (d === 'permission' && s.why) return { kind: 'permission', text: s.why, coarse: s.whyCoarse, gloss: s.whyGloss }
    if (d === 'blocked') {
      const child = blockingChildOf.get(s.sessionId)
      return child ? { kind: 'blocked', text: child } : null
    }
    // A question gate (interactive) or a turn that ended asking you — both read as
    // 'waiting' (blue) and carry whyKind==='question'.
    if (d === 'waiting' && s.whyKind === 'question' && s.why)
      return { kind: 'question', text: s.why, coarse: s.whyCoarse, gloss: s.whyGloss }
    // A turn that ended on a statement (job complete). Base text is a plain 'done';
    // the Arbiter gloss, when present, says what it finished.
    if (d === 'done') return { kind: 'done', text: s.why || 'done', gloss: s.whyGloss }
    return null
  }

  const counts = useMemo(() => {
    const c: Record<DisplayState, number> = {
      permission: 0,
      working: 0,
      waiting: 0,
      blocked: 0,
      done: 0,
      idle: 0,
      unknown: 0,
    }
    for (const s of live) if (!s.dormant) c[dstate(s)]++
    return c
  }, [live, blockedSet]) // eslint-disable-line react-hooks/exhaustive-deps
  const liveCount = useMemo(() => live.filter((s) => !s.dormant).length, [live])
  const dormantCount = useMemo(() => live.filter((s) => s.dormant).length, [live])
  // The "NEEDS YOU" ledger: sessions that genuinely want you — a permission gate
  // (open a door), a question (interactive or a turn that ended asking you, both
  // whyKind==='question'), a parent blocked on an unfinished child, OR a turn that
  // ended on a statement (whyKind==='done' — job complete, your move). The 'done'
  // entry only reaches here for a session you WEREN'T looking at (main gates it by
  // the last-viewed watermark), so it's the unattended-completion signal, not the
  // replied-and-idle noise the ledger was built to drop.
  // Dormant sessions are included when the ledger still holds an unresolved gate
  // for them. After a restart everything the app owns starts dormant, and the
  // thing you were in the middle of is exactly what you must not have to go
  // hunting for — so it stays on the list, dimmed and marked resumable, and
  // sorts below anything actually running.
  const needsYou = useMemo(
    () =>
      live
        .filter(
          (s) =>
            s.attention === 'permission' ||
            s.whyKind === 'question' ||
            s.whyKind === 'done' ||
            blockedSet.has(s.sessionId),
        )
        .sort((a, b) => {
          if (!!a.dormant !== !!b.dormant) return a.dormant ? 1 : -1
          return STATE[dstate(a)].order - STATE[dstate(b)].order
        }),
    [live, blockedSet], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const catById = useMemo(() => new Map(snap.categories.map((c) => [c.id, c])), [snap.categories])
  // The companion why-board: the same needs-you set, scoped to the current category
  // or the whole fleet ("All"). A cross-category roll-up, each card tagged with its
  // category — never merged.
  const boardItems = useMemo(
    () => (companionScope === 'all' ? needsYou : needsYou.filter((s) => s.categoryId === selectedCat)),
    [needsYou, companionScope, selectedCat],
  )

  // The Strip: per-session duration swimlanes. A renderer-side ring buffer of each
  // live session's coarse state, accumulated from the 1.5s snapshots (nothing
  // persists this) — change-points only, kept to a rolling window. Lost on restart.
  // The buffer always retains the LARGEST selectable window, so raising the
  // granularity later reveals history already captured rather than an empty
  // left edge. The current selection only crops what is rendered.
  const STRIP_MAX_WINDOW = 25 * 60 * 1000
  const STRIP_WINDOW = stripWinMin * 60 * 1000
  const stripHist = useRef<Map<string, { t: number; s: DisplayState }[]>>(new Map())
  useEffect(() => {
    const now = snap.scannedAt || Date.now()
    const h = stripHist.current
    const liveSet = new Set<string>()
    for (const s of live) {
      if (s.dormant) continue
      liveSet.add(s.sessionId)
      const d = dstate(s)
      let arr = h.get(s.sessionId)
      if (!arr) {
        arr = []
        h.set(s.sessionId, arr)
      }
      const last = arr[arr.length - 1]
      if (!last || last.s !== d) arr.push({ t: now, s: d }) // record only on a state change
      while (arr.length > 1 && arr[1].t < now - STRIP_MAX_WINDOW) arr.shift() // drop points past the max window
    }
    for (const k of [...h.keys()]) if (!liveSet.has(k)) h.delete(k) // forget gone sessions
  }, [snap]) // eslint-disable-line react-hooks/exhaustive-deps
  // The lanes shown in the Strip: live sessions in the current scope, most-urgent first.
  const stripLanes = useMemo(
    () =>
      live
        .filter((s) => !s.dormant && (companionScope === 'all' || s.categoryId === selectedCat))
        .sort((a, b) => STATE[dstate(a)].order - STATE[dstate(b)].order || (a.name ?? '').localeCompare(b.name ?? ''))
        .slice(0, 24),
    [live, companionScope, selectedCat], // eslint-disable-line react-hooks/exhaustive-deps
  )
  // The overview ("50k-foot") grid: every ACTIVE session across the whole fleet,
  // most-critical first. Active = live and either doing something or needing you —
  // working / waiting / permission / blocked, plus done-but-unseen (main only
  // reports dstate 'done' for a session that finished after your watermark and
  // that you aren't viewing, so seen/idle/dormant never appear here). Fleet-wide,
  // so it ignores the selected category. Capped, with the remainder shown as a
  // count so a busy fleet can't flood the grid.
  const OVERVIEW_CAP = 24
  const OVERVIEW_STATES = new Set<DisplayState>(['permission', 'working', 'waiting', 'blocked', 'done'])
  // "Your turn" splits in two: a session that asked a DIRECT question (whyKind
  // 'question') is genuinely waiting on your answer, vs a soft turn-end that's just
  // your move. Both stay blue (governance), but the question sorts AHEAD of the
  // soft ones — a half-step below plain waiting — so the ones needing an answer
  // land first. (A fuller re-tiering — question just below permission everywhere —
  // is stubbed in the roadmap for later.)
  const hasQuestion = (s: Session): boolean => dstate(s) === 'waiting' && s.whyKind === 'question'
  const overviewOrder = (s: Session): number =>
    hasQuestion(s) ? STATE.waiting.order - 0.5 : STATE[dstate(s)].order
  const overviewAll = useMemo(
    () =>
      live
        .filter(
          (s) =>
            !s.dormant &&
            (OVERVIEW_STATES.has(dstate(s)) || (overviewIdle && dstate(s) === 'idle')),
        )
        .sort(
          (a, b) => overviewOrder(a) - overviewOrder(b) || (a.name ?? '').localeCompare(b.name ?? ''),
        ),
    [live, overviewIdle], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const overviewTiles = overviewAll.slice(0, OVERVIEW_CAP)
  const overviewOverflow = overviewAll.length - overviewTiles.length

  // Right-aligned segments (now at the right edge); widths are fractions of the
  // window, so a short history leaves the left end empty rather than stretching.
  const stripSegs = (sid: string, now: number): { w: number; s: DisplayState }[] => {
    const pts = stripHist.current.get(sid) ?? []
    const windowStart = now - STRIP_WINDOW
    const out: { w: number; s: DisplayState }[] = []
    for (let i = 0; i < pts.length; i++) {
      const start = Math.max(pts[i].t, windowStart)
      const end = i + 1 < pts.length ? pts[i + 1].t : now
      if (end <= windowStart) continue
      out.push({ w: (end - start) / STRIP_WINDOW, s: pts[i].s })
    }
    return out
  }
  const short = (cwd: string) => (snap.home ? cwd.replace(snap.home, '~') : cwd)

  const edgeByChild = useMemo(() => {
    const m = new Map<string, Edge>()
    for (const e of snap.edges) m.set(e.child_id, e)
    return m
  }, [snap.edges])

  const groups = useMemo(() => {
    const byCat = new Map<number | null, Session[]>()
    for (const s of live) {
      const k = s.categoryId ?? null
      const arr = byCat.get(k) ?? []
      arr.push(s)
      byCat.set(k, arr)
    }
    // Sidebar order, in three tiers (so a live-idle session never sinks among the
    // dormant "resume" rows):
    //   0. active & attention-or-busy — needs a response (permission/waiting/blocked)
    //      or is working. Ordered by display-state urgency.
    //   1. active & idle — ordered by when YOU last opened it (most recent first),
    //      then most-recently-active.
    //   2. dormant/resume — most-recently-active first.
    const tierOf = (s: Session): number => {
      if (s.dormant) return 2
      const d = dstate(s)
      return d === 'permission' || d === 'blocked' || d === 'waiting' || d === 'working' ? 0 : 1
    }
    const cmp = (a: Session, b: Session): number => {
      const ta = tierOf(a)
      const tb = tierOf(b)
      if (ta !== tb) return ta - tb
      if (ta === 0) {
        return STATE[dstate(a)].order - STATE[dstate(b)].order || (a.name ?? '').localeCompare(b.name ?? '')
      }
      if (ta === 1) {
        const oa = openOrder.current.get(a.sessionId) ?? -1
        const ob = openOrder.current.get(b.sessionId) ?? -1
        if (oa !== ob) return ob - oa
      }
      return (b.transcriptMtimeMs ?? 0) - (a.transcriptMtimeMs ?? 0) || (a.name ?? '').localeCompare(b.name ?? '')
    }
    // Flatten a category's sessions into a depth-tagged tree via the edges,
    // treating a session whose parent is outside this category as a root.
    const buildTree = (sessions: Session[]): TreeRow[] => {
      const byId = new Map(sessions.map((s) => [s.sessionId, s]))
      const childrenOf = new Map<string, { s: Session; type: string }[]>()
      const roots: Session[] = []
      for (const s of sessions) {
        const e = edgeByChild.get(s.sessionId)
        if (e && byId.has(e.parent_id)) {
          const arr = childrenOf.get(e.parent_id) ?? []
          arr.push({ s, type: e.type })
          childrenOf.set(e.parent_id, arr)
        } else {
          roots.push(s)
        }
      }
      const out: TreeRow[] = []
      const walk = (s: Session, depth: number, edgeType: string | null) => {
        out.push({ s, depth, edgeType })
        const kids = (childrenOf.get(s.sessionId) ?? []).sort((a, b) => cmp(a.s, b.s))
        for (const k of kids) walk(k.s, depth + 1, k.type)
      }
      for (const r of roots.sort(cmp)) walk(r, 0, null)
      return out
    }
    const cats = snap.categories.map((c) => ({
      id: c.id as number | null,
      name: c.name,
      color: c.color,
      label: c.label,
      emoji: c.emoji,
      arbiter_context: c.arbiter_context ?? 0,
      notify_permission: c.notify_permission ?? null,
      notify_question: c.notify_question ?? null,
      notify_done: c.notify_done ?? null,
      rows: buildTree(byCat.get(c.id) ?? []),
    }))
    const uncat = {
      id: null as number | null,
      name: 'Uncategorized',
      color: '#6a6355',
      label: null as string | null,
      emoji: null as string | null,
      arbiter_context: 0, // Uncategorized is never cleared to send substance
      // Not a real category row, so it has no overrides — it always follows global.
      notify_permission: null as number | null,
      notify_question: null as number | null,
      notify_done: null as number | null,
      rows: buildTree(byCat.get(null) ?? []),
    }
    // Uncat is ALWAYS shown, even when empty. It used to be hidden on zero rows,
    // which made it flicker in and out as uncategorized sessions went live/idle
    // (dormant edge-less uncategorized sessions aren't in the snapshot, so the
    // row count bounced between 0 and some). A rail cell that appears and
    // vanishes is disorienting, and a tangential child — which is decoupled and
    // lands in Uncat rather than its parent's category — was unfindable whenever
    // Uncat happened to be empty at that moment. It's also the drop target for
    // un-categorizing a session, so it needs to always be there.
    return [...cats, uncat]
  }, [live, snap.categories, edgeByChild, blockedSet]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectedGroup =
    groups.find((g) => g.id === selectedCat) ??
    groups[0] ?? {
      id: null as number | null,
      name: 'Uncategorized',
      color: '#6a6355',
      label: null as string | null,
      emoji: null as string | null,
      rows: [] as TreeRow[],
    }

  // First time sessions load, land on the LAST-USED category (if it still exists),
  // else the fullest — never an empty rail.
  useEffect(() => {
    if (initCatRef.current || live.length === 0 || !catRestoreLoaded) return
    initCatRef.current = true
    const raw = restoredCatRef.current
    const target: number | null | undefined =
      raw === 'null' ? null : raw != null && raw !== '' ? Number(raw) : undefined
    if (target !== undefined && groups.some((g) => g.id === target)) {
      setSelectedCat(target)
      return
    }
    const fullest = [...groups].sort((a, b) => b.rows.length - a.rows.length)[0]
    if (fullest) setSelectedCat(fullest.id)
  }, [groups, live, catRestoreLoaded])

  // Remember the selected category so the next launch reopens it.
  useEffect(() => {
    if (!initCatRef.current) return
    window.cc.stateSet('lastCategory', selectedCat === null ? 'null' : String(selectedCat))
  }, [selectedCat])

  // Does resuming this session need to ask for launch parameters first? Only a
  // real spawn can: if the app already owns the PTY it just re-attaches, and no
  // flags are involved. Sticky sessions have their answer stored. Everything else
  // — adopted, pre-feature, or created without ticking the box — gets asked.
  const needsResumeGate = (s: Session): boolean => !s.managed && !s.resumeSticky
  const openSession = (s: Session): void => {
    if (needsResumeGate(s)) {
      setResumeGate({ session: s, edit: false }) // reallyOpen runs from the modal's confirm
      return
    }
    reallyOpen(s)
  }
  // The actual open. Every side effect lives here rather than in openSession, so a
  // cancelled modal leaves nothing behind — especially activeSessionId, which would
  // otherwise arm restore-on-launch for a session the user declined to resume.
  const reallyOpen = (s: Session, oneShot?: ResumeFlags): void => {
    // Switch the rail to this session's category FIRST, so the row you just opened
    // is actually visible and highlighted instead of the terminal changing under a
    // rail that stayed put. Every cross-category surface — the needs-you why-cards,
    // the Strip lanes, the activity owner/rollup chips — routes through here, so
    // this is the one place it has to be right. Guarded against a category that
    // vanished in this snapshot window, which would otherwise leave selectedCat
    // pointing at nothing and no rail cell active.
    if (s.categoryId === null || groups.some((g) => g.id === s.categoryId)) {
      setSelectedCat(s.categoryId)
    }
    lastByCat.current.set(s.categoryId, s.sessionId) // remember per category for rail jump-back
    openOrder.current.set(s.sessionId, ++openSeq.current) // remember open recency for the sidebar sort
    window.cc.stateSet('activeSessionId', s.sessionId) // remember for restore-on-launch
    setSelected({
      key: s.sessionId,
      pid: s.pid,
      sessionId: s.sessionId,
      cwd: s.cwd,
      name: s.name ?? `pid ${s.pid}`,
      resume: true,
      hadLiveOriginal: !!(s.alive && !s.managed), // a real second copy only if live elsewhere
      resumeFlags: oneShot ?? s.resumeFlags,
    })
  }
  // Scroll the opened row into view. Switching category isn't enough on its own —
  // in a long tree the row lands below the fold and the sidebar looks unchanged.
  // 'nearest' is deliberate: an already-visible row doesn't jog the list.
  const selRowRef = useRef<HTMLLIElement | null>(null)
  useLayoutEffect(() => {
    selRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected?.sessionId, selectedCat])
  const closeTerminal = () => {
    if (selected) window.cc.termClose(selected.key)
    setSelected(null)
  }

  // Clicking an OS notification opens that session. Held as a pending request
  // rather than acted on inline, because the session may not be in the current
  // snapshot yet — this retries on each push until it resolves, and switches to
  // the session's category first so it's actually visible in the rail.
  const [pendingFocus, setPendingFocus] = useState<string | null>(null)
  useEffect(() => window.cc.onFocusSession((sid) => setPendingFocus(sid)), [])
  useEffect(() => {
    if (!pendingFocus) return
    const s = snap.sessions.find((x) => x.sessionId === pendingFocus)
    if (!s) return
    // reallyOpen, not openSession: a notification click means "take me to this
    // live session now" — it must never stop at the resume-params modal. reallyOpen
    // still switches the rail to its category and selects the row.
    reallyOpen(s)
    setPendingFocus(null)
  }, [pendingFocus, snap.sessions]) // eslint-disable-line react-hooks/exhaustive-deps

  // ⌘⇧E toggles the fleet overview; Esc closes it. (⌘E alone is a common global
  // hotkey — Rize, etc. — so Shift keeps it clear.) A window-level listener works
  // even while the terminal has focus: xterm returns false for any Cmd combo, so
  // the combo is never consumed as PTY input and bubbles here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() === 'e' && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setOverviewOpen((v) => !v)
      } else if (e.key === 'Escape' && overviewOpen) {
        setOverviewOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overviewOpen])

  // Reconcile an in-app launched session (key new:<pid>) to its adopted session
  // id once the scan surfaces it: the row highlights, the theme picker persists,
  // and re-opening re-attaches (main rehomes the terminal) instead of forking a
  // duplicate resume.
  useEffect(() => {
    if (!selected || !selected.key.startsWith('new:')) return
    const s = live.find((x) => x.pid === selected.pid && x.alive)
    if (s) {
      window.cc.stateSet('activeSessionId', s.sessionId)
      setSelected({
        key: s.sessionId,
        pid: s.pid,
        sessionId: s.sessionId,
        cwd: s.cwd,
        name: s.name ?? selected.name,
        resume: false,
        hadLiveOriginal: false,
      })
    }
  }, [live, selected]) // eslint-disable-line react-hooks/exhaustive-deps

  // Restore-on-launch: once the last-active session appears live, reopen it —
  // but only if the user hasn't already selected something this run.
  useEffect(() => {
    if (restoredRef.current) return
    if (selected) {
      restoredRef.current = true
      return
    }
    if (!pendingRestore) return
    const s = live.find((x) => x.sessionId === pendingRestore && x.alive)
    if (s) {
      restoredRef.current = true
      // Never pop the params modal on app start. If the open is silent — the app
      // already owns the PTY, or the flags are remembered — restore as before.
      // Otherwise select it and offer a Resume button, so the ask happens at a
      // moment the user chose. This is what ticking "always use these flags" buys:
      // the session comes back by itself.
      if (needsResumeGate(s)) {
        if (s.categoryId === null || groups.some((g) => g.id === s.categoryId))
          setSelectedCat(s.categoryId)
        setDeferredResume(s)
      } else {
        reallyOpen(s)
      }
    }
  }, [live, selected, pendingRestore]) // eslint-disable-line react-hooks/exhaustive-deps
  // The theme shown for the open terminal: the just-picked override (instant),
  // else the session's persisted theme, else Default.
  const selLive = selected ? live.find((s) => s.sessionId === selected.key) : undefined
  const selThemeName =
    themeOverride && selected && themeOverride.key === selected.key
      ? themeOverride.name
      : selLive?.theme ?? DEFAULT_THEME_NAME
  const pickTheme = (name: string) => {
    if (!selected) return
    setThemeOverride({ key: selected.key, name })
    // Persist by session id when known; store null for Default to keep it clean.
    if (selected.sessionId) window.cc.themeSet(selected.sessionId, name === DEFAULT_THEME_NAME ? null : name)
  }
  const assign = (s: Session, categoryId: number | null) => {
    window.cc.catAssign(s.sessionId, categoryId)
    setMenu(null)
  }
  const setEdge = (child: Session, parent: Session, type: MenuMode) => {
    if (type === 'blocking' || type === 'tangential') window.cc.edgeSet(child.sessionId, parent.sessionId, type)
    setMenu(null)
  }
  // Beacon "needs you" click. openSession switches the rail itself now, so this is
  // a plain alias kept for the call site's readability.
  const jumpTo = openSession

  // The two poppable companion panels, built once. Each renders either inline in
  // the companion (not popped) or inside a floating card at the app root (popped)
  // — never both — so a single element instance moves between the two homes. The
  // float lives at the root, NOT inside the companion, so closing the sidebar
  // doesn't take a popped panel down with it.
  const stripPanel = (
    <div className="comp-strip-wrap">
      <div className="comp-section-head strip-head">
        <button className="sh-toggle" onClick={() => showStrip(!stripOpen)}>
          <span className="chev">{stripOpen ? '▾' : '▸'}</span> timeline
        </button>
        {stripOpen && (
          <span className="strip-gran">
            {[5, 10, 25].map((m) => (
              <button
                key={m}
                className={`sg-opt${stripWinMin === m ? ' on' : ''}`}
                onClick={() => {
                  setStripWinMin(m)
                  window.cc.stateSet('stripWinMin', String(m))
                }}
                title={`show the last ${m} minutes`}
              >
                {m}m
              </button>
            ))}
          </span>
        )}
      </div>
      {stripOpen && (
        <div className="comp-strip">
          {stripLanes.length === 0 ? (
            <div className="strip-empty">no live sessions</div>
          ) : (
            stripLanes.map((s) => {
              const segs = stripSegs(s.sessionId, snap.scannedAt || Date.now())
              return (
                <button
                  key={s.sessionId}
                  className="strip-lane"
                  onClick={() => openSession(s)}
                  title={nameOf(s)}
                >
                  <span className="strip-name">{nameOf(s)}</span>
                  <span className="strip-track">
                    {segs.map((seg, i) => (
                      <span
                        key={i}
                        className={`strip-seg seg-${seg.s}`}
                        style={{ width: `${(seg.w * 100).toFixed(2)}%` }}
                      />
                    ))}
                  </span>
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
  const fleetPanel = (
    <FleetActivity
      sessions={live.filter((s) => companionScope === 'all' || s.categoryId === selectedCat)}
      now={snap.scannedAt || Date.now()}
      onOpen={openSession}
      activeSessionId={selected?.sessionId ?? null}
    />
  )
  // The artifact drawer belongs to the OPEN session; it lives in the terminal
  // area (folds down over the terminal), not the companion.
  const activeArtSession = selected ? live.find((s) => s.sessionId === selected.sessionId) ?? null : null

  return (
    <div className="app">
      {/* Popped panels float at the app ROOT so they persist when the companion
          (their normal home) is hidden. */}
      {popped.has('strip') && (
        <FloatCard id="strip" title="Timeline" onReturn={() => setPop('strip', false)}>
          {stripPanel}
        </FloatCard>
      )}
      {popped.has('subagents') && (
        <FloatCard id="subagents" title="Activity" onReturn={() => setPop('subagents', false)}>
          {fleetPanel}
        </FloatCard>
      )}
      <header className="beacon">
        <div className="beacon-brand">
          <span className="pulse" />
          <span className="wordmark">command-center</span>
          {version && <span className="ver" title="version · build">{version}</span>}
        </div>
        <div className="tally">
          {counts.permission > 0 && (
            <TallyItem
              n={counts.permission}
              label="needs approval"
              color={STATE.permission.color}
            />
          )}
          <TallyItem n={counts.working} label="working" color={STATE.working.color} />
          <TallyItem n={counts.waiting} label="your turn" color={STATE.waiting.color} />
          <TallyItem n={counts.blocked} label="blocked" color={STATE.blocked.color} />
          <TallyItem n={counts.idle} label="idle" color={STATE.idle.color} />
          <TallyItem n={liveCount} label="total" color="var(--cc-dim)" />
        </div>
        <div className="beacon-grow">
          {/* The companion pane owns the needs-you list when open, so the beacon
              drops it to avoid showing the same thing twice. Tallies stay. */}
          {companionOpen ? null : needsYou.length === 0 ? (
            <div className="allclear">
              <span className="pulse" /> all clear — nothing needs you
            </div>
          ) : (
            <div className="needsyou">
              <span className="needs-label">needs you</span>
              {needsYou.slice(0, 3).map((s, i) => {
                const cat = snap.categories.find((c) => c.id === s.categoryId)
                return (
                  <button
                    key={s.sessionId}
                    className={`needs-item ns-${dstate(s)}${s.dormant ? ' held' : ''}`}
                    onClick={() => jumpTo(s)}
                    title={
                      s.dormant
                        ? 'Was waiting on you before the restart — click to resume'
                        : s.stateReason
                    }
                  >
                    <span className="ns-idx">{String(i + 1).padStart(2, '0')}</span>
                    <span className={`cc-dot cc-dot--${dstate(s)}`} />
                    <span className="ns-name">{s.name ?? `pid ${s.pid}`}</span>
                    {/* Recalled from the ledger rather than observed live: it earns
                        its place on the list, but must not look like a live gate. */}
                    {s.dormant && <span className="ns-held">resume</span>}
                    <span
                      className="cdot"
                      style={{ background: cat?.color ?? 'var(--cc-cat-none)' }}
                    />
                    <span className="ns-age">{fmtAge(s.transcriptMtimeMs, snap.scannedAt)}</span>
                  </button>
                )
              })}
              {needsYou.length > 3 && (
                <span className="needs-more">+{needsYou.length - 3} more</span>
              )}
            </div>
          )}
        </div>
        {((snap.messages && snap.messages.length > 0) || snap.awarenessPaused) && (
          <button
            className={`msgbtn${snap.awarenessPaused ? ' paused' : ''}`}
            onClick={() => setLogOpen(true)}
            title={
              snap.awarenessPaused
                ? 'Autonomous messaging PAUSED — open message log'
                : 'Cross-session message log'
            }
          >
            {snap.awarenessPaused ? '⏸' : '✉'} {snap.messages?.length ?? 0}
          </button>
        )}
        <button
          className={`showallbtn${overviewOpen ? ' on' : ''}`}
          onClick={() => setOverviewOpen((v) => !v)}
          title="Fleet overview — every active session at once (⌘⇧E)"
        >
          <span className="showall-ico">▦</span> Show all
        </button>
        <UsageMeter usage={snap.usage} now={snap.scannedAt || Date.now()} />
        <button className="gearbtn" onClick={() => setSettingsOpen(true)} title="Settings">
          ⚙
        </button>
        {/* Command-palette entry point — hidden until there's a real palette behind it. */}
      </header>

      <div className="body">
        <nav className="rail">
          {groups.map((g) => {
            // Uncategorized reads as a word like every other rail tag — a bare
            // dot gave no clue what the section was.
            const tag = g.id === null ? 'Uncat' : g.label || autoTag(g.name)
            // The most-urgent "needs you" state in this category, so the rail dot
            // shows not just THAT a category needs you but WHY. Order MATCHES the
            // beacon's STATE.order so the two surfaces never disagree: needs-approval
            // (amber) > your-turn/question (blue) > blocked-on-child (pink). null =
            // quiet. Only a genuine question counts for blue — not a transient
            // turn-end that will settle to idle — matching the NEEDS YOU ledger.
            const rows = g.rows.filter((r) => !r.s.dormant)
            const railNeed: DisplayState | null = rows.some((r) => r.s.attention === 'permission')
              ? 'permission'
              : rows.some((r) => r.s.whyKind === 'question')
                ? 'waiting'
                : rows.some((r) => blockedSet.has(r.s.sessionId))
                  ? 'blocked'
                  : null
            return (
              <button
                key={g.id ?? 'uncat'}
                className={`rail-cell${selectedCat === g.id ? ' active' : ''}${railNeed ? ` needs need-${railNeed}` : ''}${dragCat !== null && dragCat !== g.id && g.id !== null ? ' droptarget' : ''}`}
                style={{ '--cat-color': g.color } as CSSProperties}
                draggable={g.id !== null}
                onDragStart={() => g.id !== null && setDragCat(g.id)}
                onDragOver={(e) => {
                  if (dragCat !== null && g.id !== null) e.preventDefault()
                }}
                onDrop={() => dropCat(g.id)}
                onDragEnd={() => setDragCat(null)}
                onClick={() => {
                  setSelectedCat(g.id)
                  // Jump back to the last session opened in this category. Only if
                  // it still exists — never surprise-resume a session you didn't pick.
                  // It must ALSO still belong to this category: lastByCat is keyed by
                  // the category the session had when it was opened and isn't re-keyed
                  // on reassignment, so without this check openSession's category
                  // switch would land you somewhere other than the cell you clicked.
                  const lastId = lastByCat.current.get(g.id)
                  const target = lastId ? live.find((s) => s.sessionId === lastId) : undefined
                  if (target && target.categoryId === g.id) openSession(target)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  if (g.id !== null)
                    setCatEdit({
                      id: g.id,
                      name: g.name,
                      color: g.color,
                      label: g.label,
                      emoji: g.emoji,
                      count: g.rows.length,
                      arbiterContext: g.arbiter_context ?? 0,
                      notify: {
                        permission: g.notify_permission,
                        question: g.notify_question,
                        done: g.notify_done,
                      },
                      x: e.clientX,
                      y: e.clientY,
                    })
                }}
                title={`${g.name} · ${g.rows.length}`}
              >
                {g.emoji && <span className="rail-emoji">{g.emoji}</span>}
                <span className="rail-tag">{tag}</span>
              </button>
            )
          })}
          <button
            className="rail-add"
            title="New category"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setCatEdit({
                id: null,
                name: '',
                color: '',
                label: null,
                emoji: null,
                notify: { permission: null, question: null, done: null },
                count: 0,
                arbiterContext: 0,
                x: r.right + 6,
                y: Math.max(48, Math.min(r.top, window.innerHeight - 380)),
              })
            }}
          >
            ＋
          </button>
        </nav>

        <aside className="treepane">
          <button className="newsession" onClick={() => setNewSessionOpen(true)}>
            ＋ New session…
          </button>
          <div className="treehead">
            <span className="cdot" style={{ background: selectedGroup.color }} />
            <span className="cname">{selectedGroup.name}</span>
            <span className="gcount">{selectedGroup.rows.length}</span>
          </div>
          <ul className="rows">
            {selectedGroup.rows.length === 0 && (
              <li className="emptycat">right-click a session to move it here</li>
            )}
            {selectedGroup.rows.map(({ s, depth, edgeType }) => {
              const why = whyOf(s)
              // Background work running right now — so a session churning on a dev
              // server / build / agent / workflow doesn't read as idle. Only
              // 'running' counts (a stalled/failed task isn't actively working).
              const bgRunning =
                (s.subtasks?.filter((t) => t.status === 'running').length ?? 0) +
                (s.workflows?.filter((w) => w.status === 'running').length ?? 0)
              return (
              <li
                key={s.sessionId}
                // Match on sessionId, not key: an in-app launched session carries
                // key `new:<pid>` until the scan adopts it, and FleetActivity
                // already compares sessionId — one concept, one field.
                ref={selected?.sessionId === s.sessionId ? selRowRef : null}
                className={`row state-${dstate(s)}${s.dormant ? ' dormant' : ''}${selected?.sessionId === s.sessionId ? ' sel' : ''}${why ? ' has-why' : ''}${s.unhandled ? ' unhandled' : ''}`}
                style={{ paddingLeft: 10 + depth * 16 }}
                title={s.stateReason}
                onClick={() => openSession(s)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ x: e.clientX, y: e.clientY, session: s, mode: 'root' })
                }}
              >
                {s.unhandled && <span className="pip" title="you haven't looked at this yet" />}
                {edgeType && (
                  <span className={`edge edge-${edgeType}`}>
                    {edgeType === 'blocking' ? '└─' : '└╌'}
                  </span>
                )}
                <span className={`cc-dot cc-dot--${dstate(s)}`} />
                {s.theme && s.theme !== DEFAULT_THEME_NAME && (
                  <span
                    className="tswatch"
                    style={{ background: themeByName(s.theme).accent }}
                    title={`theme: ${s.theme}`}
                  />
                )}
                <span className="rowmain">
                  <span className="name">
                    {s.name ?? <em>{s.dormant ? s.sessionId.slice(0, 8) : `pid ${s.pid}`}</em>}
                  </span>
                  <span className="rowcwd">{short(s.cwd)}</span>
                  {why && (
                    <span className={`why why-${why.kind}`} title={why.text}>
                      {why.kind === 'permission' &&
                        (why.coarse ? (
                          <>
                            {why.text} <span className="whytag">coarse</span>
                          </>
                        ) : (
                          <>
                            <span className="whyverb">wants</span> <code>{why.text}</code>
                          </>
                        ))}
                      {why.kind === 'question' &&
                        (why.coarse ? (
                          <>
                            {why.text} <span className="whytag">coarse</span>
                          </>
                        ) : (
                          <>
                            <span className="whyverb">asked</span> {why.text}
                          </>
                        ))}
                      {why.kind === 'blocked' && (
                        <>
                          <span className="whyverb">blocked →</span> {why.text}
                        </>
                      )}
                      {why.kind === 'done' && <span className="whyverb">✓ done — your move</span>}
                      {why.gloss && <span className="whygloss">{why.gloss}</span>}
                    </span>
                  )}
                </span>
                {s.dormant ? (
                  <span className="meta resume">resume</span>
                ) : (
                  <span className="meta">
                    {bgRunning > 0 && (
                      <span
                        className="rowtasks"
                        title={`${bgRunning} background task${bgRunning > 1 ? 's' : ''} running — see the activity panel`}
                      >
                        ⚙ {bgRunning}
                      </span>
                    )}
                    {typeof s.contextPct === 'number' && (
                      <span
                        className={`ctxchip ${ctxTone(s.contextPct)}`}
                        title={`context window ${s.contextPct}% used${
                          s.contextPct >= 85 ? ' — near auto-compact' : ''
                        }`}
                      >
                        {s.contextPct >= 85 ? '⚠ ' : ''}
                        {s.contextPct}%
                      </span>
                    )}
                    {fmtAge(s.transcriptMtimeMs, snap.scannedAt)}
                  </span>
                )}
                <CtxBar pct={s.contextPct} />
              </li>
              )
            })}
          </ul>
        </aside>

        <main className="terminalarea">
          <div className="termstack">
          {selected ? (
            <>
              <div className="termbar">
                <span className="tname">{selected.name}</span>
                <span className="tcwd" title={selected.cwd}>
                  {short(selected.cwd)}
                </span>
                {selected.resume &&
                  (selected.hadLiveOriginal ? (
                    <span className="tnote">resumed copy — original still running elsewhere</span>
                  ) : (
                    <span className="tnote tnote-dim">resumed session</span>
                  ))}
                {(() => {
                  const pct = snap.sessions.find((x) => x.sessionId === selected.sessionId)?.contextPct
                  return typeof pct === 'number' ? (
                    <span
                      className={`tctx ${ctxTone(pct)}`}
                      title={`context window ${pct}% used${pct >= 85 ? ' — near auto-compact' : ''}`}
                    >
                      ctx {pct}%{pct >= 85 ? ' ⚠' : ''}
                    </span>
                  ) : null
                })()}
                <span className="grow" />
                <ThemePicker current={selThemeName} onPick={pickTheme} />
                <button className="tclose" onClick={closeTerminal} title="Close terminal">
                  ✕
                </button>
              </div>
              <ArtifactDrawer session={activeArtSession} />
              <TerminalView
                key={selected.key}
                termKey={selected.key}
                sessionId={selected.sessionId}
                pid={selected.pid}
                cwd={selected.cwd}
                resume={selected.resume}
                resumeFlags={selected.resumeFlags}
                themeName={selThemeName}
                fontFamily={fontFamilyCss(snap.settings?.terminalFont)}
                fontSize={snap.settings?.terminalFontSize || DEFAULT_TERMINAL_FONT_SIZE}
                onSpawnFromSelection={(text, instant, type) => {
                  if (!selected.sessionId) {
                    showFlash('session not ready to spawn from')
                    return
                  }
                  const label = type === 'blocking' ? 'blocking child' : 'tangent'
                  if (instant) {
                    window.cc.sessionSpawnChild(selected.sessionId, selected.cwd, type, text)
                    showFlash(`spawned ${label} from selection`)
                    return
                  }
                  const parent = live.find((s) => s.sessionId === selected.sessionId)
                  if (parent)
                    setSpawn({
                      parent,
                      type,
                      cwd: selected.cwd,
                      note: text,
                      name: '',
                      autoMode: snap.settings?.spawnAutoMode ?? true,
                    })
                  else {
                    window.cc.sessionSpawnChild(selected.sessionId, selected.cwd, type, text)
                    showFlash(`spawned ${label} from selection`)
                  }
                }}
              />
              {recover && recover.key === selected.key && (
                <div
                  className="recover"
                  onClick={(e) => {
                    if (e.target === e.currentTarget) setRecover(null) // click-away to dismiss
                  }}
                >
                  <div className="recovercard">
                    <div className="recovertitle">This conversation no longer exists</div>
                    <div className="recoversub">
                      Its transcript was deleted or pruned, so it can’t be resumed. Pick up where it
                      left off, or clear it out.
                    </div>
                    <div className="recoveractions">
                      <button
                        className="rbtn primary"
                        onClick={() => {
                          window.cc.stateSet('activeSessionId', '') // repointed once the fresh one adopts
                          window.cc.sessionStartFresh(recover.cwd)
                          window.cc.sessionRemove(recover.sessionId)
                          setRecover(null)
                        }}
                      >
                        Start fresh here
                      </button>
                      <button
                        className="rbtn"
                        onClick={() => {
                          window.cc.stateSet('activeSessionId', '') // don't restore a removed session
                          window.cc.sessionRemove(recover.sessionId)
                          setSelected(null)
                          setRecover(null)
                        }}
                      >
                        Remove from list
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {composerOpen && (
                <div className="composer">
                  <textarea
                    className="composerinput"
                    value={composerText}
                    placeholder="Type a prompt — Enter for a newline, ⌘↩ to send"
                    onChange={(e) => setComposerText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault()
                        const t = composerText.trim()
                        if (!t || !selected.sessionId) return
                        window.cc.sessionSend(selected.sessionId, t).then((r) => {
                          if (r.ok) {
                            setComposerText('')
                            showFlash('sent')
                          } else showFlash(r.reason ? `not sent: ${r.reason}` : 'not sent')
                        })
                      }
                    }}
                  />
                </div>
              )}
              <div className="termstatus">
                <button
                  className="tsbtn"
                  title="Add a file or folder — inserts its path into the terminal"
                  onClick={async () => {
                    const p = await window.cc.pickPath(selected.sessionId)
                    if (p) window.cc.termInput(selected.key, `${insertablePath(p)} `)
                  }}
                >
                  ＋ file/folder
                </button>
                <button
                  className={`tsbtn${composerOpen ? ' on' : ''}`}
                  title="Toggle the prompt composer (Enter = newline, ⌘↩ = send)"
                  onClick={() => setComposerOpen((v) => !v)}
                >
                  ⌨ composer
                </button>
                <button
                  className="tsbtn"
                  title="Force the terminal to repaint — fixes misaligned/stale output (a SIGWINCH redraw, same as resizing the window)"
                  onClick={() => window.cc.termRedraw(selected.key)}
                >
                  ⟳ redraw
                </button>
                <span className="tsgrow" />
                <span className="tshint">drag a file onto the terminal to insert its path</span>
                <span className="tsctx" title="Context usage — pending a data source">
                  ctx&nbsp;—
                </span>
              </div>
            </>
          ) : deferredResume ? (
            /* Restore-on-launch found this session but it needs launch parameters.
               Asking at startup would mean a modal every time the app opens, so it
               waits here for a click. */
            <div className="placeholder">
              <div className="recovercard">
                <div className="recovertitle">{deferredResume.name ?? 'Last session'}</div>
                <div className="recoversub">
                  Not running. Resuming needs its launch parameters — model, effort, context and
                  mode — because <code>claude --resume</code> doesn&rsquo;t carry them forward.
                </div>
                <div className="recoveractions">
                  <button
                    className="rbtn primary"
                    onClick={() => {
                      const s = deferredResume
                      setDeferredResume(null)
                      openSession(s)
                    }}
                  >
                    Resume&hellip;
                  </button>
                  <button className="rbtn" onClick={() => setDeferredResume(null)}>
                    Not now
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="placeholder">
              <p>Select a session to open its terminal.</p>
              <p className="sub">
                Right-click a session to set its category or make it a blocking child / tangential
                offshoot of another. Opening a session running in iTerm resumes a managed copy here.
              </p>
            </div>
          )}
          </div>
          {companionOpen ? (
            <aside className="companion">
              <div className="comp-head">
                <div className="comp-scope">
                  <button
                    className={companionScope === 'category' ? 'on' : ''}
                    onClick={() => setScope('category')}
                    title="This category only"
                  >
                    {selectedGroup.emoji ? `${selectedGroup.emoji} ` : ''}
                    {selectedGroup.id === null ? 'Uncat' : selectedGroup.label || autoTag(selectedGroup.name)}
                  </button>
                  <button
                    className={companionScope === 'all' ? 'on' : ''}
                    onClick={() => setScope('all')}
                    title="Everything that needs you, across all categories"
                  >
                    All{needsYou.length > 0 ? ` · ${needsYou.length}` : ''}
                  </button>
                </div>
                <span className="grow" />
                <button className="comp-hide" onClick={() => showCompanion(false)} title="Hide panel">
                  ⇥
                </button>
              </div>
              {popped.has('strip') ? (
                <PopStub title="Timeline" onReturn={() => setPop('strip', false)} />
              ) : (
                <div className="poppable">
                  <button
                    className="pop-out"
                    onClick={() => setPop('strip', true)}
                    title="Pop out to a floating panel"
                  >
                    ⇱
                  </button>
                  {stripPanel}
                </div>
              )}
              <div className="comp-board">
                {boardItems.length === 0 ? (
                  <div className="comp-empty">
                    <div className="comp-empty-mark">✓</div>
                    <div>Nothing needs you{companionScope === 'category' ? ' in this category' : ''}.</div>
                  </div>
                ) : (
                  boardItems.map((s) => {
                    const why = whyOf(s)
                    const cat = s.categoryId != null ? catById.get(s.categoryId) : undefined
                    return (
                      <button
                        key={s.sessionId}
                        className={`wcard ns-${dstate(s)}${s.unhandled ? ' unhandled' : ''}`}
                        onClick={() => openSession(s)}
                      >
                        <div className="wc-top">
                          {s.unhandled && <span className="wc-pip" title="you haven't looked at this yet" />}
                          <span className={`cc-dot cc-dot--${dstate(s)}`} />
                          <span className="wc-name">{nameOf(s)}</span>
                          {cat && (
                            <span className="wc-cat" style={{ '--cat-color': cat.color } as CSSProperties}>
                              {cat.emoji && <span className="wc-cat-emoji">{cat.emoji}</span>}
                              {cat.label || autoTag(cat.name)}
                            </span>
                          )}
                          <span className="wc-age">{fmtAge(s.transcriptMtimeMs, snap.scannedAt)}</span>
                        </div>
                        {why && (
                          <div className={`wc-why why-${why.kind}`} title={why.text}>
                            {why.kind === 'permission' &&
                              (why.coarse ? (
                                <>
                                  {why.text} <span className="whytag">coarse</span>
                                </>
                              ) : (
                                <>
                                  <span className="whyverb">wants</span> <code>{why.text}</code>
                                </>
                              ))}
                            {why.kind === 'question' &&
                              (why.coarse ? (
                                <>
                                  {why.text} <span className="whytag">coarse</span>
                                </>
                              ) : (
                                <>
                                  <span className="whyverb">asked</span> {why.text}
                                </>
                              ))}
                            {why.kind === 'blocked' && (
                              <>
                                <span className="whyverb">blocked →</span> {why.text}
                              </>
                            )}
                            {why.kind === 'done' && (
                              <>
                                <span className="whyverb">✓ done — your move</span>
                                {why.gloss && <span className="whygloss"> {why.gloss}</span>}
                              </>
                            )}
                          </div>
                        )}
                        <CtxBar pct={s.contextPct} />
                      </button>
                    )
                  })
                )}
              </div>
              {popped.has('subagents') ? (
                <PopStub title="Activity" onReturn={() => setPop('subagents', false)} />
              ) : (
                <div className="poppable">
                  <button
                    className="pop-out"
                    onClick={() => setPop('subagents', true)}
                    title="Pop out to a floating panel"
                  >
                    ⇱
                  </button>
                  {fleetPanel}
                </div>
              )}
              <ArbiterConsole
                panel={snap.arbiter}
                enabled={snap.settings?.arbiterEnabled ?? false}
                paused={snap.settings?.arbiterPaused ?? false}
                capUsd={snap.settings?.arbiterCapUsd ?? 0}
              />
            </aside>
          ) : (
            <button
              className={`comp-spine${needsYou.length > 0 ? ' active' : ''}`}
              onClick={() => showCompanion(true)}
              title="Show the needs-you panel"
            >
              {needsYou.length > 0 && <span className="comp-spine-count">{needsYou.length}</span>}
              <span className="comp-spine-label">NEEDS YOU</span>
            </button>
          )}
        </main>
        {overviewOpen && (
          <OverviewGrid
            sessions={overviewTiles.map((s): OverviewSession => {
              const d = dstate(s)
              const cat = s.categoryId != null ? catById.get(s.categoryId) : undefined
              const question = hasQuestion(s)
              return {
                sessionId: s.sessionId,
                name: nameOf(s),
                dstate: d,
                stateLabel: question ? 'Asked you' : STATE[d].label,
                stateColor: STATE[d].color,
                question,
                categoryColor: cat?.color,
                categoryEmoji: cat?.emoji ?? null,
                categoryLabel: cat?.label ?? cat?.name,
              }
            })}
            overflow={overviewOverflow}
            showIdle={overviewIdle}
            onToggleIdle={toggleOverviewIdle}
            themeName={selThemeName}
            fontFamily={fontFamilyCss(snap.settings?.terminalFont)}
            fontSize={snap.settings?.terminalFontSize || DEFAULT_TERMINAL_FONT_SIZE}
            onPick={(sid) => {
              const s = live.find((x) => x.sessionId === sid)
              setOverviewOpen(false)
              if (s) openSession(s)
            }}
            onClose={() => setOverviewOpen(false)}
          />
        )}
      </div>

      {menu && (
        <ContextMenu
          menu={menu}
          snap={snap}
          live={live}
          edgeByChild={edgeByChild}
          setMenu={setMenu}
          assign={assign}
          setEdge={setEdge}
          onNewCat={() => {
            const pos = menu ? { x: menu.x, y: menu.y } : { x: 90, y: 110 }
            setMenu(null)
            setCatEdit({
              id: null,
              name: '',
              color: '',
              label: null,
              emoji: null,
              notify: { permission: null, question: null, done: null },
              count: 0,
              arbiterContext: 0,
              x: pos.x,
              y: pos.y,
            })
          }}
          onSpawn={(s, type) => {
            setMenu(null)
            setSpawn({
              parent: s,
              type,
              cwd: s.cwd,
              note: '',
              name: '',
              autoMode: snap.settings?.spawnAutoMode ?? true,
            })
          }}
          onSend={(s) => {
            setMenu(null)
            setSend(s)
          }}
          onCopy={(s) => {
            setMenu(null)
            window.cc
              .copyOutput(s.sessionId, s.cwd)
              .then((r) => showFlash(r.ok ? `copied ${r.chars} chars` : 'no output to copy'))
          }}
          onRemove={async (s) => {
            setMenu(null)
            if (!s.sessionId) return
            const kids = descendantIds(s.sessionId, snap.edges)
            const live = !!s.managed && !s.dormant
            if (kids.length || live) {
              const also = kids.length
                ? ` and its ${kids.length} descendant session${kids.length > 1 ? 's' : ''}`
                : ''
              const label = s.name ?? `pid ${s.pid}`
              if (!window.confirm(`Remove “${label}”${also}? Their terminal${kids.length ? 's' : ''} will be ended.`))
                return
            }
            const r = await window.cc.sessionRemove(s.sessionId)
            const removed = new Set(r?.removed ?? [s.sessionId])
            if (selected?.sessionId && removed.has(selected.sessionId)) {
              setSelected(null)
              window.cc.stateSet('activeSessionId', '')
            }
          }}
          onLaunchParams={(s) => {
            setMenu(null)
            setResumeGate({ session: s, edit: true })
          }}
          onRename={(s) => {
            if (!s.sessionId) return
            setNameEdit({ sessionId: s.sessionId, name: s.name ?? '', x: menu.x, y: menu.y })
            setMenu(null)
          }}
        />
      )}
      {nameEdit && (
        <SessionNameEditor
          edit={nameEdit}
          setEdit={setNameEdit}
          onSaved={(sessionId, nm) => {
            // Keep the open terminal's header in sync if it's this session.
            if (selected?.sessionId === sessionId) setSelected({ ...selected, name: nm || `pid ${selected.pid}` })
          }}
        />
      )}
      {spawn && (
        <SpawnComposer
          spawn={spawn}
          setSpawn={setSpawn}
          apiKeys={snap.apiKeys ?? []}
          siblingNames={live
            .filter((s) => edgeByChild.get(s.sessionId ?? '')?.parent_id === spawn.parent.sessionId)
            .map((s) => (s.name ?? '').toLowerCase())
            .filter(Boolean)}
        />
      )}
      {send && (
        <SendComposer
          origin={send}
          managed={live.filter((s) => s.managed && !s.dormant)}
          setSend={setSend}
        />
      )}
      {newSessionOpen && (
        <NewSessionComposer
          categories={snap.categories}
          defaultCat={selectedCat}
          home={snap.home}
          recent={snap.recentFolders ?? []}
          lastModel={snap.settings?.lastModel ?? ''}
          lastEffort={snap.settings?.lastEffort ?? ''}
          lastContext={snap.settings?.lastContext ?? ''}
          lastMode={snap.settings?.lastMode ?? ''}
          lastResumeSticky={snap.settings?.lastResumeSticky ?? false}
          apiKeys={snap.apiKeys ?? []}
          close={() => setNewSessionOpen(false)}
        />
      )}
      {resumeGate && (
        <ResumeParamsComposer
          session={resumeGate.session}
          settings={snap.settings}
          edit={resumeGate.edit}
          onCancel={() => setResumeGate(null)}
          onConfirm={(flags, remember) => {
            const { session: s, edit } = resumeGate
            setResumeGate(null)
            // Persist for next time (remember=false still records them, so the
            // modal prefills), and pass inline as a one-shot so the spawn doesn't
            // race the async write — the node row may not even exist yet.
            window.cc.resumeFlagsSet(s.sessionId, flags, remember)
            // Edit mode is a pure settings change — don't resume/attach; the row is
            // now sticky, so a later click opens it silently with these flags.
            if (!edit) reallyOpen(s, flags)
          }}
        />
      )}
      {catEdit && <CategoryEditor edit={catEdit} setEdit={setCatEdit} onCreated={(id) => setSelectedCat(id)} />}
      {logOpen && (
        <MessageLog
          messages={snap.messages ?? []}
          paused={!!snap.awarenessPaused}
          close={() => setLogOpen(false)}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          settings={snap.settings}
          apiKeys={snap.apiKeys ?? []}
          showFlash={showFlash}
          close={() => setSettingsOpen(false)}
        />
      )}
      {snap.settings && !snap.settings.firstRunSeen && (
        <FirstRunMail settings={snap.settings} showFlash={showFlash} />
      )}
      {updateAvail && (
        <UpdateAvailableModal
          payload={updateAvail}
          dl={updateDl}
          onInstall={() => window.cc.updateInstall()}
          onInstallOnQuit={() => {
            window.cc.updateInstallOnQuit()
          }}
          onSkip={() => {
            window.cc.updateSkip(updateAvail.version)
            setUpdateAvail(null)
            setUpdateDl(null)
          }}
          onRemindLater={() => {
            setUpdateAvail(null)
            setUpdateDl(null)
          }}
        />
      )}
      {postUpdate && (
        <PostUpdateModal payload={postUpdate} close={() => setPostUpdate(null)} />
      )}
      {flash && <div className="flash">{flash}</div>}
    </div>
  )
}

// Settings menu. Backed by app_state via settingsSet; the mail-permission grant
// edits ~/.claude/settings.json (see main). Grows as more settings are added.
function SettingsModal({
  settings,
  apiKeys,
  showFlash,
  close,
}: {
  settings?: AppSettings
  apiKeys: ApiKey[]
  showFlash: (m: string) => void
  close: () => void
}) {
  const [tab, setTab] = useState<'general' | 'terminal' | 'notifications' | 'arbiter' | 'keys'>(
    'general',
  )
  const trust = settings?.trustChildrenByDefault ?? true
  const mailGranted = settings?.mailAllowGranted ?? false
  const hooksInstalled = settings?.statusHooksInstalled ?? false
  // Installed monospace fonts for the terminal-font picker (discovered async).
  const [fontList, setFontList] = useState<string[]>([])
  useEffect(() => {
    let live = true
    listMonospaceFonts().then((l) => live && setFontList(l))
    return () => {
      live = false
    }
  }, [])
  const curFont = settings?.terminalFont?.trim() ?? ''
  const curSize = settings?.terminalFontSize || DEFAULT_TERMINAL_FONT_SIZE
  // One combobox (input + datalist) is the single source of truth for the font —
  // no separate dropdown to desync from. Draft seeds from the stored value at open.
  const [fontDraft, setFontDraft] = useState(curFont)
  const commitFont = (v: string) => {
    const next = v.trim()
    if (next !== curFont) window.cc.settingsSet('terminalFont', next)
  }
  const [keyName, setKeyName] = useState('')
  const [keyVal, setKeyVal] = useState('')
  const [adding, setAdding] = useState(false)
  const addKey = async () => {
    if (!keyName.trim() || !keyVal.trim() || adding) return
    setAdding(true)
    const r = await window.cc.apiKeysAdd(keyName.trim(), keyVal.trim())
    setAdding(false)
    if (r.ok) {
      setKeyName('')
      setKeyVal('')
      showFlash('API key stored')
    } else showFlash(`couldn’t store: ${r.reason}`)
  }
  return (
    <div className="spawnscrim" onClick={close}>
      <div className="spawnmodal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="spawntitle">Settings</div>
        <div className="settabs">
          {(['general', 'terminal', 'notifications', 'arbiter', 'keys'] as const).map((t) => (
            <button
              key={t}
              className={`settab${tab === t ? ' on' : ''}`}
              onClick={() => setTab(t)}
            >
              {t === 'general'
                ? 'General'
                : t === 'terminal'
                  ? 'Terminal'
                  : t === 'notifications'
                    ? 'Notifications'
                    : t === 'arbiter'
                      ? 'Arbiter'
                      : 'API keys'}
            </button>
          ))}
        </div>

        <div className="settbody">
        {tab === 'general' && (
        <>
        <label className="setrow">
          <input
            type="checkbox"
            checked={trust}
            onChange={(e) => window.cc.settingsSet('trustChildrenByDefault', String(e.target.checked))}
          />
          <span>
            <b>Trust children by default</b>
            <span className="setsub">
              {trust
                ? 'A child you spawn can message its parent (and be messaged) automatically.'
                : 'You’ll manually trust each child: right-click it → Trust link.'}
            </span>
          </span>
        </label>

        <label className="setrow">
          <input
            type="checkbox"
            checked={settings?.hideUnmanaged ?? false}
            onChange={(e) => window.cc.settingsSet('hideUnmanaged', String(e.target.checked))}
          />
          <span>
            <b>Only show sessions managed here</b>
            <span className="setsub">
              Hide live Claude Code sessions running in other terminals that this app doesn’t
              manage — they add noise to the needs-you bar as they work. Your own sessions
              (and resumable ones) always stay.
            </span>
          </span>
        </label>

        <div className="setrow">
          <span>
            <b>Awareness mailbox write permission</b>
            <span className="setsub">
              {mailGranted
                ? 'Granted — sessions write their outbox without a permission prompt.'
                : 'Pre-authorize writes to ~/.claude/ccc/ in your global Claude settings so sessions don’t get prompted on every message.'}
            </span>
          </span>
          <button
            className="rbtn"
            disabled={mailGranted}
            onClick={async () => {
              const r = await window.cc.settingsGrantMail()
              showFlash(r.ok ? 'mailbox writes pre-authorized' : `couldn’t grant: ${r.reason ?? 'error'}`)
            }}
          >
            {mailGranted ? 'Granted ✓' : 'Grant…'}
          </button>
        </div>

        <div className="setrow">
          <span>
            <b>Accurate status via hooks</b>
            <span className="setsub">
              {hooksInstalled
                ? 'Installed — sessions report working / your turn / needs-approval themselves.'
                : 'Adds lightweight hooks to your global Claude settings so every session reports its own state (incl. the instant a permission dialog opens) instead of the app inferring it. Applies to sessions started after install.'}
            </span>
          </span>
          <button
            className="rbtn"
            onClick={async () => {
              const r = hooksInstalled
                ? await window.cc.settingsRemoveStatusHooks()
                : await window.cc.settingsInstallStatusHooks()
              showFlash(
                r.ok
                  ? hooksInstalled
                    ? 'status hooks removed'
                    : 'status hooks installed'
                  : `couldn’t ${hooksInstalled ? 'remove' : 'install'}: ${r.reason ?? 'error'}`,
              )
            }}
          >
            {hooksInstalled ? 'Remove' : 'Install…'}
          </button>
        </div>
        </>
        )}

        {tab === 'terminal' && (
        <div className="setsection">
          <b>Terminal font</b>
          <span className="setsub">
            Applies to every terminal, live. Pick from the monospaced fonts installed on this Mac,
            or type any family name (a proportional font would misalign Claude’s interface). Leave
            blank for the system default.
          </span>
          <div className="setrow">
            <span className="setlabel">Font</span>
            <input
              className="cat-in"
              list="ccc-fontlist"
              value={fontDraft}
              placeholder="System default (Menlo)"
              onChange={(e) => setFontDraft(e.target.value)}
              onBlur={() => commitFont(fontDraft)}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            <datalist id="ccc-fontlist">
              {fontList.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </div>
          <div className="setrow">
            <span className="setlabel">Size</span>
            <input
              className="cat-in"
              type="number"
              min="6"
              max="40"
              step="0.5"
              defaultValue={curSize}
              onBlur={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n) && n >= 6 && n <= 40)
                  window.cc.settingsSet('terminalFontSize', String(n))
              }}
            />
            <span className="setsub">px</span>
          </div>
          <div
            className="fontpreview"
            style={{ fontFamily: fontFamilyCss(fontDraft), fontSize: `${curSize}px` }}
          >
            The quick brown fox 0123 () {'{}'} =&gt; != ~/dev &amp;&amp; ll
          </div>
        </div>
        )}

        {tab === 'notifications' && (
        <>
        <label className="setrow">
          <input
            type="checkbox"
            checked={settings?.notifyEnabled ?? false}
            onChange={(e) => window.cc.settingsSet('notifyEnabled', String(e.target.checked))}
          />
          <span>
            <b>macOS notifications</b>
            <span className="setsub">
              Off by default. Turning this on is also when macOS asks for notification
              permission. Notifications never fire while this window is focused — the
              needs-you bar already covers that.
            </span>
          </span>
        </label>

        <div className="setsection">
          <b>Notify me when a session…</b>
          <span className="spawnsub">
            Defaults cover the cases where something is stopped and only you can unstick it.
            Each category can override these individually (right-click a category → Edit).
          </span>
          <label className="setrow">
            <input
              type="checkbox"
              disabled={!(settings?.notifyEnabled ?? false)}
              checked={settings?.notifyPermission ?? true}
              onChange={(e) => window.cc.settingsSet('notifyPermission', String(e.target.checked))}
            />
            <span>
              <b>Needs permission</b>
              <span className="setsub">Parked on a permission dialog. Nothing moves until you answer.</span>
            </span>
          </label>
          <label className="setrow">
            <input
              type="checkbox"
              disabled={!(settings?.notifyEnabled ?? false)}
              checked={settings?.notifyQuestion ?? true}
              onChange={(e) => window.cc.settingsSet('notifyQuestion', String(e.target.checked))}
            />
            <span>
              <b>Your turn</b>
              <span className="setsub">Asked you a question and is waiting on the answer.</span>
            </span>
          </label>
          <label className="setrow">
            <input
              type="checkbox"
              disabled={!(settings?.notifyEnabled ?? false)}
              checked={settings?.notifyDone ?? false}
              onChange={(e) => window.cc.settingsSet('notifyDone', String(e.target.checked))}
            />
            <span>
              <b>Finished a task</b>
              <span className="setsub">
                Off by default — nothing is blocked and this is the highest-volume class, so
                leaving it on is the fastest way to start ignoring notifications.
              </span>
            </span>
          </label>
        </div>
        </>
        )}

        {tab === 'arbiter' && (
        <div className="setsection">
          <b>The Arbiter</b>
          <span className="setsub">
            An optional agent that writes a plain-English line explaining why each session is
            waiting on you. It runs on <b>metered API billing</b>, not your subscription, and reads
            only categories you tick in the category editor — everything else sends state alone. It
            takes no action on any session.
          </span>
          <label className="setrow">
            <input
              type="checkbox"
              checked={settings?.arbiterEnabled ?? false}
              // Only block turning it ON without a key — a checked box must
              // always be clickable, or a bad state can't be switched off.
              disabled={apiKeys.length === 0 && !(settings?.arbiterEnabled ?? false)}
              onChange={(e) => window.cc.arbiterSetEnabled(e.target.checked)}
            />
            <span>
              Enabled
              {apiKeys.length === 0 && <span className="setsub"> — add an API key first</span>}
            </span>
          </label>
          <div className="setrow">
            <span className="setlabel">Key</span>
            <select
              className="cat-in"
              value={settings?.arbiterKeyId ?? ''}
              onChange={(e) =>
                window.cc.arbiterSetKey(e.target.value === '' ? null : Number(e.target.value))
              }
            >
              <option value="">none</option>
              {apiKeys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
          </div>
          <div className="setrow">
            <span className="setlabel">Model</span>
            <select
              className="cat-in"
              value={settings?.arbiterModel ?? 'claude-haiku-4-5'}
              onChange={(e) => window.cc.arbiterSetModel(e.target.value)}
            >
              <option value="claude-haiku-4-5">Haiku — cheapest, the default</option>
              <option value="claude-sonnet-5">Sonnet — steadier triage</option>
              <option value="claude-opus-4-8">Opus — best, priciest</option>
            </select>
            <span className="setsub">Pricing tracks the model; the spend readout stays accurate.</span>
          </div>
          <div className="setrow">
            <span className="setlabel">Daily cap</span>
            <input
              className="cat-in"
              type="number"
              min="0"
              step="0.25"
              defaultValue={settings?.arbiterCapUsd ?? 1}
              onBlur={(e) => window.cc.arbiterSetCap(Number(e.target.value))}
            />
            <span className="setsub">USD — it stops at this, it does not just warn. 0 = no cap.</span>
          </div>
        </div>
        )}

        {tab === 'keys' && (
        <div className="setsection">
          <b>API keys</b>
          <span className="setsub">
            Stored encrypted in your macOS Keychain — never shown again, never leaves this machine
            in the clear. Pick one per session to run it on metered API billing instead of your
            subscription.
          </span>
          {apiKeys.length > 0 && (
            <div className="keylist">
              {apiKeys.map((k) => (
                <div className="keyrow" key={k.id}>
                  <span className="keyname">{k.name}</span>
                  <span className="keyhint">{k.hint}</span>
                  <button
                    className="rbtn danger"
                    onClick={async () => {
                      if (!window.confirm(`Remove API key “${k.name}”?`)) return
                      await window.cc.apiKeysRemove(k.id)
                      showFlash('API key removed')
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="keyadd">
            <input
              className="spawnname"
              value={keyName}
              placeholder="Name — e.g. Personal, Work…"
              onChange={(e) => setKeyName(e.target.value)}
            />
            <input
              className="spawnname"
              type="password"
              value={keyVal}
              placeholder="sk-ant-…  (paste key; hidden)"
              autoComplete="off"
              onChange={(e) => setKeyVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addKey()
              }}
            />
            <button className="rbtn primary" disabled={!keyName.trim() || !keyVal.trim() || adding} onClick={addKey}>
              Add Claude API key
            </button>
          </div>
        </div>
        )}
        </div>

        <div className="spawnactions">
          <button className="rbtn" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// First-run offer to pre-authorize the mailbox path (with the why). Opt-out just
// records firstRunSeen; you can grant later in Settings.
function FirstRunMail({
  settings,
  showFlash,
}: {
  settings: AppSettings
  showFlash: (m: string) => void
}) {
  if (settings.mailAllowGranted) return null
  return (
    <div className="spawnscrim">
      <div className="spawnmodal" onClick={(e) => e.stopPropagation()}>
        <div className="spawntitle">Let sessions message each other without prompts?</div>
        <div className="spawnsub">
          The awareness bus lets your sessions message each other by writing tiny files to{' '}
          <code>~/.claude/ccc/</code>. By default, Claude Code asks permission every time a session
          writes there. With your OK, CC Command Center will add one narrowly-scoped rule —{' '}
          <code>Write(~/.claude/ccc/**)</code> — to your global <code>~/.claude/settings.json</code>{' '}
          (backed up first) so those writes just work. Nothing else is changed. You can undo it there
          anytime, or turn it on later in Settings.
        </div>
        <div className="spawnactions">
          <button
            className="rbtn"
            onClick={() => window.cc.settingsSet('firstRunSeen', 'true')}
          >
            Not now
          </button>
          <button
            className="rbtn primary"
            onClick={async () => {
              const r = await window.cc.settingsGrantMail()
              showFlash(r.ok ? 'mailbox writes pre-authorized' : `couldn’t grant: ${r.reason ?? 'error'}`)
            }}
          >
            Allow mailbox writes
          </button>
        </div>
      </div>
    </div>
  )
}

function ContextMenu({
  menu,
  snap,
  live,
  edgeByChild,
  setMenu,
  assign,
  setEdge,
  onNewCat,
  onSpawn,
  onSend,
  onCopy,
  onRemove,
  onRename,
  onLaunchParams,
}: {
  menu: Menu
  snap: Snapshot
  live: Session[]
  edgeByChild: Map<string, Edge>
  setMenu: (m: Menu | null) => void
  assign: (s: Session, c: number | null) => void
  setEdge: (child: Session, parent: Session, type: MenuMode) => void
  onNewCat: () => void
  onSpawn: (s: Session, type: 'blocking' | 'tangential') => void
  onSend: (s: Session) => void
  onCopy: (s: Session) => void
  onRemove: (s: Session) => void
  onRename: (s: Session) => void
  onLaunchParams: (s: Session) => void
}) {
  const s = menu.session
  const hasParent = edgeByChild.has(s.sessionId)
  const isBlockingChild = edgeByChild.get(s.sessionId)?.type === 'blocking'
  const candidates = live.filter((x) => x.categoryId === s.categoryId && x.sessionId !== s.sessionId)
  return (
    <>
      <div
        className="menuscrim"
        onClick={() => setMenu(null)}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu(null)
        }}
      />
      <div className="menu" style={{ left: menu.x, top: menu.y }}>
        {menu.mode === 'root' ? (
          <>
            {isBlockingChild ? (
              <div className="menuhint">Category follows its parent (blocking child)</div>
            ) : (
              <>
                <div className="menuhead">Move “{s.name ?? `pid ${s.pid}`}” to</div>
                {snap.categories.map((c) => (
                  <button key={c.id} className="menuitem" onClick={() => assign(s, c.id)}>
                    <span className="cdot" style={{ background: c.color }} />
                    <span className="grow">{c.name}</span>
                    {s.categoryId === c.id && <span className="check">✓</span>}
                  </button>
                ))}
                <button className="menuitem" onClick={() => assign(s, null)}>
                  <span className="cdot" style={{ background: '#5b6474' }} />
                  <span className="grow">Uncategorized</span>
                  {s.categoryId == null && <span className="check">✓</span>}
                </button>
              </>
            )}
            <div className="menusep" />
            <button className="menuitem" onClick={() => onRename(s)}>
              Rename…
            </button>
            {/* The only way to change or clear a session's remembered launch
                parameters once they're sticky — otherwise ticking "always" with
                the wrong model would be a one-way door. */}
            <button className="menuitem" onClick={() => onLaunchParams(s)}>
              Launch settings…
            </button>
            <button className="menuitem" onClick={() => onCopy(s)}>
              Copy last output
            </button>
            {s.managed && (
              <button className="menuitem" onClick={() => onSend(s)}>
                Send prompt…
              </button>
            )}
            <button className="menuitem" onClick={() => onSpawn(s, 'blocking')}>
              Spawn blocking child…
            </button>
            <button className="menuitem" onClick={() => onSpawn(s, 'tangential')}>
              Spawn tangential offshoot…
            </button>
            <div className="menusep" />
            <button className="menuitem" onClick={() => setMenu({ ...menu, mode: 'blocking' })}>
              Make blocking child of…
            </button>
            <button className="menuitem" onClick={() => setMenu({ ...menu, mode: 'tangential' })}>
              Make tangential offshoot of…
            </button>
            {hasParent && (
              <button
                className="menuitem"
                onClick={() => {
                  window.cc.edgeTrust(s.sessionId, !edgeByChild.get(s.sessionId)?.trusted)
                  setMenu(null)
                }}
              >
                {edgeByChild.get(s.sessionId)?.trusted
                  ? 'Untrust link messaging'
                  : 'Trust link — let it message its parent'}
              </button>
            )}
            {hasParent && (
              <button
                className="menuitem"
                onClick={() => {
                  window.cc.edgeClear(s.sessionId)
                  setMenu(null)
                }}
              >
                Clear parent
              </button>
            )}
            <div className="menusep" />
            <button className="menuitem danger" onClick={() => onRemove(s)}>
              Remove from list{s.dormant ? '' : ' (ends terminal)'}
            </button>
            <div className="menusep" />
            <button className="menuitem" onClick={onNewCat}>
              + New category…
            </button>
          </>
        ) : (
          <>
            <div className="menuhead">
              {menu.mode === 'blocking' ? 'Blocking child of…' : 'Tangential offshoot of…'}
            </div>
            {candidates.length === 0 && <div className="emptycat">no other sessions in this category</div>}
            {candidates.sort(bySort).map((p) => (
              <button key={p.sessionId} className="menuitem" onClick={() => setEdge(s, p, menu.mode)}>
                <span className={`cc-dot cc-dot--${p.state}`} />
                <span className="grow">
                  {p.name ?? (p.dormant ? p.sessionId.slice(0, 8) : `pid ${p.pid}`)}
                </span>
              </button>
            ))}
            <div className="menusep" />
            <button className="menuitem" onClick={() => setMenu({ ...menu, mode: 'root' })}>
              ← back
            </button>
          </>
        )}
      </div>
    </>
  )
}

type SpawnState = {
  parent: Session
  type: 'blocking' | 'tangential'
  cwd: string
  note: string
  name: string
  autoMode: boolean
  apiKeyId?: number
}

// "Use an API key for this session" — a checkbox that reveals a key dropdown.
// value is the chosen key id (undefined = use the subscription).
function ApiKeyPicker({
  apiKeys,
  value,
  onChange,
}: {
  apiKeys: ApiKey[]
  value?: number
  onChange: (id?: number) => void
}) {
  const on = value != null
  return (
    <div className="apikeypick">
      <label className="setrow">
        <input
          type="checkbox"
          checked={on}
          disabled={apiKeys.length === 0}
          onChange={(e) => onChange(e.target.checked ? apiKeys[0]?.id : undefined)}
        />
        <span>
          <b>Use an API key for this session</b>
          <span className="setsub">
            {apiKeys.length === 0
              ? 'Add a key in Settings first — runs this session on metered API billing.'
              : 'Runs on metered API billing instead of your subscription.'}
          </span>
        </span>
      </label>
      {on && (
        <>
          <select
            className="keyselect"
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
          >
            {apiKeys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name} · {k.hint}
              </option>
            ))}
          </select>
          <div className="keywarn">
            A session on a key can read that key (anything it runs can too). Prefer a key with a
            spend limit, and avoid high-value keys on untrusted or fully-automated work.
          </div>
        </>
      )}
    </div>
  )
}

function SpawnComposer({
  spawn,
  setSpawn,
  siblingNames,
  apiKeys,
}: {
  spawn: SpawnState
  setSpawn: (s: SpawnState | null) => void
  siblingNames: string[]
  apiKeys: ApiKey[]
}) {
  const isBlocking = spawn.type === 'blocking'
  const parentName = spawn.parent.name ?? `pid ${spawn.parent.pid}`
  // Duplicate child name → ambiguous @-addressing on the bus; block it.
  const dupName = !!spawn.name.trim() && siblingNames.includes(spawn.name.trim().toLowerCase())
  const submit = () => {
    if (dupName) return
    window.cc.sessionSpawnChild(
      spawn.parent.sessionId,
      spawn.cwd,
      spawn.type,
      spawn.note.trim() || undefined,
      spawn.name.trim() || undefined,
      spawn.autoMode,
      spawn.apiKeyId,
    )
    setSpawn(null)
  }
  return (
    <div className="spawnscrim" onClick={() => setSpawn(null)}>
      <div className="spawnmodal" onClick={(e) => e.stopPropagation()}>
        <div className="spawntitle">Spawn {isBlocking ? 'blocking child' : 'tangential offshoot'}</div>
        <div className="spawnsub">
          of “{parentName}” —{' '}
          {isBlocking
            ? 'blocks the parent until it’s done; the parent rolls back to it.'
            : 'spun off with context; does not block the parent.'}
        </div>
        <div className="spawntype">
          <button
            className={spawn.type === 'tangential' ? 'on' : ''}
            onClick={() => setSpawn({ ...spawn, type: 'tangential' })}
          >
            Tangential offshoot
          </button>
          <button
            className={spawn.type === 'blocking' ? 'on' : ''}
            onClick={() => setSpawn({ ...spawn, type: 'blocking' })}
          >
            Blocking child
          </button>
        </div>
        <div className="spawnlabel">
          Name <span className="spawnopt">optional — how you’ll @message it; stays fixed</span>
        </div>
        <input
          className="spawnname"
          value={spawn.name}
          placeholder="e.g. reviewer, db-work…"
          onChange={(e) => setSpawn({ ...spawn, name: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
            if (e.key === 'Escape') setSpawn(null)
          }}
        />
        {dupName && (
          <div className="spawnwarn">“{spawn.name.trim()}” already names a child of this parent — pick another.</div>
        )}
        <div className="spawnlabel">Folder</div>
        <div className="spawnfolder">
          <span className="spawncwd" title={spawn.cwd}>
            {spawn.cwd}
          </span>
          <button
            className="rbtn"
            onClick={async () => {
              const p = await window.cc.pickFolder()
              if (p) setSpawn({ ...spawn, cwd: p })
            }}
          >
            Change…
          </button>
        </div>
        <div className="spawnlabel">
          Handoff note <span className="spawnopt">optional — sent as the child’s first message</span>
        </div>
        <textarea
          className="spawnnote"
          autoFocus
          value={spawn.note}
          placeholder="What should the child pick up? The gap to fill, context, links…"
          onChange={(e) => setSpawn({ ...spawn, note: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
            if (e.key === 'Escape') setSpawn(null)
          }}
        />
        <label className="setrow spawnauto">
          <input
            type="checkbox"
            checked={spawn.autoMode}
            onChange={(e) => setSpawn({ ...spawn, autoMode: e.target.checked })}
          />
          <span>
            <b>Start in auto mode</b>
            <span className="setsub">recommended for parent/child work</span>
          </span>
        </label>
        <ApiKeyPicker
          apiKeys={apiKeys}
          value={spawn.apiKeyId}
          onChange={(id) => setSpawn({ ...spawn, apiKeyId: id })}
        />
        <div className="spawnhint">
          Parent–child messaging writes to a small mailbox file, and each session’s first write
          crosses a permission gate. Auto mode clears it on its own; without auto mode you’ll
          approve one prompt in each session before messages flow. Pre-authorizing the mailbox in
          Settings removes the gate entirely.
        </div>
        <div className="spawnactions">
          <button className="rbtn" onClick={() => setSpawn(null)}>
            Cancel
          </button>
          <button className="rbtn primary" onClick={submit} disabled={dupName}>
            Spawn {isBlocking ? 'blocking child' : 'offshoot'}
          </button>
        </div>
      </div>
    </div>
  )
}

const MODEL_OPTS = [
  { v: '', label: 'Default' },
  { v: 'opus', label: 'Opus' },
  { v: 'sonnet', label: 'Sonnet' },
  { v: 'haiku', label: 'Haiku' },
  { v: 'fable', label: 'Fable' },
  { v: '__custom__', label: 'Custom…' },
]
// `ultracode` is not a sixth effort level: the CLI maps it to xhigh AND injects a
// standing instruction to orchestrate with the Workflow tool. It's accepted by
// --effort but undocumented in --help, and it silently no-ops on a model without
// xhigh, so it's gated per-model below.
const EFFORT_OPTS: { v: string; label: string; ultra?: boolean }[] = [
  { v: '', label: 'Default' },
  { v: 'low', label: 'low' },
  { v: 'medium', label: 'medium' },
  { v: 'high', label: 'high' },
  { v: 'xhigh', label: 'xhigh' },
  { v: 'max', label: 'max' },
  { v: 'ultracode', label: 'ultracode', ultra: true },
]
// The Arbiter console: docked at the bottom of the companion pane. This is NOT
// where the insight lives — the gloss renders inline on the session it describes.
// This is where you audit the agent: what it is doing, and what it has cost.
// Collapsed to a single line unless opened, so it stays quiet.
// Fleet activity: the subagents every session in scope has spawned, and their
// status. Arbiter-style — a quiet collapsed line ("N running" / "no subagents"),
// click to expand into the full list grouped by the session that owns each one.
// A floating, draggable card that holds a popped-out companion panel. Rendered
// via a portal to <body> so it sits over the terminal area regardless of where
// the source panel lived. NOT an OS window — deliberately in-app (the OS-window
// version is deferred). Position is per-panel and persisted, so a popped panel
// comes back where you left it.
function FloatCard({
  id,
  title,
  onReturn,
  children,
}: {
  id: string
  title: string
  onReturn: () => void
  children: React.ReactNode
}): React.ReactElement {
  const clampPos = (p: { x: number; y: number }): { x: number; y: number } => ({
    // Keep the header on-screen so a card can never be dragged fully out of reach.
    x: Math.min(Math.max(0, p.x), window.innerWidth - 80),
    y: Math.min(Math.max(0, p.y), window.innerHeight - 40),
  })
  // Default: down the right edge, offset per panel so two don't overlap.
  const [pos, setPos] = useState<{ x: number; y: number }>(() => ({
    x: Math.max(40, window.innerWidth - 400),
    y: id === 'subagents' ? 360 : 96,
  }))
  const drag = useRef<{ dx: number; dy: number } | null>(null)
  const posRef = useRef(pos)
  posRef.current = pos
  useEffect(() => {
    window.cc.stateGet(`floatpos:${id}`).then((v) => {
      if (!v) return
      try {
        const p = JSON.parse(v)
        if (typeof p?.x === 'number' && typeof p?.y === 'number') setPos(clampPos(p))
      } catch {
        /* ignore */
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  const onPointerDown = (e: React.PointerEvent): void => {
    if ((e.target as HTMLElement).closest('.fc-return')) return // don't drag on the button
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    if (!drag.current) return
    setPos(clampPos({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy }))
  }
  const onPointerUp = (): void => {
    if (!drag.current) return
    drag.current = null
    window.cc.stateSet(`floatpos:${id}`, JSON.stringify(posRef.current))
  }
  return (
    <div className="floatcard" style={{ left: pos.x, top: pos.y }}>
      <div
        className="fc-head"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <span className="fc-grip">⠿</span>
        <span className="fc-title">{title}</span>
        <span className="grow" />
        <button className="fc-return" onClick={onReturn} title="Dock back into the sidebar">
          return to sidebar
        </button>
      </div>
      <div className="fc-body">{children}</div>
    </div>
  )
}

// The stub left in the companion while a panel is popped out — so the slot never
// silently vanishes: you can see it's out and dock it back. The panel itself
// floats separately (FloatCard, rendered at the app root).
function PopStub({
  title,
  onReturn,
}: {
  title: string
  onReturn: () => void
}): React.ReactElement {
  return (
    <div className="pop-stub">
      <span className="pop-stub-txt">{title} — in separate window</span>
      <button className="pop-stub-btn" onClick={onReturn}>
        return to sidebar
      </button>
    </div>
  )
}

// An all-done group whose newest subagent started longer ago than this is stale
// history — hidden entirely so a finished workflow stops taking up the panel.
const FLEET_DONE_TTL_MS = 15 * 60 * 1000

function FleetActivity({
  sessions,
  now,
  onOpen,
  activeSessionId,
}: {
  sessions: Session[]
  now: number
  onOpen: (s: Session) => void
  activeSessionId: string | null
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    window.cc.stateGet('subsOpen').then((v) => v === 'true' && setOpen(true))
  }, [])
  const toggle = (): void => {
    const n = !open
    setOpen(n)
    window.cc.stateSet('subsOpen', String(n))
  }
  // Per session: split the active subagents (shown as rows — the live signal)
  // from the done ones (collapsed to a count, so a 40-agent workflow doesn't
  // flood the panel). A group with nothing active and only stale done work is
  // dropped entirely.
  const groups = sessions
    .filter((s) => (s.subtasks?.length ?? 0) > 0 || (s.workflows?.length ?? 0) > 0)
    .map((s) => {
      const subs = s.subtasks ?? []
      const active = subs.filter((t) => t.status === 'running' || t.status === 'stalled')
      // Failed = awareness, not action: shown as its own soft row, never a gate.
      const failed = subs.filter((t) => t.status === 'failed')
      const done = subs.filter((t) => t.status === 'done')
      // Workflows: one rich entry each. Running ones show as rows; done ones fold
      // into the done count (like finished subtasks).
      const wfs = s.workflows ?? []
      const wfRunning = wfs.filter((w) => w.status === 'running')
      const wfDone = wfs.length - wfRunning.length
      const newest = Math.max(
        subs.reduce((m, t) => Math.max(m, t.startedAt ?? 0), 0),
        wfs.reduce((m, w) => Math.max(m, w.startedAt ?? 0), 0),
      )
      return {
        session: s,
        active,
        failed,
        wfRunning,
        doneCount: done.length + wfDone,
        newest,
      }
    })
    // A group shows while it has live work, OR recently (TTL) if it only has
    // finished/failed work — so a just-failed task lingers long enough to notice.
    .filter((g) => g.active.length > 0 || g.wfRunning.length > 0 || now - g.newest <= FLEET_DONE_TTL_MS)

  const running = groups.reduce((n, g) => n + g.active.length + g.wfRunning.length, 0)
  const failedN = groups.reduce((n, g) => n + g.failed.length, 0)
  const label =
    groups.length === 0
      ? 'no activity'
      : [running > 0 ? `${running} running` : '', failedN > 0 ? `${failedN} failed` : '']
          .filter(Boolean)
          .join(' · ') || 'idle'
  // Open-session priority: the session you're viewing gets the FULL ledger at the
  // top; every other session collapses to a compact rollup chip (⚙ running / ⚠
  // failed), clicking which switches to it. So detail follows your attention.
  type Group = (typeof groups)[number]
  const activeGroup = groups.find((g) => g.session.sessionId === activeSessionId) ?? null
  const others = groups.filter((g) => g.session.sessionId !== activeSessionId)

  const renderGroup = (g: Group): React.ReactElement => (
    <div className="fleet-group" key={g.session.sessionId}>
      <button className="fleet-owner" onClick={() => onOpen(g.session)}>
        {g.session.name ?? `pid ${g.session.pid}`}
        {g.active.length + g.wfRunning.length > 0 && (
          <span className="fleet-owner-n">{g.active.length + g.wfRunning.length}</span>
        )}
      </button>
      {g.wfRunning.map((w) => (
        <div className="fleet-sub sub-running" key={w.runId}>
          <span className="fleet-dot fs-running" />
          <span className="fleet-desc">{w.description || w.name}</span>
          <span className="fleet-wf-prog">
            {w.agentDone}/{w.agentTotal}
          </span>
          <span className="fleet-bg">wf</span>
        </div>
      ))}
      {[...g.active, ...g.failed].map((t) => (
        <div className={`fleet-sub sub-${t.status}`} key={t.id}>
          <span className={`fleet-dot fs-${t.status}`} />
          <span className="fleet-desc">{t.description}</span>
          {t.source === 'workflow' && <span className="fleet-bg">wf</span>}
          {t.source === 'shell' && <span className="fleet-bg">sh</span>}
          {t.source === 'task' && t.background && <span className="fleet-bg">bg</span>}
        </div>
      ))}
      {g.doneCount > 0 && (
        <div className="fleet-donerow">
          {g.doneCount} done
          {g.active.length === 0 && g.failed.length === 0 && g.wfRunning.length === 0 ? ' · idle' : ''}
        </div>
      )}
    </div>
  )

  const renderRollup = (g: Group): React.ReactElement => (
    <button className="fleet-rollup" key={g.session.sessionId} onClick={() => onOpen(g.session)}>
      <span className="fleet-rollup-name">{g.session.name ?? `pid ${g.session.pid}`}</span>
      <span className="grow" />
      {g.active.length + g.wfRunning.length > 0 && (
        <span className="fleet-rollup-run">⚙ {g.active.length + g.wfRunning.length}</span>
      )}
      {g.failed.length > 0 && <span className="fleet-rollup-fail">⚠ {g.failed.length}</span>}
      {g.active.length + g.wfRunning.length === 0 && g.failed.length === 0 && (
        <span className="fleet-rollup-idle">{g.doneCount} done</span>
      )}
    </button>
  )

  return (
    <div className={`fleet${open ? ' open' : ''}`}>
      <button className="fleet-head" onClick={toggle} title="Background activity across the fleet — agents, shell tasks, and workflows">
        <span className="chev">{open ? '▾' : '▸'}</span>
        <span className="fleet-name">activity</span>
        <span className="fleet-count">{label}</span>
      </button>
      {open && (
        <div className="fleet-body">
          {groups.length === 0 ? (
            <div className="fleet-empty">No session has background activity.</div>
          ) : (
            <>
              {activeGroup && renderGroup(activeGroup)}
              {others.length > 0 && (
                <div className="fleet-rollups">
                  {activeGroup && <div className="fleet-rollups-label">other sessions</div>}
                  {others.map(renderRollup)}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// Artifact preview drawer (spec D): folds DOWN over the terminal for the OPEN
// session. Left = the selected artifact rendered inline (images/SVG via a
// script-inert <img>, text/markdown as text); right = the session's artifact
// list. HTML/PDF are never rendered in-app — they open in the real browser /
// default app. Hidden entirely when the session produced nothing previewable.
const artExt = (name: string): string => (name.includes('.') ? name.split('.').pop() ?? '' : '')

// Short relative age for an artifact's mtime — "just now", "5m ago", "3h ago",
// "2d ago", then an absolute short date past a week. Full timestamp on hover.
const fmtArtTime = (ms: number): string => {
  const d = Date.now() - ms
  if (d < 0) return 'just now'
  if (d < 60_000) return 'just now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`
  const days = Math.floor(d / 86_400_000)
  if (days < 7) return `${days}d ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// m:ss for the audio player's time readout.
const fmtDur = (s: number): string => {
  if (!isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const ss = Math.floor(s % 60)
  return `${m}:${ss.toString().padStart(2, '0')}`
}

// A themed audio player — the native <audio> control renders as a stark light
// pill that clashes with the app. This is a minimal custom transport (play/pause,
// click-to-seek, time) styled with the app's palette. The <audio> element is
// hidden and driven programmatically.
function AudioPlayer({ src }: { src: string }): React.ReactElement {
  const ref = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)
  const toggle = (): void => {
    const el = ref.current
    if (!el) return
    if (el.paused) el.play().catch(() => {}) // decode failure just no-ops the button
    else el.pause()
  }
  // Only seek when we have a finite duration — some formats report Infinity (or
  // NaN before metadata), and assigning a non-finite currentTime throws.
  const seek = (e: React.MouseEvent<HTMLDivElement>): void => {
    const el = ref.current
    if (!el || !dur) return
    const r = e.currentTarget.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const t = frac * dur
    if (Number.isFinite(t)) el.currentTime = t
  }
  const setDuration = (d: number): void => setDur(Number.isFinite(d) && d > 0 ? d : 0)
  const pct = dur ? (cur / dur) * 100 : 0
  return (
    <div className="aplayer-wrap">
      <div className="aplayer">
      <audio
        ref={ref}
        src={src}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onEnded={() => setPlaying(false)}
      />
      <button className="aplayer-btn" onClick={toggle} title={playing ? 'Pause' : 'Play'}>
        {playing ? '❚❚' : '▶'}
      </button>
      <div className="aplayer-bar" onClick={seek}>
        <div className="aplayer-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="aplayer-time">
        {fmtDur(cur)} / {fmtDur(dur)}
      </span>
      </div>
    </div>
  )
}

function ArtifactPreview({
  art,
}: {
  art: { path: string; name: string; kind: string }
}): React.ReactElement {
  const [state, setState] = useState<{
    loading: boolean
    dataUrl?: string
    text?: string
    tooBig?: boolean
    failed?: boolean
  }>({ loading: true })
  // Markdown previews toggle between the rendered view (default) and raw source.
  const [mdMode, setMdMode] = useState<'rendered' | 'raw'>('rendered')
  useEffect(() => {
    let cancelled = false
    setState({ loading: true })
    window.cc.artifactRead(art.path).then((r) => {
      if (cancelled) return
      setState(
        r.ok
          ? { loading: false, dataUrl: r.dataUrl, text: r.text, tooBig: r.tooBig }
          : { loading: false, failed: true },
      )
    })
    return () => {
      cancelled = true
    }
  }, [art.path])

  if (state.loading) return <div className="artdrawer-msg">loading…</div>
  if (state.dataUrl)
    return art.kind === 'audio' ? (
      <AudioPlayer src={state.dataUrl} />
    ) : (
      <img className="artdrawer-img" src={state.dataUrl} alt={art.name} />
    )
  if (state.text != null) {
    if (art.kind === 'markdown') {
      // renderMarkdown returns null if marked throws (deeply nested input); fall
      // back to the raw source rather than crashing or showing an empty pane.
      const mdHtml = mdMode === 'rendered' ? renderMarkdown(state.text) : null
      return (
        <div className="artdrawer-md">
          <div className="artdrawer-md-bar">
            <button
              className={`artdrawer-md-btn${mdMode === 'rendered' ? ' on' : ''}`}
              onClick={() => setMdMode('rendered')}
            >
              rendered
            </button>
            <button
              className={`artdrawer-md-btn${mdMode === 'raw' ? ' on' : ''}`}
              onClick={() => setMdMode('raw')}
            >
              raw
            </button>
          </div>
          {mdHtml != null ? (
            <div className="artdrawer-rich" dangerouslySetInnerHTML={{ __html: mdHtml }} />
          ) : (
            <pre className="artdrawer-text">{state.text || '(empty file)'}</pre>
          )}
        </div>
      )
    }
    if (art.kind === 'rtf') {
      const html = rtfToHtml(state.text)
      if (html) return <div className="artdrawer-rich" dangerouslySetInnerHTML={{ __html: html }} />
      return (
        <OpenCard name={art.name} path={art.path} why="Couldn’t render this RTF — open it instead." />
      )
    }
    if (art.kind === 'code' && state.text) {
      const html = highlightCode(state.text, art.name)
      if (html != null)
        return (
          <pre className="artdrawer-text hljs">
            <code dangerouslySetInnerHTML={{ __html: html }} />
          </pre>
        )
    }
    return <pre className="artdrawer-text">{state.text || '(empty file)'}</pre>
  }
  const why = state.tooBig
    ? 'Too large to preview inline.'
    : art.kind === 'html'
      ? 'Opens in your browser.'
      : art.kind === 'pdf'
        ? 'PDF — open to view it.'
        : art.kind === 'office'
          ? 'Opens in your default app.'
          : state.failed
            ? 'Could not read this file.'
            : 'No inline preview for this type.'
  return <OpenCard name={art.name} path={art.path} why={why} />
}

// Centered "open externally" card — for pdf/office/html, too-large files, and RTF
// we couldn't render. Leads with the filename, then the reason, then Open.
function OpenCard({
  name,
  path,
  why,
}: {
  name: string
  path: string
  why: string
}): React.ReactElement {
  return (
    <div className="artdrawer-msg">
      <div className="artdrawer-card">
        <div className="artdrawer-card-name" title={path}>
          {name}
        </div>
        <div className="artdrawer-card-text">{why}</div>
        <button className="artdrawer-card-btn" onClick={() => window.cc.artifactOpen(path)}>
          Open
        </button>
      </div>
    </div>
  )
}

// Isolates a preview render failure so a single bad artifact can never blank-screen
// the whole app. Keyed by artifact path in the drawer, so it remounts fresh (state
// reset) when you switch artifacts. A caught throw shows a message + Open fallback.
class PreviewBoundary extends Component<
  { onOpen: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  render(): ReactNode {
    if (this.state.failed)
      return (
        <div className="artdrawer-msg">
          <div className="artdrawer-card">
            <div className="artdrawer-card-text">Couldn’t preview this file.</div>
            <button className="artdrawer-card-btn" onClick={this.props.onOpen}>
              Open
            </button>
          </div>
        </div>
      )
    return this.props.children
  }
}

function ArtifactDrawer({ session }: { session: Session | null }): React.ReactElement | null {
  const [open, setOpen] = useState(false)
  // Sort the list by most-recent (default) or by name. Persisted so a long-running
  // session keeps the ordering you chose across restarts.
  const [sortBy, setSortBy] = useState<'recent' | 'name'>('recent')
  useEffect(() => {
    window.cc.stateGet('artifactsOpen').then((v) => v === 'true' && setOpen(true))
    window.cc.stateGet('artifactsSort').then((v) => (v === 'name' || v === 'recent') && setSortBy(v))
  }, [])
  const [selPath, setSelPath] = useState<string | null>(null)
  const arts = session?.artifacts ?? []
  if (arts.length === 0) return null
  const sorted = [...arts].sort((a, b) =>
    sortBy === 'name' ? a.name.localeCompare(b.name) : b.mtimeMs - a.mtimeMs,
  )
  const sel = sorted.find((a) => a.path === selPath) ?? sorted[0]
  const toggle = (): void => {
    const n = !open
    setOpen(n)
    window.cc.stateSet('artifactsOpen', String(n))
  }
  const setSort = (v: 'recent' | 'name'): void => {
    setSortBy(v)
    window.cc.stateSet('artifactsSort', v)
  }
  return (
    <div className={`artdrawer${open ? ' open' : ''}`}>
      <button className="artdrawer-handle" onClick={toggle} title="Artifacts this session produced">
        <span className="chev">{open ? '▾' : '▸'}</span>
        <span className="artdrawer-htitle">artifacts</span>
        <span className="artdrawer-count">{arts.length}</span>
      </button>
      {open && (
        <>
          <div className="artdrawer-body">
            <div className="artdrawer-preview">
              <PreviewBoundary key={sel.path} onOpen={() => window.cc.artifactOpen(sel.path)}>
                <ArtifactPreview art={sel} />
              </PreviewBoundary>
            </div>
            <div className="artdrawer-list">
              <div className="artdrawer-sort">
                <span className="artdrawer-sort-lbl">sort</span>
                <button
                  className={`artdrawer-sort-btn${sortBy === 'recent' ? ' on' : ''}`}
                  onClick={() => setSort('recent')}
                >
                  recent
                </button>
                <button
                  className={`artdrawer-sort-btn${sortBy === 'name' ? ' on' : ''}`}
                  onClick={() => setSort('name')}
                >
                  name
                </button>
              </div>
              {sorted.map((a) => (
                <div className={`artdrawer-item${a.path === sel.path ? ' sel' : ''}`} key={a.path}>
                  <button className="artdrawer-item-main" onClick={() => setSelPath(a.path)}>
                    <span className="artifact-kind">{artExt(a.name) || a.kind}</span>
                    <span className="artdrawer-item-body">
                      <span className="artdrawer-item-name" title={a.path}>
                        {a.name}
                      </span>
                      <span
                        className="artdrawer-item-time"
                        title={new Date(a.mtimeMs).toLocaleString()}
                      >
                        {fmtArtTime(a.mtimeMs)}
                      </span>
                    </span>
                  </button>
                  <button
                    className="artifact-btn"
                    title="Reveal in Finder"
                    onClick={() => window.cc.artifactReveal(a.path)}
                  >
                    ⤴
                  </button>
                </div>
              ))}
            </div>
          </div>
          <button className="artdrawer-close" onClick={toggle} title="Close the drawer">
            <span className="chev">▲</span> close drawer
          </button>
        </>
      )}
    </div>
  )
}

function ArbiterConsole({
  panel,
  enabled,
  paused,
  capUsd,
}: {
  panel: ArbiterPanel | undefined
  enabled: boolean
  paused: boolean
  capUsd: number
}): React.ReactElement | null {
  const [open, setOpen] = useState(false)
  const [poking, setPoking] = useState(false)
  if (!panel) return null
  const { status, spend, log } = panel
  const today = `$${spend.todayUsd.toFixed(spend.todayUsd < 1 ? 4 : 2)}`
  const capped = status === 'capped'
  const poke = async () => {
    setPoking(true)
    try {
      await window.cc.arbiterPoke()
    } finally {
      setPoking(false)
    }
  }
  return (
    <div className={`arb${open ? ' open' : ''}`}>
      <button className="arb-head" onClick={() => setOpen(!open)} title="Arbiter">
        <span className={`arb-dot arb-${status}`} />
        <span className="arb-name">Arbiter</span>
        <span className="arb-status">
          {!enabled
            ? 'off'
            : paused
              ? 'paused'
              : capped
                ? 'capped'
                : status === 'running'
                  ? 'reading…'
                  : status === 'error'
                    ? 'error'
                    : 'idle'}
        </span>
        {/* Spend is always visible, on or off — it is the number that must never surprise. */}
        <span className={`arb-spend${capped ? ' over' : ''}`} title={`${spend.calls} calls`}>
          {today}
          {capUsd > 0 ? ` / $${capUsd.toFixed(2)}` : ''}
        </span>
      </button>
      {open && (
        <div className="arb-body">
          {enabled ? (
            <div className="arb-btns">
              {/* Pause is an operator control, not configuration: it stops spend
                  now and keeps the key, the cap, and the glosses already paid
                  for. Disabling lives in Settings. */}
              <button
                className={`arb-poke${paused ? ' on' : ''}`}
                onClick={() => window.cc.arbiterSetPaused(!paused)}
                title={paused ? 'Resume — starts spending again' : 'Pause — stops spending, keeps setup'}
              >
                {paused ? 'Resume' : 'Pause'}
              </button>
              <button
                className="arb-poke"
                onClick={poke}
                disabled={poking || status === 'running' || paused}
              >
                {poking || status === 'running' ? 'reading…' : 'Read now'}
              </button>
            </div>
          ) : (
            <div className="arb-note">Enable in Settings, with an API key and a daily cap.</div>
          )}
          <div className="arb-log">
            {log.length === 0 ? (
              <div className="arb-note">nothing yet</div>
            ) : (
              log.map((l) => (
                <div key={l.id} className={`arb-line arb-${l.kind}`}>
                  <span className="arb-t">
                    {new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="arb-txt">{l.text}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const CONTEXT_OPTS = [
  { v: '', label: 'Default' },
  { v: '1m', label: '1M' },
]
// Claude Code selects the 1M-context variant of a model with a `[1m]` suffix on
// the model string (`--model opus[1m]`). It only attaches to a model that has a
// 1M variant — Haiku doesn't, and "Default" gives us no model string to suffix.
function supports1m(model: string, customModel: string): boolean {
  if (model === '__custom__') return customModel.trim() !== ''
  return model !== '' && model !== 'haiku'
}
function withContext(model: string, ctx: string): string {
  if (!model || ctx !== '1m') return model
  return model.replace(/(\[1m\])+$/i, '') + '[1m]'
}

// `--effort ultracode` needs a model that supports xhigh. Haiku doesn't, and the
// CLI accepts the flag silently in that case — no warning, no effect — so the
// option is hidden rather than left to fail quietly. "Default" and "Custom…"
// can't be resolved to a concrete model here, so they stay permissive.
function supportsUltracode(model: string, customModel: string): boolean {
  if (model === '__custom__') return customModel.trim() !== ''
  return model !== 'haiku'
}

// Permission mode at launch (--permission-mode). '' emits no flag, leaving the
// CLI to use permissions.defaultMode from the user's settings; 'manual' actively
// forces ask-every-time, overriding it. ('manual' is the supported spelling —
// the CLI maps it to 'default' internally.)
const MODE_OPTS = [
  { v: '', label: 'Default' },
  { v: 'plan', label: 'Plan' },
  { v: 'acceptEdits', label: 'Accept edits' },
  { v: 'auto', label: 'Auto' },
  { v: 'dontAsk', label: "Don't ask" },
  { v: 'manual', label: 'Manual (ask every time)' },
  { v: 'bypassPermissions', label: 'Bypass all (danger)' },
]
// Bypass is deliberately never remembered: left selected, it would silently
// launch every later session with all permission checks off.
const stickyMode = (m: string): string => (m === 'bypassPermissions' ? '' : m)

// Derived launch-parameter rules, shared so the composer and the resume modal
// apply identical gating. effortVal is the re-application of the ultracode gate:
// a model that can't do xhigh must never emit --effort ultracode, which the CLI
// accepts and silently ignores.
function launchDerived(
  model: string,
  customModel: string,
  effort: string,
): { ctxOk: boolean; ultraOk: boolean; effortVal: string } {
  const ctxOk = supports1m(model, customModel)
  const ultraOk = supportsUltracode(model, customModel)
  return { ctxOk, ultraOk, effortVal: effort === 'ultracode' && !ultraOk ? 'xhigh' : effort }
}

// The four launch-parameter pickers. Used by the New-session composer AND by the
// resume-parameters modal, so the two can't drift apart.
function LaunchParams({
  model,
  setModel,
  customModel,
  setCustomModel,
  effort,
  setEffort,
  ctx,
  setCtx,
  mode,
  setMode,
}: {
  model: string
  setModel: (v: string) => void
  customModel: string
  setCustomModel: (v: string) => void
  effort: string
  setEffort: (v: string) => void
  ctx: string
  setCtx: (v: string) => void
  mode: string
  setMode: (v: string) => void
}): React.ReactElement {
  const { ctxOk, ultraOk, effortVal } = launchDerived(model, customModel, effort)
  return (
    <>
          <div className="nsrow">
            <div className="nscol">
              <div className="spawnlabel">Model</div>
              <select className="cat-in" value={model} onChange={(e) => setModel(e.target.value)}>
                {MODEL_OPTS.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="nscol">
              <div className="spawnlabel">Effort</div>
              <select
                className="cat-in"
                value={effortVal}
                title={
                  ultraOk
                    ? 'ultracode = xhigh effort plus standing workflow orchestration (needs workflows enabled)'
                    : 'reasoning effort — ultracode needs a model that supports xhigh'
                }
                onChange={(e) => setEffort(e.target.value)}
              >
                {EFFORT_OPTS.filter((o) => !o.ultra || ultraOk).map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="nsrow">
            <div className="nscol">
              <div className="spawnlabel">Context</div>
              <select
                className="cat-in"
                value={ctxOk ? ctx : ''}
                disabled={!ctxOk}
                title={ctxOk ? '1M adds the [1m] suffix to the model' : 'pick a model that has a 1M variant'}
                onChange={(e) => setCtx(e.target.value)}
              >
                {CONTEXT_OPTS.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="nscol">
              <div className="spawnlabel">Mode</div>
              <select
                className="cat-in"
                value={mode}
                title="Permission mode at launch. Default follows your settings; Plan works out an approach before touching anything."
                onChange={(e) => setMode(e.target.value)}
              >
                {MODE_OPTS.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {model === '__custom__' && (
            <input
              className="cat-in"
              value={customModel}
              placeholder="model id, e.g. claude-opus-4-8"
              onChange={(e) => setCustomModel(e.target.value)}
            />
          )}
    </>
  )
}

// "Set the starting parameters for this session" — shown before a session that
// has no remembered flags is resumed. It exists because `claude --resume` starts
// the session at the CLI defaults regardless of how it was originally launched,
// so without this the model/effort/mode silently change under you on every resume.
// Cancel aborts the open entirely; resuming with defaults would make the modal
// cosmetic, which is the outcome this whole feature exists to prevent.
function ResumeParamsComposer({
  session,
  settings,
  edit,
  onCancel,
  onConfirm,
}: {
  session: Session
  settings?: AppSettings
  // Edit mode = opened from the context menu to change the remembered flags. The
  // intent is unambiguously "save these", so there's no checkbox and no resume —
  // it just stores them and closes. Resume mode = the gate shown before a
  // non-sticky session resumes, where remembering is the user's choice.
  edit?: boolean
  onCancel: () => void
  onConfirm: (flags: ResumeFlags, remember: boolean) => void
}): React.ReactElement {
  // Prefill from what the session already remembers; failing that, the app-global
  // last-used choices, so an adopted or pre-existing session isn't a blank form.
  const seed = session.resumeFlags
  const seedModel = seed?.model ?? settings?.lastModel ?? ''
  const known = MODEL_OPTS.some((o) => o.v === seedModel)
  const [model, setModel] = useState(known ? seedModel : seedModel ? '__custom__' : '')
  const [customModel, setCustomModel] = useState(known ? '' : seedModel)
  const [effort, setEffort] = useState(seed?.effort ?? settings?.lastEffort ?? '')
  const [ctx, setCtx] = useState(seed?.context ?? settings?.lastContext ?? '')
  const [mode, setMode] = useState(seed?.mode ?? settings?.lastMode ?? '')
  const [remember, setRemember] = useState(false)
  const { ctxOk, effortVal } = launchDerived(model, customModel, effort)
  const confirm = (): void => {
    const baseModel = model === '__custom__' ? customModel.trim() : model
    onConfirm(
      {
        model: baseModel,
        context: ctxOk ? ctx : '',
        effort: effortVal,
        mode: stickyMode(mode),
      },
      edit ? true : remember, // editing from the menu always saves
    )
  }
  const who = session.name ?? session.sessionId.slice(0, 8)
  return (
    <div className="spawnscrim" onClick={onCancel}>
      <div className="spawnmodal" onClick={(e) => e.stopPropagation()}>
        <div className="spawntitle">
          {edit ? 'Launch settings' : 'Set the starting parameters for this session'}
        </div>
        <div className="spawnsub">
          {edit ? (
            <>
              <b>{who}</b> — applied each time this session resumes.
            </>
          ) : (
            <>
              <b>{who}</b> — resuming starts it at the CLI defaults unless these are set.
            </>
          )}
        </div>

        <LaunchParams
          model={model}
          setModel={setModel}
          customModel={customModel}
          setCustomModel={setCustomModel}
          effort={effort}
          setEffort={setEffort}
          ctx={ctx}
          setCtx={setCtx}
          mode={mode}
          setMode={setMode}
        />

        {/* No checkbox in edit mode: choosing "Launch settings…" already means save. */}
        {!edit && (
          <label className="setrow nsremember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>
              <b>Remember these settings when resuming in the future</b>
              <span className="setsub">This session will resume with them without asking again.</span>
            </span>
          </label>
        )}

        <div className="spawnactions">
          <button className="rbtn" onClick={onCancel}>
            Cancel
          </button>
          <button className="rbtn primary" onClick={confirm}>
            {edit ? 'Save' : 'Resume'}
          </button>
        </div>
      </div>
    </div>
  )
}

function NewSessionComposer({
  categories,
  defaultCat,
  home,
  recent,
  lastModel,
  lastEffort,
  lastContext,
  lastMode,
  lastResumeSticky,
  apiKeys,
  close,
}: {
  categories: Category[]
  defaultCat: number | null
  home: string
  recent: string[]
  lastModel: string
  lastEffort: string
  lastContext: string
  lastMode: string
  lastResumeSticky: boolean
  apiKeys: ApiKey[]
  close: () => void
}) {
  const [name, setName] = useState('')
  const [cat, setCat] = useState<number | null>(defaultCat)
  const [cwd, setCwd] = useState('')
  const [flags, setFlags] = useState('')
  const [instructions, setInstructions] = useState('')
  const [apiKeyId, setApiKeyId] = useState<number | undefined>(undefined)
  // Remember the last model/effort. A custom id restores as the "Custom…" choice.
  const knownModel = MODEL_OPTS.some((o) => o.v === lastModel)
  const [model, setModel] = useState(knownModel ? lastModel : lastModel ? '__custom__' : '')
  const [customModel, setCustomModel] = useState(knownModel ? '' : lastModel)
  const [effort, setEffort] = useState(lastEffort)
  const [ctx, setCtx] = useState(lastContext)
  const [mode, setMode] = useState(lastMode)
  // Re-applied here, not just in the dropdown, so switching to a model that can't
  // do ultracode never leaks a flag the CLI would silently ignore.
  const { ctxOk, effortVal } = launchDerived(model, customModel, effort)
  const [remember, setRemember] = useState(lastResumeSticky)
  const pick = async () => {
    const p = await window.cc.pickFolder()
    if (p) setCwd(p)
  }
  const create = () => {
    if (!cwd) return
    const baseModel = model === '__custom__' ? customModel.trim() : model
    const chosenModel = ctxOk ? withContext(baseModel, ctx) : baseModel
    // Prepend --model / --effort / --permission-mode to whatever the user typed
    // in Flags. Anything they type there lands last and therefore wins.
    const allFlags = [
      chosenModel && `--model ${chosenModel}`,
      effortVal && `--effort ${effortVal}`,
      mode && `--permission-mode ${mode}`,
      flags.trim(),
    ]
      .filter(Boolean)
      .join(' ')
    // Remember the bare model; the context choice is remembered separately so
    // the two restore independently. effortVal (not effort) so a stale
    // 'ultracode' can't be remembered against a model that rejects it.
    window.cc.settingsSet('lastModel', baseModel)
    window.cc.settingsSet('lastEffort', effortVal)
    window.cc.settingsSet('lastContext', ctx)
    window.cc.settingsSet('lastMode', stickyMode(mode))
    window.cc.settingsSet('lastResumeSticky', String(remember))
    window.cc.sessionCreate({
      cwd,
      flags: allFlags || undefined,
      categoryId: cat,
      name: name.trim() || undefined,
      instructions: instructions.trim() || undefined,
      apiKeyId,
      // The four structured fields only — never `flags`, which is arbitrary text.
      resumeFlags: {
        model: baseModel,
        context: ctxOk ? ctx : '',
        effort: effortVal,
        mode: stickyMode(mode),
      },
      resumeSticky: remember,
    })
    close()
  }
  const shortCwd = home && cwd.startsWith(home) ? cwd.replace(home, '~') : cwd
  return (
    <div className="spawnscrim" onClick={close}>
      {/* Wider, two-column layout: this form has many more fields than the other
          modals, and one-per-row made it taller than short viewports. Pairing the
          short fields keeps everything on one page without scrolling. */}
      <div className="spawnmodal nswide" onClick={(e) => e.stopPropagation()}>
        <div className="spawntitle">New session</div>
        <div className="spawnsub">launches a managed Claude session and adopts it here.</div>

        <div className="nssplit">
          {/* LEFT: what & where. */}
          <div className="nscol">
            <div className="spawnlabel">
              Name <span className="spawnopt">optional</span>
            </div>
            <input
              className="cat-in"
              autoFocus
              value={name}
              placeholder="e.g. schema-fix"
              onChange={(e) => setName(e.target.value)}
            />

            <div className="spawnlabel">Category</div>
            <select
              className="cat-in"
              value={cat ?? ''}
              onChange={(e) => setCat(e.target.value === '' ? null : Number(e.target.value))}
            >
              <option value="">Uncategorized</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>

            <div className="spawnlabel">Folder</div>
            <div className="spawnfolder">
              <span className="spawncwd" title={cwd}>
                {cwd ? shortCwd : 'choose a folder…'}
              </span>
              <button className="rbtn" onClick={pick}>
                Choose…
              </button>
            </div>
            {recent.length > 0 && (
              <>
                <div className="spawnlabel">
                  Recent <span className="spawnopt">click to reuse</span>
                </div>
                <div className="recentfolders">
                  {recent.map((f) => (
                    <button key={f} className="recentfolder" title={f} onClick={() => setCwd(f)}>
                      {home && f.startsWith(home) ? f.replace(home, '~') : f}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* RIGHT: how it runs. */}
          <div className="nscol">
            <LaunchParams
              model={model}
              setModel={setModel}
              customModel={customModel}
              setCustomModel={setCustomModel}
              effort={effort}
              setEffort={setEffort}
              ctx={ctx}
              setCtx={setCtx}
              mode={mode}
              setMode={setMode}
            />

            <div className="spawnlabel">
              Flags <span className="spawnopt">optional extra CLI args</span>
            </div>
            <input
              className="cat-in"
              value={flags}
              placeholder="e.g. --add-dir ../shared"
              onChange={(e) => setFlags(e.target.value)}
            />

            <label className="setrow nsremember">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span>
                <b>Always use these flags on resume</b>
                <span className="setsub">
                  <code>claude --resume</code> won&rsquo;t carry them; otherwise you&rsquo;re asked
                  each time.
                </span>
              </span>
            </label>

            <ApiKeyPicker apiKeys={apiKeys} value={apiKeyId} onChange={setApiKeyId} />
          </div>
        </div>

        <div className="spawnlabel">
          Initial instructions <span className="spawnopt">optional — sent as the first message</span>
        </div>
        <textarea
          className="spawnnote"
          value={instructions}
          placeholder="What should it start on?"
          onChange={(e) => setInstructions(e.target.value)}
        />

        <div className="spawnactions">
          <button className="rbtn" onClick={close}>
            Cancel
          </button>
          <button className="rbtn primary" onClick={create} disabled={!cwd}>
            Create session
          </button>
        </div>
      </div>
    </div>
  )
}

function MessageLog({
  messages,
  paused,
  close,
}: {
  messages: MsgLogEntry[]
  paused: boolean
  close: () => void
}) {
  const cls = (status: string) =>
    status.startsWith('delivered') ? 'ok' : status.startsWith('held') ? 'held' : 'drop'
  return (
    <div className="spawnscrim" onClick={close}>
      <div className="spawnmodal msglog" onClick={(e) => e.stopPropagation()}>
        <div className="msgloghead">
          <div>
            <div className="spawntitle">Cross-session messages</div>
            <div className="spawnsub">
              every message the awareness bus routed — delivered, held (untrusted link), or dropped.
            </div>
          </div>
          <button
            className={`killswitch${paused ? ' on' : ''}`}
            onClick={() => window.cc.awarenessPause(!paused)}
            title={
              paused
                ? 'Autonomous messaging is paused — click to resume'
                : 'Pause all autonomous messaging (messages are buffered, not lost)'
            }
          >
            {paused ? '▶ Resume messaging' : '⏸ Pause messaging'}
          </button>
        </div>
        {paused && (
          <div className="pausednote">
            Paused — new messages are buffered and held; nothing is delivered until you resume.
          </div>
        )}
        <div className="msglist">
          {messages.length === 0 && <div className="emptycat">no messages yet</div>}
          {[...messages].reverse().map((m, i) => (
            <div key={i} className="msgrow">
              <div className="msgmeta">
                <span className="msgroute">
                  {m.from} → {m.to}
                </span>
                <span className={`msgstatus s-${cls(m.status)}`}>{m.status}</span>
              </div>
              <div className="msgtext">{m.text}</div>
            </div>
          ))}
        </div>
        <div className="spawnactions">
          <button className="rbtn" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function SendComposer({
  origin,
  managed,
  setSend,
}: {
  origin: Session
  managed: Session[]
  setSend: (v: Session | null) => void
}) {
  const [text, setText] = useState('')
  const [targets, setTargets] = useState<Set<string>>(new Set([origin.sessionId]))
  const [status, setStatus] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const close = () => setSend(null)
  const toggle = (sid: string) =>
    setTargets((prev) => {
      const n = new Set(prev)
      if (n.has(sid)) n.delete(sid)
      else n.add(sid)
      return n
    })
  const doSend = async () => {
    if (!text.trim() || targets.size === 0 || sending) return
    setSending(true)
    const results = await Promise.all(
      [...targets].map((sid) => window.cc.sessionSend(sid, text.trim())),
    )
    setSending(false)
    const ok = results.filter((r) => r.ok).length
    const fail = results.length - ok
    setStatus(`✓ sent to ${ok}${fail ? ` · ${fail} failed` : ''}`)
    if (fail === 0) {
      setText('')
      setTimeout(close, 1000)
    }
  }
  // origin first, then the other managed sessions you could also fan out to
  const list = [origin, ...managed.filter((m) => m.sessionId !== origin.sessionId)]
  return (
    <div className="spawnscrim" onClick={close}>
      <div className="spawnmodal" onClick={(e) => e.stopPropagation()}>
        <div className="spawntitle">Send a prompt</div>
        <div className="spawnsub">
          injects into the selected session(s) as if typed — runs on each one's next turn. ⌘↩ to
          send.
        </div>
        <textarea
          className="spawnnote"
          autoFocus
          value={text}
          placeholder="Prompt to send…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doSend()
            if (e.key === 'Escape') close()
          }}
        />
        <div className="spawnlabel">
          Targets <span className="spawnopt">check multiple to broadcast</span>
        </div>
        <div className="send-targets">
          {list.map((s) => (
            <label key={s.sessionId} className="send-target">
              <input
                type="checkbox"
                checked={targets.has(s.sessionId)}
                onChange={() => toggle(s.sessionId)}
              />
              <span className={`cc-dot cc-dot--${s.state}`} />
              <span className="st-name">{s.name ?? `pid ${s.pid}`}</span>
            </label>
          ))}
        </div>
        <div className="spawnactions">
          {status && <span className="send-ok">{status}</span>}
          <button className="rbtn" onClick={close}>
            Cancel
          </button>
          <button
            className="rbtn primary"
            onClick={doSend}
            disabled={sending || !text.trim() || targets.size === 0}
          >
            {sending ? 'Sending…' : targets.size > 1 ? `Broadcast (${targets.size})` : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

function CategoryEditor({
  edit,
  setEdit,
  onCreated,
}: {
  edit: {
    id: number | null // null → create mode
    name: string
    color: string
    label: string | null
    emoji: string | null
    count: number
    arbiterContext: number
    // Per-class notification overrides; null = inherit the global switch.
    notify: { permission: number | null; question: number | null; done: number | null }
    x: number
    y: number
  }
  setEdit: (v: null) => void
  onCreated?: (id: number) => void
}) {
  const isCreate = edit.id === null
  const [name, setName] = useState(edit.name)
  const [tag, setTag] = useState(edit.label ?? '')
  const [emoji, setEmoji] = useState(edit.emoji ?? '')
  const [color, setColor] = useState(edit.color)
  // Deleting a category used to fire on a single click, silently. It's a
  // container holding sessions, so it asks first and says where they go.
  const [confirmDel, setConfirmDel] = useState(false)
  const [arbCtx, setArbCtx] = useState(edit.arbiterContext === 1)
  // Notification overrides, tri-state per class: inherit (null) / on / off. Saved
  // live like the other category fields — no Save click.
  const [notify, setNotify] = useState(edit.notify)
  const setNotifyCls = (cls: 'permission' | 'question' | 'done', v: boolean | null): void => {
    setNotify((n) => ({ ...n, [cls]: v === null ? null : v ? 1 : 0 }))
    if (edit.id !== null) window.cc.catSetNotify(edit.id, cls, v)
  }
  const close = () => setEdit(null)
  const save = async () => {
    const nm = name.trim()
    const label = tag.trim().slice(0, 8) || null
    // Keep only the first grapheme (a single emoji can span several code points —
    // variation selectors, ZWJ sequences); empty clears it.
    const g = emoji.trim()
    const firstGrapheme = g ? [...new Intl.Segmenter().segment(g)][0]?.segment ?? null : null
    if (edit.id === null) {
      if (!nm) return close() // no name → nothing to create
      const c = await window.cc.catCreate(nm)
      if (c?.id != null) {
        await window.cc.catSetLabel(c.id, label)
        await window.cc.catSetEmoji(c.id, firstGrapheme)
        if (color) await window.cc.catSetColor(c.id, color) // else keep the auto-assigned color
        onCreated?.(c.id)
      }
    } else {
      if (nm && nm !== edit.name) window.cc.catRename(edit.id, nm)
      window.cc.catSetLabel(edit.id, label)
      window.cc.catSetEmoji(edit.id, firstGrapheme)
      if (color && color !== edit.color) window.cc.catSetColor(edit.id, color)
    }
    close()
  }
  // Existing categories save every field the instant you change it (like the
  // Arbiter opt-in below) — a color/emoji pick takes effect immediately, no Save
  // click. A brand-new category still commits via Create (nothing to write until
  // it exists). save() stays as a harmless final commit + close.
  const existing = edit.id !== null
  const pickColor = (col: string): void => {
    setColor(col)
    if (existing) window.cc.catSetColor(edit.id as number, col)
  }
  const pickEmoji = (raw: string): void => {
    setEmoji(raw)
    if (existing) {
      const g = raw.trim()
      const first = g ? [...new Intl.Segmenter().segment(g)][0]?.segment ?? null : null
      window.cc.catSetEmoji(edit.id as number, first)
    }
  }
  const commitName = (): void => {
    const nm = name.trim()
    if (existing && nm && nm !== edit.name) window.cc.catRename(edit.id as number, nm)
  }
  const commitLabel = (): void => {
    if (existing) window.cc.catSetLabel(edit.id as number, tag.trim().slice(0, 8) || null)
  }
  return (
    <>
      <div
        className="menuscrim"
        onClick={close}
        onContextMenu={(e) => {
          e.preventDefault()
          close()
        }}
      />
      <div className="menu cateditor" style={{ left: edit.x, top: edit.y }}>
        <div className="menuhead">{isCreate ? 'New category' : 'Category'}</div>
        <input
          className="cat-in"
          autoFocus
          value={name}
          placeholder="Name"
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') close()
          }}
        />
        <div className="cat-idrow">
          <div className="cat-in cat-emoji-in cat-emoji-display" aria-label="Category emoji — pick below">
            {emoji.trim() ? emoji.trim() : <span className="cat-emoji-ph">🙂</span>}
          </div>
          <input
            className="cat-in"
            value={tag}
            maxLength={8}
            placeholder={`Short word (default ${autoTag(name || edit.name || '?')})`}
            onChange={(e) => setTag(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') close()
            }}
          />
        </div>
        <div className="cat-emoji-grid">
          <button
            type="button"
            className={`cat-emoji-opt none${!emoji.trim() ? ' on' : ''}`}
            title="No emoji"
            onClick={() => pickEmoji('')}
          >
            ⊘
          </button>
          {CAT_EMOJI.map((e) => (
            <button
              type="button"
              key={e}
              className={`cat-emoji-opt${emoji.trim() === e ? ' on' : ''}`}
              onClick={() => pickEmoji(e)}
            >
              {e}
            </button>
          ))}
        </div>
        <div className="cat-colors">
          {CAT_PALETTE.map((col) => (
            <button
              key={col}
              className={`cat-sw${col === color ? ' on' : ''}`}
              style={{ background: col }}
              title={col}
              onClick={() => pickColor(col)}
            />
          ))}
        </div>
        <div className="menusep" />
        <button className="menuitem" onClick={save}>
          {isCreate ? 'Create' : 'Done'}
        </button>
        {/* The privacy gate. Off by default and per-category, so client work
            never reaches the API unless it is switched on deliberately. */}
        {edit.id !== null && (
          <label className="arb-optin" title="Send this category's pending commands and questions to the Arbiter">
            <input
              type="checkbox"
              checked={arbCtx}
              onChange={(e) => {
                setArbCtx(e.target.checked)
                window.cc.catSetArbiterContext(edit.id as number, e.target.checked)
              }}
            />
            <span>
              Arbiter may read this category
              <span className="arb-optin-sub">
                {arbCtx ? 'sends commands and questions' : 'sends state only'}
              </span>
            </span>
          </label>
        )}
        {/* Per-category notification overrides. Each class defaults to "inherit",
            so a category behaves like the global setting until you diverge. */}
        {edit.id !== null && (
          <div className="catnotify">
            <div className="catnotify-head">Notify me</div>
            {(
              [
                ['permission', 'Needs permission'],
                ['question', 'Your turn'],
                ['done', 'Finished'],
              ] as const
            ).map(([cls, label]) => {
              const cur = notify[cls]
              return (
                <div className="catnotify-row" key={cls}>
                  <span className="catnotify-label">{label}</span>
                  <div className="catnotify-seg">
                    {(
                      [
                        [null, 'auto'],
                        [true, 'on'],
                        [false, 'off'],
                      ] as const
                    ).map(([val, txt]) => (
                      <button
                        key={txt}
                        className={`catnotify-btn${
                          (val === null ? cur == null : cur === (val ? 1 : 0)) ? ' on' : ''
                        }`}
                        title={val === null ? 'Follow the global setting' : undefined}
                        onClick={() => setNotifyCls(cls, val)}
                      >
                        {txt}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {edit.id !== null &&
          (confirmDel ? (
            <>
              {/* Deleting a category terminates its sessions. Say so plainly, and
                  say what to do about it — the count is the load-bearing part. */}
              <div className="menunote">
                {edit.count === 0
                  ? 'Delete this category?'
                  : `Terminates ${edit.count} session${edit.count === 1 ? '' : 's'}. Move any you want to keep to another category first.`}
              </div>
              <button
                className="menuitem danger"
                onClick={() => {
                  window.cc.catDelete(edit.id as number)
                  close()
                }}
              >
                {edit.count === 0
                  ? `Delete “${edit.name}”`
                  : `Delete “${edit.name}” + ${edit.count}`}
              </button>
              <button className="menuitem" onClick={() => setConfirmDel(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button className="menuitem danger" onClick={() => setConfirmDel(true)}>
              Delete category
            </button>
          ))}
      </div>
    </>
  )
}

function SessionNameEditor({
  edit,
  setEdit,
  onSaved,
}: {
  edit: { sessionId: string; name: string; x: number; y: number }
  setEdit: (v: null) => void
  onSaved: (sessionId: string, name: string) => void
}) {
  const [name, setName] = useState(edit.name)
  const close = () => setEdit(null)
  const save = () => {
    const nm = name.trim()
    window.cc.sessionSetName(edit.sessionId, nm)
    onSaved(edit.sessionId, nm)
    close()
  }
  return (
    <>
      <div
        className="menuscrim"
        onClick={close}
        onContextMenu={(e) => {
          e.preventDefault()
          close()
        }}
      />
      <div className="menu cateditor" style={{ left: edit.x, top: edit.y }}>
        <div className="menuhead">Rename session</div>
        <input
          className="cat-in"
          autoFocus
          value={name}
          placeholder="Name — blank restores the generated title"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') close()
          }}
        />
        <div className="menusep" />
        <button className="menuitem" onClick={save}>
          Save
        </button>
      </div>
    </>
  )
}

// Shared body for both update modals: a two-tab view — "What's new" (this
// release's features) and "Changelog" (every version). Kept dumb; the parent
// owns the surrounding chrome and buttons.
function UpdateTabs({ payload }: { payload: UpdatePayload }) {
  const [tab, setTab] = useState<'new' | 'log'>('new')
  const features = payload.features ?? []
  const changelog = payload.changelog ?? []
  return (
    <div className="uptabs">
      <div className="uptabbar">
        <button
          className={`uptab${tab === 'new' ? ' on' : ''}`}
          onClick={() => setTab('new')}
        >
          What’s new
        </button>
        <button
          className={`uptab${tab === 'log' ? ' on' : ''}`}
          onClick={() => setTab('log')}
        >
          Full changelog
        </button>
      </div>
      <div className="upbody">
        {tab === 'new' ? (
          features.length ? (
            <ul className="upfeatures">
              {features.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          ) : (
            <div className="upempty">Release notes weren’t published for this version.</div>
          )
        ) : changelog.length ? (
          <div className="uplog">
            {changelog.map((e) => (
              <div className="uplog-entry" key={e.version}>
                <div className="uplog-head">
                  <span className="uplog-ver">v{e.version}</span>
                  {e.date && <span className="uplog-date">{e.date}</span>}
                  {e.critical && <span className="uplog-crit">critical</span>}
                </div>
                <ul className="upfeatures">
                  {(e.features ?? []).map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <div className="upempty">No changelog available.</div>
        )}
      </div>
    </div>
  )
}

// "An update is available." Offers install-now, install-on-quit, remind-later,
// and (unless the release is critical) skip-this-version. Once a download is in
// flight the buttons give way to progress / staged / error state.
function UpdateAvailableModal({
  payload,
  dl,
  onInstall,
  onInstallOnQuit,
  onSkip,
  onRemindLater,
}: {
  payload: UpdatePayload
  dl: { state: 'downloading' | 'staged' | 'error'; percent?: number; message?: string } | null
  onInstall: () => void
  onInstallOnQuit: () => void
  onSkip: () => void
  onRemindLater: () => void
}) {
  return (
    <div className="spawnscrim" onClick={onRemindLater}>
      <div className="spawnmodal upmodal" onClick={(e) => e.stopPropagation()}>
        <div className="spawntitle">
          Update available — v{payload.version}
          {payload.critical && <span className="uplog-crit" style={{ marginLeft: 8 }}>critical</span>}
        </div>
        <div className="upsub">
          You’re on v{payload.currentVersion}. A newer release is ready to install.
        </div>
        <UpdateTabs payload={payload} />
        {dl?.state === 'downloading' && (
          <div className="upprogress">
            <div className="upbar">
              <div className="upbar-fill" style={{ width: `${dl.percent ?? 0}%` }} />
            </div>
            <div className="upprogress-l">Downloading… {dl.percent ?? 0}%</div>
          </div>
        )}
        {dl?.state === 'staged' && (
          <div className="upstaged">Update downloaded — it will install when you quit the app.</div>
        )}
        {dl?.state === 'error' && (
          <div className="uperror">Update failed: {dl.message}</div>
        )}
        <div className="upactions">
          {!payload.critical && (
            <button className="rbtn ghost" onClick={onSkip} disabled={!!dl && dl.state !== 'error'}>
              Skip this version
            </button>
          )}
          <div className="grow" />
          <button className="rbtn ghost" onClick={onRemindLater}>
            Remind me later
          </button>
          <button className="rbtn" onClick={onInstallOnQuit} disabled={!!dl && dl.state !== 'error'}>
            Install on quit
          </button>
          <button
            className="rbtn primary"
            onClick={onInstall}
            disabled={!!dl && dl.state !== 'error'}
          >
            Install now
          </button>
        </div>
      </div>
    </div>
  )
}

// First launch after an update. A full-window blurred overlay (not an OS
// window) centered over the app, confirming the new version, with the same
// two-tab notes and a single dismiss button.
function PostUpdateModal({ payload, close }: { payload: UpdatePayload; close: () => void }) {
  return (
    <div className="updatescrim">
      <div className="spawnmodal upmodal postupdate" onClick={(e) => e.stopPropagation()}>
        <div className="spawntitle">CC Command Center has been updated to version {payload.version}</div>
        <UpdateTabs payload={payload} />
        <div className="upactions">
          <div className="grow" />
          <button className="rbtn primary" onClick={close}>
            Awesome, let’s go
          </button>
        </div>
      </div>
    </div>
  )
}

function TallyItem({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <div className={`tally-item${n > 0 ? '' : ' zero'}`}>
      <span className="tally-n" style={{ color }}>
        {n}
      </span>
      <span className="tally-l">{label}</span>
    </div>
  )
}

function ThemePicker({ current, onPick }: { current: string; onPick: (name: string) => void }) {
  const [open, setOpen] = useState(false)
  const cur = themeByName(current)
  return (
    <div className="themepicker">
      <button className="themebtn" onClick={() => setOpen((o) => !o)} title={`Terminal theme: ${cur.name}`}>
        <span className="tswatch" style={{ background: cur.accent }} />
        <span className="themename">{cur.name}</span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <>
          <div className="menuscrim" onClick={() => setOpen(false)} />
          <div className="thememenu">
            {THEMES.map((t) => (
              <button
                key={t.name}
                className="menuitem"
                onClick={() => {
                  onPick(t.name)
                  setOpen(false)
                }}
              >
                <span className="tswatch" style={{ background: t.accent }} />
                <span className="grow">{t.name}</span>
                {t.name === cur.name && <span className="check">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
