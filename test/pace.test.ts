// The pace meter (spec MIP2-1498 §4): projection, bands, hysteresis, Learning, Stale.

import { describe, expect, it } from 'vitest'
import { addReading, PACE_LABEL, paceHover, paceOf, paceWords, settle, type Reading } from '../src/renderer/model/pace.ts'

const NOW = 1_800_000_000_000
const H = 3_600_000
// A 5h window three hours in: it resets in two.
const RESET = (NOW + 2 * H) / 1000
const at = (minsAgo: number, used: number, resetsAt = RESET): Reading => ({ at: NOW - minsAgo * 60_000, used, resetsAt })

describe('pace (MIP2-1498 §4)', () => {
  it('is on pace, tight or over from the projection at reset', () => {
    expect(paceOf('5h', [at(60, 10), at(30, 12), at(0, 14)], NOW).state).toBe('onpace')
    const tight = paceOf('5h', [at(60, 40), at(30, 50), at(0, 60)], NOW)
    expect(tight.state).toBe('tight')
    expect(paceWords('5h', tight, NOW)).toEqual({ word: 'Tight', detail: '~100% at reset' })
    const over = paceOf('5h', [at(60, 40), at(30, 60), at(0, 80)], NOW)
    expect(over.state).toBe('over')
    // 20 points left at about 33 points an hour.
    expect(paceWords('5h', over, NOW)).toEqual({ word: 'Over', detail: 'out in 36m' })
  })

  it('says how early the 7d limit comes', () => {
    const reset = (NOW + 24 * H) / 1000
    const list = [24 * 60, 12 * 60, 0].map((m, i) => ({ at: NOW - m * 60_000, used: [40, 60, 80][i]!, resetsAt: reset }))
    const p = paceOf('7d', list, NOW)
    expect(p.state).toBe('over')
    expect(paceWords('7d', p, NOW)?.detail).toMatch(/^out \d+h \d+m early$/)
  })

  it('holds a more severe state until 2 points inside the less severe band', () => {
    expect(settle('onpace', 'tight', 89)).toBe('tight')
    expect(settle('onpace', 'tight', 87)).toBe('onpace')
    expect(settle('tight', 'over', 99)).toBe('over')
    expect(settle('tight', 'over', 98)).toBe('tight')
    expect(settle('onpace', 'over', 89)).toBe('tight')
    expect(settle('onpace', 'over', 87)).toBe('onpace')
    // More severe applies at once.
    expect(settle('over', 'onpace', 101)).toBe('over')
  })

  it('is Learning early in a window or with fewer than three readings', () => {
    const fresh = (NOW + 5 * H - 10 * 60_000) / 1000
    expect(paceOf('5h', [at(8, 1, fresh), at(4, 2, fresh), at(0, 3, fresh)], NOW).state).toBe('learning')
    expect(paceOf('5h', [at(30, 50), at(0, 60)], NOW).state).toBe('learning')
  })

  it('is Stale past 10 minutes, Reset past the reset, Out at 100%, and never read with none', () => {
    const stale = paceOf('5h', [at(60, 10), at(30, 12), at(11, 14)], NOW)
    expect(stale.state).toBe('stale')
    expect(paceHover('5h', stale)).toMatch(/^Reading from 11m ago\. It updates when a session here sends a request\./)
    expect(paceOf('5h', [at(60, 10, NOW / 1000 - 60)], NOW).state).toBe('reset')
    const out = paceOf('5h', [at(60, 90), at(30, 95), at(0, 100)], NOW)
    expect(out.state).toBe('out')
    expect(paceWords('5h', out, NOW)?.word).toBe('Out')
    expect(paceOf('5h', [], NOW).state).toBe('never')
    // Screen readers get the words, not the state ids.
    expect([PACE_LABEL.onpace, PACE_LABEL.never]).toEqual(['On pace', 'No reading'])
  })

  it('starts a window over when its reset time moves', () => {
    const list = addReading(addReading([], at(10, 50)), at(5, 55))
    expect(list).toHaveLength(2)
    expect(addReading(list, at(0, 2, RESET + 5 * 3600))).toEqual([at(0, 2, RESET + 5 * 3600)])
    expect(addReading(list, at(5, 55))).toHaveLength(2)
  })
})
