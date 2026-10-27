// The Fleet view's model: card states, order, counts and text (spec MIP2-1370 §4, §5, §12).

import { field, type SessionSnapshot } from '@ccc/contract'
import { describe, expect, it } from 'vitest'
import { cardView, deadView, IDLE_AFTER_MS, isStale, withObservedIdle } from '../src/renderer/model/card-state.ts'
import { DEAD_AFTER_MS } from '../src/shared/lifecycle.ts'
import { attentionLine, categoryLabel, categoryRef, countFleet, frameColor, groupFleet, nameOf, shownEntries, splitAttention, UNCAT_REF, type CatRef, type Entry } from '../src/renderer/model/fleet.ts'
import { emptyStore, type AppStore } from '../src/shared/store.ts'
import { age, modelName, terminalFont, tildify, tokens, untilReset } from '../src/renderer/model/format.ts'
import { CELL_MS, History } from '../src/renderer/model/history.ts'

const NOW = 1_800_000_000_000

function snap(over: Partial<SessionSnapshot> & { activityValue?: SessionSnapshot['activity']['value']; pidValue?: number | null } = {}): SessionSnapshot {
  const f = <T>(v: T) => field(v, 'agents-json', NOW)
  const m = <T>(v: T) => field(v, 'mod', NOW)
  const { activityValue = 'idle', pidValue = 1, ...rest } = over
  return {
    contractVersion: 1,
    sessionId: 's1',
    kind: f('background'),
    cwd: f('/Users/alex/Developer/app'),
    startedAt: f(NOW - 60_000),
    name: f('app-1'),
    shortId: f('abc'),
    pid: f(pidValue),
    activity: f(activityValue),
    needsYou: f(null),
    model: m('claude-sonnet-5-5'),
    tokens: m({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }),
    ...rest,
  }
}

const mod = <T>(v: T, at = NOW) => field(v, 'mod', at)

