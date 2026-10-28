// The release script and the updater order prerelease versions the same way (gate pass 15, L-4):
// one vector, run against both comparers, so the two can't drift.

import { describe, expect, it } from 'vitest'
import { comparePrerelease as releaseOrder } from '../scripts/release-lib.mjs'
import { comparePrerelease as updaterOrder } from '../src/main/update-feed.ts'

/** Pairs in ascending order (semver §11). */
const ASCENDING: [string, string][] = [
  ['alpha', 'beta'],
  ['beta.1', 'beta.2'],
  ['beta.2', 'beta.10'],
  ['beta', 'beta.1'],
  ['1', '2'],
  ['2', '10'],
  ['9', 'alpha'],
  ['alpha.1', 'alpha.beta'],
  ['rc.1', 'rc.1.1'],
]

describe('prerelease order (gate pass 15, L-4)', () => {
  it.each(ASCENDING)('%s < %s in both the release script and the updater', (a, b) => {
    for (const cmp of [releaseOrder, updaterOrder]) {
      expect(Math.sign(cmp(a, b))).toBe(-1)
      expect(Math.sign(cmp(b, a))).toBe(1)
      expect(cmp(a, a)).toBe(0)
    }
  })
})
