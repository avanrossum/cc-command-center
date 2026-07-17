import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { insertablePath } from './util'
import { TerminalView } from './Terminal'
import { THEMES, themeByName, DEFAULT_THEME_NAME } from './themes'

type CoarseState = 'working' | 'waiting' | 'idle' | 'unknown'
// 'blocked' and 'permission' are DERIVED display states, not coarse engine states.
// 'blocked': a parent whose blocking child is unfinished (computed in the renderer).
// 'permission': a managed session parked on a dialog (the engine reports it via
// s.attention, scanned from the live PTY buffer — it reads as 'working' in the
// transcript, so this is the only way it surfaces as needing you).
type DisplayState = CoarseState | 'blocked' | 'permission'

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
  attention?: 'permission' // parked on a permission/approval dialog (buffer-scanned)
}
interface Category {
  id: number
  name: string
  color: string
  sort: number
  label: string | null
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
  statusHooksInstalled: boolean
  spawnAutoMode: boolean
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

// Rail tag: initials from the name — one word → first 2 letters, multi-word →
// first letters of the first two words. "Test"→TE, "Test 2"→T2, "A · B"→AB.
function autoTag(name: string): string {
  const words = name
    .split(/[\s·/|,_-]+/)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

const CAT_PALETTE = [
  '#e2b34a', '#4ac0e2', '#e2724a', '#9b6ff0', '#d14a9b',
  '#2fb8a0', '#e0625f', '#9bbf4a', '#6d7cf0',
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
  const [newCat, setNewCat] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const [version, setVersion] = useState('')
  // The category rail selects ONE collection; its tree shows in the pane below.
  const [selectedCat, setSelectedCat] = useState<number | null>(null)
  const initCatRef = useRef(false)
  // Right-click a rail cell → edit its name / tag / color / delete.
  const [catEdit, setCatEdit] = useState<{
    id: number
    name: string
    color: string
    label: string | null
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
    const bySession = new Map<string, Session>()
    for (const s of snap.sessions) {
      if (s.isSpare) continue
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
  // Display state, most-urgent wins: a parked dialog (self needs action) beats
  // blocked-on-child, which beats the coarse transcript state.
  const dstate = (s: Session): DisplayState =>
    s.dormant
      ? s.state
      : s.attention === 'permission'
        ? 'permission'
        : blockedSet.has(s.sessionId)
          ? 'blocked'
          : s.state

  const counts = useMemo(() => {
    const c: Record<DisplayState, number> = {
      permission: 0,
      working: 0,
      waiting: 0,
      blocked: 0,
      idle: 0,
      unknown: 0,
    }
    for (const s of live) if (!s.dormant) c[dstate(s)]++
    return c
  }, [live, blockedSet]) // eslint-disable-line react-hooks/exhaustive-deps
  const liveCount = useMemo(() => live.filter((s) => !s.dormant).length, [live])
  const dormantCount = useMemo(() => live.filter((s) => s.dormant).length, [live])
  // The "NEEDS YOU" ledger: only sessions that genuinely can't proceed without
  // you — parked on a dialog, or blocked on an unfinished blocking child. Plain
  // 'waiting' (a turn that just ended) is NOT included: it's usually a session
  // that replied and went idle, which was the old over-flagging noise.
  const needsYou = useMemo(
    () =>
      live
        .filter((s) => !s.dormant && (s.attention === 'permission' || blockedSet.has(s.sessionId)))
        .sort((a, b) => STATE[dstate(a)].order - STATE[dstate(b)].order),
    [live, blockedSet], // eslint-disable-line react-hooks/exhaustive-deps
  )
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
      rows: buildTree(byCat.get(c.id) ?? []),
    }))
    const uncat = {
      id: null as number | null,
      name: 'Uncategorized',
      color: '#6a6355',
      label: null as string | null,
      rows: buildTree(byCat.get(null) ?? []),
    }
    return [...cats, uncat].filter((g) => g.id !== null || g.rows.length > 0)
  }, [live, snap.categories, edgeByChild, blockedSet]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectedGroup =
    groups.find((g) => g.id === selectedCat) ??
    groups[0] ?? { id: null as number | null, name: 'Uncategorized', color: '#6a6355', rows: [] as TreeRow[] }

