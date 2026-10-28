// The session switcher's order, limits and pins (spec MIP2-1494 §5.3–5.5), and the sidebar's width and empty-categories control (MIP2-1495).

import { describe, expect, it } from 'vitest'
import { checkStore } from '../src/main/store-schema.ts'
import { emptyCategoriesLabel } from '../src/renderer/components/Sidebar.tsx'
import { clampSidebarWidth } from '../src/shared/store.ts'
import { chipIds, chipName, cycle, fitStrip, moveChip, movePin, noteOpened, pruned, removeRecent, togglePin, type SwitcherLists } from '../src/renderer/model/switcher.ts'

const empty: SwitcherLists = { pins: [], recent: [] }
const open = (ids: string[], start = empty) => {
  const at = new Map<string, number>()
  let l = start
  ids.forEach((id, t) => {
    l = noteOpened(l, id, at)
    at.set(id, t)
  })
  return { l, at }
}

describe('the switcher (MIP2-1494 §5.3)', () => {
  it('keeps the last five opened, in order of first opening, and never reorders on a switch', () => {
    const { l } = open(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(l.recent).toEqual(['b', 'c', 'd', 'e', 'f'])
    expect(open(['a', 'b', 'c', 'a', 'b']).l.recent).toEqual(['a', 'b', 'c'])
  })

  it('drops the least recently focused recent, not the leftmost', () => {
    const { l, at } = open(['a', 'b', 'c', 'd', 'e', 'a'])
    expect(l.recent).toEqual(['a', 'b', 'c', 'd', 'e'])
    at.set('a', 10)
    expect(noteOpened(l, 'f', at).recent).toEqual(['a', 'c', 'd', 'e', 'f'])
  })

  it('puts pins first, leaves pinned sessions out of the recents, and skips unlisted ones', () => {
    const l = { pins: ['p', 'q'], recent: ['a', 'b'] }
    expect(chipIds(l, new Set(['p', 'q', 'a', 'b']))).toEqual(['p', 'q', 'a', 'b'])
    expect(chipIds(l, new Set(['q', 'b']))).toEqual(['q', 'b'])
    expect(noteOpened(l, 'p', new Map())).toBe(l)
    expect(pruned(l, new Set(['q', 'a']))).toEqual({ pins: ['q'], recent: ['a'] })
  })

  it('pins to the end and unpins the current session back into the recents', () => {
    const l = togglePin({ pins: ['p'], recent: ['a', 'b'] }, 'a', 'a', new Map())
    expect(l).toEqual({ pins: ['p', 'a'], recent: ['b'] })
    expect(togglePin(l, 'a', 'a', new Map())).toEqual({ pins: ['p'], recent: ['b', 'a'] })
    expect(togglePin(l, 'a', 'b', new Map())).toEqual({ pins: ['p'], recent: ['b'] })
  })

  it('moves a chip within its group, and a dragged pin before another', () => {
    const l = { pins: ['p', 'q', 'r'], recent: ['a', 'b'] }
    expect(moveChip(l, 'q', -1).pins).toEqual(['q', 'p', 'r'])
    expect(moveChip(l, 'p', -1)).toEqual(l)
    expect(moveChip(l, 'a', 1).recent).toEqual(['b', 'a'])
    expect(movePin(l, 'r', 'p').pins).toEqual(['r', 'p', 'q'])
    expect(movePin(l, 'p', null).pins).toEqual(['q', 'r', 'p'])
    expect(removeRecent(l, 'a').recent).toEqual(['b'])
  })

  it('cycles with wrapping (§5.4)', () => {
    expect(cycle(['a', 'b', 'c'], 'c', 1)).toBe('a')
    expect(cycle(['a', 'b', 'c'], 'a', -1)).toBe('c')
    expect(cycle(['a', 'b', 'c'], null, 1)).toBe('a')
    expect(cycle([], 'a', 1)).toBeNull()
  })

  it('shortens names first, then moves recents into the menu oldest first, then pins', () => {
    const names = new Map(['p', 'a', 'b', 'c'].map(id => [id, 'a-fairly-long-session-name']))
    const chips = ['p', 'a', 'b', 'c']
    expect(fitStrip(chips, ['p'], names, 2000)).toEqual({ shown: chips, overflow: [], short: false })
    expect(fitStrip(chips, ['p'], names, 600)).toMatchObject({ shown: chips, short: true })
    const tight = fitStrip(chips, ['p'], names, 300)
    expect(tight.overflow[0]).toBe('a')
    expect(tight.shown).toContain('p')
    expect(fitStrip(chips, ['p'], names, 10).overflow).toEqual(['a', 'b', 'c', 'p'])
    expect(chipName('a-fairly-long-session-name', 10)).toBe('a-fairly-…')
    // A measured width wins over the estimate.
    const wide = new Map(chips.map(id => [`${id}:18`, 600]))
    expect(fitStrip(chips, ['p'], names, 2000, wide).short).toBe(true)
  })
})

describe('the sidebar (MIP2-1495)', () => {
  it('keeps its width within 200–480 px, and a saved width only in that range', () => {
    expect(clampSidebarWidth(100)).toBe(200)
    expect(clampSidebarWidth(900)).toBe(480)
    expect(clampSidebarWidth(321.6)).toBe(322)
    expect(clampSidebarWidth(Number.NaN)).toBe(236)
    expect(checkStore({ version: 1, settings: { sidebarWidth: 320 } }).settings.sidebarWidth).toBe(320)
    expect(checkStore({ version: 1, settings: { sidebarWidth: 5000 } }).settings.sidebarWidth).toBeUndefined()
  })

  it('names the empty-categories action, with no arrow', () => {
    expect(emptyCategoriesLabel(false)).toBe('Show empty categories')
    expect(emptyCategoriesLabel(true)).toBe('Hide empty categories')
  })
})
