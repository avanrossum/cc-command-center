// The usage help panel's content (spec MIP2-1498 §4.5): each window's
// status, this app's sessions by their share of its estimated cost, and the
// Arbiter-off "why, risk and what to do" lines. Pure, so the rules are
// tested without a window. Every line fires only on evidence.

import type { SessionSnapshot, UsageLimit } from '@ccc/contract'
import { creditsMoney, type CreditsSpend } from '../../shared/spend.ts'
import { modelName } from './format.ts'
import type { TipFacts } from '../../shared/usage.ts'
import { clock, dayClock, PACE_LABEL, resetText, span, TRAILING_MS, WINDOW_MS, type Pace, type Reading, type WindowKind } from './pace.ts'

/**
 * Each session's cost when the window began, by window (`kind:resetsAt`),
 * and since when the app has been counting: the later of the window's
 * start and the first time it noted the window.
 */
export type Baselines = Record<string, { since: number; costs: Record<string, number> }>

/**
 * Records a baseline for sessions not yet seen in this window: zero for one
 * started inside it, else its cost now. Older windows are dropped.
 */
export function noteBaselines(b: Baselines, kind: WindowKind, resetsAt: number | null, sessions: readonly SessionSnapshot[], now: number): Baselines {
  if (resetsAt === null) return b
  const key = `${kind}:${resetsAt}`
  const start = resetsAt * 1000 - WINDOW_MS[kind]
  const cur = { ...(b[key]?.costs ?? {}) }
  let changed = !b[key]
  for (const s of sessions) {
    const cost = s.costUsd?.value
    if (cost === undefined || s.sessionId in cur) continue
    cur[s.sessionId] = s.startedAt.value >= start ? 0 : cost
    changed = true
  }
  if (!changed) return b
  const kept = Object.fromEntries(Object.entries(b).filter(([k]) => !k.startsWith(`${kind}:`)))
  return { ...kept, [key]: { since: b[key]?.since ?? Math.max(start, now), costs: cur } }
}

export interface SessionShare {
  sessionId: string
  name: string
  /** `Opus 5.5`, or null when unknown. */
  model: string | null
  effort: string | null
  contextPct: number | null
  /** Cache reads over all input tokens, 0–1. */
  cacheRatio: number | null
  subagents: number
  working: boolean
  /** Share of this app's estimated cost in the window, 0–1. */
  share: number
}

/** `claude-opus-5-5` as `Opus 5.5`. */
export const modelLabel = (id: string | undefined) => {
  if (!id) return null
  const n = modelName(id)
  return n.charAt(0).toUpperCase() + n.slice(1)
}

/** This app's sessions by their share of its estimated cost since the window began, most first. */
export function sharesOf(sessions: readonly SessionSnapshot[], names: ReadonlyMap<string, string>, baseline: Record<string, number> | undefined): SessionShare[] {
  const spent = sessions.map(s => ({ s, usd: Math.max(0, (s.costUsd?.value ?? 0) - (baseline?.[s.sessionId] ?? s.costUsd?.value ?? 0)) }))
  const total = spent.reduce((n, x) => n + x.usd, 0)
  if (total <= 0) return []
  return spent
    .filter(x => x.usd > 0)
    .sort((a, b) => b.usd - a.usd)
    .map(({ s, usd }) => {
      const t = s.tokens?.value
      const input = t ? t.input + t.cacheRead + t.cacheWrite : 0
      return {
        sessionId: s.sessionId,
        name: names.get(s.sessionId) ?? s.sessionId.slice(0, 8),
        model: modelLabel(s.model?.value),
        effort: s.effort?.value ?? null,
        contextPct: s.context?.value.percent ?? null,
        cacheRatio: input > 0 ? t!.cacheRead / input : null,
        subagents: (s.subagents?.value ?? []).filter(a => a.status === 'running').length,
        working: s.activity.value === 'working',
        share: usd / total,
      }
    })
}

const pct = (x: number) => `${Math.round(x * 100)}%`

