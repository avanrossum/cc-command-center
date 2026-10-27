// Bulk select's click gestures (MIP2-1407).

import { describe, expect, it } from 'vitest'
import { NO_SELECTION, selectClick } from '../src/renderer/model/selection.ts'

const order = ['a', 'b', 'c', 'd', 'e']
const meta = { meta: true, shift: false }
const shift = { meta: false, shift: true }

describe('selectClick', () => {
  it('opens the session on a plain click', () => {
    expect(selectClick(NO_SELECTION, 'a', order, { meta: false, shift: false })).toBeNull()
  })

  it('⌘-click starts a selection, and toggles one session in or out', () => {
    const one = selectClick(NO_SELECTION, 'b', order, meta)!
    expect([...one.picked!]).toEqual(['b'])
    expect(one.anchor).toBe('b')
    const two = selectClick(one, 'd', order, meta)!
    expect([...two.picked!].sort()).toEqual(['b', 'd'])
    expect([...selectClick(two, 'b', order, meta)!.picked!]).toEqual(['d'])
  })

  it('⇧-click adds the range from the anchor, either direction, keeping what was picked', () => {
    const start = selectClick(selectClick(NO_SELECTION, 'a', order, meta)!, 'd', order, meta)!
    const down = selectClick(start, 'b', order, shift)!
    expect([...down.picked!].sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(down.anchor).toBe('d')
    const up = selectClick(selectClick(NO_SELECTION, 'e', order, meta)!, 'c', order, shift)!
    expect([...up.picked!].sort()).toEqual(['c', 'd', 'e'])
  })

  it('⇧-click with no anchor in view picks just that session', () => {
    const r = selectClick({ picked: new Set(['z']), anchor: 'z' }, 'c', order, shift)!
    expect([...r.picked!].sort()).toEqual(['c', 'z'])
    expect(r.anchor).toBe('c')
  })
})
