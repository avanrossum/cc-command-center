// Which notifications show (MIP2-1412, spec MIP2-1387 §4.3, D-016).

import type { SessionSnapshot } from '@ccc/contract'
import { describe, expect, it } from 'vitest'
import { classOn, decide, newMemory, NOTIFY_GAP_MS, SETTLE_MS, type NotifyMemory } from '../src/main/notify-rules.ts'
import { emptyStore, type AppStore } from '../src/shared/store.ts'

const T = 1_793_000_000_000
const ID = 'aaaaaaaa-0000-4000-8000-000000000000'
const f = <V,>(value: V) => ({ value, source: 'agents-json' as const, observedAt: T, stale: false })

function snap(over: { activity?: string; needs?: { kind: string; detail: string | null } | null; pending?: { requestId: string; tool: string; summary: string; questions: { question: string; options: string[] }[] | null }[]; answer?: string } = {}): SessionSnapshot {
  return {
    contractVersion: 1,
    sessionId: ID,
    kind: f('background'),
    cwd: f('/Users/x/site'),
    startedAt: f(T),
    name: f('site-fix'),
    shortId: f('aaaaaaaa'),
    pid: f(1),
    activity: f(over.activity ?? 'idle'),
    needsYou: f(over.needs ?? null),
    ...(over.pending ? { pendingRequests: { ...f(over.pending.map(p => ({ ...p, canRemember: true, agentId: null, askedAt: T }))), source: 'mod' } } : {}),
    ...(over.answer ? { turn: { ...f({ running: false, startedAt: T, endedAt: T, lastAnswer: over.answer }), source: 'mod' } } : {}),
  } as unknown as SessionSnapshot
}

const store = (over: Partial<AppStore['settings']> = {}): AppStore => ({
  ...emptyStore(),
  categories: [{ id: 'c1', name: 'Acme General', color: '#4ac0e2', label: 'AC-gen', emoji: '', sort: 0, folders: [], notFolders: [], isolation: 'none', arbiterReadsText: false, collapsed: false }],
  sessions: { [ID]: { categoryId: 'c1', placedBy: 'hand' } },
  settings: { ...emptyStore().settings, ...over },
})

/** Two good polls 5 s apart: startup has settled, with these sessions seen. */
function settled(sessions: SessionSnapshot[], st = store()): NotifyMemory {
  const mem = newMemory()
  decide(mem, { sessions, store: st, focused: true, now: T - SETTLE_MS })
  decide(mem, { sessions, store: st, focused: true, now: T })
  return mem
}