/** The panel's status line for a window (§4.5 item 1). */
export function statusLine(kind: WindowKind, p: Pace): string {
  if (p.state === 'absent') return `${kind} · Not reported now`
  if (p.used === null || p.resetsAt === null) return `${kind} · No reading yet`
  const head = `${kind} · ${PACE_LABEL[p.state]} · ${Math.round(p.used)}% used`
  if ((p.state === 'tight' || p.state === 'over') && p.projected !== null) return `${head} · ~${Math.round(Math.min(p.projected, 999))}% by ${resetText(kind, p.resetsAt)}`
  return `${head} · resets ${resetText(kind, p.resetsAt)}`
}

/** How many points the window moved over its trailing span, and when it fills at that rate. Null without two readings in the span. */
export function trailing(kind: WindowKind, list: readonly Reading[], now: number): { moved: number; fillsIn: number | null } | null {
  const last = list.at(-1)
  const from = list.find(r => r.at >= now - TRAILING_MS[kind])
  if (!last || !from || from === last) return null
  const moved = last.used - from.used
  const rate = moved / (last.at - from.at)
  return { moved, fillsIn: rate > 0 ? (100 - last.used) / rate : null }
}

/**
 * A limit beside 5h and 7d from Claude Code's /usage (§9.2), with its pace
 * when it has one: a `weekly_*` limit uses the 7d rules; any other kind has
 * none until it's specified.
 */
export interface ExtraLimit {
  key: string
  limit: UsageLimit
  pace: Pace | null
}

/** Its name: the model or scope Claude Code gives, plus `week` for a scoped week; `Other limit` with none (§9.2). */
export function limitLabel(l: UsageLimit): string {
  if (l.kind === 'weekly_scoped') return `${l.label || 'Model'} week`
  return l.label || 'Other limit'
}

/** Whether a limit's pace takes the 7d rules. */
export const pacedLimit = (l: UsageLimit) => l.kind.startsWith('weekly_')

/** Its status line, after 5h and 7d (§9.2). */
export function extraStatusLine(x: ExtraLimit): string {
  const l = x.limit
  const p = x.pace
  const used = Math.round(p?.used ?? l.usedPercent)
  const resets = l.resetsAt === null ? null : resetText('7d', l.resetsAt)
  const head = limitLabel(l)
  if (p && (p.state === 'tight' || p.state === 'over') && p.projected !== null && resets) return `${head} · ${PACE_LABEL[p.state]} · ${used}% used · ~${Math.round(Math.min(p.projected, 999))}% by ${resets}`
  if (p && p.state === 'out') return `${head} · Out · ${used}% used${resets ? ` · resets ${resets}` : ''}`
  // A limit with a pace says its state, as 5h and 7d do (MIP2-1610 UX review); one without says percent and reset.
  return `${head}${p ? ` · ${PACE_LABEL[p.state]}` : ''} · ${used}% used${resets ? ` · resets ${resets}` : ''}`
}

const ALARM = ['tight', 'over', 'out']

/** A scoped limit at Tight or worse: which model stops, until when, and that others keep working (§9.2; Research MIP2-1499). */
export function scopedRisk(x: ExtraLimit): string | null {
  if (x.limit.kind !== 'weekly_scoped' || !x.limit.label || !x.pace || !ALARM.includes(x.pace.state) || x.limit.resetsAt === null) return null
  return `At 100%, ${x.limit.label} stops answering until ${resetText('7d', x.limit.resetsAt)}. Other models keep working.`
}

/** What to do for a scoped limit at Tight or worse, when a session on that model has the largest share (§9.2). */
export function scopedTodo(x: ExtraLimit, shares: readonly SessionShare[]): string | null {
  const model = x.limit.label
  const top = shares[0]
  if (x.limit.kind !== 'weekly_scoped' || !model || !x.pace || !ALARM.includes(x.pace.state) || !top?.model?.startsWith(model)) return null
  return `${top.name} (${top.model}) is ${pct(top.share)} of this app's use. ${model} has its own weekly limit; other models aren't affected by it.`
}