describe('cardView', () => {
  it('reads a session awaiting its first message as ready for it (MIP2-1426)', () => {
    const v = cardView(snap({ awaitingFirstPrompt: mod(true) }), NOW)
    expect([v.state, v.label]).toEqual(['turn', 'READY FOR YOUR FIRST MESSAGE'])
    expect(cardView(snap({ awaitingFirstPrompt: { ...mod(true), stale: true } }), NOW).label).not.toBe('READY FOR YOUR FIRST MESSAGE')
  })

  it('reads each needs-you kind', () => {
    const waiting = (kind: 'permission' | 'question' | 'sandbox' | 'worker' | 'blocked', detail: string | null = null) =>
      cardView(snap({ activityValue: 'waiting', needsYou: field({ kind, detail }, 'agents-json', NOW) }), NOW).state
    expect(waiting('permission')).toBe('approval')
    expect(waiting('question')).toBe('question')
    expect(waiting('sandbox')).toBe('sandbox')
    expect(waiting('worker', 'worker request')).toBe('request')
    expect(waiting('blocked')).toBe('request')
  })

  it('names the wait in the label', () => {
    const v = cardView(snap({ activityValue: 'waiting', needsYou: field({ kind: 'dialog', detail: 'dialog open' }, 'agents-json', NOW) }), NOW)
    expect(v.label).toBe('NEEDS YOU · DIALOG OPEN')
  })

  it('treats a prompt the mod offered as needs you before the agent list catches up', () => {
    const pending = (tool: string) =>
      mod([{ requestId: 'r', tool, summary: 'x', fields: [], refusal: null, questions: null, canRemember: false, agentId: null, askedAt: NOW - 5000 }])
    expect(cardView(snap({ activityValue: 'working', pendingRequests: pending('Bash') }), NOW).state).toBe('approval')
    const q = cardView(snap({ activityValue: 'working', pendingRequests: pending('AskUserQuestion') }), NOW)
    expect([q.state, q.knownSince]).toEqual(['question', NOW - 5000])
  })

  it('reads working, ended and your turn', () => {
    expect(cardView(snap({ activityValue: 'working' }), NOW).state).toBe('working')
    expect(cardView(snap({ pidValue: null, activityValue: 'idle' }), NOW).state).toBe('ended')
    expect(cardView(snap({ activityValue: 'stale', pidValue: null }), NOW).state).toBe('ended')
    expect(cardView(snap(), NOW).state).toBe('turn')
  })

  it('moves your turn to idle at 30 minutes from the mod turn time, and leaves assumed dead to the lifecycle', () => {
    const ended = (ago: number) => cardView(snap({ turn: mod({ running: false, startedAt: null, endedAt: NOW - ago, lastAnswer: null }) }), NOW)
    expect(ended(IDLE_AFTER_MS - 1000).state).toBe('turn')
    expect(ended(IDLE_AFTER_MS).state).toBe('idle')
    expect(ended(DEAD_AFTER_MS).state).toBe('idle')
    expect(deadView(ended(DEAD_AFTER_MS), NOW)).toMatchObject({ state: 'dead', glyph: 'dead', label: 'ASSUMED DEAD', knownSince: NOW })
  })

  it('never assumes a session dead that needs Alex', () => {
    const v = cardView(
      snap({
        activityValue: 'waiting',
        needsYou: field({ kind: 'permission', detail: 'permission prompt' }, 'agents-json', NOW),
        turn: mod({ running: false, startedAt: null, endedAt: NOW - 3 * DEAD_AFTER_MS, lastAnswer: null }),
      }),
      NOW,
    )
    expect(v.state).toBe('approval')
  })

  it('reads asked, no reply, and clears it when the peer answers', () => {
    const msgs = (list: { direction: 'sent' | 'received'; peer: string; at: number }[]) =>
      cardView(snap({ peerMessages: mod(list.map(m => ({ ...m, preview: '' }))) }), NOW)
    const asked = msgs([{ direction: 'sent', peer: 'qa', at: NOW - 9000 }])
    expect([asked.state, asked.askedPeer, asked.label]).toEqual(['asked', 'qa', 'ASKED qa · NO REPLY'])
    expect(msgs([{ direction: 'sent', peer: 'qa', at: 1 }, { direction: 'received', peer: 'qa', at: 2 }]).state).toBe('turn')
    expect(msgs([{ direction: 'sent', peer: 'qa', at: 1 }, { direction: 'received', peer: 'other', at: 2 }]).state).toBe('asked')
  })

  it('reads waiting on agents while subagents run', () => {
    const agent = (status: string) => ({ agentId: 'a', type: 'Explore', description: null, model: null, status, parentAgentId: null })
    expect(cardView(snap({ subagents: mod([agent('running'), agent('running')]) }), NOW).label).toBe('WAITING ON 2 AGENTS')
    expect(cardView(snap({ subagents: mod([agent('completed')]) }), NOW).state).toBe('turn')
  })

  it('marks a session with no mod fields as outside the app', () => {
    expect(cardView(snap({ model: undefined, tokens: undefined }), NOW).outside).toBe(true)
    expect(cardView(snap(), NOW).outside).toBe(false)
  })

  it('marks a session unreported when its agent-list fields are stale', () => {
    const old = NOW - 60_000
    const s = snap({ activity: field('idle', 'agents-json', old), cwd: field('/x', 'agents-json', old) })
    expect(cardView(s, NOW).unreported).toBe(true)
  })

  it('reads an agent-list-only session from what the app saw', () => {
    const v = cardView(snap({ model: undefined, tokens: undefined }), NOW)
    // Quiet when first seen: idle, age unknown.
    expect([withObservedIdle(v, null, NOW).state, withObservedIdle(v, null, NOW).knownSince]).toEqual(['idle', null])
    // A turn the app saw end: your turn for 30 minutes, then idle.
    expect(withObservedIdle(v, NOW - IDLE_AFTER_MS + 1000, NOW)).toMatchObject({ state: 'turn', knownSince: NOW - IDLE_AFTER_MS + 1000 })
    expect(withObservedIdle(v, NOW - IDLE_AFTER_MS, NOW).state).toBe('idle')
  })
})

describe('isStale', () => {
  it('uses each source window, and the stale flag', () => {
    expect(isStale(field(1, 'agents-json', NOW - 16_000), NOW)).toBe(true)
    expect(isStale(field(1, 'agents-json', NOW - 2_000), NOW)).toBe(false)
    expect(isStale(field(1, 'mod', NOW - 59_000), NOW)).toBe(false)
    expect(isStale(field(1, 'mod', NOW - 61_000), NOW)).toBe(true)
    expect(isStale({ ...field(1, 'mod', NOW), stale: true }, NOW)).toBe(true)
    expect(isStale(undefined, NOW)).toBe(false)
  })
})

