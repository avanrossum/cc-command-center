import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { TerminalView } from './Terminal'
import { THEMES, themeByName, DEFAULT_THEME_NAME } from './themes'

type CoarseState = 'working' | 'waiting' | 'idle' | 'unknown'
// 'blocked' is a DERIVED display state (a parent whose blocking child is
// unfinished) — computed in the renderer, not reported by the engine.
type DisplayState = CoarseState | 'blocked'

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

const STATE: Record<DisplayState, { label: string; color: string; order: number }> = {
  working: { label: 'Working', color: '#34d399', order: 0 },
  // Blue = the assistant's last turn ended recently, so structurally it's the
  // human's move. It does NOT mean a question/permission was detected (that
  // precision is roadmap Phase 7) — so the honest label is "Your turn".
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
  // The category rail selects ONE collection; its tree shows in the pane below.
  const [selectedCat, setSelectedCat] = useState<number | null>(null)
  const initCatRef = useRef(false)
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
  const [spawn, setSpawn] = useState<{
    parent: Session
    type: 'blocking' | 'tangential'
    cwd: string
    note: string
  } | null>(null)

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
  const dstate = (s: Session): DisplayState =>
    !s.dormant && blockedSet.has(s.sessionId) ? 'blocked' : s.state

  const counts = useMemo(() => {
    const c: Record<DisplayState, number> = { working: 0, waiting: 0, blocked: 0, idle: 0, unknown: 0 }
    for (const s of live) if (!s.dormant) c[blockedSet.has(s.sessionId) ? 'blocked' : s.state]++
    return c
  }, [live, blockedSet])
  const liveCount = useMemo(() => live.filter((s) => !s.dormant).length, [live])
  const dormantCount = useMemo(() => live.filter((s) => s.dormant).length, [live])
  // The "NEEDS YOU" ledger: every waiting or blocked session, most-urgent first.
  const needsYou = useMemo(
    () =>
      live
        .filter((s) => !s.dormant && (blockedSet.has(s.sessionId) || s.state === 'waiting'))
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
        <div className="cmdk" title="Command palette — coming soon">
          ⌘K
        </div>
      </header>

      <div className="body">
        <nav className="rail">
          {groups.map((g) => {
            const letter = g.id === null ? '·' : (g.name.trim()[0] ?? '?').toUpperCase()
            const hasWaiting = g.rows.some(
              ({ s }) => !s.dormant && (blockedSet.has(s.sessionId) || s.state === 'waiting'),
            )
            return (
              <button
                key={g.id ?? 'uncat'}
                className={`rail-cell${selectedCat === g.id ? ' active' : ''}${hasWaiting ? ' waiting' : ''}`}
                style={{ '--cat-color': g.color } as CSSProperties}
                onClick={() => setSelectedCat(g.id)}
                title={`${g.name} · ${g.rows.length}`}
              >
                {letter}
              </button>
            )
          })}
          <button className="rail-add" onClick={() => setNewCat(true)} title="New category">
            ＋
          </button>
        </nav>

        <aside className="treepane">
          <button className="newsession" onClick={() => window.cc.sessionNew()}>
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
            setSpawn({ parent: s, type, cwd: s.cwd, note: '' })
          }}
        />
      )}
      {spawn && <SpawnComposer spawn={spawn} setSpawn={setSpawn} />}
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
                  window.cc.edgeClear(s.sessionId)
                  setMenu(null)
                }}
              >
                Clear parent
              </button>
            )}
            {s.dormant && (
              <>
                <div className="menusep" />
                <button
                  className="menuitem danger"
                  onClick={() => {
                    window.cc.sessionRemove(s.sessionId)
                    setMenu(null)
                  }}
                >
                  Remove from list
                </button>
              </>
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

type SpawnState = { parent: Session; type: 'blocking' | 'tangential'; cwd: string; note: string }

function SpawnComposer({
  spawn,
  setSpawn,
}: {
  spawn: SpawnState
  setSpawn: (s: SpawnState | null) => void
}) {
  const isBlocking = spawn.type === 'blocking'
  const parentName = spawn.parent.name ?? `pid ${spawn.parent.pid}`
  const submit = () => {
    window.cc.sessionSpawnChild(spawn.parent.sessionId, spawn.cwd, spawn.type, spawn.note.trim() || undefined)
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
        <div className="spawnactions">
          <button className="rbtn" onClick={() => setSpawn(null)}>
            Cancel
          </button>
          <button className="rbtn primary" onClick={submit}>
            Spawn {isBlocking ? 'blocking child' : 'offshoot'}
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
