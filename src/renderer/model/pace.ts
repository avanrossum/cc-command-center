// The pace meter (spec MIP2-1498 §4; Research MIP2-1499 §1): where each usage
// window is heading at the recent rate. Pure, so it's tested without a
// window. A reading refreshes only when a session here makes a request, so
// its age is part of every state.

import { untilReset } from './format.ts'

export type WindowKind = '5h' | '7d'
export type PaceState = 'never' | 'reset' | 'out' | 'stale' | 'learning' | 'onpace' | 'tight' | 'over'

export interface Reading {
  /** When the reading was taken, Unix ms. */
  at: number
  /** 0–100. */
  used: number
  /** When the window resets, Unix seconds. */
  resetsAt: number
}

const HOUR = 3_600_000
export const WINDOW_MS: Record<WindowKind, number> = { '5h': 5 * HOUR, '7d': 7 * 24 * HOUR }
/** The trailing slope's span (§4.1). */
export const TRAILING_MS: Record<WindowKind, number> = { '5h': HOUR, '7d': 24 * HOUR }
/** Learning until this long into a window (§4.2). */
export const LEARNING_MS: Record<WindowKind, number> = { '5h': 30 * 60_000, '7d': 6 * HOUR }
export const LEARNING_READINGS = 3
/** A reading older than this is Stale (§4.4). */
export const STALE_MS = 10 * 60_000
export const TIGHT_AT = 90
/** A state moves to a less severe one only this many points inside its band (§4.1). */
export const HYSTERESIS = 2
/** A reset time that moves by more than this starts a new window. */
const SAME_RESET_S = 60
/** Readings kept per window. */
const KEEP = 400

/** The readings of one window, oldest first; a reading for another reset time starts the list over. */
export function addReading(list: readonly Reading[], r: Reading): Reading[] {
  const last = list.at(-1)
  if (last && Math.abs(last.resetsAt - r.resetsAt) > SAME_RESET_S) return [r]
  if (last && r.at <= last.at) return [...list]
  return [...list, r].slice(-KEEP)
}

/**
 * Percentage points per ms: the average of the rate since the window began
 * and the slope over the trailing span (§4.1). The slope needs two readings
 * at least five minutes apart in that span; without it, the first rate alone.
 */
export function rateOf(kind: WindowKind, list: readonly Reading[], now: number): number {
  const last = list.at(-1)
  if (!last) return 0
  const start = last.resetsAt * 1000 - WINDOW_MS[kind]
  const sinceStart = last.used / Math.max(60_000, last.at - start)
  const from = list.find(r => r.at >= now - TRAILING_MS[kind])
  if (!from || last.at - from.at < 5 * 60_000) return sinceStart
  const slope = Math.max(0, (last.used - from.used) / (last.at - from.at))
  return (sinceStart + slope) / 2
}

export interface Pace {
  state: PaceState
  used: number | null
  resetsAt: number | null
  /** Projected percent at the reset, for on pace, tight and over. */
  projected: number | null
  /** When it reaches 100%, Unix ms, for over. */
  outAt: number | null
  /** The reading's age, ms. */
  age: number | null
}

const SEVERITY: Partial<Record<PaceState, number>> = { onpace: 0, tight: 1, over: 2 }

/**
 * Hysteresis (§4.1): from Over, Tight needs the projection at or below 98%
 * and On pace below 88%; from Tight, On pace needs below 88%. More severe
 * states apply at once.
 */
export function settle(next: 'onpace' | 'tight' | 'over', prev: PaceState | null, projected: number): 'onpace' | 'tight' | 'over' {
  const was = prev === null ? undefined : SEVERITY[prev]
  if (was === undefined || SEVERITY[next]! >= was) return next
  if (prev === 'over' && projected > 100 - HYSTERESIS) return 'over'
  return projected < TIGHT_AT - HYSTERESIS ? 'onpace' : 'tight'
}

/** Each state in words, for the panel and screen readers. */
export const PACE_LABEL: Record<PaceState, string> = { onpace: 'On pace', tight: 'Tight', over: 'Over', out: 'Out', learning: 'Learning', stale: 'Stale', reset: 'Reset', never: 'No reading' }

