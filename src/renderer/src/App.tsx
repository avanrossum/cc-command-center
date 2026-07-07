import { useEffect, useMemo, useState } from 'react'
import { TerminalView } from './Terminal'

type CoarseState = 'working' | 'waiting' | 'idle' | 'unknown'

interface Session {
  pid: number
  sessionId: string
  cwd: string
  name?: string
  version?: string
  registryStatus?: string
  state: CoarseState
  stateReason: string
  transcriptMtimeMs?: number
  isSpare: boolean
}

interface Snapshot {
  home: string
  scannedAt: number
  sessions: Session[]
}

interface Selected {
  pid: number
  sessionId?: string
  cwd: string
  name: string
  resume: boolean
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
  const [snap, setSnap] = useState<Snapshot>({ home: '', scannedAt: 0, sessions: [] })
  const [selected, setSelected] = useState<Selected | null>(null)

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

  const groups = useMemo(() => {
    const byCwd = new Map<string, Session[]>()
    for (const s of live) {
      const arr = byCwd.get(s.cwd) ?? []
      arr.push(s)
      byCwd.set(s.cwd, arr)
    }
    const short = (cwd: string) => (snap.home ? cwd.replace(snap.home, '~') : cwd)
    return [...byCwd.entries()]
      .map(([cwd, sessions]) => {
        sessions.sort(
          (a, b) =>
            STATE[a.state].order - STATE[b.state].order ||
            (a.name ?? '').localeCompare(b.name ?? ''),
        )
        const active = sessions.some((s) => s.state === 'working' || s.state === 'waiting')
        return { cwd, short: short(cwd), sessions, active }
      })
      .sort((a, b) => Number(b.active) - Number(a.active) || a.short.localeCompare(b.short))
  }, [live, snap.home])

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
          {groups.length === 0 && <div className="empty">No live sessions.</div>}
          {groups.map((g) => (
            <section key={g.cwd} className={`group${g.active ? ' active' : ''}`}>
              <div className="grouphead">
                <span className="path" title={g.cwd}>
                  {g.short}
                </span>
                <span className="gcount">{g.sessions.length}</span>
              </div>
              <ul className="rows">
                {g.sessions.map((s) => (
                  <li
                    key={s.pid}
                    className={`row state-${s.state}${selected?.pid === s.pid ? ' sel' : ''}`}
                    title={s.stateReason}
                    onClick={() => openSession(s)}
                  >
                    <span className="dot" style={{ background: STATE[s.state].color }} />
                    <span className="name">{s.name ?? <em>pid {s.pid}</em>}</span>
                    <span className="grow" />
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
                  {snap.home ? selected.cwd.replace(snap.home, '~') : selected.cwd}
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
                Opening a session running in iTerm resumes a managed copy here — the original keeps
                running until you close it.
              </p>
            </div>
          )}
        </main>
      </div>
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
