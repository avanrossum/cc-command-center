// Reads `claude agents --json` output and maps each entry to the contract.
// The documented fields are in code.claude.com/docs/en/agent-view.md, "List
// sessions as JSON" and "Read session state from a script" (read 2026-10-26,
// Claude Code 2.1.311). Fields this version doesn't know are ignored; values
// it doesn't know map to `unknown` or `other`, so a new value degrades one
// field instead of dropping the session.

import {
  CONTRACT_VERSION,
  field,
  type Activity,
  type NeedsYou,
  type NeedsYouKind,
  type SessionKind,
  type SessionSnapshot,
} from '@ccc/contract'

/** One entry as `agents --json` prints it. Every field but the first three can be absent. */
export interface AgentsJsonEntry {
  cwd: string
  kind: string
  startedAt: number
  id?: string
  state?: string
  pid?: number
  status?: string
  waitingFor?: string
  sessionId?: string
  name?: string
}

export interface ParseResult {
  entries: AgentsJsonEntry[]
  /** Entries left out, with the reason, for the source-health line. */
  rejected: { index: number; reason: string }[]
}

export function parseAgentsJson(text: string): ParseResult {
  const data: unknown = JSON.parse(text)
  if (!Array.isArray(data)) throw new Error('agents --json did not print an array')
  const entries: AgentsJsonEntry[] = []
  const rejected: ParseResult['rejected'] = []
  data.forEach((raw: unknown, index) => {
    const reason = checkEntry(raw)
    if (reason) rejected.push({ index, reason })
    else entries.push(raw as AgentsJsonEntry)
  })
  return { entries, rejected }
}

function checkEntry(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return 'not an object'
  const e = raw as Record<string, unknown>
  if (typeof e.cwd !== 'string') return 'cwd is not a string'
  if (typeof e.kind !== 'string') return 'kind is not a string'
  if (typeof e.startedAt !== 'number') return 'startedAt is not a number'
  // The contract is keyed by sessionId. The docs say it is present "when
  // set"; an entry without one can't be tracked across polls.
  if (typeof e.sessionId !== 'string' || e.sessionId === '') return 'no sessionId'
  for (const key of ['id', 'state', 'status', 'waitingFor', 'name'] as const) {
    if (e[key] !== undefined && typeof e[key] !== 'string') return `${key} is not a string`
  }
  if (e.pid !== undefined && typeof e.pid !== 'number') return 'pid is not a number'
  return null
}

const WAITING_FOR: Record<string, NeedsYouKind> = {
  'permission prompt': 'permission',
  'input needed': 'question',
  'sandbox request': 'sandbox',
  'worker request': 'worker',
  'dialog open': 'dialog',
}

export function activityOf(e: AgentsJsonEntry): Activity {
  const alive = e.pid !== undefined
  // `blocked` "always means the session needs something from you". With its
  // process gone, nothing is open to answer, so the entry is stale.
  if (e.state === 'blocked') return alive ? 'waiting' : 'stale'
  // A live entry with no status yet: for one poll after a respawn, a wake or a copy, the process hasn't
  // reported one, so it's read by its state like an entry without a pid (Research MIP2-1448).
  if (alive && e.status !== undefined) {
    switch (e.status) {
      case 'busy': return 'working'
      case 'waiting': return 'waiting'
      case 'idle': return 'idle'
      default: return 'unknown'
    }
  }
  switch (e.state) {
    case 'working': return 'working'
    case 'done': return 'idle'
    case 'failed': return 'failed'
    case 'stopped': return 'stopped'
    default: return 'unknown'
  }
}

export function needsYouOf(e: AgentsJsonEntry, activity: Activity): NeedsYou | null {
  if (activity !== 'waiting') return null
  if (e.waitingFor === undefined) return { kind: 'blocked', detail: null }
  return { kind: WAITING_FOR[e.waitingFor] ?? 'other', detail: e.waitingFor }
}

function kindOf(e: AgentsJsonEntry): SessionKind {
  // Only two kinds are documented. Anything else is hosted somewhere this
  // version doesn't know; treating it as interactive keeps the app from
  // offering supervisor commands for it.
  return e.kind === 'background' ? 'background' : 'interactive'
}

export function toSnapshot(e: AgentsJsonEntry, observedAt: number): SessionSnapshot {
  const f = <T>(value: T) => field(value, 'agents-json', observedAt)
  const activity = activityOf(e)
  return {
    contractVersion: CONTRACT_VERSION,
    sessionId: e.sessionId as string,
    kind: f(kindOf(e)),
    cwd: f(e.cwd),
    startedAt: f(e.startedAt),
    name: f(e.name ?? null),
    shortId: f(e.id ?? null),
    pid: f(e.pid ?? null),
    activity: f(activity),
    needsYou: f(needsYouOf(e, activity)),
  }
}
