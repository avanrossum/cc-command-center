import { useEffect, useMemo, useState } from 'react'

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

  useEffect(() => {
    window.cc.getSessions().then((s) => setSnap(s as Snapshot))
    return window.cc.onSessions((s) => setSnap(s as Snapshot))
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

      <main className="board">
        {groups.length === 0 && <div className="empty">No live Claude Code sessions found.</div>}
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
                <li key={s.pid} className={`row state-${s.state}`} title={s.stateReason}>
                  <span className="dot" style={{ background: STATE[s.state].color }} />
                  <span className="name">
                    {s.name ?? <em>pid {s.pid}</em>}
                    {s.version && <span className="ver">{s.version}</span>}
                  </span>
                  <span className="grow" />
                  <span className="statelabel" style={{ color: STATE[s.state].color }}>
                    {STATE[s.state].label}
                  </span>
                  <span className="meta">{fmtAge(s.transcriptMtimeMs, snap.scannedAt)}</span>
                  <span className="meta pid">#{s.pid}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>
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
