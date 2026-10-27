// The archive (⌘⇧A, MIP2-1370 §4.1) and the roll-off notice. The app never
// deletes a session: rolled-off and hand-archived ones wait here until
// resurrected. Only sessions still in `claude agents --json --all` are
// listed, since a removed one is never offered for resume (MIP2-1393 §4.5).

import { useState } from 'react'
import type { SessionSnapshot } from '@ccc/contract'
import { age, tildify } from '../model/format.ts'
import { inArchive } from '../../shared/lifecycle.ts'
import { categoryLabel, categoryRef } from '../model/fleet.ts'
import { catStyle, useStore } from './Categories.tsx'

type Filter = 'sessions' | 'rolled' | 'mine' | 'contractors'

const date = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

export function Archive({ sessions, only, now, onClose }: { sessions: SessionSnapshot[]; only: string[] | null; now: number; onClose: () => void }) {
  const api = useStore()
  const [filter, setFilter] = useState<Filter>(only ? 'rolled' : 'sessions')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [limit, setLimit] = useState<string[] | null>(only)
  const store = api.store

  const rows = sessions
    .map(s => ({ s, m: store?.sessions[s.sessionId] }))
    .filter(({ s, m }) => inArchive(m) && (!limit || limit.includes(s.sessionId)))
    .filter(({ m }) =>
      filter === 'contractors' ? m?.contractor === true : m?.contractor !== true && (filter === 'sessions' || (filter === 'rolled' ? !!m?.rolledOffAt && !m.archivedAt : !!m?.archivedAt)),
    )
    .sort((a, b) => (b.m?.rolledOffAt ?? b.m?.archivedAt ?? 0) - (a.m?.rolledOffAt ?? a.m?.archivedAt ?? 0))

  const resurrect = async (ids: string[], keep = false) => {
    const r = await window.ccc.resurrect(ids, keep)
    if (!r.ok) return api.notice(`Not resurrected: ${r.error}`)
    setPicked(new Set())
    api.notice(r.count === 1 ? '1 session is back, as Ended.' : `${r.count} sessions are back, as Ended.`)
  }

  return (
    <div className="sheet-veil" onMouseDown={ev => ev.target === ev.currentTarget && onClose()} onKeyDown={ev => ev.key === 'Escape' && onClose()}>
      <div className="sheet archive" role="dialog" aria-label="Archive" tabIndex={-1}>
        <h2>Archive</h2>
        <div className="seg">
          {(
            [
              ['sessions', 'Sessions'],
              ['rolled', 'Rolled off'],
              ['mine', 'Archived by you'],
              ['contractors', 'Contractors'],
            ] as const
          ).map(([v, l]) => (
            <button type="button" key={v} className={`fchip${filter === v ? ' on' : ''}`} onClick={() => setFilter(v)}>
              {l}
            </button>
          ))}
          {limit && (
            <button type="button" className="link" onClick={() => setLimit(null)}>
              Show the whole archive
            </button>
          )}
        </div>
        <div className="arch-list">
          {rows.length === 0 && <div className="quiet">Nothing here.</div>}
          {rows.map(({ s, m }) => {
            const cat = categoryRef(store, s.sessionId)
            const name = s.name.value || m?.name || s.cwd.value.split('/').at(-1) || s.sessionId.slice(0, 8)
            const last = Math.max(s.startedAt.value, s.turn?.value.startedAt ?? 0, m?.activityAt ?? 0)
            return (
              <label key={s.sessionId} className="arch-row">
                <input
                  type="checkbox"
                  checked={picked.has(s.sessionId)}
                  onChange={ev => {
                    const next = new Set(picked)
                    if (ev.target.checked) next.add(s.sessionId)
                    else next.delete(s.sessionId)
                    setPicked(next)
                  }}
                />
                <b>{name}</b>
                <span className="chip" style={catStyle(cat)}>
                  {categoryLabel(cat)}
                </span>
                <span className="mono path" title={s.cwd.value}>
                  {tildify(s.cwd.value)}
                </span>
                <span className="meta">last active {age(now - last)} ago</span>
                <span className="meta">{m?.archivedAt ? `archived by you ${date(m.archivedAt)}` : `rolled off ${date(m?.rolledOffAt ?? now)}`}</span>
                <button type="button" className="fchip" onClick={ev => (ev.preventDefault(), void resurrect([s.sessionId]))}>
                  Resurrect
                </button>
                <button type="button" className="link" title="Resurrect and set Never roll off" onClick={ev => (ev.preventDefault(), void resurrect([s.sessionId], true))}>
                  and keep
                </button>
              </label>
            )
          })}
        </div>
        <div className="sheet-acts">
          <span className="spacer" />
          {picked.size > 0 && (
            <button type="button" className="fchip on" onClick={() => void resurrect([...picked])}>
              Resurrect {picked.size} selected
            </button>
          )}
          <button type="button" className="fchip" onClick={onClose}>
            Close Esc
          </button>
        </div>
      </div>
    </div>
  )
}

/** The sticky roll-off notice (§4.1): stays until Alex acts, across restarts. */
export function RollOffNotice({ onReview }: { onReview: (ids: string[]) => void }) {
  const { store } = useStore()
  const ids = store?.settings.rollOffNotice ?? []
  if (!ids.length) return null
  return (
    <div className="rolloff" role="status">
      {ids.length === 1 ? '1 session has rolled off.' : `${ids.length} sessions have rolled off.`}{' '}
      <button type="button" className="link" onClick={() => onReview(ids)}>
        Review and resurrect if needed
      </button>
      <button type="button" className="fchip" onClick={() => void window.ccc.dismissRollOffNotice()}>
        Dismiss
      </button>
    </div>
  )
}
