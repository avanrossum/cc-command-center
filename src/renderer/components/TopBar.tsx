// The top bar (spec MIP2-1370 §12): the attention line, state counts and the
// 5h / 7d usage meter. The Arbiter is N3, so the line uses the spec's
// "Arbiter is off" form.

import type { Field, RateLimits, RateLimitWindow } from '@ccc/contract'
import { untilReset } from '../model/format.ts'
import { splitAttention, type Counts } from '../model/fleet.ts'
import { Glyph } from './bits.tsx'

/** The meter hides when its reading is older than this (spec §12). */
const USAGE_MAX_AGE_MS = 10 * 60 * 1000

function Meter({ label, w, now }: { label: string; w: RateLimitWindow | null; now: number }) {
  if (!w) return null
  const heat = w.usedPercent >= 85 ? 'hot' : w.usedPercent >= 65 ? 'warm' : ''
  return (
    <>
      <span>{label}</span>
      <i className={heat}>
        <b style={{ width: `${Math.min(100, w.usedPercent)}%` }} />
      </i>
      <span>{Math.round(w.usedPercent)}%</span>
      <span className="r">{untilReset(w.resetsAt, now)}</span>
    </>
  )
}

export function TopBar({
  line,
  counts,
  usage,
  now,
  railOpen,
  onToggleRail,
  onNew,
}: {
  line: string
  counts: Counts
  usage: Field<RateLimits> | null
  now: number
  railOpen: boolean
  onToggleRail: () => void
  onNew: () => void
}) {
  const { count: needsCount, rest } = splitAttention(line)
  const fresh = usage && now - usage.observedAt <= USAGE_MAX_AGE_MS ? usage : null
  const count = (n: number, kind: Parameters<typeof Glyph>[0]['kind'], label: string) => (
    <span className={n === 0 ? 'zero' : ''}>
      <Glyph kind={kind} /> {n} {label}
    </span>
  )
  return (
    <header className="top">
      <span className="brand">
        <i className="dot" aria-hidden="true" />
        CC Command Center
      </span>
      <button className="newbtn" onClick={onNew} title="New session (⌘N)">
        ＋ New ⌘N
      </button>
      <div className={`attn${counts.needs ? ' has-needs' : ''}`}>
        {needsCount && <span className="n">{needsCount}</span>}
        <span className="t" title={line}>
          {rest.replace(/^ · /, '')}
        </span>
      </div>
      <div className="counts">
        {count(counts.working, 'working', 'working')}
        {count(counts.turn, 'turn', 'your turn')}
        {count(counts.asked, 'blocked', 'asked')}
        {count(counts.idle, 'idle', 'idle')}
      </div>
      {fresh && (
        <div className="usage" title={`From ${fresh.source}`}>
          <Meter label="5h" w={fresh.value.fiveHour} now={now} />
          <Meter label="7d" w={fresh.value.sevenDay} now={now} />
        </div>
      )}
      <button className="rail-toggle" onClick={onToggleRail} title="Show or hide the right rail (⌘⌥0)">
        {railOpen ? 'Rail ▸' : '◂ Rail'}
        {!railOpen && counts.needs > 0 && <span className="badge">{counts.needs}</span>}
      </button>
    </header>
  )
}
