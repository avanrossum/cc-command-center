import { useEffect, useMemo, useRef, useState } from 'react'
import { TerminalView } from './Terminal'
import { THEMES, themeByName, DEFAULT_THEME_NAME } from './themes'

type CoarseState = 'working' | 'waiting' | 'idle' | 'unknown'

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
}
interface Category {
  id: number
  name: string
  color: string
  sort: number
}
interface Edge {
  child_id: string
  parent_id: string
  type: string
  source: string
}
interface Snapshot {
  home: string
  scannedAt: number
  sessions: Session[]
  categories: Category[]
  edges: Edge[]
}
interface Selected {
  key: string
  pid?: number
  sessionId?: string
  cwd: string
  name: string
  resume: boolean
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

const STATE: Record<CoarseState, { label: string; color: string; order: number }> = {
  working: { label: 'Working', color: '#34d399', order: 0 },
  // Blue = the assistant's last turn ended recently, so structurally it's the
  // human's move. It does NOT mean a question/permission was detected (that
  // precision is roadmap Phase 7) — so the honest label is "Your turn".
  waiting: { label: 'Your turn', color: '#60a5fa', order: 1 },
  idle: { label: 'Idle', color: '#6b7280', order: 2 },
  unknown: { label: 'Unknown', color: '#a78bfa', order: 3 },
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

export function App() {
  const [snap, setSnap] = useState<Snapshot>({
    home: '',
    scannedAt: 0,
    sessions: [],
    categories: [],
    edges: [],
  })
  const [selected, setSelected] = useState<Selected | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [newCat, setNewCat] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const [version, setVersion] = useState('')
  // Instant theme feedback for the current terminal before the persisted value
  // round-trips back through the next snapshot. Cleared when the selection changes.
  const [themeOverride, setThemeOverride] = useState<{ key: string; name: string } | null>(null)
  // A session whose transcript is gone: the pane shows a recovery card instead
  // of a doomed `claude --resume`.
  const [recover, setRecover] = useState<{ key: string; sessionId: string; cwd: string } | null>(null)
  // Restore-on-launch: the last-active session id to reopen once it appears live.
  const [pendingRestore, setPendingRestore] = useState<string | null>(null)
  const restoredRef = useRef(false)

  useEffect(() => {
    window.cc.appVersion().then((v) => setVersion(v.full))
    window.cc.getSessions().then((s) => setSnap(s as Snapshot))
    window.cc.stateGet('activeSessionId').then((id) => setPendingRestore(id))
    const offSessions = window.cc.onSessions((s) => setSnap(s as Snapshot))
    const offShow = window.cc.onTermShow((p) => {
      setRecover(null)
      setSelected({ key: p.key, pid: p.pid, cwd: p.cwd, name: p.name, resume: false })
    })
    const offRecover = window.cc.onTermRecover((p) => setRecover(p))
    return () => {
      offSessions()
      offShow()
      offRecover()
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
  const counts = useMemo(() => {
    const c: Record<CoarseState, number> = { working: 0, waiting: 0, idle: 0, unknown: 0 }
    for (const s of live) c[s.state]++
    return c
  }, [live])
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
        const kids = (childrenOf.get(s.sessionId) ?? []).sort((a, b) => bySort(a.s, b.s))
        for (const k of kids) walk(k.s, depth + 1, k.type)
      }
      for (const r of roots.sort(bySort)) walk(r, 0, null)
      return out
    }
    const cats = snap.categories.map((c) => ({
      id: c.id as number | null,
      name: c.name,
      color: c.color,
      rows: buildTree(byCat.get(c.id) ?? []),
    }))
    const uncat = {
      id: null as number | null,
      name: 'Uncategorized',
      color: '#5b6474',
      rows: buildTree(byCat.get(null) ?? []),
    }
    return [...cats, uncat].filter((g) => g.id !== null || g.rows.length > 0)
  }, [live, snap.categories, edgeByChild])

  const openSession = (s: Session) => {
    window.cc.stateSet('activeSessionId', s.sessionId) // remember for restore-on-launch
    setSelected({
      key: s.sessionId,
      pid: s.pid,
      sessionId: s.sessionId,
      cwd: s.cwd,
      name: s.name ?? `pid ${s.pid}`,
      resume: true,
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
    if (name) await window.cc.catCreate(name)
    setNewCatName('')
    setNewCat(false)
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="pulse" />
          <span className="title">Claude Command Center</span>
          {version && <span className="ver" title="version · build">{version}</span>}
        </div>
        <div className="summary">
          <Pill n={counts.working} label="working" color={STATE.working.color} />
          <Pill n={counts.waiting} label="your turn" color={STATE.waiting.color} />
          <Pill n={counts.idle} label="idle" color={STATE.idle.color} />
          <span className="total">{live.length} sessions</span>
        </div>
      </header>

      <div className="body">
        <aside className="sidebar">
          <button className="newsession" onClick={() => window.cc.sessionNew()}>
            ＋ New session…
          </button>
          <div className="sidehead">
            <span className="sidetitle">CATEGORIES</span>
            {newCat ? (
              <input
                className="newcatinput"
                autoFocus
                placeholder="Category name…"
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
            ) : (
              <button className="addcat" onClick={() => setNewCat(true)}>
                + Category
              </button>
            )}
          </div>

          {groups.map((g) => (
            <section key={g.id ?? 'uncat'} className="group">
              <div className="grouphead">
                <span className="cdot" style={{ background: g.color }} />
                <span className="cname">{g.name}</span>
                <span className="gcount">{g.rows.length}</span>
              </div>
              <ul className="rows">
                {g.rows.length === 0 && <li className="emptycat">right-click a session to move it here</li>}
                {g.rows.map(({ s, depth, edgeType }) => (
                  <li
                    key={s.sessionId}
                    className={`row state-${s.state}${selected?.key === s.sessionId ? ' sel' : ''}`}
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
                    <span className="dot" style={{ background: STATE[s.state].color }} />
                    {s.theme && s.theme !== DEFAULT_THEME_NAME && (
                      <span
                        className="tswatch"
                        style={{ background: themeByName(s.theme).accent }}
                        title={`theme: ${s.theme}`}
                      />
                    )}
                    <span className="rowmain">
                      <span className="name">{s.name ?? <em>pid {s.pid}</em>}</span>
                      <span className="rowcwd">{short(s.cwd)}</span>
                    </span>
                    <span className="meta">{fmtAge(s.transcriptMtimeMs, snap.scannedAt)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </aside>

        <main className="terminalarea">
          {selected ? (
            <>
              <div className="termbar">
                <span className="tname">{selected.name}</span>
                <span className="tcwd" title={selected.cwd}>
                  {short(selected.cwd)}
                </span>
                {selected.resume && <span className="tnote">resumed copy — original keeps running</span>}
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
              />
              {recover && recover.key === selected.key && (
                <div className="recover">
                  <div className="recovercard">
                    <div className="recovertitle">This conversation no longer exists</div>
                    <div className="recoversub">
                      Its transcript was deleted or pruned, so it can’t be resumed. Anything above is
                      the last scrollback snapshot we saved.
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

      {menu && <ContextMenu menu={menu} snap={snap} live={live} edgeByChild={edgeByChild} setMenu={setMenu} assign={assign} setEdge={setEdge} onNewCat={() => { setMenu(null); setNewCat(true) }} />}
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
}: {
  menu: Menu
  snap: Snapshot
  live: Session[]
  edgeByChild: Map<string, Edge>
  setMenu: (m: Menu | null) => void
  assign: (s: Session, c: number | null) => void
  setEdge: (child: Session, parent: Session, type: MenuMode) => void
  onNewCat: () => void
}) {
  const s = menu.session
  const hasParent = edgeByChild.has(s.sessionId)
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
                  window.cc.edgeClear(s.sessionId)
                  setMenu(null)
                }}
              >
                Clear parent
              </button>
            )}
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
              <button key={p.pid} className="menuitem" onClick={() => setEdge(s, p, menu.mode)}>
                <span className="dot" style={{ background: STATE[p.state].color }} />
                <span className="grow">{p.name ?? `pid ${p.pid}`}</span>
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

function Pill({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <span className={`spill${n > 0 ? ' on' : ''}`}>
      <span className="pdot" style={{ background: color }} />
      {n} {label}
    </span>
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
