// The usage meter when Claude Code reports no 5-hour window, as for a verified Ultra account (MIP2-1610, UX spec
// MIP2-1609): the bar shows 7d then the scoped week, 5h comes back with a reading that has it, the shares count this
// week, and the Arbiter's facts say 5h isn't reported.

import { renderToStaticMarkup } from 'react-dom/server'
import { field, type RateLimits, type SessionSnapshot, type UsageLimit } from '@ccc/contract'
import { describe, expect, it } from 'vitest'
import { checkTipFacts } from '../src/main/usage-tips.ts'
import { TopBar } from '../src/renderer/components/TopBar.tsx'
import { UsagePanel } from '../src/renderer/components/UsagePanel.tsx'
import { ABSENT, type Pace } from '../src/renderer/model/pace.ts'
import { barRows, baseWindow, NO_FIVE_HOUR_NOTE, noteBaselines, sharesOf, sharesSinceText, tipFacts, weeklyOnly, type ExtraLimit } from '../src/renderer/model/usage-help.ts'

const NOW = new Date(2026, 10, 3, 12, 0).getTime()
const H = 3_600_000
const SAT = new Date(2026, 10, 7, 15, 0).getTime() / 1000
const pace = (over: Partial<Pace> = {}): Pace => ({ state: 'onpace', used: 12, resetsAt: SAT, projected: 40, outAt: null, age: 0, ...over })
const scoped = (label: string, p: Partial<Pace> = {}): ExtraLimit => ({
  key: `weekly_scoped:${label}`,
  limit: { kind: 'weekly_scoped', label, usedPercent: p.used ?? 0, resetsAt: SAT },
  pace: pace({ used: 0, ...p }),
})
const weekly = { '5h': ABSENT, '7d': pace() }
const both = { '5h': pace({ resetsAt: (NOW + 2 * H) / 1000 }), '7d': pace() }
// What Claude Code's own /usage listed: the week and no 5-hour window, fresh (MIP2-1613).
const NO5H = { value: { fiveHour: false, sevenDay: true }, stale: false }