/** The Arbiter-off lines (§4.5 item 4): why, risk, and what to do, each on evidence. */
export function plainHelp(
  kind: WindowKind,
  p: Pace,
  list: readonly Reading[],
  shares: readonly SessionShare[],
  now: number,
  credits: CreditsSpend | null = null,
): { why: string | null; risk: string | null; todo: string[] } {
  const t = trailing(kind, list, now)
  const spanText = kind === '5h' ? 'In the last hour the 5h window' : 'In the last 24 h the week'
  // The fill time only when it comes before the reset; otherwise the window resets first.
  const fills = t?.fillsIn != null && kind === '5h' && p.resetsAt !== null && now + t.fillsIn < p.resetsAt * 1000
  const why = t ? `${spanText} moved ${Math.round(t.moved)} points.${fills ? ` At that rate it fills in ${span(t.fillsIn!)}.` : ''}` : null
  const stop = p.state === 'out' ? "You're at 100%. Claude Code stops answering" : 'At 100%, Claude Code stops answering'
  // Credits reported and on: what's been spent from them; reported and off: nothing continues (§9.1, UX review).
  // The general sentence only when Claude Code doesn't report them.
  const after = !credits
    ? "If usage credits are on, sessions keep going at API rates, billed against your plan's monthly spend limit."
    : credits.enabled
      ? `Usage credits are on: sessions keep going at API rates, ${creditsMoney(credits.used, credits.currency)}${credits.limit !== null ? ` of a ${creditsMoney(credits.limit, credits.currency)} cap` : ''} spent so far this period.`
      : 'Usage credits are off, so nothing continues until then.'
  const risk = p.resetsAt !== null ? `${stop} until the reset at ${resetText(kind, p.resetsAt)}. ${after}` : null
  const todo: string[] = []
  const top = shares[0]
  if (top && top.model && /^(Opus|Fable)/.test(top.model)) {
    // Claude Academy, "Choosing the right Claude model": Opus "uses more of your rate limit". No multiplier is sourced.
    todo.push(`${top.name} (${top.model}) is ${pct(top.share)} of this app's use. Lighter models use less of your limit. If this work doesn't need ${top.model.split(' ')[0]}, Sonnet would slow the pace.`)
  } else if (top && top.share > 0.5) {
    todo.push(`${top.name}${top.model ? ` (${top.model})` : ''} is ${pct(top.share)} of this app's use. Stop it or let it finish if it can wait.`)
  }
  const working = shares.filter(s => s.working).length
  if (working >= 3) todo.push(`${working} sessions are working at once. Each adds to the same limit.`)
  const heavy = shares.find(s => s.effort === 'high' || s.effort === 'max' || s.effort === 'xhigh')
  if (heavy) todo.push(`${heavy.name} runs at ${heavy.effort} effort.`)
  if (!todo.length) todo.push('No single session here stands out. Use outside this app may be adding to it.')
  return { why, risk, todo }
}

export function tipFacts(paces: Record<WindowKind, Pace>, lists: Record<WindowKind, readonly Reading[]>, shares: readonly SessionShare[], now: number, weekly = false): TipFacts {
  // With no 5-hour window, the week only, and 5h said not to be reported (MIP2-1609 §6; only on /usage's word, gate pass 45, M-1).
  const kinds = weekly ? (['7d'] as const) : (['5h', '7d'] as const)
  return {
    ...(weekly ? { fiveHour: 'not reported' as const } : {}),
    windows: kinds.map(kind => {
      const p = paces[kind]
      return {
        kind,
        state: p.state,
        usedPercent: p.used,
        projectedPercent: p.projected === null ? null : Math.round(p.projected),
        resetsIn: p.resetsAt === null ? null : span(Math.max(0, p.resetsAt * 1000 - now)),
        movedPoints: trailing(kind, lists[kind], now)?.moved ?? null,
      }
    }),
    sessions: shares.slice(0, 5).map(s => ({
      name: s.name,
      model: s.model,
      effort: s.effort,
      contextPercent: s.contextPct,
      cacheReadShare: s.cacheRatio === null ? null : Math.round(s.cacheRatio * 100) / 100,
      runningSubagents: s.subagents,
      working: s.working,
      sharePercent: Math.round(s.share * 100),
    })),
  }
}

