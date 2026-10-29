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

  it('falls back to the newest reading past its reset, so the meter can say so', async () => {
    put('a.json', 50, NOW / 1000 - 600, NOW - 60_000)
    put('b.json', 70, NOW / 1000 - 60, NOW - 1000)
    const r = await readUsageDir(dir, NOW)
    expect(r?.value.fiveHour).toEqual({ usedPercent: 70, resetsAt: NOW / 1000 - 60 })
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
