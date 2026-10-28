// The top bar (spec MIP2-1370 §12): the attention line, state counts and the
// 5h / 7d usage meter, with its pace (MIP2-1498 §4). The Arbiter is N3, so the line uses the spec's
// "Arbiter is off" form.

import { useRef } from 'react'
import type { Field, RateLimits, SessionSnapshot } from '@ccc/contract'
import { noteBaselines, sharesOf, type Baselines } from '../model/usage-help.ts'
import { UsagePanel } from './UsagePanel.tsx'
import { SpendIndicator } from './Spend.tsx'
import type { SpendState } from '../../shared/spend.ts'
import { untilReset } from '../model/format.ts'
import { addReading, PACE_LABEL, paceHover, paceOf, paceWords, type Pace, type PaceState, type Reading, type WindowKind } from '../model/pace.ts'
import { splitAttention, type Counts } from '../model/fleet.ts'
import { Glyph } from './bits.tsx'

const HISTORY_KEY = 'ccc.paceHistory'
const BASELINES_KEY = 'ccc.paceBaselines'

function loadBaselines(): Baselines {
  try {
    const b = JSON.parse(localStorage.getItem(BASELINES_KEY) ?? '{}') as Baselines
    return typeof b === 'object' && b !== null ? b : {}
  } catch {
    return {}
  }
}
type History = Record<WindowKind, Reading[]>

function loadHistory(): History {
  try {
    const h = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '{}') as Partial<History>
    return { '5h': Array.isArray(h['5h']) ? h['5h'] : [], '7d': Array.isArray(h['7d']) ? h['7d'] : [] }
  } catch {
    return { '5h': [], '7d': [] }
  }
}

/**
 * Each window's readings and its pace (MIP2-1498 §4). The readings are kept
 * in this window's storage across launches, a convenience only: without
 * them a window shows Learning until three new readings come in.
 */
export function usePace(usage: Field<RateLimits> | null, now: number): { paces: Record<WindowKind, Pace>; lists: Record<WindowKind, readonly Reading[]> } {
  const history = useRef<History | null>(null)
  history.current ??= loadHistory()
  const prev = useRef<Record<WindowKind, PaceState | null>>({ '5h': null, '7d': null })
  const h = history.current
  let changed = false
  for (const [kind, w] of [['5h', usage?.value.fiveHour], ['7d', usage?.value.sevenDay]] as const) {
    if (!usage || !w || w.resetsAt === null) continue
    const next = addReading(h[kind], { at: usage.observedAt, used: w.usedPercent, resetsAt: w.resetsAt })
    if (next.length !== h[kind].length || next.at(-1) !== h[kind].at(-1)) (h[kind] = next), (changed = true)
  }
  if (changed) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(h))
    } catch {
      // Kept for this run only.
    }
  }
  const out = {} as Record<WindowKind, Pace>
  for (const kind of ['5h', '7d'] as const) {
    out[kind] = paceOf(kind, h[kind], now, prev.current[kind])
    if (['onpace', 'tight', 'over'].includes(out[kind].state)) prev.current[kind] = out[kind].state
  }
  return { paces: out, lists: h }
}

