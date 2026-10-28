// Fleet: the filter chips and the four groups (spec MIP2-1370 §5).

import { useState } from 'react'
import { catFilter, countFleet, groupFleet, type Entry, type FilterId } from '../model/fleet.ts'
import { NO_SELECTION, selectClick, type Selection } from '../model/selection.ts'
import type { SelfCheckReport } from '@ccc/contract'
import { Card, SessionRow } from './Card.tsx'
import { useStore } from './Categories.tsx'
import { SelfCheckBand } from './SelfCheckBand.tsx'
import { UpdateBand } from './UpdateBand.tsx'

export function Fleet({
  entries,
  rank,
  now,
  filter,
  onFilter,
  selfCheck,
  onOpen,
  selection,
  onSelection,
}: {
  entries: Entry[]
  /** The Arbiter's Needs-you order, session ids; empty for oldest first. */
  rank: readonly string[]
  now: number
  filter: FilterId
  onFilter: (f: FilterId) => void
  selfCheck: SelfCheckReport | null
  onOpen: (sessionId: string) => void
  /** Shared with the sidebar's rows (App). */
  selection: Selection
  onSelection: (s: Selection) => void
}) {
  const [rows, setRows] = useState(false)
  const [showDead, setShowDead] = useState(false)
  const [showOrphans, setShowOrphans] = useState(false)
  const api = useStore()
  const picked = selection.picked
  const [moveOpen, setMoveOpen] = useState(false)
  /** Session ids in the order shown, filled as the groups render, for ⇧-click ranges. */
  const order: string[] = []
  const sel = (id: string) => {
    order.push(id)
    return {
      active: picked !== null,
      on: picked?.has(id) ?? false,
      toggle: () => onSelection(selectClick(selection, id, order, { meta: true, shift: false })!),
      click: (ev: React.MouseEvent) => {
        const next = selectClick(selection, id, order, { meta: ev.metaKey, shift: ev.shiftKey })
        if (next) onSelection(next)
        return next !== null
      },
    }
  }
  const bulk = async (what: 'never' | 'allow' | 'archive' | { move: string | null }) => {
    const ids = [...(picked ?? [])]
    for (const id of ids) {
      if (what === 'archive') await window.ccc.archive(id)
      else if (typeof what === 'object') await window.ccc.place(id, what.move)
      else await window.ccc.setNeverRollOff(id, what === 'never')
    }
    setMoveOpen(false)
    onSelection(NO_SELECTION)
  }
  const counts = countFleet(entries)
  const g = groupFleet(entries, filter, rank)
  const chip = (id: FilterId, label: string, n: number, cat?: string) => (
    <button key={id} className={`fchip${filter === id ? ' on' : ''}`} onClick={() => onFilter(id)}>
      {cat && <i className="sq" style={{ '--cat': cat } as React.CSSProperties} />}
      {label} {n}
    </button>
  )

  return (
    <main className="main">
      <div className="filters">
        {chip('all', 'All', counts.all)}
        {chip('needs', 'Needs you', counts.needs)}
        {[...counts.byCategory.values()].map(({ cat, n }) => chip(catFilter(cat), cat.name, n, cat.color))}
        <span className="spacer" />
        <button className={`fchip${picked ? ' on' : ''}`} onClick={() => onSelection(picked ? NO_SELECTION : { picked: new Set(), anchor: null })} title="Select several sessions. ⌘-click or ⇧-click a session also selects.">
          Select
        </button>
        <button className="fchip" onClick={() => setRows(r => !r)} title="Cards or rows">
          {rows ? 'Rows ▾' : 'Cards ▾'}
        </button>
      </div>

      <SelfCheckBand report={selfCheck} />
      <UpdateBand />
      {entries.length === 0 && <div className="empty">No Claude Code sessions are running.</div>}

      {g.needs.length > 0 && (
        <>
          <div className="grp">
            Needs you · {g.needs.length} <span className="why">oldest first</span>
          </div>
          <div className="grid">
            {g.needs.map(e => (
              <Card key={e.session.sessionId} e={e} now={now} onOpen={onOpen} select={sel(e.session.sessionId)} />
            ))}
          </div>
        </>
      )}

      {g.active.length > 0 && (
        <>
          <div className="grp">
            Everything else · {g.active.length} <span className="why">by category, then name</span>
          </div>
          {rows ? (
            <div className="rows">
              {g.active.map(e => (
                <SessionRow key={e.session.sessionId} e={e} now={now} onOpen={onOpen} select={sel(e.session.sessionId)} />
              ))}
            </div>
          ) : (
            <div className="grid">
              {g.active.map(e => (
                <Card key={e.session.sessionId} e={e} now={now} onOpen={onOpen} select={sel(e.session.sessionId)} />
              ))}
            </div>
          )}
        </>
      )}

      {g.quiet.length > 0 && (
        <>
          <div className="grp">
            Idle and ended · {g.quiet.length} <span className="why">most recent first</span>
          </div>
          <div className="rows">
            {g.quiet.map(e => (
              <SessionRow key={e.session.sessionId} e={e} now={now} onOpen={onOpen} select={sel(e.session.sessionId)} />
            ))}
          </div>
        </>
      )}

      {g.dead.length > 0 && (
        <>
          <div className="grp">
            <button onClick={() => setShowDead(v => !v)}>
              {showDead ? '▾' : '▸'} Assumed dead · {g.dead.length}
            </button>
          </div>
          {showDead && (
            <div className="rows">
              {g.dead.map(e => (
                <SessionRow key={e.session.sessionId} e={e} now={now} onOpen={onOpen} select={sel(e.session.sessionId)} />
              ))}
            </div>
          )}
        </>
      )}
      {g.orphans.length > 0 && (
        <>
          <div className="grp">
            <button onClick={() => setShowOrphans(v => !v)}>
              {showOrphans ? '▾' : '▸'} Contractors · {g.orphans.length} · parent unknown
            </button>
          </div>
          {showOrphans && (
            <div className="rows">
              {g.orphans.map(e => (
                <SessionRow key={e.session.sessionId} e={e} now={now} onOpen={onOpen} select={sel(e.session.sessionId)} />
              ))}
            </div>
          )}
        </>
      )}
      {picked && (
        <div className="bulk-bar" role="toolbar" aria-label="Selected sessions">
          <span className="count">{picked.size} selected</span>
          <button type="button" className="fchip" disabled={!picked.size} onClick={() => void bulk('never')}>
            Never roll off
          </button>
          <button type="button" className="fchip" disabled={!picked.size} onClick={() => void bulk('allow')}>
            Allow roll-off
          </button>
          <span className="chip-wrap">
            <button type="button" className="fchip" disabled={!picked.size} onClick={() => setMoveOpen(o => !o)} aria-haspopup="menu">
              Move to category ›
            </button>
            {moveOpen && (
              <div className="menu up" role="menu">
                {(api.store?.categories ?? []).map(c => (
                  <button key={c.id} role="menuitem" onClick={() => void bulk({ move: c.id })}>
                    <i className="sq" style={{ '--cat': c.color } as React.CSSProperties} />
                    {c.emoji && <span>{c.emoji}</span>} {c.name}
                  </button>
                ))}
                <button role="menuitem" onClick={() => void bulk({ move: null })}>
                  <i className="sq" style={{ '--cat': 'var(--cc-cat-none)' } as React.CSSProperties} /> Uncategorized
                </button>
              </div>
            )}
          </span>
          <button type="button" className="fchip" disabled={!picked.size} onClick={() => void bulk('archive')}>
            Archive
          </button>
          <button type="button" className="fchip on" onClick={() => onSelection(NO_SELECTION)}>
            Done
          </button>
        </div>
      )}
    </main>
  )
}
