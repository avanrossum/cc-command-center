// The usage help panel (spec MIP2-1498 §4.5), opened with the ? button or
// ⌘⇧U: each window's status, this app's sessions by share of its estimated
// cost, then the Arbiter's tips when it's on, or fixed why, risk and
// what-to-do lines when it's off, capped or failing. Esc or a click outside
// closes it, and focus goes back where it was.

import { useEffect, useRef, useState } from 'react'
import type { Pace, Reading, WindowKind } from '../model/pace.ts'
import { calmLine, extraStatusLine, NO_FIVE_HOUR_NOTE, plainHelp, scopedRisk, scopedTodo, severity, sharesSinceText, statusLine, tipFacts, type ExtraLimit, type SessionShare } from '../model/usage-help.ts'
import type { CreditsSpend } from '../../shared/spend.ts'
import type { TipsResult } from '../../shared/usage.ts'

const clockText = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

/** The window whose pace matters more: the more severe, else 5h; 7d when 5h isn't reported (MIP2-1609 §4). */
function worse(paces: Record<WindowKind, Pace>): WindowKind {
  if (paces['5h'].state === 'absent') return '7d'
  const rank = (p: Pace) => ['out', 'over', 'tight'].indexOf(p.state)
  const r5 = rank(paces['5h'])
  const r7 = rank(paces['7d'])
  return r7 !== -1 && (r5 === -1 || r7 < r5) ? '7d' : '5h'
}

export function UsagePanel({
  paces,
  lists,
  extras = [],
  credits = null,
  shares,
  sharesSince = null,
  base = '5h',
  weekly = false,
  arbiterOn,
  now,
  onOpen,
  onClose,
}: {
  paces: Record<WindowKind, Pace>
  lists: Record<WindowKind, readonly Reading[]>
  /** Limits beside 5h and 7d from Claude Code's /usage (MIP2-1498 §9.2). */
  extras?: readonly ExtraLimit[]
  /** Usage credits, when Claude Code reports them, for the risk line (§9.1). */
  credits?: CreditsSpend | null
  shares: readonly SessionShare[]
  /** When the shares start: the later of the base window's start and when the app began counting it. */
  sharesSince?: number | null
  /** The window the shares are counted over: 5h, or 7d when there's no 5-hour window (MIP2-1609 §5). */
  base?: WindowKind
  /** No 5-hour window, on the word of Claude Code's own /usage (MIP2-1609; gate pass 45, M-1). */
  weekly?: boolean
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
    void window.ccc.usageTips(tipFacts(paces, lists, shares, now, weekly)).then(r => live && setTips(r))
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
  const plain = plainHelp(kind, paces[kind], lists[kind], shares, now, credits)
  // A window that isn't reported has nothing to slow down for (MIP2-1609 §4).
  const quiet = (p: Pace) => p.state === 'onpace' || p.state === 'learning' || p.state === 'absent'
  // Nothing to slow down for: no advice, and no risk line (UX review, MIP2-1500).
  const windowsCalm = (['5h', '7d'] as const).every(k => quiet(paces[k]))
  const calm = windowsCalm && extras.every(x => !x.pace || quiet(x.pace))
  const scopedRisks = extras.flatMap(x => scopedRisk(x) ?? [])
  const scopedTodos = extras.flatMap(x => scopedTodo(x, shares) ?? [])
  const sinceText = sharesSince === null ? '' : clockText(sharesSince)
  // Shares over 5h say so when the panel is about the week; over 7d the heading names the week (MIP2-1609 §5).
  const sinceLabel = !sinceText ? '' : base === '7d' ? ` · ${sharesSinceText('7d', sharesSince)}` : kind === '7d' ? ` · since the 5h window began at ${sinceText}` : ` · ${sharesSinceText('5h', sharesSince)}`
  const sinceShort = sharesSince === null ? '' : base === '7d' ? sharesSinceText('7d', sharesSince).replace(/^this week, /, '') : sharesSinceText('5h', sharesSince)
  // With no 5-hour window: the reported limits, most severe first, 7d ahead of a scoped week on a tie, then the note (§6).
  const lines = weekly
    ? [{ key: '7d', text: statusLine('7d', paces['7d']), rank: severity(paces['7d']) }, ...extras.map(x => ({ key: x.key, text: extraStatusLine(x), rank: x.pace ? severity(x.pace) : 4 }))].sort((a, b) => a.rank - b.rank)
    : [{ key: '5h', text: statusLine('5h', paces['5h']) }, { key: '7d', text: statusLine('7d', paces['7d']) }, ...extras.map(x => ({ key: x.key, text: extraStatusLine(x) }))]
  const showTips = tips?.ok === true && tips.tips.length > 0
  return (
    <div className="usage-panel" ref={ref} role="dialog" aria-label="Usage help" tabIndex={-1}>
      <div className="up-sec">
        {lines.map(l => (
          <p key={l.key}>{l.text}</p>
        ))}
        {weekly && <p className="up-note">{NO_FIVE_HOUR_NOTE}</p>}
      </div>
      <div className="up-sec">
        <div className="up-h">This app's sessions{sinceLabel}</div>
        {shares.length === 0 ? (
          <p className="up-note">{sinceShort ? `No session here has reported a cost ${sinceShort}.` : 'No session here has reported a cost in this window yet.'}</p>
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
            <p>{calmLine((['5h', '7d'] as const).filter(k => paces[k].state !== 'absent').length + extras.filter(x => x.pace).length)}</p>
          ) : (
            <>
              {!windowsCalm && plain.risk && (
                <p>
                  <b>Risk:</b> {plain.risk}
                </p>
              )}
              {scopedRisks.map(r => (
                <p key={r}>
                  <b>Risk:</b> {r}
                </p>
              ))}
              <div className="up-h">What to do</div>
              {[...scopedTodos, ...plain.todo].map(t => (
                <p key={t}>{t}</p>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
