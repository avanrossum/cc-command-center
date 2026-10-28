// Reads the usage governor's files, `~/.claude/ccc/usage/<session>.json`,
// for the usage meter. Electron CCCC writes them from each session's
// statusLine, and the reporter mod writes them for app-launched sessions
// (D-011 item 9). Both carry the statusLine's `rate_limits` shape.
//
// The rule matches `usage-governor.sh`: the newest file whose 5-hour window
// hasn't reset yet. An idle session re-renders an old payload whose reset
// time has passed, so that guard keeps a stale window off the meter. When
// every file is past its reset, the newest of them comes back, so the meter
// can say the window reset and it waits for a new reading (MIP2-1498 §4.4).

import { lstat, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { field, type Field, type RateLimits, type RateLimitWindow } from '@ccc/contract'

export const DEFAULT_USAGE_DIR = join(homedir(), '.claude', 'ccc', 'usage')
const NEWEST_READ = 20
const MAX_BYTES = 1024 * 1024

function windowOf(v: unknown): RateLimitWindow | null {
  if (typeof v !== 'object' || v === null) return null
  const w = v as { used_percentage?: unknown; resets_at?: unknown }
  if (typeof w.used_percentage !== 'number' || !Number.isFinite(w.used_percentage)) return null
  const resetsAt = typeof w.resets_at === 'number' && Number.isFinite(w.resets_at) ? w.resets_at : null
  return { usedPercent: w.used_percentage, resetsAt }
}

export async function readUsageDir(dir = DEFAULT_USAGE_DIR, now = Date.now()): Promise<Field<RateLimits> | null> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter(n => n.endsWith('.json'))
  } catch {
    return null
  }
  const stats = await Promise.all(
    names.map(async name => {
      try {
        const st = await lstat(join(dir, name))
        return st.isFile() && st.size <= MAX_BYTES ? { name, mtimeMs: st.mtimeMs } : null
      } catch {
        return null
      }
    }),
  )
  const newest = stats.filter((s): s is { name: string; mtimeMs: number } => s !== null).sort((a, b) => b.mtimeMs - a.mtimeMs)
  let pastReset: Field<RateLimits> | null = null
  for (const { name, mtimeMs } of newest.slice(0, NEWEST_READ)) {
    try {
      const data = JSON.parse(await readFile(join(dir, name), 'utf8')) as { rate_limits?: { five_hour?: unknown; seven_day?: unknown } }
      const fiveHour = windowOf(data.rate_limits?.five_hour)
      if (!fiveHour || fiveHour.resetsAt === null) continue
      const reading = field({ fiveHour, sevenDay: windowOf(data.rate_limits?.seven_day) }, 'statusline', mtimeMs)
      if (fiveHour.resetsAt * 1000 > now) return reading
      pastReset ??= reading
    } catch {
      // A file mid-write reads short; the next poll reads it whole.
    }
  }
  return pastReset
}