describe('the bar with no 5-hour window (MIP2-1609 §2, §3)', () => {
  it('shows 7d then the scoped week by its label, on the 7d rules', () => {
    expect(weeklyOnly(weekly, NO5H)).toBe(true)
    expect(barRows(weekly, [scoped('Fable')], true).map(r => [r.label, r.kind])).toEqual([
      ['7d', '7d'],
      ['Fable', '7d'],
    ])
  })

  it('keeps 5h and 7d while 5h is reported, with no reading, or with a stale one', () => {
    for (const fiveHour of [pace(), pace({ state: 'never', used: null, resetsAt: null }), pace({ state: 'stale' })]) {
      const p = { '5h': fiveHour, '7d': pace() }
      expect(weeklyOnly(p, NO5H)).toBe(false)
      expect(barRows(p, [scoped('Fable')], weeklyOnly(p, NO5H)).map(r => r.label)).toEqual(['5h', '7d'])
    }
  })

  it('puts the most severe scoped week in the bar, the first of equals, and 7d alone with none', () => {
    expect(barRows(weekly, [scoped('Fable'), scoped('Opus', { state: 'tight', projected: 95 })], true).map(r => r.label)).toEqual(['7d', 'Opus'])
    expect(barRows(weekly, [scoped('Fable'), scoped('Opus')], true).map(r => r.label)).toEqual(['7d', 'Fable'])
    const other: ExtraLimit = { key: 'monthly:x', limit: { kind: 'monthly', label: 'x', usedPercent: 5, resetsAt: SAT }, pace: null }
    expect(barRows(weekly, [other], true).map(r => r.label)).toEqual(['7d'])
  })

  it('renders 7d and Fable with no 5h row, then 5h and 7d once a reading has 5h again', () => {
    const extra = field<UsageLimit[]>([{ kind: 'weekly_all', label: null, usedPercent: 12, resetsAt: SAT }, { kind: 'weekly_scoped', label: 'Fable', usedPercent: 0, resetsAt: SAT }], 'usage-report', NOW)
    const render = (limits: RateLimits) =>
      renderToStaticMarkup(
        <TopBar line="" counts={{ needs: 0, working: 0, turn: 0, asked: 0, idle: 0, all: 0, byCategory: {} } as never} usage={field(limits, 'usage-report', NOW)} usageExtra={extra} usageReported={{ value: { fiveHour: !!limits.fiveHour, sevenDay: true }, stale: false }} now={NOW} railOpen onToggleRail={() => {}} onNew={() => {}} />,
      )
    const meter = (html: string) => [...html.matchAll(/<div class="usage">(.*?)<\/div>/g)][0]![1]!
    const weeklyBar = meter(render({ fiveHour: null, sevenDay: { usedPercent: 12, resetsAt: SAT } }))
    expect(weeklyBar).toContain('>7d</span>')
    expect(weeklyBar).toContain('>Fable</span>')
    expect(weeklyBar).not.toContain('>5h</span>')
    expect(weeklyBar.indexOf('>7d</span>')).toBeLessThan(weeklyBar.indexOf('>Fable</span>'))
    const back = meter(render({ fiveHour: { usedPercent: 30, resetsAt: (NOW + 2 * H) / 1000 }, sevenDay: { usedPercent: 12, resetsAt: SAT } }))
    expect(back).toContain('>5h</span>')
    expect(back).toContain('>7d</span>')
    expect(back).not.toContain('Fable')
  })

  it('cuts a label longer than 6 characters, with the full label on hover', () => {
    const extra = field<UsageLimit[]>([{ kind: 'weekly_scoped', label: 'Sonnet 5', usedPercent: 0, resetsAt: SAT }], 'usage-report', NOW)
    const html = renderToStaticMarkup(
      <TopBar line="" counts={{ needs: 0, working: 0, turn: 0, asked: 0, idle: 0, all: 0, byCategory: {} } as never} usage={field<RateLimits>({ fiveHour: null, sevenDay: { usedPercent: 12, resetsAt: SAT } }, 'usage-report', NOW)} usageExtra={extra} usageReported={NO5H} now={NOW} railOpen onToggleRail={() => {}} onNew={() => {}} />,
    )
    expect(html).toContain('>Sonne…</span>')
    expect(html).toMatch(/title="Sonnet 5\. /)
  })
})

describe('the shares over this week (MIP2-1609 §5)', () => {
  const s = (id: string, cost: number): SessionSnapshot =>
    ({ contractVersion: 1, sessionId: id, kind: field('background', 'agents-json', NOW), startedAt: field(NOW - 240 * H, 'agents-json', NOW), activity: field('idle', 'agents-json', NOW), costUsd: field(cost, 'mod', NOW) }) as unknown as SessionSnapshot

  it('count from the week\'s baseline when 5h is not reported, and from 5h when it is', () => {
    expect(baseWindow(weeklyOnly(weekly, NO5H))).toBe('7d')
    expect(baseWindow(weeklyOnly(both, NO5H))).toBe('5h')
    const b = noteBaselines({}, '7d', SAT, [s('a', 1), s('b', 2)], NOW)
    const shares = sharesOf([s('a', 4), s('b', 3)], new Map(), b[`7d:${SAT}`]?.costs)
    expect(shares.map(x => [x.sessionId, Math.round(x.share * 100)])).toEqual([
      ['a', 75],
      ['b', 25],
    ])
  })

  it("name the window in the heading, and say since when there's nothing yet", () => {
    const since = new Date(2026, 10, 3, 9, 14).getTime()
    expect(sharesSinceText('7d', since)).toBe('this week, since Tue 9:14 AM')
    expect(sharesSinceText('5h', since)).toBe('since 9:14 AM')
    const html = renderToStaticMarkup(<UsagePanel paces={weekly} lists={{ '5h': [], '7d': [] }} extras={[scoped('Fable')]} shares={[]} sharesSince={since} base="7d" weekly arbiterOn={false} now={NOW} onOpen={() => {}} onClose={() => {}} />)
    expect(html).toContain("This app&#x27;s sessions · this week, since Tue 9:14 AM")
    expect(html).toContain('No session here has reported a cost since Tue 9:14 AM.')
  })
})

describe('the help panel with no 5-hour window (MIP2-1609 §4, §6)', () => {
  it('lists the reported limits, the most severe first, then the note, with no 5h line', () => {
    const html = renderToStaticMarkup(
      <UsagePanel paces={weekly} lists={{ '5h': [], '7d': [] }} extras={[scoped('Fable', { state: 'tight', used: 80, projected: 94 })]} shares={[]} base="7d" weekly arbiterOn={false} now={NOW} onOpen={() => {}} onClose={() => {}} />,
    )
    expect(html).not.toContain('5h ·')
    expect(html.indexOf('Fable week · Tight')).toBeLessThan(html.indexOf('7d · On pace'))
    expect(html).toContain(NO_FIVE_HOUR_NOTE.replace(/'/g, '&#x27;'))
    // The note's words, as Research and UX settled them (MIP2-1615; gate pass 47, L-4).
    expect(NO_FIVE_HOUR_NOTE).toBe("Claude Code's usage report shows no 5-hour window right now. Verified Ultra accounts don't have one.")
    // The Fable week at Tight brings its risk line; 7d is the panel's own window.
    expect(html).toContain('At 100%, Fable stops answering until')
  })

  it('reads as calm when every reported limit is on pace', () => {
    const html = renderToStaticMarkup(<UsagePanel paces={weekly} lists={{ '5h': [], '7d': [] }} extras={[scoped('Fable')]} shares={[]} base="7d" weekly arbiterOn={false} now={NOW} onOpen={() => {}} onClose={() => {}} />)
    expect(html).toContain('Both windows are on pace.')
    // 7d alone, then 5h, 7d and a scoped week (MIP2-1610 UX review).
    const alone = renderToStaticMarkup(<UsagePanel paces={weekly} lists={{ '5h': [], '7d': [] }} extras={[]} shares={[]} base="7d" weekly arbiterOn={false} now={NOW} onOpen={() => {}} onClose={() => {}} />)
    expect(alone).toContain('The week is on pace.')
    const three = renderToStaticMarkup(<UsagePanel paces={both} lists={{ '5h': [], '7d': [] }} extras={[scoped('Fable')]} shares={[]} arbiterOn={false} now={NOW} onOpen={() => {}} onClose={() => {}} />)
    expect(three).toContain('All windows are on pace.')
    expect(html).not.toContain('Risk:')
  })
})

describe("the Arbiter's facts (MIP2-1609 §6)", () => {
  it('send the reported windows only, and say 5h is not reported, through the main-side check', () => {
    const facts = tipFacts(weekly, { '5h': [], '7d': [] }, [], NOW, true)
    expect(facts.windows.map(w => w.kind)).toEqual(['7d'])
    expect(facts.fiveHour).toBe('not reported')
    expect(checkTipFacts(facts)).toEqual(facts)
    expect(tipFacts(both, { '5h': [], '7d': [] }, [], NOW)).not.toHaveProperty('fiveHour')
    expect(checkTipFacts({ ...facts, fiveHour: 'none' })).toBeNull()
    // 5h said to be unreported can't come with a 5h window (gate pass 46, L-2).
    expect(checkTipFacts({ ...tipFacts(both, { '5h': [], '7d': [] }, [], NOW), fiveHour: 'not reported' })).toBeNull()
  })
})

describe('no 5-hour window only on /usage\'s word (gate pass 45, M-1, L-1, L-3)', () => {
  it("keeps 5h's neutral Not reported, 5h shares and no Ultra note when /usage didn't say so", () => {
    for (const reported of [null, { value: { fiveHour: false, sevenDay: true }, stale: true }, { value: { fiveHour: true, sevenDay: true }, stale: false }]) {
      expect(weeklyOnly(weekly, reported)).toBe(false)
      expect(baseWindow(weeklyOnly(weekly, reported))).toBe('5h')
    }
    // A statusline-only reading: 7d, and a 5h dropped for lacking its reset time.
    const html = renderToStaticMarkup(
      <TopBar line="" counts={{ needs: 0, working: 0, turn: 0, asked: 0, idle: 0, all: 0, byCategory: {} } as never} usage={field<RateLimits>({ fiveHour: null, sevenDay: { usedPercent: 12, resetsAt: SAT } }, 'statusline', NOW)} now={NOW} railOpen onToggleRail={() => {}} onNew={() => {}} help />,
    )
    expect(html).toContain('>5h</span>')
    expect(html).toContain('5h · Not reported now')
    expect(html).not.toContain('Verified Ultra')
    const facts = tipFacts(weekly, { '5h': [], '7d': [] }, [], NOW)
    expect(facts).not.toHaveProperty('fiveHour')
    expect(facts.windows.map(w => w.kind)).toEqual(['5h', '7d'])
  })

  it('has its own calm line when no window is reported', () => {
    const none = { '5h': ABSENT, '7d': ABSENT }
    const html = renderToStaticMarkup(<UsagePanel paces={none} lists={{ '5h': [], '7d': [] }} extras={[]} shares={[]} arbiterOn={false} now={NOW} onOpen={() => {}} onClose={() => {}} />)
    expect(html).toContain('Claude Code isn&#x27;t reporting any usage limits right now.')
  })

  it('cuts a label by character, never inside one, and names an empty label Model (gate pass 47, L-4)', () => {
    const extra = field<UsageLimit[]>([{ kind: 'weekly_scoped', label: 'Fa\u{1F600}ble😀x', usedPercent: 0, resetsAt: SAT }], 'usage-report', NOW)
    const html = renderToStaticMarkup(
      <TopBar line="" counts={{ needs: 0, working: 0, turn: 0, asked: 0, idle: 0, all: 0, byCategory: {} } as never} usage={field<RateLimits>({ fiveHour: null, sevenDay: { usedPercent: 12, resetsAt: SAT } }, 'usage-report', NOW)} usageExtra={extra} usageReported={NO5H} now={NOW} railOpen onToggleRail={() => {}} onNew={() => {}} />,
    )
    expect(html).toContain('>Fa\u{1F600}bl…</span>')
    // A family emoji is one character, never cut inside (gate pass 46, L-3).
    const fam = '👨\u200d👩\u200d👧'
    const famHtml = renderToStaticMarkup(
      <TopBar line="" counts={{ needs: 0, working: 0, turn: 0, asked: 0, idle: 0, all: 0, byCategory: {} } as never} usage={field<RateLimits>({ fiveHour: null, sevenDay: { usedPercent: 12, resetsAt: SAT } }, 'usage-report', NOW)} usageExtra={field<UsageLimit[]>([{ kind: 'weekly_scoped', label: `ABCD${fam}EF`, usedPercent: 0, resetsAt: SAT }], 'usage-report', NOW)} usageReported={NO5H} now={NOW} railOpen onToggleRail={() => {}} onNew={() => {}} />,
    )
    expect(famHtml).toContain(`>ABCD${fam}…</span>`)
    expect(barRows(weekly, [{ ...scoped(''), limit: { kind: 'weekly_scoped', label: '', usedPercent: 0, resetsAt: SAT } }], true).map(r => r.label)).toEqual(['7d', 'Model'])
  })
})
