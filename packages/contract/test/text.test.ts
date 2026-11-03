// Cutting untrusted text by character and by length (gate pass 46, L-3; pass 47, M-1, L-3).

import { describe, expect, it } from 'vitest'
import { cutGraphemes, TEXT_UNITS_MAX } from '../src/text.ts'

describe('cutGraphemes', () => {
  it('keeps whole characters, a family emoji among them', () => {
    const fam = '👨‍👩‍👧'
    expect(cutGraphemes(`ab${fam}cd`, 3)).toBe(`ab${fam}`)
    expect(cutGraphemes('Fable', 64)).toBe('Fable')
    expect(cutGraphemes('', 64)).toBe('')
  })

  it('bounds the length, though one character carries 100,000 combining marks', () => {
    const long = `a${'́'.repeat(100_000)}`
    expect(cutGraphemes(long, 64)).toBe('')
    expect(cutGraphemes(`xy${long}`, 64)).toBe('xy')
    expect(cutGraphemes('z'.repeat(1000), 1000).length).toBe(TEXT_UNITS_MAX)
  })

  it('leaves out a character cut off at the length bound, never half of it', () => {
    const text = `${'a'.repeat(9)}👍🏽tail`
    expect(cutGraphemes(text, 64, 10)).toBe('a'.repeat(9))
    expect(cutGraphemes(text, 64, 13)).toBe(`${'a'.repeat(9)}👍🏽`)
  })
})
