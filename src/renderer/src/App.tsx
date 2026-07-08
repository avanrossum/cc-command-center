import { useEffect, useMemo, useState } from 'react'
import { TerminalView } from './Terminal'

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
  categoryId: number | null
}

interface Category {
  id: number
  name: string
  color: string
  sort: number
}

interface Snapshot {
  home: string
  scannedAt: number
  sessions: Session[]
  categories: Category[]
}

interface Selected {
  pid: number
  sessionId?: string
  cwd: string
  name: string
  resume: boolean
}

interface Menu {
  x: number
  y: number
  session: Session
}

const STATE: Record<CoarseState, { label: string; color: string; order: number }> = {
  working: { label: 'Working', color: '#34d399', order: 0 },
  waiting: { label: 'Waiting on you', color: '#60a5fa', order: 1 },
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

export function App() {
  const [snap, setSnap] = useState<Snapshot>({ home: '', scannedAt: 0, sessions: [], categories: [] })
  const [selected, setSelected] = useState<Selected | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [newCat, setNewCat] = useState(false)
  const [newCatName, setNewCatName] = useState('')

  useEffect(() => {
    window.cc.getSessions().then((s) => setSnap(s as Snapshot))
    const offSessions = window.cc.onSessions((s) => setSnap(s as Snapshot))
    const offShow = window.cc.onTermShow((p) =>
      setSelected({ pid: p.pid, cwd: p.cwd, name: p.name, resume: false }),
    )
    return () => {
      offSessions()
      offShow()
    }
  }, [])

  const live = useMemo(() => snap.sessions.filter((s) => !s.isSpare), [snap])

  const counts = useMemo(() => {
    const c: Record<CoarseState, number> = { working: 0, waiting: 0, idle: 0, unknown: 0 }
    for (const s of live) c[s.state]++
    return c
  }, [live])

  const short = (cwd: string) => (snap.home ? cwd.replace(snap.home, '~') : cwd)

  const groups = useMemo(() => {
    const byCat = new Map<number | null, Session[]>()
    for (const s of live) {
      const k = s.categoryId ?? null
      const arr = byCat.get(k) ?? []
      arr.push(s)
      byCat.set(k, arr)
    }
    const sortSessions = (arr: Session[]) =>
      arr.sort(
        (a, b) =>
          STATE[a.state].order - STATE[b.state].order || (a.name ?? '').localeCompare(b.name ?? ''),
      )
    const cats = snap.categories.map((c) => ({
      id: c.id as number | null,
      name: c.name,
      color: c.color,
      sessions: sortSessions(byCat.get(c.id) ?? []),
    }))
    const uncat = {
      id: null as number | null,
      name: 'Uncategorized',
      color: '#5b6474',
      sessions: sortSessions(byCat.get(null) ?? []),
    }
    // Keep real categories visible even when empty; drop Uncategorized when empty.
    return [...cats, uncat].filter((g) => g.id !== null || g.sessions.length > 0)
  }, [live, snap.categories])

  const openSession = (s: Session) =>
    setSelected({
      pid: s.pid,
      sessionId: s.sessionId,
      cwd: s.cwd,
      name: s.name ?? `pid ${s.pid}`,
      resume: true,
    })

  const closeTerminal = () => {
    if (selected) window.cc.termClose(selected.pid)
    setSelected(null)
  }

  const assign = (s: Session, categoryId: number | null) => {
    window.cc.catAssign(s.sessionId, categoryId)
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
        </div>
        <div className="summary">
          <Pill n={counts.working} label="working" color={STATE.working.color} />
          <Pill n={counts.waiting} label="waiting" color={STATE.waiting.color} />
          <Pill n={counts.idle} label="idle" color={STATE.idle.color} />
          <span className="total">{live.length} sessions</span>
        </div>
      </header>

      <div className="body">
        <aside className="sidebar">
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
              <button className="addcat" onClick={() => setNewCat(true)} title="New category">
                + Category
              </button>
            )}
          </div>

          {groups.map((g) => (
            <section key={g.id ?? 'uncat'} className="group">
              <div className="grouphead">
                <span className="cdot" style={{ background: g.color }} />
                <span className="cname">{g.name}</span>
                <span className="gcount">{g.sessions.length}</span>
              </div>
              <ul className="rows">
                {g.sessions.length === 0 && <li className="emptycat">drag or right-click a session here</li>}
                {g.sessions.map((s) => (
                  <li
                    key={s.pid}
                    className={`row state-${s.state}${selected?.pid === s.pid ? ' sel' : ''}`}
                    title={s.stateReason}
                    onClick={() => openSession(s)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setMenu({ x: e.clientX, y: e.clientY, session: s })
                    }}
                  >
                    <span className="dot" style={{ background: STATE[s.state].color }} />
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
                {selected.resume && (
                  <span className="tnote">resumed copy — original keeps running</span>
                )}
                <span className="grow" />
                <button className="tclose" onClick={closeTerminal} title="Close terminal">
                  ✕
                </button>
              </div>
              <TerminalView
                key={selected.pid}
                pid={selected.pid}
                sessionId={selected.sessionId}
                cwd={selected.cwd}
                resume={selected.resume}
              />
            </>
          ) : (
            <div className="placeholder">
              <p>Select a session to open its terminal.</p>
              <p className="sub">
                Right-click a session to move it into a category. Opening a session running in iTerm
                resumes a managed copy here — the original keeps running until you close it.
              </p>
            </div>
          )}
        </main>
      </div>

      {menu && (
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
            <div className="menuhead">Move “{menu.session.name ?? `pid ${menu.session.pid}`}” to</div>
            {snap.categories.map((c) => (
              <button key={c.id} className="menuitem" onClick={() => assign(menu.session, c.id)}>
                <span className="cdot" style={{ background: c.color }} />
                <span className="grow">{c.name}</span>
                {menu.session.categoryId === c.id && <span className="check">✓</span>}
              </button>
            ))}
            <button className="menuitem" onClick={() => assign(menu.session, null)}>
              <span className="cdot" style={{ background: '#5b6474' }} />
              <span className="grow">Uncategorized</span>
              {menu.session.categoryId == null && <span className="check">✓</span>}
            </button>
            <div className="menusep" />
            <button
              className="menuitem"
              onClick={() => {
                setMenu(null)
                setNewCat(true)
              }}
            >
              + New category…
            </button>
          </div>
        </>
      )}
    </div>
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