/** Which windows Claude Code's own `/usage` listed in its last good reading (FleetSnapshot.usageReported). */
export type Reported = { value: { fiveHour: boolean; sevenDay: boolean }; stale: boolean }

/**
 * Claude Code's usage report shows no 5-hour window (MIP2-1609 §2; the
 * panel says what the report shows now, gate pass 46, M-1, with Research's
 * wording from MIP2-1614): only on a positive sign, a fresh `/usage` reading that
 * lists the week and no 5-hour window, with no 5h shown from any source
 * (gate pass 45, M-1). A 5h missing for any other reason, such as a
 * statusline reading without its reset or `/usage` not read, stays the
 * neutral "Not reported" of MIP2-1590.
 */
export const weeklyOnly = (paces: Record<WindowKind, Pace>, reported: Reported | null | undefined): boolean =>
  !!reported && !reported.stale && reported.value.sevenDay && !reported.value.fiveHour && paces['5h'].state === 'absent' && paces['7d'].state !== 'absent'

const SEVERE = ['out', 'over', 'tight']
/** Lower is more severe: Out, Over, Tight, then everything else. */
export const severity = (p: Pace) => (SEVERE.includes(p.state) ? SEVERE.indexOf(p.state) : SEVERE.length)

/** One row of the top bar's meter: its label, the pace rules it takes, and its pace. */
export interface BarRow {
  key: string
  label: string
  kind: WindowKind
  pace: Pace
}

/**
 * The bar's rows (MIP2-1609 §3): 5h and 7d, or, with no 5-hour window, 7d
 * and the most severe scoped weekly limit by the label Claude Code gives it,
 * on the 7d rules. The first of equals wins. With no scoped limit, 7d alone.
 */
export function barRows(paces: Record<WindowKind, Pace>, extras: readonly ExtraLimit[], weekly: boolean): BarRow[] {
  const row = (kind: WindowKind): BarRow => ({ key: kind, label: kind, kind, pace: paces[kind] })
  if (!weekly) return [row('5h'), row('7d')]
  let top: (ExtraLimit & { pace: Pace }) | null = null
  for (const x of extras) if (x.limit.kind === 'weekly_scoped' && x.pace && (!top || severity(x.pace) < severity(top.pace))) top = x as ExtraLimit & { pace: Pace }
  return [row('7d'), ...(top ? [{ key: top.key, label: top.limit.label || 'Model', kind: '7d' as const, pace: top.pace }] : [])]
}

/** The window the panel's shares are counted over (MIP2-1609 §5): 5h when reported, otherwise this week. */
export const baseWindow = (weekly: boolean): WindowKind => (weekly ? '7d' : '5h')

/** The shares heading's tail (MIP2-1609 §5): `since 10:45 AM` over 5h, `this week, since Tue 9:14 AM` over 7d. */
export function sharesSinceText(base: WindowKind, since: number | null): string {
  if (since === null) return ''
  return base === '5h' ? `since ${clock(since)}` : `this week, since ${dayClock(since)}`
}

/** The calm line, by how many windows have a pace (MIP2-1610 UX review): the week alone, both, or all. */
export function calmLine(windows: number): string {
  if (windows === 0) return "Claude Code isn't reporting any usage limits right now."
  return windows === 1 ? 'The week is on pace.' : windows === 2 ? 'Both windows are on pace.' : 'All windows are on pace.'
}

/** The note after the status lines when there's no 5-hour window (MIP2-1609 §6). */
export const NO_FIVE_HOUR_NOTE = "Claude Code's usage report shows no 5-hour window right now. Verified Ultra accounts don't have one."