  // First time sessions load, land on the fullest category rather than an empty one.
  useEffect(() => {
    if (initCatRef.current || live.length === 0) return
    initCatRef.current = true
    const fullest = [...groups].sort((a, b) => b.rows.length - a.rows.length)[0]
    if (fullest) setSelectedCat(fullest.id)
  }, [groups, live])

  const openSession = (s: Session) => {
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
    })
  }
  const closeTerminal = () => {
    if (selected) window.cc.termClose(selected.key)
    setSelected(null)
  }

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
      openSession(s)
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
  const createCategory = async () => {
    const name = newCatName.trim()
    if (name) {
      const c = await window.cc.catCreate(name)
      if (c?.id != null) setSelectedCat(c.id)
    }
    setNewCatName('')
    setNewCat(false)
  }
  // Beacon "needs you" click: switch the rail to that session's category, then open it.
  const jumpTo = (s: Session) => {
    setSelectedCat(s.categoryId)
    openSession(s)
  }

  return (
    <div className="app">
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
          {needsYou.length === 0 ? (
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
                    className={`needs-item ns-${dstate(s)}`}
                    onClick={() => jumpTo(s)}
                    title={s.stateReason}
                  >
                    <span className="ns-idx">{String(i + 1).padStart(2, '0')}</span>
                    <span className={`cc-dot cc-dot--${dstate(s)}`} />
                    <span className="ns-name">{s.name ?? `pid ${s.pid}`}</span>
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
        <button className="gearbtn" onClick={() => setSettingsOpen(true)} title="Settings">
          ⚙
        </button>
        {/* Command-palette entry point — hidden until there's a real palette behind it. */}
      </header>

      <div className="body">
        <nav className="rail">
          {groups.map((g) => {
            const tag = g.id === null ? '·' : g.label || autoTag(g.name)
            // Category dot lights when something in it needs you — same rule as
            // the beacon ledger (a parked dialog or a blocked parent).
            const hasWaiting = g.rows.some(
              ({ s }) => !s.dormant && (s.attention === 'permission' || blockedSet.has(s.sessionId)),
            )
            return (
              <button
                key={g.id ?? 'uncat'}
                className={`rail-cell${selectedCat === g.id ? ' active' : ''}${hasWaiting ? ' waiting' : ''}`}
                style={{ '--cat-color': g.color } as CSSProperties}
                onClick={() => {
                  setSelectedCat(g.id)
                  // Jump back to the last session opened in this category. Only if
                  // it still exists — never surprise-resume a session you didn't pick.
                  const lastId = lastByCat.current.get(g.id)
                  const target = lastId ? live.find((s) => s.sessionId === lastId) : undefined
                  if (target) openSession(target)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  if (g.id !== null)
                    setCatEdit({ id: g.id, name: g.name, color: g.color, label: g.label, x: e.clientX, y: e.clientY })
                }}
                title={`${g.name} · ${g.rows.length}`}
              >
                {tag}
              </button>
            )
          })}
          <button className="rail-add" onClick={() => setNewCat(true)} title="New category">
            ＋
          </button>
        </nav>

        <aside className="treepane">
          <button className="newsession" onClick={() => setNewSessionOpen(true)}>
            ＋ New session…
          </button>
          {newCat && (
            <input
              className="newcatinput"
              autoFocus
              placeholder="New category name…"
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') createCategory()
                if (e.key === 'Escape') {
                  setNewCat(false)
                  setNewCatName('')
                }
              }}
              onBlur={createCategory}
            />
          )}
          <div className="treehead">
            <span className="cdot" style={{ background: selectedGroup.color }} />
            <span className="cname">{selectedGroup.name}</span>
            <span className="gcount">{selectedGroup.rows.length}</span>
          </div>
          <ul className="rows">
            {selectedGroup.rows.length === 0 && (
              <li className="emptycat">right-click a session to move it here</li>
            )}
            {selectedGroup.rows.map(({ s, depth, edgeType }) => (
              <li
                key={s.sessionId}
                className={`row state-${dstate(s)}${s.dormant ? ' dormant' : ''}${selected?.key === s.sessionId ? ' sel' : ''}`}
                style={{ paddingLeft: 10 + depth * 16 }}
                title={s.stateReason}
                onClick={() => openSession(s)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ x: e.clientX, y: e.clientY, session: s, mode: 'root' })
                }}
              >
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
                </span>
                {s.dormant ? (
                  <span className="meta resume">resume</span>
                ) : (
                  <span className="meta">{fmtAge(s.transcriptMtimeMs, snap.scannedAt)}</span>
                )}
              </li>
            ))}
          </ul>
        </aside>

        <main className="terminalarea">
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
                <span className="grow" />
                <ThemePicker current={selThemeName} onPick={pickTheme} />
                <button className="tclose" onClick={closeTerminal} title="Close terminal">
                  ✕
                </button>
              </div>
              <TerminalView
                key={selected.key}
                termKey={selected.key}
                sessionId={selected.sessionId}
                pid={selected.pid}
                cwd={selected.cwd}
                resume={selected.resume}
                themeName={selThemeName}
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
          ) : (
            <div className="placeholder">
              <p>Select a session to open its terminal.</p>
              <p className="sub">
                Right-click a session to set its category or make it a blocking child / tangential
                offshoot of another. Opening a session running in iTerm resumes a managed copy here.
              </p>
            </div>
          )}
        </main>
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
            setMenu(null)
            setNewCat(true)
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
        />
      )}
      {spawn && (
        <SpawnComposer
          spawn={spawn}
          setSpawn={setSpawn}
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
          close={() => setNewSessionOpen(false)}
        />
      )}
      {catEdit && <CategoryEditor edit={catEdit} setEdit={setCatEdit} />}
      {logOpen && (
        <MessageLog
          messages={snap.messages ?? []}
          paused={!!snap.awarenessPaused}
          close={() => setLogOpen(false)}
        />
      )}
      {settingsOpen && (
        <SettingsModal settings={snap.settings} showFlash={showFlash} close={() => setSettingsOpen(false)} />
      )}
      {snap.settings && !snap.settings.firstRunSeen && (
        <FirstRunMail settings={snap.settings} showFlash={showFlash} />
      )}
      {flash && <div className="flash">{flash}</div>}
    </div>
  )
}

