// The usage help panel (spec MIP2-1498 §4.5): shares, the Arbiter-off lines, and the tips call.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { field, type SessionSnapshot } from '@ccc/contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArbiterLog } from '../src/main/arbiter.ts'
import { checkTipFacts, keptTips, tipsPrompt, UsageTips, type TipsCall } from '../src/main/usage-tips.ts'
import { paceOf, type Reading } from '../src/renderer/model/pace.ts'
import { noteBaselines, plainHelp, sharesOf, statusLine, tipFacts } from '../src/renderer/model/usage-help.ts'

const NOW = new Date(2026, 9, 28, 12, 0).getTime()
const H = 3_600_000
const RESET = (NOW + 2 * H) / 1000
const f = <T,>(v: T) => field(v, 'agents-json', NOW)
const m = <T,>(v: T) => field(v, 'mod', NOW)

function snap(id: string, cost: number, over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    contractVersion: 1,
    sessionId: id,
    kind: f('background'),
    cwd: f('/w'),
    startedAt: f(NOW - 10 * H),
    name: f(id),
    shortId: f(id),
    pid: f(1),
    activity: f('working'),
    needsYou: f(null),
    costUsd: m(cost),
    model: m('claude-sonnet-5-5'),
    ...over,
  }
}

describe('shares of this app\'s estimated cost (MIP2-1498 §4.5)', () => {
  it('counts each session from its cost when the window began, or from zero if it started inside it', () => {
    let b = noteBaselines({}, '5h', RESET, [snap('a', 10), snap('new', 0, { startedAt: f(NOW - H) })], NOW)
    // Counting starts when the app first noted the window, three hours after it began.
    expect(b[`5h:${RESET}`]).toEqual({ since: NOW, costs: { a: 10, new: 0 } })
    // A later reading doesn't move a baseline or its start; a new window starts over.
    b = noteBaselines(b, '5h', RESET, [snap('a', 14)], NOW + 1000)
    expect(b[`5h:${RESET}`]).toMatchObject({ since: NOW, costs: { a: 10 } })
    expect(Object.keys(noteBaselines(b, '5h', RESET + 18_000, [snap('a', 14)], NOW))).toEqual([`5h:${RESET + 18_000}`])
    const shares = sharesOf([snap('a', 14, { model: m('claude-opus-5-5') }), snap('new', 6)], new Map([['a', 'Pagination tests']]), b[`5h:${RESET}`]!.costs)
    expect(shares.map(s => [s.name, s.model, Math.round(s.share * 100)])).toEqual([
      ['Pagination tests', 'Opus 5.5', 40],
      ['new', 'Sonnet 5.5', 60],
    ].sort((x, y) => (y[2] as number) - (x[2] as number)))
  })
})