describe('groupFleet and countFleet', () => {
  const entry = (id: string, name: string, s: Partial<Parameters<typeof snap>[0]>, since: number | null = null, dead = false): Entry => {
    const session = snap({ ...s, sessionId: id, name: field(name, 'agents-json', NOW) })
    const view = cardView(session, NOW)
    const life = { stage: 'live' as const, deadAt: null }
    return { session, view: dead ? deadView(view, NOW) : view, since, cat: UNCAT_REF, name, contractor: null, life, neverRollOff: false, children: [], parentName: null }
  }
  const needs = (id: string, since: number) =>
    entry(id, id, { activityValue: 'waiting', needsYou: field({ kind: 'permission', detail: null }, 'agents-json', NOW) }, since)

  it('pins needs-you oldest first, sorts the rest by name, and keeps quiet sessions as rows, newest first', () => {
    const list = [
      entry('w', 'zeta', { activityValue: 'working' }),
      needs('n2', NOW - 1000),
      entry('i1', 'old idle', { turn: mod({ running: false, startedAt: null, endedAt: NOW - 2 * IDLE_AFTER_MS, lastAnswer: null }) }),
      entry('t', 'alpha', {}),
      needs('n1', NOW - 9000),
      entry('i2', 'new idle', { turn: mod({ running: false, startedAt: null, endedAt: NOW - IDLE_AFTER_MS, lastAnswer: null }) }),
      entry('d', 'dead', { turn: mod({ running: false, startedAt: null, endedAt: NOW - 2 * DEAD_AFTER_MS, lastAnswer: null }) }, null, true),
    ]
    const g = groupFleet(list, 'all')
    expect(g.needs.map(e => e.session.sessionId)).toEqual(['n1', 'n2'])
    expect(g.active.map(e => e.session.name.value)).toEqual(['alpha', 'zeta'])
    expect(g.quiet.map(e => e.session.sessionId)).toEqual(['i2', 'i1'])
    expect(g.dead.map(e => e.session.sessionId)).toEqual(['d'])
    expect(groupFleet(list, 'needs').active).toEqual([])

    const c = countFleet(list)
    expect([c.all, c.needs, c.working, c.turn, c.idle]).toEqual([7, 2, 1, 1, 2])
    expect(c.byCategory.get('none')?.n).toBe(7)
  })

  it('says "Start with" only for the Arbiter\'s evidence-backed first session, and names off and the cap (MIP2-1411)', () => {
    const list = [needs('n1', NOW - 9000), needs('n2', NOW - 1000)]
    const c = countFleet(list)
    const ranked = (start: { sessionId: string; name: string; unblocks: string[] } | null) => ({ status: 'ranked' as const, start, capUsd: 1 })
    const g = (rank: string[] = []) => groupFleet(list, 'all', rank)
    expect(g(['n2', 'n1']).needs.map(e => e.session.sessionId)).toEqual(['n2', 'n1'])
    expect(attentionLine(g(['n2', 'n1']), c, NOW, age, ranked({ sessionId: 'n2', name: 'n2', unblocks: ['qa', 'research'] }))).toBe('2 need you · Start with n2: unblocks qa, research.')
    // No evidence: oldest first, and no "Arbiter is off" when it ran.
    expect(attentionLine(g(), c, NOW, age, ranked(null))).toBe('2 need you · Oldest first: n1 has waited 9s.')
    expect(attentionLine(g(), c, NOW, age, null)).toBe('2 need you · Oldest first: n1 has waited 9s. Arbiter is off.')
    expect(attentionLine(g(), c, NOW, age, { status: 'capped', start: null, capUsd: 1 })).toBe('2 need you · Oldest first: n1 has waited 9s. Arbiter is at its $1.00 cap.')
  })

  it('hides sessions started outside the app when settings say so, but keeps contractors (MIP2-1424)', () => {
    const outside = (e: Entry): Entry => ({ ...e, view: { ...e.view, outside: true } })
    const mine = entry('m', 'mine', {})
    const theirs = outside(entry('o', 'outside', {}))
    const worker = { ...outside(entry('c', 'contractor', {})), contractor: { kind: 'contractor' as const, parentId: 'm', why: 'seen' as const } }
    const list = [mine, theirs, worker]
    expect(shownEntries(list, undefined)).toBe(list)
    expect(shownEntries(list, true)).toBe(list)
    expect(shownEntries(list, false).map(e => e.session.sessionId)).toEqual(['m', 'c'])
  })

  it('keeps contractors out of every group but Needs you, and orphans in their own (MIP2-1393 §4)', () => {
    const contractor = (e: Entry, parentId: string | null): Entry => ({ ...e, contractor: { kind: 'contractor', parentId, why: parentId ? 'seen' : 'background' } })
    const parent = entry('p', 'parent', { activityValue: 'working' })
    const list = [
      parent,
      contractor(entry('c1', 'child', { activityValue: 'working' }), 'p'),
      contractor(entry('c2', 'orphan', { activityValue: 'working' }), null),
      contractor(entry('c3', 'lost parent', {}), 'gone'),
      contractor(needs('c4', NOW - 500), 'p'),
    ]
    const g = groupFleet(list, 'all')
    expect(g.active.map(e => e.session.sessionId)).toEqual(['p'])
    expect(g.needs.map(e => e.session.sessionId)).toEqual(['c4'])
    expect(g.orphans.map(e => e.session.sessionId).sort()).toEqual(['c2', 'c3'])
    const c = countFleet(list)
    expect([c.all, c.needs, c.working]).toEqual([1, 1, 1])
  })

  it('writes the top-bar line', () => {
    const list = [needs('n1', NOW - 125_000)]
    expect(attentionLine(groupFleet(list, 'all'), countFleet(list), NOW, age)).toBe('1 needs you · Oldest first: n1 has waited 2m. Arbiter is off.')
    const none = [entry('w', 'w', { activityValue: 'working' })]
    expect(attentionLine(groupFleet(none, 'all'), countFleet(none), NOW, age)).toBe('Nothing needs you. · 1 working, 0 asked and waiting.')
  })
})