// Settings menu. Backed by app_state via settingsSet; the mail-permission grant
// edits ~/.claude/settings.json (see main). Grows as more settings are added.
function SettingsModal({
  settings,
  showFlash,
  close,
}: {
  settings?: AppSettings
  showFlash: (m: string) => void
  close: () => void
}) {
  const trust = settings?.trustChildrenByDefault ?? true
  const mailGranted = settings?.mailAllowGranted ?? false
  const hooksInstalled = settings?.statusHooksInstalled ?? false
  return (
    <div className="spawnscrim" onClick={close}>
      <div className="spawnmodal" onClick={(e) => e.stopPropagation()}>
        <div className="spawntitle">Settings</div>

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
            disabled={hooksInstalled}
            onClick={async () => {
              const r = await window.cc.settingsInstallStatusHooks()
              showFlash(r.ok ? 'status hooks installed' : `couldn’t install: ${r.reason ?? 'error'}`)
            }}
          >
            {hooksInstalled ? 'Installed ✓' : 'Install…'}
          </button>
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
}

function SpawnComposer({
  spawn,
  setSpawn,
  siblingNames,
}: {
  spawn: SpawnState
  setSpawn: (s: SpawnState | null) => void
  siblingNames: string[]
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
const EFFORT_OPTS = ['', 'low', 'medium', 'high', 'xhigh', 'max']

function NewSessionComposer({
  categories,
  defaultCat,
  home,
  recent,
  lastModel,
  lastEffort,
  close,
}: {
  categories: Category[]
  defaultCat: number | null
  home: string
  recent: string[]
  lastModel: string
  lastEffort: string
  close: () => void
}) {
  const [name, setName] = useState('')
  const [cat, setCat] = useState<number | null>(defaultCat)
  const [cwd, setCwd] = useState('')
  const [flags, setFlags] = useState('')
  const [instructions, setInstructions] = useState('')
  // Remember the last model/effort. A custom id restores as the "Custom…" choice.
  const knownModel = MODEL_OPTS.some((o) => o.v === lastModel)
  const [model, setModel] = useState(knownModel ? lastModel : lastModel ? '__custom__' : '')
  const [customModel, setCustomModel] = useState(knownModel ? '' : lastModel)
  const [effort, setEffort] = useState(lastEffort)
  const pick = async () => {
    const p = await window.cc.pickFolder()
    if (p) setCwd(p)
  }
  const create = () => {
    if (!cwd) return
    const chosenModel = model === '__custom__' ? customModel.trim() : model
    // Prepend --model / --effort to whatever the user typed in Flags.
    const allFlags = [
      chosenModel && `--model ${chosenModel}`,
      effort && `--effort ${effort}`,
      flags.trim(),
    ]
      .filter(Boolean)
      .join(' ')
    window.cc.settingsSet('lastModel', model === '__custom__' ? customModel.trim() : model)
    window.cc.settingsSet('lastEffort', effort)
    window.cc.sessionCreate({
      cwd,
      flags: allFlags || undefined,
      categoryId: cat,
      name: name.trim() || undefined,
      instructions: instructions.trim() || undefined,
    })
    close()
  }
  const shortCwd = home && cwd.startsWith(home) ? cwd.replace(home, '~') : cwd
  return (
    <div className="spawnscrim" onClick={close}>
      <div className="spawnmodal" onClick={(e) => e.stopPropagation()}>
        <div className="spawntitle">New session</div>
        <div className="spawnsub">launches a managed Claude session and adopts it here.</div>

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
                <button
                  key={f}
                  className="recentfolder"
                  title={f}
                  onClick={() => setCwd(f)}
                >
                  {home && f.startsWith(home) ? f.replace(home, '~') : f}
                </button>
              ))}
            </div>
          </>
        )}

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
            <select className="cat-in" value={effort} onChange={(e) => setEffort(e.target.value)}>
              {EFFORT_OPTS.map((v) => (
                <option key={v} value={v}>
                  {v === '' ? 'Default' : v}
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

        <div className="spawnlabel">
          Flags <span className="spawnopt">optional extra CLI args</span>
        </div>
        <input
          className="cat-in"
          value={flags}
          placeholder="e.g. --dangerously-skip-permissions"
          onChange={(e) => setFlags(e.target.value)}
        />

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
}: {
  edit: { id: number; name: string; color: string; label: string | null; x: number; y: number }
  setEdit: (v: null) => void
}) {
  const [name, setName] = useState(edit.name)
  const [tag, setTag] = useState(edit.label ?? '')
  const [color, setColor] = useState(edit.color)
  const close = () => setEdit(null)
  const save = () => {
    const nm = name.trim()
    if (nm && nm !== edit.name) window.cc.catRename(edit.id, nm)
    window.cc.catSetLabel(edit.id, tag.trim().slice(0, 3).toUpperCase() || null)
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
        <div className="menuhead">Category</div>
        <input
          className="cat-in"
          autoFocus
          value={name}
          placeholder="Name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') close()
          }}
        />
        <input
          className="cat-in"
          value={tag}
          maxLength={3}
          placeholder={`Rail tag (default ${autoTag(edit.name)})`}
          onChange={(e) => setTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') close()
          }}
        />
        <div className="cat-colors">
          {CAT_PALETTE.map((col) => (
            <button
              key={col}
              className={`cat-sw${col === color ? ' on' : ''}`}
              style={{ background: col }}
              title={col}
              onClick={() => {
                setColor(col)
                window.cc.catSetColor(edit.id, col)
              }}
            />
          ))}
        </div>
        <div className="menusep" />
        <button className="menuitem" onClick={save}>
          Save
        </button>
        <button
          className="menuitem danger"
          onClick={() => {
            window.cc.catDelete(edit.id)
            close()
          }}
        >
          Delete category
        </button>
      </div>
    </>
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