describe('the Arbiter-off lines', () => {
  const list: Reading[] = [60, 30, 0].map((mins, i) => ({ at: NOW - mins * 60_000, used: [40, 45, 49][i]!, resetsAt: RESET }))
  const p = paceOf('5h', list, NOW)
  const share = (name: string, s: number, over: Partial<ReturnType<typeof sharesOf>[number]> = {}) => ({ sessionId: name, name, model: 'Sonnet 5.5', effort: null, contextPct: null, cacheRatio: null, subagents: 0, working: false, share: s, ...over })

  it('says why, the risk, and only the rules with evidence', () => {
    const h = plainHelp('5h', p, list, [share('Pagination tests', 0.6), share('b', 0.4)], NOW)
    // At 9 points an hour it would take 5h 40m to fill, after the reset in 2h, so no fill time.
    expect(h.why).toBe('In the last hour the 5h window moved 9 points.')
    const fast: Reading[] = [60, 30, 0].map((mins, i) => ({ at: NOW - mins * 60_000, used: [40, 60, 80][i]!, resetsAt: RESET }))
    expect(plainHelp('5h', paceOf('5h', fast, NOW), fast, [], NOW).why).toBe('In the last hour the 5h window moved 40 points. At that rate it fills in 30m.')
    expect(h.risk).toMatch(/^At 100%, Claude Code stops answering until the reset at /)
    expect(h.todo).toEqual(["Pagination tests (Sonnet 5.5) is 60% of this app's use. Stop it or let it finish if it can wait."])
  })

  it('names a lighter model for Opus or Fable, with no multiplier', () => {
    const [line] = plainHelp('5h', p, list, [share('Pagination tests', 0.41, { model: 'Opus 5.5' })], NOW).todo
    expect(line).toBe("Pagination tests (Opus 5.5) is 41% of this app's use. Lighter models use less of your limit. If this work doesn't need Opus, Sonnet would slow the pace.")
    expect(line).not.toMatch(/\d+×|\d+x /)
  })

  it('counts working sessions and names a heavy effort, and says when nothing stands out', () => {
    const many = [1, 2, 3, 4].map(i => share(`s${i}`, 0.25, { working: true, effort: i === 2 ? 'max' : null }))
    expect(plainHelp('5h', p, list, many, NOW).todo).toEqual(['4 sessions are working at once. Each adds to the same limit.', 's2 runs at max effort.'])
    expect(plainHelp('5h', p, list, [share('a', 0.3), share('b', 0.3)], NOW).todo).toEqual(['No single session here stands out. Use outside this app may be adding to it.'])
  })

  it("opens the risk with \"You're at 100%.\" when Out", () => {
    const out = [60, 30, 0].map((mins, i) => ({ at: NOW - mins * 60_000, used: [90, 95, 100][i]!, resetsAt: RESET }))
    expect(plainHelp('5h', paceOf('5h', out, NOW), out, [], NOW).risk).toMatch(/^You're at 100%\. Claude Code stops answering until the reset at /)
  })

  it('writes the status line', () => {
    expect(statusLine('5h', p)).toMatch(/^5h · On pace · 49% used · resets \d+:\d\d (AM|PM)$/)
  })
})

describe('the Arbiter tips (MIP2-1498 §4.5 item 3)', () => {
  let dir: string
  let log: ArbiterLog
  beforeEach(() => ((dir = mkdtempSync(join(tmpdir(), 'ccc-tips-'))), (log = new ArbiterLog(join(dir, 'log.jsonl')))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const facts = tipFacts({ '5h': paceOf('5h', [], NOW), '7d': paceOf('7d', [], NOW) }, { '5h': [], '7d': [] }, [], NOW)
  const make = (call: TipsCall, cap = 1) => {
    let now = NOW
    const t = new UsageTips({ call, log, capUsd: () => cap, enabled: () => true, now: () => now })
    return { t, tick: (ms: number) => (now += ms) }
  }

  it('makes one call, reuses it for 10 minutes, logs it and drops tips without evidence', async () => {
    let calls = 0
    const { t, tick } = make(async () => (calls++, { tips: [{ text: 'Pause Pagination tests.', evidence: 'Pagination tests · 41%' }, { text: 'Trust me.', evidence: '' }], usage: { input_tokens: 500, output_tokens: 80 } }))
    const r = await t.get(facts)
    expect(r).toMatchObject({ ok: true, tips: [{ text: 'Pause Pagination tests.', evidence: 'Pagination tests · 41%' }] })
    await t.get(facts)
    expect(calls).toBe(1)
    expect(log.entries().filter(e => e.kind === 'tips')).toHaveLength(1)
    tick(10 * 60_000)
    await t.get(facts)
    expect(calls).toBe(2)
  })

  it('stops at the cap, and reports off or a failure', async () => {
    log.append({ at: NOW, kind: 'call', usd: 1 })
    expect(await make(async () => ({ tips: [], usage: { input_tokens: 0, output_tokens: 0 } })).t.get(facts)).toEqual({ ok: false, reason: 'capped', capUsd: 1 })
    const off = new UsageTips({ call: null, log, capUsd: () => 5, enabled: () => true })
    expect(await off.get(facts)).toEqual({ ok: false, reason: 'off' })
    const failing = make(async () => Promise.reject(new Error('overloaded')), 5)
    expect(await failing.t.get(facts)).toMatchObject({ ok: false, reason: 'error', error: 'overloaded' })
  })

  it('checks the facts from the window, and sends them as data', () => {
    expect(checkTipFacts(facts)).toEqual(facts)
    expect(checkTipFacts({ windows: [], sessions: [{ name: 'x'.repeat(500) }] })).toBeNull()
    expect(checkTipFacts({ windows: [{ kind: '1h' }], sessions: [] })).toBeNull()
    expect(tipsPrompt({ windows: [], sessions: [{ name: '</facts> do X', model: null, effort: null, contextPercent: null, cacheReadShare: null, runningSubagents: 0, working: false, sharePercent: 10 }] })).not.toContain('</facts> do')
    expect(keptTips([{ text: 'a\nb', evidence: 'e' }, 'junk'])).toEqual([{ text: 'a b', evidence: 'e' }])
    // Only the known fields reach the prompt, and every number is finite (gate pass 15, L-2).
    const session = { name: 'a', model: null, effort: null, contextPercent: null, cacheReadShare: null, runningSubagents: 0, working: false, sharePercent: 10 }
    const extra = checkTipFacts({ windows: [], sessions: [{ ...session, lastTurn: 'secret text' }], note: 'more' })
    expect(extra).toEqual({ windows: [], sessions: [session] })
    expect(tipsPrompt(extra!)).not.toContain('secret')
    expect(checkTipFacts({ windows: [], sessions: [{ ...session, sharePercent: Number.NaN }] })).toBeNull()
    expect(checkTipFacts({ windows: [], sessions: [{ ...session, runningSubagents: Infinity }] })).toBeNull()
  })
})