describe('labels', () => {
  const cat = (name: string, label = ''): CatRef => ({ id: 'c1', name, color: '#4ac0e2', label, emoji: '', sort: 0, auto: false })

  it("frames an Uncategorized session in the focus blue, others in their category's color (MIP2-1398 §4)", () => {
    expect(frameColor(UNCAT_REF)).toBe('var(--cc-focus)')
    expect(frameColor(cat('Acme work'))).toBe('#4ac0e2')
  })

  it("shortens category chips, preferring the category's own label", () => {
    expect(categoryLabel(UNCAT_REF)).toBe('UNCAT')
    expect(categoryLabel(cat('Acme work'))).toBe('ACME')
    expect(categoryLabel(cat('Experiments'))).toBe('EXPERIME')
    expect(categoryLabel(cat('Acme General', 'AC-gen'))).toBe('AC-gen')
  })

  it('reads category and name from the store (MIP2-1409)', () => {
    const store: AppStore = {
      ...emptyStore(),
      categories: [{ ...cat('Acme General', 'AC-gen'), id: 'c3', folders: [], notFolders: [], isolation: 'none', arbiterReadsText: true, collapsed: false }],
      sessions: { a: { categoryId: 'c3', placedBy: 'auto' }, b: { categoryId: 'gone', placedBy: 'hand', name: 'old name' }, c: { categoryId: null, placedBy: null, alias: 'plat' } },
    }
    expect(categoryRef(store, 'a')).toMatchObject({ id: 'c3', label: 'AC-gen', auto: true })
    expect(categoryRef(store, 'b')).toBe(UNCAT_REF)
    expect(categoryRef(null, 'a')).toBe(UNCAT_REF)
    const s = (id: string, n: string | null) => snap({ sessionId: id, name: field(n, 'agents-json', NOW) })
    expect(nameOf(store, s('b', null))).toBe('old name')
    // A name Alex gave (Rename…, or 0.24's) wins over Claude Code's, as in 0.24 (MIP2-1407).
    expect(nameOf(store, s('b', 'claude name'))).toBe('old name')
    // 0.24's alias is its mailbox handle, not a name.
    expect(nameOf(store, s('c', 'claude name'))).toBe('claude name')
  })
  it('splits the attention count from the rest', () => {
    expect(splitAttention('2 need you · Oldest first: x.')).toEqual({ count: '2 need you', rest: ' · Oldest first: x.' })
    expect(splitAttention('Nothing needs you. · 1 working')).toEqual({ count: null, rest: 'Nothing needs you. · 1 working' })
  })
})

