// The spend indicator and its panel (spec MIP2-1498 §5): this calendar
// month, real (the Console's cost, with a Console key) or simulated (Claude
// Code's own per-session estimate, marked ≈). No token counts.

import { useEffect, useRef, useState } from 'react'
import type { SpendState } from '../../shared/spend.ts'
import { modelLabel } from '../model/usage-help.ts'
import { span } from '../model/pace.ts'

const MONTH = (now: number, style: 'short' | 'long') => new Date(now).toLocaleDateString('en-US', { month: style })
const NEXT_MONTH = (now: number) => {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
const usd = (n: number) => `$${n.toFixed(2)}`
/** A real amount older than this, or after a failed poll, is marked stale. */
const REAL_STALE_MS = 30 * 60_000

/** The top line's amount and whether it's marked stale (§5.4). */
export function spendAmount(s: SpendState, now: number): { text: string; stale: boolean } {
  if (s.source === 'simulated') return { text: `≈${usd(s.simulated.totalUsd)}`, stale: false }
  if (!s.real.configured || s.real.totalUsd === null) return { text: '$—', stale: false }
  return { text: usd(s.real.totalUsd), stale: s.real.error !== null || (s.real.at !== null && now - s.real.at > REAL_STALE_MS) }
}

export function spendHover(s: SpendState, now: number): string {
  return s.source === 'real'
    ? `Console spend for ${MONTH(now, 'long')}, through today. Resets ${NEXT_MONTH(now)}.`
    : `${MONTH(now, 'long')}'s sessions here at Claude Code's list prices. Not money spent.`
}

export function SpendIndicator({
  spend,
  now,
  names,
  onSetUp,
  claudeVersion = null,
}: {
  spend: SpendState | null
  now: number
  names: ReadonlyMap<string, string>
  onSetUp: () => void
  claudeVersion?: string | null
}) {
  const [open, setOpen] = useState(false)
  if (!spend) return null
  const amount = spendAmount(spend, now)
  return (
    <div className="spend-wrap">
      <button type="button" className="spend" title={spendHover(spend, now)} aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className={`spend-amt${amount.stale ? ' stale-u' : ''}`}>{amount.text}</span>
        <span className="spend-sub">
          {MONTH(now, 'short')} · {spend.source === 'real' ? 'real' : 'sim'}
        </span>
      </button>
      {open && <SpendPanel spend={spend} now={now} names={names} claudeVersion={claudeVersion} onSetUp={() => (setOpen(false), onSetUp())} onClose={() => setOpen(false)} />}
    </div>
  )
}

function SpendPanel({
  spend,
  now,
  names,
  claudeVersion,
  onSetUp,
  onClose,
}: {
  spend: SpendState
  now: number
  names: ReadonlyMap<string, string>
  claudeVersion: string | null
  onSetUp: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null
    const outside = (ev: MouseEvent) => ref.current?.contains(ev.target as Node) || (ev.target as HTMLElement).closest('.spend') || onClose()
    const esc = (ev: KeyboardEvent) => ev.key === 'Escape' && (ev.preventDefault(), onClose())
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', esc, true)
    ref.current?.focus()
    return () => (document.removeEventListener('mousedown', outside), document.removeEventListener('keydown', esc, true), back?.focus())
  }, [])
  const setSource = (source: 'real' | 'simulated') => void window.ccc.setSpendSource(source)
  const sim = spend.simulated
  const real = spend.real
  return (
    <div className="usage-panel spend-panel" ref={ref} role="dialog" aria-label="Spend" tabIndex={-1}>
      <div className="seg" role="radiogroup" aria-label="Spend source">
        {(['real', 'simulated'] as const).map(src => (
          <button key={src} type="button" role="radio" aria-checked={spend.source === src} className={spend.source === src ? 'on' : ''} onClick={() => setSource(src)}>
            {src === 'real' ? 'Real' : 'Simulated'}
          </button>
        ))}
      </div>
      <p className="up-note">
        {MONTH(now, 'long')} · resets {NEXT_MONTH(now)}
      </p>
      {spend.source === 'simulated' ? (
        <>
          {sim.totalUsd === 0 && sim.topSessions.length === 0 ? (
            <p>No sessions this month yet.</p>
          ) : (
            <div className="up-sec">
              <p className="spend-big">≈{usd(sim.totalUsd)}</p>
              <div className="up-h">Sessions</div>
              {sim.topSessions.map(s => (
                <div key={s.sessionId} className="up-row static">
                  <span className="up-name">{names.get(s.sessionId) ?? `Session ${s.sessionId.slice(0, 8)}`}</span>
                  <span className="up-pct">≈{usd(s.usd)}</span>
                </div>
              ))}
              <ModelSplit rows={sim.byModel} approx />
              <p>Today: ≈{usd(sim.todayUsd)}</p>
            </div>
          )}
          {sim.noCost > 0 && <p className="up-note">{sim.noCost === 1 ? "1 session didn't report a cost." : `${sim.noCost} sessions didn't report a cost.`}</p>}
          <p className="up-note">
            At {claudeVersion ? `Claude Code ${claudeVersion}` : "Claude Code's"} list prices. Subscription sessions aren't billed this way. The Arbiter isn't included; its spend is in the right rail.
          </p>
        </>
      ) : !real.configured ? (
        <div className="up-sec">
          <p>Real spend needs an Anthropic Console organization and a Console key: an Admin key, or a personal or service-account key.</p>
          <button type="button" className="fchip on" onClick={onSetUp}>
            Set up…
          </button>
        </div>
      ) : (
        <>
          {real.error && (
            <p className="up-note">
              {real.at !== null ? `As of ${span(now - real.at)} ago. ` : ''}
              {real.error}
            </p>
          )}
          {real.totalUsd !== null && (
            <div className="up-sec">
              <p className="spend-big">{usd(real.totalUsd)}</p>
              <ModelSplit rows={real.byModel} />
              {real.todayUsd !== null && <p>Today: {usd(real.todayUsd)}</p>}
            </div>
          )}
          <p className="up-note">It includes the Arbiter and any session started with an API key. Cost data comes in daily buckets, so today can trail by a few minutes.</p>
          <p className="up-note">Usage credits on your Claude plan aren't included. They're in claude.ai Settings &gt; Usage.</p>
        </>
      )}
    </div>
  )
}

function ModelSplit({ rows, approx = false }: { rows: readonly { model: string; usd: number }[]; approx?: boolean }) {
  if (!rows.length) return null
  return (
    <>
      <div className="up-h">By model</div>
      {rows.map(r => (
        <div key={r.model} className="up-row static">
          <span className="up-name">{r.model.startsWith('claude-') ? modelLabel(r.model) : r.model}</span>
          <span className="up-pct">
            {approx ? '≈' : ''}
            {usd(r.usd)}
          </span>
        </div>
      ))}
    </>
  )
}
