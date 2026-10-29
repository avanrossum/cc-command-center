// Spend (spec MIP2-1498 §5): the simulated ledger, the cost report, and the indicator's amount.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { field, type SessionSnapshot } from '@ccc/contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { checkLedger, fetchMonthCost, monthStartUtc, RealSpendPoller, SpendLedger, type Fetch } from '../src/main/spend.ts'
import { spendAmount } from '../src/renderer/components/Spend.tsx'
import type { SpendState } from '../src/shared/spend.ts'

const OCT28 = new Date(2026, 9, 28, 12, 0).getTime()
const NOV1 = new Date(2026, 10, 1, 9, 0).getTime()
let dir: string
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'ccc-spend-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function snap(id: string, cost: number | undefined, startedAt: number, model = 'claude-opus-5-5'): SessionSnapshot {
  const f = <T,>(v: T) => field(v, 'agents-json', startedAt)
  return {
    contractVersion: 1,
    sessionId: id,
    kind: f('background'),
    cwd: f('/w'),
    startedAt: f(startedAt),
    name: f(id),
    shortId: f(id),
    pid: f(1),
    activity: f('working'),
    needsYou: f(null),
    model: field(model, 'mod', startedAt),
    ...(cost === undefined ? {} : { costUsd: field(cost, 'mod', startedAt) }),
  }
}

describe('simulated spend (MIP2-1498 §5.2)', () => {
  it('adds each reading\'s increase to its month, by session and model, and counts a month-spanning session only in part', () => {
    const l = new SpendLedger(join(dir, 'spend.json'), 0)
    const early = new Date(2026, 8, 30).getTime()
    // An older session's cost before its first reading can't be split by month, so it starts from there.
    l.observe([snap('old', 5, early), snap('new', 2, OCT28 - 3_600_000, 'claude-sonnet-5-5')], OCT28)
    l.observe([snap('old', 7, early), snap('new', 3, OCT28 - 3_600_000, 'claude-sonnet-5-5')], OCT28 + 1000)
    const oct = l.current(OCT28 + 1000)
    expect(oct.totalUsd).toBeCloseTo(5)
    expect(oct.topSessions).toEqual([{ sessionId: 'new', usd: 3 }, { sessionId: 'old', usd: 2 }])
    expect(oct.byModel).toEqual([{ model: 'claude-sonnet-5-5', usd: 3 }, { model: 'claude-opus-5-5', usd: 2 }])
    // Into November: only November's increase counts there.
    l.observe([snap('old', 9, early)], NOV1)
    expect(l.current(NOV1).totalUsd).toBeCloseTo(2)
    expect(l.current(NOV1).todayUsd).toBeCloseTo(2)
  })

  it('counts from zero after a /clear, notes sessions with no cost, and survives a restart', () => {
    const path = join(dir, 'spend.json')
    const l = new SpendLedger(path, 0)
    l.observe([snap('a', 4, OCT28 - 1000), snap('b', undefined, OCT28 - 1000)], OCT28)
    l.observe([snap('a', 1, OCT28 - 1000)], OCT28 + 1)
    expect(l.current(OCT28).totalUsd).toBeCloseTo(5)
    l.observe([snap('a', 1, OCT28 - 1000), snap('b', undefined, OCT28 - 1000)], OCT28 + 2)
    expect(l.current(OCT28).noCost).toBe(1)
    l.save()
    expect(new SpendLedger(path).current(OCT28).totalUsd).toBeCloseTo(5)
  })
})

