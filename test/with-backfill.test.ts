// Every restart path backfills an unrecorded session's mod copy before the verdict (MIP2-1583).

import { describe, expect, it } from 'vitest'
import { BACKFILL_RETRY_MS, withBackfill } from '../src/main/mod-verdict.ts'

const A = 'c0ffee01-0000-4000-8000-000000000001'

describe('withBackfill', () => {
  it('backfills an unrecorded session, then judges it as any other', () => {
    const recorded = new Set<string>()
    const calls: string[] = []
    const verdict = withBackfill(
      id => (calls.push(`verdict ${id}`), recorded.has(id) ? null : 'the app has no record of which reporter mod copy this session uses'),
      id => !recorded.has(id),
      id => (calls.push(`backfill ${id}`), recorded.add(id), null),
    )
    expect(verdict(A)).toBeNull()
    expect(verdict(A)).toBeNull()
    expect(calls).toEqual([`backfill ${A}`, `verdict ${A}`, `verdict ${A}`])
  })

  it("refuses with the backfill's reason, and tries again only after BACKFILL_RETRY_MS", () => {
    let t = 1_000_000
    let tries = 0
    const verdict = withBackfill(
      () => null,
      () => true,
      () => (tries++, "its saved reporter mod copy was removed and couldn't be restored (disk full)"),
      () => t,
    )
    expect(verdict(A)).toMatch(/couldn't be restored/)
    t += BACKFILL_RETRY_MS - 1
    expect(verdict(A)).toMatch(/couldn't be restored/)
    expect(tries).toBe(1)
    t += 1
    verdict(A)
    expect(tries).toBe(2)
  })

  it('leaves a recorded session to the verdict alone', () => {
    let backfills = 0
    const verdict = withBackfill(() => 'its copy could not be moved aside', () => false, () => (backfills++, null))
    expect(verdict(A)).toBe('its copy could not be moved aside')
    expect(backfills).toBe(0)
  })
})