describe('decide', () => {
  it('records on the first poll, then notifies a new need with the session, category and request', () => {
    const mem = settled([snap({ activity: 'working' })])
    const out = decide(mem, {
      sessions: [snap({ activity: 'waiting', needs: { kind: 'permission', detail: 'permission prompt' }, pending: [{ requestId: 'r1', tool: 'Bash', summary: 'npm test', questions: null }] })],
      store: store(),
      focused: false,
      now: T + 20_000,
    })
    expect(out).toEqual([{ sessionId: ID, cls: 'needs', title: 'site-fix', subtitle: 'AC-gen · Needs you', body: 'Bash: npm test' }])
  })

  it('shows nothing while the app is in front, and not later either', () => {
    const mem = settled([snap()])
    const asking = snap({ needs: { kind: 'question', detail: null }, pending: [{ requestId: 'q', tool: 'AskUserQuestion', summary: 'x', questions: [{ question: 'Which branch?', options: ['a', 'b'] }] }] })
    expect(decide(mem, { sessions: [asking], store: store(), focused: true, now: T + 20_000 })).toEqual([])
    expect(decide(mem, { sessions: [asking], store: store(), focused: false, now: T + 40_000 })).toEqual([])
  })

  it('keeps Your turn off by default, and sends it with the answer when on', () => {
    const run = () => settled([snap({ activity: 'working' })])
    expect(decide(run(), { sessions: [snap({ answer: 'Done: tests pass.' })], store: store(), focused: false, now: T + 20_000 })).toEqual([])
    const on = decide(run(), { sessions: [snap({ answer: 'Done: tests pass.' })], store: store({ notifyTurn: true }), focused: false, now: T + 20_000 })
    expect(on).toMatchObject([{ cls: 'turn', subtitle: 'AC-gen · Your turn', body: 'Done: tests pass.' }])
  })

  it('sends at most one per session every 10 s, honors the switches, and clips the body to 180', () => {
    const mem = settled([snap()])
    const ask = (id: string, summary = 'x') => snap({ needs: { kind: 'permission', detail: null }, pending: [{ requestId: id, tool: 'Bash', summary, questions: null }] })
    expect(decide(mem, { sessions: [ask('r1', 'y'.repeat(400))], store: store(), focused: false, now: T + 1 })[0]?.body.length).toBe(180)
    expect(decide(mem, { sessions: [ask('r2')], store: store(), focused: false, now: T + NOTIFY_GAP_MS - 1 })).toEqual([])
    expect(decide(mem, { sessions: [ask('r3')], store: store({ notifyNeedsYou: false }), focused: false, now: T + 2 * NOTIFY_GAP_MS })).toEqual([])
    expect(decide(mem, { sessions: [ask('r4')], store: store({ notifyEnabled: false }), focused: false, now: T + 3 * NOTIFY_GAP_MS })).toEqual([])
    expect(decide(mem, { sessions: [ask('r5')], store: store(), focused: false, now: T + 4 * NOTIFY_GAP_MS })).toHaveLength(1)
  })

  it('waits for startup to settle, then sends one notice for sessions already waiting (UX ruling, MIP2-1387 §4.3)', () => {
    const waitingNow = snap({ needs: { kind: 'permission', detail: 'x' }, pending: [{ requestId: 'r1', tool: 'Bash', summary: 'npm test', questions: null }] })
    const one = newMemory()
    expect(decide(one, { sessions: [waitingNow], store: store(), focused: false, now: T })).toEqual([])
    // A second good poll, but not yet 5 s.
    expect(decide(one, { sessions: [waitingNow], store: store(), focused: false, now: T + 1000 })).toEqual([])
    // A failed poll doesn't count.
    const bad = newMemory()
    decide(bad, { sessions: [waitingNow], store: store(), focused: false, now: T })
    expect(decide(bad, { sessions: [waitingNow], store: store(), focused: false, now: T + SETTLE_MS, listOk: false })).toEqual([])
    // Settled: the per-session form for one.
    expect(decide(one, { sessions: [waitingNow], store: store(), focused: false, now: T + SETTLE_MS })).toMatchObject([{ sessionId: ID, title: 'site-fix', body: 'Bash: npm test' }])
    expect(decide(one, { sessions: [waitingNow], store: store(), focused: false, now: T + 2 * SETTLE_MS })).toEqual([])

    // Several: one summary that opens Fleet on Needs you.
    const ID2 = 'bbbbbbbb-0000-4000-8000-000000000000'
    const other = { ...waitingNow, sessionId: ID2, name: f('docs') } as SessionSnapshot
    const many = newMemory()
    decide(many, { sessions: [waitingNow, other], store: store(), focused: false, now: T })
    expect(decide(many, { sessions: [waitingNow, other], store: store(), focused: false, now: T + SETTLE_MS })).toEqual([
      { sessionId: null, cls: 'needs', title: '2 sessions need you', subtitle: 'Needs you', body: 'site-fix, docs' },
    ])

    // In front, or Needs you off: nothing, then or later.
    const front = newMemory()
    decide(front, { sessions: [waitingNow], store: store(), focused: true, now: T })
    expect(decide(front, { sessions: [waitingNow], store: store(), focused: true, now: T + SETTLE_MS })).toEqual([])
    expect(decide(front, { sessions: [waitingNow], store: store(), focused: false, now: T + 2 * SETTLE_MS })).toEqual([])
  })

  it('announces once a session first seen after startup that is already waiting', () => {
    const mem = settled([])
    const late = snap({ needs: { kind: 'permission', detail: 'x' }, pending: [{ requestId: 'r9', tool: 'Edit', summary: 'a.ts', questions: null }] })
    expect(decide(mem, { sessions: [late], store: store(), focused: false, now: T + 20_000 })).toMatchObject([{ sessionId: ID, body: 'Edit: a.ts' }])
    expect(decide(mem, { sessions: [late], store: store(), focused: false, now: T + 40_000 })).toEqual([])
  })

  it("lets a category's on or off override the class switch; auto follows it (MIP2-1387 §3)", () => {
    const st = store({ notifyNeedsYou: false, notifyTurn: false })
    expect([classOn(st, ID, 'needs'), classOn(st, ID, 'turn')]).toEqual([false, false])
    st.categories[0] = { ...st.categories[0]!, notifyNeeds: 'on', notifyTurn: 'on' }
    expect([classOn(st, ID, 'needs'), classOn(st, ID, 'turn')]).toEqual([true, true])
    const on = store()
    on.categories[0] = { ...on.categories[0]!, notifyNeeds: 'off' }
    expect(classOn(on, ID, 'needs')).toBe(false)
  })
})