describe('real spend (MIP2-1498 §5.2)', () => {
  const page = (buckets: { start: string; end: string; amounts: [string, string | null][] }[], next: string | null = null) => ({
    data: buckets.map(b => ({ starting_at: b.start, ending_at: b.end, results: b.amounts.map(([amount, model]) => ({ amount, currency: 'USD', model })) })),
    has_more: next !== null,
    next_page: next,
  })
  const NOW = Date.parse('2026-10-28T15:00:00Z')

  it('sums the month\'s cents by model across pages, with today the bucket holding now, and sends the key as x-api-key', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    const pages = [
      page([{ start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z', amounts: [['1234.5', 'claude-haiku-5-5']] }], 'p2'),
      page([{ start: '2026-10-28T00:00:00Z', end: '2026-10-29T00:00:00Z', amounts: [['100', 'claude-haiku-5-5'], ['50', null]] }]),
    ]
    const fetchFn: Fetch = async (url, init) => (seen.push({ url, headers: init.headers }), { ok: true, status: 200, json: async () => pages.shift(), text: async () => '' })
    const r = await fetchMonthCost('sk-ant-admin01-x', NOW, fetchFn)
    expect(r.totalUsd).toBeCloseTo(13.845)
    expect(r.todayUsd).toBeCloseTo(1.5)
    expect(r.byModel).toEqual([{ model: 'claude-haiku-5-5', usd: 13.345 }, { model: 'other', usd: 0.5 }])
    expect(seen[0]!.headers).toMatchObject({ 'x-api-key': 'sk-ant-admin01-x', 'anthropic-version': '2023-06-01' })
    expect(seen[0]!.url).toContain(`starting_at=${encodeURIComponent(monthStartUtc(NOW))}`)
    expect(seen[0]!.url).toContain('group_by%5B%5D=description')
    expect(seen[1]!.url).toContain('page=p2')
  })

  it("shows the API's own message on failure and keeps the last amount", async () => {
    let fail = false
    const fetchFn: Fetch = async () =>
      fail
        ? { ok: false, status: 401, json: async () => ({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), text: async () => '' }
        : { ok: true, status: 200, json: async () => page([{ start: '2026-10-28T00:00:00Z', end: '2026-10-29T00:00:00Z', amounts: [['200', 'm']] }]), text: async () => '' }
    let key: string | null = 'sk-ant-admin01-x'
    const p = new RealSpendPoller(() => key, fetchFn, () => {}, () => NOW)
    await p.poll()
    fail = true
    await p.poll()
    expect(p.current()).toMatchObject({ configured: true, totalUsd: 2, error: 'invalid x-api-key' })
    expect(await p.test('sk-ant-admin01-y')).toEqual({ ok: false, error: 'invalid x-api-key' })
    key = null
    await p.poll()
    expect(p.current()).toMatchObject({ configured: false, totalUsd: null })
  })
})

describe('the indicator (MIP2-1498 §5.1, §5.4)', () => {
  const state = (over: Partial<SpendState>): SpendState => ({
    source: 'simulated',
    simulated: { totalUsd: 184.2, todayUsd: 0, topSessions: [], byModel: [], noCost: 0 },
    real: { configured: false, totalUsd: null, todayUsd: null, byModel: [], at: null, error: null, errorAt: null },
    ...over,
  })
  it('marks simulated with ≈, real with no key as $—, and a failed real poll as stale', () => {
    expect(spendAmount(state({}), 0)).toEqual({ text: '≈$184.20', stale: false })
    expect(spendAmount(state({ source: 'real' }), 0)).toEqual({ text: '$—', stale: false })
    const real = { configured: true, totalUsd: 12.4, todayUsd: 1, byModel: [], at: 0, error: 'HTTP 500', errorAt: 1 }
    expect(spendAmount(state({ source: 'real', real }), 1000)).toEqual({ text: '$12.40', stale: true })
  })
})

describe('the ledger file (gate pass 15, M-2, L-3)', () => {
  it("survives the report's two malformed files and still counts", () => {
    for (const bad of ['{"version":1,"last":null,"months":{}}', '{"version":1,"last":{},"months":{"2026-10":{}}}']) {
      const path = join(dir, `bad-${bad.length}.json`)
      writeFileSync(path, bad)
      const l = new SpendLedger(path, 0)
      expect(() => l.observe([snap('a', 2, OCT28 - 1000)], OCT28)).not.toThrow()
      expect(l.current(OCT28).totalUsd).toBeCloseTo(2)
    }
  })

  it('drops a bad month and keeps a good one, and keeps key names like constructor as plain keys', () => {
    const d = checkLedger({
      version: 2,
      since: 1,
      last: { a: 1 },
      months: { '2026-10': { total: 3, bySession: { a: 3 }, byModel: { constructor: 3 }, byDay: {} }, '2026-09': { total: 'x', bySession: {}, byModel: {}, byDay: {} }, junk: {} },
    })
    expect(Object.keys(d.months)).toEqual(['2026-10'])
    const l = new SpendLedger(join(dir, 'k.json'), 0)
    l.observe([snap('c', 1, OCT28 - 1000, 'constructor'), snap('p', 1, OCT28 - 1000, '__proto__')], OCT28)
    expect(l.current(OCT28).byModel.map(m => m.model).sort()).toEqual(['__proto__', 'constructor'])
    expect(l.current(OCT28).totalUsd).toBeCloseTo(2)
  })

  it("forgets the last cost of a session that's gone and spent nothing in the kept months, but not one that spent", () => {
    const path = join(dir, 'p.json')
    const l = new SpendLedger(path, 0)
    const early = new Date(2026, 8, 1).getTime()
    l.observe([snap('idle', 5, early), snap('spent', 1, OCT28 - 1000)], OCT28)
    l.observe([], OCT28 + 1)
    l.save()
    const last = (JSON.parse(readFileSync(path, 'utf8')) as { last: Record<string, number> }).last
    expect(Object.keys(last)).toEqual(['spent'])
    // The session that spent comes back: its earlier cost isn't counted twice.
    l.observe([snap('spent', 1, OCT28 - 1000)], OCT28 + 2)
    expect(l.current(OCT28).totalUsd).toBeCloseTo(1)
  })
})

describe('the cost report request (gate pass 15, L-1)', () => {
  it('refuses redirects, so x-api-key never goes to another origin', async () => {
    let redirect: string | undefined
    const fetchFn: Fetch = async (_url, init) => ((redirect = init.redirect), { ok: true, status: 200, json: async () => ({ data: [], has_more: false, next_page: null }), text: async () => '' })
    await fetchMonthCost('sk-ant-admin01-x', Date.now(), fetchFn)
    expect(redirect).toBe('error')
  })
})

describe('first sight is a baseline (MIP2-1521)', () => {
  const OCT29 = new Date(2026, 9, 29, 9, 0).getTime()
  it("doesn't count a session's lifetime cost on the day the app first sees it", () => {
    const l = new SpendLedger(join(dir, 'b.json'), 0)
    const all = (old: number) => [
      // Started before this month: its cost so far is a baseline.
      snap('old', old, new Date(2026, 8, 20).getTime()),
      // Started earlier this month: its cost so far belongs to the day it started, not today.
      snap('mid', 500, new Date(2026, 9, 12, 15).getTime()),
      // Started today: counts today.
      snap('new', 2, OCT29 - 3_600_000),
    ]
    l.observe(all(3406.74), OCT29)
    const c = l.current(OCT29)
    expect(c.totalUsd).toBeCloseTo(502)
    expect(c.todayUsd).toBeCloseTo(2)
    // Later increases count where they happen.
    l.observe(all(3410.74), OCT29 + 1000)
    expect(l.current(OCT29).todayUsd).toBeCloseTo(6)
  })

  it('rebuilds a version 1 ledger, which booked first sights to today, and says since when it counts', () => {
    const path = join(dir, 'v1.json')
    writeFileSync(path, JSON.stringify({ version: 1, last: { old: 5000 }, months: { '2026-10': { total: 5250, bySession: { old: 5250 }, byModel: {}, byDay: { '2026-10-29': 5250 } } } }))
    const l = new SpendLedger(path, 0)
    l.observe([snap('old', 5000, new Date(2026, 8, 20).getTime())], OCT29)
    expect(l.current(OCT29)).toMatchObject({ totalUsd: 0, todayUsd: 0 })
    expect(l.current(OCT29).since).toBeGreaterThan(0)
  })

  it('names the sessions that reported no cost', () => {
    const l = new SpendLedger(join(dir, 'n.json'), 0)
    l.observe([snap('quiet', undefined, OCT29 - 1000)], OCT29)
    expect(l.current(OCT29)).toMatchObject({ noCost: 1, noCostIds: ['quiet'] })
  })
})
