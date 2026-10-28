// The usage help panel (spec MIP2-1498 §4.5), opened with the ? button or
// ⌘⇧U: each window's status, this app's sessions by share of its estimated
// cost, then the Arbiter's tips when it's on, or fixed why, risk and
// what-to-do lines when it's off, capped or failing. Esc or a click outside
// closes it, and focus goes back where it was.

import { useEffect, useRef, useState } from 'react'
import type { Pace, Reading, WindowKind } from '../model/pace.ts'
import { plainHelp, statusLine, tipFacts, type SessionShare } from '../model/usage-help.ts'
import type { TipsResult } from '../../shared/usage.ts'

const clockText = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

/** The window whose pace matters more: the more severe, else 5h. */
function worse(paces: Record<WindowKind, Pace>): WindowKind {
  const rank = (p: Pace) => ['out', 'over', 'tight'].indexOf(p.state)
  const r5 = rank(paces['5h'])
  const r7 = rank(paces['7d'])
  return r7 !== -1 && (r5 === -1 || r7 < r5) ? '7d' : '5h'
}

export function UsagePanel({
  paces,
  lists,
  shares,
  sharesSince = null,
  arbiterOn,
  now,
  onOpen,
  onClose,
}: {
  paces: Record<WindowKind, Pace>
  lists: Record<WindowKind, readonly Reading[]>
  shares: readonly SessionShare[]
  /** When the shares start: the later of the 5h window's start and when the app began counting it. */
  sharesSince?: number | null
  arbiterOn: boolean
  now: number
  onOpen: (sessionId: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [tips, setTips] = useState<TipsResult | null>(null)
  // One request when the panel opens; main reuses its answer for 10 minutes.
  useEffect(() => {
    if (!arbiterOn) return
    let live = true
    void window.ccc.usageTips(tipFacts(paces, lists, shares, now)).then(r => live && setTips(r))
    return () => void (live = false)
  }, [])
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null
    const outside = (ev: MouseEvent) => ref.current?.contains(ev.target as Node) || (ev.target as HTMLElement).closest('.usage-help-btn') || onClose()
    const esc = (ev: KeyboardEvent) => ev.key === 'Escape' && (ev.preventDefault(), onClose())
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', esc, true)
    ref.current?.focus()
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', esc, true)
      back?.focus()
    }
  }, [])

  const kind = worse(paces)
  const plain = plainHelp(kind, paces[kind], lists[kind], shares, now)
  // Nothing to slow down for: no advice, and no risk line (UX review, MIP2-1500).
  const calm = (['5h', '7d'] as const).every(k => paces[k].state === 'onpace' || paces[k].state === 'learning')
  const sinceText = sharesSince === null ? '' : clockText(sharesSince)
  // The shares always cover the 5h window; said so when the panel is about the week.
  const sinceLabel = !sinceText ? '' : kind === '7d' ? ` · since the 5h window began at ${sinceText}` : ` · since ${sinceText}`
  const showTips = tips?.ok === true && tips.tips.length > 0
  return (
    <div className="usage-panel" ref={ref} role="dialog" aria-label="Usage help" tabIndex={-1}>
      <div className="up-sec">
        <p>{statusLine('5h', paces['5h'])}</p>
        <p>{statusLine('7d', paces['7d'])}</p>
      </div>
      <div className="up-sec">
        <div className="up-h">This app's sessions{sinceLabel}</div>
        {shares.length === 0 ? (
          <p className="up-note">No session here has reported a cost in this window yet.</p>
        ) : (
          shares.slice(0, 5).map(s => (
            <button key={s.sessionId} type="button" className="up-row" onClick={() => (onClose(), onOpen(s.sessionId))}>
              <span className="up-name">{s.name}</span>
              {s.model && <span className="up-meta">{s.model}</span>}
              <span className="up-pct">{Math.round(s.share * 100)}%</span>
            </button>
          ))
        )}
        <p className="up-note">Only sessions in this app. Claude, IDEs and other devices count toward the same limit.</p>
      </div>
      {showTips ? (
        <div className="up-sec">
          <div className="up-h">From the Arbiter</div>
          {tips.tips.map((t, i) => (
            <p key={i}>
              {t.text} <span className="up-meta">({t.evidence})</span>
            </p>
          ))}
        </div>
      ) : (
        <div className="up-sec">
          {arbiterOn && tips?.ok === false && tips.reason === 'capped' && <p className="up-note">The Arbiter is at its ${(tips.capUsd ?? 1).toFixed(2)} cap today.</p>}
          {arbiterOn && tips === null && <p className="up-note">Asking the Arbiter…</p>}
          {plain.why && (
            <p>
              <b>Why:</b> {plain.why}
            </p>
          )}
          {calm ? (
            <p>Both windows are on pace.</p>
          ) : (
            <>
              {plain.risk && (
                <p>
                  <b>Risk:</b> {plain.risk}
                </p>
              )}
              <div className="up-h">What to do</div>
              {plain.todo.map(t => (
                <p key={t}>{t}</p>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
