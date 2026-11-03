// Cutting untrusted text to a bound (gate pass 46, L-3; pass 47, M-1, L-3): by user-perceived character, so no emoji,
// flag or accent is split, and by length too, since one character can carry any number of combining marks.

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** The longest text cutGraphemes returns, in UTF-16 code units, whatever the character count. */
export const TEXT_UNITS_MAX = 256

/**
 * The text's first `maxGraphemes` characters, and at most `maxUnits` code
 * units of them: a character that would go past the bound is left out
 * whole. Only the first `maxUnits + 1` units are segmented, so a long input
 * costs no more than a short one.
 */
export function cutGraphemes(text: string, maxGraphemes: number, maxUnits = TEXT_UNITS_MAX): string {
  const head = text.slice(0, maxUnits + 1)
  let out = ''
  let n = 0
  for (const { segment, index } of SEGMENTER.segment(head)) {
    // A character that runs to the end of a cut head may be incomplete: it's left out.
    const partial = head.length < text.length && index + segment.length === head.length
    if (n === maxGraphemes || partial || out.length + segment.length > maxUnits) break
    out += segment
    n++
  }
  return out
}
