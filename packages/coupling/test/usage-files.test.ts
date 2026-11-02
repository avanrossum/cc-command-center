// The usage meter's reading (MIP2-1498 §4.4): the newest unreset window, else the newest past its reset.

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readUsageDir } from '../src/usage-files.ts'

const NOW = 1_800_000_000_000
let dir: string
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'ccc-usage-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function put(name: string, used: number, resetsAt: number, mtime: number, sessionId?: string): void {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify({ ...(sessionId ? { session_id: sessionId } : {}), rate_limits: { five_hour: { used_percentage: used, resets_at: resetsAt }, seven_day: { used_percentage: 40, resets_at: resetsAt + 86_400 } } }))
  utimesSync(p, mtime / 1000, mtime / 1000)
}

describe('readUsageDir', () => {
  it('takes the newest file whose 5h window has not reset', async () => {
    put('a.json', 10, NOW / 1000 + 3600, NOW - 60_000)
    put('b.json', 99, NOW / 1000 - 60, NOW - 1000)
    expect((await readUsageDir(dir, NOW))?.value.fiveHour?.usedPercent).toBe(10)
  })

  it('reads a file with the 7-day window only, guarded by that window\'s reset (MIP2-1590)', async () => {
    const weekly = (name: string, used: number, resetsAt: number, mtime: number) => {
      const p = join(dir, name)
      writeFileSync(p, JSON.stringify({ rate_limits: { seven_day: { used_percentage: used, resets_at: resetsAt } } }))
      utimesSync(p, mtime / 1000, mtime / 1000)
    }
    weekly('a.json', 3, NOW / 1000 + 86_400, NOW - 1000)
    const r = await readUsageDir(dir, NOW)
    expect(r?.value).toEqual({ fiveHour: null, sevenDay: { usedPercent: 3, resetsAt: NOW / 1000 + 86_400, observedAt: NOW - 1000 } })
    // A newer weekly file past its reset doesn't hide it.
    weekly('b.json', 90, NOW / 1000 - 60, NOW - 10)
    expect((await readUsageDir(dir, NOW))?.value.sevenDay?.usedPercent).toBe(3)
  })

  it('chooses each window on its own, and leaves out a window with no reset time (gate pass 24, M-5, L-7)', async () => {
    // The newest file has only the 7-day window; the 5-hour one comes from an older file.
    put('full.json', 20, NOW / 1000 + 3600, NOW - 60_000)
    const weekly = join(dir, 'weekly.json')
    writeFileSync(weekly, JSON.stringify({ rate_limits: { five_hour: { used_percentage: 99 }, seven_day: { used_percentage: 7, resets_at: NOW / 1000 + 86_400 } } }))
    utimesSync(weekly, (NOW - 1000) / 1000, (NOW - 1000) / 1000)
    const r = await readUsageDir(dir, NOW)
    expect(r?.value.fiveHour).toEqual({ usedPercent: 20, resetsAt: NOW / 1000 + 3600, observedAt: NOW - 60_000 })
    expect(r?.value.sevenDay).toEqual({ usedPercent: 7, resetsAt: NOW / 1000 + 86_400, observedAt: NOW - 1000 })
    expect(r?.observedAt).toBe(NOW - 1000)
  })

  it('falls back to the newest reading past its reset, so the meter can say so', async () => {
    put('a.json', 50, NOW / 1000 - 600, NOW - 60_000)
    put('b.json', 70, NOW / 1000 - 60, NOW - 1000)
    const r = await readUsageDir(dir, NOW)
    expect(r?.value.fiveHour).toEqual({ usedPercent: 70, resetsAt: NOW / 1000 - 60, observedAt: NOW - 1000 })
  })

  it('reads only the sessions it is told to keep, by file name and by the id inside (MIP2-1520)', async () => {
    put('mine.json', 10, NOW / 1000 + 3600, NOW - 60_000, 'mine')
    put('qa.json', 99, NOW / 1000 + 3600, NOW - 1000, 'qa')
    put('mine2.json', 77, NOW / 1000 + 3600, NOW - 500, 'qa')
    const keep = (id: string) => id === 'mine' || id === 'mine2'
    expect((await readUsageDir(dir, NOW, keep))?.value.fiveHour?.usedPercent).toBe(10)
    expect((await readUsageDir(dir, NOW))?.value.fiveHour?.usedPercent).toBe(77)
  })

  it('is null with no readable file', async () => {
    expect(await readUsageDir(join(dir, 'missing'), NOW)).toBeNull()
  })
})
