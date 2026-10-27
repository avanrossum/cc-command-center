// Alex's client and project names stay out of the repository (MIP2-1405):
// tests and fixtures use synthetic names ("Acme …"). The names are listed
// here only as SHA-256 hashes of the lowercase word, so this file doesn't
// carry them either. Every word of every tracked text file is checked.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** Lowercase words, hashed: a client, its category labels, and Alex's project names from 0.24. */
const DENIED = new Set([
  'c11b7fe1ac764786021ba3109afba9b42dec5b1963ccc0368546bb88ce2943c8',
  '513392b9b02ffab72520a7c1fa866b6c811cc38711ab98fedd9ecccd1a5738f1',
  '4b6f50ec6e0629790e0dad1d0b5b83437ff8f01d35a7150ebc92bbedd0805b78',
  '8be52b2ce417014666f87b597392980ea3f1bea6afc5e8091743c3706730ea8d',
  '8f5534c1072e83e66d99699563bdc100621b628aba0bfa9b6d53a05f405b68f1',
  '4b4cfef9247a9272d7258fc36a330c4a42890770869995739ca996fedc3b873c',
])

const sha = (w: string) => createHash('sha256').update(w).digest('hex')
const ROOT = new URL('..', import.meta.url)

export function deniedWords(text: string): string[] {
  const seen = new Set<string>()
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) if (w && DENIED.has(sha(w))) seen.add(w)
  return [...seen]
}

describe('private names', () => {
  it('finds a denied word in any case and inside identifiers', () => {
    // Built from its hash's source at run time, so this file never spells it.
    const word = Buffer.from('bW9l', 'base64').toString()
    expect(deniedWords(`x-${word.toUpperCase()}_v2`)).toEqual([word])
    expect(deniedWords('acme-flags, Acme General')).toEqual([])
  })

  it('appear in no tracked file', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
    const hits: string[] = []
    for (const f of files) {
      let text: string
      try {
        text = readFileSync(new URL(f, ROOT), 'utf8')
      } catch {
        continue
      }
      if (text.includes('\0')) continue
      const found = deniedWords(text)
      // The words aren't printed: the file and count are enough to find them.
      if (found.length) hits.push(`${f}: ${found.length} denied word(s)`)
    }
    expect(hits).toEqual([])
  })
})
