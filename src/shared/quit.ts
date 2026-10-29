// Closing sessions when the app quits (MIP2-1528, spec MIP2-1462). Pure, so
// main decides from it and the window shows the same thing.

import type { SessionSnapshot } from '@ccc/contract'
import type { SessionMeta } from './store.ts'

/** Settings → General → "When the app quits" (§6). Absent is `ask`. */
export type QuitSessions = 'ask' | 'close' | 'keep'

/** Why a closable session starts as "keep running" (§5.1): stopping it would end a turn or a wait. */
export type QuitBusy = 'working' | 'waiting'

export interface QuitRow {
  sessionId: string
  busy: QuitBusy | null
}

/** The most the app waits for the stops before it quits anyway (§7). */
export const QUIT_STOP_MS = 15_000

/**
 * Sessions the app may stop on quit (§3): running background sessions the
 * app launched or moved in, not archived or removed, never a contractor.
 * The same rule roll-off stops by (app-store.ts observe).
 */
export function closable(sessions: readonly SessionSnapshot[], meta: Readonly<Record<string, SessionMeta | undefined>>): QuitRow[] {
  return sessions.flatMap(s => {
    const m = meta[s.sessionId]
    if (!m || s.pid.value === null || s.pid.stale || s.kind.value !== 'background') return []
    if (m.origin !== 'app' && m.movedAt === undefined) return []
    if (m.archivedAt !== undefined || m.removedAt !== undefined || m.contractor === true || m.kindOverride === 'contractor') return []
    return [{ sessionId: s.sessionId, busy: busyOf(s) }]
  })
}

/** Working (a turn or a subagent running) or waiting on Alex (§5.1), blocked on him included; null otherwise. */
export function busyOf(s: SessionSnapshot): QuitBusy | null {
  if (s.activity.value === 'waiting' || s.needsYou.value !== null || (s.pendingRequests?.value ?? []).length > 0) return 'waiting'
  if (s.activity.value === 'working' || s.turn?.value.running === true || (s.subagents?.value ?? []).some(a => a.status === 'running')) return 'working'
  return null
}

/** What the window answers on the modal. `keep` lists the ids that keep running under `close`. */
export type QuitAnswer = { action: 'cancel' } | { action: 'keep'; remember: boolean } | { action: 'close'; keep: string[]; remember: boolean }

/** A checked answer from the window, or null. Ids are only ever narrowed by main to what's closable. */
export function checkQuitAnswer(v: unknown): QuitAnswer | null {
  if (typeof v !== 'object' || v === null) return null
  const a = v as { action?: unknown; keep?: unknown; remember?: unknown }
  if (a.action === 'cancel') return { action: 'cancel' }
  const remember = a.remember === true
  if (a.remember !== undefined && typeof a.remember !== 'boolean') return null
  if (a.action === 'keep') return { action: 'keep', remember }
  if (a.action === 'close' && Array.isArray(a.keep) && a.keep.length <= 1000 && a.keep.every(id => typeof id === 'string' && id.length <= 64)) {
    return { action: 'close', keep: a.keep as string[], remember }
  }
  return null
}

/** Which ids to stop: the closable ones the answer doesn't keep, recomputed now. */
export function toStop(rows: readonly QuitRow[], keep: Iterable<string>): string[] {
  const kept = new Set(keep)
  return rows.filter(r => !kept.has(r.sessionId)).map(r => r.sessionId)
}

/** A remembered `close` (§6): like Yes, sessions working or waiting on Alex keep running. */
export function rememberedStops(rows: readonly QuitRow[]): string[] {
  return rows.filter(r => r.busy === null).map(r => r.sessionId)
}

/** The stops before the app quits (§7): every id being stopped, and which have stopped or failed so far. */
export interface QuitProgress {
  stopping: string[]
  done: string[]
  failed: string[]
}

/** What the last quit did, for the toast on the next launch (§6, §7). */
export interface QuitReport {
  /** Sessions stopped. */
  closed: number
  /** Names of sessions whose stop failed or timed out. */
  failed: string[]
  /** The remembered choice closed them without asking. */
  silent: boolean
}

export function quitNotices(r: QuitReport): string[] {
  const out: string[] = []
  if (r.silent && r.closed > 0) out.push(`Closed ${r.closed} ${r.closed === 1 ? 'session' : 'sessions'} when the app quit. Change this in Settings → General.`)
  if (r.failed.length) {
    const n = r.failed.length
    out.push(`Couldn't stop ${n} ${n === 1 ? 'session' : 'sessions'} when the app quit: ${r.failed.join(', ')}. ${n === 1 ? "It's" : "They're"} still running.`)
  }
  return out
}