/** The projected state, before hysteresis. */
function band(projected: number): 'onpace' | 'tight' | 'over' {
  return projected > 100 ? 'over' : projected >= TIGHT_AT ? 'tight' : 'onpace'
}

/**
 * A window's pace. `prev` is the last projected state shown, for
 * hysteresis: Tight holds until the projection is below 88%, and Over until
 * it's at or below 98%.
 */
export function paceOf(kind: WindowKind, list: readonly Reading[], now: number, prev: PaceState | null = null): Pace {
  const last = list.at(-1)
  if (!last) return { state: 'never', used: null, resetsAt: null, projected: null, outAt: null, age: null }
  const base = { used: last.used, resetsAt: last.resetsAt, age: now - last.at }
  const resetMs = last.resetsAt * 1000
  if (now >= resetMs) return { ...base, state: 'reset', projected: null, outAt: null }
  if (last.used >= 100) return { ...base, state: 'out', projected: null, outAt: null }
  const rate = rateOf(kind, list, now)
  const projected = last.used + rate * (resetMs - now)
  const outAt = projected > 100 && rate > 0 ? now + (100 - last.used) / rate : null
  if (now - last.at > STALE_MS) return { ...base, state: 'stale', projected, outAt }
  const start = resetMs - WINDOW_MS[kind]
  if (now - start < LEARNING_MS[kind] || list.length < LEARNING_READINGS) return { ...base, state: 'learning', projected, outAt }
  return { ...base, state: settle(band(projected), prev, projected), projected, outAt }
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
const dayClock = (ms: number) => `${new Date(ms).toLocaleDateString('en-US', { weekday: 'short' })} ${clock(ms)}`
/** A reset time as the row says it: `3:45 PM` for 5h, `Sat 3:00 PM` for 7d. */
export const resetText = (kind: WindowKind, resetsAtSec: number) => (kind === '5h' ? clock(resetsAtSec * 1000) : dayClock(resetsAtSec * 1000))
/** A duration as `1h 40m`, `9m`, `4d 3h`. */
export const span = (ms: number) => untilReset(ms / 1000, 0)

/** The word and projection that replace the countdown when the pace isn't quiet (§4.2); null keeps the countdown. */
export function paceWords(kind: WindowKind, p: Pace, now: number): { word: string; detail: string } | null {
  if (p.state === 'tight' && p.projected !== null) return { word: 'Tight', detail: `~${Math.round(p.projected)}% at reset` }
  // 5h gives the time left; 7d how early the limit comes (§4.2).
  if (p.state === 'over' && p.outAt !== null && p.resetsAt !== null) {
    return { word: 'Over', detail: kind === '5h' ? `out in ${span(p.outAt - now)}` : `out ${span(p.resetsAt * 1000 - p.outAt)} early` }
  }
  if (p.state === 'out' && p.resetsAt !== null) return { word: 'Out', detail: `resets ${resetText(kind, p.resetsAt)}` }
  return null
}

const ago = (ms: number) => (ms < 60_000 ? 'just now' : `${span(ms)} ago`)

/** The row's hover (§4.3, §4.4). */
export function paceHover(kind: WindowKind, p: Pace): string {
  const learn = kind === '5h' ? '30 min' : '6 h'
  switch (p.state) {
    case 'never':
      return `No reading yet. It comes with the next request a session here sends.`
    case 'reset':
      return `Reset at ${resetText(kind, p.resetsAt!)}. Waiting for a new reading.`
    case 'stale':
      return `Reading from ${ago(p.age!)}. It updates when a session here sends a request. Use on claude.ai or other devices isn't shown until then.`
    default: {
      const head = `${kind} · ${Math.round(p.used!)}% used · resets ${resetText(kind, p.resetsAt!)}.`
      const pace = p.state === 'learning' ? ` Pace shows after ${learn} of use in this window.` : p.state === 'out' ? '' : p.projected !== null ? ` At your recent rate, ~${Math.round(Math.min(p.projected, 999))}% at reset.` : ''
      return `${head}${pace} Reading from ${ago(p.age!)}.`
    }
  }
}