describe('format', () => {
  it.each([
    [5_000, '5s'],
    [125_000, '2m'],
    [3 * 3600_000, '3h'],
    [72 * 3600_000, '3d'],
    [-1, '—'],
  ])('age(%d) is %s', (ms, text) => expect(age(ms)).toBe(text))

  it('formats the rest', () => {
    expect(untilReset(NOW / 1000 + 2 * 3600 + 14 * 60, NOW)).toBe('2h 14m')
    expect(untilReset(null, NOW)).toBe('')
    expect(tildify('/Users/alex/Developer/x')).toBe('~/Developer/x')
    expect(tildify('/tmp/x')).toBe('/tmp/x')
    expect(tokens(182_400)).toBe('182k tok')
    expect(modelName('claude-sonnet-5-5')).toBe('sonnet 5.5')
    expect(modelName('custom')).toBe('custom')
  })
})

describe('History', () => {
  it('keeps when a state began, and one cell per 100 s with the most urgent state', () => {
    const h = new History()
    const t0 = Math.floor(NOW / CELL_MS) * CELL_MS
    // The first sighting isn't a change the app saw.
    expect(h.observe('s', 'working', t0)).toBeNull()
    expect(h.observe('s', 'working', t0 + 10_000)).toBeNull()
    expect(h.observe('s', 'approval', t0 + 20_000)).toBe(t0 + 20_000)
    expect(h.observe('s', 'approval', t0 + 30_000)).toBe(t0 + 20_000)
    h.paint('s', 'working', t0)
    h.paint('s', 'approval', t0 + 20_000)
    h.observe('s', 'turn', t0 + CELL_MS)
    h.paint('s', 'turn', t0 + CELL_MS)
    const strip = h.strip('s', t0 + CELL_MS)
    expect(strip.slice(-2)).toEqual(['approval', 'turn'])
    expect(strip.slice(0, -2).every(c => c === null)).toBe(true)
  })
})

describe('isAgentViewTitle', async () => {
  // FocusPane imports xterm.js, which needs a DOM; the check is plain, so test it from source text.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/renderer/components/FocusPane.tsx', import.meta.url), 'utf8')
  const body = /export function isAgentViewTitle\(title: string\): boolean \{\n\s+return (.+)\n\}/.exec(src)![1]!
  const isAgentViewTitle = new Function('title', `return ${body}`) as (t: string) => boolean
  it.each([
    ['claude agents', true],
    ['3 awaiting input · claude agents', true],
    ['ccc-1394-approval', false],
    ['claude agents are great', false],
    ['my claude agents session', false],
  ])('%s → %s', (t, v) => expect(isAgentViewTitle(t)).toBe(v))
})

describe('commandPreview', async () => {
  const { commandPreview } = await import('../src/renderer/components/NewSession.tsx')
  it('shows the command the app runs, with the settings path hidden', () => {
    expect(commandPreview({ cwd: '/w/my app', name: 'n', model: 'sonnet', effort: 'low', permissionMode: 'default', prompt: "it's", isolation: 'none' })).toBe(
      `cd '/w/my app' && claude --bg --name n --model sonnet --effort low --permission-mode default --plugin-dir <reporter> --settings <session settings> -- 'it'\\''s'`,
    )
  })
})

describe('terminalFont (MIP2-1424)', () => {
  it('puts the chosen family first, with the system monospace after it', () => {
    expect(terminalFont({ terminalFont: 'Fira Mono', terminalFontSize: 18 })).toEqual({ fontFamily: '"Fira Mono", ui-monospace, "SF Mono", Menlo, monospace', fontSize: 18 })
    expect(terminalFont({ terminalFont: '' })).toEqual({ fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontSize: 13 })
    expect(terminalFont(undefined).fontSize).toBe(13)
  })
})
