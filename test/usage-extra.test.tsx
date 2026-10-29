// What /usage adds (MIP2-1522, spec MIP2-1498 §9): usage credits as a spend source, and limits beside 5h and 7d.

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { UsageLimit } from '@ccc/contract'
import { CreditsPanel, spendAmount, spendHover } from '../src/renderer/components/Spend.tsx'
import type { Pace } from '../src/renderer/model/pace.ts'
import { extraStatusLine, limitLabel, plainHelp, scopedRisk, scopedTodo, type ExtraLimit } from '../src/renderer/model/usage-help.ts'
import { creditsMoney, type SpendState } from '../src/shared/spend.ts'

const NOW = new Date(2026, 9, 29, 12, 0).getTime()
const SAT = new Date(2026, 9, 31, 15, 0).getTime() / 1000
const pace = (over: Partial<Pace>): Pace => ({ state: 'onpace', used: 40, resetsAt: SAT, projected: 60, outAt: null, age: 0, ...over })
const fable: UsageLimit = { kind: 'weekly_scoped', label: 'Fable', usedPercent: 40, resetsAt: SAT }
const share = (name: string, s: number, model: string | null) => ({ sessionId: name, name, model, effort: null, contextPct: null, cacheRatio: null, subagents: 0, working: false, share: s })

describe('extra limits (§9.2)', () => {
  it('names a scoped week by its model, and an unknown unnamed kind as Other limit', () => {
    expect(limitLabel(fable)).toBe('Fable week')
    expect(limitLabel({ kind: 'monthly_new', label: null, usedPercent: 1, resetsAt: null })).toBe('Other limit')
    expect(limitLabel({ kind: 'monthly_new', label: 'Code review', usedPercent: 1, resetsAt: null })).toBe('Code review')
  })

  it('reads as percent and reset on pace, with the pace word and projection when Tight, and plainly for a kind with no pace', () => {
    const resets = new Date(SAT * 1000).toLocaleDateString('en-US', { weekday: 'short' })
    expect(extraStatusLine({ key: 'k', limit: fable, pace: pace({}) })).toMatch(new RegExp(`^Fable week · 40% used · resets ${resets}`))
    expect(extraStatusLine({ key: 'k', limit: { ...fable, usedPercent: 71 }, pace: pace({ state: 'tight', used: 71, projected: 94 }) })).toMatch(/^Fable week · Tight · 71% used · ~94% by /)
    expect(extraStatusLine({ key: 'k', limit: { kind: 'odd', label: null, usedPercent: 12, resetsAt: null }, pace: null })).toBe('Other limit · 12% used')
  })

  it('a scoped limit at Tight or worse says which model stops and that others keep working, and names a top session on it', () => {
    const tight: ExtraLimit = { key: 'k', limit: fable, pace: pace({ state: 'tight' }) }
    expect(scopedRisk(tight)).toMatch(/^At 100%, Fable stops answering until .+\. Other models keep working\.$/)
    expect(scopedRisk({ ...tight, pace: pace({}) })).toBeNull()
    expect(scopedTodo(tight, [share('Engine refactor', 0.41, 'Fable 5.1')])).toBe("Engine refactor (Fable 5.1) is 41% of this app's use. Fable has its own weekly limit; other models aren't affected by it.")
    expect(scopedTodo(tight, [share('Docs', 0.6, 'Sonnet 5.5')])).toBeNull()
  })
})

describe('usage credits (§9.1)', () => {
  const credits = { enabled: true, used: 1240, limit: 5000, currency: 'USD', at: NOW - 120_000 }
  const state = (over: Partial<SpendState>): SpendState => ({
    source: 'credits',
    simulated: { totalUsd: 0, todayUsd: 0, topSessions: [], byModel: [], noCost: 0 },
    real: { configured: false, totalUsd: null, todayUsd: null, byModel: [], at: null, error: null, errorAt: null },
    credits,
    ...over,
  })

  it('shows money in minor units, with no ≈ and no month', () => {
    expect(creditsMoney(1240, 'USD')).toBe('$12.40')
    expect(creditsMoney(1240, 'EUR')).toBe('12.40 EUR')
    expect(spendAmount(state({}), NOW)).toEqual({ text: '$12.40', stale: false })
    expect(spendHover(state({}), NOW)).toBe("Usage credits spent this billing period, as Claude Code's /usage reports it. The reset date isn't reported.")
  })

  it('shows the cap with a bar, or says no cap is reported, never "unlimited"', () => {
    const capped = renderToStaticMarkup(<CreditsPanel credits={credits} now={NOW} />)
    expect(capped).toContain('of $50.00 cap')
    expect(capped).toContain('credits-bar')
    expect(capped).toContain('/usage, read 2m ago. Billing period as your plan sets it.')
    const open = renderToStaticMarkup(<CreditsPanel credits={{ ...credits, limit: null }} now={NOW} />)
    expect(open).toContain('Claude Code reports no cap for usage credits. Your plan')
    expect(open).toContain('settings in claude.ai still apply.')
    expect(open).not.toContain('credits-bar')
    expect(open.toLowerCase()).not.toContain('unlimited')
    const off = renderToStaticMarkup(<CreditsPanel credits={{ ...credits, enabled: false }} now={NOW} />)
    expect(off).toMatch(/^<div class="up-sec"><p>Usage credits are off on your plan\.<\/p>/)
    expect(off).not.toContain('credits-bar')
    expect(off).toContain('of $50.00 cap')
  })

  it("the risk line names credit spend when it's on, with the cap, and keeps the general sentence otherwise", () => {
    const p = pace({ state: 'tight', resetsAt: (NOW + 3 * 3_600_000) / 1000 })
    expect(plainHelp('5h', p, [], [], NOW, credits).risk).toMatch(/Usage credits are on: sessions keep going at API rates, \$12\.40 of a \$50\.00 cap spent so far this period\.$/)
    expect(plainHelp('5h', p, [], [], NOW, { ...credits, limit: null }).risk).toMatch(/\$12\.40 spent so far this period\.$/)
    expect(plainHelp('5h', p, [], [], NOW, null).risk).toMatch(/If usage credits are on, sessions keep going at API rates/)
    expect(plainHelp('5h', p, [], [], NOW, { ...credits, enabled: false }).risk).toMatch(/until the reset at .+\. Usage credits are off, so nothing continues until then\.$/)
  })
})
