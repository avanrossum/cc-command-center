// The Arbiter log (D-014): each ranking, card summary (MIP2-1422), cap stop
// and error, newest first, with what it cost. Opened from the rail's Arbiter footer.

import { useEffect, useState } from 'react'
import type { ArbiterLogEntry } from '../../shared/arbiter-state.ts'

const when = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function ArbiterLogSheet({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<ArbiterLogEntry[] | null>(null)
  useEffect(() => void window.ccc.arbiterLog().then(setEntries), [])
  const today = new Date().toDateString()
  const spent = (entries ?? []).filter(e => (e.kind === 'call' || e.kind === 'summary') && new Date(e.at).toDateString() === today).reduce((s, e) => s + (e.usd ?? 0), 0)
  return (
    <div className="sheet-veil" onMouseDown={ev => ev.target === ev.currentTarget && onClose()} onKeyDown={ev => ev.key === 'Escape' && onClose()}>
      <div className="sheet arb-log" role="dialog" aria-label="Arbiter log" tabIndex={-1}>
        <h2>Arbiter log</h2>
        <p className="note">Spent today: ${spent.toFixed(4)}. The Arbiter runs only when the sessions waiting on you change.</p>
        <div className="arch-list">
          {entries && entries.length === 0 && <div className="quiet">No calls yet.</div>}
          {[...(entries ?? [])].reverse().map((e, i) => (
            <div key={`${e.at}-${i}`} className="arb-row">
              <span className="meta">{when(e.at)}</span>
              <span>
                {e.kind === 'call'
                  ? `Ranked ${e.sessions ?? 0} sessions${e.start ? ` · start with ${e.start}` : ''}`
                  : e.kind === 'summary'
                    ? 'Summarized a turn for a card'
                    : e.kind === 'capped'
                    ? 'Stopped at the daily cap'
                    : `Error: ${e.error ?? 'unknown'}`}
              </span>
              <span className="meta">{e.usd !== undefined ? `$${e.usd.toFixed(4)}` : ''}</span>
            </div>
          ))}
        </div>
        <div className="sheet-acts">
          <span className="spacer" />
          <button type="button" className="fchip" onClick={onClose}>
            Close Esc
          </button>
        </div>
      </div>
    </div>
  )
}