/** One meter row (§4.3): the bar keeps its used-color; the dot shows where the rate is heading. */
function Meter({ kind, p, now }: { kind: WindowKind; p: Pace; now: number }) {
  const used = p.used ?? 0
  const heat = used >= 85 ? 'hot' : used >= 65 ? 'warm' : ''
  const empty = p.state === 'reset' || p.state === 'never'
  const words = paceWords(kind, p, now)
  const hover = paceHover(kind, p)
  return (
    <>
      <span title={hover}>{kind}</span>
      <i className={`${heat}${empty ? ' empty' : ''}`} title={hover}>
        {!empty && <b style={{ width: `${Math.min(100, used)}%` }} />}
      </i>
      <span className={p.state === 'stale' ? 'stale-u' : ''} title={hover}>
        {empty ? '—' : `${Math.round(used)}%`}
      </span>
      <span className={`pace-dot ${p.state}`} title={hover} aria-label={`Pace: ${PACE_LABEL[p.state]}`} />
      <span className="r" title={hover}>
        {words ? (
          <>
            <b className={`pace-w ${p.state}`}>{words.word}</b>
            <span className="pace-detail"> · {words.detail}</span>
          </>
        ) : p.state === 'never' || p.state === 'reset' ? (
          ''
        ) : (
          untilReset(p.resetsAt, now)
        )}
      </span>
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
  sessions = [],
  names = new Map(),
  arbiterOn = false,
  help = false,
  onHelp = () => {},
  onOpen = () => {},
  spend = null,
  onSpendSetUp = () => {},
  claudeVersion = null,
}: {
  /** The installed Claude Code, for the simulated spend's price note (MIP2-1498 §5.2). */
  claudeVersion?: string | null
  /** This month's spend (MIP2-1498 §5). */
  spend?: SpendState | null
  onSpendSetUp?: () => void
  line: string
  counts: Counts
  usage: Field<RateLimits> | null
  now: number
  railOpen: boolean
  onToggleRail: () => void
  onNew: () => void
  /** This app's sessions and names, for the help panel's shares (MIP2-1498 §4.5). */
  sessions?: readonly SessionSnapshot[]
  names?: ReadonlyMap<string, string>
  arbiterOn?: boolean
  /** Whether the usage help panel is open; ⌘⇧U toggles it in App. */
  help?: boolean
  onHelp?: (open: boolean) => void
  onOpen?: (sessionId: string) => void
}) {
  const { count: needsCount, rest } = splitAttention(line)
  const { paces: pace, lists } = usePace(usage, now)
  // Each session's cost when the 5h window began, for its share (MIP2-1498 §4.5); kept across launches.
  const baselines = useRef<Baselines | null>(null)
  baselines.current ??= loadBaselines()
  const noted = noteBaselines(baselines.current, '5h', pace['5h'].resetsAt, sessions, now)
  if (noted !== baselines.current) {
    baselines.current = noted
    try {
      localStorage.setItem(BASELINES_KEY, JSON.stringify(noted))
    } catch {
      // Kept for this run only.
    }
  }
  const attention = ['tight', 'over', 'out'].includes(pace['5h'].state) || ['tight', 'over', 'out'].includes(pace['7d'].state)
  const worst = ['out', 'over', 'tight'].find(s => pace['5h'].state === s || pace['7d'].state === s) ?? ''
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
      {/* Always shown: an old reading is marked, not hidden (MIP2-1498 §4.4). */}
      <div className="usage-wrap">
        <div className="usage">
          <Meter kind="5h" p={pace['5h']} now={now} />
          <Meter kind="7d" p={pace['7d']} now={now} />
        </div>
        <button
          type="button"
          className={`usage-help-btn${attention ? ` ${worst}` : ''}`}
          title="What's using your limits (⌘⇧U)"
          aria-expanded={help}
          onClick={() => onHelp(!help)}
        >
          ?
        </button>
        {help && (
          <UsagePanel
            paces={pace}
            lists={lists}
            shares={sharesOf(sessions, names, pace['5h'].resetsAt === null ? undefined : baselines.current[`5h:${pace['5h'].resetsAt}`]?.costs)}
            sharesSince={pace['5h'].resetsAt === null ? null : (baselines.current[`5h:${pace['5h'].resetsAt}`]?.since ?? null)}
            arbiterOn={arbiterOn}
            now={now}
            onOpen={onOpen}
            onClose={() => onHelp(false)}
          />
        )}
      </div>
      <SpendIndicator spend={spend} now={now} names={names} onSetUp={onSpendSetUp} claudeVersion={claudeVersion} />
      <button className="rail-toggle" onClick={onToggleRail} title="Show or hide the right rail (⌘⌥0)">
        {railOpen ? 'Rail ▸' : '◂ Rail'}
        {!railOpen && counts.needs > 0 && <span className="badge">{counts.needs}</span>}
      </button>
    </header>
  )
}
