// Moving CC Command Center 0.24's sessions in (MIP2-1425; spec MIP2-1379
// §6). Pure: which sessions 0.24 hosts, and whether each can move now.

import type { AppStore, SessionMeta } from '../../shared/store.ts'
import { NEEDS_YOU } from './card-state.ts'
import { categoryRef, type CatRef, type Entry } from './fleet.ts'

/** A session 0.24 runs: imported from its registry, interactive, not moved yet. */
export function inElectron(e: Entry, meta: SessionMeta | undefined): boolean {
  return meta?.origin === 'import' && !meta.movedAt && e.session.kind.value === 'interactive'
}

/** An interactive session started outside this app and not moved in yet: 0.24's, or a terminal's (MIP2-1466). */
export function movable(e: Entry, meta: SessionMeta | undefined): boolean {
  return meta?.origin !== 'app' && !meta?.movedAt && e.session.kind.value === 'interactive'
}

/**
 * §6.2 readiness. `closed`: its 0.24 process has exited (or it's no longer
 * listed), so it can be resumed here. Only an idle session is offered.
 */
export type Readiness = 'ready' | 'wait' | 'answer' | 'closed'

export function readiness(e: Entry | undefined): Readiness {
  if (!e || e.session.pid.value === null) return 'closed'
  if (NEEDS_YOU.has(e.view.state)) return 'answer'
  if (e.view.state === 'working' || e.session.turn?.value.running === true) return 'wait'
  return 'ready'
}

export const READINESS_TEXT: Record<Readiness, string> = {
  ready: 'Idle',
  wait: 'Working: wait until it finishes',
  answer: 'Needs you: answer it first',
  closed: 'Closed in 0.24',
}

/** One row's progress through §6.2's steps. */
export type MovePhase =
  | { kind: 'idle' }
  | { kind: 'waiting' }
  | { kind: 'resuming' }
  | { kind: 'moved' }
  | { kind: 'different'; sessionId: string }
  | { kind: 'failed'; error: string; variant?: 'trust' | 'home' | 'missing' }

/** The next row to resume: the first one waiting whose 0.24 process has exited, unless one is already resuming. */
export function nextToResume(order: readonly string[], phases: Readonly<Record<string, MovePhase>>, entryOf: (id: string) => Entry | undefined): string | null {
  if (order.some(id => phases[id]?.kind === 'resuming')) return null
  return order.find(id => phases[id]?.kind === 'waiting' && readiness(entryOf(id)) === 'closed') ?? null
}

/** After a failure with "stop at the first failure" on, rows still waiting go back to idle. */
export function stopWaiting(phases: Readonly<Record<string, MovePhase>>): Record<string, MovePhase> {
  return Object.fromEntries(Object.entries(phases).map(([id, p]) => [id, p.kind === 'waiting' ? { kind: 'idle' } : p]))
}

/** A session 0.24 had parked (dormant): imported, with no process, and not listed by Claude Code (MIP2-1461). */
export interface Parked {
  id: string
  name: string
  cat: CatRef
  cwd: string
  /** The app's last activity for it, if it has one. */
  activityAt: number | null
  /** Alex hid it from the sidebar (MIP2-1465). */
  hidden: boolean
}

/**
 * Sessions imported from 0.24 that Claude Code doesn't list: neither moved,
 * archived nor removed, with a folder to resume in. 0.24 kept them as
 * dormant and offered to resume them; nothing else in the app shows them,
 * so the move sheet and the sidebar list them as parked (MIP2-1461).
 */
export function parkedSessions(store: AppStore | null, listed: ReadonlySet<string>, includeHidden = false): Parked[] {
  if (!store) return []
  return Object.entries(store.sessions)
    .filter(([id, m]) => m.origin === 'import' && !m.movedAt && !m.archivedAt && !m.removedAt && !!m.cwd && !listed.has(id))
    // Hidden ones only where asked: the move sheet's Show hidden (MIP2-1465).
    .filter(([, m]) => includeHidden || !m.parkedHidden)
    .map(([id, m]) => ({ id, name: m.name || m.cwd!.split('/').at(-1) || id.slice(0, 8), cat: categoryRef(store, id), cwd: m.cwd!, activityAt: m.activityAt ?? null, hidden: m.parkedHidden === true }))
    .sort((a, b) => (b.activityAt ?? 0) - (a.activityAt ?? 0) || a.name.localeCompare(b.name))
}
