// Small pieces every region uses. All session text is rendered as React
// text children, which React writes with textContent (D-019).

import type { Field } from '@ccc/contract'
import { isStale, type CardState, type Glyph as GlyphKind } from '../model/card-state.ts'
import { age } from '../model/format.ts'

export function Glyph({ kind }: { kind: GlyphKind }) {
  return <i className={`g g-${kind}`} aria-hidden="true" />
}

/** The token each state flashes and tints with (spec §8, §9). */
export const STATE_COLOR: Record<CardState, string> = {
  approval: 'var(--cc-needs)',
  sandbox: 'var(--cc-needs)',
  request: 'var(--cc-needs)',
  question: 'var(--cc-question)',
  working: 'var(--cc-working)',
  turn: 'var(--cc-turn)',
  asked: 'var(--cc-blocked)',
  agents: 'var(--cc-blocked)',
  idle: 'var(--cc-idle)',
  ended: 'var(--cc-ended)',
  dead: 'var(--cc-dead)',
}

/**
 * A field's text, marked when stale (spec §13): a dashed underline and its
 * age, with "as of <age> ago" on hover. A field never received shows
 * `<label> —`.
 */
export function FieldText({
  f,
  label,
  now,
  children,
}: {
  f: Field<unknown> | undefined
  label: string
  now: number
  children?: React.ReactNode
}) {
  if (!f) {
    return (
      <span className="f-missing" title={`No ${label} reported yet`}>
        {label} —
      </span>
    )
  }
  if (!isStale(f, now)) return <span>{children}</span>
  const ago = age(now - f.observedAt)
  return (
    <span className="f-stale" title={`as of ${ago} ago, from ${f.source}`}>
      {children}
      <sup>{ago}</sup>
    </span>
  )
}
