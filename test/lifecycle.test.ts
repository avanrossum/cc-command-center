// Session lifecycle and contractor classification (MIP2-1410), on a
// simulated clock: every transition in MIP2-1370 §4.1 and MIP2-1393 §5.

import type { SessionSnapshot } from '@ccc/contract'
import { describe, expect, it } from 'vitest'
import { classify, clampRollOffDays, DAY_MS, HOUR_MS, inArchive, lastActivityOf, lifeOf, parentsOf, type LifeInput } from '../src/shared/lifecycle.ts'

const T0 = 1_793_000_000_000
const f = <T,>(value: T) => ({ value, source: 'agents-json' as const, observedAt: T0, stale: false })

function snap(over: { id?: string; shortId?: string; kind?: 'background' | 'interactive'; startedAt?: number; turnStartedAt?: number | null; contractors?: { shortId: string; name: string | null; startedAt: number }[] } = {}): SessionSnapshot {
  const s = {
    contractVersion: 1,
    sessionId: over.id ?? 'aaaaaaaa-0000-4000-8000-000000000000',
    kind: f(over.kind ?? 'background'),
    cwd: f('/w'),
    startedAt: f(over.startedAt ?? T0),
    name: f(null),
    shortId: f(over.shortId ?? 'aaaaaaaa'),
    pid: f(1),
    activity: f('idle'),
    needsYou: f(null),
    ...(over.turnStartedAt !== undefined ? { turn: { ...f({ running: false, startedAt: over.turnStartedAt, endedAt: null, lastAnswer: null }), source: 'mod' as const } } : {}),
    ...(over.contractors ? { contractors: { ...f(over.contractors), source: 'mod' as const } } : {}),
  }
  return s as unknown as SessionSnapshot
}

const base = (over: Partial<LifeInput>): LifeInput => ({ lastActivityAt: T0, needsYou: false, neverRollOff: false, contractor: false, parentGone: false, rollOffDays: 7, now: T0, ...over })

describe('lifeOf: sessions (§4.1)', () => {
  it('stays live for a day, is assumed dead from 24 h, and rolls off 7 days later', () => {
    expect(lifeOf(base({ now: T0 + DAY_MS - 1 }))).toEqual({ stage: 'live', deadAt: T0 + DAY_MS })
    expect(lifeOf(base({ now: T0 + DAY_MS }))).toEqual({ stage: 'dead', since: T0 + DAY_MS, rollsOffAt: T0 + 8 * DAY_MS })
    expect(lifeOf(base({ now: T0 + 8 * DAY_MS - 1 })).stage).toBe('dead')
    expect(lifeOf(base({ now: T0 + 8 * DAY_MS }))).toEqual({ stage: 'rolled', at: T0 + 8 * DAY_MS })
  })

  it('follows the 7–14 day setting, clamped', () => {
    expect(lifeOf(base({ rollOffDays: 14, now: T0 + 14 * DAY_MS })).stage).toBe('dead')
    expect(lifeOf(base({ rollOffDays: 14, now: T0 + 15 * DAY_MS })).stage).toBe('rolled')
    expect([clampRollOffDays(3), clampRollOffDays(30), clampRollOffDays(undefined), clampRollOffDays(9.6)]).toEqual([7, 14, 7, 10])
  })

  it('never assumes dead or rolls off a session that needs Alex, or one set to never roll off (D-020)', () => {
    expect(lifeOf(base({ needsYou: true, now: T0 + 30 * DAY_MS })).stage).toBe('live')
    expect(lifeOf(base({ neverRollOff: true, now: T0 + 30 * DAY_MS })).stage).toBe('live')
  })

  it('any activity resets the clock', () => {
    const later = T0 + 5 * DAY_MS
    expect(lifeOf(base({ lastActivityAt: later, now: later + 2 * HOUR_MS })).stage).toBe('live')
  })
})

describe('lifeOf: contractors (MIP2-1393 §5, D-022)', () => {
  it('skips assumed dead and rolls off 24 h after its last activity', () => {
    expect(lifeOf(base({ contractor: true, now: T0 + DAY_MS - 1 }))).toEqual({ stage: 'live', deadAt: null })
    expect(lifeOf(base({ contractor: true, now: T0 + DAY_MS }))).toEqual({ stage: 'rolled', at: T0 + DAY_MS })
  })

  it('rolls off with its parent, but not while it waits on Alex', () => {
    expect(lifeOf(base({ contractor: true, parentGone: true, now: T0 + HOUR_MS }))).toEqual({ stage: 'rolled', at: T0 + HOUR_MS })
    expect(lifeOf(base({ contractor: true, parentGone: true, needsYou: true, now: T0 + 3 * DAY_MS })).stage).toBe('live')
  })
})

describe('lastActivityOf', () => {
  it('takes the latest of start, a turn starting, and what the app recorded', () => {
    expect(lastActivityOf(snap(), undefined)).toBe(T0)
    expect(lastActivityOf(snap({ turnStartedAt: T0 + 50 }), { categoryId: null, placedBy: null, activityAt: T0 + 20 })).toBe(T0 + 50)
    expect(lastActivityOf(snap({ turnStartedAt: null }), { categoryId: null, placedBy: null, activityAt: T0 + 20 })).toBe(T0 + 20)
  })
})

