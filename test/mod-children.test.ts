// The mod's reading of `claude --bg` output in a Bash result (MIP2-1392, MIP2-1410).

import { describe, expect, it } from 'vitest'
import { backgroundedChildren } from '../mod/hooks/children.ts'

describe('backgroundedChildren', () => {
  it('reads the short id and name Claude Code prints', () => {
    const r = { result: { stdout: 'backgrounded · c0ffee09 · ccc-1392-child\n  claude attach c0ffee09    open in this terminal\n' } }
    expect(backgroundedChildren(r)).toEqual([{ shortId: 'c0ffee09', name: 'ccc-1392-child' }])
  })

  it('takes an unnamed child and several in one call, once each', () => {
    const r = { result: { stdout: 'backgrounded · c0ffee01\nbackgrounded · c0ffee0a · two\nbackgrounded · c0ffee0a · two' } }
    expect(backgroundedChildren(r)).toEqual([
      { shortId: 'c0ffee01', name: null },
      { shortId: 'c0ffee0a', name: 'two' },
    ])
  })

  it('finds nothing in other output, a deny, or no result', () => {
    expect(backgroundedChildren({ result: { stdout: 'ok' } })).toEqual([])
    expect(backgroundedChildren({ deny: 'no' })).toEqual([])
    expect(backgroundedChildren(undefined)).toEqual([])
  })
})
