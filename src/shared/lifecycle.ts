// Session lifecycle and contractors (MIP2-1410): assumed dead, roll-off to
// the archive, and which sessions are contractors. Pure functions of the
// snapshot, the app's records and the clock, shared by main (which rolls
// sessions off) and the renderer (which draws them).
//
// Specs: MIP2-1370 §4.1 (lifecycle), MIP2-1393 (contractors). Rulings:
// D-018, D-020 (never roll off), D-022 (contractor rules).

import type { SessionSnapshot } from '@ccc/contract'
import type { SessionMeta } from './store.ts'

export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS
/** No activity for a day: assumed dead (§4.1). */
export const DEAD_AFTER_MS = DAY_MS
/** A contractor skips assumed dead and rolls off a day after its last activity (D-022). */
export const CONTRACTOR_ROLL_OFF_MS = DAY_MS
export const ROLL_OFF_DAYS = { min: 7, max: 14, default: 7 } as const

export function clampRollOffDays(days: number | undefined): number {
  if (typeof days !== 'number' || !Number.isFinite(days)) return ROLL_OFF_DAYS.default
  return Math.min(ROLL_OFF_DAYS.max, Math.max(ROLL_OFF_DAYS.min, Math.round(days)))
}

/**
 * Last activity (§4.1): the latest of a turn starting, a resume, Alex
 * opening or answering it (the app records those as `activityAt`), and the
 * session's start. A card being visible doesn't count.
 */
export function lastActivityOf(s: SessionSnapshot, meta: SessionMeta | undefined): number {
  return Math.max(s.startedAt.value, s.turn?.value.startedAt ?? 0, meta?.activityAt ?? 0)
}

export type Life =
  | { stage: 'live'; deadAt: number | null }
  | { stage: 'dead'; since: number; rollsOffAt: number }
  | { stage: 'rolled'; at: number }

export interface LifeInput {
  lastActivityAt: number
  /** Waiting on Alex: never assumed dead, never rolled off. */
  needsYou: boolean
  /** D-020. */
  neverRollOff: boolean
  contractor: boolean
  /** A contractor's parent has rolled off or been archived. */
  parentGone: boolean
  rollOffDays: number
  now: number
}

export function lifeOf(i: LifeInput): Life {
  if (i.needsYou || i.neverRollOff) return { stage: 'live', deadAt: null }
  if (i.contractor) {
    if (i.parentGone) return { stage: 'rolled', at: i.now }
    const at = i.lastActivityAt + CONTRACTOR_ROLL_OFF_MS
    return i.now >= at ? { stage: 'rolled', at } : { stage: 'live', deadAt: null }
  }
  const deadAt = i.lastActivityAt + DEAD_AFTER_MS
  const rollsOffAt = deadAt + clampRollOffDays(i.rollOffDays) * DAY_MS
  if (i.now >= rollsOffAt) return { stage: 'rolled', at: rollsOffAt }
  if (i.now >= deadAt) return { stage: 'dead', since: deadAt, rollsOffAt }
  return { stage: 'live', deadAt }
}

export type Classification = { kind: 'session' } | { kind: 'contractor'; parentId: string | null; why: 'seen' | 'background' | 'hand' }

/**
 * Session or contractor (MIP2-1393 §3):
 * - Alex's correction wins (`Keep as my session`, `Treat as a contractor`).
 * - A session the app launched, or one placed in a category (by Alex, or
 *   by 0.24 for him), is Alex's. Being in 0.24's registry alone isn't:
 *   Electron recorded every session it saw, contractors included.
 * - A session whose start an app-launched parent's mod saw is that parent's contractor.
 * - Another background session is a contractor with no known parent.
 * - Everything else (interactive sessions Alex started in a terminal) is a session.
 */
export function classify(s: SessionSnapshot, meta: SessionMeta | undefined, parentOf: ReadonlyMap<string, string>): Classification {
  if (meta?.kindOverride === 'session') return { kind: 'session' }
  if (meta?.kindOverride === 'contractor') return { kind: 'contractor', parentId: meta.parentId ?? null, why: 'hand' }
  if (meta?.origin === 'app' || (meta?.categoryId && (meta.placedBy === 'hand' || meta.placedBy === 'import'))) return { kind: 'session' }
  if (parentOf.get(s.sessionId) === AMBIGUOUS || (meta?.headlessChild && !meta.parentId)) return { kind: 'contractor', parentId: null, why: 'seen' }
  const parent = (s.shortId.value && parentOf.get(s.shortId.value)) || parentOf.get(s.sessionId) || meta?.parentId
  if (parent && parent !== s.sessionId) return { kind: 'contractor', parentId: parent, why: 'seen' }
  if (s.kind.value === 'background') return { kind: 'contractor', parentId: null, why: 'background' }
  return { kind: 'session' }
}

/** A headless child that fits more than one parent. */
export const AMBIGUOUS = ''

/** A Bash command that runs `claude -p` / `claude --print`: a headless child. */
const HEADLESS = /(^|[\s;&|(])claude\s(?:[^;&|]*\s)?(?:-p|--print)(\s|$)/

/**
 * Child → parent session id. Keyed by the child's short id for `--bg`
 * children, and by its full session id for headless ones, which have no
 * short id (only background sessions do):
 * - `--bg` children from every parent's reported contractors (exact);
 * - headless (`-p`) children, which `agents --json` lists while they run
 *   (Research MIP2-1419): a
 *   non-background session that started in a parent's folder while that
 *   parent's Bash call ran `claude -p`. With two candidates it maps to
 *   AMBIGUOUS: a contractor with no parent named.
 */
export function parentsOf(sessions: readonly SessionSnapshot[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const p of sessions) for (const c of p.contractors?.value ?? []) map.set(c.shortId, p.sessionId)
  const running = sessions.flatMap(p =>
    (p.toolCalls?.value ?? []).filter(c => c.tool === 'Bash' && c.agentId === null && HEADLESS.test(c.detail ?? '')).map(c => ({ p, at: c.startedAt })),
  )
  if (!running.length) return map
  for (const s of sessions) {
    if (s.kind.value === 'background' || map.has(s.sessionId) || (s.shortId.value && map.has(s.shortId.value))) continue
    const fits = running.filter(r => r.p.sessionId !== s.sessionId && r.p.cwd.value === s.cwd.value && s.startedAt.value >= r.at)
    const parents = new Set(fits.map(r => r.p.sessionId))
    // Two candidates: still a contractor, with no parent named (D-018).
    if (parents.size) map.set(s.sessionId, parents.size === 1 ? [...parents][0]! : AMBIGUOUS)
  }
  return map
}

/** Off the live views: rolled off or archived by hand, and not resurrected since. */
export function inArchive(meta: SessionMeta | undefined): boolean {
  return Boolean(meta?.rolledOffAt || meta?.archivedAt)
}