describe('classify (MIP2-1393 §3)', () => {
  const PARENT = 'pppppppp-0000-4000-8000-000000000000'
  const parent = snap({ id: PARENT, shortId: 'pppppppp', contractors: [{ shortId: 'c0ffee09', name: 'probe', startedAt: T0 }] })
  const child = snap({ id: 'c0ffee09-0000-4000-8000-000000000000', shortId: 'c0ffee09' })
  const map = parentsOf([parent, child])

  it('puts a child its parent saw start under that parent', () => {
    expect(classify(child, undefined, map)).toEqual({ kind: 'contractor', parentId: PARENT, why: 'seen' })
  })

  it('keeps the parent link after the report has rolled off', () => {
    expect(classify(child, { categoryId: null, placedBy: null, parentId: PARENT }, new Map())).toEqual({ kind: 'contractor', parentId: PARENT, why: 'seen' })
  })

  it("treats another background session as a contractor with no known parent, and Alex's own as sessions", () => {
    const other = snap({ id: 'bbbbbbbb-0000-4000-8000-000000000000', shortId: 'bbbbbbbb' })
    expect(classify(other, undefined, map)).toEqual({ kind: 'contractor', parentId: null, why: 'background' })
    expect(classify(other, { categoryId: null, placedBy: null, origin: 'app' }, map)).toEqual({ kind: 'session' })
    expect(classify(other, { categoryId: 'c3', placedBy: 'import', origin: 'import' }, map)).toEqual({ kind: 'session' })
    expect(classify(other, { categoryId: 'c3', placedBy: 'hand' }, map)).toEqual({ kind: 'session' })
    // In 0.24's registry but never placed: Electron recorded contractors too.
    expect(classify(other, { categoryId: null, placedBy: null, origin: 'import' }, map)).toEqual({ kind: 'contractor', parentId: null, why: 'background' })
    // Auto-assign is the app's guess, not Alex's say.
    expect(classify(other, { categoryId: 'c3', placedBy: 'auto' }, map)).toEqual({ kind: 'contractor', parentId: null, why: 'background' })
    expect(classify(snap({ kind: 'interactive' }), undefined, map)).toEqual({ kind: 'session' })
  })

  it('links a headless child listed while its parent runs `claude -p` in the same folder', () => {
    const P2 = 'qqqqqqqq-0000-4000-8000-000000000000'
    const call = (detail: string, startedAt = T0) => ({ ...f([{ toolUseId: 't', tool: 'Bash', detail, agentId: null, startedAt }]), source: 'mod' as const })
    const parentRunning = { ...snap({ id: PARENT, shortId: 'pppppppp' }), toolCalls: call('claude -p --model haiku "count"') } as SessionSnapshot
    // As observed on 2.1.311: interactive, with no short id.
    const headless = { ...snap({ id: 'dddddddd-0000-4000-8000-000000000000', kind: 'interactive', startedAt: T0 + 100 }), shortId: f(null) } as SessionSnapshot
    expect(classify(headless, undefined, parentsOf([parentRunning, headless]))).toEqual({ kind: 'contractor', parentId: PARENT, why: 'seen' })
    // Started before the call, another folder, or two possible parents: no link.
    const early = snap({ id: 'eeeeeeee-0000-4000-8000-000000000000', shortId: 'eeeeeeee', kind: 'interactive', startedAt: T0 - 1 })
    expect(parentsOf([parentRunning, early]).has(early.sessionId)).toBe(false)
    const other = { ...snap({ id: P2, shortId: 'qqqqqqqq' }), toolCalls: call('echo x | claude --print "y"') } as SessionSnapshot
    // Once marked, it stays a contractor after the calls end.
    expect(classify(headless, { categoryId: null, placedBy: null, headlessChild: true }, new Map())).toEqual({ kind: 'contractor', parentId: null, why: 'seen' })
    // Two candidates: a contractor with no parent named, never Alex's own (D-018).
    expect(classify(headless, undefined, parentsOf([parentRunning, other, headless]))).toEqual({ kind: 'contractor', parentId: null, why: 'seen' })
    // Not a headless run.
    const plain = { ...snap({ id: P2, shortId: 'qqqqqqqq' }), toolCalls: call('claude agents --json') } as SessionSnapshot
    expect(parentsOf([plain, headless]).has(headless.sessionId)).toBe(false)
  })

  it("lets Alex's correction win either way", () => {
    expect(classify(child, { categoryId: null, placedBy: null, kindOverride: 'session' }, map)).toEqual({ kind: 'session' })
    expect(classify(snap({ kind: 'interactive' }), { categoryId: null, placedBy: null, kindOverride: 'contractor' }, map)).toEqual({ kind: 'contractor', parentId: null, why: 'hand' })
  })
})

describe('inArchive', () => {
  it('holds rolled-off and hand-archived sessions', () => {
    expect([inArchive(undefined), inArchive({ categoryId: null, placedBy: null, rolledOffAt: 1 }), inArchive({ categoryId: null, placedBy: null, archivedAt: 1 })]).toEqual([false, true, true])
  })
})
